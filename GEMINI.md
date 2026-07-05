<!-- BUZZASSIST:START -->
# BuzzAssist Agent Setup

When the user gives this repository URL and asks to set it up, do the setup end to end for Antigravity only.

1. Clone or open this repository.
2. Run `node scripts/setup-agents.mjs --agent antigravity --project-dir <active-user-project-dir>` from the repository root. If there is no separate active project, use this repository root as the project dir.
3. The script must configure Antigravity only. Do not configure Codex, Claude Code, or Cursor unless the user explicitly asks for those hosts too.
4. After the script prints `BUZZASSIST_CANVAS_URL=...` and `BUZZASSIST_CANVAS_CHECK=ok`, open that URL in Antigravity's in-app browser if available. If browser control is unavailable, report the URL and say that setup still completed because the canvas check passed.

Manual fallback:

```bash
node scripts/setup-agents.mjs --agent antigravity --project-dir <active-user-project-dir> --no-launch
node scripts/serve-canvas.mjs <active-user-project-dir>
```

Use the live URL from `canvas/.server.json` when a requested port is busy.
<!-- BUZZASSIST:END -->
