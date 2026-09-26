# 解説動画のハーネス（explainer-video）— 既存のローカル制作の取り込み

チャンネルが手元で持っている解説動画の制作（HTML/CSS/素の JavaScript の映像、ローカルの音声、レンダーの
スクリプト）を作り直さずに、BuzzAssist の共通の入口（`node scripts/run-video-harness.mjs` の plan-request /
start / resume、Job、RunReceipt、Canvas の投影）へつなぐ「薄い接続」です。制作エンジンは BuzzAssist に入れません。

- 宣言: `config/harnesses/explainer-video.harness.json`（保証と監査の対応、`inForceSince`）
- 能力カード: `config/harnesses/explainer-video.capabilities.json`
- 入口: 上位は `node scripts/run-video-harness.mjs`、Job の中の runner は `node scripts/explainer-video.mjs full`
  （Job の束縛が無ければ `explainer-outer-job-required` で止まる）。読むだけの `plan` もある
- 本体: `lib/explainerChannelPack.mjs`（Pack の中身の形・start の引数）、`lib/explainerVideo.mjs`（計画・取り込み・監査・制作の実行・
  人の確認の記録）、`lib/explainerQualityLoop.mjs`（完成動画の品質契約。署名済みの評価を回にする配線はナレーション物語と共通の
  `lib/signedReviewQualityLoop.mjs`）
- 人の確認の入口: `node scripts/explainer-video.mjs signoff`（MCP の `signoff_video_harness_job`）。署名は3つのハーネスで共通の
  `lib/koyaReviewAttestation.mjs`（subject `explainer-video`）

## 1. 実行の型

Job の `options.explainerMode`（CLI は start の `--explainer-mode`）で決まり、Job の識別子に入ります（後から変えられない）。

| 型 | すること | 制作のスクリプト | 有料・モデルの呼び出し |
|---|---|---|---|
| `import-delivery`（既定） | 制作が書いた納品の記録（DELIVERY.json）の成果物と台本の SHA を照合し、一致すれば取り込んで監査する。一致しなければ理由コードで止める | 起動しない | しない。子プロセスに `lib/paidCallGuard.mjs` の関所を入れ、BuzzAssist の有料の送り口は送る前に止める。止めた呼び出しが1件でもあれば failed |
| `produce` | Channel Pack の `production.steps` を順に起動し（3つのパスを必ず明示）、できた納品を同じ監査にかける | 起動する | チャンネルの制作のスクリプトしだい（このハーネスは数えない） |

`{rendererUrl}` を使う制作の雛形は、start の `--explainer-renderer-url`（手元の HTTP サーバーの URL。
`http://127.0.0.1:<port>/...` か localhost）が要ります。サーバーは運営者が起動します。無ければ何も起動せずに
`explainer-renderer-url-required` で人待ちに止まります。Pack が制作のコマンドを宣言していなければ
`explainer-production-not-declared` で止まります。

## 2. Channel Pack の中身（payload）

署名の封筒は既存の `lib/channelPackEnvelope.mjs`（`node scripts/channel-pack.mjs sign --harness explainer-video
--payload-kind explainer-channel-pack ...`）。payload は `explainer-channel-pack.json` 1つで、台本の本文・研究の資料・
声の参照音声は入れません（パスと SHA だけ）。形（例は合成）:

```json
{
  "version": "buzzassist-explainer-channel-pack-v1",
  "channelId": "sample-explainer",
  "harnessId": "explainer-video",
  "videoRoot": "/absolute/path/to/video-project",
  "paths": { "productionDir": "production/releases/draft3", "visualsDir": "visuals-v3", "outputDir": "out-v3" },
  "delivery": { "file": "out-v3/DELIVERY.json" },
  "release": {
    "deliverySha256": "<64桁>", "scriptSha256": "<64桁>", "videoSha256": "<64桁>",
    "captionsSha256": "<64桁>", "thumbnailSha256": "<64桁>", "uploadMetadataSha256": "<64桁>"
  },
  "scriptQuality": { "genre": "explainer", "workDir": "production" },
  "assetQuality": { "workDir": ".", "stages": ["thumbnail"] },
  "display": { "bgm": "none", "numerals": "arabic" },
  "production": {
    "steps": [
      { "id": "render", "argv": ["node", "scripts/render.mjs", "--production-dir", "{productionDir}", "--visuals-dir", "{visualsDir}", "--output-dir", "{outputDir}", "--url", "{rendererUrl}"] },
      { "id": "package", "argv": ["python3", "scripts/package.py", "--production-dir", "{productionDir}", "--output-dir", "{outputDir}"] }
    ]
  }
}
```

- パスは `videoRoot` からの相対だけ（絶対パス・ドライブ名・`..` は受けない）
- 3つのパスは、制作の雛形のどこかに必ず `{productionDir}` `{visualsDir}` `{outputDir}` として出てくること
  （省くと古い版を作り直すスクリプトがあるので、既定に頼らない）。起動するときは絶対パスで明示する
- 実行ファイルは `node`（今動いている Node）・`python3`・`python` だけ。シェルの文字列は受けない
- `release` は任意。書くなら `deliverySha256`・`scriptSha256`・`videoSha256` は必ず書き、取り込みでは全部の一致を求める。
  制作し直した（produce）ときは、できた納品を納品の記録と照合する（`release` は取り込みの版を縛るもの）
- 制作の実行を宣言しないなら `"production": { "status": "not-declared", "reason": "…" }`
- 表示の決まりは機械で確かめられるものだけ（`bgm: none | allowed`、`numerals: arabic | any`）。常時の左上タイトルが無いことなど、
  画の決まりは人の試聴・視聴で確かめる

## 3. 納品の記録（DELIVERY.json）の形

制作側が書く記録で、ハーネスは次の欄を読みます。パスは絶対か、記録のあるフォルダからの相対。成果物は `outputDir`、台本は
`productionDir` の中でなければなりません。

```text
script_sha256, script,
video: { file, sha256, bytes, duration_seconds, width, height, fps, frames?, bgm?, script_sha256? },
captions, captions_sha256, thumbnail, thumbnail_sha256, upload_metadata, upload_metadata_sha256?
```

投稿用情報の SHA が記録に無いときは、Pack の `release.uploadMetadataSha256` で縛ります（どちらにも無ければ止まる）。

## 4. 監査（完成 MP4 で測る）

宣言の保証と監査の対応（機械の監査は `buzzassist-explainer-audit-v1` から、人の確認の2つは `buzzassist-explainer-audit-v2` から。
v1 で測る記録では v2 の保証は効力の外（not-in-force）になり、すでに走った Job を後から落とさない）:

| 保証 | 監査 | 何を見るか |
|---|---|---|
| delivery-bound | deliveryManifestBound / scriptBoundToDelivery / deliveryArtifactsBound | 納品の記録、Job の台本の SHA、動画・字幕・サムネ・投稿用情報の SHA（記録と Pack の版） |
| final-video-decodes | finalVideoFullDecode | 共通の実デコード（`lib/videoHarnessReceipt.mjs` の `validateFinalVideoMedia`） |
| duration-conformance | durationMatchesDelivery | 尺（±0.05 秒）・幅・高さ・fps・フレーム数と納品の記録 |
| captions-in-range | captionsTimingInRange | 字幕の時刻が読める・0 秒以上・動画の終わり以内・順に並ぶ |
| thumbnail-present | thumbnailPresent | 画として読める（見出しから寸法） |
| script-quality-accepted | scriptQualityAccepted | 台本の品質ループ（`lib/scriptQualityUseGate.mjs`、ジャンル explainer）。作業フォルダは `options.scriptQualityWorkDir`、無ければ Pack の `scriptQuality.workDir` |
| asset-quality-loop | assetQualityLoopsPassed | Pack の `assetQuality.stages`（今はサムネ）が途中の成果物の品質ループ（harness explainer-video）で合格した版と同じか |
| display-rules | displayNumeralsArabic / bgmAbsentMeasured | 字幕の漢数字の数量・年（2字以上の漢数字＋数え方の語）／完成 MP4 の音の無音の区間（-50 dBFS 未満・0.3 秒以上）と、音の途切れない最長の区間（60 秒まで） |
| no-new-paid-calls | noBuzzAssistPaidCalls | 関所の台帳が空（取り込みでは関所が効いていなければ不合格） |
| human-review-signed（v2） | humanReviewSigned | 別の文脈の評価者が全編を通して見て承認し、信頼リストの鍵で Job・完成 MP4・contact sheet・納品の記録に結び付けて署名した（5 章） |
| quality-loop（v2） | qualityLoopPassed | その評価を品質ループの1回として記録し、目標点以上・どの項目も下限以上・評価者が承認した回だけを合格にする（5 章） |

- 納品の記録と一致しないファイルは測りません（一致しない動画をデコードして合格にしない）
- 時刻の行の直後が空行の字幕は、合否には使わず観察（observations）として残します。ffmpeg は読めますが、読み手によっては
  そこで字幕が終わったと読み、本文が落ちます
- BGM の閾値は、声だけの完成版（語りの間の無音の間隔が最大 7 秒ほど）と、低い持続音を重ねた合成（無音の区間 0）を同じ
  測定にかけて決めました

## 5. 人の確認と完成（completed）

人の確認（全編の試聴と、初見の視聴者の理解・聞きやすさの評価）は機械の監査とは別の工程で、ナレーション物語と同じ仕組み
（信頼リストの鍵の署名・品質ループの1回・共通の RunReceipt の検証）で記録します。新しい仕組みは作っていません。

1. 取り込みの監査のあと、runner が Job の `explainer/review/` に次を置きます
   - `contact-sheet.png`: 完成 MP4（納品の記録と一致して最後までデコードできたもの）の全尺から 24 枚を 4x6 に並べた1枚。
     同じ MP4 なら作り直さない（署名に入る SHA が揺れない）。MP4 が変われば作り直し、前の署名は落ちる
   - `review-sheet.json`: 評価シート。評価項目の id・名前・説明と点数の尺度・契約の digest、採点ファイルの雛形だけで、
     **合格点・下限・重み・前の回の点数は載せない**（見ると採点がそれに寄る）。評価者はこれと MP4 だけで採点し、
     ループのソース（`lib/*QualityLoop.mjs`）は開かない
2. 評価項目は共通の解説動画の項目（`lib/scriptQualityLoop.mjs` の explainer の id・名前・重み・下限）を、完成した動画を
   初見で通して見て採点する形にしたもの: 問いの明確さ・初見での理解・発見の積み上がり・冒頭の約束の回収・図解と説明の対応・
   テンポ・読み、と完成した音でしか分からない聞きやすさ。根拠が支える範囲は台本の品質ループで見る（初見の視聴者は出所を
   確かめられない）。機械では測れない所見は notes と findings に書く。チャンネルごとの評価者の数・点・回数は作らない
3. 評価者（Job を動かした文脈とは別の人・別の会話）が、自分の端末で signoff を打ちます（8 章のコマンド）。signoff は
   監査の報告が指す完成 MP4・contact sheet・納品の記録を disk から読み直して SHA を取り、運営者の信頼リストにある鍵で
   Job の識別子・3つの SHA・signoff の本文に署名して `explainer/review/human-review-signoff.json` に書きます。評価の文脈が
   Job と同じ（`<jobId>`・`production:<jobId>`）なら書きません。`--full-length-viewed` の無い signoff も書きません
4. `resume` で runner が署名を確かめ（信頼リストが無い・鍵が失効・署名の改ざん・別の MP4 や納品への署名は不合格）、
   **機械の監査が全部通っているときだけ**その評価を品質ループの1回として記録します（通っていなければ
   `explainer-human-review-waiting-for-machine-audits` で待ち、回は消費しない。サムネの品質ループが合格してから resume すれば
   同じ signoff で記録される）。評価者の差し戻し（`--fail`）は点数に関わらず不合格の回です
5. 回が合格すると runner は `final-audited` を返し、共通の RunReceipt（`lib/videoHarnessReceipt.mjs` の
   `SIGNOFF_BINDING_VALIDATORS` の `explainer-video`）が、完成 MP4 の実デコード・contact sheet・納品の記録・監査の報告の
   humanReviewSigned / qualityLoopPassed・署名を検証し直して、Job を `completed`（RunReceipt の outcome pass、
   knownRemainingIssues 空）に確定します。検証が通らなければ `awaiting-human-review`（`pendingReceiptFinalization`）で止まり、
   resume は確定だけをやり直します
6. 合格しなかった回のあとは、直した完成版を納品し直し、`explainer/quality/revision-delta.json` に
   `{ "previousFailureFingerprint": "…", "revisionDelta": "直した内容" }` を書いて、新しい評価の文脈で signoff し直します。
   Pack が版の SHA を縛っていれば、直した納品は新しい Pack・新しい Job になるので、新しい Job の同じ場所に
   `"predecessorJobId": "<前の Job>"` も書いてループを引き継ぎます（ナレーション物語と同じ引き継ぎ。回数・時間の上限は
   引き継いだ回を含めて数える）

完成版の動画と納品の記録は、確定（`final-audited`）のときだけ Job の成果物に載ります（チャンネルのフォルダの元のファイルを指し、
写さない）。Canvas はそのとき完成 MP4 を1回だけ投影します。人待ちの間の成果物は監査の報告・RunReceipt・contact sheet だけです。

## 6. 書く場所

共通の入口の決まりどおり、チャンネルの作業フォルダ（台帳の `projectDir`）の中にだけ書きます。

```text
<projectDir>/canvas/harness-runs/<jobId>/job.json            Job（入力の台本の写し input/ も共通の入口が置く）
<projectDir>/canvas/harness-runs/<jobId>/canvas-run.json      Canvas の投影の状態
<projectDir>/canvas/harness-runs/<jobId>/explainer/audit-report.json   監査の報告（取り込んだ成果物のパスと SHA）
<projectDir>/canvas/harness-runs/<jobId>/explainer/run-receipt.json    RunReceipt（harness-run-receipt-v1。パスは持たない）
<projectDir>/canvas/harness-runs/<jobId>/explainer/review/            contact sheet・評価シート・人の確認の signoff
<projectDir>/canvas/harness-runs/<jobId>/explainer/quality/           人の確認の品質ループの状態と revision-delta.json
<projectDir>/canvas/harness-runs/<jobId>/run-receipt.json             completed に確定したときの共通の RunReceipt
<projectDir>/canvas/excalidraw-canvas.json                     Canvas の表示
<projectDir>/.buzzassist/channel-pack-acceptance.json          Channel Pack の版の受け入れの記録
```

取り込んだ完成版のファイル（動画・字幕・サムネ・投稿用情報）は Job のフォルダへ写しません。人待ちの間は SHA と大きさだけを
監査の報告と RunReceipt に残し、completed に確定するときだけ完成 MP4 と納品の記録を（元の場所を指したまま）Job の成果物に載せます。

## 7. チャンネルの台帳の例（合成）

`config/harness-deployments.json`（運営者の端末の追跡しないファイル）の `deployments` に
`{ "harnessId": "explainer-video", "root": ".", "entrypoint": "node scripts/explainer-video.mjs" }` を足し、`channels` に:

```json
{
  "id": "sample-explainer",
  "projectDir": "/absolute/path/to/channel-project",
  "channelPack": "/absolute/path/to/canvas/sample-explainer-handoff/signed-envelope",
  "production": { "kind": "harness", "harnessId": "explainer-video" },
  "strategy": { "workDir": "/absolute/path/to/channel-project/strategy-work", "requireBrief": false },
  "scriptQuality": { "genre": "explainer" }
}
```

`requireBrief` の決め方は `docs/strategy-handoff-spec-ja.md` の 7.1。

## 8. 手順

```bash
# 読むだけ（何を再利用し、何を実行するか）
node scripts/run-video-harness.mjs plan-request --channel sample-explainer --request-kind produce --request "<依頼文>" --script-path <台本>
# 計画だけの Job（Canvas に投影。有料 API を呼ばない）
node scripts/run-video-harness.mjs start --channel sample-explainer --script-path <台本>
# 取り込みと監査（完成済みの取り込みは有料・モデルの呼び出し 0 件）
node scripts/run-video-harness.mjs resume --job-id <jobId> --project-dir <projectDir> --confirmed

# 途中の成果物（サムネ）の品質ループ。作業フォルダは Pack の assetQuality.workDir（videoRoot からの相対を絶対にしたもの）、
# 対象 id は thumbnail、ファイルは納品の記録のサムネ。評価者は sheet の出力だけで採点する
node scripts/asset-quality-loop.mjs start  --work-dir <dir> --harness explainer-video --stage thumbnail --subject thumbnail --generator-context <サムネを作った文脈の ID>
node scripts/asset-quality-loop.mjs sheet  --work-dir <dir> --stage thumbnail --subject thumbnail --asset <納品のサムネ>
node scripts/asset-quality-loop.mjs record --work-dir <dir> --stage thumbnail --subject thumbnail --asset <納品のサムネ> --version <版の名前> \
  --review <採点ファイル> --producer-context <サムネを作った文脈の ID> --producer-host <host> --route <経路> \
  --reference-exempt-reason "人物が写らない"   # 人物が写るなら --reference <設定画> --approved-references <一覧.json>
node scripts/asset-quality-loop.mjs verify --work-dir <dir> --stage thumbnail --subject thumbnail --asset <納品のサムネ> \
  --check hand-safety --pass --reviewer <名前> --note "何を見てどう判断したか" --human-verified   # 人が自分の対話端末で（人物が写るなら --check identity も）
node scripts/asset-quality-loop.mjs status --work-dir <dir> --stage thumbnail --subject thumbnail --asset <納品のサムネ> --require-pass

# 人の確認（評価者が、Job を動かした文脈とは別の文脈・自分の端末で）
node scripts/explainer-video.mjs reviewer-key-create --reviewer-key-path /absolute/outside-repo/reviewer-ed25519.pem --reviewer-label <名前>   # 初回だけ。trustEntry を運営者へ
#   → 評価シート <projectDir>/canvas/harness-runs/<jobId>/explainer/review/review-sheet.json で、完成 MP4 を全編通して見て採点し、採点ファイルを書く
node scripts/explainer-video.mjs signoff --job-id <jobId> --project-dir <projectDir> --reviewer-id <評価者の名前> \
  --reviewer-context-id <この評価の文脈の ID> --reviewer-key-path /absolute/outside-repo/reviewer-ed25519.pem \
  --review-path <採点ファイル> --full-length-viewed --pass   # 差し戻しは --fail（findings を1件以上）
# 確定（署名・品質ループ・共通の RunReceipt。有料の呼び出しはしない）
node scripts/run-video-harness.mjs resume --job-id <jobId> --project-dir <projectDir> --confirmed
node scripts/run-video-harness.mjs status --job-id <jobId> --project-dir <projectDir>
```

サムネの品質ループの引数の詳しい形は `node scripts/asset-quality-loop.mjs help` と
`.agents/skills/platform-craft/references/quality-loops-ja.md` にあります（ここに書いたのは流れ）。採点ファイルの形は
`{ "rubricScores": { "<評価項目の id>": 0〜100 }, "notes": "見て判断したこと", "findings": ["直すべき点"] }` で、評価項目の id は
評価シートにあるものを全部使います。信頼リストは運営者が `BUZZASSIST_REVIEWER_TRUST` に設定し、評価者の公開鍵（trustEntry）を
運営者が足します（`.agents/skills/platform-craft/references/reviewer-attestation-ja.md`）。

BuzzAssist を更新したあとの resume は、ほかのハーネスと同じく `canonical-identity-drift` で止まります（Job の識別子に
コードの同一性が入るため）。同じ入力で新しい Job を start し直します（取り込みは有料の呼び出しをしないので、作り直しても
費用はかかりません）。解説動画の Job での `resume --finalize-after-update` はまだ試していません。

## 9. 学習の宛先

解説動画の Job の確定時の捕捉・途中の成果物と台本の品質ループの不合格・Canvas の採否は、解説動画のチャンネルの
非公開台帳 `channel-pack:explainer`（`docs/learning/targets.json`、正本の台帳は保存先の `docs/explainer-requirements-ledger.md`）
へ積みます。保存先はチャンネルごと（運営者の配置表の `channelLearning` の宣言か、無ければ学習の置き場の `channels/<チャンネルの id>`。
`lib/channelRegistry.mjs`・`lib/learningChannelResolver.mjs`）で、チャンネル固有の事実は共有層へ流しません。ジャンルの正本スキルが
まだ無いので `genre:` の宛先は持たず、共有層（`platform:`）へ上げるのは人が宛先を明示したときだけです。
