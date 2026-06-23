---
name: excalidraw-video-gen
description: Generate or insert a video into the local Codex Excalidraw canvas. Use when the user asks Codex to create, place, or generate a video on the Excalidraw canvas using Grok Imagine(Hermes).
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
