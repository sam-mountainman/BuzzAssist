# 学習の置き場とチャンネル単位の保存先

`../SKILL.md` の「学習の置き場」の続き。置き場・保存先を決めるコードや運営者の配置表を直すとき、
学習（提案・反映記録・台帳）が見つからないときに読む。置き場は `lib/harnessLearningState.mjs` の1か所で
決まり、チャンネルの保存先は `lib/channelRegistry.mjs` が台帳の読み込みで決める。入口ごとに別の置き場を書かない。

## 開発用チェックアウトと運営者の端末

- **開発用チェックアウト**（`.git` と `.claude/skills` と `.agents/skills` がある）: リポジトリの `docs/learning`。
  台帳は git で追跡され、commit を人が読む
- **運営者の端末**: Claude Code と Codex のどの版の写しから動かしても `~/.buzzassist/learning/`
  （`BUZZASSIST_LEARNING_DIR` で上書き可）。中の配置は次のとおり
  - `shared/` — 共有層（genre: / platform:）の台帳
  - `channel-packs/<id>/` — 保存先を宣言していない Channel Pack 宛の台帳（チャンネルの無い Job の分）
  - `channels/<チャンネルの id>/` — チャンネル単位の既定の保存先（下。開発用チェックアウトでもここを使う）
  - `receipts/index.jsonl` — Job の決着の索引
  - `overlays/<skill>/learned-auto.md` — この端末の項目
- 写しの中（plugin cache・`~/plugins/buzzassist/plugin`）に台帳を書かない。setup・自動更新・ホストの版上げで消える
- 初回だけ、古い写しに残った台帳を取り込む。提案は ID と session で重複を除き、元は消さない
- 運営者の端末の `sync` は同梱の overlay を書き直さず、この端末の項目を印で囲んだ区画として、ホストが
  読む全部の写しの `references/learned-auto.md` の末尾へ届ける。setup のたびにも届け直す

## チャンネル単位の保存先

運営者の配置表 harness-deployments.json（配布物の `config/harness-deployments.example.json` から作る、運営者の
手元だけのファイル）の `channels` のチャンネルで作った Job（`start --channel`、または Pack・作業フォルダが台帳の
チャンネルに当たった Job。Job の `metadata.channel` に残る）の学習は、そのチャンネルの保存先へ積む。
宛先（`channel-pack:<id>`）はハーネス単位なので、同じハーネスのチャンネルが2つあると保存先が同じになり、
学習が混ざっていたため。

- 保存先は `channelLearning` の `{ "target": "channel-pack:<id>", "channel": "<チャンネルの id>", "root": "<dir>" }`。
  宣言が無ければ `~/.buzzassist/learning/channels/<チャンネルの id>`（`BUZZASSIST_LEARNING_DIR` で上書き可）。
  開発用チェックアウトでも同じくリポジトリの外に置く（`docs/learning` は公開の共有台帳で、`channel-packs/` に
  別の名前のフォルダを作ると既定の Pack の探索が変わる）
- 保存先の中は、提案と反映記録が `<root>/docs/learning/`、宛先の正本（要求台帳）が `<root>/<正本の相対 path>`
- `channel` の無い `{ "target", "root" }` の行は、今までどおりチャンネルの無い Job の保存先
- `BUZZASSIST_CHANNEL_REGISTRY` で台帳を別のファイルにした端末では、`channelLearning`（宛先単位の行も）をその
  ファイルに書く。検査する保存先と実際に書く保存先を同じ宣言から読むため。指したファイルが無ければ、配置表へ
  落とさずに `channel-learning-store-invalid` で止まる
- 重なる保存先は台帳の読み込みで拒む: 別のチャンネルの場所・別のチャンネルの保存先に重なる保存先は不可
  （`channel-learning-store-overlap`）。チャンネルの無い Job の保存先に重なるのは、その宛先を使うチャンネルが
  1つのときだけ許す（`channel-learning-store-unscoped-overlap`）。台帳に無いチャンネル・使わない宛先・共有層の
  宛先・重複・未完成の宣言も名指しで拒む
- 保存先は配備 root とは別の設定で、共有台帳には決して解決しない

### 既存の台帳を1つ目のチャンネルへ引き継ぐ

開発用チェックアウトで `channel-packs/<id>/`（`docs/learning/` の提案・反映記録と `docs/` の要求台帳）に学習を
持っていたチャンネルを台帳に登録するときは、チャンネルごとの宣言の root をその Pack のフォルダにする:
`{ "target": "channel-pack:<id>", "channel": "<チャンネルの id>", "root": "channel-packs/<id>" }`。書かずに登録すると、
登録後の学習は新しい保存先（`channels/<チャンネルの id>`）へ積まれ、従来の台帳は `--channel` なしの一覧に残る。

- 引き継げるのは、その宛先を使うチャンネルが台帳に1つだけのとき。2つ目の同じハーネスのチャンネルは別の root にする。
  宛先単位の宣言で従来の保存先を別の場所にしていたなら、その root を書く
- 印（`channel`）の無い従来の行は、そのチャンネルの行として読む。反映記録の照合も同じ要求台帳を見るので、反映済みの
  数えは変わらない。引き継ぐ前に置いた承認待ちの変更は、`--channel` を付けずに当てるか `pending` を作り直す
- 運営者の端末の従来の台帳（`~/.buzzassist/learning/channel-packs/<id>/`）は `docs/learning/` を挟まないので、root
  では指せない。引き継ぐなら、中の `*.jsonl` を新しい root の `docs/learning/` へ写す

## `harness-learn` の `--channel <id>`

- capture / status / review / promote / apply / pending / approve / reject / rollback で使える。付けると共有台帳と
  そのチャンネルの保存先だけを読み書きし、別のチャンネル・チャンネルの無い保存先の提案・反映記録・承認待ちの
  変更は出さない
- `--channel` なしの status は、末尾にチャンネルごとの未反映の件数だけを出す（中身は混ぜない）。チャンネルの
  学習を `--channel` なしで探して「無い」と判断しない
- 共有層（genre: / platform:）宛には付けられない（`channel-scope-shared-target`）。チャンネル固有の事実を共有層へ
  上げないため。一般化するなら、チャンネルを外して一般的な言い方で別の提案として capture する
- 台帳に無いチャンネル・そのチャンネルの宛先に無い宛先は `channel-learning-scope-invalid` で止め、チャンネルの
  無い保存先へ落とさない。別のチャンネルの変更は `channel-scope-mismatch` で当てない
- sync と curate は `--channel` を受け付けない（overlay は共有層だけを書く）

## 自動の捕捉とチャンネル

- Job の決着時の捕捉と Canvas のフィードバックは、Job の `metadata.channel` があれば、channel-pack 宛の提案を
  そのチャンネルの保存先へ積む。保存先を決められなければ `channel-learning-store-unresolved` で積まずに返す
  （チャンネルの無い保存先へ落とさない）
- 品質ループ（台本・途中の成果物・企画ブリーフ）の不合格の回の捕捉は、`lib/learningChannelResolver.mjs` が
  チャンネルを次の順に決める（上ほど強い。Job を優先）:
  1. 呼び出しが明示したチャンネル
  2. 制作の Job の `metadata.channel`
  3. ループの作業フォルダが、台帳のチャンネルの Job の台本の作業フォルダ（`options.scriptQualityWorkDir`）と同じかその中
  4. 企画ブリーフの `channel.id`、またはループの作業フォルダが台帳のチャンネルの `strategy.workDir`・`projectDir` と
     同じかその中
- 手がかりが別々のチャンネルを指せば `channel-learning-channel-ambiguous`、台帳を読めなければ
  `channel-registry-unreadable`、チャンネルが決まったのに保存先を決められなければ `channel-learning-store-unresolved`。
  どれも推測で寄せずに積まない。ループの CLI の出力には、積んだチャンネルの保存先が出る
- どれにも当たらなければ（`metadata.channel` の無い Job を含む）、今までどおりハーネス単位の Channel Pack の台帳へ積む
