# Canvas Harness Run v1

## 目的

`lib/canvasRunState.mjs` と `lib/canvasRunProjection.mjs` は、動画Harnessのdurable jobを
BuzzAssist Canvasへ投影する共通境界。Harness固有のproduction stateを直接読まず、
共通の `CanvasRun v1` に正規化してからExcalidraw要素へ変換する。

この層はOS GUI、クリップボード、AppleScriptを使わない。Canvas JSONを
cross-process lockの内側で読み、runが所有する要素だけを原子的にupsertする。

## 状態の置き場所

共通jobの正本は次の配置を使う。

```text
canvas/harness-runs/<jobId>/job.json         durable job本体（runner所有）
canvas/harness-runs/<jobId>/canvas-run.json Canvas投影に使った正規化済み状態
canvas/excalidraw-canvas.json                表示scene
```

`canvas-run.json` は `job.json` を置き換えない。runner側adapterがjobを投影用viewへ変換する。

## CanvasRun v1の必須情報

- `runId`, `revision`, `status`, `updatedAt`
- `script`: 日本語本文またはpathとSHA-256
- `scenes`: scene/cutと関連job
- `jobs`: `id`, `status`, `needs` を持つDAG
- `artifacts`: 種別、安定した論理ID、SHA-256、producer job、任意のCanvas asset URL
- `audits`: 自動監査と証跡SHA
- `signoffs`: 独立レビュー、reviewer、証跡SHA
- `knownRemainingIssues`
- `versions`: Harness、Skill、Channel Pack、providerの版とSHA

artifact種別は画像候補・採用画像・参照画像、音声、字幕、BGM、preview/final MP4、
audit report、contact sheet、signoffを表せる。完了済みartifactにSHAが無い入力は拒否する。
`complete` runにknown issueが残る入力、またはSHA証跡に拘束されたapproved signoffが1件も無い
入力も拒否する。Video Harness adapterは共通 `run-receipt` 自体のSHAと、receipt内artifact rosterが
現在のjob artifactsと一致することを再検証してからsignoffを投影する。signoffの
Ed25519 reviewer attestationは、Receipt側が`BUZZASSIST_REVIEWER_TRUST`の信頼リストで再検証済みの
ものだけを`signoffs`へ載せる（規則は`.agents/skills/platform-craft/SKILL.md`の「独立レビューの署名」）。
信頼リストの唯一のアンカーは運営者envで、実行時引数`reviewerTrustPath`は照合用に限る。envと
内容が違えば`reviewer-trust-conflict`、env未設定なら明示しても`reviewer-trust-unconfigured`で
Receipt確定は止まる。

## 安定IDと再投影

要素IDは `runId + entity kind + logical ID` のSHA-256から作る。同じjob状態をClaude/Codexの
どちらから投影しても同じID・配置・projection hashになる。

- 同じ状態の再投影: 既存要素をそのまま保持し、重複を増やさない
- job状態変更: 同じelement IDをversion-upして更新する
- artifact削除: 過去要素を消去せずtombstone化する
- 別runとユーザー要素: 変更しない
- Canvas上の `buzzassistDecision` / `buzzassistComment` / `buzzassistFeedbackRevision`:
  job状態の再投影でも保持する

artifact cardには `buzzassistArtifactId`, `buzzassistArtifactKind`,
`buzzassistArtifactSha256` が入る。`lib/canvasRunMediaProjection.mjs` は、完了した画像、contact sheet、
MP4、音声/BGM、SRT/VTTの実bytesを宣言SHAと照合してから
`canvas/assets/harness-runs/<runId>/<sha256>.<ext>` へcontent-addressed copyする。元の絶対pathは
Canvas JSONへ残さない。

- 画像/contact sheet: asset-backed Excalidraw image element
- MP4: `codexMediaKind: video` の再生card
- 音声/BGM: `codexMediaKind: audio` の波形cardと明示再生button。buttonを押した時だけ
  native `<audio>` を1つ生成する`音声プレイヤー`を開き、Canvas asset URL以外は再生しない
- SRT/VTT: 既存subtitle overlayと同じrectangle形式

media element IDはartifact roleとSHA、file IDはmedia kindとSHAから決まる。同一SHAのpreview/finalは
assetを再利用しつつ別elementとして表示する。各media elementは対応するartifact card IDを持つ。
再投影で重複せず、ユーザーが並べた位置を保持し、artifactが消えた場合はelementだけをtombstone化して
asset bytes/file recordは削除しない。source SHA不一致、path traversal、symlink、mime/拡張子不一致は
main Canvas stateを進める前に拒否する。

## 途中の成果物（progress）の投影

Run と media の投影が出すのは、Job が決着した成果物（最終 MP4・監査・contact sheet・signoff・Receipt）
だけ。制作の途中を運営者が Canvas 上で見て判断できるよう、`projectVideoHarnessJob` は Run の投影の後に
**途中の成果物**も投影する。

- 描く側（ジャンル共通）: `lib/canvasRunProgressProjection.mjs`。入力は
  `buzzassist-canvas-progress-snapshot-v1`（工程の DAG、見出し、格子の section と item）で、
  要素は customData `buzzassist.harnessRunProgress.v1` で所有を示す。Run・media の要素とは所有が別なので、
  互いに墓標化しない
- 読む側（ジャンルごと）: 漫画は `lib/koyaMangaProgressSnapshot.mjs`。Job の隔離 workspace
  （`job.executionProjectDir`）の中だけを読み、外を指すパスと外へ出る symlink は読まない。
  読み取り側が無いハーネス（今はナレーション物語）は途中の投影をしない
- 出すもの（漫画）: 工程の DAG（doctor・声の人選・衣装・人物・本編の画・構成と顔の配置・台詞の音声・
  レンダー・最終監査・独立レビュー・RunReceipt・Canvas 投影を pending / running / pass / fail /
  awaiting-human-review で）、本編の画のカット順の格子（生成と QA の台帳の合否と、途中の成果物の品質ループ
  `lib/assetQualityLoop.mjs` の合否をラベルで）、人物の候補と承認済みの設定画、カットごとの採用テイク
- 承認前の人物は匿名: 「人物 N（承認前）」と候補の匿名ラベル A〜E だけを出し、名前・人物 id・説明・
  作り分けの軸・プロンプトを Canvas に書かない。候補の採用が記録されてから名前を出す
- 品質ループの記録の置き場は Job の workspace（`--work-dir` に workspace を渡す）。成果物の SHA で
  突き合わせるので、subject id の付け方に依らない。同じ subject で別の版を採点した記録は
  「別の版を採点済み」と出す
- 画は content-addressed に複製し（`canvas/assets/harness-runs/<runId>/<sha256>.<ext>`）、表示は
  `?w=640`（Canvas サーバーが ffmpeg で WebP に縮めて返す。256KB 以下は原本のまま）、原寸は要素の
  link から開く。採用テイクは `codexMediaKind: audio` の再生カードで、ポスターは WAV から描いた波形
- 配置: Run の投影（x=40 から右・下）と重ならないよう、左側（x < 0）の固定幅パネル。配置と要素 ID は
  snapshot（Job ID・工程・成果物のキー・SHA-256）だけで決まり、置き場の絶対パスに依らない
- 再投影: 投影 hash が同じ要素は触らず、変わった要素だけ version を上げ、消えた要素は墓標にする。
  画のラベルが変わっても画の要素は動かさない。新しい要素の index は scene の最大の後ろに付ける
- revision: 保存済み（`canvas/harness-runs/<runId>/canvas-progress.json`）より古い Job revision の投影は
  書かずに skip する。途中の成果物は workspace から毎回読み直す表示なので、同じ revision で中身が
  変わるのは正常（Run の投影のような衝突にしない）
- 失敗: 途中の投影の失敗は Job の状態遷移（completed の確定を含む）を止めず、戻り値の
  `progressProjection.ok=false` と `error` に残す

## 呼び出し

ライブラリから:

```js
import { projectCanvasRun } from "./lib/canvasRunProjection.mjs";

await projectCanvasRun({ projectDir }, canvasRunView);
```

CLIから:

```bash
node scripts/project-canvas-run.mjs \
  --project-dir <project-dir> \
  --input <canvas-run.json>
```

`--dry-run` はscene/stateを書かず、追加・更新・削除数だけ計算する。

## 共通Video Harness serviceとMCP

Job操作の唯一のcomposition rootは `lib/videoHarnessService.mjs`。CLI
`scripts/run-video-harness.mjs` とMCPはこのserviceへ委譲し、doctor、Channel Pack prepare、
Harness adapter、lock、Canvas投影を別々に組み立てない。

公開MCP toolは次の8つ（`lib/videoHarnessMcp.mjs` の `VIDEO_HARNESS_TOOL_NAMES` と同順）。

- `run_video_harness`: durable jobを作成または同じ入力のjobへ再接続する。`confirmed`の既定は
  `false` で、planだけを保存し有料処理を始めない。任意の`reviewerTrustPath`は照合用（後述）。
- `get_video_harness_job`: 1件の正本 `job.json` を読む。
- `list_video_harness_jobs`: project内の正常なvideo jobを列挙する。
- `cancel_video_harness_job`: cancellationをdurable stateへ記録してCanvasへ投影する。
- `resume_video_harness_job`: 同じjobを再開する。`confirmed: true` が必須。任意の`reviewerTrustPath`は
  照合用。
- `collect_video_harness_feedback`: 現在のBuzzAssist所有elementに付いた採択・却下・コメントだけを
  明示回収し、通常proposal台帳へappendする。
- `signoff_video_harness_job`: **narrated-story-video Job専用**の独立reviewer工程。
  `scripts/narrated-story-video.mjs signoff`を`run_koya_manga_pipeline action=signoff`と同じ引数名
  （`reviewer`, `reviewerContextId`, `reviewerKeyPath`, 任意の`reviewerTrustPath` / `videoPath` /
  `contactSheetPath` / `signoffPath` / `force`）に、採点ファイル`reviewPath`（Job の
  `review.quality` の評価項目すべての点数 `rubricScores`・所見 `notes`・直す点 `findings`）と
  判定`pass`（`true`＝承認、`false`＝差し戻し）を足して呼び、`confirmed: true`必須。
  承認でも差し戻しでも品質ループの1回として記録され、合格した回が無い限り final にならない。
  reviewer context は production Job の generator context と別で、前の回で使っていないものでなければならない。秘密鍵は
  `reviewerKeyPath`の**fileから**だけ読み、鍵の中身らしい引数名（`*Pem`, `*PrivateKey` 等）や
  PEM文字列・信頼リスト本文を含む値は拒否する。koya-manga-video Job をここへ渡すと拒否され、
  Koya は `run_koya_manga_pipeline action=signoff` を使う。有料APIは呼ばない。
- `create_video_harness_reviewer_key`: 両ハーネス共通の`reviewer-key-create`をMCPから呼ぶ。
  `reviewerKeyPath`（repo外・project-dir外・git作業木外の絶対path）と`confirmed: true`必須、
  任意で`reviewerPublicKeyPath` / `reviewerLabel`。秘密鍵をmode 0600で書き、既存fileを上書きせず、
  `keyId`と運営者が信頼リストへ登録する`trustEntry`（公開鍵だけ）を返す。秘密鍵は返さない。
  生成と同じcontextで作った鍵による signoff は独立レビューにならない。

### CLI との対応（`scripts/run-video-harness.mjs`）

```text
start  --harness ID --script-path FILE --channel-pack BUNDLE [--confirmed] [--reviewer-trust-path JSON]
resume --job-id ID --project-dir DIR --confirmed [--reviewer-trust-path JSON]
status / cancel / list
```

`--reviewer-trust-path`はMCPの`reviewerTrustPath`と同じ**照合用**実行時引数で、Job identityに入らず
`job.json`にも保存されない。信頼アンカーは実行側hostの`BUZZASSIST_REVIEWER_TRUST`
（または`BUZZASSIST_REVIEWER_TRUST_JSON`。旧`BUZZASSIST_KOYA_REVIEWER_TRUST(_JSON)`は互換で、新旧不一致は
`reviewer-trust-invalid:env-ambiguous`）だけ。明示pathの正規化sha256がenvと違えば`reviewer-trust-conflict`、
env未設定なら明示しても`reviewer-trust-unconfigured`でfail-closed。一致したpathは上位Jobからジャンル子CLI
（`koya-manga-video.mjs full` / `narrated-story-video.mjs full`）へも同じ値で渡され、両層が同じ信頼リストで
signoffを再検証する。`--options-json`の`reviewerTrust*` / `reviewerKeyPath` / PEM系fieldはJob作成前に拒否される。
reviewer signoff と reviewer-key-create は production Job とは別 context の工程で、CLIでは
`koya-manga-video.mjs signoff|reviewer-key-create` / `narrated-story-video.mjs signoff|reviewer-key-create`、
MCPでは上の2 toolと`run_koya_manga_pipeline`が同等入口になる。

### Receipt確定待ち（`awaiting-human-review` + `pendingReceiptFinalization`）

有料生成が終わったJobで、信頼リスト未設定（`reviewer-trust-unconfigured`）、
`reviewer-trust-conflict`、attestation欠落などの設定・証跡側の失敗によりRunReceiptが確定できない
場合、Jobは`failed`にならず`awaiting-human-review`へ置かれ、`job.json`に
`pendingReceiptFinalization`（version `buzzassist-video-harness-pending-receipt-v1`、確定予定の
outcome/artifacts、attempts、lastError）が残る。`resume_video_harness_job`（`confirmed: true`）は
このJobに対して**Receiptの確定だけ**を再試行し、Media Jobを再発行しない。確定待ちの間に成果物SHAが
変わっていれば`run-receipt-artifact-drift`で再び止まり、productionを勝手に再実行しない。
`run-receipt-artifact-drift`の唯一の出口は、宣言と成果物を直したうえで**新しいJobを作る**こと。
resumeは同じJobを何度でも同じblockerで止め、productionを再実行しない。課金は`requestKey` journal
（同じinput/provider/model/voice/paramsは同じrequest keyへ正規化）で再利用され、既に済んだMedia Jobを
再submitしない。
`reviewer-attestation-unsupported-harness`（harness宣言に`reviewAttestation.subject`が無い／未知）は
宣言がJob identityの一部なので、宣言を直したうえで**新しいJobを作る**のが復旧手順であり、resumeでは
直らない。

`run_video_harness` の実行開始にも `confirmed: true` の明示が要る。Channel Packは
`channelPackPath` が常に必須で、署名envelopeの検証はprepare側が行う。MCP/CLIへtrusted key、
signing key、API key、token、credentialを渡さない。`options`に秘密fieldがあればjob作成前に拒否し、
古いjobに秘密名fieldが残っていてもservice結果から除外する。

start/get/list/cancel/resumeはすべて `buzzassist-video-harness-service-result-v1` envelopeを返す。
`operation`, `projectDir`, `jobId`, `status`, `job`, `jobs`, `attached`, `execution`, `note` の形が共通なので、
Claude CodeとCodexで別の状態判定を持たない。`execution.planOnly === true` は「計画保存済み」であり、
動画完成ではない。

## runner/MCP側の接続点

1. `job.json` を原子的に保存した後、同じrevisionから `CanvasRun v1` を作る。
2. `projectCanvasRun()` を呼ぶ。呼び出し失敗をproduction jobの完成として隠さない。
3. artifact完成時に実バイトのSHAを渡す。パス文字列だけのhashをartifact SHAにしない。
4. `run_video_harness` / get / list / cancel / resume は共通serviceだけを呼び、その結果を再投影する。
5. Canvas feedback collectorは投影更新の直前に自動実行し、明示MCPからも呼べる。BuzzAssist所有ID、
   job ID、run fingerprint/revision、entity ID、projection hash、単調なfeedback revisionが全部一致する
   feedbackだけを捕捉する。同一revisionをdedupeし、stale revisionを再捕捉しない。
6. commentは800文字まで。秘密、台本本文、Channel Pack本文、POSIX/Windows/UNC絶対pathを拒否する。
   channel固有feedbackは隔離されたChannel Pack台帳だけへ送り、共有 `docs/learning` へ解決される構成は
   common capture pathでもfail-closedにする。genre/platform一般化は明示flagと許可targetが要る。

Browser上の見え方を最終的に確認する実測signoffとHarness固有production adapterは統合側の責任。
durable Jobはrunning投影とcompleted候補投影の両方が成功するまでterminal `completed` へ進めない。
