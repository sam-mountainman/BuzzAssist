# 実MP4知覚レビュー

`signoff`は自動監査の代替ではなく、機械が判断できない品質を実際に見聞きした記録である。レビュー記録は契約digest、実MP4、contact sheet、代表フレーム、確認時刻、確認区間へ結び付く。いずれかのbyteが変わるとSHA-256が変わるため、旧署名は無効になる。

## 必ず確認する証拠

1. 最終MP4を最初から最後まで再生する
2. 最終MP4から生成されたcontact sheetを拡大して見る
3. 各人物、分割ページ、吹き出し密集部、重要小道具、感情頂点の代表フレームを見る
4. 冒頭、カット境界、問い返し、長文、過去に直した箇所、末尾を音声スポットチェックする

## レビュー項目

- `characterContinuity`: 人物同一性、年齢、服、髪、色
- `composition`: 構図変化、背景、余白、文脈
- `camera`: 意味、3系統、単調さ、停止・push-in・clampなし
- `bubblePlacement`: 話者顔・重要物への重なりなし、順番
- `splitPages`: 必要性、ガター、flatten後の一体移動
- `textReadability`: 縦組、文節、文字化け、疑似文字なし
- `anatomyAndPropScale`: 顔、身体、手、指、小道具、遠近
- `editContinuity`: 場面、視線、行動、因果が切れない
- `imagePacing`: 画像切替が多すぎず、一画像の保持時間が自然
- `dialoguePacing`: 問い返し、話者交代、感情転換の間
- `audioNaturalness`: 読み、抑揚、速度、感情、文末完全性
- `audioBoundaryArtifacts`: 頭切れ、click、孤立tail burst、humなし
- `generatedTextArtifacts`: 小道具・背景に疑似文字や不要ロゴなし

## レビュー記録JSON

各項目の値は8文字以上の具体的な日本語メモにする。`true`だけの自己申告は不可。hash、尺、絶対パスはレビュー対象の実ファイルから計算し、例の値を転記しない。`reviewedAt`は実際に確認し終えた時刻にする。

```json
{
  "version": "koya-perceptual-review-notes-v3",
  "episodeId": "manga-example-001",
  "contractDigest": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "reviewedAt": "2026-08-12T12:00:00.000Z",
  "reviewer": {
    "host": "codex",
    "id": "codex:実タスクID",
    "contextId": "実タスクID"
  },
  "summary": "全尺、全監査証拠、代表フレーム、音声区間を確認し完成品質に達している",
  "rubricScores": {
    "semantic-scene-fit": 95,
    "character-continuity": 95,
    "camera-composition": 95,
    "editorial-grammar": 95,
    "bubble-typography": 95,
    "voice-performance": 95,
    "audio-technical": 95,
    "timing-continuity": 95,
    "final-playback": 95
  },
  "video": {
    "path": "/ABSOLUTE/PATH/final.mp4",
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "durationSeconds": 100
  },
  "contactSheet": {
    "path": "/ABSOLUTE/PATH/contact-sheet.jpg",
    "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  "evidence": {
    "fullVideoReviewed": {
      "note": "00:00から終端まで連続再生し、停止や欠落なし",
      "startSeconds": 0,
      "endSeconds": 100
    },
    "contactSheetReviewed": {
      "note": "全コマを原寸で拡大し、人物と編集連続性を確認した"
    },
    "representativeFramesReviewed": {
      "note": "冒頭・感情頂点・終幕の実フレームを原寸確認した",
      "frames": [
        {
          "path": "/ABSOLUTE/PATH/frame-01.jpg",
          "sha256": "1111111111111111111111111111111111111111111111111111111111111111",
          "timestampSeconds": 1.5,
          "checkIds": ["characterContinuity", "composition", "bubblePlacement"]
        },
        {
          "path": "/ABSOLUTE/PATH/frame-02.jpg",
          "sha256": "2222222222222222222222222222222222222222222222222222222222222222",
          "timestampSeconds": 50,
          "checkIds": ["anatomyAndPropScale", "textReadability", "generatedTextArtifacts"]
        },
        {
          "path": "/ABSOLUTE/PATH/frame-03.jpg",
          "sha256": "3333333333333333333333333333333333333333333333333333333333333333",
          "timestampSeconds": 98.5,
          "checkIds": ["characterContinuity", "splitPages", "composition"]
        }
      ]
    },
    "audioSpotChecksReviewed": {
      "note": "冒頭・中盤・終端をヘッドホンで実際に確認した",
      "intervals": [
        { "startSeconds": 0, "endSeconds": 2, "note": "冒頭の頭切れとノイズがないことを確認" },
        { "startSeconds": 49, "endSeconds": 52, "note": "中盤の話者交代と間を実聴確認した" },
        { "startSeconds": 98, "endSeconds": 100, "note": "終端の文末とクリックなしを確認した" }
      ]
    }
  },
  "checks": {
    "characterContinuity": { "note": "全カットで人物の顔・服装段階が連続している", "evidenceRefs": ["contactSheet", "representativeFrames"] },
    "composition": { "note": "場面と発話の意味が一致し、余白も自然である", "evidenceRefs": ["contactSheet", "representativeFrames"] },
    "camera": { "note": "全編で三系統を確認し、不自然な停止がない", "evidenceRefs": ["fullVideo"] },
    "bubblePlacement": { "note": "表示中の話者顔と重要物への重なりがない", "evidenceRefs": ["representativeFrames"] },
    "splitPages": { "note": "必要性とflatten後の一体移動を確認した", "evidenceRefs": ["representativeFrames"] },
    "textReadability": { "note": "縦組・文節・字形を原寸で確認した", "evidenceRefs": ["representativeFrames"] },
    "anatomyAndPropScale": { "note": "手指・身体・小道具比率に破綻がない", "evidenceRefs": ["representativeFrames"] },
    "editContinuity": { "note": "場面・視線・行動・因果が全編で連続している", "evidenceRefs": ["fullVideo"] },
    "imagePacing": { "note": "画像保持時間と切替頻度が全編で自然である", "evidenceRefs": ["fullVideo", "contactSheet"] },
    "dialoguePacing": { "note": "問い返しと話者交代の間が全編で自然である", "evidenceRefs": ["fullVideo", "audioSpotChecks"] },
    "audioNaturalness": { "note": "読み・抑揚・速度・感情・文末に問題がない", "evidenceRefs": ["audioSpotChecks"] },
    "audioBoundaryArtifacts": { "note": "頭切れ・click・tail burst・humがない", "evidenceRefs": ["audioSpotChecks"] },
    "generatedTextArtifacts": { "note": "背景と小道具に疑似文字・不要ロゴがない", "evidenceRefs": ["representativeFrames", "contactSheet"] }
  },
  "knownRemainingIssues": []
}
```

最低3枚の代表フレームと、冒頭・中盤・終端を含む最低3区間の音声確認が必要である。全編確認区間は0秒から実尺終端までを覆う。`signoff`と再監査は、レビュー記録ファイル自体のSHA-256と正規化内容digestも検証する。

問題が1件でもあれば署名せず、`knownRemainingIssues`へ時刻、対象、症状を書く。ユーザー指摘と機械結果が矛盾したらユーザー指摘を不合格根拠にする。

吹き出し末尾句点を除く契約では、原寸フレームの目視だけでなく`bubble-typography.json`の`terminalPunctuation`を確認する。全SVGの`data-text`を機械検査し、`pass=true`かつ`terminalPeriodFound=false`でなければ署名しない。旧episodeの修復は公式`refresh-bubbles`→`render --force`→`audit`の順で行い、音声・台本本文は変更しない。

再監査の最後に`audits/koya-final/quality-harness/final-decision.json`を読む。`status=passed`、独立contextの品質roundが1件以上、自分自身を除く全必須監査が`passedAuditIds`へ含まれること、各適用監査の`evidenceSha256`、契約digest、実MP4 SHA-256、`evidence-manifest.json`のSHA-256とMerkle rootが現在値と一致することを確認する。`needs-human-approval`は知覚署名待ち、`blocked`は機械監査・品質loop・証拠拘束の失敗であり、どちらも完成ではない。
