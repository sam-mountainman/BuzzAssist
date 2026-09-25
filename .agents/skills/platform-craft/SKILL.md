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

**端末全体の枠。** 有料の音声・画像の送信は、端末全体の枠（`lib/machineSlots.mjs`。既定は
paid-speech 4・paid-image 16、`BUZZASSIST_MACHINE_SLOTS_PAID_SPEECH` / `BUZZASSIST_MACHINE_SLOTS_PAID_IMAGE`
で端末ごとに変える）の中で行う。broker が送信の直前に枠を取るので、Claude Code と Codex の別の
セッションが同時に投げても端末全体の同時数は上限を越えない。枠を待って失敗しても送信前なので
未課金（Media Job は reserved のまま）。

**課金APIの外で作った画・動画。** 運営者の web 画面・ローカルモデル・撮影などで作った素材を公式経路へ
入れるときは、画は `lib/operatorImageImport.mjs`、動画は `lib/operatorVideoImport.mjs` を使う。来歴
（sha256・経路・プロンプトの sha256・生成した時刻、画は承認済みの参照も）を有料の処理の前に検査してから
取り込み、会話の URL などの本文は私有の Job フォルダにだけ残す（公開面は sha256 だけ）。費用は Media Job に
数えず `operator-external-contract` として記録する。2つ目の取り込み口を作らない。

### 更新をまたいで確定させる

BuzzAssist を更新すると、進行中の Job はコードの同一性が計画時と変わり `canonical-identity-drift` で止まる。
入力（台本・Channel Pack・options（ブリーフの SHA を含む）・取り込みの記録・漫画の回の例外）が同じなら、
`node scripts/run-video-harness.mjs resume --finalize-after-update`（MCP は `finalizeAfterUpdate: true`）で、
作り直さずに確定までやり直す（2026-09-26 運営者決定。本体 `lib/videoHarnessUpdateFinalize.mjs`）。

- 付け替えるのはコードの同一性だけ。計画時の値は `codeIdentityRebind` に残し、Job ID と identityDigest は
  変えない（reviewer の署名は identityDigest に結ばれているので、変えると済んだレビューまで無効になる）
- 付け替えた Job は以後、再利用だけで走る。新しい有料の呼び出しは `lib/paidCallGuard.mjs` が送る前に止め
  （`finalize-after-update-paid-call-required`、課金なし）、確定させない。送り口ごとに2つ目の関所を書かない
- 監査と確定は Job に固定した契約の版で行う（漫画は固定した制作契約の写し、ナレーション物語は計画時の宣言）。
  更新後の版の必須監査で測ると、当時無かった監査で落とすことになる
- 入力が変わっていれば今までどおり止まる（`finalize-after-update-input-changed` など）。新しい Job として
  start する。`--retry-failed-images` とは一緒に使えない。更新をまたいだ事実は RunReceipt の `codeIdentity` に残る

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
- 依頼文からハーネスを選ぶ判定は `lib/videoHarnessJob.mjs` の `decideVideoHarness` の1か所で、start と
  plan-request が同じ判定を使う。依頼文の否定の節（〜は使わず・〜ではなく・〜なし・not / without）の語は
  減点する。否定の語だけ、または上位2つの点差が2未満（同点を含む）なら1つに決めず、
  `video-harness-choice-required` で候補と1問を返す

### 依頼からハーネスを選ぶ（plan-request）

運営者が作りたい動画を言ったら、start の前に
`node scripts/run-video-harness.mjs plan-request --request "<依頼文>" [--script-path FILE] [--channel-pack BUNDLE]`
（MCP は `plan_video_request`、本体 `lib/videoRequestPlan.mjs`）を呼ぶ。返るのは候補の順位と理由（一致した
語・否定された語・入力要件・前提・実績・Channel Pack の向き先）と、決めきれないときの1問。モデルも有料 API
も呼ばず、Job も作らない。判断はホストがする。

- `decision.status` が `selected` でなければ、`question` をホストの質問 UI でそのまま1回だけ聞き、
  答えのハーネス ID で plan-request を呼び直す。推測で1つに決めない
- `decision.blockers` が残っている間は start しない。実績は RunReceipt と skill evals の記録から読み、
  無ければ「実績なし」と出る。「実績なし」を「問題なし」と言い換えない
- ハーネスを足したら、宣言（`config/harnesses/<id>.harness.json`）の隣に能力カード
  `<id>.capabilities.json` を置く（本体 `lib/harnessCapabilities.mjs`）。保証・運営者に要る素材・実績は
  カードに書かない（保証と素材は宣言から自動で作り、実績は記録から読む）。説明をカードに分けるのは、
  文を直しただけで宣言の SHA（Job の識別子に入る）が変わらないようにするため

**チャンネルが決まっている依頼**は `plan-request --channel <id>`（MCP は `channelId`）で呼ぶ。運営者の配置表
harness-deployments.json（配布物の `config/harness-deployments.example.json` から作る）の `channels` が、作業
フォルダ・署名済み Channel Pack・制作の仕組み・戦略の作業フォルダ・台本の品質ループの設定を決め、依頼の種類
（`requestKind`）と次の工程の推奨・代案・理由（`workflow`）が返る（本体 `lib/channelNextStep.mjs`）。Pack や
作業フォルダが台帳のチャンネルに当たれば、`--channel` が無くても同じ扱いになる。

- 種類を決めきれなければ `question` を1回だけ聞き、答えを `requestKind`（CLI は `--request-kind`）に入れて呼び直す
- 戦略スキルの工程（`workflow` の owner が strategy-skill のもの）はホストの AI が戦略スキルで実行する。終わったら
  `workflow.recommended.then` の順（ブリーフの下書き → 欄を埋める → 形の確認 → 当てはまりの記録 → 企画の品質
  ループ）でブリーフを作ってから plan-request を呼び直す
- 台帳の `strategy.requireBrief` が true のチャンネルは、合格したブリーフ（`--strategy-brief`）が無いと start が
  Job を作る前に止まる（`channel-strategy-brief-required` / `channel-strategy-brief-not-passed`）
- 同じ内容の再レンダーは resume だけ。start のときのブリーフが変わっていれば resume も止まる
  （`strategy-brief-changed-since-start`）ので、新しい Job として start する。start と resume の関門は
  `lib/channelStartGate.mjs` の1か所（CLI と MCP が同じ判定になる）

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

共通の Receipt（`lib/videoHarnessReceipt.mjs`）は「その Job に効いている契約の版の必須監査」で測る。
制作契約を Job に固定したハーネス（漫画）は、確定の直前に読み直した固定契約の `requiredAudits`。
それ以外は audit-report の版を、宣言の保証の `inForceSince` で測る（`declaredAuditIdsInForce`）。今の宣言で
計画された Job は、宣言の版（`inForceSince` の最新）より古い版を名乗れない。**監査契約の版を上げるときは、
足す監査を新しい保証として `inForceSince` つきで宣言する**——既存の保証に監査を足すと、版から過去の契約を
導けず、確定待ちの古い Job が当時無かった監査で落ちる。

### どのホストから動かしたかを残す

Job を作った呼び出しは `job.metadata.invocation.createdBy`、再開は `resumedBy[]` に分けて残り、共通
RunReceipt の `invocation` 欄へ digest つきで写る。判定は `lib/harnessHostProvenance.mjs` の1か所
（MCP は initialize の `clientInfo`、CLI は環境変数の**名前**で判定し、値は残さない）。入口ごとに2つ目の
判定を書かない。

- ホストは Job の同一性にも inputDigests にも入れない。Claude Code で始めた Job を Codex で再開しても同じ Job
- モデル ID は推測で埋めない。自分のモデル ID が分かるときだけ MCP の `hostModel` / CLI の `--host-model`
  に渡す（記録は caller-declared。分からなければ unknown のまま）
- 記録の系列名 `harness-run-receipt-v1` は変えない（Canvas 投影・学習の索引・Stop フックが完全一致で読む）。
  欄の増減は `schemaRevision` で表す（2 = invocation と timing、3 = `timing.stages`、4 = `skillApproval`）。
  上げたら、上げる前の版の実例を `test/fixtures/run-receipt-past-schema-revisions.json` に足す
- 同じ品質かは `node scripts/harness-receipts.mjs rollup --by host` で見る。ホストの記録が無い・判定できない・
  作ったホストと再開したホストが混ざった組は比べない

### 正本スキルの承認の状態を残す

正本スキルの人の承認（在庫の approval 欄。版と内容 SHA に束縛）は、運営者へ配る版を出すときに1回だけ
確かめる（2026-09-26 運営者決定。`npm run skills:check:release` と release.yml の関門、承認は承認者本人の
端末の `skill-inventory --approve` だけが記録できる）。制作で止めるかは写しの種類で分ける
（本体 `lib/videoHarnessProductionProfile.mjs`。開発用チェックアウトの判定は `lib/hostSkillSync.mjs` の
`readsCanonicalDirectly` と同じ1つ）:

- 開発用チェックアウト: 承認前の正本でも止めない。Job の `canonicalIdentity.productionProfile.skillApproval` と
  RunReceipt の `skillApproval`（digest つき）に、写しの種類と承認の付いていないスキルの id・版・sha256 を残す。
  doctor は `skill-approval` を advisory で出す
- 配布された写し: 今までどおり承認済みの版でなければ止める（doctor もハーネス指定なら blocking）
- `BUZZASSIST_REQUIRE_SKILL_APPROVAL=0` で外す、それ以外の値ならどちらの写しでも止める。止めたかどうかは
  Job の同一性に入れない（env で Job が分かれないように、記録は写しの種類と未承認のスキルだけ）
- 承認前の正本で作ったことは Receipt の合否を変えない。成果物を報告するときは `skillApproval` を伏せない

### 完成と言う前に（Stop フック）

Claude Code と Codex のプラグインは Stop フック（`scripts/harness-stop-hook.mjs`）を持つ。最後の発言が
完成・完了・納品できる・done を主張し、この会話で扱った Job が合格で決着していない（completed でない、
RunReceipt が pass で確かめられない、blockers・`knownRemainingIssues` が残る、工程が pass でない）とき、
止まるのを差し戻し、reason に Job の状態と残りの項目を返す。

- 差し戻されたら、完成と言い直さずに今の状態と残りを報告するか、次の工程を進める。有料の実行・再開は
  運営者の明示の確認があるときだけ
- `awaiting-human-review` は正当な停止。作業を進めず、確認待ちであることと、誰が何を確認すれば進むかを報告する
- フックは同じ会話・同じ Job で2回までしか差し戻さず、`stop_hook_active` のときは何もしない。
  **差し戻されなかったことは合格の証拠ではない**——合格の根拠は Job と RunReceipt だけ
- Codex は `/hooks` でフックを信頼するまで動かさない。Antigravity にはフックが無いので、
  `node scripts/run-video-harness.mjs status` で自分で Job を確かめてから報告する

## Canvas への投影

Canvas への投影の家は3つだけ。Run の状態は `lib/canvasRunProjection.mjs`、決着した成果物は
`lib/canvasRunMediaProjection.mjs`、制作の途中は `lib/canvasRunProgressProjection.mjs`（ジャンルは
snapshot の読み取り側だけを書く。漫画は `lib/koyaMangaProgressSnapshot.mjs`）。4つ目の投影器を作らない。
途中の投影の失敗は Job の状態遷移（completed への確定を含む）を止めず、戻り値の
`progressProjection.ok=false` として残す。

## 品質ループ（作って、測って、直す）

`lib/qualityLoop.mjs`。ジャンルに依らない品質ループの中核で、漫画もナレーション物語もここを
使う。ジャンルが決めるのは評価項目・下限・機械ゲート・上限だけで、漫画は `lib/mangaQualityHarness.mjs`、
ナレーション物語は `lib/narratedStoryQualityLoop.mjs` に置く。2つ目の中核を作らない。

- 作る係と同じ文脈の評価は拒否し、評価の文脈は回ごとに新しくする（同じ人が直した版を
  見直すのは許すが、文脈の使い回しは拒否する）
- 採点基準は契約の指紋に縛り、走行中に変えさせない
- 合格は、機械ゲート全部pass・加重平均が目標以上・どの評価項目も下限以上の3つ。
  平均だけで判定すると、1つの項目の致命的な低さが他の満点で薄まる
- 止まる条件を複数持つ: 目標到達、人の判断が要る状態、費用、時間、回数、改善の停滞
- 合格しなかった回には失敗指紋を付け、次の回は「どの失敗を、どう直したか」を必須にする。
  修正内容が無いときは例外で落とさず、人待ちで止める
- 時計はループの中で観測した最も早い時刻から最も遅い時刻までで数える。レビューの署名が監査より先でも
  例外にしない（読めない時刻だけ拒否する）
- 費用は有料生成の記録（Media Job の受領記録）から `summarizePaidMediaCost` で回ごとに集計して渡す。
  数えた Media Job は状態の `costedKeys` に残し、二重に数えない。単位は提供元が申告した通貨で、混ざったら
  合計せず人待ちにする。契約の `maximumCostUnits` はその通貨の単位で書く
- 直前の回と同じ所見の評価は `quality-feedback-not-updated` で拒否し、新しい評価を求める
- 合格せずに止まったら、最高点の回を成果物 SHA つきで `bestRound` に残す。合格扱いにはしない

### 品質ループの種類と入口

| 対象 | 入口 | 本体 | 使う前の照合 |
|---|---|---|---|
| 完成動画 | 各ジャンルの signoff と最終監査 | `lib/mangaQualityHarness.mjs` / `lib/narratedStoryQualityLoop.mjs` | 最終監査・RunReceipt |
| 途中の成果物（人物の設定画・背景・本編の画・サムネ・声のテイク・動画クリップ） | `node scripts/asset-quality-loop.mjs` | `lib/assetQualityLoop.mjs` | `lib/assetQualityUseGate.mjs` |
| 台本 | `node scripts/script-quality-loop.mjs` | `lib/scriptQualityLoop.mjs` | `lib/scriptQualityUseGate.mjs` |
| 企画（戦略ブリーフ） | `node scripts/strategy-brief.mjs` | `lib/strategyBriefQualityLoop.mjs` | `lib/channelStartGate.mjs`（start / resume） |

使う前の照合と「状態 → 理由コード」の対応は、ループの種類ごとに1か所だけに置く。ジャンルが足すのは効力の
判定（どの契約の版から効くか）だけで、照合する側はループの issues や状態名を読まない。2つ目の照合を作らない。

- 途中の成果物: 人物の同一性と、公開面に出る画の手指の安全は、対話端末＋`--human-verified` の人の確認が
  無いと合格にならない（対象ごと。batch では記録できない）。評価者に渡すシートには合格点・下限・重み・
  前の回の点数を載せない。動画クリップは `measure-video` で測ってから記録する
- 台本: 制作の Job は、有料の処理の前に、使う台本（Job に保存した写しのバイト列の SHA）を
  `scriptQualityVerdict` に問う。ループが合格した版か、人がそのまま使うと認めた版（`accept-human
  --human-verified`、確認した人が自分の端末で打つ）でなければ `script-quality-required:<理由>` の人待ちで止まる。
  運営者・依頼者が書いた台本を AI の点で止めないための道が accept-human
- 企画: 判断はホストのエージェントと運営者がする。BuzzAssist はブリーフの形と根拠の SHA を検査し、版ごとに
  別の評価文脈の採点を記録するだけ。`verdict --require-pass` が通るまで制作へ渡さない

対象 id・batch の保証・動画クリップの測定・台本のループの評価者の組と累計と指摘の採否・企画ブリーフの根拠の
古さと下書きの組み立ては `references/quality-loops-ja.md` にある。ループを回すとき、ループの記録や照合を
読むコードを触るとき、ブリーフを組み立てるときは、先にそれを最後まで読む。

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

信頼リストの形、鍵の作成、CLI と MCP の入口の対応表、MCP host（Claude Code / Codex）へ信頼リストを
届ける方法（env の名前だけを設定 file に書き、値は host を起動する環境に置く）、owner・reviewer・生成側の
runbook、失敗コードと復旧は `references/reviewer-attestation-ja.md` にある。署名・信頼リスト・signoff・
reviewer 鍵を扱うコードや手順を触るとき、Receipt の確定が reviewer 系の理由で止まったときは、先にそれを
最後まで読む。

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

複数のファイルを1つの確定として書く（完成 MP4・監査の報告・Receipt・状態ファイルなど）ときは
`lib/fileTransaction.mjs`（redo journal）を使う。新しい中身を全部置き場へ書き、journal を原子的に
書いた時点を確定の点にしてから順に入れ替える。状態を読む前に `recoverFileTransactions` を呼ぶ。
1つずつ rename すると、途中で落ちたとき「報告だけ pass・状態は古い」が残る。

## 共有の部品（2つ目を作らない）

- 字幕の組版に要るフォントの寸法（字の有無・送り幅）は `lib/fontMetrics.mjs`
- 長い filter graph は `lib/ffmpegFilterArgs.mjs` でファイルに書いて渡す（Linux は1引数 128KiB、Windows は
  コマンド行全体で 32,767 字の上限がある。FFmpeg 7 以降は `-/filter_complex`、それより前は
  `-filter_complex_script`）
- 運営者の画・動画の取り込みは上の `lib/operatorImageImport.mjs` / `lib/operatorVideoImport.mjs`

## UI を触ったら、起動して確かめる

`src/` の下を変更したら、**ブラウザで実際に起動してコンソールを見る**。
これは任意の丁寧さではなく、この層で必須の手順。

理由は実測にある。UI のテスト44件は `App.jsx` をレンダーせず readFile と正規表現で判定しているので、
挙動については何も保証しない。実際、**44件すべてが緑のまま、起動するとコンソールに40件超のエラーが
出ていた**。`npm test` の入口の `vite build` も、import と構文の破壊は落とすが、トップレベルの throw と
実行時のエラーは落とさない。

- 開く URL は setup が出した `BUZZASSIST_CANVAS_URL` か `canvas/.server.json` の live URL（固定 port を
  推測しない）。今のホストが内蔵 Browser を持つならそれで開く
- 見るのは3つ: 新しい読み込み以降のコンソールエラーが0件・画面が描画されている・触った機能が実際に動く

開き方の詳細と、古いエラーの見分け方・初回ハイドレーション中のエラーの辿り方は
`references/ui-verification-ja.md` にある。`src/` を触ったとき、ブラウザで原因を辿るときに読む。

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

BuzzAssist正本は`.agents/skills`に置く。Claude Code は `.claude/skills` の薄い adapter から正本を読む
（Claude Code は `.agents/skills` を読まない）。Codex はリポジトリの `.agents/skills` を直接読むので adapter を
置かない。`.codex/skills` の adapter は同じ Skill を一覧に2回出すだけだった（2026-09-25 実測）ので
2026-09-26 に外した（経緯はリポジトリの docs/skill-inventory-profiles-ja.md）。`.codex/skills` を作り直さない。
開発用チェックアウトの判定（`lib/hostSkillSync.mjs` の `readsCanonicalDirectly`）は `.git`・`.claude/skills`・
`.agents/skills` の3つで見る。host名やCLI名を一括置換して別内容を作らない。正本更新時は
`skill-creator`、eval、inventoryのversion/content SHA、adapter検査をまとめて行う。正本はエージェントも
直してよいが、人の承認は配る版を出すときの1回（上の「正本スキルの承認の状態を残す」）で、
エージェントは `skill-inventory --approve` を打たない。

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
- **字幕のように画素で測る監査は、MP4 の輝度（Y）の面で測る。** RGB へ戻してから輝度を計算すると、
  4:2:0 の色の間引きで原色の背景の色が白い字の画素へにじみ、RGB が飽和して読める字を読めないと取り違える

## やってはいけないこと

- 既存実装をコピーして2つ目の家を作る（先に `harness-registry.mjs list`）
- ジャンル固有・チャンネル固有の規則をこの層へ書く
- 課金APIに新しい `fetch` + リトライを直接書く
- 判定を各呼び出し側へ散らす（後から増えた1つが素通りする）
- `src/` を触ったのに、起動して確かめずに終える（テストは緑でも動くとは限らない）
- 「あとで紐づける」と書いて宣言に穴を残す。**書けない理由を宣言に書き、
  テストで見えるようにする**（`receiptAdapter: { status: "pending", reason, requiredWork }`）
- CLAUDE.md / AGENTS.md / GEMINI.md を手で直す。リポジトリの config/host-instructions.template.md を直して
  `node scripts/generate-host-instructions.mjs` で作る（CI が `npm run instructions:check` で照合する）
- 4つ目の Canvas 投影器、2つ目の取り込み口・品質ループの照合・ホストの判定・有料の呼び出しの関所を作る
- エージェントが人の代わりに `accept-human`・`reset-cumulative` を `--human-verified` で打つ
  （台本を認めたこと・累計を戻したことは、確認した人の端末でだけ記録する）
- Stop フックに差し戻されなかったことを、合格の根拠として報告する
- 承認前の正本スキルで作ったこと（Receipt の `skillApproval`）を伏せて完成を報告する。
  エージェントが `skill-inventory --approve` を打つ・`skills:check:release` の関門を外す
