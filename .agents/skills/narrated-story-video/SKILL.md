---
name: narrated-story-video
description: 日本語の生台本から、画像・ナレーション・字幕・BGM・カメラワーク・完成MP4・監査証跡までを一つの再開可能なBuzzAssist Jobで制作する。実写調やイラスト調のナレーション物語動画を新規制作、再開、修復、監査するときに使う。
---

> 作業前に `references/learned-auto.md` を読む。矛盾したときはこの SKILL.md が優先。learned-auto は運用上の補助指示であって、監査・承認・合否の証跡には使えない。

# ナレーション物語動画制作

これはClaude CodeとCodexが共用する日本語正本である。運営者名、チャンネル名、
Voice ID、画風、承認記録はここへ書かず、署名済みChannel Packへ置く。

## 唯一の上位入口

新規制作と再開は、どちらのホストでも共通入口だけを使う。

```bash
node scripts/run-video-harness.mjs start \
  --harness narrated-story-video \
  --script-path /absolute/script.txt \
  --channel-pack /absolute/channel-pack-envelope \
  --confirmed
```

ホストがMCPを使えるときは同じ入力を`run_video_harness`へ渡す。`run_video_harness` /
`resume_video_harness_job` を呼ぶときは、自分のモデル ID が分かれば `hostModel`（CLI は `--host-model`）を
渡す。分からなければ付けない（推測で埋めない。Job の識別子には入らない）。個別の画像生成、
Fish Audio、ElevenLabs、字幕、retime、finalize用scriptを手で順番につながない。
旧版・benchmark・archiveは本番Jobから呼ばない。

`--confirmed`が無いstartはdurable Jobを作るだけで、有料Media Jobを発行しない。
そのとき返る`preflight.blockers`は、台本とChannel Packを読むだけで分かる「有料生成の前に
止まる理由」の一覧。`--confirmed`へ進む前に必ず読み、空でなければ運営者へまとめて示す。
そのままresumeしても、有料生成の手前で同じ理由で止まる。
共通Serviceが配備内で呼ぶ公開Coreは`node scripts/narrated-story-video.mjs full`だが、
これはdeployment entrypointであって運営者が上位Jobを迂回する入口ではない。

## 入力契約

- 必須入力は日本語の生台本、Harness ID、署名済みChannel Pack。
- Channel Packは外部の信頼済み公開鍵で検証し、bundle内の鍵を信頼しない。
- API key、秘密鍵、未公開台本本文をChannel PackやRunReceiptへ入れない。
- 台本はJob固有workspaceへコピーし、SHA-256で拘束する。
- 台本解析で人間判断が残る場合は、有料生成前にまとめて提示して停止する。
- `--script-path` は生テキストのほか、台本パッケージ（`script-package.json`、形式
  `buzzassist-narrated-script-package-v1`、スキーマ `config/narrated-story-script-package.schema.json`）か、
  Pack の `scriptIntake.markdown` で本編・感想の見出しを宣言した `script.md` を受け取る。見出し・注記は
  声にしない。宣言の無い Markdown や、見出しらしい行を含む生テキストは推測せずに止まる。

## 台本の関門（監査契約 v8 から）

有料の処理の前に、使う台本のバイト列が台本の品質ループで合格した版か、人がそのまま使うと認めた版かを問う。
どちらでもなければ `awaiting-human-review` で止まり、`script-quality-required:<理由>` と次に打つコマンドを
返す。plan-only の start も同じ理由を `preflight.blockers` に出す。台本が通っていないまま画や声に払うと、
直した台本で全部を払い直すことになるため。

- 作業フォルダは start の `--script-quality-work-dir`（MCP は `options.scriptQualityWorkDir`。省けば台本の
  あるフォルダ）。Job の識別子に入る
- 運営者・依頼者が書いた台本をそのまま使うなら、確認した人が自分の端末で
  `node scripts/script-quality-loop.mjs accept-human --work-dir <台本のフォルダ> --script <台本> --reviewer <名前> --reason "…" --human-verified`
  を打つ。エージェントは代わりに打たない。直しを提案するなら台本の品質ループ（ジャンル narrated-story）を回す
- ループの評価者の組・累計・指摘の採否は `../platform-craft/references/quality-loops-ja.md` にある

## 配役・読み・BGM

- 地の文は Pack の `voice`、「」内の台詞は台本パッケージの `speakers[].castRole` → Pack の `cast.roles`
  の声で読む。使えない（blocked）役・宣言の無い役・権利根拠の無い役が台本に出れば、有料生成の前に止まる
  （宣言の無い役を語りの声で読むのは、Pack が `undeclaredRoles: "narrator"` と明示したときだけ）
- 字幕の表記と声の読みは、台本パッケージの `readings` で分ける。字幕は台本の表記のまま、声には読みを
  渡す。音声品質ゲートの CER は声に渡した読みで測る
- 本編の曲は Pack の `musicPlan` の区分ごとに、台本の各場面へ割り当てる。使う区分の曲が未受領なら、
  有料生成の前に `music-section-pending` で止まる。感想パートの曲は `bookends.review.music`

## 制作DAG

1. doctorでNode、Python、FFmpeg/ffprobe、Canvas、画像/TTS provider、書込権限を実測する。
2. 台本を順序付きsegmentへ分け、読み、感情、画面意図、字幕境界を固定する。
3. Channel Packの画風・Voice・BGM・禁止事項・承認SHAを検証する。
4. 画像と音声を型付きMedia Jobとして発行する。providerを直接呼ばない。
5. segment index順に画像、音声、字幕、BGM、カメラを組み立てる。workerは共有manifestを書かず、collectorだけが原子的に確定する。
6. temp MP4を生成し、全デコード、音量、音声とBGMの分離、尺、字幕、フレーム連続性を実測する。
7. contact sheetを生成し、生成contextとは独立したreviewerのSHA拘束付き確認を待つ。
8. 全gateがpassし`knownRemainingIssues`が空のときだけfinalへrenameし、RunReceiptとCanvas Runを確定する。

## OP・本編・感想（bookends）

番組の頭のOP、本編、あとの感想パートという構造は、Channel Packの`narrated-story.json`の
`bookends`で宣言する。公開Coreは構造・汎用の転換・境目の監査だけを持ち、OPの文言・色・秒数・
曲・人物素材などチャンネル固有の値は1つも持たない。足りなければ有料生成の前にblockerで止まる。

- `opening`: `title-card`（文言・書体・背景・音はPack内のファイル）か、Pack内の`video`
- `review`: 台本の区切り行（`scriptMarker`）、人物素材（`presenter`。必須と宣言して無ければ停止）、
  感想用の曲
- `transitions.openingToStory` / `transitions.storyToReview`: `hard-cut`、`fade-through-black`、
  `film-burn` のどれかと、秒数、字幕なしの間（lead-in）。film-burnは外部素材なしで手続き的に描く
- 境目では、字幕なしのlead-inのあとに語りと字幕が同時に始まり、BGMは境目を通して鳴り続ける
- Packで決まっていないこと（未受領の曲、権利根拠の無い声、未提供の人物素材など）は、埋めずに
  Packの`blockers`配列へ書く。Jobは有料生成の前に`awaiting-operator-input`で止まる

感想パートの一人称の体験談は、生成した文を本人の体験として出さない。台本に
`[[operator-replace]]`（Packが追加の印を宣言してもよい）が残っていれば有料生成へ進まず、
最終監査の`operatorReplacementCleared`でも止まる。運営者が本人の体験へ差し替えてから進める。

境目の監査（`audioBoundaryBreathV16`、`bookendTransitionMeasured`、監査v2）は、完成MP4の
音声・映像フレーム・字幕と、MP4へ入れたvoice stemを実際にデコードして測る。語り末尾が
切れていないこと、宣言した区間に転換が実在すること、転換中に字幕が無いこと、音の二重化や
クリップが無いことを見る。閾値は基準版と壊した版を同じ測定にかけて決めてある
（根拠は`lib/narratedStoryBookends.mjs`の各定数）。生成側の「こう作った」を根拠にpassにしない。

## 見た目（字幕・カメラ・場面の切り替え・感想の配置・重ね物・回ごとの OP 映像）

見た目の値は全部 Channel Pack の `narrated-story.json` で宣言する。公開 Core はチャンネルの値を持たない
（既定の画像・位置・色も持たない）。

- `subtitles`: 焼き込み字幕。書体は Pack 内のファイル。字幕の字は台本の表記で、声の読みではない。
  書体に無い字・1行に入らない語は、有料生成の前に止まる
- `camera`: 場面の画のゆっくりした寄り引きの型（`slow-push-in` / `slow-pull-out` / `pan-left` /
  `pan-right` / `static`）と速さ。同じ画の文（話者ごとに分けた場面）は1つの動きで通し、動きを
  始め直さない。台本パッケージの場面は `camera` で型を指定できる（Pack に無い型は止まる）
- `sceneTransition`: 本編の場面の切り替え。`{ "type": "crossfade", "durationSeconds": 0.1〜2 }` を宣言した
  ときだけ混ぜ、無ければ cut。尺と字幕・声の時刻は変わらない（前後の場面を伸ばして重ねる）。短い場面の
  隣では重なりを縮め、2フレームに満たなければ cut のまま描いて計画に `reduced` を残す
- `bookends.review.layout`: 感想パートの配置（`plain` / `tv-left-presenter-right`）。人物の映像が
  無ければ人物の枠は空のまま（代わりの人物を描かない）。台本パッケージの感想の文は `layout`・
  `tvScene`・`captionOnlySeconds`（声を作らず字幕だけを出す文。0.5〜30秒。感想パートの最初の文には
  使えない）を持てる。TV 枠の中身は `tv.content` で `still`（既定）/ `scene-motion`（本編でその場面に
  当てたカメラの型で動かす）/ `operator-video`（取り込みの記録の枠 `review-tv` の動画。必須で、音は
  使わず、短ければ頭から繰り返す）
- `overlays`: Pack に置いた PNG を、本編・感想パートの宣言の区間と位置に重ねる。重ねる部ごとに
  `faceRegions`（顔の出うる範囲）を宣言する——顔の範囲は Core には分からないため。画面の外、焼き込み字幕・
  TV 枠・人物の枠・顔の範囲と重なる置き場所は、有料生成の前に止まる。OP と境目の転換には重ねない
- `bookends.opening.kind: "episode-video"`: 回ごとの OP 映像。OP の動画・感想パートの人物の映像
  （`presenter.episodeVideo`）・TV 枠の動画は、取り込みの記録（`buzzassist-operator-video-manifest-v1`）を
  `run-video-harness.mjs start --operator-video-manifest FILE`（MCP / `--options-json` では
  `options.operatorVideoManifestPath`）で渡す。Job の識別子に入り、plan-only でも検査する

監査契約 v6 から、字幕・カメラ・感想の配置・OP の来歴を完成 MP4 のフレームで測る（`burnedSubtitlesMeasured`・
`cameraMotionMeasured`・`reviewLayoutMeasured`・`episodeOpeningProvenance`）。字幕は輝度（Y）で測る。
監査契約 v9（宣言 1.12.0）から、場面の切り替えと重ね物も測る（`sceneTransitionMeasured`・`fixedOverlaysMeasured`）。
`reviewLayoutMeasured` は、TV の中身が動く型なら区間の始まりと終わりの変わり方まで測り、止まった画での
代用を落とす。どれも、宣言していない機能は「描いていない」ことを確かめて通る。

監査契約 v7 から、取り込んだ運営者の映像（回ごとの OP 映像・感想パートの人物の映像。後から足した TV 枠の動画も
同じ経路）は、途中の成果物の品質ループ（工程 video-clip）に合格した版でなければ使わない。取り込みの記録のフォルダで、先に `node scripts/asset-quality-loop.mjs measure-video`
で測ってからループを回し、記録の各行に `assetLoop: { statePath, passedSha256 }` を書く。無い・未合格なら、
有料の処理の前に `video-clip-asset-loop-not-passed:<枠>:<理由>` の `awaiting-human-review` で止まる。
人物が写る映像は同一性と手指を人が確かめる（そのまま公開面に出るため）。

## 運営者が用意した画（image.source: operator-file）

本編の画をハーネスの外（運営者の web 画面・Codex・ローカルモデルなど）で作るチャンネルは、Pack の
`narrated-story.json` で `image.source: "operator-file"` と `image.operatorFile`（`manifest.location:
"job-option"`・`expectedSize`・`tolerancePx`・`approvedReferences`・`requireAssetLoopPass`）を宣言する。

- 取り込みの記録（`buzzassist-operator-image-manifest-v1`）は `run-video-harness.mjs start
  --operator-image-manifest FILE`（MCP では `options.operatorImageManifestPath`）で渡す。Job の識別子に入る
- 全部の場面を記録から取り、broker の画と混在させない。sha256・場面の過不足・使い回しの理由・
  承認済みの参照・寸法・品質ループの合格のどれかが合わなければ、有料の処理の前に `operator-image-*` で止まる
- 画の Media Job は作らず、費用は `operator-external-contract` として記録する。会話の URL は私有の
  Job フォルダにだけ残り、公開面（生成記録・監査・RunReceipt・Canvas）は sha256 だけ
- 画を差し替えたら、記録の sha256 を直して同じ Job を resume する（声と BGM は払い直さない）
- 自動監査 `sceneImageProvenance` が、描いた画を Media Job の受領記録か取り込みの記録と照合する

## 途中の成果物の品質ループ（監査契約 v5 から）

本編の画・その参照の人物の設定画・採用する声のテイクは、途中の成果物の品質ループ
（`node scripts/asset-quality-loop.mjs`、本体 `lib/assetQualityLoop.mjs`）に合格した版でなければ描かない。

- broker の画と声のテイクは、Job の作業フォルダ（`.media/narrated-story-video/<Job>/`）で、場面 id・
  文 id を対象 id にして回す。作った文脈は `production:<Job>` で、この文脈では採点できない
- 運営者の画は、取り込みの記録の各行に `assetLoop: { statePath, passedSha256 }` を書き、記録のフォルダで
  ループを回してから Job を始める。参照は同じフォルダの人物の設定画（character）のループで合格した版で
  なければ通らない
- 声の測定は `quality/voice-take-measurements/<文 id>.json` に置かれ、ループの機械ゲートになる。評価者は
  直前の地の文と続けて聞き、声の連続と台詞だけ浮いていないかを採点する。ループが合格させたテイクを採用する
- 未合格があれば、描かず BGM も依頼せずに `awaiting-human-review` で止まり、工程・対象 id・理由コードと
  `assetQualityLoop.pending` を返す。有料の再生成はしない。ループを回してから同じ Job を resume する
- 確定の前にも、描いた画と採用したテイクが今も合格した版かを照合する
- 対象が多い回（長い動画の声のテイク・本編の画）は `sheet --batch` / `record --batch` で1つの評価文脈が
  まとめて採点できる（1回 50 件まで。人の確認は対象ごとに `verify`）

## サムネ

サムネは Job の成果物にも RunReceipt の保証にも入れず、Job の外で作る。計画と検査は
`node scripts/thumbnail-plan.mjs draft|audit --harness narrated-story-video`（漫画と同じ
`lib/thumbnailPlan.mjs`）。決まりは署名済み Pack の `narrated-story.json` の `thumbnail` 節に置き、
節が無い Pack ではサムネを計画しない（チャンネル固有の値を推測で埋めない）。手順・final の条件は
`references/thumbnail-ja.md` にある。サムネを計画・検査するときに読む。

## 並列実行

複数segmentの画像・音声・機械QAは、先に`harness-parallel-execution`正本を読み、
`node scripts/harness-parallel-run.mjs`または`node scripts/harness-parallel-agents.mjs`から
実測上限内で流す。workerはsegment固有workspaceと成果物だけを所有し、job.json、
generation manifest、Receipt、Canvas sceneのような共有状態はcollectorが直列に確定する。
同一request identityのMedia Jobを別workerが二重submitしない。doctor、Channel Pack検証、
最終mux、全デコード、外部署名、finalizeは依存関係を越えて並列化しない。

## 有料Media Job

<!-- buzzassist-learning:079632f77850 -->
本番の画像・Fish Audio・ElevenLabs呼び出しは共通の型付きMedia Job BrokerとRunReceiptを必ず経由する。

- Fish Audio、ElevenLabsその他のproviderはBuzzAssist共通Brokerだけから呼ぶ。
- submit前にreservationとrequest identityを永続化する。
- 429、5xx、network断だけを上限付きで再送する。
- 2xx受領後のbody/decode失敗は自動再submitせず、provider job照会によるrecoverへ移す。
- `get / cancel / resume / recover`は同じJob IDを使い、完成済みartifactを再生成しない。
- Receiptへprovider、adapter版、voice/model ID、入力SHA、秒数、費用、artifact SHAを残す。本文、認証情報、provider生レスポンスは残さない。

## Canvas

入力、DAG、状態、候補、採択、音声、字幕、BGM、preview/final MP4、監査、
`knownRemainingIssues`、Harness/Skill/Channel Pack/provider版を同じCanvas Runへ投影する。
画像は画像element、音声/BGMは音声element、字幕は字幕element、preview/final MP4は
動画elementとして実ファイルへ結び付ける。成果物名を書いたカードやfile pathだけで
代用しない。再実行はRun・artifact SHAから得た安定element/file IDを更新し、同じ
mediaを再登録せず、重複カードを増やさない。採択・却下・コメントはJob feedbackへ
戻す。削除済み成果物は既存要素を無言で再利用せず、非破壊のtombstoneとして示す。
OSのクリップボードやGUI自動操作を主要経路にしない。

## 停止と再開

- 不足入力や曖昧なrouteは有料呼び出し前に停止する。
- 人間の知覚確認が必要なら`awaiting-human-review`として同じJob IDを保持する。
- 中断、429、通信断、再起動後は共通Job APIからresumeする。
- 決着していない有料 Media Job（`recovery-required`）は、broker の recover で決着させてから進む。
  決着しなければ `paid-media-recovery-pending` で止まり、送り直さない。課金されていない失敗は自動で
  送り直す。課金された画像の失敗は `resume --retry-failed-images` のときだけ作り直し、回数が台帳と
  Receipt に残る（それ以外の課金された失敗は `paid-media-failed-charged` で止まる）。
- 走っていないgate、fixture fallback、別出力へ結び付いたsignoffをpassにしない。

## 独立 signoff の署名

contact sheet の独立確認は `review/contact-sheet-signoff.json`
（`buzzassist-narrated-story-contact-sheet-signoff-v2`）として Job workspace に置く。
本文は `reviewer`、`reviewerContextId`、`approved`、`videoSha256`、`contactSheetSha256`、
`originalDetailReviewed: true`、`findings`、`knownRemainingIssues`、`qualityReview`
（`contractDigest`、`evaluatorContextId`＝`reviewerContextId`、`rubricScores`、`notes`）を持ち、
reviewer の Ed25519 秘密鍵で `reviewerAttestation` を付ける。`approved` は `true`（findings は空）か
`false`（差し戻し、findings は1件以上）。評価項目と契約の digest は Job の `review.quality` にある。
署名対象には Job ID・identityDigest・MP4 SHA・contact sheet SHA・signoff 本文 SHA・
reviewer context が入るので、承認内容の書き換えも署名で落ちる。

鍵・信頼リスト（`BUZZASSIST_REVIEWER_TRUST`）・失効・fail-closed・運用モデルの規則は
`../platform-craft/SKILL.md`の「独立レビューの署名（reviewer attestation）」が正本で、
ここには繰り返さない。鍵の作成も同じ `reviewer-key-create` を使う。

```bash
node scripts/narrated-story-video.mjs signoff \
  --job-id <video-narrated-story-video-...> \
  --project-dir /absolute/project \
  --reviewer claude --reviewer-context-id <実Claude-session-id> \
  --reviewer-key-path /secure/outside-repo/reviewer-ed25519.pem \
  --review-path /absolute/review-scores.json \
  --pass
# review-scores.json は { rubricScores, notes, findings }。差し戻しは --pass の代わりに --fail
# または --reviewer codex --reviewer-context-id <実Codex-task-id>
# 出力先は既定の Job workspace 内 review/contact-sheet-signoff.json。governed route
# （finalize / RunReceipt）が読むのはこの場所だけなので、--signoff-path は付けない
# 信頼リストは監査・Receipt 実行側の BUZZASSIST_REVIEWER_TRUST（env）だけが正。
# --reviewer-trust-path JSON は env と同じ内容の照合用で、不一致は reviewer-trust-conflict、
# env 未設定なら明示しても reviewer-trust-unconfigured で止まる
```

MCP を使える host では、同じ工程を `signoff_video_harness_job`（`jobId`, `reviewer`,
`reviewerContextId`, `reviewerKeyPath`, `reviewPath`, 任意 `reviewerTrustPath`, `pass: true|false`, `confirmed: true`）と
`create_video_harness_reviewer_key`（`reviewerKeyPath`, `confirmed: true`）で呼ぶ。引数名は Koya の
`run_koya_manga_pipeline action=signoff` と共通で、鍵・信頼リストは path だけを受け、中身は拒否される。
Koya Job をこの tool へ渡すと拒否される（Koya は `run_koya_manga_pipeline` 側）。上位
`run-video-harness.mjs start|resume --reviewer-trust-path JSON`（MCP `reviewerTrustPath`）は照合用で、
一致した path は上位 Job から `narrated-story-video.mjs full` へも同じ値で渡される。

`--signoff-path FILE` は上級者向けで、governed route が読まない場所へ書く。使うのは
別配備の finalize へ手で受け渡す等の特殊事情に限り、その場合も finalize 側へ同じ path を
明示しなければ signoff は「無い」扱いになる。通常の制作では使わない。

CLI が無い配備では `lib/koyaReviewAttestation.mjs` の `signNarratedReviewSignoff` が同じ
subject を署名する唯一の経路であり、finalize と RunReceipt は `verifyNarratedReviewSignoff`
で信頼リスト照合を行う。署名の無い signoff、信頼リスト未登録・失効済みの鍵、generator と
同じ context の signoff は final へ進めない。

## 品質ループ

独立 signoff は、承認でも差し戻しでも品質ループの1回になる（中核は `lib/qualityLoop.mjs`、
このジャンルの評価項目は `lib/narratedStoryQualityLoop.mjs`）。合格は、機械ゲートが全部通り、
評価項目の加重平均が目標点以上で、どの項目も下限を下回らないこと。平均が目標に届いても1項目の
下限割れは不合格。

合格点・項目ごとの下限・重みは品質契約（`lib/narratedStoryQualityLoop.mjs`）とループのコードだけが持ち、
評価者には見せない。評価者として採点するときは、Job の `review.quality` のシート（評価項目の id・名前・
説明・0〜100 の尺度・契約の digest）だけで採点し、合格点・下限・前の回の点数を探しに行かない
（見ると採点がそれに寄る）。前の回と同じ所見の評価は `quality-feedback-not-updated` で拒否されるので、
回ごとに今の MP4 を見て所見を書く。

届かない回は失敗指紋を残して `awaiting-human-review` で止まる（例外にはしない）。次の回には、
前の回で使っていない `--reviewer-context-id` と、Job の作業領域の `quality/revision-delta.json`
（`{ "previousFailureFingerprint", "revisionDelta" }`）が要る。直した出力は台本・Pack・コードの
指紋が変わって別の Job になるので、新しい Job の同じファイルに `"predecessorJobId"` を書いて
前の Job のループを引き継ぐ。書かなければ新しいループの1回目として数える。

止まる条件は目標到達・人の判断・費用・時間・回数・停滞。上限は Channel Pack の `qualityLoop`
で変えられるが、評価項目と下限は変えられない（範囲外の値は有料生成の前に止まる）。

## 完了条件

次がすべて実在し、SHA拘束されるまで完成と呼ばない。

- final MP4、字幕、voice/BGM/master音声、generation manifest、audit report、contact sheet、RunReceipt
- 実MP4の全デコード成功
- 契約に列挙された全gateの実測pass
- 現在のMP4へ拘束され、信頼リスト上の active な reviewer 鍵で署名された独立contact-sheet signoff
- 品質ループに合格した回があり、その回の signoff が今の MP4 に結び付いた承認であること（`qualityLoopPassed`）
- 声と人物の実測 pass（`voiceTakeQuality`・`voiceCastRouting`・`characterIdentityReviewed`）
- 途中の成果物の品質ループと画の来歴の実測 pass（`sceneImageAssetLoopPassed`・`characterAssetLoopPassed`・
  `voiceTakeAssetLoopPassed`・`sceneImageProvenance`）と、監査契約 v6 の見た目の4監査（宣言していない
  機能は描いていないことの確認）
- 監査契約 v7〜v9 の実測 pass（運営者の映像のループの合格 `operatorVideoAssetLoopPassed`、台本の受け入れ
  `scriptQualityAccepted`、場面の切り替え `sceneTransitionMeasured`、重ね物 `fixedOverlaysMeasured`）
- `knownRemainingIssues`が空
- Canvas Runが最終成果物と同じartifact SHAを表示

<!-- buzzassist-learning:6edb2451ffe2 -->
台本から完成動画までの制作hot pathへYouTube Analyticsやyt-quality-loopを混ぜない。
Analyticsと公開後指標は別工程であり、このSkillの完了条件へ入れない。
