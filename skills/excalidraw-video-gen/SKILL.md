---
name: excalidraw-video-gen
description: Generate or insert a video into the local BuzzAssist canvas. Use when the user asks to create, place, or generate a video on the Excalidraw canvas using Grok Imagine(Grok) or BuzzAssist cloud models (Seedance 2, Seedance 2 Fast, Kling v3, Kling o3, Kling v2.6, Grok Imagine API), or Lovart models (Veo 3.1, Hailuo 2.3, Kling 3.0 Omni, Wan 2.6).
---

# Excalidraw Video Gen

Use this skill when the user wants a generated video represented on the BuzzAssist canvas.

## Preconditions

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
- モデル対応のアスペクト比・秒数・解像度・音声。選択肢が1つしかない項目は聞かない
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

## Workflow

1. Read the selection with the plugin `get_excalidraw_selection` tool.

2. Prefer `generate_excalidraw_videos_batch` for chat-driven generation, even
   for one video. It creates and focuses the `Generating...` frame before the
   slow generation starts, without showing selection handles. The default
   layout fills items 1-5 down column 1 and items 6-10 down column 2.

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
  "columns": 2
}
```

`generate_excalidraw_video` follows the same placeholder behavior and is a
valid convenience tool for one result.

3. If the user supplies an existing video path, use `insert_excalidraw_video`.

## Notes

Excalidraw does not render native video playback as an image element. This plugin places a linked video card into the scene and stores the generated file under `canvas/assets/`.
