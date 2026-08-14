# 顔検出漏れ・重要証拠遮蔽時の手動領域レビュー

これは自動検出を無条件で迂回する承認ではない。画像QAを通過した実画像を原寸で確認し、発話者・非話者の検出漏れ顔と、台詞理解に不可欠な手・小道具・証拠・生成画像内文字を画像SHA-256へ拘束する例外経路である。最終MP4では別系統の顔監査と知覚レビューを必ず実施する。

## 手順

1. `koya-production-state.json`の`active-speaker-face-not-detected`、flatten済み分割ページの`split-page-face-inventory-required`、または独立した実MP4レビューが示した顔・重要物の遮蔽を対象にする。
2. 各`imagePath`を原寸表示する。顔は頭髪、目、鼻、口、顎を含む保守的な矩形、重要物は台詞の意味を成立させる可視情報全体を測る。分割ページでは黒ガター合成後のflatten済み実ファイルを測る。発話者でない人物も除外しない。
3. 画像ファイルのSHA-256を計算する。スクリーンショットや別解像度のhashを使わない。
4. 下記JSONを作り、`--source-face-review-path`を付けて`prepare`または`full`を再開する。
5. 顔の話者ID、kind、画像hash、矩形、未使用注釈のどれかが不一致なら停止する。画像を変更した場合は古い注釈を再利用しない。同じ発話に複数領域がある場合は一意な`id`を持つ複数注釈を保存する。採用した領域はすべて`hardProtection=true`としてカメラ全区間で0px保護する。自動cascadeには人物同定能力がないため、対象発話者と同じ`speakerId`のhash拘束付き手動顔は、自動検出が存在しても必ず発話者primaryを上書きする。`thought`の明部中心も同じprimaryを使うので、群衆画面では主人公以外へ光が当たっていないか実MP4の開始・中間・終了で確認する。自動検出顔自体は消さず、非話者を含むhard obstacleとして残す。

```json
{
  "version": "koya-source-region-review-v2",
  "episodeId": "manga-example-001",
  "reviewedBy": "codex:<実task-id> または claude:<実session-id>",
  "reviewedAt": "2026-08-13T00:00:00.000Z",
  "annotations": [
    {
      "id": "cut-02-u03-speaker-face",
      "utteranceId": "cut-02-u03",
      "kind": "face",
      "speakerId": "approved-character-id",
      "imageSha256": "64桁の実画像SHA-256",
      "bounds": { "x": 0.30, "y": 0.12, "width": 0.14, "height": 0.29 },
      "note": "原寸画像で髪、眼鏡、両目、鼻、口、顎を含む発話顔を確認した"
    },
    {
      "id": "cut-04-u02-phone-evidence",
      "utteranceId": "cut-04-u02",
      "kind": "evidence",
      "imageSha256": "64桁の実画像SHA-256",
      "bounds": { "x": 0.18, "y": 0.36, "width": 0.28, "height": 0.31 },
      "note": "原寸画像で内定を示すスマホ画面全体を確認した"
    }
  ]
}
```

分割ページの例では、左・右上・右下など人物が存在する全パネルについて次のように同じflatten済み画像SHA-256へ結び付ける。

```json
{
  "id": "cut-08-u03-left-panel-face",
  "utteranceId": "cut-08-u03",
  "kind": "face",
  "speakerId": "approved-character-id",
  "imageSha256": "flatten済み最終ページの64桁SHA-256",
  "bounds": { "x": 0.08, "y": 0.10, "width": 0.18, "height": 0.30 },
  "note": "flatten済み原寸ページ左パネルの人物について髪から顎までを囲った"
}
```

`kind`は`face/hand/prop/evidence/text`だけを使う。顔だけ`speakerId`を必須とし、重要物では省略できる。座標は対象の実画像左上を`0,0`、右下を`1,1`とする。`x + width <= 1`、`y + height <= 1`でなければならない。顔が画面外へ切れているときは見えている範囲を矩形化し、切れている事実を`note`へ書く。分割ページに人物がいるのに顔注釈が0件なら停止し、別発話の通常画像から推測した座標を流用しない。正規化矩形をpixelへ戻すときは契約上の1920×1080を仮定せず、overlay specに記録された実`imageSize`を必ず使う。

```bash
node scripts/koya-manga-video.mjs full \
  --episode-id manga-example-001 \
  --script-path /absolute/script.txt \
  --protagonist-speaker-id <主人公> \
  --source-face-review-path /absolute/source-face-review.json \
  --retry-failed
```
