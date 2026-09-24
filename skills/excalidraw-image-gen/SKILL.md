---
name: excalidraw-image-gen
description: ローカルの BuzzAssist キャンバス（Excalidraw）へ画像（bitmap）を生成・挿入する。「画像を作って」「画像を生成して」「この枠を画像で埋めて」「画像を差し替えて」「キャンバスに画像を置いて」など、AI生成画像を Excalidraw キャンバスへ作る・埋める・置き換える・配置する（create / fill / replace / place an AI-generated image）依頼で使う。対応するのは GPT Image 2(Codex)、Grok Imagine(Grok)、BuzzAssist クラウドモデル（Nano Banana 2、GPT Image 2 API、Seedream 5.0 Lite、Grok Imagine API — plugin の buzzassist_login ツールでのログインが必要）、Lovart モデル（Midjourney、Flux.2 Max、Nano Banana Pro、Ideogram 4 — LOVART_ACCESS_KEY/SECRET_KEY か ~/.lovart/credentials.json が必要）。
---

# Excalidraw 画像生成

ユーザーが BuzzAssist キャンバスへ画像を置きたいときに使う。

## 前提

BuzzAssist のツールを呼ぶ前に、現在（current）の Codex / Claude Code タスクの
ワークスペースルートを特定する。選択・生成・一括生成・挿入のすべての呼び出しで、
その絶対パスを `projectDir` として渡す。plugin cache、BuzzAssist のソースリポジトリ、
インストール時に記憶したプロジェクトで代用しない。現在のプロジェクトのキャンバスが
まだ開いていなければ、先に `open_buzzassist_canvas({ projectDir })` を呼び、返ってきた
`canvasUrl` をホストの in-app browser で開く。

Excalidraw のサービスは、作業中のプロジェクトで動いている必要がある。既定の URL は
たいてい次のとおり。

```text
http://127.0.0.1:43219
```

そのポートが使用中なら、live な `url` を `canvas/.server.json` から読む。

AI ホルダー（生成画像を置く枠）は、次の `customData` を持つ rectangle 要素。

```json
{
  "customData": {
    "codexAiImageHolder": true
  }
}
```

## 生成前の確認（必須）

`generate_excalidraw_image` / `generate_excalidraw_images_batch` は `confirmedSettings: true` なしの呼び出しを拒否する（`payloadPreview` を除く）。ユーザーのメッセージで全設定が明示されていない限り、生成前に AskUserQuestion で確認する（1画面1〜3問。残りがあれば下の「段階式の質問順」に従って次の画面で聞く）。

- モデル（GPT-Image-2.0 / Grok Imagine / NanoBanana 2 / Seedream v5 Lite / Midjourney …）
- 実行先（同じモデルが複数の実行先を持つ場合だけ。例: GPT Image 2 → Codex / Lovart / BuzzAssist、Nano Banana 2 → Lovart / BuzzAssist、Grok Imagine → Grok / BuzzAssist。LovartはBuzzAssistより上に表示して優先）
- アスペクト比（共通候補は 1:1 / 9:16 / 16:9。その他は自由入力欄でモデル対応値のみ受け付ける）
- モデルが対応する場合だけ、品質・解像度・枚数を確認する。GPT-Image-2.0の実行先がChatGPT（Codex）の場合と、Grok Imagineの実行先がGrokの場合は1〜10枚。各画像は独立生成として最大10件を並列実行する。選択肢が1つしかない項目は聞かない
- 推奨デフォルト: GPT-Image-2.0 (Codex)・1:1・Auto — 選択肢には（推奨）を付ける

確認できたら `confirmedSettings: true` を付けて呼び出す。

### AskUserQuestionの表示ルール

- 通常文で質問せず、ホストの `request_user_input` / `AskUserQuestion` UIを使う
- ユーザーが日本語なら、見出し・質問・選択肢・説明も日本語にする
- 1画面は1〜3問、各問は2〜3択。推奨候補を先頭にし、ラベル末尾へ `（推奨）` を付ける
- `その他` は選択肢へ追加しない。ホストが表示する自由入力欄を使う
- ユーザーがすでに指定した項目は再質問しない。残りが3項目を超える場合は、次の画面で未確認項目だけを聞く
- Midjourneyのバージョン・高精細レンダリングはLovart経由で反映を保証できないため質問しない

### 段階式の質問順

一気に全設定を質問してはいけません。必ず前の回答を受け取ってから次を組み立てる。

1. モデルが未指定なら、最初はモデルだけを質問する
2. モデル確定後、そのモデルに複数の実行先がある場合だけ、実行先を別の質問として出す。モデル名と実行先を1つの選択肢へまとめない
3. モデルと実行先の確定後、その組み合わせが実際に対応する設定だけを質問する
   - 比率
   - 対応時のみ品質・解像度・枚数
4. 1画面で収まらない場合は、回答後に残りの未確認項目だけを次画面で質問する

ユーザーがモデルまたは実行先を変更したら、対応しなくなった後続設定だけを破棄して質問し直し、引き続き有効な回答は保持する。

## チャット添付の参照画像

- ユーザーがチャットへ画像を添付し、キャラクター・人物・商品・被写体・画風の参照だと明示した場合、その添付の絶対ローカルパスを必ず `referenceImagePaths` に渡す。会話上で画像を見ただけの状態で生成ツールを呼んではいけない
- 添付の用途が不明な場合だけ、生成前に「被写体／画風の参照」「開始フレーム」「その他」のどれかを確認する
- 一括生成では、全ジョブへ同じ配列を複製せず、`generate_excalidraw_images_batch` のトップレベル `referenceImagePaths` に共通参照を1回指定する。サーバーが全ジョブへ継承し、ジョブ固有の参照があれば重複を除いて追加する
- モデルごとの参照画像上限は各生成経路の制約に従う。上限を超える添付を勝手に捨てず、ユーザーに絞り込みを依頼する

```json
{
  "referenceImagePaths": [
    "/absolute/path/to/attached-character-reference.png"
  ],
  "jobs": [
    { "prompt": "同じキャラクターが朝の街を歩く", "model": "gpt-image-2-codex", "aspectRatio": "16:9" },
    { "prompt": "同じキャラクターがカフェで座る", "model": "gpt-image-2-codex", "aspectRatio": "16:9" }
  ],
  "confirmedSettings": true
}
```

## キャラ台帳（canvas/characters.json）

- プロジェクトには登場キャラクター・小道具・舞台の台帳 `canvas/characters.json` を置ける。各エントリは `{ id, name, kind: "character"|"prop"|"location", role: "fixed"|"per-video", status, episodeId, aliases, description, invariants, negativePrompt, referenceImagePaths, stylePrompt, voiceId, notes }`
- ユーザーが台帳に登録済みのキャラ名を出したら、参照画像を再添付せず `characterIds`（バッチはトップレベル or ジョブ個別）を渡す。サーバーが台帳を引いて設定画を `referenceImagePaths` に自動マージする
- 新キャラの候補や選択待ち状態は `canvas/character-workflows.json` に保存する。ユーザーが採用していない候補を `characters.json` へ登録してはいけない
- 採用後は、候補の三面図・ディテールシートと、その候補を参照して生成した表情・顔角度シートの2枚を `canvas/assets/characters/` へ保存する。`characters.json` の `referenceImagePaths` にはこの2枚を登録する
- 動画単位の主人公（毎回変わるが1本の中では固定）は `role: "per-video"` と `episodeId` を付ける。他動画の同名キャラへ誤って再利用しない。助っ人・サブキャラなどチャンネル共通キャラは `role: "fixed"` にする
- 未知のIDを渡すと登録済みID一覧つきのエラーが返る。勝手に近いIDへ読み替えず、ユーザーに確認するか台帳へ登録してから再実行する

```json
{
  "characterIds": ["sukketo-ojisan"],
  "jobs": [
    { "prompt": "助っ人のおじさんが主人公を励ますシーン", "model": "gpt-image-2-codex", "aspectRatio": "16:9" }
  ],
  "confirmedSettings": true
}
```

### 台本から新キャラを作る標準フロー

台本を受け取ったら、次の順番を崩さない。

1. `analyze_character_script` へ台本を渡す。`名前：セリフ`、`【名前】`、`名前「セリフ」` を抽出し、固定キャラは既存台帳と照合する。エージェントが台本から外見・役割を読める場合は `cast` に `description`、`invariants`、`role` を補足する
2. 画像設定を確認後、`generate_character_candidates` を `confirmedSettings: true` で呼ぶ。新キャラごとに既定3案の軽量候補カード（全身1点＋顔3方向）をキャンバスへ `Generating...` 枠から生成する。候補段階では素材・服・肌・靴の接写を作らない。候補はキャラ名と候補番号で表示される
3. 全候補を見せ、ユーザーの採用を待つ。自動採用は禁止
4. ユーザーが選んだら `approve_character_candidate` を呼ぶ。選択候補を参照した採用三面図と表情・顔角度シートを生成し、その2枚をidentity packとして台帳へ登録する
5. 全キャラがreadyになった後だけ `generate_character_storyboard` を呼ぶ。各シーンの `characters` / `characterIds` を明示する。サーバーが設定画とキャラ別identity lockを自動追加する

複数キャラが同じシーンに出る場合、参照画像の割り当てと「顔・髪・服・年齢を混ぜない」指示が自動付与される。ただし生成モデルのドリフトを完全には保証できないため、完成画像は人物ごとに目視確認する。
3人以上が同じ画像に出る場合は、処理時間と参照過多を抑えるため、各キャラの採用設定画（identity）1枚だけを自動投入する。1〜2人では設定画と表情・角度シートの2枚を維持する。

### チャンネル画風プロファイル

- チャンネル固有の画風・背景・構図・光・カメラ距離は `canvas/channel-visual-profiles.json` に保存する。台本解析時に `visualProfileId` を指定するか、省略時は `defaultProfileId` を使う
- 画風参照は `canvas/assets/style-references/` に置き、人物のidentity packとは分離する。画風参照からは線・塗り・パレット・背景仕上げ・光・構図だけを取り、参照内の顔・髪・服・文字・吹き出しをコピーさせない
- 本編シーンには必要に応じて `styleTags`（`interior` / `exterior` / `day` / `night` / `closeup` / `wide` / `dialogue` / `action`）、`shotType`、`camera`、`lighting`、`bubbleSafeZone` を付ける
- `generate_character_storyboard` はタグに合う画風参照を既定2枚まで自動選択し、その後ろへキャラ台帳のidentity参照を追加する。3人以上のカットはidentityを優先して画風参照を1枚へ減らす
- ベース画像では文字・吹き出しを生成しない。`bubbleSafeZone` に話者の反対側の余白を残し、吹き出しは決定論的な後工程で重ねる

## 手順

1. plugin の `get_excalidraw_selection` ツールで選択中の要素を読む。現在のタスクの
   絶対パスの `projectDir` を渡す。

2. 選択中の要素がちょうど1つで、それが AI ホルダーなら、その `width` と `height` を
   生成サイズと表示サイズの目標にする。

3. チャットからの生成では、1枚だけでも `generate_excalidraw_images_batch` を優先する。
   先に `Generating...` フレームを作り、選択ハンドルを出さずにビューポートをそこへ合わせ、
   結果が届いたフレームから順に置き換えるため。既定の配置は横へ埋めていく形で、
   1〜5件目が1行目、6〜10件目が2行目。

```json
{
  "jobs": [{
    "prompt": "<user prompt>",
    "model": "gpt-image-2-codex",
    "aspectRatio": "1:1"
  }],
  "projectDir": "/absolute/path/to/user/codex-project",
  "anchorElementId": "<selected holder or source element id>",
  "placement": "right",
  "columns": 5
}
```

ユーザーが Grok Imagine(Grok) を指定したら `"model": "grok-imagine-image-hermes"` を使う。

GPT-Image-2.0をChatGPT（Codex）で、またはGrok ImagineをGrokで複数枚生成する場合は、回答された枚数ぶん同じ設定の`jobs`を作り、`generate_excalidraw_images_batch`を1回呼ぶ。1つのjobへ枚数だけを渡さない。先に全`Generating...`フレームを2行×5列（1〜5枚目が1行目、6〜10枚目が2行目）で表示し、最大10件を並列生成するため。

```json
{
  "jobs": [
    { "prompt": "<user prompt>", "model": "gpt-image-2-codex", "aspectRatio": "1:1" },
    { "prompt": "<user prompt>", "model": "gpt-image-2-codex", "aspectRatio": "1:1" }
  ],
  "columns": 5,
  "concurrency": 10,
  "confirmedSettings": true
}
```

`generate_excalidraw_image` も同じプレースホルダー動作をするので、結果が1件だけなら
使ってよい便利ツール。ChatGPT/Codex とローカル Grok の経路では `imageCount: 1..10` も
受け付け、その枚数を同じ一括生成フローへ展開する。

4. ユーザーが既存の画像パスを渡した場合は、plugin の `insert_excalidraw_image` ツールで挿入する。

```json
{
  "imagePath": "/absolute/path/to/generated.png",
  "projectDir": "/absolute/path/to/user/codex-project",
  "anchorElementId": "<selected holder or source element id>",
  "placement": "right",
  "margin": 40,
  "matchAnchor": true,
  "customData": {
    "codexGeneratedImage": true
  }
}
```

5. ユーザーが置き換えを明示しない限り、ホルダーを削除しない。ホルダーを残しておけば、
   意図した置き場所（スロット）が保たれる。

## 守ること

- 明示的な置き換えの依頼がない限り、既存のアセットファイルを上書きしない。
- plugin ツールが使えるなら、Excalidraw の画像レコードを手書きしない。
- 挿入後は、返ってきた `elementId`、寸法、アセットパスを確認する。
