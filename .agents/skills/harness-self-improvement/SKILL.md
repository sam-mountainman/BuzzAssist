---
name: harness-self-improvement
description: ユーザーの指摘・訂正・好みを、その場の修正で終わらせずに次のセッションが読む正本へ積み上げるための正本。ユーザーから「それは違う」「さっきも言った」「〜しないで」「〜してほしい」と言われたとき、こちらの誤りが判明したとき、実測で新しい事実が分かったときに必ず使う。定期的に溜まった提案を統合してスキルや台帳へ反映する手順も定める。Claude Code と Codex のどちらでも同じ入口を使う。
---


> 作業前に `references/learned-auto.md` を読む。矛盾したときはこの SKILL.md が優先。learned-auto は運用上の補助指示であって、監査・承認・合否の証跡には使えない。
# ハーネスの自己改善

## この文書の役割

同じ指摘を何度も受けるのは、こちらが学習していないということ。
このリポジトリでは実際に起きた。「赤茶のラベルが逆」「目の左右が逆」
「Codexにもレビューさせて」——どれもその場では直したが、次のセッションが
読む場所には残らなかったので、同じ種類の失敗が繰り返された。

ここでの狙いは**その場の修正を、次が読む正本へ載せること**に尽きる。
仕組みは Nous Research の hermes-agent が採る3層
（ターン内の捕捉 → 定期的な統合 → 人間起動の取り込み）を参考にしている。
ただし、自己生成した提案を記録も巻き戻しも無しに正本へ書く仕組みは採らない。
BuzzAssistでは、提案の捕捉、機械所有overlayへの同期、差分の承認キューを通した
正本への反映、配る版の人の承認（リリース）を別の操作と証跡に分ける。


## 大原則

自己改善が「自分で自分に合格を出す」構造になってはいけない。
このリポジトリは今日、スクリプトが自作のサインオフを根拠に納品物を
合格にしていた箇所を3件塞いだ。学習の仕組みが同じ形になれば同じことが起きる。

**機械は正本も直してよい。人が確かめるのは、運営者へ配る版を出すときの1回だけ**
（運営者の決定 2026-09-26）。以前は正本スキルへの反映のたびに人の確認を要求していたが、
人の手番が溜まって学習が正本へ届かなかった。そこで関門を、人が見ないまま他人のパソコンへ
届き、有料 API を動かす指示になる地点——配る版（GitHub Release）——の1か所へ寄せた。

- **捕捉は何も書き換えない**。提案を追記するだけ
- **sync が自動で書き換えるのは overlay ファイルだけ**。各スキルの
  `references/learned-auto.md` を `sync` が丸ごと書き直す。hermes の curator が
  「agent作成スキルだけ触り、bundled や hub-installed には手を出さない」としているのと
  同じ境界を、ここでは**ファイル単位の所有**が担っている
- **正本スキル（SKILL.md・references）はエージェントも直してよい**。提案を反映するときは
  差分の承認キュー（`pending` → `approve`、後述）を通し、変更前後の sha256・元の提案・時刻・
  誰が当てたか（エージェントか人か）を残して、1件ずつ `rollback` できる形にする。
  提案に結び付かない改訂は skill-creator の手順で直接直してよい（記録は変更履歴と在庫の SHA）
- **配る版は人がリリースで1回確かめる**。`npm run skills:check:release`（release.yml の関門）は、
  在庫の承認が今の版と内容 SHA に付いていなければ止まる。承認は承認者本人の端末の
  `node scripts/skill-inventory.mjs --approve <id> --reviewer <名前> --human-verified` だけが記録でき、
  **エージェントは代わりに打たない**
- **開発用チェックアウトの制作は、承認前の正本でも止めない**。代わりに Job と RunReceipt の
  `skillApproval` に「承認前の正本スキルで作った」ことと、そのスキルの id・版・sha256 が残る
  （本体 `lib/videoHarnessProductionProfile.mjs`）。配布された写し（運営者の端末のプラグイン）は
  今までどおり、承認済みの版でなければ止まる
- **overlay は証跡ではない**。運用上の補助指示であって、監査・承認・合否の
  根拠には使えない。だから台帳（`ledger:koya`）とゲート基準
  （`doc:mike-audio-gates`）は `review-only` にして自動反映しない——
  そこは承認の記録そのものなので、機械が書き足すと何を人が決めたのかが
  分からなくなる。同じ理由で、Channel Pack の台帳（review-only）への `approve`・`rollback` は
  今までどおり人の確認でだけ通る（台帳はリリースも通らない）
- **機械区画から人の規則へ上げる（promote）には reviewer 名と正本内の実在証拠が要る**。
  「機械が書いた」と「人が確認した」の差がこの一手で、この差が無くなると
  自己改善が自己認証に変わる（台帳R196と同じ理由）。

  **この規則は一度、書いた本人に破られている。** reviewer をただの引数で
  受けていたので、エージェントがユーザーの名前を打てば通った。実際そうなり、
  台帳に残る19件は全部エージェントが打ったものだった。次の修正は TTY の
  有無で分けたが、それも証明にならない——`script -q /dev/null node ...` を
  通せば `isTTY` は true になる（実測）。しかも当時は TTY を先に見ていたので
  PTY 経由で `--agent-attested` を付けると「人の確認」として記録された。

  **シェルを持つエージェントが同じ機械にいる以上、人の確認を機械的に
  強制することはできない。** これは実装の不足ではなく、この配置の性質。
  できるのは3つだけで、そこに集中すること:

  1. 既定を拒否にする（黙って人を名乗れる状態を無くす）
  2. 詐称に明示的な一手を要求し、何を名乗ったかを記録に残す
  3. **記録の残らない機械の自己申告を「反映済み」として数えない**

  3が実効の中心。`isActuallyApplied` がここを見ていなかったので、機械の
  自己申告が人の確認と同じ効力で applied になり、しかも未反映一覧から
  消えるので**後から人が昇格しようとすると「既に反映済み」で拒まれた**。
  機械の自己申告が、人の確認を締め出す向きに働いていた。

  印と、反映済みに数えるか:

  | 印 | 何を意味するか | 反映済みに数えるか |
  |---|---|---|
  | `human-verified` | 対話端末＋ `--human-verified` の二手 | ○ |
  | `agent-self-attested`（差分の承認キューの `approve`、`actor: agent`） | エージェントが差分を当てた。変更前後の sha256・元の提案・時刻が残り、1件ずつ戻せる | ○（配る版は人がリリースで確かめる） |
  | `agent-self-attested`（`apply`・`promote`・`curate --archive`） | 機械が機械として記録しただけ。変更前の版も巻き戻しも残らない | × |
  | `cli-interactive-claimed` | 対話端末だった、という事実だけ | × |
  | `unverified-agent-typed` | ガード導入前の記録 | × |

  ここで作っているのは関門ではなく、**読める証跡**。本当の関門は、配る版を出すときに
  人が差分を読んで承認するところ（上の skills:check:release と承認者の端末の
  skill-inventory --approve）と、この台帳が変更履歴で追跡されていて commit を人が読むところに
  ある。新しいゲートを足す前に、そのゲートを通さずに同じ効果を得る道が残っていないかを
  先に探すこと。正本の直接編集と `applied.jsonl` への直接追記は物理的には今も残っている
  （開発側のレビュー台帳に cx-a3 として記録）が、どちらもリリースの承認を越えては届かない
- **消さない**。置き換えたものは記録に残す
- **1件1スキルにしない**。個別事象を並べた文書は読まれなくなる

## いつ捕捉するか

次のいずれかが起きたら、**その場で** `capture` する。後回しにすると忘れる。

| 種別 | 何を捕まえるか | 例 |
|---|---|---|
| `correction` | こちらの誤りをユーザーが正した | 「min(16,CPU-2)はWorkflow専用の式」 |
| `preference` | 作り方・進め方の好み | 「スキルは skill-creator を通す」「中身は日本語」 |
| `constraint` | やってはいけないこと | 「実在ブランドロゴは使わない」 |
| `fact` | 実測で分かったこと | 「ffmpegは単体でCPU486%」 |

捕捉しないもの: そのセッション限りの段取り、コードを読めば分かること、
既に正本に書いてあること。

```bash
node scripts/harness-learn.mjs capture \
  --kind correction \
  --target platform:harness-parallel-execution \
  --text "何をどう改めるべきかが分かる形で" \
  --evidence "ファイル:行、実測値、ユーザーの発言など" \
  --session "この会話・実行を一意に表すID"
```

`--session` は必須。同じproposalを同じsessionから何度捕捉しても、独立した
再発回数へ水増ししないために使う。`--target` は3層の正本に限る。

- `platform:` — 課金、ジョブ、証跡、Canvas、並列制御など運営者非依存の共通基盤
- `genre:` — 漫画動画、ナレーション物語などジャンル共通の制作規則
- `channel-pack:` — 声、画風、番組固有の禁止事項など非公開チャンネル台帳

使える正確な宛先は `node scripts/harness-learn.mjs --help` に出る。廃止した
`skill:`、`ledger:`、`doc:`という旧名を新しい捕捉へ使わない。

**同じ指摘が2回目以降なら警告が出る。** それは「まだ直っていない」という
強い信号なので、その場で正本へ反映するところまでやる。

**文脈に「[BuzzAssist 自己改善] …」が足されたら**、それは BuzzAssist プラグインの
フック（Claude Code と Codex の UserPromptSubmit）が、直前の発言に訂正・禁止・
繰り返しらしい言い回しを見つけたという合図にすぎない。発言が本当に訂正・禁止・
繰り返しに当たるかを自分で判断し、当たればその場で `capture` する。当たらなければ
何もしない。フックは捕捉も発言本文の保存もせず、提案ゼロは正常。案内を
「毎回何か capture せよ」と読まない——書かせる圧をかけると、効かない教訓が溜まる。

**回数で起動する振り返り。** 同じフックが会話ごとにユーザーの発言の回数だけを数え（本文も会話 ID
そのものも残さない）、既定で10回ごとに「残すものがあれば capture する」と促す。促しに出た
`--session` の値で capture すると数え直しになる。促しは数えただけで、何かが起きた合図ではない。
間隔は `BUZZASSIST_LEARNING_REFLECT_EVERY`（0 で数えるのも促すのも止まる）。子エージェントでは数えない
（本体 `lib/harnessLearningReflection.mjs`）。

**Codex ではフックを信頼してから動く。** Codex は `/hooks` で信頼したフックだけを動かし、信頼を
`~/.codex/config.toml` の `[hooks.state."buzzassist@buzzassist:hooks/codex-hooks.json:user_prompt_submit:0:0"]`
のような表と `trusted_hash` に残す。表の無いフックは黙って飛ばされる。BuzzAssist を入れたら、端末の
`codex` で `/hooks` を開き、UserPromptSubmit フックと Stop フックを確かめて信頼する（デスクトップ版の
`/hooks` は信頼を書き込まない報告がある）。更新でフックの定義が変わったら信頼し直す。確認は
`node scripts/harness-doctor.mjs` の advisory 検査 `learning-hook-trust`。フックの記録
（学習の置き場の `hook-events.jsonl`）には host が残るので、codex の行が無ければ未信頼を疑う。

**子エージェントは学習を書かない。** `harness-parallel-agents` が起動する子には
`BUZZASSIST_LEARNING_WRITE_FORBIDDEN` が渡り、capture / sync / promote / apply /
`curate --archive` は拒否される。子は捕捉したい内容を結果本文で親へ返し、親が
確かめてから capture する。並列の子それぞれが同じ指摘を書くと再発回数が水増しされ、
確かめていない推測が台帳に入るため。

廃止した旧名（`skill:<名前>`）で記録済みの提案は、対応表
`lib/harnessLearningTargets.mjs`（harness-learn・feedback bundle・Canvas collector が
同じ1つを読む）で新しい宛先へ解決される。status は新しい宛先で数え、「旧名 … で記録」と
出す。台帳の行は書き換えない（提案 ID が本文と宛先から作られるので、書き換えると
過去の反映記録と結び付かなくなる）。

## 学習の置き場

置き場は `lib/harnessLearningState.mjs` の1か所で決まる。入口ごとに別の置き場を書かない。

- **開発用チェックアウト**（`.git` と `.claude/skills` と `.agents/skills` がある）: 従来どおり
  リポジトリの `docs/learning`（台帳は git で追跡され、commit を人が読む）
- **運営者の端末**: Claude Code と Codex のどの版の写しから動かしても `~/.buzzassist/learning/`
  （`BUZZASSIST_LEARNING_DIR` で上書き可）。**写しの中に台帳を書かない**（setup・自動更新・ホストの版上げで消える）
- **チャンネル**: 運営者の配置表の `channels` のチャンネルで作った Job（Job の `metadata.channel` に残る）の学習は、
  そのチャンネルの保存先へ積む（`channelLearning` の宣言か、無ければ `~/.buzzassist/learning/channels/<id>`）。
  同じハーネスのチャンネルが2つあっても学習が混ざらないようにするため。見る・直すときは `harness-learn` に
  `--channel <id>` を付ける。付けない一覧にはチャンネルの中身は出ない（末尾に件数だけ）

置き場の中の配置、古い写しからの初回の取り込み、sync の届け方、チャンネルの保存先の決め方・重なりの拒否・
理由コードは `references/learning-store-ja.md` にある。置き場や保存先を決めるコード・配置表を直すとき、
学習が見つからないときに読む。

## 書き込み前の検査

capture・sync・promote・apply の前に、本文を検査する。見るのは、プロンプト注入らしい
言い回し、隠し HTML コメント、不可視 Unicode、資格情報らしい文字列（sk-、Bearer、JWT、
PEM など）、端末を特定できる絶対パス。検査語彙（HMAC digest）の照合とは別の層で、
語彙に無い形の混入を止める。

- 当たった提案は捨てずに `blocked` として台帳に残る。資格情報とパスは置き換えて記録し、
  元の文字列は指紋だけ残す
- blocked は overlay に載らず、review にも出ず、promote・apply もできない
- status の ⛔ 欄に理由だけが出る（本文は出ない）。理由を見て、何を直すかの形に書き直して
  capture し直す。元の行は台帳の規則どおり書き換えない

## 自動反映（sync）

捕捉したものは、区切りで `sync` を打てば自動で正本へ載る。

```bash
node scripts/harness-learn.mjs sync
```

書き換わるのは `references/learned-auto.md` だけで、`SKILL.md` は
1文字も変わらない。`review-only` の宛先（台帳・ゲート基準）は
自動反映されず、保留として理由つきで報告される。

sync は Job の決着時と setup のたびにも、同じ本体で自動で走る。語彙を照合できない端末では
書かず、理由だけを学習の置き場の `auto-sync.jsonl` に残して Job も setup も止めない。自動の sync に
`--allow-missing-vocabulary` の抜け道は無い。`BUZZASSIST_LEARNING_AUTO_SYNC=0` で止まり、
子エージェントでは走らない。

**sync は検査語彙を照合できなければ止まる（fail-closed）。** overlay へ書く前に、Channel Pack 由来の語と
リポジトリ側にだけ置く検査語彙（`sensitive-vocabulary.digest.json`、配布物には入れない）で私的語を除去し、
一覧が壊れている・**無い**・**鍵が無い**のどれでも止まる（無ければ通すと、私的語の残存を検出できないのに
「除去済み」と区別が付かない）。検査語彙は**鍵つき**（HMAC）で、鍵はリポジトリの外にだけ置き、出力・
コミットしない。共有台帳（公開される）への `capture` も、同じ語彙に一致する語——人の名前、顧客の識別子、
端末のパス——を含めば拒否するので、発言をそのまま引用せず、何を直すべきかの形に書き直す。

語彙の作り方・鍵の置き場・開発用の `--allow-missing-vocabulary`（CI・配布・本番端末では使わない）は
`references/sensitive-vocabulary-ja.md` にある。sync が語彙で止まったとき、語彙を作り直すときに読む。

宛先と方式は `docs/learning/targets.json` が持つ。overlay は
**次のセッションが読む**ので、これだけで学習は成立する。
`promote` は「機械が書いた箇条書き」を「人が確認した規則」へ格上げする
ときだけ使う——常に必要なわけではない。

## いつ統合するか

区切りのついたとき（大きな作業の完了時、セッションの終わり）に見る。

```bash
node scripts/harness-learn.mjs status   # 未反映を繰り返し回数順に
node scripts/harness-learn.mjs review   # 統合案（dry-run）
```

`review` が「まとめて1つの節に書く」と言ったら、**提案を1件ずつ追記しない**。
同じ宛先に2件以上溜まっているのは、個別の注記ではなくクラスレベルの規則が
1つ足りていないということ。hermes の curator も同じことを言っている——
1セッションの個別事象を1スキルにする蓄積は、機能ではなく失敗である。

書き方の順序:

1. 対象の正本を読み、**既存の節へ吸収できないか先に見る**
2. 吸収できなければ、複数の提案をまとめてクラスレベルの1節を書く
3. スキルを書き換えるときは **skill-creator を使う**（この規則自体が
   ユーザーの指示から来ている）
4. 書き換え後の本文（エージェントは正本の写し、人は正本そのもの）へ
   `<!-- buzzassist-learning:<提案ID> -->` と、12文字以上の規則本文を
   書く。提案IDだけ、短い要約だけ、overlay内の文言だけでは反映証跡にならない
5. エージェントが反映するなら、書き換え後の全文を写しに作って、下の差分の承認キュー
   （`pending` → `approve`）で当てる。変更前後の sha256・元の提案・時刻・当てた者が残り、
   1件ずつ `rollback` できる。これが反映済みに数えられる機械の経路
6. 人が skill-creator で正本を直接直したなら、その人の端末から記録する:

```bash
node scripts/harness-learn.mjs apply --id <提案ID> \
  --reviewer <名前> --note "正本に完全一致する12文字以上の規則本文" \
  --human-verified
```

エージェントが `apply --agent-attested` で記録すると、記録は残るが未反映として扱われる——
直接の編集には変更前の版も巻き戻しも残らないため。エージェントは apply ではなくキューを使う。
TTYは人間性の証明にならないため、`--reviewer`だけ、または対話端末だったという事実だけでは
人の確認に数えない。

## 正本を書き換えるとき（差分の承認キュー）

正本（SKILL.md・台帳）の書き換え案は、差分と「案を作るときに読んだ正本の sha256（base）」を
つけてキューに置き、`approve` で当てる（本体 `lib/harnessLearningChanges.mjs`）。approve の記録が
apply を兼ねるので、別に apply は打たない。

```bash
node scripts/harness-learn.mjs pending --id <提案ID> --proposed <書き換え後の全文> --note "規則本文" --base <読んだ版の sha256>
node scripts/harness-learn.mjs pending                       # 一覧（base が変わったものは base-changed と出る）
node scripts/harness-learn.mjs pending --show <変更ID> [--out <写しの SKILL.md>]
node scripts/harness-learn.mjs approve --change <変更ID> [--require-evals] [--evals-dir <dir>]       # エージェントが当てる
node scripts/harness-learn.mjs approve --change <変更ID> --reviewer <名前> --human-verified      # 人が自分の端末で当てる
node scripts/harness-learn.mjs reject --change <変更ID> --reason "..."
node scripts/harness-learn.mjs rollback --change <変更ID> --reason "..."                          # 人なら --reviewer <名前> --human-verified を足す
```

- 案には提案ごとの印（`<!-- buzzassist-learning:<提案ID> -->`）と、`--note` と完全一致の規則本文が要る
- `approve`・`rollback`・`reject` は、エージェントも打てる。`--reviewer` を省けば記録は
  「エージェントが当てた」（`actor: agent`、reviewer は `agent`）。人が承認者の端末から
  `--reviewer <名前> --human-verified` で打てば「人が当てた」（`actor: human`）として分けて残る。
  **名前だけ（`--human-verified` なし）と、非対話の端末からの `--human-verified` は拒否する**——
  エージェントがユーザーの名前を打って人を名乗らない
- Channel Pack の台帳（review-only）への `approve`・`rollback` は、今までどおり人の確認でだけ通る。
  エージェントは `pending` に置くまで
- `base-changed` が出たら、正本を読み直して案を作り直す。正本を base の版へ手で戻して通さない
- `rollback-conflict`（正本が、その変更を当てた後にさらに変わっている）が出たら、後の変更を先に戻す
- 正本スキルへの approve は、評価の関門（skill-evals の記録で、変更後の版の contentSha256 に両ホストの
  結果があり、変更前の版より悪化していないか）を警告として出す。`--require-evals` のときだけ止まる。
  警告を読んでから当てる（`--out` で書いた写しで evals を流せる）
- 正本スキルを approve したら（skill-creator で直接直したときも）、`.agents/skills/inventory.manifest.json`
  の contentSha256 を今の内容へ更新する。版は skill-creator の決まりに従う（まだ配っていない版が
  すでに上がっていれば、同じ版のまま SHA だけ）。開発用チェックアウトの制作は止まらず、RunReceipt に
  承認前の正本で作ったと残る。運営者へ配る版を出す前に、人が承認者の端末で
  `skill-inventory --approve` を打つ（`npm run skills:check:release` が確かめる）

## 自動の捕捉経路

エージェントが覚えていなくても走る捕捉がある。どれも**提案を積むまで**で、
正本への自動昇格ではない。Job の決着時と品質ループの捕捉は、子エージェントと
`BUZZASSIST_LEARNING_AUTO_CAPTURE=0` では積まず、捕捉に失敗しても元の工程（Job・ループ）の結果は変えない。

### 品質ループの不合格（途中の成果物・台本・企画ブリーフ）

- 途中の成果物の品質ループ（`scripts/asset-quality-loop.mjs`、本体 `lib/assetQualityLearning.mjs`）:
  合格しなかった回と人の確認の否を、工程・失敗指紋・評価項目 id・機械ゲート id だけで、そのハーネスの
  Channel Pack 宛の非公開台帳へ積む。件数は evidence 側に置き、対象の id（人物名になりうる）・
  所見・パスは入れない。同じ版・同じ指紋は二重に積まない
- 台本の品質ループ（`scripts/script-quality-loop.mjs record`、本体 `lib/scriptQualityLearning.mjs`）と企画ブリーフの
  品質ループ（本体 `lib/strategyBriefLearning.mjs`）: 合格しなかった回の、下限割れの評価項目 id・落ちた機械ゲート id・
  止まった理由のコードを非公開台帳へ積む
- どのループも、台帳のチャンネルが分かればそのチャンネルの保存先へ積む（本体 `lib/learningChannelResolver.mjs`。
  Job の `metadata.channel` を優先し、次にループの作業フォルダ、企画ブリーフの `channel.id` で決める）。手がかりが
  別々のチャンネルを指す・台帳を読めない・保存先を決められないときは、推測で寄せずに積まない。どれにも当たらなければ
  従来の Channel Pack の台帳へ積む。決め方と理由コードは `references/learning-store-ja.md`

### Job の決着時（RunReceipt から）

共通入口（`run-video-harness` の start / resume、MCP の同じ service）を通った Job が
completed / failed / awaiting-human-review で決着すると、その Receipt から学習候補を
取り出して提案台帳へ積む。

- 本文に入るのは、不合格・skip のゲート id、issue のコード、再試行・再開の回数などの
  件数だけ。台本・プロンプト・生のエラー全文・パス・人名は入れない
- 各行は `createdBy=auto-receipt`、Receipt の digest、捕捉時の skill SHA を持つ。
  同じ Receipt からは二重に積まない。全部通った Run からは何も積まない
- 宛先は Channel Pack 宛の非公開台帳。genre / platform へ一般化するときは、人が
  target を明示して別の提案として capture する
- Job の `metadata.channel` があれば、そのチャンネルの保存先へ積む。保存先を決められなければ
  `channel-learning-store-unresolved` で積まない（チャンネルの無い保存先へ落とすと、別のチャンネルと混ざる）
- 捕捉に失敗しても Job の結果は変えない。`BUZZASSIST_LEARNING_AUTO_CAPTURE=0` で止まる

### Canvas のフィードバック

Canvas Run上の採択・却下・改善コメントは、次の投影より前に
`collect_video_harness_feedback`（または同じcollectorを使う共通Job API）で読む。
これは**提案の捕捉まで**を自動化する入口で、正本への自動昇格ではない。

- 元のRun ID、Run fingerprint、対象elementのdigest、projection hash、feedback revisionを
  evidenceへ残し、同じ要素・同じrevisionの再読込をexactly-onceで処理する
- コメントからcredential、絶対path、台本本文、Channel Pack本文を除外する
- 既定のchannel-pack宛は、その運営者専用の非公開台帳が共有リポジトリから物理的に
  分離されている場合だけ許す。共有pathやsymlink経由の衝突はfail-closedにする。
  `metadata.channel` の Job では、channel-pack 宛の提案はそのチャンネルの保存先へ積む
- genre/platformへ一般化する場合は、利用者がtargetとgeneralizeを明示する。推測で
  チャンネル固有情報を共有層へ持ち上げない
- collectorが途中で落ちても、proposal追記とpending/captured journalを照合して
  同じJSONL行を重複追記しない

Canvasのコメントが書かれたこと自体は、映像品質ゲートのpassや人間signoffを意味しない。
制作の知覚承認と、改善提案の正本昇格は別々の証跡として扱う。

## 運営者端末から管理側へ返す

運営者の端末で溜まった学習は、署名つきの bundle にして提供元へ返す。運ぶのはゲートの判定の件数・
ハーネスの版・ホスト・既知の提案 ID と回数で、台本・Channel Pack の本文・provider の応答・credential は
入れない。受け取る側も検証済みの bundle を隔離してから、owner の承認後に既知の提案の観測回数へ
加えるだけで、**正本は一切書き換えない**。

- Job の決着時の自動の bundle（v3）は、運営者が同意したとき（`harness-feedback.mjs consent --enable`、
  または対話の setup）だけ作られ、送り先が無いあいだは貯めるだけ。受領証が提供元の鍵で署名されて
  いなければ届いたと記録しない
- **エージェントは運営者の代わりに `consent --enable` を打たない。** 同意は運営者本人の決定であり、
  `--human-verified` と同じく機械では証明できない

bundle の中身・同意の範囲・送り先の設定・手動の bundle（v2）と再送・管理側の受け取り（ingest）の
手順は `references/feedback-return-ja.md` にある。feedback bundle・送信・受け取りを触るときに読む。

このため「自動学習」は、捕捉・署名upload・重複排除・集計までを自動化する意味で
あり、AIが自分の変更を自分で承認する意味ではない。正本への反映は開発用チェックアウトで
`skill-creator` と差分の承認キューを通し（エージェントも当てられる）、運営者へ届く版は
人がリリースで承認する。

## 使われない教訓の扱い（curate）

overlay は毎回まるごと読まれるので、hermes の curator のような「使われた回数」は
意味を持たない。代わりに「最後に再発・再捕捉された日」と「関連するゲートが直近の
RunReceipt に不合格・skip で出たか」を見て、長く再発していない項目を**候補として
列挙するだけ**にする（既定 dry-run）。

```bash
node scripts/harness-learn.mjs curate                    # 候補の一覧（何も書き換えない）
node scripts/harness-learn.mjs curate --archive --id <id> \
  --reviewer <名前> --reason "何を見て判断したか" --human-verified
```

退避は候補に出た項目だけ、人の確認つきでだけ行い、`references/learned-archive.md` へ
移すだけで削除しない。退避後に再発すれば overlay へ戻る。`learned-archive.md` は
作業前に読む対象ではない。再発しないのは、その規則が効いているからかもしれず、
機械には見分けられない——だから機械の判断で退避しない。

## 改善したかを測る（RunReceipt）

提案を反映しても、**良くなったかどうかは別に測らないと分からない**。
「気づいたこと」を書き足すだけの自己改善は、書き足した量が増えるだけで、
落ちるところは落ち続ける。狙い先は、**何度も落ちている場所**であって、
1セッションで目についたことではない。

本番の実行は `RunReceipt` を残す。1件の記録に載るのは:

- ハーネスの指紋——platform craft / genre harness / channel pack を**別々に**取る。
  混ぜた1つのハッシュだと、どの層を直して結果が変わったのか読めない
- overlay（`references/learned-auto.md`）の指紋も別枠。
  「スキル本体は変えていないのに指紋が動いた」を読めるようにするため
- 宣言された保証ごとの判定と、その裏づけになった実測監査の指紋
- 結果と `knownRemainingIssues`
- 正本スキルの承認の状態（`skillApproval`。承認前の正本で作ったか、そのスキルの id・版・sha256）。
  合否は変えないが、正本を直した効果を測るときに「承認前の版で出た結果」を分けて読める

記録が守っている規則は1つだけ——**走っていないゲートを「通った」と書けない**。

- 宣言されたゲートに判定が1件でも欠けていれば `finalize` が失敗する
- 判定には証拠の指紋が要る。判定だけ受け取ると、何も見ずに pass と書ける
- 理由のない `skip` は受け取らない。理由のない skip は要件充足にされる
- 落ちたゲートや `knownRemainingIssues` があれば、pass と申告されても pass に
  しない。申告を信じた瞬間、記録は自己申告書になる

集計はこう見る:

```bash
node scripts/harness-receipts.mjs rollup            # 版ごとのゲート失敗率
node scripts/harness-receipts.mjs rollup --harness koya-manga-video
node scripts/harness-receipts.mjs rollup --by host   # ハーネス × ホスト × 版の pass 率・所要時間と、片方のホストだけ低い組の警告
node scripts/harness-receipts.mjs export --out <path>   # 返せる形だけ
```

`rollup` は学習の置き場の索引（`receipts/index.jsonl`）が指す RunReceipt を読み、`--project-dir <dir>` を
付けると `<dir>/canvas/harness-runs/*/run-receipt.json` も読み取り専用で読む。`--by host` では、ホストの
記録が無い（unrecorded）・判定できない（unknown）・作ったホストと再開したホストが混ざった組は比べない。

`worstGates` の先頭が、次に直すべき場所。**ここを見ずに書いた提案は、
思いつきと区別がつかない**。`capture` の evidence には、可能なら
該当ゲートの失敗率を添える。

版をまたいで混ぜないことに意味がある。混ぜると、直した後も古い失敗が率に
残って、改善したことも悪化したことも見えなくなる。

`export` が出すのはチャンネル固有のものを一切含まない形（ハーネスの指紋、
ゲートごとの判定、結果だけ）。運営者の手元で回った結果をこちら側へ返す道は、
**返せるものだけで作る**。

## 反映先の選び方

| 何を学んだか | 宛先 |
|---|---|
| 漫画動画の制作手順・品質基準 | `genre:manga-video-production` |
| ナレーション物語の制作手順・品質基準 | `genre:narrated-story-video` |
| カメラ移動の文法 | `genre:manga-page-camera` |
| 並列実行の上限・粒度 | `platform:harness-parallel-execution` |
| 自己改善の捕捉・昇格規則 | `platform:harness-self-improvement` |
| 課金APIの再送規則・秘密の扱い | `platform:platform-craft`（正本は `lib/paidApiRetry.mjs`） |
| どの入口を使わせるか | `platform:platform-craft`（正本は `lib/harnessRouting.mjs`） |
| 証跡・指紋・記録の不変条件 | `platform:platform-craft`（正本は `lib/harnessRunReceipt.mjs`） |
| 漫画チャンネル固有の要求・禁止事項 | そのChannel Pack専用target（例: `channel-pack:koya`。非公開台帳） |
| 特定ナレーションチャンネルの声・BGM・番組文法 | そのChannel Pack専用target（例: `channel-pack:narrated-story`） |

分類できないときは推測で共有層へ書かず、`--help`とChannel Packの配置を確認する。
チャンネル固有情報はまず非公開台帳へ置き、一般化するときだけ別proposalとして
genre/platformへ引き上げる。

## やってはいけないこと

- 捕捉を後回しにする（セッションが終われば失われる）
- `review` の出力を、正本へそのまま貼り付ける
- 提案を1件ずつ別々の節として追記する
- overlay（`references/learned-auto.md`）を手で編集する（次の sync で消える）
- overlay を監査や承認の根拠として引く（そこは証跡ではない）
- `promote` を reviewer 名なしで通そうとする
- エージェントがユーザー名を入力して `--human-verified` を代行する
- Canvas feedbackを品質signoffや正本の自動承認として扱う
- Channel Pack固有のコメントを共有learning台帳へ書く
- 「ユーザーが言ったから」だけを根拠に書く。**何を観測したか**を evidence に残す
- `rollup` を見ずに「よく落ちる」と書く。落ちている場所は測れる
- blocked の提案本文を、検査を通さずに正本へ貼る
- `curate` の候補を、人の確認なしに機械の判断で退避する
- フックの案内を「毎回何か capture せよ」と読む
- 提案を正本へ反映するのに、キューを通さず直接書き換えて `apply --agent-attested` で済ませる
  （変更前の版も巻き戻しも残らない。`pending` → `approve` を使う）
- `base-changed` を、正本を base の版へ手で戻して通す
- エージェントが approve・rollback を「人が当てた」ように見せる（名前を打つ・PTY 経由で `--human-verified`）
- Channel Pack の台帳（review-only）を、エージェントの approve で書き換えようとする
- 評価の関門の警告を読まずに当てる
- エージェントが `skill-inventory --approve` を打つ（配る版の承認は承認者本人の端末だけ）
- 開発用チェックアウトで承認前の正本のまま作った成果物を、Receipt の `skillApproval` を伏せて報告する
- 運営者の代わりに `harness-feedback.mjs consent --enable` を打つ
- 学習の台帳をホストの写し（plugin cache・`~/plugins/buzzassist/plugin`）の中へ書く
- 共有層（genre: / platform:）の宛先に `--channel` を付けて捕捉する（拒否される。一般化はチャンネルを外して
  別の提案にする）。チャンネルの学習を `--channel` なしで探して「無い」と判断する
