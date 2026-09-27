# BuzzAssist Agent Setup

This is the full setup procedure that the host instruction files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`)
point to. When the user gives this repository URL and asks you to set it up, read this document to the end,
then do the setup end to end. The host instruction files keep only the entry command and the canvas rules;
everything else is here.

Use the values for your own host:

| | Claude Code | Codex |
|---|---|---|
| `--agent` value | `claude` | `codex` |
| The other host (and its command) | Codex (`codex`) | Claude Code (`claude`) |
| Where to open the canvas first | Claude Code's browser tool (in-app browser) | Codex's in-app browser |
| What to start after setup | a new Claude Code session | a new Codex task |

Antigravity and Cursor have their own, shorter procedures at the end of this document.

## Claude Code and Codex

1. Clone or open this repository. If the machine has no Node.js 20+, use the one-line installer instead of
   cloning: macOS/Linux `curl -fsSL https://raw.githubusercontent.com/sam-mountainman/BuzzAssist/main/install.sh | bash`,
   Windows `powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -UseBasicParsing https://raw.githubusercontent.com/sam-mountainman/BuzzAssist/main/install.ps1 -OutFile $env:TEMP\buzzassist-install.ps1; & $env:TEMP\buzzassist-install.ps1"`.
   It verifies Node, the Release, and every download, configures every installed host (Claude Code and Codex),
   and lists remaining video-harness prerequisites as next steps.
2. Run `node scripts/setup-agents.mjs --agent <your --agent value> --project-dir <active-user-project-dir>` from
   the repository root. If the other host is also installed on this machine (its command exists), run
   `--agents claude,codex` instead so both hosts read the same skill version. If there is no separate active
   project, use this repository root as the project dir. On Windows, run the same command from PowerShell; do
   not use the `.sh` wrappers.
3. Configure your own host, plus the other host only when it is already installed on this machine. Both hosts
   must read the same canonical skills, so do not leave one of them on an older plugin. Do not configure Claude
   Desktop, Cursor, or Antigravity unless the user explicitly asks for those hosts too.
   `BUZZASSIST_AUTO_UPDATE_HOSTS` may list the other host even when you configured one; that is expected,
   because auto-update also refreshes every host that already has the BuzzAssist plugin.
4. Setup also installs pinned ffmpeg/ffprobe and a Python venv (opencv-python-headless<5, numpy, pillow) into
   `~/.buzzassist/tools/` without administrator rights (opt out with `--no-install-prerequisites`), and creates
   the machine's own `harness-deployments.json` from `config/harness-deployments.example.json` (same folder) when it
   is missing. If setup stops with exit 2 because
   video-harness prerequisites are missing (for example the voice-quality Python stack, paid API keys, or a
   Codex login), fix them and rerun; when the user only needs the canvas and media tools now, rerun with
   `--allow-harness-not-ready` and report the remaining items as next steps. Paid production still stops at the
   doctor gate when a Job starts.
5. Treat setup as complete only when your host is reported as `configured`, and the script prints
   `BUZZASSIST_CANVAS_URL=...`, `BUZZASSIST_CANVAS_CHECK=ok`, and `BUZZASSIST_AUTO_UPDATE=enabled`.
   The updater checks only stable GitHub Releases, validates a staged build and real MCP call, backs up the
   active plugin, and rolls back on failure. Operators set up before 0.1.27 must rerun setup once: their
   scheduler entry lacks the login-time catch-up and the PATH that the updater needs, so scheduled updates could
   not install new Releases. Do not disable it unless the user explicitly requests `--no-auto-update`.
   If host installation or verification fails, fix that error and rerun the same command; do not claim setup
   succeeded.
6. Then first open `BUZZASSIST_CANVAS_URL` in your host's in-app browser (Claude Code: its browser tool when it is
   exposed; Codex: its in-app browser). This is mandatory when that browser control is available. Only when the
   current host's in-app Browser capability is unavailable may you use Chrome/the OS browser fallback; with the
   installed MCP, call `open_buzzassist_canvas` again with `openExternalBrowser: true`.
7. Tell the user to start a new Claude Code session / Codex task after setup so the installed skills and MCP
   tools are loaded.
8. If the user wants phone/mobile access or says they want the exact same Excalidraw UI outside the machine, use
   Canvas Tunnel: run setup with `--tunnel` or run `npm run tunnel:start -- --project-dir <active-user-project-dir>`.
   The tunnel uses Cloudflare (`cloudflared`) by default — no account is needed for a quick tunnel. If a system
   copy is not installed, BuzzAssist downloads the pinned official release into the user's `~/.buzzassist/tools/`
   cache, verifies its SHA-256 checksum, and runs it without administrator privileges. Use
   `--no-auto-download` or `BUZZASSIST_CLOUDFLARED_AUTO_DOWNLOAD=0` to opt out. For a fixed
   `canvas.buzzassist.ai` URL, they run `cloudflared tunnel login` once then start with
   `--cf-hostname canvas.buzzassist.ai`. To use ngrok instead, pass `--provider ngrok --ngrok-authtoken <token>`.
   Give the printed `BUZZASSIST_TUNNEL_ACCESS_URL` for the phone; keep using the local `BUZZASSIST_CANVAS_URL`
   in your host's in-app browser for desktop work.

### Canvas rules after setup

- Claude Code itself does not render MCP Apps widgets. Always use the local canvas URL plus MCP tools in Claude
  Code. From Codex, Claude Code follows the same local-canvas rule: open `BUZZASSIST_CANVAS_URL` in Claude Code's
  browser tool when it is exposed, and use MCP tools for stable reads/writes.
- The native `render_buzzassist_canvas_widget` entrypoint is experimental fallback only. Do not use it for Codex
  or Claude Code unless the user explicitly asks to test the widget.
- To attach selected canvas images, videos, SRT, XML, audio, or text files to the current Claude Code / Codex
  chat, use the plugin MCP tools `prepare_canvas_attachments`, `read_canvas_attachment_bundle`, and
  `list_canvas_attachment_bundles`.
- Do not use OS GUI automation (`open -a`, AppleScript, clipboard keystrokes) as the primary media attachment
  path. That route is macOS-only and can target the wrong chat (from Claude Code, also a new Cowork chat). The
  MCP tools work on macOS and Windows because the current chat pulls the prepared bundle from
  `canvas/.agent-attachments/`.

### Manual fallback

Claude Code:

```bash
node scripts/setup-agents.mjs --agent claude --project-dir <active-user-project-dir> --no-launch
claude plugin marketplace add ~/plugins/buzzassist --scope user
claude plugin install buzzassist@buzzassist --scope user
node scripts/serve-canvas.mjs <active-user-project-dir>
npm run tunnel:start -- --project-dir <active-user-project-dir>
```

Codex:

```bash
node scripts/setup-agents.mjs --agent codex --project-dir <active-user-project-dir> --no-launch
codex plugin marketplace add ~/plugins/buzzassist
codex plugin add buzzassist@buzzassist
node scripts/serve-canvas.mjs <active-user-project-dir>
npm run tunnel:start -- --project-dir <active-user-project-dir>
```

Use the live URL from `canvas/.server.json` when a requested port is busy.

## Antigravity

Setup writes a short managed block (between `<!-- BUZZASSIST:START -->` and `<!-- BUZZASSIST:END -->`) into the
active project's `GEMINI.md`; this repository's `GEMINI.md` ends with the same block. The full procedure:

1. Clone or open this repository.
2. Run `node scripts/setup-agents.mjs --agent antigravity --project-dir <active-user-project-dir>` from the
   repository root. If there is no separate active project, use this repository root as the project dir.
3. The script must configure Antigravity only. Do not configure Codex, Claude Code, or Cursor unless the user
   explicitly asks for those hosts too.
4. After the script prints `BUZZASSIST_CANVAS_URL=...` and `BUZZASSIST_CANVAS_CHECK=ok`, first open that URL in
   Antigravity's in-app browser. Only if that capability is unavailable, use Chrome/the external-browser fallback.
5. If the user wants phone/mobile access or says they want the exact same Excalidraw UI outside the machine, use
   Canvas Tunnel: run setup with `--tunnel` or run `npm run tunnel:start -- --project-dir <active-user-project-dir>`.
   The tunnel uses Cloudflare (`cloudflared`) by default — no account is needed. If a system copy is not
   installed, BuzzAssist downloads the pinned official release into the user's `~/.buzzassist/tools/` cache,
   verifies its SHA-256 checksum, and runs it without administrator privileges. Use `--no-auto-download` or
   `BUZZASSIST_CLOUDFLARED_AUTO_DOWNLOAD=0` to opt out. Give the printed `BUZZASSIST_TUNNEL_ACCESS_URL` for the
   phone.

Manual fallback:

```bash
node scripts/setup-agents.mjs --agent antigravity --project-dir <active-user-project-dir> --no-launch
node scripts/serve-canvas.mjs <active-user-project-dir>
npm run tunnel:start -- --project-dir <active-user-project-dir>
```

Use the live URL from `canvas/.server.json` when a requested port is busy.

## Cursor

Setup writes `.cursor/mcp.json` and `.cursor/rules/buzzassist.mdc` into the active project; the rule file carries
the Cursor procedure (`node scripts/setup-agents.mjs --agent cursor --project-dir <active-user-project-dir>`,
Cursor only, in-app browser or browser preview first, Canvas Tunnel for phones).
