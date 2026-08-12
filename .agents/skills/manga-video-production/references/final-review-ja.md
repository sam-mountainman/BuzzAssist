# 実MP4知覚レビュー

`signoff`は自動監査の代替ではなく、機械が判断できない品質を実際に見聞きした記録である。MP4が変わるとSHA-256が変わるため、旧署名は無効になる。

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

各項目の値は空でない具体的な日本語メモにする。`true`だけの自己申告は不可。

```json
{
  "version": "koya-perceptual-review-notes-v1",
  "evidence": {
    "fullVideoReviewed": "00:00から終端まで再生し、停止や欠落なし",
    "contactSheetReviewed": "24枚を拡大確認",
    "representativeFramesReviewed": "人物・吹き出し・小道具の代表時刻を確認",
    "audioSpotChecksReviewed": "冒頭、全境界、終端をヘッドホン確認"
  },
  "checks": {
    "characterContinuity": "全カットで人物の顔・服装段階が連続",
    "composition": "場面と発話の意味が一致し、余白も自然",
    "camera": "3系統を確認し、不自然な停止なし",
    "bubblePlacement": "表示中の話者顔・重要物への重なりなし",
    "splitPages": "該当なし、または必要性と一体移動を確認",
    "textReadability": "縦組・文節・字形を確認",
    "anatomyAndPropScale": "手指・身体・小道具比率に破綻なし",
    "editContinuity": "場面・視線・因果が連続",
    "imagePacing": "保持時間と切替頻度が自然",
    "dialoguePacing": "問い返しと話者交代の間が自然",
    "audioNaturalness": "読み・抑揚・速度・文末に問題なし",
    "audioBoundaryArtifacts": "頭切れ・click・tail burst・humなし",
    "generatedTextArtifacts": "疑似文字・不要ロゴなし"
  },
  "knownRemainingIssues": []
}
```

問題が1件でもあれば署名せず、`knownRemainingIssues`へ時刻、対象、症状を書く。ユーザー指摘と機械結果が矛盾したらユーザー指摘を不合格根拠にする。
