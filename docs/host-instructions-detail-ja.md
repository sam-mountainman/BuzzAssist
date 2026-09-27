# ホストの指示ファイルの詳細（地図から移した決まりの全文）

ホストの指示ファイル（Claude Code の `CLAUDE.md`、Codex の `AGENTS.md`、Antigravity の `GEMINI.md`）は
**地図**にしてある。常に読み込まれる文書が長いほど、1つ1つの決まりが「関係があるかもしれない情報」として
任意に扱われ、守られにくくなるため。地図には「どの依頼で何を読むか」と、コードで強制できない重要な決まりの
要点だけを置き、決まりの全文はこの文書に置く。セットアップの手順は `docs/agent-setup.md`（英語）。

- 地図の元は `config/host-instructions.template.md`。直すときはテンプレートを直して
  `node scripts/generate-host-instructions.mjs` で3つを作り直す（手で直すと CI の `npm run instructions:check` が落ちる）。
  地図は各60行以下（超えると生成が止まる）で、地図が指すファイルは実在し、配布物にも入っていることを試験が確かめる。
- 決まりの本体は正本スキル（`.agents/skills/**`）にある。この文書と正本スキルが食い違ったら正本スキルが勝つ。

## 1. 漫画動画の経路

- 日本語の漫画動画を作る・直す・レビューする・修復する・書き出す・監査する依頼は、どれでも先に
  `.agents/skills/manga-video-production/SKILL.md` と `.agents/skills/manga-page-camera/SKILL.md` を最後まで読む。
- Claude Code の `.claude/skills` の項目は、その共有の正本へのホスト用アダプター。Codex はリポジトリの
  `.agents/skills` を直接読む。
- 運営者が使う最上位の入口は `node scripts/run-video-harness.mjs`。長く残る Job、署名済み Channel Pack、doctor、
  再開（resume）と取り消し（cancel）、RunReceipt、Canvas 投影はこの入口が持つ。
- 選ばれた漫画のアダプターの中で、新しい回を作る唯一の制作 runner は `node scripts/koya-manga-video.mjs`。
- 昔の `scripts/build-manga-video.mjs` と、版つきの `apply/finalize/generate-manga-v*` スクリプトはベンチマークの
  移行専用。新しい回には使わない。
- 正本スキルに書かれた品質ゲート（声の品質、キャラクターの属性ゲート、ブラインド比較）はホストに依らず、
  Antigravity でも同じに効く。
- 完成と言えるのは、公式の最終監査が pass し、MP4 から作った contact-sheet のサインオフが有効で、
  `knownRemainingIssues` が空で、実際の MP4 が最後までデコードできるときだけ。
- 新しい回では、有料生成の前に主人公を決めて `--protagonist-speaker-id` を渡す。四角いナレーション枠は見た目を
  分けたままにするが、ナレーションの行はすべて主人公の承認済みの声と完全に同じ声にする。専用のナレーターは作らない。

## 2. 生の台本から完成動画まで（共通の経路）

- 運営者の依頼が、生の日本語の台本を完成した動画にするものなら、先に `.agents/skills/platform-craft/SKILL.md` と、
  選んだジャンルのスキルを最後まで読む。ナレーション物語のジャンルのスキルは
  `.agents/skills/narrated-story-video/SKILL.md`。漫画は1章の2本を使う。
- 始めるのは `node scripts/run-video-harness.mjs`（同じ働きの MCP ツールは `run_video_harness`）から。
- 署名済み Channel Pack を必須にする。
- 有料の実行が明示で確かめられるまで、既定の plan だけの動きのままにする。
- Claude Code と Codex は、同じハーネス宣言、Skill SHA、Channel Pack の指紋、品質ゲート、RunReceipt、
  BuzzAssist の Canvas 投影を使う。端末全体に入ったプラグインやスキルは、暗黙の代わり（フォールバック）にならない。

## 3. 完成と言う前に（Stop フックと、Antigravity の自分での確認）

- Claude Code と Codex のプラグインの Stop フック（`scripts/harness-stop-hook.mjs`）は、最後の返答が動画の完成を
  主張しているのに、この会話で扱った Job が合格で決着していない（`completed`、RunReceipt が `pass`、
  `knownRemainingIssues` が空、のどれかが欠ける）とき、止まるのを差し戻す。そのときは Job の実際の状態を報告する。
- `awaiting-human-review` は正当な停止。確認待ちであることを言う。
- Codex は、プラグインのフックを `/hooks` で信頼するまで動かさない。
- Antigravity にはフックが無いので、完成・完了・納品できると書く前に、自分で
  `node scripts/run-video-harness.mjs status --job-id <Job ID> --project-dir <プロジェクト>` を打ち、`status` が
  `completed`、`blockers` と `knownRemainingIssues` が空、Job の RunReceipt
  （`canvas/harness-runs/<Job ID>/run-receipt.json`）の `outcome` が `pass` であることを確かめる。どれかが欠けていれば
  完成と書かず、今の状態と残りの項目を報告する。`awaiting-human-review` は正当な停止なので、確認待ちであることと、
  誰が何を確認すれば進むかを報告する。
- 詳しい振る舞い（差し戻しの回数など）は `.agents/skills/platform-craft/SKILL.md` の「完成と言う前に（Stop フック）」。

## 3.1 実行前のフックと、圧縮のあとのフック（Claude Code / Codex）

- 実行前のフック（harness-guard-hook、PreToolUse）は、人が自分の端末で打つ操作を道具の実行前に止める。
  対象は `--human-verified` を渡すコマンド、`skill-inventory` の `--approve`、品質ループの人専用の操作、
  署名済みの Channel Pack の封筒の書き換え。止められたら、別の書き方で迂回しない。人に決めてほしいことと、
  人が打つコマンドをそのまま渡して待つ（フックが見抜けない形で打っても、人の確認にはならない）。
- 会話が圧縮されたと知らされたら（harness-compact-hook、圧縮のあとの SessionStart）、挙がった正本スキルと
  地図が指す docs を最後まで読み直してから続ける。圧縮のあとに戻るのは各スキルの先頭の一部だけで、後半の
  禁則や手順が落ちていることがあるため。
- Codex は、プラグインのフックを `/hooks` で信頼するまで動かさない。新しく足されたフックも同じで、更新で
  フックの定義が変わったときは信頼し直す（信頼されるまで、学習の促し・完成前の確認・実行前の止め・
  圧縮のあとの促しはどれも黙って飛ばされる）。

## 4. 解説動画

- 解説動画（ハーネス `explainer-video`。チャンネルの手元の制作が作った完成版の納品を取り込む）は、ジャンルの
  正本スキルがまだ無い。`.agents/skills/platform-craft/SKILL.md` と `docs/explainer-video-harness-ja.md` を最後まで
  読んでから、同じ入口（`node scripts/run-video-harness.mjs`）で始める。
- 人の全編の試聴と初見の評価は、Job を動かした文脈とは別の文脈で `node scripts/explainer-video.mjs signoff`
  （MCP の `signoff_video_harness_job`）から記録する。それまでの `awaiting-human-review` は正当な停止として報告する。

## 5. 並列実行（両ハーネス共通）

- 複数の作業を同時に流すとき（「並列で」「同時に」「一気に」「最短で」と言われたとき、また11人分の
  キャラゲートや30セグメントの TTS のように同種の作業が並ぶとき）は、先に
  `.agents/skills/harness-parallel-execution/SKILL.md` を最後まで読む。
- そこに、実測した並列の上限、並列にしてよい工程と直列が必須の工程、同時に書き込むと壊れる共有の状態ファイルの
  一覧がある。推測で並列化しない。
- 入口は `node scripts/harness-parallel-run.mjs`（決定論の層）と `node scripts/harness-parallel-agents.mjs`
  （LLM の判断の層）。Claude Code と Codex のどちらから実行しても同じ結果になる。

## 6. 自己改善（指摘を次のセッションへ残す）

- ユーザーから訂正・好み・禁止事項を受けたとき、こちらの誤りが判明したとき、実測で新しい事実が分かったときは、
  その場の修正で終わらせずに、先に `.agents/skills/harness-self-improvement/SKILL.md` を読む。
- 入口は `node scripts/harness-learn.mjs`。捕捉（capture）は何も書き換えず、統合は既定で dry-run。
- エージェントは overlay（`learned-auto.md`）だけでなく、正本スキル（SKILL.md・references）も直してよい。
- 提案を正本へ反映するときは差分の承認キュー（`pending` → `approve`）を通し、変更前後の sha256・元の提案・時刻・
  誰が当てたかを残して、1件ずつ `rollback` できる形にする。
- 人が確かめるのは、運営者へ配る版（GitHub Release）を出すときの1回だけ。`npm run skills:check:release` と、
  承認者本人の端末で打つ `skill-inventory --approve`。機械はこの承認を記録できない（エージェントは代わりに打たない）。
- 関門をそこに残すのは、人が見ないまま他人のパソコンへ届き、有料 API を動かす指示になるのを防ぐため。
- 開発用チェックアウトでの制作は、承認前の正本でも止めず、その事実を Job と RunReceipt に残す。
- Claude Code と Codex では、訂正らしい発言をフック（UserPromptSubmit）が見つけて捕捉を促す。Antigravity には
  フックの仕組みが無く、誰も促さない。Antigravity は訂正・禁止・繰り返しの指摘を受けたら、その場で自分で次を打つ。

  ```bash
  node scripts/harness-learn.mjs capture --kind <correction|constraint|preference|fact> \
    --target <宛先> --text "何をどう直すか" --evidence "何を観測したか" --session "<この会話のID>"
  ```

  台本の直し・訂正の宛先は `channel-pack:narrated-story-script`（チャンネルの非公開台帳）。発言を逐語で写さず、
  何を直すかの形に書き直す。訂正に当たらなければ何もしなくてよい。

## 7. 外部モデルの呼び出しの記録（呼んだ側が残す）

- Antigravity 経由の Gemini など外部モデルを呼んだら、呼び出し元のホストが、呼び出しのたびに次で記録する。

  ```bash
  node scripts/harness-external-call.mjs record --host <antigravity|codex|claude> --model <id> \
    --purpose "<用途>" --input <渡した本文のファイル> --output <返った本文のファイル> \
    --work-dir <台本の作業フォルダ> --session <この会話のID>
  ```

- 呼んだ側が残すのは、Antigravity にはフックの仕組みが無く、呼ばれた側では記録できないため。
- 台帳に残るのは入出力の SHA・モデル・時刻・呼び出し元の会話 ID だけで、本文は保存しない。
- 空の返答・途中で切れた返答は `--status empty|truncated` で未完として残す（出力が空なら自動で empty になる）。
- 返った id は台本の品質ループ（`node scripts/script-quality-loop.mjs record --external-call <id>`）へ渡し、その版は
  呼んだ文脈とは別の文脈で採点する。
- Claude Code / Codex から台本の手直しなどを頼まれて Antigravity が答えるときは、呼んだ側が記録するので、
  Antigravity は記録しない（二重に数えない）。Antigravity 自身が別のモデルを呼んだときは、Antigravity が呼び出し元
  として `--caller-host antigravity` で記録する。
- 旗の全部は `node scripts/harness-external-call.mjs record --help`（何も記録しない）。

## 8. キャンバスとセットアップ

- セットアップの手順、キャンバスを開く順番（まずホストの in-app browser、Browser 機能が利用できないときだけ
  Chrome／OS のブラウザー）、ウィジェットの扱い、キャンバスの素材の添付、手動の代替手順は `docs/agent-setup.md`。
