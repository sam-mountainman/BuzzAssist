# BuzzAssist Setup

This repository is intended to work from only a GitHub URL plus "セットアップして".
No manual plugin ID or host-specific setup instruction should be required.

```text
https://github.com/taiyuhiga/BuzzAssist
```

An agent should clone/open the repo, run the setup script, install the plugin into both hosts, then open the canvas URL in the current host's in-app browser.

```bash
node scripts/setup-agents.mjs --project-dir /path/to/active/project
```

What the script does:

- installs npm dependencies when needed
- builds the static canvas UI when needed
- refreshes a lightweight local marketplace at `~/plugins/buzzassist`
- stores the actual plugin root at `~/plugins/buzzassist/plugin`
- registers `~/plugins/buzzassist` as the `buzzassist` marketplace
- installs `buzzassist@buzzassist` into Codex
- installs `buzzassist@buzzassist` into Claude Code
- starts the local canvas service and prints `BUZZASSIST_CANVAS_URL=...`
- checks the browser canvas and prints `BUZZASSIST_CANVAS_CHECK=ok`

If the setup is triggered from Claude Code, Codex is still configured. If it is triggered from Codex, Claude Code is still configured.

After setup, open the printed URL in the host in-app browser. If browser control is unavailable, use the URL from the discovery file and treat `BUZZASSIST_CANVAS_CHECK=ok` as the setup completion signal:

```text
canvas/.server.json
```
