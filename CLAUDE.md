# BuzzAssist Agent Setup

When the user gives this repository URL and asks to set it up, do the setup end to end.

1. Clone or open this repository.
2. Run `node scripts/setup-agents.mjs --agent claude --project-dir <active-user-project-dir>` from the repository root. If there is no separate active project, use this repository root as the project dir. On Windows, run the same command from PowerShell; do not use the `.sh` wrappers.
3. The script must configure Claude Code only. Do not configure Codex, Claude Desktop, Cursor, or Antigravity unless the user explicitly asks for those hosts too.
4. Treat setup as complete only when Claude Code is reported as `configured`, and the script prints both `BUZZASSIST_CANVAS_URL=...` and `BUZZASSIST_CANVAS_CHECK=ok`. If host installation or verification fails, fix that error and rerun the same command; do not claim setup succeeded. Then open that URL in the current host's in-app browser. In Claude Code, use Claude Code's browser tool when it is exposed. This is mandatory when the tool is available: do not use the OS/default browser (`open`, `xdg-open`, etc.) as a substitute unless the user explicitly asks for it. If browser control is unavailable, report the URL and say that setup still completed because the canvas check passed. Tell the user to start a new Claude Code session after setup so the installed skills and MCP tools are loaded.
5. If the user wants phone/mobile access or says they want the exact same Excalidraw UI outside the machine, use Canvas Tunnel: run setup with `--tunnel` or run `npm run tunnel:start -- --project-dir <active-user-project-dir>`. The tunnel uses Cloudflare (`cloudflared`) by default — no account needed for a quick tunnel. If it is not installed, tell the user to install it with `brew install cloudflared` on macOS or `winget install Cloudflare.cloudflared` on Windows. For a fixed `canvas.buzzassist.ai` URL, they run `cloudflared tunnel login` once then start with `--cf-hostname canvas.buzzassist.ai`. To use ngrok instead, pass `--provider ngrok --ngrok-authtoken <token>`. Give the printed `BUZZASSIST_TUNNEL_ACCESS_URL` for the phone; keep using the local `BUZZASSIST_CANVAS_URL` in Claude Code's in-app browser for desktop work.
6. Claude Code itself does not render MCP Apps widgets. Always use the local canvas URL plus MCP tools in Claude Code.
7. The native `render_buzzassist_canvas_widget` entrypoint is experimental fallback only. Do not use it for Claude Code unless the user explicitly asks to test the widget.

Canvas media attachment rule:

- To attach selected canvas images, videos, SRT, XML, audio, or text files to the current Claude Code chat, use the plugin MCP tools `prepare_canvas_attachments`, `read_canvas_attachment_bundle`, and `list_canvas_attachment_bundles`.
- Do not use OS GUI automation (`open -a`, AppleScript, clipboard keystrokes) as the primary media attachment path. That route is macOS-only and can target the wrong chat or a new Cowork chat. The MCP tools work on macOS and Windows because the current chat pulls the prepared bundle from `canvas/.agent-attachments/`.

Manual fallback:

```bash
node scripts/setup-agents.mjs --agent claude --project-dir <active-user-project-dir> --no-launch
claude plugin marketplace add ~/plugins/buzzassist --scope user
claude plugin install buzzassist@buzzassist --scope user
node scripts/serve-canvas.mjs <active-user-project-dir>
npm run tunnel:start -- --project-dir <active-user-project-dir>
```

Use the live URL from `canvas/.server.json` when a requested port is busy.
