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
ただし、自己生成した提案をそのまま正本へ書く仕組みは採らない。BuzzAssistでは
提案の捕捉、機械所有overlayへの同期、人が確認した正本への昇格を別の操作と証跡に
分ける。


## 大原則

自己改善が「自分で自分に合格を出す」構造になってはいけない。
このリポジトリは今日、スクリプトが自作のサインオフを根拠に納品物を
合格にしていた箇所を3件塞いだ。学習の仕組みが同じ形になれば同じことが起きる。

- **捕捉は何も書き換えない**。提案を追記するだけ
- **自動で書き換えてよいのは overlay ファイルだけ**。各スキルの
  `references/learned-auto.md` を `sync` が丸ごと書き直す。人が書く
  `SKILL.md` には触らない。hermes の curator が「agent作成スキルだけ触り、
  bundled や hub-installed には手を出さない」としているのと同じ境界を、
  ここでは**ファイル単位の所有**が担っている
- **overlay は証跡ではない**。運用上の補助指示であって、監査・承認・合否の
  根拠には使えない。だから台帳（`ledger:koya`）とゲート基準
  （`doc:mike-audio-gates`）は `review-only` にして自動反映しない——
  そこは承認の記録そのものなので、機械が書き足すと何を人が決めたのかが
  分からなくなる
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
  3. **人の確認が無いものを「反映済み」として数えない**

  3が実効の中心。`isActuallyApplied` がここを見ていなかったので、機械の
  自己申告が人の確認と同じ効力で applied になり、しかも未反映一覧から
  消えるので**後から人が昇格しようとすると「既に反映済み」で拒まれた**。
  機械の自己申告が、人の確認を締め出す向きに働いていた。

  印は4段階で、`human-verified` だけが反映済みとして数えられる:

  | 印 | 何を意味するか | 反映済みに数えるか |
  |---|---|---|
  | `human-verified` | 対話端末＋ `--human-verified` の二手 | ○ |
  | `cli-interactive-claimed` | 対話端末だった、という事実だけ | × |
  | `agent-self-attested` | 機械が機械として記録した | × |
  | `unverified-agent-typed` | ガード導入前の記録 | × |

  ここで作っているのは関門ではなく、**読める証跡**。本当の関門は、この台帳が
  git で追跡されていて、commit を人が読むところにある。新しいゲートを足す
  前に、そのゲートを通さずに同じ効果を得る道が残っていないかを先に探すこと
  ——`promote`/`apply` は正本を書き換えるのではなく追記するだけなので、
  正本の直接編集と `applied.jsonl` への直接追記はいまも残っている（未対応。開発側のレビュー台帳に cx-a3 として記録）
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

## 自動反映（sync）

捕捉したものは、区切りで `sync` を打てば自動で正本へ載る。

```bash
node scripts/harness-learn.mjs sync
```

書き換わるのは `references/learned-auto.md` だけで、`SKILL.md` は
1文字も変わらない。`review-only` の宛先（台帳・ゲート基準）は
自動反映されず、保留として理由つきで報告される。

**sync は語彙 digest が無ければ止まる（fail-closed）。** overlay へ書く前に、
Channel Pack 由来の語と `docs/learning/sensitive-vocabulary.digest.json` の salted digest
語彙で私的語を除去する。digest が壊れていても、**無くても**同じく throw する——以前は
「壊れていれば止まる、無ければ通る」で、語彙無しの overlay は私的語の残存を検出できない
のに出力は「除去済み」と区別が付かなかった（欠落を許可として扱う型）。

```bash
# 語彙を作る（平文一覧は git 追跡外、digest だけコミット）
node scripts/audit-package-tarball.mjs build-vocabulary \
  --terms-file docs/learning/sensitive-vocabulary.local.txt \
  --output docs/learning/sensitive-vocabulary.digest.json

# 開発用途に限り、語彙無しで生成する。overlay ヘッダに「語彙照合なし」が刻まれる
node scripts/harness-learn.mjs sync --allow-missing-vocabulary
```

`--allow-missing-vocabulary` で作った overlay は、ヘッダの印で読む側・監査側が見分けられる。
CI・配布・本番端末では使わず、印の付いた overlay をそのまま release へ載せない。

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
4. 正本へ `<!-- buzzassist-learning:<提案ID> -->` と、12文字以上の規則本文を
   書く。提案IDだけ、短い要約だけ、overlay内の文言だけでは反映証跡にならない
5. 人が実際に確認した端末から記録する:

```bash
node scripts/harness-learn.mjs apply --id <提案ID> \
  --reviewer <名前> --note "正本に完全一致する12文字以上の規則本文" \
  --human-verified
```

非対話のエージェントが変更内容を記録するときは `--agent-attested` を使う。その
記録は残るが、`human-verified`ではなく未反映として扱われる。TTYは人間性の証明に
ならないため、`--reviewer`だけ、または対話端末だったという事実だけでは人の承認に
数えない。誰も確認していない自動反映は証跡にならないので、この仕組みは意図的に
そこで止まる。

## Canvasからの自動捕捉

Canvas Run上の採択・却下・改善コメントは、次の投影より前に
`collect_video_harness_feedback`（または同じcollectorを使う共通Job API）で読む。
これは**提案の捕捉まで**を自動化する入口で、正本への自動昇格ではない。

- 元のRun ID、Run fingerprint、対象elementのdigest、projection hash、feedback revisionを
  evidenceへ残し、同じ要素・同じrevisionの再読込をexactly-onceで処理する
- コメントからcredential、絶対path、台本本文、Channel Pack本文を除外する
- 既定のchannel-pack宛は、その運営者専用の非公開台帳が共有リポジトリから物理的に
  分離されている場合だけ許す。共有pathやsymlink経由の衝突はfail-closedにする
- genre/platformへ一般化する場合は、利用者がtargetとgeneralizeを明示する。推測で
  チャンネル固有情報を共有層へ持ち上げない
- collectorが途中で落ちても、proposal追記とpending/captured journalを照合して
  同じJSONL行を重複追記しない

Canvasのコメントが書かれたこと自体は、映像品質ゲートのpassや人間signoffを意味しない。
制作の知覚承認と、改善提案の正本昇格は別々の証跡として扱う。

## 運営者端末から管理側へ返す

運営者側ではread-only curatorの出力を`harness-feedback.mjs create`で
Ed25519署名bundleへする。bundleは台本本文、Channel Pack payload、provider応答、
credentialを含まず、proposal ID・target・版・SHA・実測gateだけを運ぶ。
管理側endpointとtokenが設定済みなら、作成と同じ操作で耐久uploadまで行う。

```bash
BUZZASSIST_FEEDBACK_UPLOAD_TOKEN=... \
  node scripts/harness-feedback.mjs create \
  --report /absolute/export-report.json \
  --output /absolute/feedback-bundles/<bundle>.json \
  --private-key /absolute/operator-private.pem \
  --core-version <version> --harness <id> --harness-version <version> \
  --channel-pack-id <id> --channel-pack-version <version> \
  --channel-pack-sha <sha256> --source-host <claude-code-or-codex> \
  --upload --endpoint https://<owner-host>/v1/feedback/bundles

# network/5xxで止まったbundleを、同じdigestのままjournalから再送する
BUZZASSIST_FEEDBACK_UPLOAD_TOKEN=... \
  node scripts/harness-feedback.mjs sync \
  --bundle-dir /absolute/feedback-bundles \
  --endpoint https://<owner-host>/v1/feedback/bundles
```

upload tokenは環境変数だけから読み、bundleやjournalへ保存しない。remote endpointは
HTTPSに限り、URL内credential・query・fragmentを拒否する。network、408、425、429、5xx
だけを上限付きで再送し、4xx、server receiptのbundle digest不一致は恒久失敗として止める。
配達済みjournalは同じbundleを再送せず、管理側の冪等receiptへ再接続する。

管理側の入口は`harness-feedback-ingest.mjs`だけを使う。

```bash
# ownerが公開鍵と許可Harnessをローカル登録（この操作はHTTPへ公開しない）
node scripts/harness-feedback-ingest.mjs enroll \
  --root var/feedback-ingest --operator <operator-id> \
  --public-key <operator-public.pem> --harnesses <harness-id> \
  --approved-by <owner-id>

# upload API。tokenは引数へ書かず環境変数で渡す
BUZZASSIST_FEEDBACK_UPLOAD_TOKEN=... \
  node scripts/harness-feedback-ingest.mjs serve --root var/feedback-ingest

# ownerがverified quarantineを確認してからcurator観測へ昇格
node scripts/harness-feedback-ingest.mjs approve \
  --root var/feedback-ingest --bundle-digest <sha256> \
  --approved-by <owner-id> --reason "確認内容"
```

受付はBearer tokenと登録済みoperator署名を両方検証する。同じbundle digestは冪等に
再接続し、同じsigner/source reportが別内容で来たらreplay conflictとして隔離する。
未登録・不正bundleはraw bytesを保存せず失敗metadataだけを残す。検証済みbundleも
即時反映せず`verified-quarantine`へ置き、owner承認後のimportも既知proposal IDの
観測回数にだけ加える。未知IDから規則本文を捏造せず、**正本は一切書き換えない**。

このため「自動学習」は、捕捉・署名upload・重複排除・集計までを自動化する意味で
あり、AIが自分の変更を自分で承認する意味ではない。正本への昇格は従来どおり
`skill-creator`でfixture比較を行い、人の承認証跡を要する。

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
node scripts/harness-receipts.mjs export --out <path>   # 返せる形だけ
```

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
| 幸谷チャンネル固有の要求・禁止事項 | `channel-pack:koya`（非公開台帳） |
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
