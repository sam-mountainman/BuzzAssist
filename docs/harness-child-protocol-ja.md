# 外の非公開層と子プロトコル

上位の入口は `node scripts/run-video-harness.mjs`。公開宣言は `config/harnesses/` に置き、
非公開の宣言・実装はリポジトリの作業木の外へ置く。
`BUZZASSIST_PRIVATE_HARNESS_DIRS` に絶対パスを設定する（複数なら OS のパス区切り、POSIX は `:`、Windows は `;`）。
`realpathSync.native` と各祖先の `(dev, ino)` で作業木の内側を検査する。祖先に `.git`（ファイル・フォルダ）が
あれば拒否するので、大文字小文字違い・firmlink・separate-git-dir・`.git` の無い cache からの起動でも回避できない。
リンク先とリンク元の両方を検査する。公開宣言には `layer` を書かず、
外の宣言には `"layer": "private"` が必須。同じ id の宣言は上書きせず拒否する。
ファイル名は `<id>.harness.json`、能力カードは同じ場所の `<id>.capabilities.json`。
子プロトコルの id は先頭を小文字英数字にし、小文字英数字とハイフンで48字以内にする。
`produces.kind` は厳密に `"video"` だけを受け付ける。Receipt の署名・全編デコードの必須条件は
`childProtocol` からも決めるので、kind を変えて条件を外すことはできない。

外のフォルダが読めない・宣言が壊れている場合、一覧は `BUZZASSIST_PRIVATE_HARNESS_DIRS` と対象・理由を示し、
その宣言だけを除く。公開 id の検索は外の宣言を読む前に解決し、漫画・物語の再開を外の障害で止めない。
クライアント名の禁止は公開宣言だけに適用する。非公開の競合 id は採用せず、公開の宣言を上書きしない。

追加する宣言の要点（id と内容は合成の例）:

```json
{
  "id": "synthetic-video",
  "version": "1.0.0",
  "displayName": "合成動画",
  "status": "in-production",
  "layer": "private",
  "childProtocol": "buzzassist-child-v1",
  "entrypoint": "node child.mjs",
  "produces": { "kind": "video" },
  "reviewAttestation": { "subject": "synthetic-video" },
  "scriptQualityGenre": "narrated-story",
  "canonicalSkills": [".agents/skills/platform-craft/SKILL.md"],
  "learningTargets": ["platform:platform-craft"],
  "requiresFromOperator": [
    { "id": "signed-channel-pack", "blocking": true },
    { "id": "script-quality-acceptance", "blocking": true }
  ],
  "guarantees": [{ "id": "final-quality", "evidenceAuditIds": ["finalQuality"] }]
}
```

公開側に追加するジャンルは `layer` だけを省く。`entrypoint` はシェル構文を使わない `node <script>`。
公開は既存の配置表を優先し、無ければリポジトリ基準で宣言の入口を使う。
private は配置表を使わず、外の宣言のフォルダを root とする。
entrypoint と root の実パス・inode の包含を検査し、entrypoint 自体の symlink と中間リンクによる root 外への脱出を拒否する。
正本スキルは既存の production inventory・profile の検査を受ける。外部スキルの自動登録や承認は行わない。
`script-quality-acceptance` を要求する場合、`scriptQualityGenre` は `lib/scriptQualityLoop.mjs` の既存ジャンルを指定する。
計画時に照合し、実行時にも子の起動前に同じ台本と署名済みPackの採点表で照合する。

## 子の入口

子は無課金の `help` と次の `full` を実装する。署名は共通層が行う。

```text
<入口> full --script-path <台本> --job-id <id> --project-dir <dir>
  [--episode-id <id>] [--channel-pack-dir <検証済みpayload>]
  [--script-quality-work-dir <dir>] [--reviewer-trust-path <file>]
  --upstream-job-path <job.json> --upstream-job-id <id>
  --upstream-job-revision <revision> --upstream-execution-binding <sha256>
  --review-signoff-path <共通層が署名結果を書く固定のpath>
```

`full` は有料処理より前に `verifyVideoHarnessUpstreamExecution`（`lib/videoHarnessJob.mjs`）で束縛を検証し、
`assertScriptQualityWorkDirBoundToJob` で台本品質フォルダを照合する。
Pack は共通層が署名・対象harness・版の巻き戻しを検証する。payloadKind は `channel-pack`。
子は渡されたpayloadの中身を検査し、別のPackを探索して代用しない。
再開は同じJob・入力から再利用し、signoff 待ちで再生成しない。有料実行の明示確認は上位の `--confirmed` が担う。

stdout の最後の空でない行全体に、次の形のJSONを**1行で**出す（下は読みやすく整形した説明用）。
ログの途中の `{` や複数行JSONは結果として読まない。終了コードは合格 `0`、人待ち `3`、失敗はその他。
timeout で終了させた子は、終了コードが `0` でも `final-audited` を返しても失敗になる。
エラーを出す場合も `status: "failed"` と問題の一覧を残す。

```json
{
  "status": "final-audited",
  "knownRemainingIssues": [],
  "artifacts": {
    "final-video": { "path": "/absolute/final.mp4", "sha256": "64桁のSHA-256" },
    "contact-sheet": { "path": "/absolute/contact-sheet.png", "sha256": "64桁のSHA-256" },
    "audit-report": { "path": "/absolute/audit.json", "sha256": "64桁のSHA-256" }
  },
  "runReceiptPath": "/absolute/child-receipt.json",
  "auditChecks": { "finalQuality": { "pass": true } }
}
```

相対の成果物パスは子の配置root基準。SHAは実ファイルと一致させる。同じ成果物を複数の名前で返す場合も全てのSHAを照合する。
ハッシュはストリームで計算し、前後のsize・mtime・ファイルの同一性を照合する。2GiB超でも全体をメモリへ読み込まない。
`awaiting-human-review` と `failed` は `knownRemainingIssues` が1件以上必須。空なら `child-protocol-result-invalid`。
監査JSONは `version: "buzzassist-child-audit-v1"`、`harnessId`、`jobId`、`contractVersion`、`status: "pass"`、
`videoSha256`、`contactSheetSha256`、`auditChecks`、`knownRemainingIssues: []` と、
`independentSignoff: {path, sha256, reviewer, reviewerContextId}` を持つ。
`guarantees[].evidenceAuditIds` の全項目を実測した `auditChecks` に載せる。

## signoff と確定

確認者は制作と別の文脈で、実際のMP4とcontact-sheetを確認して `signoff_video_harness_job` を使う。
秘密鍵のパス・本文は外付けの子へ渡さず、子の `signoff` コマンドも起動しない。
共通層（`lib/harnessChildReview.mjs`）が確認結果JSON、Jobの成果物の実SHA、確認者の文脈と信頼リストを検査して署名する。
確認結果は `{originalDetailReviewed: true, findings: [], knownRemainingIssues: []}`。
`pass=true` は両配列が空、`pass=false` はどちらかに1件以上必要。確認結果から `approved` や文脈を上書きできない。
署名結果は `<Job.runDir>/child-review-signoff.json` に固定して保存する。
子は次の `full` で渡された `--review-signoff-path` を読み、信頼リストとJob・成果物のSHAで検証する。
signoff本文は `version: "buzzassist-child-contact-sheet-signoff-v1"`、`approved`、`originalDetailReviewed`、
`findings`、`knownRemainingIssues`、`reviewer`、`reviewerContextId`、`generatorContextId`、
`videoSha256`、`contactSheetSha256` を持つ。合格は両boolがtrue、両配列が空であること。
`signChildReviewSignoff` / `verifyChildReviewSignoff`（`lib/koyaReviewAttestation.mjs`）で、
既存の運営者の信頼リストとEd25519を使う。署名対象は宣言のharness id・Job id・identityDigest・
両成果物の実SHA・signoff本文全体・確認者の文脈。別Jobの署名や本文の改変は通らない。

再度 `resume --confirmed` すると、上位が宣言の実パスとSHAをJobの `canonicalIdentity.harnessDeclaration` と照合する。
実行中に宣言を差し替えた通常確定は `canonical-identity-drift` で止まる。
さらに成果物SHA・必須監査・`CHILD_AUDIT_VERSION`・harnessId・jobId・署名・MP4の最後までの実デコードを確認し、
共通RunReceiptを確定する。`completed` / Receipt `pass` / 残件なしで初めてStopフックも合格する。
学習は宣言の `layer` と `learningTargets` から決める（channel-pack 宛を優先、それ以外は先頭の宛先）。
既存の2ジャンルだけは従来のChannel Pack宛との互換を保つ。
private の提案・Receipt索引は運営者の学習の置き場（`BUZZASSIST_LEARNING_DIR` または `~/.buzzassist/learning`）の
`private-harnesses/<harnessId>/` に保存する。チャンネル付きJobはさらに `channels/<channelId>/` に分離する。
公開の台帳・catalog・overlayへ書かず、自動一般化や提供元へのfeedbackには接続しない。
提供元向けfeedbackのゲート語彙は公開宣言だけを読み、private の決着から settlement を作らない。
配布境界は `node --test test/harnessPrivateDistribution.test.mjs` で毎回確認する。
