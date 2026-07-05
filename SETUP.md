# BuzzAssist Setup

This repository is intended to work from a GitHub URL plus "セットアップして".

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
- installs `buzzassist@personal` into Codex
- registers `~/plugins/buzzassist` as the `buzzassist-local` marketplace for Claude Code
- installs `buzzassist@buzzassist-local` into Claude Code
- starts the local canvas service and prints `BUZZASSIST_CANVAS_URL=...`

If the setup is triggered from Claude Code, Codex is still configured. If it is triggered from Codex, Claude Code is still configured.

After setup, open the printed URL in the host in-app browser. If browser control is unavailable, use the URL from:

```text
canvas/.server.json
```
