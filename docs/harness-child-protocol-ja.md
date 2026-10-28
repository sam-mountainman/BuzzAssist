# 外の非公開層と子プロトコル

上位の入口は `node scripts/run-video-harness.mjs`。公開宣言は `config/harnesses/` に置き、
非公開の宣言・実装はリポジトリの作業木の外へ置く。
`BUZZASSIST_PRIVATE_HARNESS_DIRS` に絶対パスを設定する（複数なら OS のパス区切り、POSIX は `:`、Windows は `;`）。
リンク先を含め、現在・main・別の linked worktree の内側は拒否する。公開宣言には `layer` を書かず、
外の宣言には `"layer": "private"` が必須。同じ id の宣言は上書きせず拒否する。
ファイル名は `<id>.harness.json`、能力カードは同じ場所の `<id>.capabilities.json`。
子プロトコルの id は先頭を小文字英数字にし、小文字英数字とハイフンで48字以内にする。

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
既存の配置表があればその配置を使い、無ければ宣言の入口を使う（公開はリポジトリ基準、private は宣言のフォルダ基準）。
正本スキルは既存の production inventory・profile の検査を受ける。外部スキルの自動登録や承認は行わない。
`script-quality-acceptance` を要求する場合、`scriptQualityGenre` は `lib/scriptQualityLoop.mjs` の既存ジャンルを指定する。
計画時に照合し、実行時にも子の起動前に同じ台本と署名済みPackの採点表で照合する。

## 子の入口

子は無課金の `help` と次の2つを実装する。

```text
<入口> full --script-path <台本> --job-id <id> --project-dir <dir>
  [--episode-id <id>] [--channel-pack-dir <検証済みpayload>]
  [--script-quality-work-dir <dir>] [--reviewer-trust-path <file>]
  --upstream-job-path <job.json> --upstream-job-id <id>
  --upstream-job-revision <revision> --upstream-execution-binding <sha256>

<入口> signoff --job-id <id> --project-dir <dir>
  --reviewer-context-id <別文脈id> --reviewer-key-path <秘密鍵file>
  --review-path <確認結果JSON> --pass|--fail
```

`full` は有料処理より前に `verifyVideoHarnessUpstreamExecution`（`lib/videoHarnessJob.mjs`）で束縛を検証し、
`assertScriptQualityWorkDirBoundToJob` で台本品質フォルダを照合する。
Pack は共通層が署名・対象harness・版の巻き戻しを検証する。payloadKind は `channel-pack`。
子は渡されたpayloadの中身を検査し、別のPackを探索して代用しない。
再開は同じJob・入力から再利用し、signoff 待ちで再生成しない。有料実行の明示確認は上位の `--confirmed` が担う。

stdout の最後のJSONは次の形。終了コードは合格 `0`、人待ち `3`、失敗はその他。
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

相対の成果物パスは子の配置root基準。SHAは実ファイルと一致させる。
`awaiting-human-review` では待つ理由を `knownRemainingIssues` に入れる。
監査JSONは `version: "buzzassist-child-audit-v1"`、`harnessId`、`jobId`、`contractVersion`、`status: "pass"`、
`videoSha256`、`contactSheetSha256`、`auditChecks`、`knownRemainingIssues: []` と、
`independentSignoff: {path, sha256, reviewer, reviewerContextId}` を持つ。
`guarantees[].evidenceAuditIds` の全項目を実測した `auditChecks` に載せる。

## signoff と確定

確認者は制作と別の文脈で、実際のMP4とcontact-sheetを見て署名する。秘密鍵は制作Jobへ渡さない。
signoff本文は `version: "buzzassist-child-contact-sheet-signoff-v1"`、`approved`、`originalDetailReviewed`、
`findings`、`knownRemainingIssues`、`reviewer`、`reviewerContextId`、`generatorContextId`、
`videoSha256`、`contactSheetSha256` を持つ。合格は両boolがtrue、両配列が空であること。
`signChildReviewSignoff` / `verifyChildReviewSignoff`（`lib/koyaReviewAttestation.mjs`）で、
既存の運営者の信頼リストとEd25519を使う。署名対象は宣言のharness id・Job id・identityDigest・
両成果物の実SHA・signoff本文全体・確認者の文脈。別Jobの署名や本文の改変は通らない。

再度 `resume --confirmed` すると、上位が成果物SHA・必須監査・署名・MP4の最後までの実デコードを確認し、
共通RunReceiptを確定する。`completed` / Receipt `pass` / 残件なしで初めてStopフックも合格する。
学習は既存のReceipt捕捉と宣言の学習先を使い、非公開の本文を公開層へ入れない。
配布境界は `node --test test/harnessPrivateDistribution.test.mjs` で毎回確認する。
