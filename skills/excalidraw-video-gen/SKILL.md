---
name: excalidraw-video-gen
description: ローカルの BuzzAssist キャンバス（Excalidraw）へ動画を生成・挿入する。「動画を作って」「動画を生成して」「この画像を動画にして」「キャンバスに動画を置いて」など、Excalidraw キャンバス上で動画を作る・置く・生成する（create / place / generate a video）依頼で使う。対応するのは Grok Imagine(Grok)、BuzzAssist クラウドモデル（Seedance 2、Seedance 2 Fast、Kling v3、Kling o3、Kling v2.6、Grok Imagine API）、Lovart モデル（Veo 3.1、Hailuo 2.3、Kling 3.0 Omni、Wan 2.6）。
---

# Excalidraw 動画生成

ユーザーが生成した動画を BuzzAssist キャンバス上に置きたいときに使う。

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

Grok Imagine(Grok) には、公式の Grok CLI（grok-cli-tools）と xAI へのログインが必要。

```bash
grok login --timeout 600
```

BuzzAssist クラウドモデル（`seedance-2`、`seedance-2-fast`、`kling-v3`、`kling-o3`、`kling-v2-6`、`grok-imagine-video-api`）には BuzzAssist へのサインインが必要。plugin の `buzzassist_auth_status` ツールで状態を確かめ、`buzzassist_login` でサインインする。これらのモデルは次の引数にも対応する。`mode`（Kling の `standard`/`pro`）、`endFramePath`（Seedance/Kling のキーフレームの終了フレーム）、`referenceVideoPaths`/`referenceAudioPaths`（Seedance の参照モード）、`useMotion` + `motionOrientation`（Kling v2.6 のモーションコントロール。開始フレーム＋参照動画1本）。

## 生成前の確認（必須）

`generate_excalidraw_video` / `generate_excalidraw_videos_batch` は `confirmedSettings: true` なしの呼び出しを拒否する（`payloadPreview` を除く）。ユーザーのメッセージで全設定が明示されていない限り、生成前に AskUserQuestion で確認する（1画面1〜3問。残りがあれば下の「段階式の質問順」に従って次の画面で聞く）。

- モデル（Grok Imagine / Seedance 2 / Kling v3 / Veo 3.1 …）
- 実行先（同じモデルが複数の実行先を持つ場合だけ。例: Grok Imagine → Grok / BuzzAssist、Kling / Seedance → Lovart / BuzzAssist。LovartはBuzzAssistより上に表示して優先）
- モデル対応のアスペクト比・秒数・解像度・音声・本数。Grok Imagineの実行先がGrokの場合は1〜10本を独立生成する。選択肢が1つしかない項目は聞かない
- 添付画像・動画の用途が曖昧なら、開始フレーム・スタイル/被写体参照・モーション元のどれかを生成前に確認する
- 推奨デフォルト: Grok Imagine (Grok)・16:9・6s・720p — 選択肢には（推奨）を付ける

確認できたら `confirmedSettings: true` を付けて呼び出す。

### AskUserQuestionの表示ルール

- 通常文で質問せず、ホストの `request_user_input` / `AskUserQuestion` UIを使う
- ユーザーが日本語なら、見出し・質問・選択肢・説明も日本語にする
- 1画面は1〜3問、各問は2〜3択。推奨候補を先頭にし、ラベル末尾へ `（推奨）` を付ける
- `その他` は選択肢へ追加しない。カスタム秒数や比率はホストの自由入力欄を使う
- ユーザーがすでに指定した項目は再質問しない。残りが3項目を超える場合は、次の画面で未確認項目だけを聞く
- Grok CLIの秒数は6秒・10秒だけ。Seedance、Kling、Veoなども選択モデルの有効値だけを表示する

### 段階式の質問順

一気に全設定を質問してはいけません。必ず前の回答を受け取ってから次を組み立てる。

1. 添付画像・動画の用途が曖昧なら、開始フレーム・スタイル/被写体参照・モーション元のどれかを最初に質問し、対応モデルを絞る
2. モデルが未指定なら、次にモデルだけを質問する
3. モデル確定後、そのモデルに複数の実行先がある場合だけ、実行先を別の質問として出す。モデル名と実行先を1つの選択肢へまとめない
4. モデルと実行先の確定後、その組み合わせが実際に対応する設定だけを質問する
   - 比率・秒数・解像度・対応時のみ本数
   - 対応時のみ音声・モード・開始/終了フレーム・参照素材
5. 1画面で収まらない場合は、回答後に残りの未確認項目だけを次画面で質問する

ユーザーが添付用途・モデル・実行先を変更したら、対応しなくなった後続設定だけを破棄して質問し直し、引き続き有効な回答は保持する。

## 手順

1. plugin の `get_excalidraw_selection` ツールで選択中の要素を読む。現在のタスクの
   絶対パスの `projectDir` を渡す。

2. チャットからの生成では、1本だけでも `generate_excalidraw_videos_batch` を優先する。
   時間のかかる生成が始まる前に `Generating...` フレームを作ってそこへフォーカスし、
   選択ハンドルは出さないため。既定の配置では、1〜5件目を1行目、6〜10件目を2行目へ
   横に並べる。

```json
{
  "jobs": [{
    "prompt": "<user prompt>",
    "model": "grok-imagine-video-hermes",
    "aspectRatio": "16:9",
    "duration": "6",
    "resolution": "720p"
  }],
  "projectDir": "/absolute/path/to/user/codex-project",
  "anchorElementId": "<selected holder or source element id>",
  "placement": "right",
  "columns": 5
}
```

Grok ImagineをGrokで複数本生成する場合は、回答された本数ぶん同じ設定の`jobs`を作り、`generate_excalidraw_videos_batch`を1回呼ぶ。先に全`Generating...`フレームを2行×5列で表示し、各動画を独立ジョブとして最大10件並列生成する。秒数（6秒または10秒）などの設定は全ジョブで共有する。

`generate_excalidraw_video` も同じプレースホルダー動作をする。ローカル Grok の経路では
`videoCount: 1..10` も受け付け、その本数を同じ一括生成フローへ展開する。

3. ユーザーが既存の動画パスを渡した場合は `insert_excalidraw_video` を使う。

## 補足

Excalidraw は image 要素としてネイティブの動画再生を描画しない。そのためこの plugin は、
リンク付きの動画カードをシーンに置き、生成したファイルを `canvas/assets/` に保存する。
