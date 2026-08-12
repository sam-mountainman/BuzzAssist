# 「まさお」フォルダー全件監査と動画品質ハーネス統合

## 監査範囲

- 対象: `/Users/higataiyu/まさお`
- 容量: 54 MB
- `.git` 内部を除く物理ファイル: 318件（2026-08-12再集計。55,004,124 bytes）
- Markdown: 74件をすべて末尾まで読了。SHA-256で重複を照合すると本文は35種類、複製は39件。
- YouTube調査素材: 動画情報65件（うち1件はプレイリスト情報）、実動画64本、VTT 130件（日本語64組128件＋英語2件）。64組の`.ja.vtt`と`.ja-orig.vtt`は全組で完全一致。
- JSON: 78件を全件読み込み・構文検証し、78件すべて有効。
- その他: HTML 4、JavaScript 2、Python 1、テキスト9、PNG 2、拡張子なし18。全ファイルをバイト単位で読み、SHA-256で198種類の実内容と89個の複製グループを確認。JSON 78件は全件構文有効。

## Markdownで得た共通原則

74件のMarkdownは次の群に分かれる。

1. `1.md`〜`20.md`, `84.md`〜`88.md`: AI制作、YouTube運用、評価、改善ループ、外部記憶、チェックリスト化。
2. `X記事_ハーネスエンジニアリング.md`: ハーネス設計の長文統合資料。
3. `akapen-*`: 高コストで曖昧な判断だけを人間へ聞き、推奨既定値と判断証拠を残す方式。
4. `bestofn-*`: 複数候補、明示的な変化軸、匿名化、採用後の対応表開示。
5. `.fable/last-plan.md`: 動画の理解を助ける比喩、ループ構造、人間の役割の設計。
6. 多数の `CLAUDE.md`: 33件は同一のプレースホルダー。実装内容はなく、配置・パッケージ構造の証拠として扱った。

文書全体で一貫していた原則は以下。

- 生成者と評価者を分離する。生成者の自己申告を完成証拠にしない。
- 解像度、欠損、文字はみ出し、無音、音量、参照漏れなど測れる項目は、主観評価より先にハードゲートで落とす。
- 採点基準は制作開始前に固定し、実行中に都合よく変更しない。
- 完了、失敗、次の行動、成果物、証拠を外部状態へ保存し、中断後に再開できるようにする。
- 品質閾値だけでなく、最大反復回数、時間、費用、改善停止を終了条件にする。
- 再発事故を「注意書き」で終わらせず、チェックリスト、恒久指示、自動検査へ段階的に昇格させる。
- チャンネル固有の視聴者、視聴状況、声、画風、構成、勝ちパターン、禁止事項、既知事故は、普遍的品質規則と分離する。
- Best-of-Nは同じ指示の乱数違いにせず、カメラ、演技、余白、光、情報密度など変化軸を明示する。出所を隠して固定基準で比較する。
- 画像と日本語文字は分離し、画像モデルに吹き出し文字を焼き込ませない。
- ナレーション用読み上げ文と、画面・絵コンテ・素材指示を分離する。
- 自動評価だけで満点にせず、ネイティブサイズ確認、参照との横並び比較、全尺視聴を最終証拠にする。
- 人間判断はブランド、味、リスク、曖昧な優先順位に限定し、機械判定可能な質問を増やさない。

## ファイル時刻とGit履歴から見た時系列

以下はファイルmtimeと同梱Git履歴に基づく来歴であり、本文中の出来事の発生日や著者を断定するものではない。

- 2026-07-03 00:07〜00:23（UTC+8）: `1.md`〜`18.md`が順次保存された。
- 2026-07-03 01:07以降: YouTubeプレイリスト情報、64動画分の情報JSON、日本語字幕64組と英語字幕2件が`.hiroya_obsidian_work/`へ収集された。
- 2026-07-03〜07-04: `84.md`〜`87.md`と作業用バックアップが追加された。
- 2026-07-06〜07-07: `.fable/last-plan.md`、Claude/Codex/Cursor/Antigravity向け`yt-quality-loop`配置試験、E2E痕跡、各階層の`CLAUDE.md`プレースホルダーが作られた。実装本体よりも、複数hostへ同じループを配る構造検討の証拠が中心である。
- 2026-07-12 21:37:58: 同梱Git履歴で`akapen v0.1.0`（commit `a6a8277`）と`bestofn v0.4.0`（commit `59b6ba8`）がそれぞれ単一commitとして確定した。`*-main`と`*-repo`は内容重複なので一組ずつとして分析した。
- 2026-07-23: `19.md`と`20.md`が追加された。
- 2026-07-24: `X記事_ハーネスエンジニアリング.md`が追加され、外部状態、生成/評価分離、停止条件、人間判断の設計が長文で統合された。
- 2026-08-10〜08-12: 実質的な本文追加は確認できず、更新は主にFinderの`.DS_Store`だった。

## 調査動画64本との照合

VTTはYouTubeのローリング字幕で重複行が多いため、出現回数ではなく「その語を含む動画数」で照合した。主要概念の文書カバレッジは、評価64/64、チェック63/64、人間45/64、エージェント44/64、ログ36/64、フォルダ33/64、スキル24/64、指示24/64、ルール23/64、失敗23/64、判断21/64、記憶16/64、仕組み14/64、プロンプト13/64、反復13/64、テンプレート11/64、レビュー11/64、ループ10/64、自動化10/64、品質10/64だった。

したがって、単発の表現ではなく、資料群と調査動画の双方で反復された「外部状態・評価分離・ゲート・上限・証拠」を移植対象とした。

## 同梱コードから採用した設計

### akapen

- 3±1問に絞る。
- 推奨選択肢を先頭に置く。
- 回答途中をローカル保存する。
- 自由記述をサニタイズし、回答を証拠として残す。

このプロジェクトでは、人間への質問UIを直接コピーせず、品質ループの終了理由を `human-review` へ限定し、機械ゲート通過前に人へ聞かない設計へ置き換えた。

### bestofn

- 2〜5候補を基本とする。
- 候補名、モデル名、パスから出所が漏れない匿名ラベルを使う。
- 採用ラベル確定前に秘密対応表を評価者へ渡さない。
- 生成失敗、空出力、パストラバーサル、巨大入力、偽の採用記法、サーバー重複起動などを自己テストする。

`bestofn` 側に明示ライセンスが見当たらなかったため、コードはコピーせず、匿名比較と安全境界を独自実装した。

## 現行パイプラインへ実装した内容

### 2026-08-12再監査で判明した接続欠落

初回統合は部品単位では正しかったが、完成判定への接続が不十分だった。

- `audit-manga-quality-harness.mjs --stage final`は、実行のたびに`quality-loop-state.json`を`active / rounds=[]`へ上書きしていた。
- 必須監査`quality-harness-final`は、その空状態を読まず、`preflight-final.json.pass`だけで合格していた。
- rubricは一項目だけ採点しても100点を作れ、review noteと証拠が空でも通せた。
- evaluator名だけ変えれば、generatorと同じ会話contextでも自己採点できた。
- Best-of-Nは匿名ラベルを作る一方、異なるvariation axis、判定記録、採用理由を必須にしていなかった。
- キャラクターと声の人間承認は候補IDを残すだけで、「なぜ採用したか」を次回へ継承できなかった。

これらは資料群の中心原則と矛盾するため、今回の統合で修復対象にした。

### 品質契約

`lib/mangaQualityHarness.mjs` の `createMangaQualityContract` が以下を正規化し、安定JSONのSHA-256で固定する。

- チャンネル固有指示
- 普遍的品質規則
- ハードゲート一覧
- 合計100点へ正規化した9カテゴリrubric
- 目標点、最大レビュー2回、時間、費用、最低改善量、停滞上限
- 匿名候補比較ポリシー

契約オブジェクトは再帰的にfreezeされ、途中変更した場合は別runを要求する。

### 制作前ハードゲート

`auditMangaPreflight` は、有料生成より前に次を検査する。

- エピソード、カット、台詞の構造
- 台詞IDの欠損、孤立、重複参照
- 読み上げ不能なMarkdown、URL、空文
- 全台詞の音声割当
- 吹き出しのoverflow、textLoss、tooSmall、insideBubble
- 連続構図の変化量
- 画像への文字焼き込み
- final段階での完成動画証拠

明示された無言カットは許可し、まだ存在しない後工程の証拠は `not-applicable` として誤検知を避ける。

### 匿名Best-of-N

`createBlindCandidateSet` は候補順をsalt付きハッシュで並べ替え、評価者には `A`, `B` 等と匿名アーティファクト参照だけを渡す。モデル名、元ファイル名、provider、内部IDは秘密対応表にのみ残す。`revealBlindSelection` は採用後だけ対応を返し、対応表digestも証拠に残す。

### 上限付き品質ループ

`createMangaQualityLoopState` と `recordMangaQualityRound` は次を保証する。

- generatorと同じIDのevaluatorを拒否。
- 前roundと同じevaluatorを拒否し、新鮮な評価を要求。
- 固定rubricから重み付き点数を計算。
- ハードゲート合格かつ目標点以上のみpass。
- 最大round、費用、時間、改善停止で自動停止し、人間へエスカレーション。
- 評価証拠、費用、経過時間、次の行動を外部状態へ保存。

v2ではさらに、全rubric項目、generatorと異なるevaluator context、具体的なメモ、SHA-256に結ばれた証拠を必須にした。不合格roundはfailure fingerprintを持ち、再試行は直前fingerprintと修正差分を参照する。時間は呼び出し側の自己申告加算ではなく`startedAt`からの観測時刻で判定する。

### 判断ルーターと承認証跡

- 外部テストで一意に決まる判断は機械ゲートへ送り、人へ質問しない。
- 単一提案の曖昧点は赤ペン型の3±1問へ圧縮する。
- 主観・ブランド・有料で複数候補がある判断はhuman Best-of-Nへ送る。
- rubricで比較できる低リスク判断だけfresh evaluatorのblind Best-of-Nへ送る。
- 匿名候補は2〜5件、`variationAxis`重複禁止、artifact必須。対応表は`setId`、採用ラベル、判定者、時刻、具体的理由を持つverdict確定後だけ開示する。
- 幸谷のキャラクター承認CLIは`--approval-reason`を必須にし、声の採用も`selectionReason`と人間reviewerをレジストリへ保存する。

### 最終品質決定

`quality-harness-final`を事前ゲートの別名として扱う経路を廃止した。公式`koya-manga-video.mjs audit`の最後で、自分自身を除く全必須監査を集約し、各適用監査の証拠ファイルSHA-256、正本契約digest、実MP4 SHA-256へ拘束した`final-decision.json`と`quality-loop-state.json`を作る。

- 全監査と知覚署名が揃う: `passed`
- 機械監査は全合格で知覚署名だけ未完了: `needs-human-approval`
- 監査欠損・不合格・証拠hash欠落: `blocked`

空の`active`状態は完成証拠にならず、standalone preflight CLIの`--stage final`も拒否する。

### 事故知識の昇格

`recordMangaQualityIncident` は同一signatureの再発数を数える。

- 1回目: checklist
- 2回目: instruction
- 高影響かつ機械判定可能な事故が2回: hard-gate

例として、文字はみ出しは再発時に吹き出し自動ゲートへ昇格する。

### 制作DAG

`lib/mangaProductionDag.mjs` をv3へ更新した。

```text
script-analysis
  -> quality-contract
  -> preflight-hard-gates
  -> character / voice / camera / bubble / image / render
  -> independent audits
  -> whole-program-audit
  -> quality-decision
```

事前ゲートが失敗した場合は組み込みhandlerがfail-closedで停止し、決定論的失敗を無意味に再試行しない。最終terminalは単なる監査完了ではなく `quality-decision` になった。

### 運用CLI

```bash
npm run manga-video:preflight -- \
  --manifest-path canvas/manga-videos/<episode>/episode-manifest.json \
  --stage planning
```

このCLIは `quality-contract.json`, `preflight-planning.json`, `quality-loop-state.json` を原子的に保存する。チャンネル指示と品質上書きは別JSONで渡せる。

## 移植しなかったもの

- 同じ本文のリポジトリ複製: ハッシュが同一のため二重導入しない。
- プレースホルダーだけの `yt-quality-loop`: 実装が同梱されていないため、存在しない機能として扱わない。
- 無限自己改善: 費用と時間を浪費し、品質の自己申告を強めるため不採用。
- 生成AIによる自己合格: 独立評価の原則に反するため不採用。
- 画像モデルへの日本語吹き出し生成: 文字破綻と修正不能を招くため禁止。
- `bestofn` コードの直接コピー: 明示ライセンスが見当たらないため、概念だけを独自実装。
- akapenの質問を毎工程へ増やすこと: 機械検査できない高コスト判断だけに限定する。

## 実データ確認

`manga-photo-homecoming-001` の実MP4をv49へ同期し、公式最終監査を二段階で実証した。

1. 旧v48知覚署名のまま監査すると、機械監査15項目と全尺デコードは合格したが、契約digest不一致を検出。`final-decision.json`は`needs-human-approval / perceptual-signoff-required`で停止し、`quality-harness-final`も不合格になった。
2. 同一MP4 SHA-256、実MP4由来contact sheet、代表4フレーム、v49契約digestへ拘束したCodex知覚レビューを作成し、再監査した。最終17監査は17/17合格、`quality-harness/final-decision.json`は`passed`、16独立監査証拠は全件SHA-256付き、`knownRemainingIssues=[]`、manifestは`final-koya-audited`になった。

実証値:

- 契約: `koya-manga-production-v49`
- エピソード固有契約digest: `31b44d5066eeaae342ca5b1d7965d974bad6fac76131d1d57ddb2dcd40317108`
- 実MP4 SHA-256: `4c0ecf9f9216a8d7a7d8ff5eea98c9bf3f03117413fd6b769f4c8c5be8cc722b`
- 実デコード尺: `149.087696`秒、1920×1080、30fps、H.264/AAC
- 最終監査: 17/17、品質決定証拠: 16/16、未解決事項: 0

検証は全458リポジトリテスト、公式`skill-creator` validatorによる制作・カメラ両スキル、Node構文検査、`git diff --check`でも合格した。
