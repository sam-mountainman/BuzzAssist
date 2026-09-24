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

ホストがMCPを使えるときは同じ入力を`run_video_harness`へ渡す。個別の画像生成、
Fish Audio、ElevenLabs、字幕、retime、finalize用scriptを手で順番につながない。
旧版・benchmark・archiveは本番Jobから呼ばない。

`--confirmed`が無いstartはdurable Jobを作るだけで、有料Media Jobを発行しない。
共通Serviceが配備内で呼ぶ公開Coreは`node scripts/narrated-story-video.mjs full`だが、
これはdeployment entrypointであって運営者が上位Jobを迂回する入口ではない。

## 入力契約

- 必須入力は日本語の生台本、Harness ID、署名済みChannel Pack。
- Channel Packは外部の信頼済み公開鍵で検証し、bundle内の鍵を信頼しない。
- API key、秘密鍵、未公開台本本文をChannel PackやRunReceiptへ入れない。
- 台本はJob固有workspaceへコピーし、SHA-256で拘束する。
- 台本解析で人間判断が残る場合は、有料生成前にまとめて提示して停止する。

## 制作DAG

1. doctorでNode、Python、FFmpeg/ffprobe、Canvas、画像/TTS provider、書込権限を実測する。
2. 台本を順序付きsegmentへ分け、読み、感情、画面意図、字幕境界を固定する。
3. Channel Packの画風・Voice・BGM・禁止事項・承認SHAを検証する。
4. 画像と音声を型付きMedia Jobとして発行する。providerを直接呼ばない。
5. segment index順に画像、音声、字幕、BGM、カメラを組み立てる。workerは共有manifestを書かず、collectorだけが原子的に確定する。
6. temp MP4を生成し、全デコード、音量、音声とBGMの分離、尺、字幕、フレーム連続性を実測する。
7. contact sheetを生成し、生成contextとは独立したreviewerのSHA拘束付き確認を待つ。
8. 全gateがpassし`knownRemainingIssues`が空のときだけfinalへrenameし、RunReceiptとCanvas Runを確定する。

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
- 走っていないgate、fixture fallback、別出力へ結び付いたsignoffをpassにしない。

## 独立 signoff の署名

contact sheet の独立確認は `review/contact-sheet-signoff.json`
（`buzzassist-narrated-story-contact-sheet-signoff-v1`）として Job workspace に置く。
本文は `reviewer`、`reviewerContextId`、`approved: true`、`videoSha256`、
`contactSheetSha256`、`originalDetailReviewed: true`、空の `findings` と
`knownRemainingIssues` を持ち、reviewer の Ed25519 秘密鍵で `reviewerAttestation` を付ける。
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
  --pass
# または --reviewer codex --reviewer-context-id <実Codex-task-id>
# 出力先は既定の Job workspace 内 review/contact-sheet-signoff.json。governed route
# （finalize / RunReceipt）が読むのはこの場所だけなので、--signoff-path は付けない
# 信頼リストは監査・Receipt 実行側の BUZZASSIST_REVIEWER_TRUST（env）だけが正。
# --reviewer-trust-path JSON は env と同じ内容の照合用で、不一致は reviewer-trust-conflict、
# env 未設定なら明示しても reviewer-trust-unconfigured で止まる
```

MCP を使える host では、同じ工程を `signoff_video_harness_job`（`jobId`, `reviewer`,
`reviewerContextId`, `reviewerKeyPath`, 任意 `reviewerTrustPath`, `pass: true`, `confirmed: true`）と
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

## 完了条件

次がすべて実在し、SHA拘束されるまで完成と呼ばない。

- final MP4、字幕、voice/BGM/master音声、generation manifest、audit report、contact sheet、RunReceipt
- 実MP4の全デコード成功
- 契約に列挙された全gateの実測pass
- 現在のMP4へ拘束され、信頼リスト上の active な reviewer 鍵で署名された独立contact-sheet signoff
- `knownRemainingIssues`が空
- Canvas Runが最終成果物と同じartifact SHAを表示

<!-- buzzassist-learning:6edb2451ffe2 -->
台本から完成動画までの制作hot pathへYouTube Analyticsやyt-quality-loopを混ぜない。
Analyticsと公開後指標は別工程であり、このSkillの完了条件へ入れない。
