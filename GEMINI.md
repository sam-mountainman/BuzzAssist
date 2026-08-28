<!-- BUZZASSIST:START -->
# Koya manga video — mandatory route

For any request that produces, changes, reviews, repairs, renders, or audits a
Japanese manga video, read these canonical skills completely first:

- `.agents/skills/manga-video-production/SKILL.md`
- `.agents/skills/manga-page-camera/SKILL.md`

Use `node scripts/koya-manga-video.mjs` as the only production entrypoint for new
episodes. The quality gates documented in that skill (voice quality, character
attribute gate, blind comparison) are host-agnostic and apply here identically.
Do not claim completion until the official final audit passes, the MP4-derived
contact-sheet signoff is valid, `knownRemainingIssues` is empty, and the real
MP4 fully decodes.

# BuzzAssist Agent Setup

When the user gives this repository URL and asks to set it up, do the setup end to end for Antigravity only.

1. Clone or open this repository.
2. Run `node scripts/setup-agents.mjs --agent antigravity --project-dir <active-user-project-dir>` from the repository root. If there is no separate active project, use this repository root as the project dir.
3. The script must configure Antigravity only. Do not configure Codex, Claude Code, or Cursor unless the user explicitly asks for those hosts too.
4. After the script prints `BUZZASSIST_CANVAS_URL=...` and `BUZZASSIST_CANVAS_CHECK=ok`, open that URL in Antigravity's in-app browser if available. If browser control is unavailable, report the URL and say that setup still completed because the canvas check passed.
5. If the user wants phone/mobile access or says they want the exact same Excalidraw UI outside the machine, use Canvas Tunnel: run setup with `--tunnel` or run `npm run tunnel:start -- --project-dir <active-user-project-dir>`. The tunnel uses Cloudflare (`cloudflared`) by default — no account needed for a quick tunnel. If it is not installed, tell the user to install it with `brew install cloudflared` on macOS or `winget install Cloudflare.cloudflared` on Windows. Give the printed `BUZZASSIST_TUNNEL_ACCESS_URL` for the phone.

Manual fallback:

```bash
node scripts/setup-agents.mjs --agent antigravity --project-dir <active-user-project-dir> --no-launch
node scripts/serve-canvas.mjs <active-user-project-dir>
npm run tunnel:start -- --project-dir <active-user-project-dir>
```

Use the live URL from `canvas/.server.json` when a requested port is busy.
<!-- BUZZASSIST:END -->
