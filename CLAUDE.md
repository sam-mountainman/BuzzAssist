# BuzzAssist Agent Setup

When the user gives this repository URL and asks to set it up, do the setup end to end.

1. Clone or open this repository.
2. Run `node scripts/setup-agents.mjs --project-dir <active-user-project-dir>` from the repository root. If there is no separate active project, use this repository root as the project dir.
3. The script must configure both Claude Code and Codex. Do not stop after installing only the host currently running you.
4. After the script prints `BUZZASSIST_CANVAS_URL=...`, open that URL in the current host's in-app browser. If Claude Code exposes a browser tool, use it. If browser control is unavailable, report the URL and say that setup still completed.

Manual fallback:

```bash
node scripts/setup-agents.mjs --project-dir <active-user-project-dir> --no-launch
claude plugin marketplace add ~/plugins/buzzassist --scope user
claude plugin install buzzassist@buzzassist-local --scope user
codex plugin add buzzassist@personal
node scripts/serve-canvas.mjs <active-user-project-dir>
```

Use the live URL from `canvas/.server.json` when a requested port is busy.
