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
  --output-dir /absolute/path/to/delivery/koya-handoff-v1

node scripts/koya-manga-video.mjs handoff-verify \
  --bundle-dir /absolute/path/to/delivery/koya-handoff-v1
```

この束には、show/location/thumbnail bible、キャラ微調整spec、承認済み人物台帳とその実asset、移送用review attestation、locked visual profile、contract snapshotを含めます。attestationは元reviewのSHA-256と判断snapshotを残しつつ、送信元端末の絶対pathを除去します。`character-workflows.json`、候補のprivate mapping、未承認人物、他案件人物、未使用voice、セッションログ、資格情報は含めません。転送時はフォルダを通常のZIPへ圧縮して構いませんが、受領側では展開後に必ず`handoff-verify`を通します。

MCPからは`run_koya_manga_pipeline`へ`action: "handoff-export" | "handoff-verify" | "handoff-restore"`を渡して同じ公式処理を呼べます。export/restoreは書き込みなので`confirmed: true`が必要です。MCP専用の別実装はありません。

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
3. `handoff-restore --bundle-dir ...`、またはMCPの同actionで案件データを復元する。導入済みproduction contractとsnapshotが違えば停止する
4. `open_buzzassist_canvas`で案件canvasを開く
5. `run_koya_manga_pipeline`の`contract`を呼び、contract validationがpassであることを確認
6. `channel-contract`を呼び、show/location/thumbnailの3正本が`source=project`かつ全validation passであることを確認
7. 既存episodeは`status`、長時間処理はbackground jobとして開始し、`get_koya_manga_job`で追跡

新規動画は必ず`run_koya_manga_pipeline`または`node scripts/koya-manga-video.mjs`から開始します。`build_excalidraw_manga_video`は漫画動画ハーネス案件に使いません。

## 更新とロールバック

自動更新はstable GitHub Releaseだけを対象にし、staged buildと実MCP callを検証してから切り替えます。失敗時は前版へ戻します。受領側で自動更新を止める必要がある場合だけ、明示的に`--no-auto-update`を使います。

## データの扱い

- 人物登録は実ターンアラウンド8方向、表情12セル、必要な衣装4セル、開眼4セルのv2 reviewが通ったものだけ
- locationは人物なし背景ボードが承認されるまで`approved`登録しない
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
  mapの形は`docs/examples/koya-character-styling-import-map.example.json`を参照する。これは形式例であり、ももの正式選択結果ではない。実行前に各`optionId`と実画像を人間が原寸で対応確認する
- 独立QAを通過していても、後から判明した運営者の明示要件とspecが食い違う場合は、旧合格を削除せず`correctiveSupersedeReason`付き後継roundへ置き換える。旧roundのasset/SHA/review/supersede理由を残し、仕様違反の旧案を採用候補へ戻さない
- 複数属性は1roundで同時決定しない。前roundの人間選択assetを次roundの唯一の基準にする。ももは`horo-refinement-v5`仕様の現行v6合格round（髪型と共通服形状）→`horo-hair-color-v1`（髪色だけ）→`horo-jersey-color-v1`（ジャージ色だけ）の順
- styling roundはshow bibleの宣言順、spec path/SHA、characterIdへ拘束し、全round選択済みになるまでidentity packへ進めない。エマは採用顔に加えてoffice/private-casual/private-dressyの3衣装シートを登録する
- `hairColor` roundはラベルやreview文だけで色差を認めない。`character-style-review-refresh`で同じnormalized ROIのmedian CIE Labを実画像から再計測し、全ペアのDelta E 76がspec閾値を満たすことと、別contextの肉眼差を両方要求する。保存値の手編集や画像差し替えは再計測で拒否する
- `character-approve`の有料identity pack生成は人物単位のcheckpointへ、候補SHA、参照SHA、prompt/model/size、generator context、各出力SHAを保存する。停止後は同じ引数・同じcontextで再実行し、一致する生成済み画像だけを再利用する。既存画像だけ、別context、入力変更、digest不一致は再開扱いにしない
- レイジのように既存作品人物への非類似確認が必要なroundは、比較参照を`canvas/`内へ保存して`--styling-comparison-reference-paths`へ渡す。path/SHAと候補別の原寸非類似チェックが揃わなければ合格しない。比較参照は画像生成入力へ混ぜない
- 固定11人を個別登録しただけで本編制作を許可しない。`character-roster-review-draft`で11人を同一縮尺とサムネ縮小へ並べ、11人個別と全55ペアについてシルエット、顔/年齢/役柄、髪/衣装色衝突、縮小識別性を生成contextと別のreviewerが確認する。`character-roster-audit`がpassするまで`plan/full`を遮断する
- 新規台本は`story-audit`で実台本SHAと逆転beat reviewを固定してから、同じ`--story-review-path`を`plan/full`へ渡す
- 背景は`location-plan`→anchor生成→別contextのSHA拘束anchor review→そのreview pathを必須入力にしたcontinuity生成へ分ける。`all`一括生成は禁止。公式generation manifestにanchor承認、生成context、prompt/anchor/画像SHAを保存し、全生成contextと異なるreviewerが全画像SHA・原寸・人物/文字/実在ロゴ0・建築連続性を通したreviewだけを`location-register`する
- サムネは承認済み帯色/書体、copy SHA承認、専用art、本編sourceとのSHA＋正規化画素差分を`thumbnail-audit`で確認する
