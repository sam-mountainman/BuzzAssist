# BuzzAssist Agent Setup

When the user gives this repository URL and asks to set it up, do the setup end to end.

1. Clone or open this repository.
2. Run `node scripts/setup-agents.mjs --agent claude --project-dir <active-user-project-dir>` from the repository root. If there is no separate active project, use this repository root as the project dir.
3. The script must configure Claude Code only. Do not configure Codex, Cursor, or Antigravity unless the user explicitly asks for those hosts too.
4. After the script prints `BUZZASSIST_CANVAS_URL=...` and `BUZZASSIST_CANVAS_CHECK=ok`, open that URL in the current host's in-app browser. In Claude Code, use Claude Code's browser tool when it is exposed. This is mandatory when the tool is available: do not use the OS/default browser (`open`, `xdg-open`, etc.) as a substitute unless the user explicitly asks for it. If browser control is unavailable, report the URL and say that setup still completed because the canvas check passed.
5. If the user wants phone/mobile access or says they want the exact same Excalidraw UI outside the machine, use Canvas Tunnel: run setup with `--tunnel` or run `npm run tunnel:start -- --project-dir <active-user-project-dir>`. If ngrok is not configured, ask the user for their personal ngrok authtoken or tell them to run `ngrok config add-authtoken <token>`. Give the printed `BUZZASSIST_TUNNEL_URL` and Basic Auth credentials for the phone; keep using the local `BUZZASSIST_CANVAS_URL` in Claude Code's in-app browser for desktop work.

Manual fallback:

```bash
node scripts/setup-agents.mjs --agent claude --project-dir <active-user-project-dir> --no-launch
claude plugin marketplace add ~/plugins/buzzassist --scope user
claude plugin install buzzassist@buzzassist --scope user
node scripts/serve-canvas.mjs <active-user-project-dir>
npm run tunnel:start -- --project-dir <active-user-project-dir>
```

Use the live URL from `canvas/.server.json` when a requested port is busy.
