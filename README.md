# Codex Excalidraw

Codex Excalidraw is a local Excalidraw canvas for Codex and Claude Code, modeled after Cowart's architecture:

- official Excalidraw MCP App access through `https://mcp.excalidraw.com/mcp`
- a local Vite/React canvas service
- project-local canvas persistence under `canvas/`
- MCP tools for Codex to read selection state, insert assets, and generate images/videos
- Codex skills for opening the canvas and placing generated media

## Run The Canvas

```bash
./scripts/start-canvas.sh /path/to/user/project
```

Default URL:

```text
http://127.0.0.1:43219/
```

Project-local data:

```text
canvas/excalidraw-canvas.json
canvas/excalidraw-selection.json
canvas/excalidraw-view-state.json
canvas/assets/
```

## MCP Tools

This plugin includes two Excalidraw MCP entries:

- `excalidraw_official`: the official open-source Excalidraw MCP App hosted by Excalidraw, useful for prompt-to-diagram generation and MCP App rendering
- `excalidraw_mcp`: this repository's local project-bound HTTP MCP endpoint, served by the same browser canvas process at `http://127.0.0.1:43219/mcp`
- `excalidraw_mcp_stdio`: fallback stdio MCP server for clients that cannot connect to the local browser canvas HTTP endpoint

The official remote MCP is configured in `.mcp.json` as:

```json
{
  "type": "http",
  "url": "https://mcp.excalidraw.com/mcp"
}
```

The local browser canvas MCP is configured in `.mcp.json` as:

```json
{
  "type": "http",
  "url": "http://127.0.0.1:43219/mcp"
}
```

Start the canvas first:

```bash
./scripts/start-canvas.sh /path/to/user/project
```

Then MCP clients can connect to `http://127.0.0.1:43219/mcp`. Tool calls update the same canvas shown at `http://127.0.0.1:43219/` and the browser refreshes through the existing canvas event stream.

For clients that need stdio instead of HTTP:

```bash
./scripts/start-mcp.sh
```

Local tools include both official-compatible diagram tools and media tools:

- `read_me`: returns the official-compatible Excalidraw element format used by `create_view`
- `create_view`: accepts a JSON array string of Excalidraw-like elements and writes the diagram into the live local browser canvas
- `get_excalidraw_selection`: reads selected elements from `canvas/excalidraw-selection.json`
- `insert_excalidraw_image`: copies a local bitmap into `canvas/assets/`, adds an Excalidraw image file and element, and saves the scene
- `insert_excalidraw_video`: copies a local video into `canvas/assets/`, adds a Youtube-AGI-style video media element, and saves the scene
- `generate_excalidraw_image`: generates with `gpt-image-2-codex` or `grok-imagine-image-hermes`, inserts the result, and saves the scene
- `generate_excalidraw_video`: generates with `grok-imagine-video-hermes`, inserts a Youtube-AGI-style video media element, and saves the scene
- `generate_excalidraw_images_batch`: creates image generator frames first, then fills each frame with generated results as they finish
- `generate_excalidraw_videos_batch`: creates video generator frames first, then fills each frame with generated video media as results finish
- `generate_excalidraw_subtitles`: generates Japanese SRT subtitles from an audio file via BuzzAssist cloud (ElevenLabs forced alignment / Scribe v2), saves the SRT under `canvas/assets/`, and places an SRT card on the canvas
- `silence_cut_excalidraw_video`: removes silences from a local video with ffmpeg (jet cut) and inserts the cut video with cut statistics
- `buzzassist_login`: browser sign-in to BuzzAssist for cloud models and cloud subtitles (token saved to `~/.buzzassist/excalidraw-media-auth.json`)
- `buzzassist_auth_status`: reports the current BuzzAssist sign-in state

## Batch Generation

Generate many images or videos in one call. The MCP batch tools first place Youtube-AGI-style generator frames as a grid below existing canvas content, focus the viewport on that created grid, then run jobs with bounded concurrency and replace each frame as its media result finishes.

MCP tools:

- `generate_excalidraw_images_batch`: `{ jobs: [{ prompt, model?, aspectRatio?, imageSize?, quality?, referenceImagePaths?, fileName? }], columns?=4, gap?=24, concurrency?=3, focusCreated?=true, projectDir?, canvasDir?, dryRun? }`
- `generate_excalidraw_videos_batch`: `{ jobs: [{ prompt, model?, aspectRatio?, duration?, resolution?, generateAudio?, referenceImagePaths?, fileName? }], columns?=3, gap?=24, concurrency?=1, focusCreated?=true, projectDir?, canvasDir?, dryRun? }`

Both return `{ ok, total, succeeded, failed, results: [{ prompt, elementId, fileId, bounds, error? }] }`.

HTTP endpoints (same backend, served by the canvas process):

```text
POST /api/generate/images/batch   { jobs, columns, gap, concurrency }
POST /api/generate/videos/batch   { jobs, columns, gap, concurrency }
```

Each endpoint runs the batch, saves the scene once, broadcasts a single live-canvas update, and responds with the per-job results array.

## Codex Agent Clarifications

When a Codex agent uses the Excalidraw MCP media tools, the MCP server instructions tell it to ask before generating if required media settings are missing instead of silently guessing defaults. Use the host AskUserQuestion/request_user_input flow for those questions.

- Image generation should confirm missing model, aspect ratio, and quality. Recommended defaults: `GPT-Image-2.0(Codex)`, `1:1`, `Auto`.
- Video generation should confirm missing model, aspect ratio, duration, and resolution. Recommended defaults: `Grok Imagine(Hermes)`, `16:9`, `5s`, `720p`.
- If attached or selected media can be routed more than one way, ask before generation. For video, distinguish start frame/image-to-video from style reference.

## Media Generation Providers

The canvas UI and MCP tools use the same generation backend. Supported model IDs are aligned with the Youtube-AGI (BuzzAssist) Excalidraw bridge.

Local models (no BuzzAssist account needed):

```text
gpt-image-2-codex
grok-imagine-image-hermes
grok-imagine-video-hermes
```

BuzzAssist cloud models (billed through the BuzzAssist fal proxy; sign in first):

```text
nano-banana-2            gpt-image-2              seedream-v5-lite
grok-imagine-image-api   seedance-2               seedance-2-fast
kling-v3                 kling-o3                 kling-v2-6
grok-imagine-video-api
```

## BuzzAssist Sign-In

Cloud models, cloud subtitles, and their credits use your BuzzAssist account:

- MCP: run the `buzzassist_login` tool (opens the browser, loopback callback), check with `buzzassist_auth_status`
- HTTP: `GET/POST http://127.0.0.1:43219/api/buzzassist/login`, status at `/api/buzzassist/auth-status`
- CI/headless: set `BUZZASSIST_MEDIA_TOKEN` with a desktop auth token

Tokens are desktop-app auth tokens (30-day TTL) stored at `~/.buzzassist/excalidraw-media-auth.json`. Credits are reserved and refunded server-side by the BuzzAssist proxy; failed generations refund automatically.

## Silence Cut / Subtitles

- `silence_cut_excalidraw_video` runs the BuzzAssist tempo-cut pipeline (ffmpeg-local mode) ported to `lib/tempoCut.mjs`: silencedetect with adaptive threshold fallback, margin/keep cutlist math, and a filter_complex jet-cut render. Requires `ffmpeg`/`ffprobe`.
- `generate_excalidraw_subtitles` reserves subtitle credits, calls the BuzzAssist subtitle API (ElevenLabs forced alignment for scripted mode, Scribe v2 for scriptless), then builds SRT cues locally with the ported Japanese-aware segmentation (`lib/subtitleGeneration.mjs`).

## Claude Code

The same repo works as-is in Claude Code: `.mcp.json` registers the MCP servers, and the skills are mirrored under `.claude/skills/`. Start the canvas with `./scripts/start-canvas.sh`, then use the same MCP tools from Claude Code sessions.

`grok-imagine-image-hermes` and `grok-imagine-video-hermes` use the local Hermes Agent xAI OAuth flow:

```bash
hermes auth add xai-oauth --timeout 600
```

Optional environment variables:

```text
HERMES_PATH=/absolute/path/to/hermes
HERMES_HOME=/absolute/path/to/.hermes
HERMES_PROJECT_PATH=/absolute/path/to/hermes-agent
```

`gpt-image-2-codex` is a Codex bridge model, not a plain HTTP OpenAI API model in this standalone service. By default the canvas uses the bundled Codex app-server bridge at `scripts/codex-image-bridge.mjs`, which requires a working `codex` CLI login and the Codex `$imagegen` skill/tool path. You can still override it with one of these hooks:

```text
EXCALIDRAW_GPT_IMAGE_2_CODEX_COMMAND="node /path/to/codex-image-bridge.mjs"
EXCALIDRAW_GPT_IMAGE_2_CODEX_URL="http://127.0.0.1:PORT/generate-image"
```

The bridge receives JSON on stdin or via POST and should return one of:

```json
{ "mimeType": "image/png", "base64": "..." }
{ "image": "data:image/png;base64,..." }
{ "url": "https://..." }
{ "path": "/absolute/path/to/image.png" }
```

Hermes override hooks are also available for custom provider shims:

```text
EXCALIDRAW_GROK_IMAGE_HERMES_COMMAND="node /path/to/grok-image-bridge.mjs"
EXCALIDRAW_GROK_VIDEO_HERMES_COMMAND="node /path/to/grok-video-bridge.mjs"
```

## Codex Plugin Shape

The plugin metadata is in:

```text
.codex-plugin/plugin.json
.mcp.json
skills/
```

The local service intentionally does not store user canvas data inside the plugin repository. Pass the active project directory to `start-canvas.sh`, the same way Cowart separates plugin code from project-local canvas state.

## Development

```bash
npm install
npm run build
```

The Excalidraw package pulls in large optional diagram/font chunks, so production build can take around 40-50 seconds on first runs.
