# BuzzAssist 台本→完成動画ハーネス マスターロードマップ

最終更新: 2026-09-01  
状態: 実装・監査結果の統合版。ローカルCoreは成立、実provider・正式Release・他OS実機は未承認。

> **状態の読み方**: この文書のPhase別チェックボックスは、調査開始時点から残している
> 作業分解・履歴であり、現在の合否を示す正本ではない。現在の実装状態は「4. 実装後
> スナップショット」と `docs/review/findings.jsonl`、独立レビューJSONの検証済みfindingで
> 判定する。チェックボックスだけを根拠に完了・未完了を主張しない。

## 1. 今回の目的

当面の完成目標は、YouTube Analytics ではなく次の一点に固定する。

> 運営者が日本語台本を渡すと、Claude Code または Codex のどちらからでも、
> 同じBuzzAssistハーネスが起動し、BuzzAssist Canvas上で制作状況と成果物を確認でき、
> 品質監査済みの完成MP4・字幕・音声・RunReceiptを受け取れる。

### 今回の対象外

- YouTube Analytics / Reporting / Data APIとの接続
- 公開後24時間・7日・28日の指標を使う改善
- 幸谷チャンネルの背景、帯、声候補、動画化範囲、脇役表現など、現在触らないよう指定された個別制作判断
- 新しい動画生成プロバイダーを先に増やすこと
- `yt-quality-loop`を本番動画ハーネスへ組み込むこと

対象外の項目は削除せず、現在の制作ハーネス完成後に別ロードマップへ移す。

## 2. 完了の定義

次の全項目を満たすまで「配布可能」「台本だけで完成」「もうやることはない」としない。

- [ ] 新しい端末へ正式リリースからインストールできる
- [ ] macOS / Windows / Linuxでdoctorが実ランタイムを検査する
- [ ] Claude Code / Codexの両方で同じHarness ID・Skill版・Channel Pack版を選ぶ
- [ ] 生の日本語台本だけを入力し、必要な人間判断があれば有料生成前に一括提示する
- [ ] 画像、TTS、字幕、BGM、レンダー、監査が1つのdurable jobとして最後まで進む
- [ ] Fish Audio / ElevenLabs等への直接呼び出しがなく、課金・冪等性・再送・秘密管理が共通基盤を通る
- [ ] 入力、進捗、候補、採択、音声、字幕、MP4、監査をCanvas上へ自動配置する
- [ ] 最終MP4を実際に全デコードし、contact sheetを独立レビューする
- [ ] `knownRemainingIssues` が空で、走っていないゲートをpassと記録できない
- [ ] RunReceiptへ入力・成果物・Harness・Skill・Channel Pack・provider・費用・監査の各指紋を残す
- [ ] 同じfixtureでClaude/Codexの両方が同じ合否へ到達する
- [ ] 失敗、中断、429、通信断、再起動後に二重課金せずresumeできる
- [ ] 配布先から返るフィードバックが、秘密を除いた提案としてBuzzAssist側へ戻る
- [ ] 自動改善は提案・評価まで。正本への昇格は人間承認と版管理を通る

## 3. 守るアーキテクチャ境界

BuzzAssistを次の3層に固定する。

| 層 | 内容 | 公開範囲 |
|---|---|---|
| Platform Craft | 課金API、ジョブ、再送、秘密、Canvas、原子的保存、RunReceipt、ルーティング | 共通コアとして配布 |
| Genre Harness | 漫画動画、ナレーション物語などの工程・品質ゲート | ジャンル単位で配布 |
| Channel Pack | キャスト、Voice ID、画風、運営者固有規則、承認記録 | 運営者ごとに非公開配布 |

グローバルにインストールされたSkillやPluginが見えることと、正式ハーネスが依存することを区別する。
正式ハーネスはmanifestに列挙されたSkill・MCP・providerだけを使い、端末に偶然ある別経路へフォールバックしない。

## 4. 2026-09-01 実装後スナップショット

### 成立したもの

- 上位入口を `node scripts/run-video-harness.mjs` に統一し、Koya内部入口を
  `node scripts/koya-manga-video.mjs` に固定した。Claude Code/Codexとも同じHarness宣言、
  正本Skill SHA、署名済みChannel Pack、Job、RunReceipt、Canvas投影を通る。
- `.agents/skills` を日本語正本にし、`.claude/skills` と `.codex/skills` を薄いhost adapterにした。
  project scopeのinventoryは同名競合0、内容分岐0。`skill-creator` は
  `buzzassist-development` に残し、`operator-production` からだけ外した。
- `yt-analytics*`、`yt-quality-loop*`、Cowork一般業務Skillは本番profileでhard denyした。
  端末から削除・無効化はしていない。
- Durable JobへCAS、cancel/resume、Channel Pack差替え検出、累積証拠、Canvas完了前の
  crash回復を実装した。RunReceiptは成果物、provider、費用、監査、外部署名へSHA拘束する。
- Canvas Runと実media投影を実装した。PNG、MP4、WAV、MP3、SRTの有効なfixtureを
  Codex内蔵Browserで実マウントし、画像・動画・音声・字幕の配置、MP4 `readyState=4`、
  2秒のdecode、console warning/error 0を確認した。無人の回帰は Playwright の Chromium で
  CI（canvas-browser-smoke）と release の gate が実ブラウザーで Canvas を mount して確かめる（2026-09-24 決定）。
- narrated-story Coreはnetwork禁止fixtureでraw台本→画像/TTS/BGM→実MP4→全decode→
  contact sheet→別context signoff→共通RunReceipt→Canvasまで完走し、中断後に有料素材を
  再生成しないことを実証した。
- setupはimport-safeかつ隔離test化し、macOS上でCodex/Claude双方の配布simulationに合格した。
  doctorはNode、Python（Windows `py.exe -3`候補を含む）、FFmpeg/ffprobe、codec、実MP4
  生成・probe・全decode、権限、Channel Pack、provider capabilityを有料処理前に検査する。
- フィードバックはproposal追記→重複整理→自動overlay→評価→reviewer名付き人間承認→
  正本昇格の順にした。未承認proposalは正本や完成判定へ使えず、自己採点で自己承認できない。
- Claude Codeの2セッション、関連workflow、`~/まさお`全320ファイルを内容ハッシュ付きで再監査し、
  Fish/Eleven、Canvas、配布、Skill分岐、Best-of-N、Analytics対象外を台帳へ取り込んだ。

### まだ外部実証またはRelease操作が必要なもの

- レビュー台帳は46件。今回実装した項目も、正式Release・他OS実機・実provider・人間signoffが
  必要なものは `implemented-unverified` または `open` のままにする。
- COVNEXの有料Media Job serverはserver-side secret、認証、credits、永続idempotency、
  refund recovery、owner scope、artifact receiptを実装した。exact adapterはFish/Eleven音声、
  Eleven dialogue、FAL GPT Image 2、ElevenLabs Music v1/v2。provider-freeの同時start、予約応答喪失、
  crash、返金、曖昧応答、容量境界を通した。まだConvex deploy、実credential、Stripe credit ledger、
  実providerとの非課金ではないE2Eを行っていないため、本番provider完走とはしない。
- 現在のMacに入っているBuzzAssist plugin cacheは旧 `0.1.25`。正本をcacheへ直接コピーせず、
  reviewed stable Releaseを作成後、Claude/Codex双方へ公式setupで再導入し、再起動後にSHA一致を測る。
- npm tarballはChannel Packや表示名を含まないが、Koya roster IDを持つ2実装ファイルを
  accepted-riskとして許可している。public境界を完全cleanにするならgeneric fixtureへ分離する。
- Windows/Linux CIとsetup simulationはあるが、実Windows/Linux/Claude Code browserでの
  Canvas media mount、provider接続、長いpath、権限は未実測。現段階で「全端末同一品質」とは言わない。
- 音声/BGMはCanvas上の波形カードから明示buttonでnative playerを開く。現在のmacOS Codex内蔵Browserで
  WAV/MP3とも`readyState=4`、2秒のduration、再生位置の進行、errorなし、console error 0を実測した。
  Claude CodeとWindows/Linuxでの同じUI smokeは未実施。
- 作業ツリーには今回以前からの大量のユーザー変更がある。勝手にstage/commit/publishせず、
  所有者が差分を分けてreviewした後にRelease gateを通す。

## 5. 実行ロードマップ

### Phase 0 — 証拠と作業環境を信用できる状態にする

最優先。ここが壊れたまま他を直すと、テストや台帳が偽の完了を返す。

- [ ] `scripts/setup-agents.mjs`をimport-safeにする
  - `main()`は直接実行時だけ呼ぶ
  - exportを読むテストが実ホストを設定変更しない
  - 一時HOME・一時plugin rootだけでセットアップテストを完結させる
- [ ] テスト実行前後でCodex/Claude設定・plugin cacheが変化していないことを検査する
- [ ] 壊れた`codex-mcp` marketplace参照を、修復または明示的に無効化する
- [ ] BuzzAssist本体とマイク側のdirty状態を、所有者・目的・検証状況ごとに棚卸しする
- [ ] ユーザーの変更を失わず、リリース対象を小さい論理コミットへ分ける
- [ ] `findings.jsonl`の状態を `open / implemented-unverified / verified / accepted-risk` に分ける
- [ ] verifiedには検証コマンド、結果ハッシュ、対象commit、実行環境を必須にする
- [ ] レビューラウンドごとの取り込みmanifestを作り、セッション指摘の転記漏れを検出する
- [ ] 行番号だけの証拠を、commit + 内容ハッシュ + 狭い識別子へ置き換える
- [ ] 台帳外だった次の問題を正式ID化する
  - Fish Audio直接接続とBuzzAssist課金・Receipt迂回
  - ElevenLabs直接接続
  - setupテストの実環境副作用
  - Canvasへの自動投影欠如
  - Plugin/Skillの「端末導入」と「ハーネス依存」の混同
  - plugin cacheの過大コピー
  - RunReceipt 0件
- [ ] 同一提案・同一セッションの再捕捉をoccurrenceとして水増ししない
- [ ] public surface監査で他端末由来絶対パス、散在識別子、最終npm tarballを検査する
- [ ] release時はbuild後の実tarballへsecret/public-surface監査を再実行する
- [ ] Strykerは全面導入せず、重要関数へ限定する。固定22秒テストを変異対象から分離する

完了条件:

- [ ] クリーンクローンの`npm test`が端末設定を1バイトも変更せず完走する
- [ ] 台帳に存在しないレビュー項目をmanifest検査が失敗として検出する
- [ ] 現在のブランチ・dirty差分・検証済みcommitを一意に説明できる

### Phase 1 — セットアップ、doctor、クロスOSをfail-closedにする

- [ ] `BUZZASSIST_HARNESS_READY=no`ならsetupを成功終了させない
- [ ] doctorを有料処理より必ず先に実行する
- [ ] CLI doctorとMCP doctorを同じ検査実装へ統合する
- [ ] doctorで以下の実体を検査する
  - Node.jsの対応版
  - Python実行ファイルと必要ライブラリ
  - FFmpeg / ffprobeと必要codec
  - Codex/Claudeホストの認証
  - 実際に使う画像モデルへの権限
  - 実際に使うTTS providerへの接続
  - Canvas serverの起動・read/write
  - 空き容量、出力権限、長いパス
- [ ] `python3`、`/usr/bin/python3`、`.venv/bin/python`の直書きを共通resolverへ置き換える
- [ ] Windowsでは`py.exe` / `python.exe`とパス区切りを実測する
- [ ] Channel Packを「任意」ではなく、チャンネル本番実行時の必須入力にする
- [ ] Channel Packを公開pluginへ混ぜず、署名付き非公開bundleとしてimportする
- [ ] roster review、Voice参照、画風ロック、承認SHAをhandoff bundleへ含める
- [ ] fixture fallbackはsourceを明示し、本番入口では拒否する
- [ ] setup後に実際のactive plugin/cache版を照合する
- [ ] plugin更新後に再起動が必要な場合は明示し、旧版を使ったまま成功扱いにしない
- [ ] node_modules全体を管理pluginへコピーしない。配布manifest対象だけをstageする

完了条件:

- [ ] 空のmacOS / Windows / Linux環境で、正式Releaseからsetup→doctorまで成功する
- [ ] 資格情報・Channel Pack・runtimeのどれかを欠くfixtureが必ず有料処理前に失敗する
- [ ] Codex/Claudeのdoctorが同一JSON schemaと同一合否を返す

### Phase 2 — 音声と有料メディアをBuzzAssist共通Brokerへ統合する

- [ ] providerを自由なproxyではなく型付きMedia Jobとして抽象化する
- [ ] Fish Audio adapterを実装し、マイク側の直接`api.fish.audio`呼び出しを廃止する
- [ ] ElevenLabs adapterを実装し、幸谷側の直接呼び出しを廃止する
- [ ] Irodoriを使う場合も同じJob・Receipt・課金契約へ載せる
- [ ] API keyをChannel Packや運営者クライアントへ含めず、server-side secretに限定する
- [ ] 生成前reservation、request key、idempotency、provider job IDを保存する
- [ ] 429 / 5xx / network断だけを上限付きで再送する
- [ ] 2xx受領後のdecode/body失敗は自動再送せず、provider job照会で回収する
- [ ] ログ、例外、レポート、Canvasから秘密をredactする
- [ ] 使用秒数、金額、無料再生成、provider、voice ID、入力ハッシュをReceiptへ記録する
- [ ] 同じ入力の同時起動を端末内ロックだけでなく永続idempotencyで止める
- [ ] stale lockにheartbeatを持たせ、生きた15分超ジョブを奪わない
- [ ] `get / cancel / resume / retry-safe-recover`を共通Job APIへ追加する
- [ ] 音声QA、CER、UTMOS、無音、ラウドネス、話者連続性を共通契約化する

完了条件:

- [ ] 幸谷・マイクのproduction codeからprovider直叩きとローカルAPI key読込が消える
- [ ] 通信断・5xx・プロセスkillのfailure injectionで二重課金しない
- [ ] 1セグメントごとの費用と成果物SHAをRunReceiptから追跡できる

### Phase 3 — 幸谷・マイクを同じ「台本→完成」契約へ揃える

#### 共通

- [ ] `run_video_harness`を唯一の上位入口にする
- [ ] raw台本、Channel Pack、Harness IDだけを最小入力にする
- [ ] Harness Routerはcapability・precondition・Channel Packから入口を選び、曖昧なら有料生成前に停止する
- [ ] 旧版・benchmark入口は`benchmarkMigration:true`なしでは拒否する
- [ ] 共通出力schemaを定める
  - final MP4
  - SRT/VTT
  - voice stem / BGM stem / master audio
  - generation manifest
  - audit report
  - contact sheet
  - RunReceipt
- [ ] 最終MP4はtempへ出力し、全デコード成功後にrenameする
- [ ] restore/handoffはstage→検証→commitのtransactionにし、途中状態を本番へ混ぜない
- [ ] 人間signoffが必要ならJobを`awaiting-human-review`で保持し、承認後に同じJob IDをresumeする

#### 幸谷

- [ ] 公式入口`node scripts/koya-manga-video.mjs`を上位Job APIからのみ呼ぶ
- [ ] `full`の最初に完全doctorを入れる
- [ ] 画像→manifest→音声→render→auditの依存を明示DAGへする
- [ ] 初回`audit-incomplete`時に必要なcontact-sheetレビューをCanvasへ出し、次の操作を自動提示する
- [ ] MCPにstatusだけでなくcancel/resumeを追加する
- [ ] active contract版の全gateが揃うまでfinalizeを拒否する
- [ ] 現在触らない個別制作判断はこのPhaseへ混ぜない

#### マイク

- [ ] `mike-script-to-video`と`mike-complete-video`の間を正式な1入口で接続する
- [ ] raw台本からセグメント、画像、TTS、字幕、BGM、retime、render、auditまでつなぐ
- [ ] `awaiting-built-in-imagegen`を汎用画像Jobへ接続する
- [ ] 既存画像と選択済み音声を必須前提にしない。Channel Packの再利用可能資産だけを事前資産として扱う
- [ ] `canonicalSkills: []`を解消し、必要な正本Skillと版をmanifestへ列挙する
- [ ] pendingのRunReceipt adapterを完成させる
- [ ] 90本超のversioned scriptを、production正本・benchmark・archiveへ分類する
- [ ] 共通parallel runnerと共有lockへ接続する

完了条件:

- [ ] 両ハーネスが同じ上位コマンド/MCPから開始できる
- [ ] raw台本fixtureから、手作業で別スクリプトを探さず最終MP4まで到達する
- [ ] 中断後も同じJob IDで再開でき、完成済み素材を再課金・再生成しない

### Phase 4 — Canvasを制作の正規UIにする

- [ ] Harness Runを表すCanvas scene schemaを定める
- [ ] 各runに安定したelement IDとartifact SHAを割り当てる
- [ ] Canvasへ以下を自動配置する
  - 入力台本カード
  - scene/cut DAG
  - 生成待ち・実行中・失敗・承認待ち・完成状態
  - 画像候補、採用画像、参照画像
  - 音声、波形、字幕、BGM
  - preview MP4、final MP4
  - 自動監査、独立レビュー、knownRemainingIssues
  - Harness / Skill / Channel Pack / providerの版と指紋
- [ ] Job状態変更を同じ要素へ反映し、再実行で重複要素を増やさない
- [ ] Canvas上の採択・却下・コメントをJob/feedbackへ戻す
- [ ] `prepare_canvas_attachments`経路を正式なチャット添付経路として維持する
- [ ] OS GUI自動操作やクリップボードを主要経路にしない
- [ ] Codexは内蔵Browser、Claudeは利用可能な内蔵Browser/Chrome連携で同じURLを開く
- [x] 無人UI回帰は Playwright（devDependency、CI と release の gate だけで使う）。運営者の端末には入れない。Stryker（変異テスト）は導入しない（2026-09-24 決定: lib 全体で 6〜20 時間、Node 20 行列と不整合）
- [ ] Tunnelは別端末閲覧用と明記し、別端末単独実行と混同しない

完了条件:

- [ ] Claude/Codexの同じfixture runが、Canvas上で同じ構造・状態遷移として見える
- [ ] 画像・音声・字幕・MP4を手動ドラッグせず確認できる
- [ ] ブラウザー実測で画面描画、主要操作、console error 0を確認する

### Phase 5 — SkillとPluginを役割別に整理する

- [ ] 次の4区分をmanifestとUIで明示する
  - 端末に導入済み
  - BuzzAssist/pluginに同梱
  - 本番Harnessで許可
  - 開発・改善時だけ許可
- [ ] `.agents/skills`をBuzzAssist正本とし、Claude/Codexアダプターは薄く保つ
- [ ] 各Skillへsemver、内容SHA、言語、owner、由来、対応ホストを持たせる
- [ ] BuzzAssist固有Skillの本文を日本語正本にする
- [ ] `buzzassist:skill-creator`を管理・curation用の共通正本として設計する
- [ ] 端末にある4系統の`skill-creator`を比較し、Codex内蔵版は変更せず、曖昧なgeneric名の競合を解消する
  - 2026-09-25 比較済み（`docs/skill-inventory-profiles-ja.md`の「同名 Skill の棚卸し」）。BuzzAssist 正本は
    `buzzassist:`で区別でき名前の変更は不要。残る競合は端末全体の汎用版同士で、端末側の整理が要る（未実施）。
    `.codex/skills`のアダプターは Codex では重複になるだけなので外す提案（未実施）
- [ ] 機械置換で壊れた`Codex -p` / `Codex.ai`等の記述を原典と照合して直す
- [ ] `skill-creator`は削除せず、運営者の動画生成hot pathから管理権限だけ分離する
- [ ] profileを最低3つに分ける
  - Operator Production: BuzzAssist、Canvas、Browser、正式Harness、provider、feedback capture
  - BuzzAssist Development: 上記 + skill-creator、Best-of-N、独立監査、engineering
  - General Work: Office、Finance、HR、Legal、Sales等
- [ ] Operator Productionでは`yt-analytics`と`yt-quality-loop`を候補から外す
- [ ] `yt-analytics`のglobal版とplugin版の二重登録・内容差を解消する
- [x] `yt-quality-loop`のStop/UserPromptSubmit hookが動画制作Jobへ介入しないことを保証する
  （2026-09-25、yt-quality-loop 1.8.x のフックのコードを読んで確かめた。yt-quality-loop 側は変更していない）
  - Stop: フック入力の`cwd`と`session_id`から`<cwd>/.yt-loop/sessions/<session_id>/state.json`を読み、
    無い・`active`でないときは何も出さない。`{"decision":"block"}`で終了を止めてループの続きを指示するのは、
    **同じ会話・同じ作業フォルダーで yt-quality-loop のループが動いているときだけ**
  - UserPromptSubmit: 入力を書き換えず、止めもしない。毎回`YT_LOOP_SESSION_ID=<id>`の1行を文脈へ足し、
    同じ会話にループがあればその状態を足す
  - `run-video-harness` / `koya-manga-video` / `narrated-story-video`の Job はホストのフックの外で走る子プロセスなので、
    Job の続行判定や入力には触れない。ハーネスが起動する子エージェント（`codex exec` / `claude -p`）は
    別の会話IDなので、上の1行が文脈に足されるだけで止められない
  - 残る介入は「ループを動かしている会話で制作 Job を回す」ときだけ。doctor の任意項目
    `yt-quality-loop-hooks`が、Claude Code / Codex でプラグインが有効か、作業フォルダーに動いているループが
    あるかを見て知らせる（`lib/ytQualityLoopHooks.mjs`）。ループの状態ファイルは BuzzAssist から書き換えない
  - Codex のプラグインフックは信頼レビュー後にだけ動く（上の harness-learn の項と同じ）。有効化されていても
    未レビューなら走らないが、doctor は安全側に「有効」として数える
- [ ] Cowork系は削除せずGeneral Work profileへ隔離する
- [ ] HyperFrames / Remotion / Koyaの経路を用途で明示し、正式Harnessが暗黙選択しないようにする
- [ ] `claude-mem`と`codex-mcp`は、修復して使うか無効化するかを明示決定する
- [ ] Fable/Grok/RunPod等は正式Harness manifestが呼ぶ場合だけOperator profileへ入れる
- [ ] BuzzAssist releaseからClaude/Codexへ同じSkill SHAを配布する
- [ ] plugin cacheを編集元にせず、正本→build→署名Release→各ホスト更新の一方向配布にする

完了条件:

- [ ] `skill inventory`が同名競合を0件と報告する
- [ ] Claude/CodexでBuzzAssist正本SkillのSHAが一致する
- [ ] Operator fixtureで目的外Skillが自動選択されない
- [ ] skill-creatorを使った変更が、評価・人間承認なしに正本へ入らない

### Phase 6 — 安全な最大並列化

- [ ] 全Harnessを共通DAG形式へする
- [ ] 各jobに`needs`、`locks`、timeout、retry class、費用上限を持たせる
- [ ] workerは共有manifestを書かず、collectorだけが原子的に書く
- [ ] 完了順ではなくscript index順で成果物を組み立てる
- [ ] Koyaのキャラ単位・別episode単位の既存並列性を維持する
- [ ] KoyaのTTSを横断並列化する前に`nextCutId`を完了済みcut集合へ置き換える
- [ ] 画像生成枠とsemantic QA枠を分離する場合、再生成loopを含む2段pipelineとして設計する
- [ ] マイクのFish TTS並列を共通Brokerのprovider quotaへ移す
- [ ] マイクのregenerate/finalize共有JSONを直列またはtransaction化する
- [ ] ffmpeg並列度は端末ごとにbenchmarkし、8コア機で無闇に上げない
- [ ] 外側の`codex exec`と内側のnative agentを合算して上限管理する
- [ ] Claude/Codexエンジン差をreportへ記録する
- [ ] read-onlyを保証できないengineへread-only監査を割り当てない
- [ ] 並列計画・各job結果・待ち時間・429・費用をRunReceiptへ統合する

完了条件:

- [ ] 逐次実行と並列実行が同じ順序・同じartifact SHA・同じ合否を返す
- [ ] 共有ファイル競合、二重課金、stale overwriteのfailure testが通る
- [ ] macOS / Windows / Linuxごとの安全なauto concurrencyが実測値から決まる

### Phase 7 — Hermes型の自己改善を閉ループ化する

- [ ] Claude/Codexの両方で、訂正・好み・禁止・実測事実をturn内で自動候補化する
  - [x] 両ホストのプラグインにUserPromptSubmitフック（`scripts/harness-learn-hook.mjs`）を載せ、
    訂正・禁止・繰り返しの言い回しでエージェントへcaptureを促す。フックは何も書き換えず、
    発言本文を保存せず（リポジトリ外にsha256と時刻だけ）、常にexit 0で入力を止めない。
    捕捉するかはエージェントが決める（言い回しが当たっただけの誤検知を台帳へ積まない）
  - [ ] Codexのプラグインフックは信頼レビュー後にだけ動く。実機のCodexで一度通すこと
- [x] Job決着時（completed / failed / awaiting-human-review）にRunReceiptから不合格ゲート・
  knownRemainingIssuesのコード・再試行と再開の回数を、Channel Pack宛のproposalへ自動で積む
  （`createdBy=auto-receipt`、Receipt digestをsessionにして冪等、本文はid・コード・件数だけ）
- [x] capture / sync / promote / applyの前に、注入らしい言い回し・隠しHTMLコメント・不可視Unicode・
  資格情報らしい文字列・端末の絶対パスを検査し、削除せず`blocked`として残す（検査語彙照合とは別の層）
- [x] 旧名宛先（`skill:` / `ledger:` / `doc:`）の対応表をharness-learnとfeedback bundleで共有し、
  status / sync / curatorで新しい宛先に数える
- [x] 長く再発しないoverlay項目を`curate`で候補として列挙する（最後の再発日と、関連ゲートが直近の
  Receiptに出たかで判定。既定dry-run）。退避はhuman-verifiedの人の判断に限り、削除はしない
- [x] `harness-parallel-agents`が起動する子エージェントは学習を書かず、捕捉したい内容を親へ返す
- [ ] captureはproposal追記だけにし、正本を直接変更しない
- [x] セッション終了後のread-only curatorを追加する
- [x] curatorは類似提案を束ね、1事象1Skillの増殖を防ぐ
- [ ] RunReceiptの`worstGates`から改善対象を選び、思いつきと実測改善を分ける
- [ ] `buzzassist:skill-creator`でdraft→fixture→比較→修正案を作る
- [ ] 正本への直接編集と`applied.jsonl`直接追記を検出する
- [ ] `--note`断片一致ではなく、提案ID・差分ハッシュ・対象版を拘束する
- [ ] RunReceiptへ承認種別を入れ、人間確認とagent自己申告を下流でも区別する
- [ ] 配布物へ必要な承認証跡を含める
- [ ] agent-attested時に「人の規則へ昇格」と表示しない
- [x] 運営者から返すfeedback bundleをredact・署名・版拘束する
- [x] Channel Packの秘密、台本本文、未公開素材はupstream feedbackへ含めない
- [x] operator公開鍵登録、二重認証upload、exact dedupe/replay隔離、owner承認後のcurator importを追加する
- [ ] 提案、比較結果、承認、Release、改善前後をCanvasまたは管理UIで見えるようにする
- [ ] operator側は新Releaseを受け取り、Claude/Codexの両方が同じ新Skillを使う

完了条件:

- [ ] 実RunReceiptを最低1本ずつ両Harnessで生成する
- [ ] 1つのユーザー訂正がproposal→評価→人間承認→Release→両ホスト反映まで追跡できる
- [ ] 承認前の提案が監査・合否の根拠として使われない
- [ ] 改善前後の同じfixtureで、対象gateが改善したことを測定できる

### Phase 8 — 運営者への配布形を完成させる

- [ ] 公開BuzzAssist Core Pluginと非公開Channel Packを分離する
- [ ] Channel Packへキャスト、画風、Voice参照、番組規則、承認SHAだけを含め、provider secretは含めない
- [ ] Channel Packを署名し、対象Harness/Coreの互換版を宣言する
- [ ] Claude Code / Codex両方のinstallerを同じReleaseから生成する
- [ ] macOS / Windows / Linuxで管理者権限なしの標準セットアップを用意する
- [ ] FFmpeg、Python、補助binaryをchecksum付きで解決するか、明確な導入手順を出す
- [ ] 安定Releaseだけを自動更新対象にし、stage検証、backup、rollbackを維持する
- [ ] 新バージョンがactive cacheで使われたことまで検証する
- [ ] インストール後はCanvasを内蔵Browserで開く
- [ ] 運営者向け導線を「台本を貼る／ファイルを選ぶ」の1入口にする
- [ ] 進行中、承認待ち、失敗、完成を専門用語なしで表示する
- [ ] support bundleへdoctor、Job、Receipt、version情報を秘密なしで出力する
- [ ] ユーザー提供の「まさお」フォルダーから採用した考え方と、コード・素材の由来を分けて記録する
- [ ] 第三者VTT・素材・声・BGMのlicense/provenanceをRelease gateへ入れる
- [ ] Canvas Tunnelはスマホ・別端末閲覧の任意機能として提供する

完了条件:

- [ ] 幸谷用・マイク用の署名Channel Packを別々にimportできる
- [ ] 運営者がリポジトリ構造や93本のscript名を知らなくても1本完成できる
- [ ] public packageに運営者名、秘密、ローカル絶対パス、非公開素材が含まれない

### Phase 9 — 実機E2EとRelease Gate

最低マトリクス:

| OS | Host | Harness |
|---|---|---|
| macOS | Codex | Koya / Mike |
| macOS | Claude Code | Koya / Mike |
| Windows | Codex | Koya / Mike |
| Windows | Claude Code | Koya / Mike |
| Linux | Codex CLI | Koya / Mike |
| Linux | Claude Code | Koya / Mike |

各セルで確認すること:

- [ ] Releaseからの新規setup
- [ ] doctor
- [ ] Channel Pack import
- [ ] 同一の短い日本語fixture台本
- [ ] 画像生成
- [ ] 音声生成
- [ ] 字幕・BGM・retime
- [ ] MP4 renderと全デコード
- [ ] Canvas自動配置
- [ ] contact sheet独立レビュー
- [ ] RunReceipt生成
- [ ] 中断・resume
- [ ] provider 429 / 5xx / network断
- [ ] disk不足・出力権限エラー
- [ ] updateとrollback
- [ ] public-surface / secret scan

品質の同一性はMP4のバイト一致ではなく、同じ契約・同じgate・同じ合否・同じknown issue基準で測る。

Release Gate:

- [ ] 全P0がverified
- [ ] first-video pathのP1がverified
- [ ] 実MP4が全デコード
- [ ] 独立signoffが現在版のSHAへ拘束
- [ ] `knownRemainingIssues`が空
- [ ] RunReceiptが完全
- [ ] npm tarball監査がcleanまたは明示accepted-risk
- [ ] rollback canaryが成功

## 6. 最短で進める並列Wave

依存関係を守り、次の順で進める。

### Wave 0 — 直列

1. dirty差分の所有者・版を固定
2. setup import副作用を修正
3. 台帳とラウンドmanifestを信用できる状態にする

ここが終わるまで、他レーンの「完了」を確定しない。

### Wave 1 — 4レーン並列

- Lane A: setup / doctor / Python・FFmpeg resolver / cross-OS
- Lane B: Media Job / Fish・ElevenLabs adapter / 課金・冪等性
- Lane C: Skill inventory / profile / shared skill-creator設計
- Lane D: Canvas run schema / Job状態投影

共有manifestやユーザー設定への書き込みはlane間で直列化する。

### Wave 2 — 2レーン並列

- Lane E: 幸谷ハーネスを共通Job・Broker・Canvasへ接続
- Lane F: マイクハーネスを1入口へ統合し共通Job・Broker・Canvasへ接続

Platform APIとschemaをWave 1で凍結してから開始する。

### Wave 3 — 3レーン並列

- Lane G: self-improvement curator / feedback bundle / approval chain
- Lane H: packaging / signed Channel Pack / updater・rollback
- Lane I: failure injection / cross-host fixture / UI回帰

### Wave 4 — 直列Release判定

1. macOS canary
2. Windows canary
3. Linux canary
4. Claude/Codex比較
5. public tarball監査
6. stable Release

## 7. 今は導入しないもの

- `yt-quality-loop`の本番統合
- Analytics系の制作Job接続
- Hermes Agentの丸ごと導入
- Stryker などの重い変異テスト基盤
- 重いworkflow orchestratorの先行導入
- providerを増やすだけの新Plugin
- 正式Harnessが呼ばないRemotion/HyperFrames/RunPodのOperator profile常駐

既存のNode.js、FFmpeg、BuzzAssist MCP、内蔵Browser、共通parallel runner、RunReceiptを先に完成させる。

### 条件が成立したときだけ追加する候補

| 候補 | 導入条件 | 今すぐ入れない理由 |
|---|---|---|
| WhisperX / faster-whisper | provider timestampやCER監査が実音声で不十分と測定されたとき | Python/GPU依存と配布容量を増やす。現行FFmpeg/外部alignmentで先に測る |
| OpenTelemetry | Media Job serverを実運用し、traceなしで障害箇所を追えなくなったとき | いまはJob/Receipt/Convex stateが先。観測基盤だけ先に増やさない |
| Temporal | 複数host・長時間workflowで現在のdurable Job/CASでは回復不能と実証されたとき | 別orchestratorを増やすとClaude/Codex共通経路が二重化する |
| ComfyUI | ローカルGPU生成を正式な型付きadapterとして提供すると決めたとき | 任意workflowを直接本番へ流すとmodel/費用/再現性の契約が壊れる |
| Runway / Higgsfield / Seedance等 | 動画化範囲と1本当たり予算がChannel Packで決まったとき | 現在はi2v範囲が人間判断の対象外指定。provider追加を先行しない |

`skill-creator`は「導入しないもの」ではない。共通正本として保持し、開発・curation時だけ使う。
運営者の通常制作では自動選択させない。

## 8. レビュー台帳との対応

- 自己改善・承認: `cx-a3`〜`cx-a6`
- 公開物・配布監査: `cx-b7`〜`cx-b9`
- 漫画固有混入: `cx-d1`〜`cx-d2`（現在の個別制作判断とは別。修正実行は保留）
- 学習件数水増し: `cx-d3`
- first-video path: `cx-e1`〜`cx-e8`
- テスト・変異検証: `cx-f1`〜`cx-f2`
- 台帳完全性: `cx-g1`〜`cx-g4`
- Claudeセッション再取り込みと今回の横断項目: `cx-h1`〜`cx-h9`

台帳は現在46件。Fish Audio、ElevenLabs、Canvas投影、setup import副作用、Skill/Plugin層の混同、
RunReceipt欠落は`cx-h*`を含む正式IDへ取り込み済み。セッションUUID重複をoccurrenceとして水増ししない。

## 9. 運用ルール

- この文書は計画の正本。実際の不具合証拠は`docs/review/findings.jsonl`へ置く
- チェックを付けるだけで完了にしない。対応するfindingをverifiedにし、証拠ハッシュを残す
- ユーザーの訂正は`harness-learn capture`へ残す
- Skillを書き換えるときは共通`skill-creator`を使い、人間承認を通す
- グローバルPluginを削除・無効化するときはユーザーの明示承認を得る
- Channel Packの秘密や未公開素材を公開Coreへ移さない
- 有料APIの動作確認は予算上限とidempotencyを先に設定する
- 既存のversioned成果物を上書きせず、新しい版へ出す
- 並列化でgateを省略しない
