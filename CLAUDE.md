# Koya manga video — mandatory Claude route

For any request that produces, changes, reviews, repairs, renders, or audits a Japanese manga video, Claude must first read these canonical skills completely:

- `.agents/skills/manga-video-production/SKILL.md`
- `.agents/skills/manga-page-camera/SKILL.md`

The `.claude/skills` entries are host adapters to that shared source. The operator-facing top-level entrypoint is `node scripts/run-video-harness.mjs`; it owns the durable Job, signed Channel Pack, doctor, resume/cancel, RunReceipt, and Canvas projection. Inside the selected Koya adapter, `node scripts/koya-manga-video.mjs` is the only production runner for a new episode. The historical `scripts/build-manga-video.mjs` and versioned `apply/finalize/generate-manga-v*` scripts are benchmark-only migrations and must not be used for a new episode. Do not claim completion until the official final audit passes, the MP4-derived contact-sheet signoff is valid, `knownRemainingIssues` is empty, and the real MP4 fully decodes.

For new episodes, identify the protagonist before paid generation and pass `--protagonist-speaker-id`. Square narration boxes remain visually distinct, but every narration line must use the protagonist's exact approved voice; do not create a dedicated narrator.

# Raw script to finished video — shared route

For any operator request that turns a raw Japanese script into a finished video, first read
`.agents/skills/platform-craft/SKILL.md` and the selected genre skill completely. For narrated
story videos that genre skill is `.agents/skills/narrated-story-video/SKILL.md`; manga continues
to use the two mandatory skills above. Start through `node scripts/run-video-harness.mjs` (or the
equivalent `run_video_harness` MCP tool), require a signed Channel Pack, and keep the default
plan-only behavior unless paid execution was explicitly confirmed. Claude Code and Codex must
use the same Harness declaration, Skill SHA, Channel Pack fingerprint, quality gates, RunReceipt,
and BuzzAssist Canvas projection; a globally installed plugin or skill is not an implicit fallback.

# 並列実行 — 両ハーネス共通ルート

複数の作業を同時に流すとき（「並列で」「同時に」「一気に」「最短で」、
また11人分のキャラゲートや30セグメントのTTSのように同種の作業が並ぶとき）は、
先にこの正本を最後まで読む:

- `.agents/skills/harness-parallel-execution/SKILL.md`

実測した並列上限、並列にしてよい工程と直列必須の工程、同時書き込みで壊れる
共有状態ファイルの一覧がそこにある。推測で並列化しないこと。入口は
`node scripts/harness-parallel-run.mjs`（決定論層）と
`node scripts/harness-parallel-agents.mjs`（LLM判断層）で、
Claude Code と Codex のどちらから実行しても同じ結果になる。

# 自己改善 — 指摘を次のセッションへ残す

ユーザーから訂正・好み・禁止事項を受けたとき、こちらの誤りが判明したとき、
実測で新しい事実が分かったときは、その場の修正で終わらせずに先にこれを読む:

- `.agents/skills/harness-self-improvement/SKILL.md`

入口は `node scripts/harness-learn.mjs`。捕捉は何も書き換えず、統合は既定で
dry-run、正本への反映には reviewer 名が要る。自動で正本を書き換える作りに
していないのは、それが「自分で自分に合格を出す」構造になるため。

# 外部モデル呼び出しの記録 — 呼んだ側が残す

Antigravity 経由の Gemini など外部モデルを呼んだら、呼び出し元のこのホストが、呼び出しのたびに
`node scripts/harness-external-call.mjs record --host <antigravity|codex|claude> --model <id> --purpose "<用途>" --input <渡した本文のファイル> --output <返った本文のファイル> --work-dir <台本の作業フォルダ> --session <この会話のID>`
で記録する。Antigravity にはフックの仕組みが無く、呼ばれた側では記録できないため。台帳には入出力の
SHA・モデル・時刻・呼び出し元の会話 ID だけが残り、本文は保存しない。空返答・途中切れは
`--status empty|truncated` で未完として残す（出力が空なら自動で empty になる）。返った id は台本の品質ループ
（`node scripts/script-quality-loop.mjs record --external-call <id>`）へ渡し、その版は呼んだ文脈とは別の文脈で採点する。

# BuzzAssist Agent Setup

When the user gives this repository URL and asks to set it up, do the setup end to end.

1. Clone or open this repository. If the machine has no Node.js 20+, use the one-line installer instead of cloning: macOS/Linux `curl -fsSL https://raw.githubusercontent.com/sam-mountainman/BuzzAssist/main/install.sh | bash`, Windows `powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -UseBasicParsing https://raw.githubusercontent.com/sam-mountainman/BuzzAssist/main/install.ps1 -OutFile $env:TEMP\buzzassist-install.ps1; & $env:TEMP\buzzassist-install.ps1"`. It verifies Node, the Release, and every download, configures every installed host (Claude Code and Codex), and lists remaining video-harness prerequisites as next steps.
2. Run `node scripts/setup-agents.mjs --agent claude --project-dir <active-user-project-dir>` from the repository root. If Codex is also installed on this machine (the `codex` command exists), run `--agents claude,codex` instead so both hosts read the same skill version. If there is no separate active project, use this repository root as the project dir. On Windows, run the same command from PowerShell; do not use the `.sh` wrappers.
3. Configure Claude Code, plus Codex only when it is already installed on this machine. Both hosts must read the same canonical skills, so do not leave one of them on an older plugin. Do not configure Claude Desktop, Cursor, or Antigravity unless the user explicitly asks for those hosts too. `BUZZASSIST_AUTO_UPDATE_HOSTS` may list the other host even when you configured one; that is expected, because auto-update also refreshes every host that already has the BuzzAssist plugin.
4. Setup also installs pinned ffmpeg/ffprobe and a Python venv (opencv-python-headless<5, numpy, pillow) into `~/.buzzassist/tools/` without administrator rights (opt out with `--no-install-prerequisites`), and creates `config/harness-deployments.json` from the example when it is missing. If setup stops with exit 2 because video-harness prerequisites are missing (for example the voice-quality Python stack, paid API keys, or a Codex login), fix them and rerun; when the user only needs the canvas and media tools now, rerun with `--allow-harness-not-ready` and report the remaining items as next steps. Paid production still stops at the doctor gate when a Job starts.
5. Treat setup as complete only when Claude Code is reported as `configured`, and the script prints `BUZZASSIST_CANVAS_URL=...`, `BUZZASSIST_CANVAS_CHECK=ok`, and `BUZZASSIST_AUTO_UPDATE=enabled`. The updater checks only stable GitHub Releases, validates a staged build and real MCP call, backs up the active plugin, and rolls back on failure. Operators set up before 0.1.27 must rerun setup once: their scheduler entry lacks the login-time catch-up and the PATH that the updater needs, so scheduled updates could not install new Releases. Do not disable it unless the user explicitly requests `--no-auto-update`. If host installation or verification fails, fix that error and rerun the same command; do not claim setup succeeded. Then first open that URL with Claude Code's browser tool when it is exposed. This is mandatory when the tool is available. Only when the current host's in-app Browser capability is unavailable may you use Chrome/the OS browser fallback; with the installed MCP, call `open_buzzassist_canvas` again with `openExternalBrowser: true`. Tell the user to start a new Claude Code session after setup so the installed skills and MCP tools are loaded.
6. If the user wants phone/mobile access or says they want the exact same Excalidraw UI outside the machine, use Canvas Tunnel: run setup with `--tunnel` or run `npm run tunnel:start -- --project-dir <active-user-project-dir>`. The tunnel uses Cloudflare (`cloudflared`) by default — no account is needed for a quick tunnel. If a system copy is not installed, BuzzAssist downloads the pinned official release into the user's `~/.buzzassist/tools/` cache, verifies its SHA-256 checksum, and runs it without administrator privileges. Use `--no-auto-download` or `BUZZASSIST_CLOUDFLARED_AUTO_DOWNLOAD=0` to opt out. For a fixed `canvas.buzzassist.ai` URL, they run `cloudflared tunnel login` once then start with `--cf-hostname canvas.buzzassist.ai`. To use ngrok instead, pass `--provider ngrok --ngrok-authtoken <token>`. Give the printed `BUZZASSIST_TUNNEL_ACCESS_URL` for the phone; keep using the local `BUZZASSIST_CANVAS_URL` in Claude Code's in-app browser for desktop work.
7. Claude Code itself does not render MCP Apps widgets. Always use the local canvas URL plus MCP tools in Claude Code.
8. The native `render_buzzassist_canvas_widget` entrypoint is experimental fallback only. Do not use it for Claude Code unless the user explicitly asks to test the widget.

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
