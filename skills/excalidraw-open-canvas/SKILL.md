---
name: excalidraw-open-canvas
description: Open the local project-bound BuzzAssist Excalidraw canvas. Use when the user asks to open, launch, view, or work in Excalidraw from Codex or Claude Code.
---

# Excalidraw Open Canvas

## Workflow

1. Start the local Excalidraw web service with the user's active project directory, and keep the process running:

```bash
./scripts/start-canvas.sh /path/to/user/project
```

Run this from the BuzzAssist Excalidraw repository root. Pass the active user project directory, not the plugin repository directory.

2. Open the local URL in the current host's in-app browser when browser control is available. In Codex, use the in-app Browser tool. In Claude Code, use its browser tool if available. This is mandatory for both hosts when those tools are exposed: do not use the OS/default browser (`open`, `xdg-open`, etc.) as a substitute unless the user explicitly asks for it.

The default URL is usually:

```text
http://127.0.0.1:43219/
```

If that port is busy, the server chooses another local port. Read
`canvas/.server.json` for the live `url`.

Canvas data is saved under:

```text
canvas/excalidraw-canvas.json
canvas/excalidraw-selection.json
canvas/assets/
```

If browser control is unavailable, treat the service start as successful and give the user the local URL.

## Phone / Mobile Same-UI Access

If the user asks to open the canvas from a phone, share it outside the machine,
or use the exact same Excalidraw UI remotely, use Canvas Tunnel instead of
BuzzAssist Remote Canvas:

```bash
npm run tunnel:start -- --project-dir /path/to/user/project
```

If ngrok is not configured, ask for the user's personal ngrok authtoken or tell
them to run:

```bash
ngrok config add-authtoken <token>
```

The tunnel prints an ngrok URL and Basic Auth credentials. Give those to the
user for the phone. Continue to open the local `BUZZASSIST_CANVAS_URL` in the
current host's in-app browser for desktop work. Do not use the OS/default
browser unless the user explicitly asks.

Stop the tunnel when finished:

```bash
npm run tunnel:stop -- --project-dir /path/to/user/project
```

## Notes

This design intentionally mirrors Cowart's local-service shape: the browser edits a project-local canvas file, and Codex uses plugin tools for stable state reads/writes.
