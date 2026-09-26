# 解説動画のハーネス（explainer-video）— 既存のローカル制作の取り込み

チャンネルが手元で持っている解説動画の制作（HTML/CSS/素の JavaScript の映像、ローカルの音声、レンダーの
スクリプト）を作り直さずに、BuzzAssist の共通の入口（`node scripts/run-video-harness.mjs` の plan-request /
start / resume、Job、RunReceipt、Canvas の投影）へつなぐ「薄い接続」です。制作エンジンは BuzzAssist に入れません。

- 宣言: `config/harnesses/explainer-video.harness.json`（保証と監査の対応、`inForceSince`）
- 能力カード: `config/harnesses/explainer-video.capabilities.json`
- 入口: 上位は `node scripts/run-video-harness.mjs`、Job の中の runner は `node scripts/explainer-video.mjs full`
  （Job の束縛が無ければ `explainer-outer-job-required` で止まる）。読むだけの `plan` もある
- 本体: `lib/explainerChannelPack.mjs`（Pack の中身の形・start の引数）、`lib/explainerVideo.mjs`（計画・取り込み・監査・制作の実行）

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

宣言の保証と監査の対応（効力は `buzzassist-explainer-audit-v1` から）:

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

- 納品の記録と一致しないファイルは測りません（一致しない動画をデコードして合格にしない）
- 時刻の行の直後が空行の字幕は、合否には使わず観察（observations）として残します。ffmpeg は読めますが、読み手によっては
  そこで字幕が終わったと読み、本文が落ちます
- BGM の閾値は、声だけの完成版（語りの間の無音の間隔が最大 7 秒ほど）と、低い持続音を重ねた合成（無音の区間 0）を同じ
  測定にかけて決めました

## 5. 人の評価と完成（completed）

人の全編の試聴・初見の評価は機械の監査の外です。記録する口がまだ無いので、Job はいつも `explainer-human-review-pending` を
knownRemainingIssues に残して `awaiting-human-review` で止まります（点数を作らない）。宣言の `completion.status` は
`pending` で、完成へ確定するには、人の評価を完成 MP4 の SHA に結び付けた署名つきの記録と、それを共通の RunReceipt で
検証する口（`reviewAttestation.subject`）が要ります。

## 6. 書く場所

共通の入口の決まりどおり、チャンネルの作業フォルダ（台帳の `projectDir`）の中にだけ書きます。

```text
<projectDir>/canvas/harness-runs/<jobId>/job.json            Job（入力の台本の写し input/ も共通の入口が置く）
<projectDir>/canvas/harness-runs/<jobId>/canvas-run.json      Canvas の投影の状態
<projectDir>/canvas/harness-runs/<jobId>/explainer/audit-report.json   監査の報告（取り込んだ成果物のパスと SHA）
<projectDir>/canvas/harness-runs/<jobId>/explainer/run-receipt.json    RunReceipt（harness-run-receipt-v1。パスは持たない）
<projectDir>/canvas/excalidraw-canvas.json                     Canvas の表示
<projectDir>/.buzzassist/channel-pack-acceptance.json          Channel Pack の版の受け入れの記録
```

取り込んだ完成版のファイル（動画・字幕・サムネ・投稿用情報）は Job の成果物に写しません。Canvas の投影が大きな動画の
複製を作らないように、SHA と大きさだけを監査の報告と RunReceipt に残します。

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
```

BuzzAssist を更新したあとの resume は、ほかのハーネスと同じく `canonical-identity-drift` で止まります（Job の識別子に
コードの同一性が入るため）。同じ入力で新しい Job を start し直します（取り込みは有料の呼び出しをしないので、作り直しても
費用はかかりません）。解説動画の Job での `resume --finalize-after-update` はまだ試していません。
