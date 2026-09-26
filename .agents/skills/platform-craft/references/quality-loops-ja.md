# 品質ループの詳細 — 途中の成果物・台本・企画ブリーフ

`../SKILL.md` の「品質ループ（作って、測って、直す）」の続き。中核の規則（作る係と評価の文脈を分ける・
合格の3条件・止まる条件・時計と費用の数え方・同じ所見の拒否・`bestRound`）と、ループの種類ごとの入口と
照合の置き場は SKILL.md にあり、ここでは繰り返さない。ループを回すとき、ループの記録や使う前の照合を読む
コードを触るとき、企画ブリーフを組み立てるときに読む。

## 途中の成果物（`node scripts/asset-quality-loop.mjs`）

人物の設定画・背景・本編の画・サムネ・声のテイク・動画クリップを、使う前に同じ中核でループにかける。
動詞は start / sheet / record / verify / status と、動画を測る measure-video。実装は `lib/assetQualityLoop.mjs`。

- 工程は character / location / scene-image / thumbnail / voice-take / video-clip で、ハーネスごとに使える
  工程が決まっている（`--harness`）。BuzzAssist の外で映像を組む解説動画の制作から使う口は harness id
  `explainer-video` で、scene-image・voice-take・thumbnail だけを受ける（人物の設定画・場所・動画クリップは
  拒否する）。不合格の回は解説動画のチャンネルの非公開台帳（`channel-pack:explainer`）へ積む
- 人物の同一性と、公開面に出る画の手指の安全は、対話端末＋`--human-verified` の人の確認（`verify`）が無いと
  合格にならない。人の確認は対象ごとで、batch では記録できない。対象が多いときは `verify-pages`（下の節）
- 評価者に渡すシート（`sheet`）には合格点・下限・重み・前の回の点数を載せない。見ると採点がそれに寄る
  （合格点のすぐ上に集まる、前回から少しだけ上げる）
- 採点する側は `sheet` の出力（評価シートと採点ファイルの雛形）だけで採点と記録をする。ループのソース（`lib/*QualityLoop.mjs`）や
  品質契約のコードは開かない。評価項目の定義のそばのコメントに下限の値が書いてある（2026-09-26、記録の形を調べるためにソースを
  読んだ採点者が下限の値を目にした）。採点を頼む側も「ソースを読んで形を確かめて」と指示しない
- 同じ工程の対象が多いとき（長い動画の声のテイク・本編の画）は、`sheet --batch` / `record --batch` で1つの
  評価文脈がまとめて採点する（1回 50 件まで）。保証は1件ずつと同じ: 対象ごとに作った文脈と別の評価者の
  採点と所見、1つの不合格は他の合格を消さない、再評価は不合格の対象だけ。同じ所見の写しを複数の対象に
  貼った採点は記録されない
- 状態 → 理由コードの対応は `lib/assetQualityLoop.mjs` の `assetQualityReasonCode` の1か所（before-use /
  loop-state の語彙）。使う前の照合は `lib/assetQualityUseGate.mjs` の1か所で、ジャンルは効力の判定だけを
  足す（漫画は契約の版で効力を決めてからここを呼ぶ）

### 人の確認（verify と verify-pages）

人の確認は、機械のゲートを素通りした事故の最後の砦（猥褻な手の身ぶりが機械のゲートを全部通った。背景の丸いネオンが
実在のキャラクターの意匠そっくりで2回のレビューを素通りした）。決まりは「公開面の画像は全数を目で見る」で、小さく
縮めたサムネの一覧では見落とす。

- 1件なら `verify --subject <id> --asset <file> --check <identity|hand-safety> (--pass|--reject) --reviewer <名前> --note "…" --human-verified`
- 多いとき（長い動画の本編の画が数百枚など）は `verify-pages --work-dir <dir> --stage <character|scene-image|thumbnail>
  --reviewer <名前> --human-verified --approved-references <承認済みの参照の一覧> --reference <設定画のファイルかフォルダ>`。
  本体は `lib/assetQualityVerifyPages.mjs`、ページ画像を組む部品は `lib/humanReviewPageImage.mjs`
  - 載るのは、評価者の採点が合格して人の確認を待っている対象だけ。見る欄は、その版でまだ済んでいない欄（要る欄は
    ループが決める。ページにしても人の確認が要る対象の範囲は変わらない）
  - 1ページ既定 4 枚・上限 6 枚（`--per-page`）。各画は短い辺 720px（16:9 なら 1280x720）で、拡大も同じ大きさで
    並べる。拡大は、画の中の人物の範囲の記録があればその範囲（`--targets` の regions）、無ければ画全体を縦横 55% ずつ
    4つに切った拡大（隣どうし1割重ねる）。手と顔が小さいかは機械が決めない
  - 同一性の確認が要る対象は、その版が参照した設定画を承認済みの参照の一覧で照合してから同じ段に並べる。並べられない
    （一覧が無い・一覧に無い・ファイルが無い）対象は載せず、直すまで進まない理由として出す。手指だけの画は設定画を並べない
  - ページを1枚ずつ開き（macOS は open、Windows は explorer.exe、ほかは xdg-open）、端末で「pass」か落とす画の番号を
    答える。落とす画は否とする欄（同一性・手指のどちらか両方）と理由（2文字以上）を聞く
  - 見せてから答えるまでが max(5, 2×画の数 + 1×拡大のタイルの数) 秒より短い答えは受け付けず、ページを開き直す
    （4 枚・4 分割なら 24 秒）。目安ではなく、目を通していない答えを落とす下限
  - 記録は対象ごとの `verify` と同じ形（欄ごとに1行・成果物の sha256 に結ぶ）で、`page`（ページの id・ページ画像の
    sha256・置き場・ページの中の番号・見せた時刻・答えた時刻）を足す。1つの否は同じページの他の可を消さない
  - ページに並べた後で画が変わった対象・新しい版が記録された対象は記録しない。ページ画像が変わっていればそのページは
    記録しない。ページの見せ方と答えの記録は `quality/assets/verify-pages/<工程>--<ページ id>.json`（画は同じ名前の .png）
  - 途中でやめても（`q`・Ctrl-C・Ctrl-D）答えたページまでは記録に残り、同じコマンドで残りの対象だけのページから続く
  - 動画クリップはページで見ない（静止画では動いている途中の手や顔の崩れを見落とす）。通しで再生して `verify`

### 動画クリップ（工程 video-clip）

- 先に `measure-video --work-dir <dir> --asset <動画> --declaration <宣言.json>` で ffprobe / ffmpeg の測定
  （`buzzassist-video-clip-measurement-v1`、本体 `lib/videoClipMeasurement.mjs`）を作り、`record --measurement`
  に渡す。形式・全フレームのデコード・尺・fps・解像度・音声の有無は、評価者の申告ではなく測定の数値から
  ループが決め直す
- 参照は、漫画の差し替えクリップなら元の静止画、人物が写る動画なら承認済みの設定画。人物の写らない映像
  （OP など）は参照しない理由を書く。人物が写る（参照を持つ）版は、同一性と手指を人が確かめる——動画は
  そのまま公開面に出るため

## 台本（`node scripts/script-quality-loop.mjs`）

本体は `lib/scriptQualityLoop.mjs`。ジャンルは narrated-story（既定）・manga・explainer で、評価基準は
BuzzAssist 独自のもの。チャンネル固有の型は、署名済み Channel Pack の `script-quality.json` で評価項目を
足し、下限を上げる（下げられない）。採点表は `contract --genre <id>` で見る。

- 1つの版を、その版を作った文脈と別の評価文脈の採点で1回として記録する（`record`）。外部モデルに手直し
  させた版は、呼んだホストが `node scripts/harness-external-call.mjs record` で残した id を `--external-call` で渡す
- Pack の `script-quality.json` が `acceptance.evaluators` で評価者を宣言すると、1つの版は宣言した評価者
  全員の「評価の組」がそろって1回になる。`acceptance.mode` が `each-evaluator` なら、評価者それぞれの総合点と
  項目の下限で合否を決める（既定は average。宣言しないチャンネルは今までどおり）
- 始め直しても、同じ作業フォルダの回数・費用・時間は持ち越し、止まる条件は累計でも判定する。始め直しで
  上限を消せると、止まる条件が効かなくなるため。累計を戻せるのは、人が自分の端末から打つ
  `reset-cumulative --reason "..." --reviewer <名前> --human-verified` だけ
- `--cost` を書かない回は、参照した外部モデルの呼び出しを0円ではなく「費用不明」の件数に数える
- 2回目以降の版は、前回の失敗をどう直したか（`--revision-delta`）と、前の回の指摘ごとの採否と理由
  （`--finding-dispositions`）が要る。採用した指摘が次の回でも出たら「直っていない指摘」として停滞に数える
- 合格しなかった回は、評価項目 id・機械ゲート id・止まった理由のコードだけをチャンネルの非公開台帳へ積む

### 制作で台本を使う前（台本の関門）

- 制作側が見るのは `verdict`（ライブラリでは `scriptQualityVerdict`）だけ。使ってよいのは、ループが合格した
  版と同じ SHA（`script-quality-passed`）か、人がそのまま使うと認めた SHA（`script-quality-human-accepted`）
- 運営者・依頼者が書いた台本をそのまま使うときは、確認した人が自分の端末で
  `node scripts/script-quality-loop.mjs accept-human --work-dir <台本のフォルダ> --script <台本> --reviewer <名前> --reason "…" --human-verified`
  を打つ。AI の点で人の台本を止めない。エージェントは代わりに打たない
- Job の関門は `lib/scriptQualityUseGate.mjs` の1か所。作業フォルダは Job の `options.scriptQualityWorkDir`
  （CLI は start の `--script-quality-work-dir`。省けば台本のあるフォルダ）で、Job の識別子に入る。止まると
  `script-quality-required:<理由コード>` と次に打つコマンドが返り、plan-only の start は同じ理由を
  `preflight.blockers` に出す。どの契約の版から効くかはジャンルが決める（漫画は制作契約 v56、ナレーション
  物語は監査契約 v8）

## 企画（戦略ブリーフ。`node scripts/strategy-brief.mjs`）

企画の判断はホストのエージェントと運営者がする。BuzzAssist は判断の結果を `buzzassist-strategy-brief-v1`
（形は `config/strategy-brief.schema.json`）として受け取り、形と根拠の SHA を検査し、start / sheet / record /
status / verdict で版ごとに別の評価文脈の採点を記録する（本体 `lib/strategyBriefQualityLoop.mjs`、中核は
`lib/qualityLoop.mjs`）。外部の戦略の道具の文面は BuzzAssist に写さない。道具の版は `fingerprint --skill-dir`
の SHA だけを持つ。受け渡しの形は `docs/strategy-handoff-spec-ja.md`。

- 下書き: `draft --from-hyp <戦略の道具の作業フォルダ> --channel <id> [--previous <前のブリーフ>] --strategy-skill-dir <採用版> --out <作業フォルダ>/strategy-brief-rN.json`
  で作り、`needsAuthoring` の欄を上位の AI が成果物を読んで埋める。人が毎回手で書く前提にしない。
  推測で埋めず、確かめられないことは `openQuestions` へ置く
- 根拠は作業フォルダからの相対パスと sha256 で指す。制作側でブリーフを書き換えて根拠の確かさを上げると
  （provisional を verified にする等）、verdict が `strategy-brief-evidence-upgraded-without-review` で止める
- 前提（動画の問い・見る人・制作条件）を前の版から変えたら、その前提で集めた根拠は「当てはまりの確認待ち」に
  なる。`applicability` で根拠ごとに今の前提へ当てはまるかを記録し、当てはまらない根拠は取り直す
  （`strategy-evidence-refresh-required`）。入口の表現だけの変更では根拠を古くしない。日数では決めない
- 視聴者の分析の run は、`report-manifest.json` が今の結果と一致するものだけを根拠にする
- 公開後は `next --from <前のブリーフ> --metrics <集計> [--referrals <JSON>] [--audience-run <run>]` で次の
  下書きを作る。無い数字は missing、一部だけの数字は partial として、比べない
- `verdict --require-pass` が通るまで制作へ渡さない。制作を止める未確認事項（`blocksProduction`）が open の
  ブリーフも渡さない（`strategy-brief-open-question-blocks-production`）
- 制作へは `run-video-harness.mjs plan-request|start --strategy-brief FILE`。SHA は `options.strategyBriefSha256`
  として Job の識別子に入る。必須になるのは、チャンネルの台帳が `strategy.requireBrief` を宣言したときだけ
