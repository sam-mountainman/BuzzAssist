---
name: excalidraw-open-canvas
description: Open the local project-bound Excalidraw canvas. Use when the user asks to open, launch, view, or work in Excalidraw from Codex.
---

# Excalidraw Open Canvas

## Workflow

1. Start the local Excalidraw web service with the user's active Codex project directory, and keep the process running:

```bash
./scripts/start-canvas.sh /path/to/user/codex-project
```

Run this from the Codex Excalidraw repository root. Pass the active user project directory, not the plugin repository directory.

2. Open the local URL in the Codex in-app browser when the Browser tool chain is available.

The default URL is:

```text
http://127.0.0.1:43219/
```

Canvas data is saved under:

```text
canvas/excalidraw-canvas.json
canvas/excalidraw-selection.json
canvas/assets/
```

If browser control is unavailable, treat the service start as successful and give the user the local URL.

## Notes

This design intentionally mirrors Cowart's local-service shape: the browser edits a project-local canvas file, and Codex uses MCP tools for stable state reads/writes.
