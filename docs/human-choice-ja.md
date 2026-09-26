# 人は要所で選ぶだけにする（判断の振り分けと、並べて選ぶ）

人は最後の砦ではなく、要所でだけ答える「まばらな神託」として置く。人の判断は減るのではなく、少数の点に
集まる。その一手前では候補を惜しまず出し、人は1つ選んで短い理由を言う。理由は採点の基準に変えて、以降の
生成と採点は AI に任せる。聞きすぎると承認疲れで、人がまた詰まりどころに戻る。

入口は `node scripts/human-choice.mjs`（本体 `lib/humanChoice.mjs`、理由を積む部品 `lib/humanChoiceLearning.mjs`）。

## 1. 判断の振り分け

人に何かを決めてもらう前に、どの聞き方にするかを決める。

| 聞き方 | 問い | どうするか |
|---|---|---|
| 並べて選ぶ（pick） | どれがいいか | 候補を 2〜5 案（目安 4）、設計の軸を分けて並べ、人が1つ選んで決め手を言う。決め手は採点表に足す候補として承認キューへ積む |
| 1案に赤を入れる（redline） | これでいいか | 1案を見せて、可か否かと、否なら何を直すかを書いてもらう。聞くのは 3±1 問まで。各問の既定は「お任せ」＋推奨 |
| 人に聞かない（machine） | 正解が一つで機械が確かめられる | 機械ゲート・測定・評価者の採点で決める |

決め方（`routeHumanDecision`）: 機械が確かめられるなら聞かない。候補が2つ以上あれば並べて選ぶ。1案しかなければ赤を入れる。

### 工程ごとの振り分け

`node scripts/human-choice.mjs routes` で同じ表が出る（`lib/humanChoice.mjs` の `HUMAN_DECISION_TABLE`。試験がこの表と一致を見る）。

| 工程 | 振り分け | 入口 |
|---|---|---|
| `strategy-topic` 企画の題材 | 並べて選ぶ | `human-choice.mjs create --stage strategy-topic`（題材の候補を企画ブリーフより前に並べる） |
| `strategy-brief` 企画ブリーフ | 1案に赤 | `strategy-brief.mjs`（評価者が採点する。人は止まったときだけ赤を入れる・`stop` で止める） |
| `title` タイトル | 並べて選ぶ | `human-choice.mjs create --stage title` |
| `script` 台本 | 1案に赤 | `script-quality-loop.mjs`（評価者が採点する。人がそのまま使うと認めるなら `accept-human --human-verified`） |
| `character-candidates` 人物の設定画の候補 | 並べて選ぶ | 漫画は `generate_character_candidates` → `approve_character_candidate`（`approvalReason`）。ほかは `human-choice.mjs create --stage character` |
| `character-identity` 決まった人物の同一性・手指 | 1案に赤 | `asset-quality-loop.mjs verify` / `verify-pages`（公開面の画は全数を人が見る決まり。減らすのは打つ手間だけ） |
| `voice-casting` 声の人選 | 並べて選ぶ | 既存の声の人選の経路（匿名の試聴ページ → `selectionReason` つきの承認） |
| `thumbnail` サムネ | 並べて選ぶ | `human-choice.mjs create --stage thumbnail`（選んだ案を `asset-quality-loop` へ） |
| `key-scene-image` 要の場面の画（冒頭・山場） | 並べて選ぶ | `human-choice.mjs create --stage scene-image` |
| `scene-image` それ以外の本編の画 | 聞かない | `asset-quality-loop.mjs`（評価者の採点＋機械ゲート。同一性・手指の確認は `character-identity` の行） |
| `voice-take` 声のテイク | 聞かない | `asset-quality-loop.mjs --stage voice-take`（CER・UTMOS の機械ゲート＋評価者） |
| `measurable` 寸法・尺・フレーム数・音量・文字のはみ出し・読み | 聞かない | 各ジャンルの機械ゲートと最終監査 |
| `final-video` 完成動画 | 1案に赤 | 各ジャンルの signoff（全編の試聴。作った文脈とは別の文脈で） |

並べて選ぶのは、決めた後で戻すと高くつき、機械が良し悪しを決められない工程だけ。本編の画を1枚ずつ並べて選ばせる
ようなことはしない（要の場面だけ）。機械が確かめられることを人に聞かない。

## 2. 並べて選ぶ手順

1. **候補を出す**（作る側のエージェント）。2〜5 案、目安 4。同じ指示の乱数違いにせず、設計の軸を宣言して分ける
   （例: 寄りの顔で感情を見せる / 引きで対立を見せる / 文字を主役にする / 色で一覧から浮かせる）。候補はファイルなら
   作業フォルダの中の実物（シンボリックリンク不可）、タイトル・題材なら文のまま渡す。推す案があれば推奨と理由を付ける
   （推奨はお任せの既定になる）。
2. **組を作る**。

   ```bash
   node scripts/human-choice.mjs create --work-dir <作業フォルダ> --harness <ハーネス> --stage <工程> --set <組の id> \
     --candidates <候補の一覧.json> --question "どの案で進めますか" [--open]
   ```

   候補の一覧の形:

   ```json
   {
     "version": "buzzassist-human-choice-candidates-v1",
     "candidates": [
       { "path": "thumbs/r3-a.png", "axis": "寄りの顔で感情を見せる", "summary": "任意の短い説明" },
       { "path": "thumbs/r3-b.png", "axis": "引きで対立を見せる" }
     ],
     "recommended": { "index": 2, "reason": "状況が一目で分かる" }
   }
   ```

   状態は `<作業フォルダ>/quality/choices/<工程>--<組>.json`、見せるページは同じ名前の `.html`。並べる順は生成の順・
   入力の順にしない（組の id と中身で決まる）。候補の出所（モデル・提供元）はページに出さない。
3. **人がページを開いて選ぶ**。ページは1枚の HTML（外部の読み込み無し・サーバー無し・何も保存しない）。案を1つ、
   決め手の札を 3 つまで、任意で一言、名前を入れると、自分の端末で打つコマンドができる。選んだ人がそれを自分の端末に
   貼って打つ。端末で聞かれながら答えるなら次だけでよい（聞くのは3問: どれ・決め手・一言）。

   ```bash
   node scripts/human-choice.mjs choose --work-dir <作業フォルダ> --stage <工程> --set <組の id> --reviewer <名前> --human-verified
   ```

4. **次の生成へ**。`status --json` の `choice.guidance`（選んだ案・軸・決め手・一言）を、次の生成（直し・派生）の指示に
   入れる。選んだ案が成果物なら、そのまま途中の成果物の品質ループ（`asset-quality-loop.mjs`）にかける。
   `status --require-choice` は、人の選択が無いか、選んだ案のファイルが選んだ後で変わっていれば終了コード 4。
   選んだ案を直す・派生させるときは別のファイルに書く（選択は選んだときのバイト列に結んである）。

### 記録の決まり

- 人の選択として数えるのは、選んだ人が自分の対話端末から `--human-verified` を付けた記録だけ（途中の成果物の人の確認と
  同じ `attestationFor`）。エージェントが代わりに記録するなら `--agent-attested`。記録は残るが数えず、学習にも積まない
- 決め手の札か一言のどちらかが要る（理由の無い選択は、次の生成にも採点表にも何も残さない）
- お任せ（`--delegate`）は推奨の案を選ぶ。推奨の無い組では使えない。お任せには理由が無いので学習に積まない
- 候補を並べた後でファイルが変わったら記録しない。ページのコマンドは組の digest（`--page-digest`）を持ち、候補の組が
  変わった後の古いページの答えは記録しない
- 人は選び直してよい（後の選択が前の選択に代わる。記録は全部残る）。候補を出し直すなら `create --restart --reason "..."`
  （前の組と記録は history に残る）

## 3. 決め手の札と、採点表に足す候補

札は工程ごとに決まった短い選択肢で、それぞれが採点表のどこに効くかを持つ（`routes --stage <工程>` で出る）。

- **既定の評価項目を重く見る札**: 例 サムネの「一瞬で読める」→ `readable-at-decided-size`。反映先は Pack の
  `asset-quality.json` の `weights` / `floors`（下限は上げるだけ）
- **採点表に足す評価項目の案の札**: 例 サムネの「人物の感情が強く出ている」→ `strong-emotion`（label・description 付き）。
  反映先は Pack の `asset-quality.json` の `stages.<工程>.criteria`。形は `normalizeAssetChannelConfig` がそのまま受ける
  形（重みと下限は人が決める）
- 企画の題材とタイトルには、チャンネルで変えられる採点表が無い。反映先はチャンネルの要求台帳（判断の基準として人が書く）

| 工程 | 反映先 | 札 |
|---|---|---|
| 企画の題材（`strategy-topic`） | チャンネルの要求台帳 | 題材がまだ出ていない / 見る人がはっきりしている / 入口の約束が強い / 感情の山がはっきりある / チャンネルの色に合う / 今の制作条件で作れる |
| タイトル（`title`） | チャンネルの要求台帳 | 続きが気になる / 具体的な名詞・数字がある / 短く一目で読める / サムネと役割が分かれている / 中身と食い違わない |
| 人物の設定画の候補（`character`） | `asset-quality.json` の `stages.character` | 顔立ちが役柄に合う / 年齢感が合う / 他の人物と見分けやすい / 表情に幅が出せそう / 画風がチャンネルに合う |
| サムネ（`thumbnail`） | `asset-quality.json` の `stages.thumbnail` | 一瞬で読める / 人物の感情が強く出ている / 状況・対立が一目で分かる / 文字のデザインが良い / 一覧で目立つ / 情報が多すぎない |
| 要の場面の画（`scene-image`） | `asset-quality.json` の `stages.scene-image` | 場面の意図が伝わる / 構図が読みやすい / 感情が伝わる / 光と空気感が合う / 画風が揃っている |

## 4. 理由が採点表に届くまで

1. `choose` が数える人の選択を記録すると、決め手の札ごとに1件、一言があれば1件の提案（kind `preference`）を、
   そのハーネスの Channel Pack の非公開台帳（`channel-pack:<id>`）の proposals へ積む。台帳のチャンネルが分かれば
   （`--channel`・`--job`・作業フォルダ）、そのチャンネルの保存先へ積む（決め方は途中の成果物の品質ループの `record` と同じ）
2. 札の提案の本文は工程と札で決まる定型文（組の id・候補のパス・人名を入れない）。同じ札が別の組で選ばれると同じ
   提案 id の別の記録になり、「何回その理由で選ばれたか」として数えられる。同じ組の選び直しでは二重に数えない
3. 人が `node scripts/harness-learn.mjs status --channel <id>` で読み、繰り返し選ばれた決め手を要求台帳に書くか、Pack の
   作者が `asset-quality.json` に評価項目を足して署名し直す。**採点表（署名済みの Pack）は自動では書き換えない**。
   正本へ当てるときは `pending` → `approve` の承認キューを通る
4. Pack が変わると、途中の成果物の品質ループは新しい契約で始め直す（続いているループは人が `stop` してから
   `start --restart`）。走っているループの採点基準は途中で変えない

子エージェント（`BUZZASSIST_LEARNING_WRITE_FORBIDDEN`）と `BUZZASSIST_LEARNING_AUTO_CAPTURE=0` では積まない。捕捉に
失敗しても選択の記録は変えない。

## 5. やらないこと

- 機械が確かめられることを人に聞く・1回に 3±1 問より多く聞く
- 同じ指示の乱数違いの候補を並べる（軸の同じ候補は `create` が拒否する）
- 人の選択をエージェントが `--human-verified` で記録する（選んだ人が自分の端末で打つ）
- 選んだ理由で採点表（署名済みの Pack）を直接書き換える
- 候補を見せるためにサーバーを立てる（ページは1枚の HTML で足りる。漫画の人物の候補は Canvas に並ぶ既存の経路を使う）

## 6. 既存の経路との関係

- 漫画の人物の候補（MCP の `approve_character_candidate` と、漫画の公式経路の人物の承認）と声の人選は、それぞれの経路で
  選んだ理由（`approvalReason`・`selectionReason`）を記録する。これらの経路から理由を承認キューへ積む接続はまだ無い
  （記録を human-choice の組と選択の形に揃えて `captureHumanChoiceLearning` へ渡せば同じ台帳へ積める。どちらも
  MCP・エージェントが記録する経路なので、人の選択として数えるには選んだ人の端末での記録が要る）
- 途中の成果物の品質ループ（`lib/assetQualityLoop.mjs`）は、選ばれた案を採点する側で、人の選択を合格の条件にはしない。
  選んだ案が合格した版かは、そのループの `status --require-pass` で見る
