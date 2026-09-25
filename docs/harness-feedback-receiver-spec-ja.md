# 提供元の受け取り口の仕様（自動 feedback bundle v3）

運営者の端末で起きた学習（Job の決着・既知の提案の再発・未知の改善候補）を、提供元
（BuzzAssist の開発側）が受け取るための API の仕様。**端末側は実装済み**
（`lib/harnessFeedbackOutbox.mjs`・`lib/harnessFeedbackAutoBundle.mjs`・
`node scripts/harness-feedback.mjs consent|destination|outbox|send|purge`）。
**受け取り口はオトシゴのサーバーに実装した**（BuzzAssist 本体とは別の製品。URL は配備後に決まる）。
配備して送り先を配るまで、端末は送り先が未設定のまま bundle を貯めるだけにしている。

この文書は受け取る側が満たすことと、owner が受け取り口の書き出しを管理側へ取り込む口
（`harness-feedback-ingest.mjs import-export`、下の「持ち主の取り込み」）を書く。

## 既存の部品との関係

| | 手動の bundle（既存） | 自動の bundle（この文書） |
|---|---|---|
| 作り方 | 運営者が curator report から `harness-feedback.mjs create` | Job の決着時に端末が自動で作る（同意があるときだけ） |
| bundle の版 | `buzzassist-harness-feedback-v2` | `buzzassist-harness-feedback-v3` |
| API | `POST /v1/feedback/bundles`（`harness-feedback-ingest.mjs serve`） | `POST /v2/feedback/bundles`（この文書） |
| 送り手の認証 | Bearer token と登録済み operator の Ed25519 署名 | 登録済み operator の Ed25519 署名（token は使わない） |
| 受領証 | `buzzassist-feedback-ingest-receipt-v1`（署名なし） | `buzzassist-feedback-ingest-receipt-v2`（提供元の鍵で署名） |
| 未知の提案 | bundle に入れられない（422）。草案を人手で渡す | 一般化した文として `newCandidates` に入る |
| 管理側の隔離へ入れる口 | `ingest` / `serve`（受けた場で照合して隔離） | `import-export`（受け取り口の書き出しを照合して隔離） |

v1 はそのまま残す。v2 は v1 と同じ原則を守る:

- operator の登録簿（`buzzassist-feedback-operator-registry-v2`、`enroll` / `revoke`）を**共有する**。
  登録と失効は v1 と同じくローカルの CLI だけで行い、HTTP には出さない。端末は自動の bundle を
  手動の bundle とは別の鍵で署名するので、登録簿の行に鍵の用途（`keyUse`）を持たせた。field の無い
  既存の行は手動の bundle の鍵として読み（後方互換）、自動の bundle の鍵は `--key-use auto-feedback` で
  登録する。1つの operator は用途ごとに1本ずつ active な鍵を持てる。用途の違う鍵は互いに使えない
- 検証済みの bundle も**すぐには反映しない**。`verified-quarantine` に置き、owner の承認のあとで
  集計へ入れる
- **正本（SKILL.md・台帳・公開 catalog）を書き換えない**。未知の提案から規則の本文を作らない
- 失効した鍵の署名は、受理済み・承認済みを問わず後から数えない
- 検証に失敗した送信は、生の bytes を保存せず失敗の metadata だけを残す

## エンドポイント

```
POST https://<提供元のホスト>/v2/feedback/bundles
GET  https://<提供元のホスト>/healthz
```

- HTTPS だけ。redirect しない（端末は `redirect: "error"` で送る）
- 端末側の送り先は「この URL」と「提供元の公開鍵の指紋」の組で設定する
  （`harness-feedback.mjs destination --endpoint … --provider-key-fingerprint ed25519:<24桁hex>`）

### リクエスト

| 項目 | 値 |
|---|---|
| `content-type` | `application/json` |
| `x-buzzassist-feedback-bundle-sha256` | bundle の digest（参考。サーバーは本文から計算し直し、この値を信用しない） |
| 本文 | 署名済み bundle の正規 JSON（鍵の順を固定した JSON、`lib/channelPackEnvelope.mjs` の `canonicalJson`）。1 MiB 以下 |

`Authorization` は送らない。送り手が誰かは bundle の署名だけで決める。

## bundle v3 の形

未許可の field が1つでもあれば拒否する（strict）。端末側と同じ検査は
`validateAutoFeedbackBundleForTransport`（`lib/harnessFeedbackAutoBundle.mjs`）でそのまま行える。

```json
{
  "version": "buzzassist-harness-feedback-v3",
  "kind": "operator-auto-feedback",
  "generatedAt": "2026-09-25T01:00:00.000Z",
  "trigger": "job-settled",
  "consent": { "scopes": ["settlements", "proposals", "new-candidates"], "consentDigest": "<64桁hex>" },
  "build": { "coreVersion": "0.1.27", "harnessId": "narrated-story-video", "harnessVersion": "1.7.0", "declarationDigest": "<64桁hex>" },
  "settlement": {
    "sourceDigest": "<64桁hex>",
    "receiptSource": "run-receipt",
    "jobStatus": "failed",
    "outcome": "fail",
    "outcomeOverridden": false,
    "gates": [{ "gateId": "audio-loudness", "verdict": "fail" }, { "gateId": "voice-quality", "verdict": "pass" }],
    "gateCounts": { "declared": 12, "pass": 11, "fail": 1, "skip": 0, "notInForce": 0, "missing": 0 },
    "issueCodes": [{ "code": "render-timeout", "count": 1 }, { "code": "unclassified", "count": 1 }],
    "counts": { "mediaJobRetries": 0, "incompleteMediaJobs": 0, "imageRetries": 0, "resumeAttempts": 0, "pendingReceiptAttempts": 0 },
    "failedStages": ["render"],
    "host": { "hostKey": "claude-code", "hosts": ["claude-code"], "createdByHost": "claude-code", "buzzassistVersion": "0.1.27", "models": ["<宣言されたモデル ID>"], "hostVersions": ["claude-code@<版>"] }
  },
  "proposals": [{ "id": "<12桁hex>", "kind": "fact", "target": "platform:platform-craft", "occurrences": 1, "occurrenceDigests": ["<64桁hex>"] }],
  "newCandidates": [{
    "candidateId": "<12桁hex>",
    "kind": "preference",
    "target": "genre:narrated-story-video",
    "generalizedText": "長い工程を始める前に空き容量を確かめ、足りなければ先に片付けてから始める。",
    "evidenceKinds": ["operator-preference"],
    "occurrences": 2,
    "occurrenceDigests": ["<64桁hex>", "<64桁hex>"]
  }],
  "held": { "proposals": 0, "newCandidates": 3 },
  "privacy": {
    "containsScriptText": false, "containsPrompts": false, "containsEvidenceText": false, "containsSessionIds": false,
    "containsPaths": false, "containsPersonNames": false, "containsChannelTerms": false, "vocabularyChecked": true
  },
  "signer": { "algorithm": "Ed25519", "keyId": "ed25519:<24桁hex>" },
  "signature": "<base64url 64 bytes>"
}
```

- `settlement` / `proposals` / `newCandidates` は、`consent.scopes` にある範囲のものだけが入る。
  範囲に無い中身を持つ bundle は形の検査で拒否する
- `settlement.gates[].gateId` は `build.harnessId` の宣言（`config/harnesses/<id>.harness.json` の
  `guarantees`）にある id だけ。`verdict` は `pass` / `fail` / `skip` / `not-in-force`
- `issueCodes` は自由文ではなくコード（kebab-case か宣言にある監査 id、それ以外は `unclassified`）
- `proposals[].target` と `newCandidates[].target` は共有層（`platform:` / `genre:`）の正規名だけ。
  Channel Pack 宛の提案は端末から出ない
- `occurrenceDigests` は `lib/harnessLearningCurator.mjs` の `proposalOccurrenceDigest`（提案 id と
  session の指紋）。session そのものは入らない
- `newCandidates[].generalizedText` は端末が「チャンネル固有の事実・端末のパス・人名・資格情報らしい形・
  長い引用・URL・メールアドレスを含まない」と確かめた1行（12〜400字）。**それでも受け取る側は
  運営者の語彙を持たないので、この文を人が読む前提で扱い、自動では何にも使わない**
- `held` は送らずに端末へ残した件数（中身は無い）

### 署名

`signature` は、bundle から `signature` を除いた object の正規 JSON を、登録済み operator の
Ed25519 秘密鍵で署名したもの（v1 と同じ方式）。`signer.keyId` は公開鍵の指紋
（`publicKeyId`: `ed25519:` ＋ SPKI DER の sha256 先頭24桁）。検証は
`verifyAutoFeedbackBundle({ bundle, trustedPublicKeyPem })` でできる。**bundle に公開鍵は入らない。**
検証に使う鍵は登録簿（`enroll` で owner が登録したもの）からだけ取る。

## 受け取る側の検証の順番

1. 本文が 1..1 MiB（超えたら 413 `FEEDBACK_BUNDLE_SIZE_INVALID`）
2. JSON であること、v3 の形（未許可 field・範囲外の値・同意の範囲外の中身・文の形）
   （違反は 400 `FEEDBACK_INGEST_INVALID`）
3. `signer.keyId` が登録簿で `active` の operator の鍵（違えば 403 `FEEDBACK_SIGNER_NOT_ENROLLED`）
4. `build.harnessId` が null でなければ、その operator の `allowedHarnessIds` にあること
   （無ければ 403 `FEEDBACK_HARNESS_NOT_ALLOWED`）。v1 の `allowedBuilds`（Channel Pack の
   id・版・digest を含む release tuple）の完全一致は**適用しない**——v3 は Channel Pack を
   識別する値を運ばないため。`coreVersion` / `harnessVersion` / `declarationDigest` は観測として残し、
   配布した宣言の digest と合うかは owner が見る
5. Ed25519 署名の検証（違えば 400 `FEEDBACK_SIGNATURE_INVALID`）
6. 登録簿の lock の中で鍵の状態をもう一度見る（検証中に失効した鍵の bundle を保存しない。v1 と同じ）
7. `proposals[].id` が提供元の catalog にあり、kind / target が一致すること
   （無ければ 422 `FEEDBACK_PROPOSAL_NOT_REGISTERED`、食い違えば 422 `FEEDBACK_PROPOSAL_SEMANTIC_MISMATCH`。
   端末は配布物に同梱された catalog にある id だけを `proposals` に入れるので、通常は起きない）
8. `newCandidates[].candidateId` が既に catalog にあれば、その件は既知の提案の観測として数え、文は捨てる
9. 冪等と replay の検査（下）

### 照合を owner の取り込みへ回す実装（2026-09-26 に許した差分）

受け取り口が BuzzAssist の宣言と公開 catalog を持たない実装（BuzzAssist 本体とは別の製品のサーバーに置く場合）は、
次の照合を受け取り口で行わず、owner が集計へ入れる段（取り込み）で行ってよい。

- 手順 2 のうち「`settlement.gates[].gateId` が `build.harnessId` の宣言にあること」（書式の検査は受け取り口に残す）
- 手順 7（`proposals[].id` が catalog にあり、kind / target が一致すること）と手順 8（既知の候補の数え直し）

この場合、catalog に無い提案 id を持つ bundle も 422 にならずに隔離（verified-quarantine）へ入る。
取り込みの段は、宣言に無い gateId・catalog に無い提案 id・kind / target の食い違いを、集計に入れずに
理由つきで残す（受け取り口の 422 と同じ理由コードを使う）。形・登録簿・`allowedHarnessIds`・署名・冪等と replay の
検査は、受け取り口で必ず行う。置き場はファイルの木でなくデータベースの表でもよい（下の置き場の役割、すなわち
受け付けたもの・受領証・出どころの索引・拒否の metadata を保てばよい）。

オトシゴの受け取り口はこの差分で実装した。省いた照合は `harness-feedback-ingest.mjs import-export` が必ず行う
（下の「持ち主の取り込み」）。受け取り口は運営者の検査語彙も持たないので、本文の privacy の照合も取り込みの段で
管理側の語彙に対してやり直す。

## 冪等・replay・二重計上

- `bundleDigest = sha256(canonicalJson(bundle))`（署名を含む全体）
- 同じ `bundleDigest` がもう一度来たら、何も保存し直さず **200** で `duplicate: true` の受領証を返す
  （`receivedAt` は最初に受けた時刻）。端末は受理後の切断で同じ bytes を再送するので、ここが冪等で
  ないと二重に数える
- 同じ operator・同じ `settlement.sourceDigest` で別の `bundleDigest` が来たら
  409 `FEEDBACK_SOURCE_REPLAY_CONFLICT`（v1 の source replay key と同じ考え方）
- 提案の再発は `(operatorId, 提案 id, occurrenceDigest)` で1回だけ数える

## 置き場（例: `<root>/v2/`、v1 と同じ root の別の子）

| 置き場 | 中身 |
|---|---|
| `accepted/<bundleDigest>.json` | 検証済みの署名つき bundle（そのまま） |
| `receipts/<bundleDigest>.json` | 返した受領証 |
| `curation/<bundleDigest>.json` | `verified-quarantine` の候補（owner の承認待ち） |
| `candidates/<candidateId>.jsonl` | 未知の改善候補の文と、どの operator・どの bundle から何回来たか |
| `sources/<replayKey>.json` | 決着の指紋 → bundleDigest の索引 |
| `quarantine/rejected-<時刻>-<requestSha256>.json` | 拒否した送信の metadata だけ（生の bytes は残さない） |
| `decisions/` `imports/` | owner の承認・却下と、承認後に集計へ入れた観測（v1 と同じ形） |

## 応答

成功（新規 202、重複 200）:

```json
{
  "version": "buzzassist-feedback-ingest-receipt-v2",
  "ok": true,
  "duplicate": false,
  "status": "verified-quarantine",
  "bundleDigest": "<64桁hex>",
  "receivedAt": "2026-09-25T02:00:00.000Z",
  "ownerApprovalRequired": true,
  "provider": { "keyId": "ed25519:<24桁hex>", "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n" },
  "signature": "<base64url 64 bytes>"
}
```

- `signature` は `signature` を除いた受領証の正規 JSON を、**提供元の受領証用の Ed25519 鍵**で
  署名したもの。`signProviderIngestReceipt`（`lib/harnessFeedbackAutoBundle.mjs`）がこの形を作る
- 端末は `verifyProviderIngestReceipt` で、`provider.keyId` が設定した指紋と一致すること・
  `publicKeyPem` の指紋が `keyId` と一致すること・署名・`bundleDigest` が送った bundle と一致すること、を
  全部確かめたときだけ「届いた」と記録する。1つでも合わなければ恒久失敗として止まる
  （送り先の設定違いや、本物ではない受け口に「届いた」と言わせないため）
- 受領証の field は上の9つだけ（増やさない）

失敗:

```json
{ "ok": false, "code": "FEEDBACK_SIGNER_NOT_ENROLLED", "error": "未登録または失効済みのfeedback signer。" }
```

- `code` は `^[A-Z][A-Z0-9_]{0,63}$`。端末は `code` だけを記録する。`error` に bundle の中身を
  写さない

| 状態 | 端末の扱い |
|---|---|
| 200 / 202 | 受領証を検証して届いたと記録（検証に落ちたら恒久失敗） |
| 408 / 425 / 429 / 500 / 502 / 503 / 504・通信断 | 指数バックオフで再送（決着時は2回まで・全体15秒まで、1つの bundle で合計12回まで。運営者の `send` は4回ずつ） |
| それ以外（400 / 401 / 403 / 404 / 409 / 413 / 422 など） | 恒久失敗。自動では試し直さない。運営者が `send` で試し直すか `purge` で消す |

429 を返すときは `Retry-After` を付けてよいが、端末は今は読まない（自分のバックオフで待つ）。

## 提供元の鍵

- 受領証用の Ed25519 鍵を1つ持つ。operator の署名鍵とも、Channel Pack の署名鍵とも、reviewer の鍵とも
  分ける
- 指紋（`ed25519:<24桁hex>`）を運営者へ**別経路**で渡す（配布物の既定の送り先
  `config/feedback-destination.json` に入れるか、運営者が `destination` で設定する）。
  どちらも同じ形で、運営者の設定が優先する:
  `{"version":"buzzassist-feedback-destination-v1","endpoint":"https://…/v2/feedback/bundles","providerKeyFingerprint":"ed25519:<24桁hex>"}`
- 鍵を替えるときは、新しい指紋を先に配ってから切り替える。端末は1つの指紋しか信じないので、
  切り替えの前に届いた受領証は古い指紋で検証される

## 持ち主の取り込み（受け取り口の書き出しから）

受け取り口は受け付けた bundle を隔離して置くだけで、製品のどこにも反映しない。owner は受け取り口の
書き出しを BuzzAssist の管理側（`harness-feedback-ingest.mjs` の置き場。既定の例は `var/feedback-ingest`）へ
取り込み、受け取り口が省いた照合をここで行ってから、既存の隔離（curation の候補）へ置く。集計に入るのは、
その先の owner の approve のあとだけ（v1 と同じ流れ。台帳を2つにせず、自動では採用しない）。

### 書き出しの形

```bash
python -m otoshigo.feedback_intake export > feedback-export.jsonl
```

JSON Lines で、1行ずつ次の3種類（各行は鍵の順を固定した JSON）。

| record | field | 意味 |
|---|---|---|
| `bundle` | `bundleDigest` `operatorKeyId` `signerKeyId` `receivedAt` `bundle` `receipt` | 受け付けた署名つき bundle そのものと、最初に返した受領証。`operatorKeyId` は受け取り口の中の鍵の行 ID（`fok_…`）で、鍵の指紋は `signerKeyId` |
| `rejection` | `code` `httpStatus` `requestSha256` `bodyBytes` `signerKeyId` `receivedAt` | 拒否した送信の metadata だけ（本文は無い） |
| `summary` | `exportedAt` `bundles` `excludedInactiveSigner` `rejections` | 最後の1行。`bundles` はその回に書き出した bundle 行の数 |

- 書き出しは差分ではなく、毎回「保持期限内の全件」を出す。同じ bundle 行が回をまたいで何度も来るのが普通
- 失効した鍵・止めた利用者の bundle は書き出さず、件数だけを `excludedInactiveSigner` に出す
  （`bundles` には含まない）
- 前に取り込んだ bundle が次の書き出しに出てこなくなる（保持期限切れ・鍵の失効）のは正常。
  管理側の取り込み済みの記録は消さない

### コマンド

```bash
# 自動の bundle の鍵（運営者の端末の keys/operator-feedback-ed25519.pub.pem）を、owner がローカルで登録する
node scripts/harness-feedback-ingest.mjs enroll --root var/feedback-ingest \
  --operator <operator-id> --public-key <operator-feedback-ed25519.pub.pem> \
  --key-use auto-feedback --allowed-harness-ids <harness-id>[,<harness-id>...] --approved-by <owner-id>

# まず何も書かずに照合だけ見る
node scripts/harness-feedback-ingest.mjs import-export --root var/feedback-ingest \
  --export feedback-export.jsonl --provider-key-fingerprint ed25519:<24桁hex> --dry-run

# 照合を通った bundle を verified-quarantine へ置く
node scripts/harness-feedback-ingest.mjs import-export --root var/feedback-ingest \
  --export feedback-export.jsonl --provider-key-fingerprint ed25519:<24桁hex>
```

- `--provider-key-fingerprint` は受け取り口の受領証の鍵の指紋（受け取り口で
  `python -m otoshigo.feedback_intake receipt-key-fingerprint`）。**渡さないときは全部を照合して「未検証」として
  数えるが、隔離へは置かない**（取り込みの記録だけを残して exit 2）
- `--dry-run` は何も書かない（隔離も取り込みの記録も）
- `--proposal-catalog FILE` で照合に使う catalog を替えられる（既定は `<code-root>/docs/learning/proposals.public.jsonl`）。
  `--code-root DIR` はハーネス宣言・公開 catalog・検査語彙を読む checkout（既定はこのスクリプトの checkout）
- 検査語彙を照合できない（鍵が無い・一覧が無い）ときは何もせずに止める（exit 1）。受け取り口は運営者の語彙を
  持たないので、この照合を省けない
- 結果は JSON で出る: `counts`（`quarantined` / `wouldQuarantine` / `alreadyImported` / `rejected`）、
  `rejectedByCode`、`providerReceipts`（`verified` / `unverified`）、`receiverRejections`（受け取り口の拒否の
  code ごとの件数）、`summary`（`bundlesMatch`）、`stopped`、行ごとの `bundles`。`ok` が false なら exit 2

### 照合の中身（bundle 行ごと、この順）

1. 行の `signerKeyId` が `bundle.signer.keyId` と同じ
2. `bundle` から計算し直した digest（`autoFeedbackBundleDigest`）が行の `bundleDigest` と同じ
3. 既に取り込んだ digest なら、置いた記録の署名 chain を検証してから「取り込み済み」（`alreadyImported`）として
   数え、何も書かない（冪等。重複は失敗ではない）
4. v3 の形（`validateAutoFeedbackBundleForTransport`）
5. 登録簿の鍵: `signerKeyId` の行があり、用途が `auto-feedback`、`active`、`build.harnessId` が `allowedHarnessIds`
   にある（harness を持たない bundle は許可の一覧に依らない）
6. 登録簿の公開鍵で署名（`verifyAutoFeedbackBundle`）
7. 受領証: `bundleDigest` と `receivedAt` が行と同じ。指紋を渡したときは `verifyProviderIngestReceipt` で、
   提供元の鍵の指紋・署名・digest の結び付きを確かめる
8. **受け取り口が省いた照合**: `build.harnessId` の宣言があり、`settlement.gates[].gateId` が全部宣言にある
   （`loadHarnessGateRegistry`）
9. **受け取り口が省いた照合**: `proposals[].id` が全部 catalog にあり kind / target が一致する（手順 7）。
   `newCandidates[].candidateId` が catalog にあれば kind / target が一致することを確かめ、既知の提案の観測として
   数え、文は捨てる（手順 8）
10. **受け取り口が省いた照合**: 本文の privacy（`assertFeedbackPayloadPrivacy`。管理側の検査語彙・Channel Pack の語・
    端末のパスなど。端末より管理側の語彙のほうが広い）
11. replay: 同じ operator（鍵を替えても同じ）の同じ `settlement.sourceDigest` が別の bundle として置かれていない

1〜11 のどれかに落ちた bundle は、理由のコードを取り込みの記録に残し、隔離へ入れない（残りの行は続ける）。

| 理由のコード | 意味 |
|---|---|
| `FEEDBACK_EXPORT_SIGNER_MISMATCH` | 行の `signerKeyId` と `bundle.signer.keyId` が違う |
| `FEEDBACK_EXPORT_DIGEST_MISMATCH` | 行の `bundleDigest` と計算し直した digest が違う |
| `FEEDBACK_INGEST_INVALID` | v3 の形ではない |
| `FEEDBACK_SIGNER_NOT_ENROLLED` | 署名鍵が管理側の登録簿に無い |
| `FEEDBACK_SIGNER_KEY_USE_MISMATCH` | 署名鍵が手動の bundle 用として登録されている |
| `FEEDBACK_SIGNER_REVOKED` | 署名鍵が管理側で失効している |
| `FEEDBACK_HARNESS_NOT_ALLOWED` | その鍵に `build.harnessId` の許可が無い |
| `FEEDBACK_SIGNATURE_INVALID` | 署名を検証できない |
| `FEEDBACK_PROVIDER_RECEIPT_INVALID` | 受領証が指紋・署名・digest・受領時刻のどれかと合わない |
| `FEEDBACK_HARNESS_NOT_DECLARED` | `build.harnessId` のハーネス宣言が無い |
| `FEEDBACK_GATE_NOT_DECLARED` | 宣言に無い gateId がある（件数だけ残し、gateId そのものは記録へ写さない） |
| `FEEDBACK_PROPOSAL_NOT_REGISTERED` | catalog に無い提案 id がある |
| `FEEDBACK_PROPOSAL_SEMANTIC_MISMATCH` | catalog の kind / target と食い違う |
| `FEEDBACK_PRIVACY_BLOCKED` | 本文が検査に当たる（当たった語は出さず `private-term` などの理由だけを残す） |
| `FEEDBACK_SOURCE_REPLAY_CONFLICT` | 同じ決着が別の bundle として既にある |

次のときは、その行で取り込みを止める（それより前の行の取り込みは残る。bundleDigest で冪等なので、直した
書き出しで最初から流し直してよい）: JSON として読めない行・field の組が仕様と違う行
（`FEEDBACK_EXPORT_LINE_INVALID`）、未知の record（`FEEDBACK_EXPORT_RECORD_UNKNOWN`）、summary の後ろの行
（`FEEDBACK_EXPORT_RECORD_AFTER_SUMMARY`）、置いた記録の改変（`FEEDBACK_INGEST_STORAGE_TAMPER`）。
`rejection` 行は code ごとの件数を記録するだけ。`summary` 行は「読んだ bundle 行の数 == `summary.bundles`」で
突き合わせ、合わなければ `FEEDBACK_EXPORT_SUMMARY_MISMATCH`、summary が無ければ `FEEDBACK_EXPORT_SUMMARY_MISSING`
を結果に出す（`excludedInactiveSigner` と `rejections` は件数として記録するだけ）。

### 管理側の置き場

v1 と同じ root を使う。照合を通った bundle は `accepted/`（署名つき bundle そのもの）・`curation/`（隔離の候補）・
`receipts/`（取り込みの記録。受け取り口の受領証・受領時刻・受け取り口の鍵の行 ID を含む）・`sources/`（replay の索引）
へ置く。回ごとの結果は `export-imports/<時刻>-<書き出しの sha256 の先頭16桁>.json` に残す（dry-run では書かない）。
取り込みの記録には digest・理由のコード・件数だけを書き、`generalizedText` などの本文は写さない。

### 隔離から先は既存の承認

`curation/<bundleDigest>.json` を読んでから、既存の `approve` / `reject`（`harness-feedback-ingest.mjs`）で決める。
承認した bundle だけが `list-approved` と curator（`harness-curator.mjs --feedback-ingest-root`）の観測になる。
観測に入るのは、既知の提案（`proposals` と、catalog に既にあった `newCandidates`）の出来事の指紋と、決着の
ゲートの判定だけ。catalog に無い候補の文は `curation/` で owner が読むためだけに残し、承認しても自動では
何にも使わない（一般化できると判断したものだけを owner 自身の session で `harness-learn.mjs capture` する）。
鍵を後で失効すれば、承認済みでも `revokedAfterApproval` へ分けて数えない（v1 と同じ）。

### 運営者の公開鍵を受け取り口へ登録する

配備の段で、owner の承認のもとで行う。運営者の端末の自動の bundle の公開鍵（SPKI PEM、学習の置き場の
`keys/operator-feedback-ed25519.pub.pem`。秘密鍵は渡さない）を別経路で受け取り、指紋（`ed25519:<24桁hex>`）を
運営者本人と突き合わせてから、受け取り口の `python -m otoshigo.feedback_intake enroll --user-id <利用者 ID>
--public-key-file <SPKI PEM> --allow-harness <harness-id> --reason "<理由>"` と、管理側の
`harness-feedback-ingest.mjs enroll --key-use auto-feedback`（上のコマンド）の**両方**に同じ公開鍵を登録する。
許す harness は両方で同じにする。失効も両方で行う（受け取り口だけで失効すると書き出しに出なくなり、管理側だけで
失効すると取り込みで `FEEDBACK_SIGNER_REVOKED` になる）。

## owner の承認のあと

- `settlement` はハーネス × ホスト × 版の集計（`harness-receipts.mjs rollup` と同じ軸）に入れる
- `proposals` は既知の提案の観測回数に足す（v1 の import と同じ）
- `newCandidates` は owner が読み、一般化できると判断したものだけを owner 自身の session で
  `harness-learn.mjs capture` する。次のリリースの公開 catalog に入れば、以後その運営者からは
  `proposals` として届く。**受け取った文から自動で capture しない・正本を書き換えない**

## まだ決まっていないこと

- 受け取り口の配備（URL・ホスティング・バックアップ）。置き場はオトシゴのサーバーに決め、保持は受領から1年
- 提供元の受領証用の鍵の保管場所
- operator の登録で、公開鍵を運営者から受け取る経路（登録の手順そのものは上の「運営者の公開鍵を受け取り口へ登録する」）
- 送り先を配布物に同梱するか（同梱するなら `config/feedback-destination.json` を作り、`package.json` の
  `files` に足す。同梱しなければ運営者がそれぞれ `destination` で設定する）
