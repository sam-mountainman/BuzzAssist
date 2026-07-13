---
name: excalidraw-open-canvas
description: Open the local project-bound BuzzAssist Excalidraw canvas. Use when the user asks to open, launch, view, or work in Excalidraw from Codex or Claude Code.
---

# Excalidraw Open Canvas

## Workflow

1. Resolve the host task's current workspace/project root. This is the project
   the user currently opened in Codex or Claude Code — never substitute the
   BuzzAssist plugin/cache/repository directory and never reuse the project
   chosen during an older setup just because it already has a server.

2. Call the plugin `open_buzzassist_canvas` tool with that absolute directory:

```json
{
  "projectDir": "/absolute/path/to/current/user/project"
}
```

The MCP server also reads the host's MCP workspace roots automatically when
`projectDir` is omitted, but pass it explicitly whenever the host exposes the
current working directory. The tool starts or reuses this project's server,
creates `<project>/canvas/assets`, and returns the project's live `canvasUrl`.

3. If the plugin tool is unavailable, start the service manually and keep it
running:

```bash
node scripts/serve-canvas.mjs /path/to/current/user/project
```

Run this from the BuzzAssist repository root. The same command works in macOS,
Windows PowerShell, and Linux.

4. Open the returned local URL in the current host's in-app browser when
browser control is available. In Codex, use the in-app Browser tool. In Claude
Code, use its browser tool if available. This is mandatory for both hosts when
those tools are exposed: do not use the OS/default browser (`open`,
`xdg-open`, etc.) as a substitute unless the user explicitly asks for it.

The default URL is usually:

```text
http://127.0.0.1:43219/
```

If that port is busy, the server chooses another local port. Read the current
project's `canvas/.server.json` for the live `url`. Different projects can run
simultaneously on different localhost ports.

Canvas data is saved under:

```text
<current-project>/canvas/excalidraw-canvas.json
<current-project>/canvas/excalidraw-selection.json
<current-project>/canvas/assets/
```

If browser control is unavailable, treat the service start as successful and give the user the local URL.

## Phone / Mobile Same-UI Access

If the user asks to open the canvas from a phone, share it outside the machine,
or use the exact same Excalidraw UI remotely, use Canvas Tunnel instead of
BuzzAssist Remote Canvas:

```bash
npm run tunnel:start -- --project-dir /path/to/user/project
```

Canvas Tunnel uses Cloudflare (`cloudflared`) by default. A quick tunnel needs
no account; if `cloudflared` is not installed, tell the user to install it. For
a fixed `canvas.buzzassist.ai` URL, the user runs `cloudflared tunnel login`
once, then starts with `--cf-hostname canvas.buzzassist.ai`.

Use ngrok only when the user explicitly asks for ngrok:

```bash
npm run tunnel:start -- --project-dir /path/to/user/project --provider ngrok --ngrok-authtoken <token>
```

The tunnel prints a public URL and an Access URL. Give the Access URL to the
user for the phone. Continue to open the local `BUZZASSIST_CANVAS_URL` in the
current host's in-app browser for desktop work. Do not use the OS/default
browser unless the user explicitly asks.

Stop the tunnel when finished:

```bash
npm run tunnel:stop -- --project-dir /path/to/user/project
```

## Notes

This design intentionally mirrors Cowart's local-service shape: the browser edits a project-local canvas file, and Codex uses plugin tools for stable state reads/writes.
