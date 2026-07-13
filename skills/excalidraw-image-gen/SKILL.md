---
name: excalidraw-image-gen
description: Generate or insert a bitmap into the local BuzzAssist canvas. Use when the user asks to create, fill, replace, or place an AI-generated image on the Excalidraw canvas using GPT Image 2(Codex), Grok Imagine(Grok), or BuzzAssist cloud models (Nano Banana 2, GPT Image 2 API, Seedream 5.0 Lite, Grok Imagine API — require the buzzassist_login plugin tool), or Lovart models (Midjourney, Flux.2 Max, Nano Banana Pro, Ideogram 4 — require LOVART_ACCESS_KEY/SECRET_KEY or ~/.lovart/credentials.json).
---

# Excalidraw Image Gen

Use this skill when the user wants an image placed onto the BuzzAssist canvas.

## Preconditions

The Excalidraw service should be running for the active project. The default
URL is usually:

```text
http://127.0.0.1:43219
```

If that port is busy, read `canvas/.server.json` for the live `url`.

AI holders are rectangle elements with:

```json
{
  "customData": {
    "codexAiImageHolder": true
  }
}
```

## 生成前の確認（必須）

`generate_excalidraw_image` / `generate_excalidraw_images_batch` は `confirmedSettings: true` なしの呼び出しを拒否します（`payloadPreview` を除く）。ユーザーのメッセージで全設定が明示されていない限り、生成前に AskUserQuestion を1回だけ出して確認してください:

- モデル（GPT-Image-2.0 / Grok Imagine / NanoBanana 2 / Seedream v5 Lite / Midjourney …）
- 実行先（同じモデルが複数の実行先を持つ場合。例: GPT Image 2 → Codex / BuzzAssist / Lovart、Grok Imagine → Grok / BuzzAssist）
- アスペクト比（1:1 / 16:9 / 9:16 …）と品質（Auto / Low / Medium / High）
- 推奨デフォルト: GPT-Image-2.0 (Codex)・1:1・Auto — 選択肢には（推奨）を付ける

確認できたら `confirmedSettings: true` を付けて呼び出します。

## Workflow

1. Read the selection with the plugin `get_excalidraw_selection` tool.

2. If exactly one selected element is an AI holder, use its `width` and `height` as the target generation and display size.

3. Prefer `generate_excalidraw_images_batch` for chat-driven generation, even
   for one image. It creates the `Generating...` frame first, focuses the
   viewport without selection handles, and replaces each frame as its result
   arrives. The default layout fills downward: items 1-5 in column 1 and items
   6-10 in column 2.

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
  "columns": 2
}
```

Use `"model": "grok-imagine-image-hermes"` when the user requests Grok Imagine(Grok).

`generate_excalidraw_image` follows the same placeholder behavior and is a
valid convenience tool for a single result.

4. If the user supplies an existing image path, insert it with the plugin `insert_excalidraw_image` tool:

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
- Do not hand-write Excalidraw image records if the plugin tool is available.
- Confirm the returned `elementId`, dimensions, and asset path after insertion.
