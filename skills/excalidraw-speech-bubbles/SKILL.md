---
name: excalidraw-speech-bubbles
description: Add or revise editable Japanese manga speech bubbles, narration strips, reaction bursts, and thought balloons on the current local BuzzAssist/Excalidraw canvas. Use when the user supplies manga artwork or a script and asks for 吹き出し, セリフ入れ, 漫画テロップ, vertical Japanese dialogue, or the R3 speech-bubble template.
---

# Excalidraw Speech Bubbles R3

漫画動画の画像に、後から直せるExcalidraw要素として吹き出しとセリフを配置する。画像へ文字を焼き込まず、吹き出し・尻尾・文字を独立要素のままグループ化する。

作業前に [references/r3-style-system.md](references/r3-style-system.md) を読み、寸法、色、縦書き、配置、品質基準を適用する。

## 前提

- 現在のCodex／Claude Codeタスクのワークスペースルートを解決し、すべてのBuzzAssistツール呼び出しへ絶対パスの `projectDir` を渡す。インストール時のプロジェクトやプラグインキャッシュを使わない。
- 現在のローカルキャンバスが開いていなければ、最初に `open_buzzassist_canvas({ projectDir })` を呼び、返されたURLをホスト内ブラウザで開く。
- 描画前に `read_me` を呼び、現在の `create_view` 要素形式を確認する。
- 対象画像または対象パネルは、原則としてユーザーが選択した要素を使う。`get_excalidraw_selection({ projectDir })` で座標とサイズを取得する。
- 選択がなく、対象を一意に特定できない場合はキャンバス全体へ推測で置かず、対象画像の選択を短く依頼する。

## 必要な入力

最低限、次の2つをそろえる。

1. 対象画像または漫画パネル
2. セリフまたは台本

話者、感情、発話順が台本から明確なら推測してよい。複数の人物がいて話者が曖昧な行だけ、ユーザーへ確認する。色や吹き出し種別は指定がなければR3標準を使う。

## ワークフロー

### 1. 対象を読む

`get_excalidraw_selection` の結果から、対象ごとに `x`, `y`, `width`, `height` を控える。画像内の顔、口、手、重要な小道具、既存文字がある位置も把握する。

複数パネルが1枚の画像に含まれる場合は、白い区切りや構図から各パネルの矩形を先に割り出す。発話者のいない別パネルへ尻尾をまたがせない。

### 2. 台本を配置表へ変換する

各行を次の形に整理する。

| 項目 | 内容 |
| --- | --- |
| scene | 対象パネル番号 |
| order | 読む順番 |
| speaker | 話者ID。ナレーションは `narrator` |
| emotion | neutral / happy / angry / surprise / thought |
| text | 表示する本文 |
| emphasis | 色を変える短い語句。なければ空 |
| target | 尻尾が向く口元または胸元の座標 |

本文を勝手に要約しない。長すぎる場合は、意味の切れ目で吹き出しを2つに分ける。1つに詰め込んで文字を極端に小さくしない。

### 3. R3プリセットを選ぶ

- 通常会話: 白い縦長楕円＋黒縁＋三角の尻尾
- 短い返答: 小さな円または短い楕円。1〜5文字を大きく表示
- 強い驚き・叫び: 白い楕円＋外周の短い放射線。使用は1シーン1つまで
- 心の声: 白い楕円＋小円2〜3個の尻尾。参考動画の通常会話には多用しない
- ナレーション: 尻尾なしの白い縦帯。強調語だけ赤・青・マゼンタ

### 4. 要素を組み立てる

`create_view` が扱う `ellipse`, `rectangle`, `line`, `text` だけで作る。通常会話は次の順で要素配列へ入れる。

1. 尻尾: 白塗りの閉じた `line`。塗りが表示されない環境では細長い白塗り `diamond` で代用
2. 吹き出し本体: `ellipse`
3. 縦書き列: 1列ずつ独立した `text`
4. 必要な場合だけ強調語の別色 `text`

同じ吹き出しの全要素へ同一の `groupIds` を付ける。IDは `r3-<scene>-<speaker>-<role>` とし、`customData` に `buzzassistSpeechBubble: "r3"`, `sceneId`, `speakerId`, `bubbleRole` を付ける。

日本語の縦書きは1文字ごとに改行したテキスト列で再現する。複数列は右から左へ並べ、列ごとに別の `text` 要素を使う。吹き出し内の `label` は使わない。

### 5. 先に検証し、その後で配置する

最初の `create_view` は `dryRun: true` で呼び、要素数、追加範囲、対象パネル外へのはみ出しを確認する。問題がなければ同じ要素を次で保存する。

```json
{
  "projectDir": "/absolute/path/to/current/project",
  "elements": "<JSON array string>",
  "append": true,
  "clearCanvas": false
}
```

`append: true` を必ず使う。`clearCanvas: true` は使わない。既存画像やユーザー作成要素を削除しない。

### 6. 目視で仕上げる

次をすべて満たすまで位置とサイズを調整する。

- 顔、口、手、重要な小道具を隠していない
- 尻尾が発話者の口元または胸元へ向いている
- 尻尾が別の顔や吹き出しを横切っていない
- 発話順が右から左、上から下へ自然に追える
- セリフが安全領域内に収まり、動画端で切れない
- 文字は縮小表示でも読める
- 色を使いすぎず、白地とのコントラストが十分
- 1パネルに原則1〜3個、できれば2個以内

## 既存吹き出しの修正

R3要素は `customData.buzzassistSpeechBubble` とID接頭辞 `r3-` で識別する。修正対象の古い要素IDを `delete` 疑似要素で削除し、同じscene/speakerの新要素を追加する。ユーザー作成の画像やR3以外の要素は削除しない。

## ガードレール

- 吹き出しのために画像生成モデルを呼ばない。編集可能なExcalidraw要素として作る。
- 台本にないセリフ、侮辱表現、煽り文句を追加しない。
- 参考動画のキャラクター、絵、固有のセリフを複製しない。共通する吹き出しの視覚文法だけを使う。
- 差し色は話者識別または感情強調に限定する。装飾目的でランダムに変えない。
- 最後に、配置した吹き出し数、ナレーション数、確認が必要な行だけを簡潔に報告する。
