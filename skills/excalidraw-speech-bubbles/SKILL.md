---
name: excalidraw-speech-bubbles
description: Add or revise professional Japanese manga speech bubbles, narration cards, shout balloons, and thought balloons on the current local BuzzAssist/Excalidraw canvas. Use for 吹き出し, セリフ入れ, 漫画テロップ, vertical Japanese dialogue, or the R5 August speech-bubble system.
---

# Excalidraw Speech Bubbles R5（8月版）

参考動画の本編で使われている、白地・細めの黒線・明朝体の縦書き・均等な余白を基準にする。表示物は透明な全画面SVG、編集元は `canvas/speech-bubbles/*.json`。GPT-Image-2は吹き出し本体を毎回描く用途には使わない。

作業前に [references/r5-august-system.md](references/r5-august-system.md) を読む。

## 絶対原則

- 現在のホストタスクのワークスペースルートを絶対パスの `projectDir` として、すべてのBuzzAssistツールへ渡す。
- `render_excalidraw_speech_bubbles` を使う。Excalidrawの楕円・線・1文字改行の組み合わせは公開品質に使わない。
- 通常吹き出しは滑らかな縦長楕円。尻尾なしを既定とし、必要な場面だけ短い尻尾を付ける。
- 強い発話と心の声も、参考動画プロファイルでは通常会話と同じ滑らかな楕円にする。汎用漫画のトゲ型・雲型を混ぜない。
- 尻尾ありは本体と尻尾を1つの閉じたSVGパスにする。顔を刺さない、口へ届かせない。
- 4プリセットだけを使う: `dialogue` / `shout` / `thought` / `narration`。
- 顔検出MLを足さない。台本・カット表から `speakerHint` を流す。
- レンダリングはブラウザSVG。Sharp、fontkitなどのネイティブ依存を追加しない。
- 顔、口、手、重要小道具に安全な空白がなければ、返された `compositionPrompt` で画像を再構図する。
- 台本にないセリフや煽り文句を追加しない。

## 入力の作り方

対象画像を目視し、0〜1座標で `avoidRegions` を作る。

- 顔・口: `face` / `mouth`
- 手: `hand`
- 証拠、商品、武器: `evidence` / `prop`
- 既存文字: `text`

各セリフには本文、強調語、読む順、プリセット、話者ヒントを持たせる。話者ヒントは次を優先する。

```json
{
  "text": "勝手な推測で私を疑うのか！",
  "emphasis": "私を疑う",
  "preset": "dialogue",
  "tail": true,
  "speakerHint": {
    "position": "right",
    "faceBand": "upper",
    "facing": "left",
    "faceBounds": { "x": 0.60, "y": 0.02, "width": 0.18, "height": 0.32 }
  }
}
```

`faceBounds` が分からない場合だけ `position: left|center|right` と `faceBand: upper|middle|lower` を使う。明示座標が必要なら `target` も使える。

## 実行手順

1. 対象画像を選び、`get_excalidraw_selection` でIDを取得する。
2. `profileId: "reference-video-locked-v3"` と `dryRun: true` で実行する。台本の改行はソフト改行として扱い、本文を1〜3列へ自動で組み直す。列を固定する必要がある場合だけ `columns` を使う。
3. `overflow: false`、`tooSmall: false`、`textLoss: false`、3列以下、`placementScore < 500`、顔重なり0.5%以下、重要物重なり10%以下、全体占有26%以下を確認する。
4. 不合格なら `force` せず画像を再構図する。
5. 合格後に `dryRun` を外して透明SVGを重ねる。
6. キャンバスでオーバーレイを選び、右の「吹き出し調整」で種類・尻尾・角度・長さを微調整する。
7. 100%と50%の両方で目視確認する。

## 見た目の基準

- 本編: 明朝体、font-weight 500、画面高4.6%を基準にした縦書き、白地、均一な余白、滑らかな縦長楕円。
- 数字・三点リーダー: 半角数字は全角の直立字形へ変換し、`...` / `…` は縦三点リーダー `︙` に正規化する。
- 強調語: 既定は黒のまま。台本・演出で明示された場合だけ色や太さを変える。
- 叫び: 通常会話と同じ滑らかな楕円。感情は絵・表情・本文で示す。
- 心の声: 通常会話と同じ滑らかな楕円。波形やビーズは付けない。
- ナレーション: 四角い白枠。尻尾なし。
- 位置: 話者と同じ側へ重ねず、原則として反対側の外側余白か人物間の空白を使う。上〜中央を優先し、下端は最後の候補にする。
- サムネイル用の極太ゴシックや派手な装飾は、本編プロファイルへ混ぜない。

## 完了条件

- JSONから同じ透明SVGを再生成できる。
- 入力文字数と描画文字数が一致し、`textLoss: false` である。
- 元画像と顔・手・小道具を壊していない。
- 尻尾は本体と単一パスで、顔の手前で止まる。
- 4プリセットとチャンネルプロファイルが機能する。
- 右パネル調整が保存される。
- 新規プラグインインストールが従来どおり一発で通る。
