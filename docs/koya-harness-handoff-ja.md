# 漫画動画ハーネス 引き渡し手順

## 結論

MCPだけを渡すのでは不十分です。引き渡し単位はBuzzAssistプラグインです。プラグインにはMCP、必須skill、正本契約、公式CLI、監査コードを含め、案件固有の人物・背景・承認証拠は別のデータ束として渡します。

MCPは「受領側AIがどの公式処理を呼べるか」を提供する操作口です。MCP単体には、skillsの制作判断、正本contract、CLI実装、承認済み画像の実ファイル、SHAレビュー、更新・ロールバック機構が入りません。したがって、`plugin + 案件データ束`を渡し、MCPはその上で操作に使います。

## 渡すもの

1. 安定版GitHub ReleaseのBuzzAssistプラグイン
2. 案件固有データ: 承認済み`canvas/characters.json`、承認画像、SHA拘束review、visual profile、show/location/thumbnail bible
3. 引き渡し時点のcontract version/digestと`koya_manga_doctor`結果
4. 人間承認待ち一覧。候補対応表や未承認画像を「採用済み」として混ぜない

資格情報、Claude/Codexのセッションログ、個人用canvas全体、API tokenは渡しません。

## 案件データ束の作成

固定11人が全員登録される前は、最終案件データ束を「完成版」として渡しません。現時点のように4/11登録の段階では、次の2つを分けます。

1. ハーネス本体: stable BuzzAssist plugin release。MCP、skills、CLI、contract、監査コードを含む
2. 確認用パケット: 赤帯の未承認QA sheet、合格済み選択sheet、承認依頼文。人物台帳へrestoreする案件データ束ではない

運営者の選択、人物パック、全11人55ペアreviewが完了してから、下記の公式handoff bundleを作ります。

送付前に、制作PCで公式CLIから束を作り、その場で検証します。

```bash
node scripts/koya-manga-video.mjs handoff-export \
  --project-dir /absolute/path/to/koya-project \
  --output-dir /absolute/path/to/delivery/koya-handoff-v2

node scripts/koya-manga-video.mjs handoff-verify \
  --bundle-dir /absolute/path/to/delivery/koya-handoff-v2
```

この束には、show/location/thumbnail bible、キャラ微調整spec、承認済み人物台帳とその実asset、移送用review attestation、locked visual profile、contract snapshotを含めます。承認済みロケーション（背景ボード）も同じ台帳に載せて運びます。location bibleが宣言する場所だけを対象に、4枚の実ボードと`koya-handoff-location-review-attestation-v1`（元reviewのSHA-256、審査の判断、ボードごとのSHA・寸法・出所種別を残し、絶対pathと生のreviewer/generator/importer識別子は除く）を含め、ボードやattestationの欠落・改ざんはexport/verifyで拒否します。ロケーションを持たない旧版の束はそのまま検証できます。加えて、固定11人の同時比較sheetと、11人全員・全55ペア・原寸/サムネ縮小確認・独立reviewer contextを拘束した`koya-handoff-roster-review-attestation-v1`を必須で含めます。欠落、一部人物だけのexport、episode専用人物、古い人物assetを参照するreview、再hashされた不合格pairのいずれもexport/verifyで拒否します。attestationは元reviewのSHA-256と判断snapshotを残しつつ、送信元端末の絶対pathと生のagent/session識別子を除去します。`character-workflows.json`、候補のprivate mapping、未承認人物、他案件人物、未使用voice、セッションログ、資格情報は含めません。

### 声の人選記録

漫画動画ハーネスの制作ラインは、声を自動では決めません。話す人物全員と主人公（ナレーションは主人公の声で読む）について、人が2候補以上を匿名で聴き比べて選んだ記録が台帳に無いと、有料の画像生成の前（新しい回）、manifest作成時、有料の音声生成の前のいずれかで止まります。上位Jobは失敗ではなく承認待ち（`awaiting-human-review`）になり、止まった理由には選定が必要な人物IDと記録コマンドが入ります。

- 束に入る声の情報は、人の選定記録から作った`koya-handoff-voice-selection-v1`だけです。採用者・採用理由・候補集合IDはSHA-256に置き換え、採用ラベル、候補表、試聴URL、score、personaは入れません。自動選定の記録や項目が欠けた記録は束に入れません。`handoff-verify`はこの形以外の`casting`を拒否します
- 上位Jobは実行と再開のたびに束の人物と声を作業場の台帳へ上書きで戻します。束から来た人物の声を受領側の作業場で選んでも、次の再開で消えます。声は送り手の制作PCで`node scripts/build-manga-video.mjs voice-library-audition`→全候補の試聴→`voice-library-approve`で記録し、`handoff-export`で束を作り直して署名し、新しい束で新しいJobを開始します
- 回ごとに作業場で登録した人物は束で上書きされないので、作業場で選定を記録し、同じJobを再開できます
- この記録が入る前に作った束では、全員の声が「選定記録なし」になり、音声生成へ進めません。上の手順で束を作り直します

内側の`manifest.json`のdigestと各file SHA-256は完全性検査であり、送り手の本人性を証明する署名ではありません。本番用には、この検証済みbundle全体を既存のEd25519 Channel Pack envelopeへ入れます。秘密鍵は送信側だけに置き、公開鍵はbundleとは別経路で受領側へ渡します。

```bash
node scripts/channel-pack.mjs sign \
  --source-dir /absolute/path/to/delivery/koya-handoff-v2 \
  --output-dir /absolute/path/to/delivery/koya-signed-envelope \
  --id operator-channel-pack \
  --version 1.0.0 \
  --harness koya-manga-video \
  --payload-kind koya-handoff \
  --private-key /secure/path/to/ed25519-private.pem

node scripts/channel-pack.mjs verify \
  --bundle-dir /absolute/path/to/delivery/koya-signed-envelope \
  --public-key /trusted/path/to/ed25519-public.pem \
  --harness koya-manga-video
```

`run-video-harness`は外側の署名と全payload SHAを検証した後、内側のhandoff manifestとroster attestationを再検証します。手動転送で通常のZIPを使う場合も、受領側の`handoff-verify`は省略できません。

MCPからは`run_koya_manga_pipeline`へ`action: "handoff-export" | "handoff-verify" | "handoff-restore"`を渡して同じ公式処理を呼べます。export/restoreは書き込みなので`confirmed: true`が必要です。MCP専用の別実装はありません。

## reviewer 信頼リストの受け渡し

最終監査とRunReceiptは、contact-sheet signoffのEd25519 reviewer attestationを信頼リスト
（`koya-reviewer-trust-v1`）で再検証します。規則の正本は
`.agents/skills/platform-craft/SKILL.md`の「独立レビューの署名（reviewer attestation）」です。
引き渡しで守ること:

- 信頼リストは**生成を行う端末・エージェントとは別の主体（owner）だけが設定**し、監査・Receiptを
  実行する側へ`BUZZASSIST_REVIEWER_TRUST`（JSON fileのpath）として別経路で配ります。
  **この env が唯一の信頼アンカー**です。Channel Pack bundleやhandoff bundleの中に入れず、
  signoff内の鍵も信頼しません。旧名`BUZZASSIST_KOYA_REVIEWER_TRUST`は互換で読みますが、
  新旧で内容が違えば`reviewer-trust-invalid:env-ambiguous`で拒否されます
- CLI / MCP / Job実行時引数の`--reviewer-trust-path`（`reviewerTrustPath`）は**照合用**です。
  env の信頼リストと内容（正規化sha256）が一致しなければ`reviewer-trust-conflict`で止まり、
  env が未設定なら明示pathがあっても`reviewer-trust-unconfigured`で止まります。受領側の
  生成端末が自分でpathを指して信頼アンカーを立てることはできません。Job `options`に
  `reviewerTrustPath`や`reviewerPrivateKeyPem`を書くとJob作成前に拒否されます
- reviewer秘密鍵はリポジトリ外に置き、送付物・bundle・canvas・Job workspaceへ含めません。
  中身をargv・MCP引数・Job optionsへ載せず、`--reviewer-key-path`のpathだけを渡します。
  受領側で新しいreviewerを立てるときは`reviewer-key-create`（CLI: `koya-manga-video.mjs` /
  `narrated-story-video.mjs`、MCP: `create_video_harness_reviewer_key`、`confirmed: true`必須）で
  鍵を作り、出力された`trustEntry`（公開鍵だけ）をownerへ渡して登録してもらいます。signoffの
  MCP入口はKoya Jobが`run_koya_manga_pipeline action=signoff`、narrated Jobが
  `signoff_video_harness_job`で、引数名（`reviewerKeyPath`, `reviewerContextId`, `reviewerTrustPath`）は
  共通です
- MCP hostへの信頼リストの届け方: MCPサーバーはhostが起動する子processで、届くenvはhostごとに違います
  （実測: Claude Codeはhostのprocess envを全部継承、Codexは最小envのみで、サーバー定義の`env_vars`に
  名前を挙げた変数だけを転送）。setupは`~/plugins/buzzassist/plugin/.mcp.json`の`buzzassist_mcp`と各hostの
  `mcpServers`登録へ`env_vars`（信頼リストenvの**名前だけ**）を自動で付けます。**値はCodex / Claude Codeを
  起動するシェル・launcherのenvにownerが置き**、設定fileの`env`へは書きません（書くとsetupが
  `reviewer-trust-in-config`で拒否し、再生成で消えます）。置いた後はhostを再起動します。手順の正本は
  `.agents/skills/platform-craft/SKILL.md`の「MCP host へ信頼リストを届ける」
- 失効はownerが`status: "revoked"`＋`revokedAt`＋`reason`に変えて配り直します。
  失効鍵の署名は署名日時に関係なく拒否されます
- 信頼リスト未設定の環境ではsignoffは不合格になります（fail-closed）。「設定が無いので
  検証を省いた」状態は存在しません

## Receipt確定で止まったJobの復旧

有料生成が終わった後に、信頼リスト未設定・conflict・attestation欠落などの設定/証跡側の失敗で
RunReceiptが確定できない場合、Jobは`failed`にならず、**`awaiting-human-review`に
`pendingReceiptFinalization`を持って止まります**。成果物・Media Job・課金は済んでいるので、
`node scripts/run-video-harness.mjs resume --job-id ID --project-dir DIR --confirmed`
（MCPは`resume_video_harness_job`、`confirmed: true`必須）は**Receiptの確定だけ**を再試行し、
何も再生成・再課金しません。`start` / `resume` の `--reviewer-trust-path JSON`（MCPの
`reviewerTrustPath`）は照合用で、上位Jobから子CLIへも同じpathが渡ります。

| blocker / エラー | 復旧 |
|---|---|
| `reviewer-trust-unconfigured` | ownerが実行側endの`BUZZASSIST_REVIEWER_TRUST`を設定してから`resume`。MCP経由ならhostを起動するenvに置いてhostを再起動（設定fileの`env`には書かない） |
| `reviewer-trust-conflict` | 実行時引数の`--reviewer-trust-path`を外す（またはenvと同じ内容を指す）。envは書き換えない |
| `run-receipt-artifact-drift` | 確定待ちの間に成果物SHAが変わった。productionは自動再実行されず、`resume`は同じblockerで止まり続ける。**唯一の出口は、宣言（`config/harnesses/<id>.harness.json`）と成果物を直したうえで新しいJobを作る**こと。旧Jobは`awaiting-human-review`のまま証跡として残す。課金は`requestKey` journal（同じinput/provider/model/voice/paramsは同じrequest key）で再利用され、済んだMedia Jobを再submitしない |
| `reviewer-attestation-unsupported-harness` | harness宣言（`config/harnesses/<id>.harness.json`）に`reviewAttestation.subject`が無い／未知。**宣言を直してから新しいJobを作る**。resumeでは直らない |

## 途中で止まった・失敗したJobの再開

どの場合も入口は同じ `node scripts/run-video-harness.mjs resume --job-id ID --project-dir DIR --confirmed`
（MCPは`resume_video_harness_job`、`confirmed: true`必須）です。再開のたびに doctor を測り直し、
完成済みの有料 Media Job は記録された `requestKey` で再利用するので、払い直しません。

| 止まり方 | 何が起きたか | 再開のしかた |
|---|---|---|
| `failed` | 子が例外で落ちた（回線切れ・機械の停止など）。`failed` は終端ではない | そのまま `resume`。落ちた工程から再開し、再開した事実（前回の失敗、再利用／再発行した Media Job）が Job と RunReceipt に残る |
| 画像の一部が失敗のまま | 画像台帳に `failed` の行が残っている。通常の `resume` はそれを作り直さない | `resume` に `--retry-failed-images`（MCPは`retryFailedImages: true`）。失敗した画像だけを同じ Job のまま作り直す。Job の識別子には入らず、使った事実と作り直した枚数が台帳と RunReceipt に残る |
| `paid-media-recovery-pending` | 提供元が受理した可能性のある Media Job がある（課金の有無が未確定） | 仲介の `recover` で決着させてから `resume`。子の journal が既定の場所に無いときは `BUZZASSIST_MEDIA_JOB_STATE_DIR` で指す。決着するまで doctor も adapter も走らない |
| `full-run-lock-held`（人待ち） | 同じ回の制作がもう1本走っている（親だけ落ちて子が生きている等） | 走っている方が終わるのを待ってから `resume`。錠を手で消さない |
| `awaiting-human-review`（声・衣装） | 人が選んだ声の記録が無い、台本が求める衣装が未登録 | 表示される次のコマンドどおりに選定・登録してから `resume` |
| `video-harness-failed-job-unrecoverable` | Job の記録が壊れている、作業フォルダが無い等 | 再開できない。理由を読んで新しい Job を作る |

## Claude Codeへ導入

受領側PCでリポジトリを取得し、リポジトリ直下から実行します。

```bash
node scripts/setup-agents.mjs --agent claude --project-dir /absolute/path/to/koya-project
```

完了条件は、Claude Codeが`configured`、`BUZZASSIST_CANVAS_URL=...`、`BUZZASSIST_CANVAS_CHECK=ok`、`BUZZASSIST_AUTO_UPDATE=enabled`と表示されることです。導入後は新しいClaude Codeセッションを開始し、返されたCanvas URLをClaude Code内ブラウザで開きます。

## Codexへ導入

```bash
node scripts/setup-agents.mjs --agent codex --project-dir /absolute/path/to/koya-project
```

同じ4条件を確認し、新しいCodexタスクを開始してCanvas URLをアプリ内ブラウザで開きます。

## 初回確認

1. `koya_manga_doctor`を呼ぶ
2. 展開した案件データ束を`handoff-verify`する
3. `handoff-restore --bundle-dir ...`、またはMCPの同actionで案件データを復元する。導入済みproduction contractとsnapshotが違えば停止する。復元は隔離stageで正本と11人/55ペアreviewを監査してから一括適用し、受領先での再監査が失敗した場合は変更対象をrollbackする
4. `open_buzzassist_canvas`で案件canvasを開く
5. `run_koya_manga_pipeline`の`contract`を呼び、contract validationがpassであることを確認
6. `channel-contract`を呼び、show/location/thumbnailの3正本が`source=project`かつ全validation passであることを確認
7. 既存episodeは`status`、長時間処理はbackground jobとして開始し、`get_koya_manga_job`で追跡

新規動画は必ず`run_koya_manga_pipeline`または`node scripts/koya-manga-video.mjs`から開始します。`build_excalidraw_manga_video`は漫画動画ハーネス案件に使いません。

## 更新とロールバック

自動更新はstable GitHub Releaseだけを対象にし、staged buildと実MCP callを検証してから切り替えます。失敗時は前版へ戻します。受領側で自動更新を止める必要がある場合だけ、明示的に`--no-auto-update`を使います。

## データの扱い

- 人物登録は実ターンアラウンド8方向、表情12セル、必要な衣装4セル、開眼4セルのv2 reviewが通ったものだけ
- locationは人物なし背景ボードが承認されるまで`approved`登録しない。登録済みロケーションは束に入り、復元先の作業場の台帳へ戻る。台本の場面見出しに書かれた場所名は、location bibleの別名（`aliases`）経由で登録ボードに結び付く
- 公式ルートの外（チャット型の画像ツール）で作った背景ボードは`location-import`で取り込む。取り込みマップ（`koya-location-import-map-v1`）に必須ボードごとの元ファイルとSHA-256、生成に使った会話・製品・時刻、実際に使ったプロンプト、参照画像のSHA-256、取り込んだ人のcontextを書き、継続ビューは取り込むアンカーを建築参照として宣言する。取り込みはアンカー承認を書かないので、この後もアンカー審査・本審査・登録を公式ルートと同じ条件（審査者のcontextは取り込んだ人とすべての外部生成contextのどれとも異なる）で通す。既存のファイルと古いmanifestは`superseded-<日時>/`へ退避し、削除しない。マップの形は`docs/examples/koya-location-import-map.example.json`を参照する（形式例。必須ボードは4枚すべてを1回ずつ書く）
- 記録を残す決まりが無かった頃に作った背景ボードは、プロンプト・会話id・参照画像のどれかがどこにも残っていない。書き起こせば作り話の記録になり、放置すればその場所は永久に未登録になる。そこでボード1枚単位で`provenanceGap`（理由、その絵が満たすべき文書のpathとSHA-256、そして`promptRecorded`・`generatorContextRecorded`・`referenceImagesRecorded`のうち残っていないものを`false`で）を宣言できる。3つの旗は独立で、`false`以外は受けない。宣言した旗ごとに、無いと言った記録そのものを持てなくなる。`promptRecorded`は`promptText`/`promptPath`を、`generatorContextRecorded`は`generator.contextId`を持てない。`referenceImagesRecorded`は`referenceImages`が空でなければならず、アンカー参照も名乗れないので、そのボードはアンカーのSHA拘束を持たない（代わりにアンカーとの建築の一致は、既存のボード単位の確認項目`architectureLockPass`を審査者が目で見て付ける。審査の下書きにそう書く）。`generator`の`host`・`id`・`generatedAt`はどの旗を立てても要る。旗を1つでも立てたボードには確認項目`provenanceGapAcknowledged`が増え、理由と文書を読んだ独立reviewerがtrueにするまで、アンカー審査も本審査も登録も通らない（無記入・falseは不合格）。欠落は生成manifest・審査・台帳の承認・引き渡しのattestationに残る。このとき「欠落あり」へ畳まず、どの旗を立てたかをそのまま運ぶ。verifyは旗そのものを見て、`generatorContextRecorded`を立てたボードの会話idは空でなければ拒否し、立てていないボードには今までどおり一方向tokenを求める。旗を落としたattestationも、旗を書き換えたattestationも拒否する。台帳の承認文も、立てた旗の記録だけを名指しする（プロンプトが残っているボードに「プロンプトが無い」とは書かない）。形は`docs/examples/koya-location-import-map-provenance-gap.example.json`を参照する
- 架空の看板が当然にある場所は、location bibleで`textPolicy: "fictional-signage-allowed"`を宣言する。そのlocationだけ確認項目が`readableTextAbsent`から`readableTextFictionalOnly`（最小限の架空看板のみ、実在の名前・ブランドなし）へ替わる。既定は従来どおり読める文字を認めない
- 相対パスを使い、送り手PCの絶対パスを残さない
- 承認review原文をそのまま移送せず、`koya-handoff-review-attestation-v1`へ変換する。元review SHA・判断snapshot・全承認asset SHAを検証し、assetごとのreview linkが欠けるbundleはexport/verifyで拒否する
- 未承認候補は人間選択待ちとして明示し、MCPやAIが勝手に採用しない
- `character-bootstrap-status`で固定11人のshow bible→workflow→候補review→styling→identity QA→台帳を横断し、人物ごとの次工程を確認する。これは読取専用で、未承認を進めない
- すでに相手へ見せた旧候補シートを正式工程へ移す場合は`character-candidate-migrate-blind --generator-host legacy-migration`を使い、公開済みA〜E、退避するラベル、理由、移行contextを明示する。公開ラベルを振り直さず、旧private mappingとの衝突はmigration reportへ残す。契約上限外の候補を黙ってA〜Eへ詰め直さない
- Codex/Claudeや外部生成器で作った新しい匿名A/B/Cを正式workflowへ取り込む場合は`character-candidate-import`を使う。target `workflowCastId`、候補design specのpath/SHA、生成prompt/model/context/date、各出力path/SHA、公開ラベル対応をsource manifestとimport mapへ拘束する。選択済み人物への上書き、別castの変更、公開ラベルの再シャッフル、旧packetの削除を拒否する
- 未承認の候補横並びは`character-candidate-qa-sheet`、未承認のstyling横並びは`character-style-qa-sheet`を使う。出力は赤帯・`authoritativeApproval=false`・sheet/entry SHA付きで、採用人物参照や合格証拠に使わない
- 髪型・髪色・衣装などのすり合わせは`character-style-generate`→個別原寸QA→`character-style-compose`→人間選択→`character-style-select`。styling review v2で合格案の全ペアに指定軸の可視差・非重複take・同一人物性・変更対象外一致・原寸確認を記録する。同じ設計のtake違いを候補数に数えず、比較シートを人物参照へ使わない
- `character-style-generate`には安定した`--styling-round-id`を付ける。途中停止後は同じspec・generator context・round IDで再実行し、入力SHAが一致するoptionのatomic画像とworkflow checkpointを再利用する。生成済みSHAの変異、別context、別promptでの「再開」は拒否する
- 既存の有料生成済みsheetを再利用する場合は`koya-character-styling-import-v1` mapでoption IDとsource manifest entryを人間が対応付け、`character-style-import --generator-host legacy-migration`を使う。source/output/prompt/model/time/spec/mapをSHA拘束できず、現specの最低候補数を満たさない素材は取り込まない。importは合格や選択を意味せず、通常どおり別contextの原寸reviewが必要
  mapの形は`docs/examples/koya-character-styling-import-map.example.json`を参照する。これは形式例であり、特定キャストの正式選択結果ではない。実行前に各`optionId`と実画像を人間が原寸で対応確認する
- 独立QAを通過していても、後から判明した運営者の明示要件とspecが食い違う場合は、旧合格を削除せず`correctiveSupersedeReason`付き後継roundへ置き換える。旧roundのasset/SHA/review/supersede理由を残し、仕様違反の旧案を採用候補へ戻さない
- 複数属性は1roundで同時決定しない。前roundの人間選択assetを次roundの唯一の基準にする。roundの順序はChannel Packのshow bibleにある各キャストの`stylingSpecPaths`配列順が正本（例: 髪型と共通服形状のround→髪色だけのround→衣装色だけのround）
- styling roundはshow bibleの宣言順、spec path/SHA、characterIdへ拘束し、全round選択済みになるまでidentity packへ進めない。`kind: "outfit"`のstyling specを持つキャストは、採用顔に加えてそのspecが列挙する全衣装のシートを登録する
- `hairColor` roundはラベルやreview文だけで色差を認めない。`character-style-review-refresh`で同じnormalized ROIのmedian CIE Labを実画像から再計測し、全ペアのDelta E 76がspec閾値を満たすことと、別contextの肉眼差を両方要求する。保存値の手編集や画像差し替えは再計測で拒否する
- `character-approve`の有料identity pack生成は人物単位のcheckpointへ、候補SHA、参照SHA、prompt/model/size、generator context、各出力SHAを保存する。停止後は同じ引数・同じcontextで再実行し、一致する生成済み画像だけを再利用する。既存画像だけ、別context、入力変更、digest不一致は再開扱いにしない
- 非類似確認の要件はshow bibleではなく、そのキャストのstyling spec（`stylingSpecPaths`が指すJSON）の`comparisonEvidenceRequired: true`と`comparisonRequirements`が正本である。要件が立っているroundは、比較参照を`canvas/`内へ保存して`--styling-comparison-reference-paths`へ渡す。path/SHAと候補別の原寸非類似チェックが揃わなければ合格しない。比較参照は画像生成入力へ混ぜない
- 固定11人を個別登録しただけで本編制作を許可しない。`character-roster-review-draft`で11人を同一縮尺とサムネ縮小へ並べ、11人個別と全55ペアについてシルエット、顔/年齢/役柄、髪/衣装色衝突、縮小識別性を生成contextと別のreviewerが確認する。`character-roster-audit`がpassするまで`plan/full`を遮断する
- 新規台本は`story-audit`で実台本SHAと逆転beat reviewを固定してから、同じ`--story-review-path`を`plan/full`へ渡す
- 背景は`location-plan`→anchor生成→別contextのSHA拘束anchor review→そのreview pathを必須入力にしたcontinuity生成へ分ける。`all`一括生成は禁止。公式generation manifestにanchor承認、生成context、prompt/anchor/画像SHAを保存し、全生成contextと異なるreviewerが全画像SHA・原寸・人物/文字/実在ロゴ0・建築連続性を通したreviewだけを`location-register`する
- サムネは承認済み帯色/書体、copy SHA承認、専用art、本編sourceとのSHA＋正規化画素差分を`thumbnail-audit`で確認する
