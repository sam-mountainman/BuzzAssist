---
name: excalidraw-image-gen
description: Generate or insert a bitmap into the local Codex Excalidraw canvas. Use when the user asks Codex to create, fill, replace, or place an AI-generated image on the Excalidraw canvas using GPT Image 2(Codex) or Grok Imagine(Hermes).
---

# Excalidraw Image Gen

Use this skill when the user wants an image placed onto the Codex Excalidraw canvas.

## Preconditions

The Excalidraw service should be running for the active project, usually at:

```text
http://127.0.0.1:43219
```

AI holders are rectangle elements with:

```json
{
  "customData": {
    "codexAiImageHolder": true
  }
}
```

## Workflow

1. Read the selection:

```bash
curl -s http://127.0.0.1:43219/api/selection
```

Use the MCP `get_excalidraw_selection` tool when available.

2. If exactly one selected element is an AI holder, use its `width` and `height` as the target generation and display size.

3. Prefer the MCP `generate_excalidraw_image` tool when available:

```json
{
  "prompt": "<user prompt>",
  "model": "gpt-image-2-codex",
  "projectDir": "/absolute/path/to/user/codex-project",
  "anchorElementId": "<selected holder or source element id>",
  "aspectRatio": "1:1",
  "placement": "right",
  "margin": 40,
  "matchAnchor": true
}
```

Use `"model": "grok-imagine-image-hermes"` when the user requests Grok Imagine(Hermes).

4. If the user supplies an existing image path, insert it with the MCP `insert_excalidraw_image` tool:

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

5. Do not delete the holder unless the user explicitly asks for replacement. Keeping the holder preserves the intended slot.

## Guardrails

- Do not overwrite existing asset files without an explicit replacement request.
- Do not hand-write Excalidraw image records if the MCP tool is available.
- Confirm the returned `elementId`, dimensions, and asset path after insertion.
