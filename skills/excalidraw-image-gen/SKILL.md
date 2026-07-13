---
name: excalidraw-image-gen
description: Generate or insert a bitmap into the local BuzzAssist canvas. Use when the user asks to create, fill, replace, or place an AI-generated image on the Excalidraw canvas using GPT Image 2(Codex), Grok Imagine(Grok), or BuzzAssist cloud models (Nano Banana 2, GPT Image 2 API, Seedream 5.0 Lite, Grok Imagine API — require the buzzassist_login plugin tool), or Lovart models (Midjourney, Flux.2 Max, Nano Banana Pro, Ideogram 4 — require LOVART_ACCESS_KEY/SECRET_KEY or ~/.lovart/credentials.json).
---

# Excalidraw Image Gen

Use this skill when the user wants an image placed onto the BuzzAssist canvas.

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
- 実行先（同じモデルが複数の実行先を持つ場合だけ。例: GPT Image 2 → Codex / Lovart / BuzzAssist、Nano Banana 2 → Lovart / BuzzAssist、Grok Imagine → Grok / BuzzAssist。LovartはBuzzAssistより上に表示して優先）
- アスペクト比（共通候補は 1:1 / 9:16 / 16:9。その他は自由入力欄でモデル対応値のみ受け付ける）
- モデルが対応する場合だけ、品質・解像度・枚数を確認する。GPT-Image-2.0の実行先がChatGPT（Codex）の場合と、Grok Imagineの実行先がGrokの場合は1〜10枚。各画像は独立生成として最大10件を並列実行する。選択肢が1つしかない項目は聞かない
- 推奨デフォルト: GPT-Image-2.0 (Codex)・1:1・Auto — 選択肢には（推奨）を付ける

確認できたら `confirmedSettings: true` を付けて呼び出します。

### AskUserQuestionの表示ルール

- 通常文で質問せず、ホストの `request_user_input` / `AskUserQuestion` UIを使う
- ユーザーが日本語なら、見出し・質問・選択肢・説明も日本語にする
- 1画面は1〜3問、各問は2〜3択。推奨候補を先頭にし、ラベル末尾へ `（推奨）` を付ける
- `その他` は選択肢へ追加しない。ホストが表示する自由入力欄を使う
- ユーザーがすでに指定した項目は再質問しない。残りが3項目を超える場合は、次の画面で未確認項目だけを聞く
- Midjourneyのバージョン・高精細レンダリングはLovart経由で反映を保証できないため質問しない

### 段階式の質問順

一気に全設定を質問してはいけません。必ず前の回答を受け取ってから次を組み立てます。

1. モデルが未指定なら、最初はモデルだけを質問する
2. モデル確定後、そのモデルに複数の実行先がある場合だけ、実行先を別の質問として出す。モデル名と実行先を1つの選択肢へまとめない
3. モデルと実行先の確定後、その組み合わせが実際に対応する設定だけを質問する
   - 比率
   - 対応時のみ品質・解像度・枚数
4. 1画面で収まらない場合は、回答後に残りの未確認項目だけを次画面で質問する

ユーザーがモデルまたは実行先を変更したら、対応しなくなった後続設定だけを破棄して質問し直し、引き続き有効な回答は保持します。

## Workflow

1. Read the selection with the plugin `get_excalidraw_selection` tool, passing
   the current task's absolute `projectDir`.

2. If exactly one selected element is an AI holder, use its `width` and `height` as the target generation and display size.

3. Prefer `generate_excalidraw_images_batch` for chat-driven generation, even
   for one image. It creates the `Generating...` frame first, focuses the
   viewport without selection handles, and replaces each frame as its result
   arrives. The default layout fills across: items 1-5 in row 1 and items 6-10
   in row 2.

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

Use `"model": "grok-imagine-image-hermes"` when the user requests Grok Imagine(Grok).

GPT-Image-2.0をChatGPT（Codex）で、またはGrok ImagineをGrokで複数枚生成する場合は、回答された枚数ぶん同じ設定の`jobs`を作り、`generate_excalidraw_images_batch`を1回呼びます。1つのjobへ枚数だけを渡してはいけません。先に全`Generating...`フレームを2行×5列（1〜5枚目が1行目、6〜10枚目が2行目）で表示し、最大10件を並列生成するためです。

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

`generate_excalidraw_image` follows the same placeholder behavior and is a
valid convenience tool for one result. On the ChatGPT/Codex and local Grok
routes it also accepts `imageCount: 1..10` and expands that count into the same batch flow.

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
