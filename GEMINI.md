# Koya manga video — mandatory Antigravity route

For any request that produces, changes, reviews, repairs, renders, or audits a Japanese manga video, Antigravity must first read these canonical skills completely:

- `.agents/skills/manga-video-production/SKILL.md`
- `.agents/skills/manga-page-camera/SKILL.md`

The operator-facing top-level entrypoint is `node scripts/run-video-harness.mjs`; it owns the durable Job, signed Channel Pack, doctor, resume/cancel, RunReceipt, and Canvas projection. Inside the selected Koya adapter, `node scripts/koya-manga-video.mjs` is the only production runner for a new episode. The historical `scripts/build-manga-video.mjs` and versioned `apply/finalize/generate-manga-v*` scripts are benchmark-only migrations and must not be used for a new episode. The quality gates documented in those skills (voice quality, character attribute gate, blind comparison) are host-agnostic and apply here identically. Do not claim completion until the official final audit passes, the MP4-derived contact-sheet signoff is valid, `knownRemainingIssues` is empty, and the real MP4 fully decodes.

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

**Antigravity にはフックの仕組みが無い。** Claude Code と Codex では、訂正らしい発言を
フック（UserPromptSubmit）が見つけて捕捉を促すが、Antigravity では誰も促さない。
訂正・禁止・繰り返しの指摘を受けたら、その場で自分で次を打つ:

```bash
node scripts/harness-learn.mjs capture --kind <correction|constraint|preference|fact> \
  --target <宛先> --text "何をどう直すか" --evidence "何を観測したか" --session "<この会話のID>"
```

台本の直し・訂正の宛先は `channel-pack:narrated-story-script`（チャンネルの非公開台帳）。
発言を逐語で写さず、何を直すかの形に書き直す。訂正に当たらなければ何もしなくてよい。

入口は `node scripts/harness-learn.mjs`。捕捉は何も書き換えず、統合は既定で
dry-run。エージェントは overlay（learned-auto.md）だけでなく正本スキル（SKILL.md・
references）も直してよい。提案を正本へ反映するときは `pending` → `approve` を通し、
変更前後の sha256・元の提案・時刻・誰が当てたかを残して、1件ずつ `rollback` できる形にする。
人が確かめるのは、運営者へ配る版（GitHub Release）を出すときの1回だけ
（`npm run skills:check:release` と、承認者本人の端末の `skill-inventory --approve`。
機械はこの承認を記録できない）。関門をそこに残すのは、人が見ないまま他人のパソコンへ
届き、有料 API を動かす指示になるのを防ぐため。開発用チェックアウトでの制作は承認前の
正本でも止めず、その事実を Job と RunReceipt に残す。

# 完成と言う前に Job の状態を自分で確かめる

Claude Code と Codex では、Job が合格で決着していないのに「完成しました」と言って止まると、
Stop フック（`scripts/harness-stop-hook.mjs`）が差し戻す。**Antigravity にはフックが無い**ので、
完成・完了・納品できると書く前に、自分で
`node scripts/run-video-harness.mjs status --job-id <Job ID> --project-dir <プロジェクト>` を打ち、
`status` が `completed`、`blockers` と `knownRemainingIssues` が空、Job の RunReceipt
（`canvas/harness-runs/<Job ID>/run-receipt.json`）の `outcome` が `pass` であることを確かめる。
どれかが欠けていれば完成と書かず、今の状態と残りの項目を報告する。`awaiting-human-review` は
正当な停止なので、確認待ちであることと、誰が何を確認すれば進むかを報告する。

# 外部モデルの呼び出しの記録

外部モデルの呼び出しは、**呼び出し元のホストが**
`node scripts/harness-external-call.mjs record` で記録する（入出力の SHA・モデル・時刻・
呼び出し元の会話 ID だけで、本文は保存しない）。Antigravity にはフックが無く、呼ばれた側では
記録できないため。Claude Code / Codex から台本の手直しなどを頼まれて Antigravity が答えるときは、
呼んだ側が記録するので、ここでは記録しない（二重に数えない）。Antigravity 自身が別のモデルを
呼んだときは、Antigravity が呼び出し元として `--caller-host antigravity` で記録する。
返った id は台本の品質ループ（`node scripts/script-quality-loop.mjs record --external-call <id>`）が参照する。

<!-- BUZZASSIST:START -->
# BuzzAssist Agent Setup

When the user gives this repository URL and asks to set it up, do the setup end to end for Antigravity only.

1. Clone or open this repository.
2. Run `node scripts/setup-agents.mjs --agent antigravity --project-dir <active-user-project-dir>` from the repository root. If there is no separate active project, use this repository root as the project dir.
3. The script must configure Antigravity only. Do not configure Codex, Claude Code, or Cursor unless the user explicitly asks for those hosts too.
4. After the script prints `BUZZASSIST_CANVAS_URL=...` and `BUZZASSIST_CANVAS_CHECK=ok`, first open that URL in Antigravity's in-app browser. Only if that capability is unavailable, use Chrome/the external-browser fallback.
5. If the user wants phone/mobile access or says they want the exact same Excalidraw UI outside the machine, use Canvas Tunnel: run setup with `--tunnel` or run `npm run tunnel:start -- --project-dir <active-user-project-dir>`. The tunnel uses Cloudflare (`cloudflared`) by default — no account is needed. If a system copy is not installed, BuzzAssist downloads the pinned official release into the user's `~/.buzzassist/tools/` cache, verifies its SHA-256 checksum, and runs it without administrator privileges. Use `--no-auto-download` or `BUZZASSIST_CLOUDFLARED_AUTO_DOWNLOAD=0` to opt out. Give the printed `BUZZASSIST_TUNNEL_ACCESS_URL` for the phone.

Manual fallback:

```bash
node scripts/setup-agents.mjs --agent antigravity --project-dir <active-user-project-dir> --no-launch
node scripts/serve-canvas.mjs <active-user-project-dir>
npm run tunnel:start -- --project-dir <active-user-project-dir>
```

Use the live URL from `canvas/.server.json` when a requested port is busy.
<!-- BUZZASSIST:END -->
