# BuzzAssist

BuzzAssist is a local Excalidraw canvas and media plugin for Codex, Claude Code, Cursor, and Antigravity, modeled after Cowart's architecture:

- official Excalidraw MCP App access through `https://mcp.excalidraw.com/mcp`
- a local static React canvas service
- project-local canvas persistence under `canvas/`
- plugin-provided tools for supported agents to read selection state, insert assets, and generate images/videos
- host manifests and MCP config templates with shared skills

## Agent URL Setup

Paste this GitHub URL into Codex, Claude Code, Cursor, or Antigravity and ask "セットアップして".
That URL plus that instruction is the intended setup contract; no manual
plugin IDs are needed. The agent should clone/open the repo and run the setup for itself only:

```text
https://github.com/taiyuhiga/BuzzAssist
```

```bash
node scripts/setup-agents.mjs --agent codex --project-dir /path/to/active/project
node scripts/setup-agents.mjs --agent claude --project-dir /path/to/active/project
node scripts/setup-agents.mjs --agent cursor --project-dir /path/to/active/project
node scripts/setup-agents.mjs --agent antigravity --project-dir /path/to/active/project
```

Add `--tunnel` when phone access should be ready immediately. Pass
`--ngrok-authtoken <token>` on first setup, or set `BUZZASSIST_NGROK_AUTHTOKEN`.

The setup script installs dependencies when needed, builds the canvas UI when
needed, refreshes a lightweight local marketplace at `~/plugins/buzzassist`
with the plugin root at `~/plugins/buzzassist/plugin`, configures only the
requested host, starts the local canvas server, and prints:

```text
BUZZASSIST_CANVAS_URL=http://127.0.0.1:<port>/
BUZZASSIST_CANVAS_CHECK=ok
```

With `--tunnel`, it also starts ngrok and prints:

```text
BUZZASSIST_TUNNEL_URL=https://<slug>.ngrok-free.dev
BUZZASSIST_TUNNEL_ACCESS_URL=https://<slug>.ngrok-free.dev/?t=<generated>
BUZZASSIST_TUNNEL_CHECK=ok
```

After that, the current host agent should open `BUZZASSIST_CANVAS_URL` in its
in-app browser. Use `BUZZASSIST_TUNNEL_ACCESS_URL` from a phone or other
device. If browser control is unavailable, use the URL from
`canvas/.server.json`; setup is considered complete when
`BUZZASSIST_CANVAS_CHECK=ok` is printed.

The script intentionally leaves other agents untouched. Use `--all-agents` only
when the user explicitly asks to configure every supported host.

## Run The Canvas

```bash
# macOS / Linux
./scripts/start-canvas.sh /path/to/user/project

# any OS (Windows included)
node scripts/start-canvas.mjs /path/to/user/project

# after packaging / install
npx buzzassist-canvas-mcp
npx buzzassist-canvas /path/to/user/project
```

Default URL, when available:

```text
http://127.0.0.1:43219/
```

If that port is already busy, the canvas server selects the next available
local port and writes the live URL, HTTP MCP URL, and bearer token to:

```text
canvas/.server.json
```

Project-local data:

```text
canvas/excalidraw-canvas.json
canvas/excalidraw-selection.json
canvas/excalidraw-view-state.json
canvas/assets/
```

## Mobile Full Canvas Tunnel

For phone/mobile access, BuzzAssist uses **Canvas Tunnel**: an ngrok URL that
opens the same full local Excalidraw/BuzzAssist UI as the desktop canvas. This
is the supported path when the user wants the left generator rail, canvas
frames, prompt editing, selection behavior, and generated assets to behave like
the local browser canvas.

Each user uses their own ngrok account/authtoken. The plugin can configure it
during setup:

```bash
node scripts/setup-agents.mjs --agent codex --project-dir /path/to/active/project --tunnel --ngrok-authtoken <token>
```

Or start/inspect/stop the tunnel later:

```bash
npm run tunnel:start
npm run tunnel:status
npm run tunnel:stop
```

The tunnel command prints the ngrok URL and an Access URL with a generated
token. Open the Access URL on the phone; it sets a same-site cookie and then
loads the same full canvas UI. Avoid editing heavily from desktop and phone at
the same time.

The tunnel is locked down to that one session: CORS is pinned to the exact ngrok
URL (no `*.ngrok*` wildcard), and host-only endpoints — desktop chat keystroke
injection (`/api/chat/send`), the OAuth login browser flow, and outbound probes —
reject any request that arrives from the tunnel origin, so they stay usable only
from the local browser. The tunnel also requires the generated access token for
non-local hosts. `npm run tunnel:stop` stops the tunnel-managed canvas server it
started, not just ngrok. If you explicitly want browser-native Basic Auth too,
start with `npm run tunnel:start -- --basic-auth`.

The MCP plugin also exposes:

```text
buzzassist_canvas_tunnel_start
buzzassist_canvas_tunnel_status
buzzassist_canvas_tunnel_stop
```

## Cloud Remote Canvas

The older BuzzAssist Cloud Relay commands still exist for hosted relay
experiments, but they are not the same full Excalidraw UI. Use Canvas Tunnel
when the requested behavior is "exactly like the local canvas."

```bash
npm run serve -- \
  --remote-canvas-url https://buzzassist.ai \
  --remote-canvas-session rc_xxx \
  --remote-canvas-token <desktopToken>
```

See [docs/remote-canvas-relay-architecture.md](docs/remote-canvas-relay-architecture.md).

## Plugin Tools

This plugin installs the user-facing BuzzAssist plugin and includes two MCP-backed Excalidraw entries internally:

- `excalidraw_official`: the official open-source Excalidraw MCP App hosted by Excalidraw, useful for prompt-to-diagram generation and MCP App rendering
- `excalidraw_mcp`: this repository's local project-bound stdio MCP server. It auto-starts the browser canvas when needed.

The local plugin tool server runs on `@modelcontextprotocol/sdk`, so initialization,
tool listing/calling, protocol negotiation, and `notifications/progress` are
handled by the SDK rather than a hand-written JSON-RPC loop.

The official remote MCP is configured in `.mcp.json` as:

```json
{
  "type": "http",
  "url": "https://mcp.excalidraw.com/mcp"
}
```

The local MCP is configured in `.mcp.json` as:

```json
{
  "command": "node",
  "args": ["./mcp/server.mjs"],
  "cwd": "."
}
```

The local tool server starts the canvas automatically for canvas-writing tools. To open
the canvas manually:

```bash
./scripts/start-canvas.sh /path/to/user/project
```

The local HTTP MCP endpoint is still served by the browser canvas process at
`/mcp`, but it is token-protected. Read `canvas/.server.json` for the current
`mcpUrl` and bearer `token`.

For plugin hosts or clients that need a direct stdio command:

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
- `silence_cut_excalidraw_video`: removes silences from a Premiere XML or local video and writes a downloadable non-destructive Premiere XML under `canvas/assets/` (no rendered video/result card)
- `buzzassist_login`: browser sign-in to BuzzAssist for cloud models and cloud subtitles (token saved to `~/.buzzassist/excalidraw-media-auth.json`)
- `buzzassist_auth_status`: reports the current BuzzAssist sign-in state (warns when the token expires within 3 days)

Generation extras:

- `generate_excalidraw_image` / `generate_excalidraw_video` accept `payloadPreview: true` to return the resolved fal endpoint, request payload, and estimated BuzzAssist credits without generating (`lib/mediaCredits.mjs` ports the BuzzAssist rate card)
- `generate_excalidraw_subtitles` supports a two-step LLM segmentation flow: call with `returnWordsOnly: true` to get timed words, let the agent decide semantic line breaks, then call again with `subtitleLines` to render and place the SRT without a second cloud call
- 429 responses retry automatically with backoff; payload builders are covered by `node scripts/test-fal-payloads.mjs`

## Plugin Packaging

Codex uses `.codex-plugin/plugin.json`; Claude Code uses
`.claude-plugin/plugin.json`; Cursor uses `.cursor/mcp.json` plus
`.cursor/rules/buzzassist.mdc`; Antigravity uses
`.antigravity-plugin/plugin.json`, `.agents/mcp_config.json`, and `GEMINI.md`.
All hosts point at the shared `skills/` folder and local MCP server.

For Codex local testing, `.agents/plugins/marketplace.json` exposes this repo
as `buzzassist`. For Cursor and Antigravity, the setup script writes project-local
config files because those hosts discover MCP servers from workspace config.
For npm packaging, `package.json` provides:

```bash
npx buzzassist-canvas-mcp   # stdio MCP server
npx buzzassist-canvas       # local canvas web server
```

Run the verification suite before packaging:

```bash
npm test
npm run build
npm pack --dry-run
```

## Batch Generation

Generate many images or videos in one call. The plugin batch tools first place Youtube-AGI-style generator frames as 10-item chunks below existing canvas content, keep the user's current canvas view in place by default, then run each chunk with bounded concurrency and replace each frame as its media result finishes. For example, 18 jobs run as 10 items in a 2x5 grid, then 8 items in the next grid.

Plugin tools:

- `generate_excalidraw_images_batch`: `{ jobs: [{ prompt, model?, aspectRatio?, imageSize?, quality?, referenceImagePaths?, fileName? }], columns?=5, gap?=24, concurrency?=10, focusCreated?=false, projectDir?, canvasDir?, dryRun? }`
- `generate_excalidraw_videos_batch`: `{ jobs: [{ prompt, model?, aspectRatio?, duration?, resolution?, generateAudio?, referenceImagePaths?, fileName? }], columns?=5, gap?=24, concurrency?=10, focusCreated?=false, projectDir?, canvasDir?, dryRun? }`

Both return `{ ok, total, succeeded, failed, results: [{ prompt, elementId, fileId, bounds, error? }] }`.

HTTP endpoints (same backend, served by the canvas process):

```text
POST /api/generate/images/batch   { jobs, columns, gap, concurrency }
POST /api/generate/videos/batch   { jobs, columns, gap, concurrency }
```

Each endpoint runs the batch in 10-item chunks, saves and broadcasts after each inserted chunk, and responds with the per-job results array.

## Agent Clarifications

When an agent uses the BuzzAssist plugin media tools, the tool instructions tell it to ask before generating if required media settings are missing instead of silently guessing defaults. Use the host AskUserQuestion/request_user_input flow for those questions.

The server also enforces this gate. Generation, subtitle, and paid silence-cut
tools reject calls without `confirmedSettings: true`, except for payload
previews and offline ffmpeg-local dry runs.

- Image generation should confirm missing model, aspect ratio, and quality. Recommended defaults: `GPT-Image-2.0(Codex)`, `1:1`, `Auto`.
- Video generation should confirm missing model, aspect ratio, duration, and resolution. Recommended defaults: `Grok Imagine(Hermes)`, `16:9`, `5s`, `720p`.
- If attached or selected media can be routed more than one way, ask before generation. For video, distinguish start frame/image-to-video from style reference.

## Media Generation Providers

The canvas UI and plugin tools use the same generation backend. Supported model IDs are aligned with the Youtube-AGI (BuzzAssist) Excalidraw bridge.

In the canvas UI, models appear once by canonical name (`lib/modelCatalog.mjs`) and the execution route — Codex / Hermes / BuzzAssist / Lovart — is picked per model from the 実行先 pill in the panel's settings row. The ⚡ generate button shows the pre-generation credit estimate for the selected route (0 for local routes, — for Lovart whose rates are external). The concrete backend model IDs below are what frames store and what plugin tools accept.

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

## Lovart Models

Lovart's Agent OpenAPI (issued from Lovart's OpenClaw settings) adds models the fal proxy does not have:

```text
images: lovart-midjourney  lovart-flux-2-max  lovart-nano-banana-pro  lovart-ideogram-v4  lovart-agent
videos: lovart-veo-3-1  lovart-veo-3-1-fast  lovart-hailuo-2-3  lovart-kling-3-omni  lovart-wan-2-6
```

Auth: set `LOVART_ACCESS_KEY` / `LOVART_SECRET_KEY`, or put `access_key` / `secret_key` in `~/.lovart/credentials.json` (0600). Requests are HMAC-SHA256 signed against `https://lgw.lovart.ai/v1/openapi` (`lib/lovartMediaGeneration.mjs`). Generation is prompt-driven (aspect ratio / duration are hints); results are billed in Lovart credits, generated inside a dedicated "BuzzAssist Excalidraw" Lovart project, and downloaded onto the canvas. High-cost confirmations are auto-approved by default (`autoConfirmCredits: false` to require explicit approval).

## BuzzAssist Sign-In

Cloud models, cloud subtitles, and their credits use your BuzzAssist account:

- Plugin: run the `buzzassist_login` tool (opens the browser, loopback callback), check with `buzzassist_auth_status`
- HTTP: `GET/POST <canvas-url>/api/buzzassist/login`, status at `/api/buzzassist/auth-status`
- CI/headless: set `BUZZASSIST_MEDIA_TOKEN` with a desktop auth token

Tokens are desktop-app auth tokens (30-day TTL) stored at `~/.buzzassist/excalidraw-media-auth.json`. Credits are reserved and refunded server-side by the BuzzAssist proxy; failed generations refund automatically.

## Silence Cut / Subtitles

- `silence_cut_excalidraw_video` runs the BuzzAssist tempo-cut pipeline (ffmpeg-local mode) ported to `lib/tempoCut.mjs`: silencedetect with adaptive threshold fallback, margin/keep cutlist math, and a filter_complex jet-cut render. Requires `ffmpeg`/`ffprobe`.
- `generate_excalidraw_subtitles` reserves subtitle credits, calls the BuzzAssist subtitle API (ElevenLabs forced alignment for scripted mode, Scribe v2 for scriptless), then builds SRT cues locally with the ported Japanese-aware segmentation (`lib/subtitleGeneration.mjs`).

## Folder-Canvas Storage

Same model as the Youtube-AGI (BuzzAssist) folder canvas: a canvas belongs to one project folder, and everything generated on it is written under that folder.

```text
<project>/
  canvas/excalidraw-canvas.json     # the canvas (BuzzAssist: the folder's .excalidraw canvas)
  canvas/excalidraw-selection.json
  canvas/excalidraw-view-state.json
  canvas/assets/                    # generated images, videos, SRT files (BuzzAssist: .excalidraw/)
  canvas/assets-trash/              # orphaned assets moved here by startup maintenance (recoverable)
```

Bind the canvas to a project with `./scripts/start-canvas.sh /path/to/project` (macOS/Linux), `node scripts/start-canvas.mjs /path/to/project` (any OS), or `EXCALIDRAW_PROJECT_DIR`. Plugin tools take `projectDir` per call, so different projects keep separate canvases and assets.

Downloads: every media header has a ⬇ button (`/excalidraw-assets/<name>?download=1`); selecting two or more media shows a ZIP chip backed by `POST /api/assets/archive` (STORE-method ZIP, `lib/zipStore.mjs`). Select-all + chip = bulk export.

Maintenance: both servers run `performCanvasMaintenance` at startup (`lib/canvasScene.mjs`) — legacy inline base64 file records migrate to `canvas/assets/`, stale atomic-write `.tmp` files are removed, and assets referenced nowhere move to `canvas/assets-trash/`. `node scripts/cleanup-canvas.mjs [--dry-run]` removes empty generator frames (backs up the canvas first).

## Host Integrations

- Codex: `.codex-plugin/plugin.json` registers shared skills and `.mcp.json`; `node scripts/setup-agents.mjs --agent codex ...` installs `buzzassist@buzzassist`.
- Claude Code: `.claude-plugin/plugin.json` registers shared skills and `.mcp.json`; `node scripts/setup-agents.mjs --agent claude ...` installs `buzzassist@buzzassist`.
- Cursor: `.cursor/mcp.json` registers the local stdio MCP server, and `.cursor/rules/buzzassist.mdc` tells Cursor to run `--agent cursor` when asked to set up from the repository URL.
- Antigravity: `.agents/mcp_config.json` registers the local MCP server, and `GEMINI.md` tells Antigravity to run `--agent antigravity` when asked to set up from the repository URL.

Start the canvas with `./scripts/start-canvas.sh`, then use the same BuzzAssist plugin tools from supported agent sessions.

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

## Plugin Shape

The host metadata is in:

```text
.codex-plugin/plugin.json
.claude-plugin/plugin.json
.cursor/mcp.json
.cursor/rules/buzzassist.mdc
.antigravity-plugin/plugin.json
.agents/mcp_config.json
GEMINI.md
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
