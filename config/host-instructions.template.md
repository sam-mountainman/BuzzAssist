# BuzzAssist — {{hostName}} の地図

これは地図。依頼に当たる行の先を**最後まで読んでから**動く。ここから移した決まりの全文は `docs/host-instructions-detail-ja.md`、
直すときは `config/host-instructions.template.md` を直して `node scripts/generate-host-instructions.mjs` で作り直す（手で直さない）。

## 完成と言わない条件（最優先）

- 動画を完成・完了・納品できると言えるのは、Job が `completed`、RunReceipt が `pass`、`blockers` と `knownRemainingIssues` が空のときだけ。
  漫画はさらに、公式の最終監査が pass、MP4 から作った contact-sheet のサインオフが有効、実際の MP4 が最後までデコードできること。
{{#hosts claude codex}}
- Stop フック（`scripts/harness-stop-hook.mjs`）は、Job が合格で決着していないのに完成と言うと差し戻す。言い直さずに Job の
  実際の状態を報告する。
{{/hosts}}
{{#hosts antigravity}}
- Antigravity にはフックが無い。完成と書く前に自分で `node scripts/run-video-harness.mjs status --job-id <Job ID> --project-dir <プロジェクト>`
  を打ち、RunReceipt（`canvas/harness-runs/<Job ID>/run-receipt.json` の `outcome`）まで確かめる。欠けていれば今の状態と残りを報告する。
{{/hosts}}
- `awaiting-human-review` は正当な停止。確認待ちであることと、誰が何を確認すれば進むかを報告する。
{{#hosts claude codex}}

## フックに止められたとき・圧縮のあと

- 実行前のフック（harness-guard-hook）が止めたのは、人が自分の端末で打つ操作（`--human-verified`・`skill-inventory --approve`・
  品質ループの人専用の操作・署名済みの封筒の書き換え）。迂回せず、決めてほしいことと打つコマンドを人に渡す。
- 圧縮されたと知らされたら（harness-compact-hook）、挙がった正本スキルと docs を最後まで読み直してから続ける。
- Codex はプラグインのフックを、新しく足されたものも `/hooks` で信頼するまで動かさない（更新で定義が変わったら信頼し直す）。
{{/hosts}}

## 依頼ごとに先に読む正本（最後まで読む）

- 漫画動画を作る・直す・レビュー・修復・書き出し・監査 → `.agents/skills/manga-video-production/SKILL.md` と
  `.agents/skills/manga-page-camera/SKILL.md`。{{skillNote}}
- 生の日本語台本から完成動画 → `.agents/skills/platform-craft/SKILL.md` とジャンルのスキル
  （ナレーション物語は `.agents/skills/narrated-story-video/SKILL.md`、漫画は上の2本）。
- 解説動画（ハーネス `explainer-video`。ジャンルの正本スキルはまだ無い）→ platform-craft と `docs/explainer-video-harness-ja.md`。
  人の全編の試聴と初見の評価は、Job を動かした文脈とは別の文脈で `node scripts/explainer-video.mjs signoff` から記録する。
- 複数の作業を同時に流す（「並列で」「一気に」「最短で」、同種の作業が並ぶ）→ `.agents/skills/harness-parallel-execution/SKILL.md`。
  推測で並列化しない。入口は `node scripts/harness-parallel-run.mjs`（決定論層）と `node scripts/harness-parallel-agents.mjs`（LLM判断層）。
- 訂正・好み・禁止を受けた、こちらの誤りが判明した、実測で新しい事実が分かった → その場の修正で終わらせず
  `.agents/skills/harness-self-improvement/SKILL.md`。入口は `node scripts/harness-learn.mjs`。
{{#hosts antigravity}}
  Antigravity にはフックの仕組みが無いので誰も捕捉を促さない。訂正・禁止・繰り返しの指摘を受けたら、その場で自分で
  `node scripts/harness-learn.mjs capture --kind <correction|constraint|preference|fact> --target <宛先> --text "何をどう直すか" --evidence "何を観測したか" --session "<この会話のID>"`
  を打つ（台本の直しの宛先は `channel-pack:narrated-story-script`。発言は逐語で写さず、何を直すかの形に書く）。
{{/hosts}}
{{#hosts claude codex}}
- このリポジトリの URL を渡されてセットアップを頼まれた → `docs/agent-setup.md` を最後まで読み、端から端まで行う。
  入口は `node scripts/setup-agents.mjs --agent {{agentId}} --project-dir <作業中のプロジェクト>`（{{otherHost}} も入っていれば `--agents claude,codex`）。
{{/hosts}}

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
{{#hosts claude codex}}
- 外部モデル（Antigravity 経由の Gemini など）を呼んだら、呼んだこのホストが呼び出しのたびに
  `node scripts/harness-external-call.mjs record --host <antigravity|codex|claude> ...` で記録する（本文は保存しない）。返った id は
  `node scripts/script-quality-loop.mjs record --external-call <id>` へ渡し、その版は別の文脈で採点する。
{{/hosts}}
{{#hosts antigravity}}
- 外部モデルの呼び出しは、呼び出し元のホストが `node scripts/harness-external-call.mjs record` で記録する（本文は保存しない）。
  Claude Code / Codex に頼まれて答えるときは呼んだ側が記録するので、ここでは記録しない。Antigravity 自身が別のモデルを呼んだら
  `--caller-host antigravity` で記録する。
{{/hosts}}
{{#hosts claude codex}}

## キャンバス

- キャンバスの URL はまず {{inAppBrowser}}で開く。その Browser 機能が利用できない（unavailable）ときだけ
  Chrome／OS のブラウザーへ（MCP `open_buzzassist_canvas` を `openExternalBrowser: true` で呼び直す）。
- {{widgetRule}}`render_buzzassist_canvas_widget` は実験用の代替で、試すよう頼まれたときだけ使う。
- 素材をこのチャットへ添付するときは MCP の `prepare_canvas_attachments` 系を使い、OS の GUI 自動操作を使わない（詳しくは `docs/agent-setup.md`）。
{{/hosts}}
{{#hosts antigravity}}

{{managedSetupBlock}}
{{/hosts}}
