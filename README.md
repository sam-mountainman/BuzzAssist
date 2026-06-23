# Codex Excalidraw

Codex Excalidraw is a local Excalidraw canvas for Codex, modeled after Cowart's architecture:

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

Start the MCP server:

```bash
./scripts/start-mcp.sh
```

Tools:

- `get_excalidraw_selection`: reads selected elements from `canvas/excalidraw-selection.json`
- `insert_excalidraw_image`: copies a local bitmap into `canvas/assets/`, adds an Excalidraw image file and element, and saves the scene
- `insert_excalidraw_video`: copies a local video into `canvas/assets/`, adds a linked video card, and saves the scene
- `generate_excalidraw_image`: generates with `gpt-image-2-codex` or `grok-imagine-image-hermes`, inserts the result, and saves the scene
- `generate_excalidraw_video`: generates with `grok-imagine-video-hermes`, inserts a linked video card, and saves the scene

## Media Generation Providers

The canvas UI and MCP tools use the same generation backend. Supported model IDs are intentionally aligned with the Youtube-AGI Excalidraw bridge:

```text
gpt-image-2-codex
grok-imagine-image-hermes
grok-imagine-video-hermes
```

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
