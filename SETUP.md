# BuzzAssist Setup

This repository is intended to work from only a GitHub URL plus "セットアップして".
No manual plugin ID should be required. The setup target is the host that received the request.

```text
https://github.com/taiyuhiga/BuzzAssist
```

An agent should clone/open the repo, run the setup script for itself only, then open the canvas URL in the current host's in-app browser.

```bash
node scripts/setup-agents.mjs --agent codex --project-dir /path/to/active/project
node scripts/setup-agents.mjs --agent claude --project-dir /path/to/active/project
node scripts/setup-agents.mjs --agent cursor --project-dir /path/to/active/project
node scripts/setup-agents.mjs --agent antigravity --project-dir /path/to/active/project
```

If the user wants phone access to the exact same Excalidraw UI, add `--tunnel`.
On first use, pass `--ngrok-authtoken <token>` or set
`BUZZASSIST_NGROK_AUTHTOKEN`; each user should use their own ngrok account.

What the script does:

- installs npm dependencies when needed
- builds the static canvas UI when needed
- refreshes a lightweight local marketplace at `~/plugins/buzzassist`
- stores the actual plugin root at `~/plugins/buzzassist/plugin`
- for Codex: registers `~/plugins/buzzassist` and installs `buzzassist@buzzassist`
- for Claude Code: registers `~/plugins/buzzassist` and installs `buzzassist@buzzassist`
- for Cursor: writes `.cursor/mcp.json` and `.cursor/rules/buzzassist.mdc` in the active project
- for Antigravity: writes `.agents/mcp_config.json` and a managed BuzzAssist block in `GEMINI.md` in the active project
- starts the local canvas service and prints `BUZZASSIST_CANVAS_URL=...`
- checks the browser canvas and prints `BUZZASSIST_CANVAS_CHECK=ok`
- with `--tunnel`, starts ngrok and prints `BUZZASSIST_TUNNEL_URL=...`,
  `BUZZASSIST_TUNNEL_USER=...`, and `BUZZASSIST_TUNNEL_PASSWORD=...`

The script intentionally leaves other agents untouched. Use `--all-agents` only when the user explicitly asks to configure every supported host.

After setup, open the printed URL in the host in-app browser. If browser control is unavailable, use the URL from the discovery file and treat `BUZZASSIST_CANVAS_CHECK=ok` as the setup completion signal:

```text
canvas/.server.json
```

For mobile access, open `BUZZASSIST_TUNNEL_URL` on the phone and enter the
printed Basic Auth credentials. Stop it with `npm run tunnel:stop` or the
`buzzassist_canvas_tunnel_stop` MCP tool.
