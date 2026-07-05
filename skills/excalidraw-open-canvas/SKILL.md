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

2. Open the local URL in the current host's in-app browser when browser control is available. In Codex, use the in-app Browser tool. In Claude Code, use its browser tool if available.

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

## Notes

This design intentionally mirrors Cowart's local-service shape: the browser edits a project-local canvas file, and Codex uses plugin tools for stable state reads/writes.
