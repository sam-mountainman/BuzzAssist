---
name: excalidraw-video-gen
description: Generate or insert a video into the local Codex Excalidraw canvas. Use when the user asks to create, place, or generate a video on the Excalidraw canvas using Grok Imagine(Hermes) or BuzzAssist cloud models (Seedance 2, Seedance 2 Fast, Kling v3, Kling o3, Kling v2.6, Grok Imagine API), or Lovart models (Veo 3.1, Hailuo 2.3, Kling 3.0 Omni, Wan 2.6).
---

# Excalidraw Video Gen

Use this skill when the user wants a generated video represented on the Codex Excalidraw canvas.

## Preconditions

The Excalidraw service should be running for the active project, usually at:

```text
http://127.0.0.1:43219
```

Grok Imagine(Hermes) requires Hermes Agent and xAI OAuth:

```bash
hermes auth add xai-oauth --timeout 600
```

BuzzAssist cloud models (`seedance-2`, `seedance-2-fast`, `kling-v3`, `kling-o3`, `kling-v2-6`, `grok-imagine-video-api`) require BuzzAssist sign-in: check with the MCP `buzzassist_auth_status` tool and sign in with `buzzassist_login`. They also support `mode` (`standard`/`pro` for Kling), `endFramePath` (keyframe end-frame on Seedance/Kling), `referenceVideoPaths`/`referenceAudioPaths` (Seedance reference mode), and `useMotion` + `motionOrientation` (Kling v2.6 motion control: start frame + 1 reference video).

## 生成前の確認（必須）

`generate_excalidraw_video` / `generate_excalidraw_videos_batch` は `confirmedSettings: true` なしの呼び出しを拒否します（`payloadPreview` を除く）。ユーザーのメッセージで全設定が明示されていない限り、生成前に AskUserQuestion を1回だけ出して確認してください:

- モデル（Grok Imagine / Seedance 2 / Kling v3 / Veo 3.1 …）
- 実行先（同じモデルが複数の実行先を持つ場合。例: Grok Imagine → Hermes / BuzzAssist、Kling → BuzzAssist / Lovart）
- アスペクト比（16:9 / 9:16 / 1:1）・秒数（5s / 10s …）・解像度（480p / 720p）
- 推奨デフォルト: Grok Imagine (Hermes)・16:9・5s・720p — 選択肢には（推奨）を付ける

確認できたら `confirmedSettings: true` を付けて呼び出します。

## Workflow

1. Read the selection:

```bash
curl -s http://127.0.0.1:43219/api/selection
```

Use the MCP `get_excalidraw_selection` tool when available.

2. Generate and place the video with `generate_excalidraw_video`:

```json
{
  "prompt": "<user prompt>",
  "model": "grok-imagine-video-hermes",
  "projectDir": "/absolute/path/to/user/codex-project",
  "anchorElementId": "<selected holder or source element id>",
  "aspectRatio": "16:9",
  "duration": "5",
  "resolution": "720p",
  "placement": "right",
  "margin": 40,
  "matchAnchor": true
}
```

3. If the user supplies an existing video path, use `insert_excalidraw_video`.

## Notes

Excalidraw does not render native video playback as an image element. This plugin places a linked video card into the scene and stores the generated file under `canvas/assets/`.
