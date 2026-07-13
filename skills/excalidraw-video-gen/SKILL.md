---
name: excalidraw-video-gen
description: Generate or insert a video into the local BuzzAssist canvas. Use when the user asks to create, place, or generate a video on the Excalidraw canvas using Grok Imagine(Grok) or BuzzAssist cloud models (Seedance 2, Seedance 2 Fast, Kling v3, Kling o3, Kling v2.6, Grok Imagine API), or Lovart models (Veo 3.1, Hailuo 2.3, Kling 3.0 Omni, Wan 2.6).
---

# Excalidraw Video Gen

Use this skill when the user wants a generated video represented on the BuzzAssist canvas.

## Preconditions

Resolve the current Codex/Claude Code task's workspace root before calling any
BuzzAssist tool. Pass that absolute path as `projectDir` on every selection,
generation, batch, and insertion call. Never use the plugin cache, BuzzAssist
source repository, or the project remembered at install time as a substitute.
If the current project's canvas is not open yet, call
`open_buzzassist_canvas({ projectDir })` first and open its returned `canvasUrl`
in the host's in-app browser.

The Excalidraw service should be running for the active project. The default
URL is usually:

```text
http://127.0.0.1:43219
```

If that port is busy, read `canvas/.server.json` for the live `url`.

Grok Imagine(Grok) requires the official Grok CLI (grok-cli-tools) and xAI login:

```bash
grok login --timeout 600
```

BuzzAssist cloud models (`seedance-2`, `seedance-2-fast`, `kling-v3`, `kling-o3`, `kling-v2-6`, `grok-imagine-video-api`) require BuzzAssist sign-in: check with the plugin `buzzassist_auth_status` tool and sign in with `buzzassist_login`. They also support `mode` (`standard`/`pro` for Kling), `endFramePath` (keyframe end-frame on Seedance/Kling), `referenceVideoPaths`/`referenceAudioPaths` (Seedance reference mode), and `useMotion` + `motionOrientation` (Kling v2.6 motion control: start frame + 1 reference video).

## 生成前の確認（必須）

`generate_excalidraw_video` / `generate_excalidraw_videos_batch` は `confirmedSettings: true` なしの呼び出しを拒否します（`payloadPreview` を除く）。ユーザーのメッセージで全設定が明示されていない限り、生成前に AskUserQuestion を1回だけ出して確認してください:

- モデル（Grok Imagine / Seedance 2 / Kling v3 / Veo 3.1 …）
- 実行先（同じモデルが複数の実行先を持つ場合だけ。例: Grok Imagine → Grok / BuzzAssist、Kling / Seedance → Lovart / BuzzAssist。LovartはBuzzAssistより上に表示して優先）
- モデル対応のアスペクト比・秒数・解像度・音声・本数。Grok Imagineの実行先がGrokの場合は1〜10本を独立生成する。選択肢が1つしかない項目は聞かない
- 添付画像・動画の用途が曖昧なら、開始フレーム・スタイル/被写体参照・モーション元のどれかを生成前に確認する
- 推奨デフォルト: Grok Imagine (Grok)・16:9・6s・720p — 選択肢には（推奨）を付ける

確認できたら `confirmedSettings: true` を付けて呼び出します。

### AskUserQuestionの表示ルール

- 通常文で質問せず、ホストの `request_user_input` / `AskUserQuestion` UIを使う
- ユーザーが日本語なら、見出し・質問・選択肢・説明も日本語にする
- 1画面は1〜3問、各問は2〜3択。推奨候補を先頭にし、ラベル末尾へ `（推奨）` を付ける
- `その他` は選択肢へ追加しない。カスタム秒数や比率はホストの自由入力欄を使う
- ユーザーがすでに指定した項目は再質問しない。残りが3項目を超える場合は、次の画面で未確認項目だけを聞く
- Grok CLIの秒数は6秒・10秒だけ。Seedance、Kling、Veoなども選択モデルの有効値だけを表示する

### 段階式の質問順

一気に全設定を質問してはいけません。必ず前の回答を受け取ってから次を組み立てます。

1. 添付画像・動画の用途が曖昧なら、開始フレーム・スタイル/被写体参照・モーション元のどれかを最初に質問し、対応モデルを絞る
2. モデルが未指定なら、次にモデルだけを質問する
3. モデル確定後、そのモデルに複数の実行先がある場合だけ、実行先を別の質問として出す。モデル名と実行先を1つの選択肢へまとめない
4. モデルと実行先の確定後、その組み合わせが実際に対応する設定だけを質問する
   - 比率・秒数・解像度・対応時のみ本数
   - 対応時のみ音声・モード・開始/終了フレーム・参照素材
5. 1画面で収まらない場合は、回答後に残りの未確認項目だけを次画面で質問する

ユーザーが添付用途・モデル・実行先を変更したら、対応しなくなった後続設定だけを破棄して質問し直し、引き続き有効な回答は保持します。

## Workflow

1. Read the selection with the plugin `get_excalidraw_selection` tool, passing
   the current task's absolute `projectDir`.

2. Prefer `generate_excalidraw_videos_batch` for chat-driven generation, even
   for one video. It creates and focuses the `Generating...` frame before the
   slow generation starts, without showing selection handles. The default
   layout fills items 1-5 across row 1 and items 6-10 across row 2.

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

Grok ImagineをGrokで複数本生成する場合は、回答された本数ぶん同じ設定の`jobs`を作り、`generate_excalidraw_videos_batch`を1回呼びます。先に全`Generating...`フレームを2行×5列で表示し、各動画を独立ジョブとして最大10件並列生成します。秒数（6秒または10秒）などの設定は全ジョブで共有します。

`generate_excalidraw_video` follows the same placeholder behavior. On the
local Grok route it also accepts `videoCount: 1..10` and expands that count
into the same batch flow.

3. If the user supplies an existing video path, use `insert_excalidraw_video`.

## Notes

Excalidraw does not render native video playback as an image element. This plugin places a linked video card into the scene and stores the generated file under `canvas/assets/`.
