# 「まさお」フォルダー全件監査と動画品質ハーネス統合

## 監査範囲

- 対象: `~/まさお`
- 容量: 54 MB
- `.git` 内部を除く物理ファイル: 320件（2026-09-01独立再集計。55,065,806 bytes）
- Markdown: 76件をすべて末尾まで読み、SHA-256で本文37種類、複製39件（重複hash groupは8）を確認。
- YouTube調査素材: 動画情報65件（うち1件はプレイリスト情報）、実動画64本、VTT 130件（日本語64組128件＋英語2件）。64組の`.ja.vtt`と`.ja-orig.vtt`は全組で完全一致。
- JSON: 78件を全件読み込み・構文検証し、78件すべて有効。
- その他: HTML 4、JavaScript 2、Python 1、テキスト9、PNG 2、拡張子なし18。全320ファイルをバイト単位で読み、SHA-256で201種類の実内容、88個の重複hash group、先頭コピーを除く複製119件を確認。symlinkは0件。

## Markdownで得た共通原則

76件のMarkdownは次の群に分かれる。

1. `1.md`〜`18.md`と`.hiroya_obsidian_work/backups/{19,20}.md`: AI制作、YouTube運用、評価、改善ループ、外部記憶、チェックリスト化に関する元のnote記事。
2. 現在のroot `19.md`・`20.md`: `vtt_to_markdown.py`で上書きされた調査動画1本目・2本目の字幕変換物。元のnote記事ではない。
3. `84.md`〜`88.md`: 他者記事の調査コピー。
4. `X記事_ハーネスエンジニアリング.md`: ハーネス設計の長文統合資料。
5. `akapen-*`: 高コストで曖昧な判断だけを人間へ聞き、推奨既定値と判断証拠を残す方式。
6. `bestofn-*`: 複数候補、明示的な変化軸、匿名化、採用後の対応表開示。
7. `.fable/last-plan.md`: 動画の理解を助ける比喩、ループ構造、人間の役割の設計。
8. 多数の `CLAUDE.md`: 33件はすべて同じSHA-256の169-byteプレースホルダー。そのうち`yt-quality-loop`または`yt-loop`をpathに含む21件も全て169 bytesの`CLAUDE.md`だけで、実行コードや有効なSkill本文はない。

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
- 2026-07-12 21:37:58: `akapen-repo`はcommit `a6a8277`のみ。`.git`と`.DS_Store`を除く`akapen-main`と`akapen-repo`の実体は完全一致する。`bestofn-main`は当時のcommit `59b6ba8`に対応するが、`bestofn-repo`は2026-08-28に2 commit追加され、HEADは`dca527a`。実体差分は`bin/bon.js`のみ（52行追加・1行削除）で、音声再生とその2 self-test gateが追加されている。
- 2026-07-23: 元のnote記事`19.md`・`20.md`が保存された。現物は`.hiroya_obsidian_work/backups/`に残る。
- 2026-07-24: `X記事_ハーネスエンジニアリング.md`が追加され、外部状態、生成/評価分離、停止条件、人間判断の設計が長文で統合された。
- 2026-08-10〜08-12: 実質的な本文追加は確認できず、更新は主にFinderの`.DS_Store`だった。
- 2026-08-28: `vtt_to_markdown.py`がrootの`19.md`・`20.md`を調査動画1本目・2本目の字幕変換物で上書きした。元のnote記事はbackupに残るが、root版は差し戻されていない。同日、`bestofn-repo`に音声対応の2 commitが追加された。

## 調査動画64本との照合

VTTはYouTubeのローリング字幕で重複行が多いため、出現回数ではなく「その語を含む動画数」で照合した。主要概念の文書カバレッジは、評価64/64、チェック63/64、人間45/64、エージェント44/64、ログ36/64、フォルダ33/64、スキル24/64、指示24/64、ルール23/64、失敗23/64、判断21/64、記憶16/64、仕組み14/64、プロンプト13/64、反復13/64、テンプレート11/64、レビュー11/64、ループ10/64、自動化10/64、品質10/64だった。

したがって、単発の表現ではなく、資料群と調査動画の双方で反復された「外部状態・評価分離・ゲート・上限・証拠」を移植対象とした。

## 同梱コードから採用した設計

### akapen

- 3±1問に絞る。
- 推奨選択肢を先頭に置く。
- 回答途中をローカル保存する。
- 回答はDOMの`textarea.value`として組み立て、クリップボード失敗時もtextareaに残す。下書きは`localStorage`に残るが、外部台帳への証跡保存や機密情報のサニタイズを自動で行う実装ではない。

このプロジェクトでは、人間への質問UIを直接コピーせず、品質ループの終了理由を `human-review` へ限定し、機械ゲート通過前に人へ聞かない設計へ置き換えた。

### bestofn

- 2〜5候補を基本とする。
- 候補名、モデル名、パスから出所が漏れない匿名ラベルを使う。
- 採用ラベル確定前に秘密対応表を評価者へ渡さない。
- 生成失敗、空出力、パストラバーサル、巨大入力、偽の採用記法、サーバー重複起動などを自己テストする。

`bestofn`には`LICENSE`/`COPYING`/`NOTICE`、`package.json`のlicense field、READMEのlicense表示のいずれもない。そのためBuzzAssistはコードを同梱・コピーせず、匿名比較と安全境界は独自実装し、必要時だけ外部CLIを補助ビューアとして呼ぶ。

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

v3ではさらに、全rubric項目、generatorと異なる実Codex task/Claude session context、具体的なメモ、実ファイル再hash済み証拠、証拠Merkle rootを必須にした。不合格roundはfailure fingerprintを持ち、再試行は直前fingerprintと修正差分を参照する。時間は呼び出し側の自己申告加算ではなく`startedAt`からの観測時刻で判定する。

### 判断ルーターと承認証跡

- 外部テストで一意に決まる判断は機械ゲートへ送り、人へ質問しない。
- 単一提案の曖昧点は赤ペン型の3±1問へ圧縮する。
- 主観・ブランド・有料で複数候補がある判断はhuman Best-of-Nへ送る。
- rubricで比較できる低リスク判断だけfresh evaluatorのblind Best-of-Nへ送る。
- 匿名候補は2〜5件、`variationAxis`重複禁止、artifact必須。公開packetはA〜E・匿名artifact・SHA-256だけ、provider・元ファイル・内部ID・生成順・variation axis対応表は別のprivate mappingへ物理分離する。対応表は`setId`、採用ラベル、判定者、時刻、具体的理由を持つverdict確定後だけ開示する。キャラクター画像と音声試聴MP3の双方で実ファイルhashを採用前に再検証する。
- 漫画動画ハーネスのキャラクター承認CLIは`--approval-reason`を必須にし、声の採用も`selectionReason`と人間reviewerをレジストリへ保存する。

### 最終品質決定

`quality-harness-final`を事前ゲートの別名として扱う経路を廃止した。公式`koya-manga-video.mjs audit`の最後で、自分自身を除く全必須監査を集約し、各適用監査の証拠ファイルSHA-256、正本契約digest、実MP4 SHA-256、証拠Merkle manifestへ拘束した`final-decision.json`と`quality-loop-state.json`を作る。generatorとreviewerのhost・ID・context IDが同じなら、表示名を変えても拒否する。

- 全監査と知覚署名が揃う: `passed`
- 機械監査は全合格で知覚署名だけ未完了: `needs-human-approval`
- 監査欠損・不合格・証拠hash欠落: `blocked`

空の`active`状態は完成証拠にならず、standalone preflight CLIの`--stage final`も拒否する。

### 事故知識の昇格

`recordMangaQualityIncident` は同一signatureの再発数を数える。

- 1回目: checklist
- 2回目: instruction
- 高影響かつ機械判定可能な事故が2回: hard-gate

一般化済み事故はtracked seed `config/koya-manga-quality-incidents.json`へ同梱し、無視対象の実行時台帳とマージする。強い昇格状態を弱いローカル記録で上書きしない。例として表示末尾句点は2回の再発でhard gateへ昇格済みである。

### 制作DAG

`lib/mangaProductionDag.mjs` をv4へ更新し、`lib/koyaMangaDagRuntime.mjs`の組み込みhandlerをCLI/MCPの既定へ接続した。handlerのないproduction nodeを成功扱いせず、画像、音声、cut MP4、最終MP4、最終監査の実ファイルを再検証する。

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

- 同じ本文の`akapen-main`/`akapen-repo`複製: 実体が同一のため二重導入しない。`bestofn-main`/`bestofn-repo`は同一ではなく、音声対応済みのrepo版だけを現行参照とする。
- `yt-quality-loop`: **このフォルダー（`~/まさお`）の中の**関連path 21ファイルはすべて同一の169-byte`CLAUDE.md`で、ここに実行コードは無い。ただし**実装そのものは別にある**（2026-09-25 訂正）。別の作業フォルダーの独立したリポジトリ（1.8.x）が本体で、Claude Code / Codex のプラグインとして Stop / UserPromptSubmit フックとスキルを入れる。BuzzAssist へは移植せず、`operator-production`でも hard deny のまま。フックが制作 Job へ介入するかの確認と doctor の検査は`docs/buzzassist-video-harness-master-roadmap-ja.md`の該当項目にある。
- YouTube Analytics経路: 調査記事に分析の概念はあるが、このフォルダーに認証済みAnalytics connector/pluginの実装はない。BuzzAssistの`operator-production`も`yt-analytics*` / `yt-quality-loop*` / `youtube-analytics*`をhard denyしており、本統合の対象外とする。
- 無限自己改善: 費用と時間を浪費し、品質の自己申告を強めるため不採用。
- 生成AIによる自己合格: 独立評価の原則に反するため不採用。
- 画像モデルへの日本語吹き出し生成: 文字破綻と修正不能を招くため禁止。
- ~~`bestofn` コードの直接コピー: 明示ライセンスが見当たらないため、概念だけを独自実装。~~
  **2026-09-01再確認**: 権利者とつながるユーザーの判断はローカル利用の許可として扱うが、それ自体は再配布可能なライセンス文ではない。`bestofn`は依然として明示ライセンスなし。`akapen`はREADMEとplugin manifestでMITを宣言するが、同梱ツリーにMIT全文の`LICENSE`はない。どちらもBuzzAssist配布物へコードを同梱せず、ローカルの外部ツール/参照としてのみ扱う。bestofn 3 skill (`run-bestofn`,
  `run-bestofn-auto`, `run-bestofn-multi`) と akapen skill のrepo版は `~/.claude/skills/` に導入済みで、`~/.codex/skills/`からはそれらへsymlinkされている。別系統の`~/.agents/skills/`は下記の通り一部内容が異なる。
  音声未対応のmain版self-testは73/73、音声対応済みrepo版は75/75。ハーネス側は
  `scripts/koya-open-blind-arena.mjs` (公式 blind packet のビューア) と
  `scripts/koya-blind-review.mjs` (パケット外の匿名比較) で接続し、**判断の記録は公式CLI**に残す。
- akapenの質問を毎工程へ増やすこと: 機械検査できない高コスト判断だけに限定する（この方針は継続）。

## 2026-08-28 全件再照合（2026-09-01独立再監査で訂正）

`~/まさお` の資産を用途別に突き合わせ、正式採用・補助ツール・参照のみ・対象外を分離した。

| 資産 | 状態 |
|---|---|
| note記事 `1.md`〜`18.md`、backupの`19.md`・`20.md`、他者記事 `84.md`〜`88.md` | 設計原則の参照元。他者記事は出所を保った参照のみとし、BuzzAssist配布物へ本文を複製しない |
| 現在のroot `19.md`・`20.md` | **参照のみ**。元のnote記事ではなく、調査動画の第1・第2字幕変換物。`source_subtitle`と`subtitle_lang`を持つ第三者素材として分離する |
| `X記事_ハーネスエンジニアリング.md` の3原則 | 「できましたを信じない」=hard gate群、「作った本人にチェックさせない」=generatorEvaluatorSeparation、「お願いは負け、仕組みが勝ち」=事故のchecklist→instruction→hard-gate昇格として実装済み |
| `bestofn` | **補助ビューアのみ**。repo版75/75を現行参照とし、`koya-open-blind-arena.mjs`と`koya-blind-review.mjs`から外部CLIとして呼ぶ。正式Harnessの自動DAG node・完了判定・正本台帳にはしない |
| `akapen` | **設計方式の参照のみ**。3±1問、推奨既定値、回答後に着手する原則は採用。ユーザーglobal skillは正式Harnessの`operator-production`には入れない |
| `.fable/last-plan.md` | 制作AI／審査AI／審査基準書／人間の4部品構成と Human in/on/out の切り分けは品質契約とループ状態に反映済み |
| `.hiroya_obsidian_work` 字幕64本 | **第三者調査素材として参照のみ**。VTT 64組はすべて残り、rootへのMarkdown変換は`19.md`・`20.md`の2本だけが現存する。残り62本はroot Markdownになっていない。`vtt_to_markdown.py`は既存の数字ファイルを上書きするため実行しない。利用は別ディレクトリ・出所明記・引用の範囲で、かつ明示の指示があるときに限る |
| `yt-quality-loop` / `yt-loop` 関連 | **不採用**。このフォルダーの関連21ファイルは全て169-byteの同一`CLAUDE.md`プレースホルダだが、実装は別リポジトリ（1.8.x、Claude Code / Codex のプラグイン）に存在する（2026-09-25 訂正。以前は「実装不在」と書いていた）。本番へは入れず、フックの介入は doctor の`yt-quality-loop-hooks`で知らせる |
| YouTube Analytics | **対象外**。本資産に認証済みAnalytics実装はなく、`operator-production`でも関連selectorをhard deny |
| `plugins/`・`e2e-*`・`docs/`・`scripts/` の配置痕跡 | **参照のみ**。ディレクトリ自体は存在するが、中身は上記の`CLAUDE.md`プレースホルダだけで、導入できる機能実体はない |

## 2026-09-01 独立再監査の統合境界

「まさお」資産をそのまま本番コードと見なさず、原則、外部補助ツール、配布可能なBuzzAssist正本を分離する。

| 原則 | 漫画（Koya） | ナレーション（narrated/Mike） | 共通層 |
|---|---|---|---|
| 有料呼び出し前にfail closed | 公式Koya CLIのpreflightと必須品質gate | 署名済みChannel Packから非秘密のadapter identityを固定し、実provider未接続の間は`implementation-in-progress` | `lib/paidMediaJobBroker.mjs`の無課金capability probe、request identity、冪等journal、有限retry |
| DAGと停止条件 | 品質契約、上限付き品質ループ、独立監査、`quality-decision` | `lib/narratedStoryPipeline.mjs`がraw script→media→render→automatic auditを管理し、外部signoffが無ければ完了しない | `lib/videoHarnessJob.mjs`の永続Job、CAS cancel/resume、Channel Pack差し替え拒否、成果物累積、完了前Canvas投影 |
| 生成者と評価者の分離 | 生成contextと異なるcontact-sheet/全尺review、SHA拘束 | `reviewerContextId`をproduction jobと分離し、実MP4とcontact sheetのSHAへ外部signoffを拘束 | 共通receiptとCanvas adapterが人間/独立agentのevidenceを要求 |
| 外部状態と操作可能な証拠 | 公式manifest、audit証拠、実MP4/contact sheet | state、audit report、run receipt、MP4/contact sheet/audio/subtitle | Canvas Run/Media projectionはSHA確認済み成果物をcontent-addressed assetにし、revision/fingerprint競合を拒否 |
| Best-of-N | 必要な人間選択でのみ外部arenaをビューアとして使う | 共通DAGの必須nodeにはしない | 正式完了証拠はBuzzAssistのSHA拘束receipt/signoff。`.bon`の選択状態を正本にしない |

### Best-of-N runtime resolverとhost可用性

- `lib/bestOfNRuntime.mjs` は `BON_CLI` → `BESTOFN_ROOT/bin/bon.js` → project内`node_modules` / `tools` → `bon`のPATH順で解決する。JavaScript fileは現在の`process.execPath`で起動し、`execFile`でshellを使わない。`~/まさお`の暗黙探索は削除したため、古いmain版を本番が偶然拾うことはない。
- 当該マシンではNode `v20.19.1`、Claude Code `2.1.197`、Codex CLI `0.144.1`を確認。`bon`自体はPATHにないため、ラッパーを使うときは`BON_CLI`または`BESTOFN_ROOT`の明示が必要。
- Claudeの`~/.claude/skills/{akapen,run-bestofn*}`はrepo版とSHA-256一致。Codexの`~/.codex/skills/`はそれらへのsymlinkを持つが、別の`~/.agents/skills/`に同名の一部改変版もある。特に共有`run-bestofn-multi`は本来の「Claude×2 + Codex×2」を「Codex×2 + Codex×2」へ変えており、クロスベンダー多様性を保証しない。ユーザーglobal資産はこの監査では変更しない。
- `operator-production`はAkapenと`run-bestofn*`を正式能力として許可しない。`run-bestofn*`は`buzzassist-development`だけの条件付きselectorであり、本番Harnessの一部ではない。

### クロスOS・セキュリティ・ライセンス

- Akapenの手順はmacOS `open`、Linux `xdg-open`、Windows `cmd /c start ""`を書き分け、HTML本体は外部依存なし。一方、回答下書きを`localStorage`に残し、CSPを持たないため、機密値をフォームに入れない、信頼できないHTMLをテンプレートへ混ぜない、使用後の下書きをブラウザ側で管理する必要がある。
- Best-of-NのNode coreは依存ゼロで、既定loopback、DNS-rebinding guard、Origin/content-type/body-size/path-key検査を持つ。ただし`--host 0.0.0.0`は無認証で、同一LANの利用者が候補を読み、採用を書き込める。本番/機密レビューでは使わない。
- live arenaのHTML候補は`sandbox allow-scripts`だけで、外部network loadを禁止する`default-src 'none'`はない。静的`bon export`は候補iframeへ`default-src 'none'` / `connect-src 'none'`を挿入する。信頼できないHTML候補はlive arenaで開かない。
- upstream READMEはWindows未検証を明記し、`bon-anonymize`と`bon-gen-codex`はBash専用。`bon.js` のWindowsブラウザ起動は`start`を直接spawnするが、`start`は通常`cmd.exe`の組み込みなので`--open`の動作保証がない。Windowsでは`BON_CLI`に絶対`bon.js` pathを指定し、表示されたURLをhostのBrowserで開くのが安全な境界である。
- `.hiroya_obsidian_work/vtt_to_markdown.py`は読み取り専用ではなく、既存の`19.md`以降をbackup後に上書きする変換scriptである。dry-runや出力root引数がないため、本監査では実行せず、正式Harnessへも接続しない。
- AkapenはMITと宣言するが全文license fileがなく、Best-of-Nはライセンス自体が未宣言。よってBuzzAssist packageにはどちらのコードも再配布しない。

## 実データ確認

`manga-photo-homecoming-001` の実MP4を現行v50へ同期し、公式最終監査を二段階で実証した。

1. 旧知覚署名のまま監査すると、機械監査15項目と全尺デコードは合格したが、契約digest不一致を検出。`final-decision.json`は`needs-human-approval / perceptual-signoff-required`で停止し、`quality-harness-final`も不合格になった。
2. 同一MP4 SHA-256、実MP4由来contact sheet、代表フレーム、v50契約digestへ拘束したCodex知覚レビューを作成し、再監査した。最終17監査は17/17合格、`quality-harness/final-decision.json`は`passed`、16独立監査証拠は全件SHA-256付き、`knownRemainingIssues=[]`、manifestは`final-koya-audited`になった。

実証値:

- 契約: `koya-manga-production-v50`
- エピソード固有契約digest: `76f143ce214ed0f6448b41e3835a7b65a156a11cdb3f0e9b5f550c598cff5431`
- 実MP4 SHA-256: `5a1df1c01a2dd0d49f31a03a39747542496e5a897ebce09b41855564f063709a`
- 実デコード尺: `149.087696`秒、1920×1080、30fps、H.264/AAC
- 最終監査: 17/17、品質決定証拠: 16/16、未解決事項: 0

この時点の検証は全491リポジトリテスト、公式`skill-creator` validatorによる制作・カメラ両スキル、Node構文検査、`git diff --check`でも合格した。以後の荒野編修復で追加した回帰テストは最終検証値へ更新する。

## 未見canaryから追加した恒久ゲート

v50の完全未見台本では、機械監査だけでは拾えない実MP4上の退行を、生成担当とは別のCodex contextが検出した。修正前レビュー自体を失敗証拠として保存し、次をハーネスの既定動作へ戻した。

- 分割ページはpanel単体の顔座標を信用せず、黒ガター合成後の1920×1080完成ページから全顔在庫を作る。同じ発話に複数顔があっても固有annotation IDで保持し、0件なら停止する。
- 縦書きセグメントは文字数だけで切らない。日本語の語境界を使い、固有名詞、複合語、活用語、助詞・助動詞の直前を切った`佐藤誠／司`、`利／用`、`回数／券`、`数／字`、`通院す／る`のような分割をhard gateで拒否する。
- cascadeが吹き出し輪郭を顔と誤認した場合、表示直前・直後のclear frameに同じ光学座標の顔が存在するかを独立照合する。両方に無い80%以上被覆候補だけをoverlay由来artifactとして除外し、実顔は除外しない。
- ナレーション比率が高い長編を発話ごとに75枚切り替えない。隣接ナレーションと台詞を最大2発話で共有し、ナレーション先行でも台詞人物が写る承認済みページを代表画にする。編集監査の複数発話共有率と保持中央値を実MP4から再計測する。
- 旧作品を現行契約へ移行するときは生成者を現在のtaskへ付け替えない。stateに残る実legacy provenanceを計画へ永続化し、承認済みWAVは発話ID・表示文・読み適用後speech text・voice ID・model・実ファイル・alignment pathが完全一致したものだけ復元する。

これにより、失敗レビューは「当該動画だけの修正指示」ではなく、source face、組版、レンダー顔監査、編集テンポ、移行保全の回帰テストと日本語スキル指示へ変換される。

未見canaryの完成MP4はSHA-256 `171154a74079bd7fd66c9ace18a8724272f6be214512562b316de254ac8d6b1d`、44.687696秒で、公式17/17監査、別Codex context `019ff803-e496-7b71-917b-0aa390689734`の全尺レビュー、`knownRemainingIssues=[]`まで到達した。

## 荒野長尺編の二段階独立レビュー

75発話・約9分の`manga-arano-amane-effort-001`では、短編とcanaryの合格だけでは発見できなかった長尺固有の失敗を、別Codex contextの全尺レビューで二段階に検出した。

1. context `019ff988-7158-70c0-85c1-ae8e771fa009`は、主人公顔への四角ナレーション枠、スマホ・地球儀・世界地図への吹き出し、子供二人の台詞と夫婦だけの画面という5件を検出した。修正前fail JSONは削除せず証跡として保存した。
2. 5件修復後のcontext `019ffa57-ac18-70b3-bc4b-cc55f453d23b`は、旧5件の修復を確認した一方、45.802〜58.092秒の頭髪重なりと約282秒の目・顔重なりを新たに検出し、13チェック中2件fail、`knownRemainingIssues` 2件として再び停止した。

二度目の停止から次を新規台本の既定へ一般化した。

- 自動cascadeの最大顔には人物同定能力がない。画像SHA-256拘束の手動発話者顔がある場合は、auto hitが存在してもprimaryを必ず上書きする。auto hit自体は非話者hard obstacleとして残す。
- 二人画面は発話者だけでなく全人物の頭部を在庫化し、カメラ33点の全区間へ投影する。
- `purpose-reflection`ナレーションは直前の混雑した対話画像へ統合せず、既に承認された専用画像を保持する。専用画の追加で後続カメラ多様化列をずらさない。
- 画面端の対話話者は、反対側から横断するカメラを使わず、話者を全区間可視に保つanchored pull-outへ固定する。
- flatten済み分割ページは方向移動で可視窓を狭めず、中央pull-outへ固定しつつ、後続の多様化順序は維持する。

最終MP4のSHA・独立review context・公式監査値・DAG結果は、修復後の最終レビュー完了時点でこの節へ固定する。
