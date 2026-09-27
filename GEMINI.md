# BuzzAssist — Antigravity の地図

これは地図。依頼に当たる行の先を**最後まで読んでから**動く。ここから移した決まりの全文は `docs/host-instructions-detail-ja.md`、
直すときは `config/host-instructions.template.md` を直して `node scripts/generate-host-instructions.mjs` で作り直す（手で直さない）。

## 完成と言わない条件（最優先）

- 動画を完成・完了・納品できると言えるのは、Job が `completed`、RunReceipt が `pass`、`blockers` と `knownRemainingIssues` が空のときだけ。
  漫画はさらに、公式の最終監査が pass、MP4 から作った contact-sheet のサインオフが有効、実際の MP4 が最後までデコードできること。
- Antigravity にはフックが無い。完成と書く前に自分で `node scripts/run-video-harness.mjs status --job-id <Job ID> --project-dir <プロジェクト>`
  を打ち、RunReceipt（`canvas/harness-runs/<Job ID>/run-receipt.json` の `outcome`）まで確かめる。欠けていれば今の状態と残りを報告する。
- `awaiting-human-review` は正当な停止。確認待ちであることと、誰が何を確認すれば進むかを報告する。

## 依頼ごとに先に読む正本（最後まで読む）

- 漫画動画を作る・直す・レビュー・修復・書き出し・監査 → `.agents/skills/manga-video-production/SKILL.md` と
  `.agents/skills/manga-page-camera/SKILL.md`。そこに書かれた品質ゲート（声の品質・キャラの属性ゲート・ブラインド比較）は Antigravity でも同じに効く。
- 生の日本語台本から完成動画 → `.agents/skills/platform-craft/SKILL.md` とジャンルのスキル
  （ナレーション物語は `.agents/skills/narrated-story-video/SKILL.md`、漫画は上の2本）。
- 解説動画（ハーネス `explainer-video`。ジャンルの正本スキルはまだ無い）→ platform-craft と `docs/explainer-video-harness-ja.md`。
  人の全編の試聴と初見の評価は、Job を動かした文脈とは別の文脈で `node scripts/explainer-video.mjs signoff` から記録する。
- 複数の作業を同時に流す（「並列で」「一気に」「最短で」、同種の作業が並ぶ）→ `.agents/skills/harness-parallel-execution/SKILL.md`。
  推測で並列化しない。入口は `node scripts/harness-parallel-run.mjs`（決定論層）と `node scripts/harness-parallel-agents.mjs`（LLM判断層）。
- 訂正・好み・禁止を受けた、こちらの誤りが判明した、実測で新しい事実が分かった → その場の修正で終わらせず
  `.agents/skills/harness-self-improvement/SKILL.md`。入口は `node scripts/harness-learn.mjs`。
  Antigravity にはフックの仕組みが無いので誰も捕捉を促さない。訂正・禁止・繰り返しの指摘を受けたら、その場で自分で
  `node scripts/harness-learn.mjs capture --kind <correction|constraint|preference|fact> --target <宛先> --text "何をどう直すか" --evidence "何を観測したか" --session "<この会話のID>"`
  を打つ（台本の直しの宛先は `channel-pack:narrated-story-script`。発言は逐語で写さず、何を直すかの形に書く）。

## 制作の決まり（どのホストも同じ）

- 運営者の入口は `node scripts/run-video-harness.mjs`（MCP `run_video_harness`）。署名済み Channel Pack を必須にし、
  有料の実行が明示で確かめられるまで既定の plan だけで止める。どのホストも同じハーネス宣言・Skill SHA・Channel Pack の
  指紋・品質ゲート・RunReceipt・Canvas 投影を使い、端末全体に入ったプラグインやスキルを暗黙の代わりにしない。
- 漫画の新作の内部 runner は `scripts/koya-manga-video.mjs` だけ。`scripts/build-manga-video.mjs` と版つきの
  `apply/finalize/generate-manga-v*` はベンチマークの移行専用で、新作に使わない。
- 漫画の新作は有料生成の前に主人公を決めて `--protagonist-speaker-id` を渡す。ナレーション枠の声も主人公の承認済みの声にする
  （枠の見た目は分けたまま、専用のナレーターを作らない）。
- 正本スキルへの反映は `pending` → `approve`（1件ずつ `rollback` できる）。人が確かめるのは配る版（GitHub Release）を出すときの
  1回だけ（`npm run skills:check:release` と承認者本人の端末の `skill-inventory --approve`。エージェントは打たない）。
  開発用チェックアウトの制作は承認前の正本でも止めず、その事実を Job と RunReceipt に残す。
- 外部モデルの呼び出しは、呼び出し元のホストが `node scripts/harness-external-call.mjs record` で記録する（本文は保存しない）。
  Claude Code / Codex に頼まれて答えるときは呼んだ側が記録するので、ここでは記録しない。Antigravity 自身が別のモデルを呼んだら
  `--caller-host antigravity` で記録する。

<!-- BUZZASSIST:START -->
# BuzzAssist Agent Setup

When the user gives this repository URL and asks to set it up, do the setup end to end for Antigravity only.

1. Clone or open this repository, then run `node scripts/setup-agents.mjs --agent antigravity --project-dir <active-user-project-dir>` from the repository root. If there is no separate active project, use this repository root as the project dir.
2. The script must configure Antigravity only. Do not configure Codex, Claude Code, or Cursor unless the user explicitly asks for those hosts too.
3. After the script prints `BUZZASSIST_CANVAS_URL=...` and `BUZZASSIST_CANVAS_CHECK=ok`, first open that URL in Antigravity's in-app browser. Only if that capability is unavailable, use Chrome/the external-browser fallback.
4. For phone/mobile access or the exact same Excalidraw UI outside the machine, use Canvas Tunnel: run setup with `--tunnel` or run `npm run tunnel:start -- --project-dir <active-user-project-dir>`, and give the printed `BUZZASSIST_TUNNEL_ACCESS_URL` for the phone.

Use the live URL from `canvas/.server.json` when a requested port is busy. The full procedure (tunnel download and opt-out, manual fallback) is `docs/agent-setup.md` in the BuzzAssist repository and in the installed plugin (`~/plugins/buzzassist/plugin/docs/agent-setup.md`).
<!-- BUZZASSIST:END -->
