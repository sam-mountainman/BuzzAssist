# 独立レビューの署名 — 信頼リスト・鍵・入口・届け方・復旧

`../SKILL.md` の「独立レビューの署名（reviewer attestation）」の続き。何を信頼し何を拒否するかの規則と
運用モデルは SKILL.md にあり、ここはそれを運用するための形・コマンド・入口の対応・MCP host への
届け方・失敗コードと復旧をまとめる。署名・信頼リスト・signoff・reviewer 鍵を扱うコードや手順を
触るとき、Receipt の確定が reviewer 系の理由で止まったときに読む。

## 信頼リストの形

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

## 鍵の作成

鍵の作成（両ハーネス共通。`narrated-story-video.mjs reviewer-key-create` も同じ実装）:

```bash
node scripts/koya-manga-video.mjs reviewer-key-create \
  --reviewer-key-path /secure/outside-repo/reviewer-ed25519.pem \
  --reviewer-label independent-reviewer-1
```

秘密鍵は mode 0600 で書き、既存 file は上書きしない。repo 内・`--project-dir` 内・git 作業木内の
path は拒否する。標準出力には `keyId` と信頼リストへ貼る `trustEntry`（公開鍵だけ）が出る。
秘密鍵は印字されない。

## 入口の対応表（CLI = MCP。どのhostからも同じ処理へ届く）

| 工程 | CLI | MCP（`lib/videoHarnessMcp.mjs` / `lib/koyaMcpAdapter.mjs`） |
|---|---|---|
| production Job の start / resume（照合用 path） | `run-video-harness.mjs start\|resume [--reviewer-trust-path JSON]` | `run_video_harness` / `resume_video_harness_job` の `reviewerTrustPath` |
| reviewer 鍵の作成 | `koya-manga-video.mjs reviewer-key-create` / `narrated-story-video.mjs reviewer-key-create` | `create_video_harness_reviewer_key`（`reviewerKeyPath`, 任意 `reviewerPublicKeyPath` / `reviewerLabel`, `confirmed: true`） |
| Koya Job の signoff | `koya-manga-video.mjs signoff --reviewer-key-path PEM [--reviewer-trust-path JSON]` | `run_koya_manga_pipeline action=signoff`（`reviewerKeyPath`, `reviewerContextId`, 任意 `reviewerTrustPath`） |
| narrated Job の signoff | `narrated-story-video.mjs signoff --reviewer-key-path PEM --review-path REVIEW.json --pass\|--fail [--reviewer-trust-path JSON]` | `signoff_video_harness_job`（同じ引数名に `reviewPath`・`pass: true\|false`。Koya Job を渡すと拒否） |

上位 `run-video-harness.mjs` の `--reviewer-trust-path`（MCP `reviewerTrustPath`）は Job identity に
入らず `job.json` にも保存されない実行時引数。env と一致した path だけを service がジャンル子 CLI
（`koya-manga-video.mjs full` / `narrated-story-video.mjs full`）へ同じ値で渡し、両層が同じ信頼リストで
再検証する。MCP の reviewer 系引数は path だけを受け、鍵の中身らしい引数名（`*Pem`, `*PrivateKey`,
`*Secret`, `*Token`, `*Key` 単独）や PEM 文字列・信頼リスト本文を含む値は黙って捨てずに拒否する
（黙って捨てると「渡したのに効かない」と見え、鍵本体を argv に載せる回避策を誘発する）。
reviewer 系 MCP tool はいずれも `confirmed: true` が必須で、有料 API は呼ばない。

## MCP host へ信頼リストを届ける（R6-F2）

CLI（`run-video-harness.mjs` 等）は実行したシェルの env をそのまま読む。MCP サーバーは
host（Claude Code / Codex）が起動する子 process で、**どの env が子へ届くかは host ごとに違う**
（2026-09-06 実測、Claude Code 2.1.260 / Codex 0.153.1、`ps -Eww` で MCP 子 process の env キー数を計測）:

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

## runbook（owner が行うこと / 生成側・reviewer が行うこと）

| 主体 | すること | しないこと |
|---|---|---|
| owner | 信頼リスト JSON を管理し、監査・Receipt を実行する端末の env `BUZZASSIST_REVIEWER_TRUST` に配る（MCP 経由なら host を起動するシェル / launcher の env）。失効・追加を配り直す | bundle・Channel Pack・Job options・MCP 引数で信頼リストを渡す |
| reviewer | 生成 context と別の context で `reviewer-key-create` → trustEntry（公開鍵）だけを owner へ渡す → `signoff --reviewer-key-path` | 秘密鍵を repo 内・canvas・argv・MCP 引数へ置く。信頼リストを自分で書く |
| 生成側（Claude/Codex） | 監査・Receipt で env の信頼リストを読む。`--reviewer-trust-path` を付けるなら env と同じ内容の照合用として | env 未設定の端末で `--reviewer-trust-path` だけで通そうとする。options に `reviewerTrustPath` / `reviewerPrivateKeyPem` を書く |

## 失敗コードと復旧（Job 層）

| コード | 意味 | 復旧 |
|---|---|---|
| `reviewer-trust-unconfigured` | 実行側 env に信頼リストが無い（明示 path があっても同じ） | owner が env を設定してから `resume`。MCP 経由なら host を起動する env に置き、host を再起動してから（設定 file の `env` へ書いても拒否・消去される） |
| `reviewer-trust-invalid:env-ambiguous:<path\|json>` | 新旧 env 名の両方が設定され内容が違う | env をどちらか1つにしてから `resume` |
| `reviewer-trust-conflict` | 明示 `--reviewer-trust-path` の内容が env の信頼リストと一致しない | 明示 path を外す（または env と同じ内容を指す）。env は書き換えない |
| `reviewer-key-untrusted` / `reviewer-key-revoked` | 署名鍵が信頼リストに無い／失効済み | owner が登録した active な鍵で reviewer が signoff をやり直す |
| `reviewer-attestation-unsupported-harness` | harness 宣言に `reviewAttestation.subject` が無い／未知 | **宣言を直したうえで新しい Job を作る**（resume では直らない。宣言は Job identity の一部） |
