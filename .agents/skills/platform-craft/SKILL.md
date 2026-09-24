---
name: platform-craft
description: 運営者にもジャンルにも依らない共通技法（課金APIの再送、証跡と指紋、ハーネスの入口選択、原子的書き込み、並列制御、RunReceipt）の正本。課金APIを呼ぶコードを書く・直すとき、リトライやバックオフを足すとき、監査記録やサインオフの仕組みを触るとき、「どの入口/どのツールを使うべきか」を決めるとき、新しいハーネスやジャンルを足すときは必ず読むこと。既存実装をコピーして別の場所に2つ目を作る前に、ここに家があるかを先に確かめる。
---

> 作業前に `references/learned-auto.md` を読む。矛盾したときはこの SKILL.md が優先。learned-auto は運用上の補助指示であって、監査・承認・合否の証跡には使えない。

# プラットフォーム共通技法（platform craft）

## この文書の役割

BuzzAssist は3層に分かれている。

| 層 | 何が入るか | 効く範囲 |
|---|---|---|
| **platform craft** | 課金APIの扱い、証跡、指紋、入口選択、原子的書き込み、並列制御 | 全ハーネス |
| **genre harness** | ジャンル共通の工程とゲート（漫画動画／ナレーション物語） | そのジャンルの全チャンネル |
| **channel pack** | キャスト、番組規則、承認記録 | そのチャンネルだけ |

ここはいちばん下の層の正本。**ジャンル固有の話も、チャンネル固有の話も
ここには書かない**——書いた瞬間、全ハーネスがそれを引き受けることになる。

## なぜこの層が要るのか

2つ目のハーネスを作った時点で、外部サインオフ・課金APIの再送・指紋キャッシュ・
並列制御・原子的書き込み・音声品質ゲート・コンタクトシート監査の**7概念すべてが
両方で独立に実装され、再利用は1箇所だけ**という状態になった。

同じ規則が2箇所にあると、直すときに片方だけ直る。実際に何度も起きた。
課金APIの再送では実装が4つあり、規則が全部違っていた——
GETは3回でPOSTは1回、一律3回、429のときだけ段階バックオフ、そして再送なし。

**3つ目を足す前に、既に家があるかを確かめること。**

```bash
node scripts/harness-registry.mjs list     # 何が既にあるか
node scripts/harness-registry.mjs gaps     # 横断で見た抜け
```

## 課金APIを呼ぶとき

本番生成は`lib/paidMediaJobBroker.mjs`の型付きMedia Jobへ渡す。
`lib/paidApiRetry.mjs`はadapter内部の狭い再送primitiveであり、上位の制作コードが
直接使ってreservation、idempotency、provider job ID、recover、Receiptを迂回しては
ならない。新しく `fetch` + リトライをproduction entrypointへ書かない。

課金APIでは、再送してよいかの判断を1つ間違えるたびに金が消える。だから
規則は狭く取ってある。

- submit前にrequest identityとreservationをdurable journalへ保存する。同じ
  input/provider/model/voice/paramsは同じrequest keyへ正規化し、同時起動も同一jobへ寄せる
- 再送してよいのは **429・明確な5xx・submit前と判断できるネットワーク断だけ**
- **408、504、Abort、2xx受領後のbody/decode/artifact/journal失敗は再送しない**。
  providerが仕事を受理した可能性があるため`recovery-required`へ移し、provider job IDを
  `get/recover`して回収する
- 認証エラーと不正リクエストは再送しない。何度投げても結果は同じで課金だけ増える
- **再送可否は本文を読む前にステータスだけで決める**。本文の読み取りが失敗すると
  判定の付かないまま catch へ落ち、印の無い再送が起きる
- **秘密は例外の本文からもリトライ通知からも消す**。残るのは例外の文字列で、
  それはログにもレポートにもそのまま載る。`secrets: [apiKey]` を必ず渡す
- バックオフは上限つき指数。上限が無いと止めたいときに止まらない
- `get / cancel / resume / recover`は同じMedia Job IDを使い、完成済みartifactを
  再submitしない
- **失敗した Job は共通の resume 経路で再開できる**（2026-09-24 運営者決定。それまで
  `failed` は終端で、同じ入力で回し直すと死んだ Job に再接続して何もしなかった）。
  再開の条件: 完了済みの有料 Media Job は requestKey と artifact SHA で再利用して
  再課金しない／`recovery-required` は broker の `recover` 経由で、未確定なら
  `paid-media-recovery-pending` で止まり doctor も adapter も走らない／回復不能
  （版不一致・stage 不一致・Receipt 確定待ちの残存・workspace や台本の欠落・requestKey 無し）
  は理由つきで拒否し Job は変えない／Receipt に `resume-from-failed`（直前の失敗、
  落ちた工程、再利用と再発行の内訳）と画像の失敗行を作り直した事実（件数・再課金回数）を残す。
  新しい入口も新しい旗も作らない——`run-video-harness resume` と MCP の resume がそのまま入口
- Receiptへprovider、adapterVersion、providerJobId、requestKey、input/identity hash、
  reservation、usage、cost、artifact SHAを残す。credentialとprovider生responseは残さない

```js
import { createPaidMediaJobBroker } from "./paidMediaJobBroker.mjs";

const broker = createPaidMediaJobBroker({ projectDir, adapters });
const job = await broker.start({
  kind: "speech",
  provider: "configured-provider",
  input,
  reservation,
});
```

既存の 429 の扱いを変えないこと。ジャンル側が 429 で **park**（残枠を焼かない
ために実行を止める）している箇所がある。そこを再送に変えると意図が壊れる。

## どの入口を使わせるか

`lib/harnessRouting.mjs`。ジャンルごとに、ガバナンスを通る入口は1つだけで、
同じ絵を出せる旧入口が並んでいることがある。**出せてしまうからこそ危険**で、
そちらを選んだ瞬間に番組ルール・配役ゲート・サインオフが全部消え、
監査記録のない成果物が「完成」として出てくる。

- Channel Pack が置かれている＝上位のルーターがそのチャンネルを選んでいる。
  旧入口は fail-closed で拒否する
- 過去成果物の再現は `benchmarkMigration: true` を明示したときだけ通し、
  迂回したことを戻り値に残す
- **判定を各ハンドラに散らさない**。散らすと後から増えた1つが素通りする

## 実行の記録（RunReceipt）

`lib/harnessRunReceipt.mjs`。本番の実行は必ず記録を残す。詳細は
`harness-self-improvement` スキルにあるが、この層で守る規則は1つ:

**走っていないゲートを「通った」と書けないこと。**

宣言されたゲートに判定が1件でも欠けていれば `finalize` が失敗する。
判定には証拠の指紋が要る。理由のない `skip` は受け取らない。
落ちたゲートがあれば pass と申告されても pass にしない。

保証（抽象語）と実測監査（具体的な項目）の対応は、ハーネス宣言の
`evidenceAuditIds` に書く。対応を書かずに保証だけ並べると、1つも走って
いない状態でも「全部通った」と書ける。

契約は版で増減する。**効力のあった契約で測ること**——当時存在しなかった監査を
「未実施」と数えると、過去の成果物が後から一斉に不合格になる。ただし契約から
保証の裏づけが全部消えた場合は pass ではなく `skip`。契約が縮んで保証が黙って
無効になるのが、この種の穴の入口。

## 品質ループ（作って、測って、直す）

`lib/qualityLoop.mjs`。ジャンルに依らない品質ループの中核で、漫画もナレーション物語もここを
使う。ジャンルが決めるのは評価項目・機械ゲート・上限だけ。2つ目を作らない。

- 作る係と同じ文脈の評価は拒否し、評価の文脈は回ごとに新しくする（同じ人が直した版を
  見直すのは許すが、文脈の使い回しは拒否する）
- 採点基準は契約の指紋に縛り、走行中に変えさせない
- 合格は、機械ゲート全部pass・加重平均が目標以上・どの評価項目も下限以上の3つ。
  平均だけで判定すると、1つの項目の致命的な低さが他の満点で薄まる
- 止まる条件を複数持つ: 目標到達、人の判断が要る状態、費用、時間、回数、改善の停滞
- 合格しなかった回には失敗指紋を付け、次の回は「どの失敗を、どう直したか」を必須にする。
  修正内容が無いときは例外で落とさず、人待ちで止める

## 独立レビューの署名（reviewer attestation）

`lib/koyaReviewAttestation.mjs`。漫画動画とナレーション物語の**両ハーネスが同じ1つの
実装**を使う。ハーネスごとに違うのは署名対象（subject）の形だけで、鍵・信頼リスト・
失効・検証の規則はここに1回だけ書く。ジャンルSkillはコマンド例を置き、規則はここを参照する。

**何を解くか。** signoff JSON の `reviewer` / `reviewerContextId` は自己申告で、生成側と
違う文字列を書けば「独立」に見えてしまう。そこで、運営者が**別経路で信頼した reviewer 公開鍵**
が、Job識別子・実MP4 SHA・contact sheet SHA・申告した reviewer context（Koya は加えて外側
Job binding・契約digest・review notes SHA、narrated は signoff 本文 SHA）を1つの subject
として Ed25519 で署名したことを、**最終監査と RunReceipt の両方**で再検証する。

規則:

- **鍵は attestation や Channel Pack に添付されていても信頼しない。** bundle と鍵を一緒に
  差し替えられるため。信頼は監査・Receipt を実行する側の環境変数からだけ読む
- **唯一の信頼アンカーは運営者（owner）の環境変数。** `BUZZASSIST_REVIEWER_TRUST`
  （信頼リスト JSON の path）または `BUZZASSIST_REVIEWER_TRUST_JSON`（inline JSON）。
  旧名 `BUZZASSIST_KOYA_REVIEWER_TRUST` / `BUZZASSIST_KOYA_REVIEWER_TRUST_JSON` は互換で
  読むが、新旧両方が設定され内容が違えば `reviewer-trust-invalid:env-ambiguous:<path|json>` で拒否する
  （どちらが効いているか分からない状態を通さない）
- **明示の `--reviewer-trust-path`（CLI / MCP の `reviewerTrustPath` / Job の実行時引数）は
  照合用であって、アンカーではない。** env の信頼リストと正規化 sha256 が一致しなければ
  `reviewer-trust-conflict` で拒否する。黙ってどちらかを採らない。**env が未設定なら、
  明示 path があっても `reviewer-trust-unconfigured` で fail-closed**——要求側の入力だけで
  信頼アンカーを立てることはできない。理由: 生成を行う端末上の主体が信頼リストの置き場も
  決められる構成では、attestation は自己承認へ退化する
- **未設定は fail-closed。** 信頼リストが無ければ signoff は不合格であり、「信頼リストが
  無いので検証を省いた pass」は存在しない。有料生成を終えた Job がここで止まった場合は
  terminal にせず `awaiting-human-review`（`pendingReceiptFinalization`）へ置く（後述）
- **Job options に信頼リストや鍵を載せない。** `reviewerTrustPath`、`reviewerPrivateKeyPem`、
  `reviewerTrust`、`reviewerTrustJson` などが `options` にあれば Job 作成前に拒否する。
  信頼アンカーは要求側が Job に書けるものではなく、秘密鍵の中身は argv・MCP 引数・Job
  options のどこにも載せない（path のみ）
- **失効は時刻無関係。** entry の `status` が `revoked` なら `signedAt` がいつであっても
  拒否する。`signedAt` は署名者の自己申告で、鍵が漏れた後に過去日付の署名を新しく作れる
- **正規化しない。** subject の SHA は小文字64桁hex、文字列は前後空白なしの正規形だけを
  受け、写し（別の綴り）が原本と同じ subject に収束することを許さない
- 秘密鍵は **file から読む**（`--reviewer-key-path`）。argv・環境変数・MCP 引数・Job
  options・Channel Pack・signoff 本文に鍵素材を載せない

信頼リストの形（`koya-reviewer-trust-v1`。名前に koya が残るのは履歴で、両ハーネス共通）:

```json
{
  "version": "koya-reviewer-trust-v1",
  "reviewers": [
    {
      "keyId": "ed25519:<公開鍵fingerprint 24桁hex>",
      "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
      "label": "independent-reviewer-1",
      "status": "active"
    },
    {
      "keyId": "ed25519:<別鍵のfingerprint>",
      "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
      "label": "retired-reviewer",
      "status": "revoked",
      "revokedAt": "2026-09-01T00:00:00.000Z",
      "reason": "端末交換により旧鍵を失効"
    }
  ]
}
```

`keyId` は `publicKeyPem` から導いた fingerprint と一致しなければ読み込み自体が失敗する
（alias を許すと別鍵の entry に既知の keyId を書いて差し替えられる）。`status` は
`active` / `revoked` のみ。`revoked` には `revokedAt` と `reason` が必須。重複 keyId は拒否。

鍵の作成（両ハーネス共通。`narrated-story-video.mjs reviewer-key-create` も同じ実装）:

```bash
node scripts/koya-manga-video.mjs reviewer-key-create \
  --reviewer-key-path /secure/outside-repo/reviewer-ed25519.pem \
  --reviewer-label independent-reviewer-1
```

秘密鍵は mode 0600 で書き、既存 file は上書きしない。repo 内・`--project-dir` 内・git 作業木内の
path は拒否する。標準出力には `keyId` と信頼リストへ貼る `trustEntry`（公開鍵だけ）が出る。
秘密鍵は印字されない。

**入口の対応表（CLI = MCP。どのhostからも同じ処理へ届く）:**

| 工程 | CLI | MCP（`lib/videoHarnessMcp.mjs` / `lib/koyaMcpAdapter.mjs`） |
|---|---|---|
| production Job の start / resume（照合用 path） | `run-video-harness.mjs start\|resume [--reviewer-trust-path JSON]` | `run_video_harness` / `resume_video_harness_job` の `reviewerTrustPath` |
| reviewer 鍵の作成 | `koya-manga-video.mjs reviewer-key-create` / `narrated-story-video.mjs reviewer-key-create` | `create_video_harness_reviewer_key`（`reviewerKeyPath`, 任意 `reviewerPublicKeyPath` / `reviewerLabel`, `confirmed: true`） |
| Koya Job の signoff | `koya-manga-video.mjs signoff --reviewer-key-path PEM [--reviewer-trust-path JSON]` | `run_koya_manga_pipeline action=signoff`（`reviewerKeyPath`, `reviewerContextId`, 任意 `reviewerTrustPath`） |
| narrated Job の signoff | `narrated-story-video.mjs signoff --reviewer-key-path PEM [--reviewer-trust-path JSON]` | `signoff_video_harness_job`（同じ引数名。Koya Job を渡すと拒否） |

上位 `run-video-harness.mjs` の `--reviewer-trust-path`（MCP `reviewerTrustPath`）は Job identity に
入らず `job.json` にも保存されない実行時引数。env と一致した path だけを service がジャンル子 CLI
（`koya-manga-video.mjs full` / `narrated-story-video.mjs full`）へ同じ値で渡し、両層が同じ信頼リストで
再検証する。MCP の reviewer 系引数は path だけを受け、鍵の中身らしい引数名（`*Pem`, `*PrivateKey`,
`*Secret`, `*Token`, `*Key` 単独）や PEM 文字列・信頼リスト本文を含む値は黙って捨てずに拒否する
（黙って捨てると「渡したのに効かない」と見え、鍵本体を argv に載せる回避策を誘発する）。
reviewer 系 MCP tool はいずれも `confirmed: true` が必須で、有料 API は呼ばない。

**MCP host へ信頼リストを届ける（R6-F2）。** CLI（`run-video-harness.mjs` 等）は実行したシェルの
env をそのまま読む。MCP サーバーは host（Claude Code / Codex）が起動する子 process で、**どの env が
子へ届くかは host ごとに違う**（2026-09-06 実測、Claude Code 2.1.260 / Codex 0.153.1、`ps -Eww` で
MCP 子 process の env キー数を計測）:

| host | MCP 子 process に届く env | 帰結 |
|---|---|---|
| Claude Code | host 自身の process env を全部継承（親 40 キー → 子 47 キー） | host を起動したシェル / launcher の env に値を置けば届く |
| Codex | 最小 env のみ（親 48 キー → 子 10 キー: `EXCALIDRAW_*` と `HOME` / `PATH` / `SHELL` 等）。サーバー定義の `env_vars` に**名前**を挙げた変数だけを親 env から転送 | 名前が `env_vars` に無い変数は届かない。値はやはり host を起動した env に置く |

setup（`scripts/setup-agents.mjs`）はこれに合わせ、MCP サーバー定義（`~/plugins/buzzassist/plugin/.mcp.json`
の `buzzassist_mcp`、および Claude Desktop / Cursor / Antigravity の `mcpServers` 登録）へ
`env_vars: ["BUZZASSIST_REVIEWER_TRUST", "BUZZASSIST_REVIEWER_TRUST_JSON", "BUZZASSIST_KOYA_REVIEWER_TRUST",
"BUZZASSIST_KOYA_REVIEWER_TRUST_JSON"]` を**自動で**付ける（`withReviewerTrustEnvPassthrough`。option では
なく常時）。設定 file に載るのは **env の名前だけ**で、値は載らない。

owner がすること:

- 値 `BUZZASSIST_REVIEWER_TRUST=<信頼リスト JSON の絶対 path>` は、**Codex / Claude Code を起動する
  シェルまたは launcher の環境**に置く（ログインシェルの profile、macOS launchd の
  `EnvironmentVariables`、Windows のユーザー環境変数など）。**GUI から起動した host は、setup を実行した
  シェルの `export` を見ない**
- **設定 file（`.mcp.json` / host の `mcpServers`）の `env` に `BUZZASSIST_REVIEWER_TRUST` を書かない。**
  setup と auto-update は `withReviewerTrustEnvPassthrough` でその key を `reviewer-trust-in-config` として
  fail-closed に拒否する。仮に手で足しても、サーバー定義は setup / auto-update のたびに新しい object で
  作り直されるので黙って消え、`reviewer-trust-unconfigured` が再発して原因が見えなくなる。拒否する理由:
  設定 file は plugin cache へコピーされ生成側が読み書きできる場所にあり、そこへ path を書けば
  要求側の入力で信頼アンカーが立つ（自己承認へ退化）
- `BUZZASSIST_REVIEWER_TRUST_JSON`（本文 inline）も設定 file へ書かない。host env には path を使い、
  信頼リスト file 自身は owner だけが書ける場所（repo 外・`canvas/` 外）に置く。path が生成側から
  書ける file を指すなら、env をアンカーにした意味が無い
- 新旧名（`BUZZASSIST_KOYA_REVIEWER_TRUST`）を両方置かない。内容一致でも片方を消すまで
  `env-ambiguous` で止まる
- 値を置いた後は **host を完全に再起動**して MCP サーバーを起こし直す（env は起動時にしか読まれない）
- setup summary の読み方: `BUZZASSIST_REVIEWER_TRUST_PASSTHROUGH=env-name-only` と
  `BUZZASSIST_REVIEWER_TRUST_ENV_VARS=<名前の一覧>` は「設定 file に名前だけを書いた」ことの報告。
  `BUZZASSIST_REVIEWER_TRUST_CONFIGURED=yes|no|ambiguous` は **setup を実行したシェル**での判定で
  （`BUZZASSIST_REVIEWER_TRUST_SCOPE=setup-shell-environment`）、`yes` でも GUI host に届いている
  保証にはならない。最終確認は MCP 経由で行う——確定待ち Job があれば `resume_video_harness_job`
  （`confirmed: true`）で Receipt 確定だけが通ること。`get_video_harness_job` は env を読まないので
  確認にならない
- Codex で plugin `.mcp.json` の `env_vars` が転送されなかった場合の fallback（**未実測**）:
  `~/.codex/config.toml` の `[mcp_servers.buzzassist_mcp]` に `env_vars = [...]`（名前のみ）を置く。
  ここにも値は書かない

**運用モデル（これを崩すと自己承認へ退化する）:**

- **信頼リストは、生成を行う端末・エージェントとは別の主体（owner）だけが設定する。**
  同じ端末上の同じ主体が信頼リストと reviewer 秘密鍵の両方を書ける構成では、
  生成側が自分で鍵を作り、自分で信頼リストに登録し、自分で署名できる。署名は
  成立するが「独立レビュー」ではない。だから env が唯一のアンカーであり、要求側の
  path・Job options・MCP 引数はアンカーになれない
- **reviewer 秘密鍵はリポジトリ外に置く**（`/secure/...` のような repo 外 path）。
  `canvas/`、`channel-packs/`、Job workspace、Canvas asset に置かない。
  `reviewer-key-create` はリポジトリ内・`--project-dir` 内・git 作業木内の path を拒否する
- 公開鍵（trustEntry）だけを owner へ別経路で渡し、owner が信頼リストへ追記して
  監査・Receipt 実行側へ `BUZZASSIST_REVIEWER_TRUST` として配る
- 失効は owner が `status: "revoked"` へ変えて配り直す。entry を削除して「知らない鍵」に
  するより、失効理由が残る方が後から追える
- generator と reviewer の context（Codex task ID / Claude session ID）は別でなければ
  ならず、鍵が信頼済みでも同一 context の signoff は不合格

**runbook（owner が行うこと / 生成側・reviewer が行うこと）:**

| 主体 | すること | しないこと |
|---|---|---|
| owner | 信頼リスト JSON を管理し、監査・Receipt を実行する端末の env `BUZZASSIST_REVIEWER_TRUST` に配る（MCP 経由なら host を起動するシェル / launcher の env）。失効・追加を配り直す | bundle・Channel Pack・Job options・MCP 引数で信頼リストを渡す |
| reviewer | 生成 context と別の context で `reviewer-key-create` → trustEntry（公開鍵）だけを owner へ渡す → `signoff --reviewer-key-path` | 秘密鍵を repo 内・canvas・argv・MCP 引数へ置く。信頼リストを自分で書く |
| 生成側（Claude/Codex） | 監査・Receipt で env の信頼リストを読む。`--reviewer-trust-path` を付けるなら env と同じ内容の照合用として | env 未設定の端末で `--reviewer-trust-path` だけで通そうとする。options に `reviewerTrustPath` / `reviewerPrivateKeyPem` を書く |

**失敗コードと復旧（Job 層）:**

| コード | 意味 | 復旧 |
|---|---|---|
| `reviewer-trust-unconfigured` | 実行側 env に信頼リストが無い（明示 path があっても同じ） | owner が env を設定してから `resume`。MCP 経由なら host を起動する env に置き、host を再起動してから（設定 file の `env` へ書いても拒否・消去される） |
| `reviewer-trust-invalid:env-ambiguous:<path\|json>` | 新旧 env 名の両方が設定され内容が違う | env をどちらか1つにしてから `resume` |
| `reviewer-trust-conflict` | 明示 `--reviewer-trust-path` の内容が env の信頼リストと一致しない | 明示 path を外す（または env と同じ内容を指す）。env は書き換えない |
| `reviewer-key-untrusted` / `reviewer-key-revoked` | 署名鍵が信頼リストに無い／失効済み | owner が登録した active な鍵で reviewer が signoff をやり直す |
| `reviewer-attestation-unsupported-harness` | harness 宣言に `reviewAttestation.subject` が無い／未知 | **宣言を直したうえで新しい Job を作る**（resume では直らない。宣言は Job identity の一部） |

有料生成を終えた後に上の設定・証跡側の失敗で RunReceipt が確定できない場合、Job は
`failed` にならず **`awaiting-human-review` に `pendingReceiptFinalization` を持って止まる**。
成果物・Media Job・課金は済んでいるので、`resume`（`--confirmed`）は **Receipt の確定だけ**を
再試行し、何も再生成・再課金しない。確定待ちの間に成果物 SHA が変わっていれば
`run-receipt-artifact-drift` で再び止まり、production を勝手に再実行しない。

Koya の subject は `koya-review-attestation-v1`、narrated は
`narrated-story-review-attestation-v1`。別ハーネスの署名を持ち込んでも schema が
違うので通らない。

## 並列制御

`lib/adaptiveConcurrency.mjs`（AIMD）。実測した上限と、並列にしてよい工程・
直列必須の工程は `harness-parallel-execution` スキルにある。推測で並列化しない。

## 原子的書き込み

`writeJsonAtomic`（`lib/canvasScene.mjs`）。途中で落ちた成果物が
「完成した成果物」に見えないように、必ず temp → rename で書く。

## UI を触ったら、起動して確かめる

`src/` の下を変更したら、**ブラウザで実際に起動してコンソールを見る**。
これは任意の丁寧さではなく、この層で必須の手順。

理由は実測にある。UI のテスト44件は `App.jsx` を**レンダーせず readFile と
正規表現**で判定しているので、挙動については何も保証しない。実際、
**44件すべてが緑のまま、起動するとコンソールに40件超のエラーが出ていた**
（アセットのパスを SVG の dataURL に入れていて、Excalidraw が base64 として
復号しようとして落ちていた）。誰も気づかないまま残っていた。

Claude Code/Codexの現在のhostが内蔵Browserを持つなら、そのBrowserでCanvas URLを開く。
CodexデスクトップではBrowser runtimeの`tab.playwright`でDOM操作・console取得・
screenshotができる。Claude Codeでは利用可能な内蔵BrowserまたはChrome連携を使う。
固定portを推測せず、setupが出した`BUZZASSIST_CANVAS_URL`または
`canvas/.server.json`のlive URLを使う。

見るのは3つ。

- **コンソールエラーが0件**であること。1件でも出たら原因まで辿る
- **画面が描画されている**こと。エラー0件は「真っ白」でも成立する
- 触った機能が**実際に動く**こと（クリックして結果を読む）

注意すべき点が2つある。

**コンソールは前の読み込みぶんも溜まっている。** 直したのに古いエラーが
見えて混乱する。新しいタブまたはreload境界以降のconsoleだけを判定する。

**初回ハイドレーション中のエラーは、後から計測しても捕まらない。** 原因を
辿るときは `src/main.jsx`（App より先に走る）へ一時的な計測を入れて再読込する。
調査が終わったら必ず外す。

## `npm test` では捕まらないもの

入口に `vite build` が入っているので、import と構文の破壊は落ちる。
だが**トップレベルの throw は落ちない**——構文としては正しく、バンドルも通る。
実行時のエラーも見えない。そこは上のブラウザ確認が担う。

<!-- buzzassist-learning:1a29a7b76bb8 -->
Codexデスクトップ内蔵Browserはtab.playwrightでCanvasを操作できるため、その用途だけでstandalone Playwrightを追加しない。
無人CIのブラウザー回帰が別に必要になった時点で、配布サイズ、各OSの実ブラウザー、
host内蔵機能との重複を比較して小さいrunnerを判断する。

## Skill・Pluginを分類する

端末のplugin list、BuzzAssistの配布物、production Jobのallowlistは別物。端末に見える
Skillを、正式ハーネスが依存していると説明しない。inventoryでは最低でも次を分ける。

- `installed` — その端末のユーザー環境へ導入済み
- `bundled` — BuzzAssist plugin/releaseへ同梱
- `productionAllowed` — 正式Harness manifestから本番時に呼べる
- `developmentOnly` — 作成・評価・curation時だけ使える

<!-- buzzassist-learning:d2091885825a -->
スキル整理では「端末に導入済み」「ハーネスに同梱」「本番実行時に許可」「開発・改善時に必要」を区別する。skill-creator はBuzzAssistのスキル作成・承認済み更新に必要なので不要扱いせず、運営者向け本番ホットパスから分離した管理・curation機能として位置付ける。

<!-- buzzassist-learning:d04c21b9b8d8 -->
skill-creatorは育成・正本改善のために保持し、不要物として削除しない。本番動画Jobのhot pathからだけ除外する。

BuzzAssist正本は`.agents/skills`に置き、Claude Code/Codex側は同じ正本を指す薄い
adapterにする。host名やCLI名を一括置換して別内容を作らない。正本更新時は
`skill-creator`、eval、inventoryのversion/content SHA、両host adapter検査をまとめて行う。

## 複数セッションを監査する

<!-- buzzassist-learning:c256846f03e5 -->
複数セッションを統合監査するときは、各セッションの未解決主張を原子単位でID化し、現在実装・レビュー台帳・最終回答への三者クロスウォークを作る。個別リスクを「ハーネス未完成」へ丸めず、解決・未解決・枝差分・検証不能をそれぞれ明記する。

取り込みmanifestは、原文のcontent hash、byte/line数、重複turn/tool ID、各findingの
割当を持つ。元セッションが後から変わった、findingが0件/複数回割り当てられた、
workflow synthesisが欠けている、といった状態を検査で見えるようにする。

## この層で繰り返し見つかった不具合の型

直す前にこの型を思い出すこと。**機能が動いていない**のではなく、
**検証したと書いてあるのに検証していない**のが大半だった。

- finalizer が観測文をハードコードして、自分の書いた文を根拠に自分を pass にする
- `full-decode` が名前に反して一度も映像をデコードしていない
- **欠落を許可として扱う**——指紋が無い＝再利用可、reviewer 名が無い＝通る、
  `skipped` ＝要件充足、キャストが検出できない＝この番組ではないので免除
- 合成 fixture が実データの正本を名乗り、サンプルで作った成果物に
  「プロジェクトの正本に準拠」と署名される

新しいゲートを足すときは、**そのゲートを通さずに完成させる道が残っていないか**を
先に探すこと。ゲートを足すより、迂回路を塞ぐ方が効くことが多い。

### FFmpeg で実測して分かった、ジャンルに依らない落とし穴

どれも「作ったつもりの値」と「完成 MP4 を読み戻した値」がずれた例で、生成側の記録を
根拠にしていたら見逃していた。

- **字幕の終わりの時刻は切り捨てる。** 四捨五入すると動画の長さを 1ms 越え、最後の字幕が
  丸ごと落ちる
- **trim の後はフレームレートを付け直す。** trim でフレームレートの情報が落ち、読み戻すと
  1フレーム足りなくなる
- **xfade の custom 式で st/ld（状態変数）を使うなら、その描画だけ1スレッドにする。**
  並列処理で変数が混ざり、転換が砂嵐になる
- **閾値は、基準版と、わざと壊した版を同じ測定にかけてから決める。** 基準版だけで決めると、
  壊れた版も通る値を置いてしまう

## やってはいけないこと

- 既存実装をコピーして2つ目の家を作る（先に `harness-registry.mjs list`）
- ジャンル固有・チャンネル固有の規則をこの層へ書く
- 課金APIに新しい `fetch` + リトライを直接書く
- 判定を各呼び出し側へ散らす（後から増えた1つが素通りする）
- `src/` を触ったのに、起動して確かめずに終える（テストは緑でも動くとは限らない）
- 「あとで紐づける」と書いて宣言に穴を残す。**書けない理由を宣言に書き、
  テストで見えるようにする**（`receiptAdapter: { status: "pending", reason, requiredWork }`）
