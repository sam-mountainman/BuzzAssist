# 運営者端末から管理側へ返す — bundle・送信・受け取り

`../SKILL.md` の「運営者端末から管理側へ返す」の続き。運営者の端末で溜まった学習を、署名つきの
bundle にして提供元（BuzzAssist の開発側）へ返す経路の手順をまとめる。feedback bundle・送信の
同意・送り先・受け取り側（ingest）を触るとき、運営者から返ってきた bundle を扱うときに読む。

## Job の決着時に自動で作る bundle（v3）

運営者が同意したとき（`node scripts/harness-feedback.mjs consent --enable`、または対話の setup）
だけ、Job の決着時に端末が署名つき bundle（`buzzassist-harness-feedback-v3`、本体
`lib/harnessFeedbackAutoBundle.mjs`）を自動で作り、送信待ちに積む。運ぶのは次だけ:

- 決着の要約（settlements）: ゲート id と判定の件数・issue コード・ハーネスの版・動かしたホスト
- 提案の要約（proposals）: 提供元が既に知っている提案（配布物の公開 catalog にある id）の id と回数
- 未知の提案（new-candidates）: 同意の範囲に明示したときだけ。チャンネル固有の事実・端末のパス・
  人名・逐語の引用を含まないと確かめられた一般化した文

範囲を省いた `--enable` は settlements と proposals だけ。台本・プロンプト・根拠の文・session・
端末のパス・Channel Pack の語は入れない。語彙を照合できない端末では作らない。

送り先（`harness-feedback.mjs destination --endpoint <HTTPS の URL> --provider-key-fingerprint ed25519:<24hex>`）
が無いあいだは貯めるだけ。受領証がその提供元の鍵で署名されていなければ「届いた」と記録しない。
受け取る側が満たす仕様は、BuzzAssist のリポジトリの docs/harness-feedback-receiver-spec-ja.md（提供元の受け取り口の仕様なので、運営者への配布物には入れない）。

**エージェントは運営者の代わりに `consent --enable` を打たない。** 同意は運営者本人の決定であり、
`--human-verified` と同じく機械では証明できない。setup も対話のときだけ聞き、対話でなければ
聞かずに未同意のまま進む。

## 手動で作る bundle（v2）と送り直し

運営者側ではread-only curatorの出力を`harness-feedback.mjs create`で
Ed25519署名bundleへする。bundleは台本本文、Channel Pack payload、provider応答、
credentialを含まず、proposal ID・target・版・SHA・実測gateだけを運ぶ。
管理側endpointとtokenが設定済みなら、作成と同じ操作で耐久uploadまで行う。

```bash
BUZZASSIST_FEEDBACK_UPLOAD_TOKEN=... \
  node scripts/harness-feedback.mjs create \
  --report /absolute/export-report.json \
  --output /absolute/feedback-bundles/<bundle>.json \
  --private-key /absolute/operator-private.pem \
  --core-version <version> --harness <id> --harness-version <version> \
  --channel-pack-id <id> --channel-pack-version <version> \
  --channel-pack-sha <sha256> --source-host <claude-code-or-codex> \
  --upload --endpoint https://<owner-host>/v1/feedback/bundles

# network/5xxで止まったbundleを、同じdigestのままjournalから再送する
BUZZASSIST_FEEDBACK_UPLOAD_TOKEN=... \
  node scripts/harness-feedback.mjs sync \
  --bundle-dir /absolute/feedback-bundles \
  --endpoint https://<owner-host>/v1/feedback/bundles
```

upload tokenは環境変数だけから読み、bundleやjournalへ保存しない。remote endpointは
HTTPSに限り、URL内credential・query・fragmentを拒否する。network、408、425、429、5xx
だけを上限付きで再送し、4xx、server receiptのbundle digest不一致は恒久失敗として止める。
配達済みjournalは同じbundleを再送せず、管理側の冪等receiptへ再接続する。

## 管理側の受け取り（ingest）

管理側の入口は`harness-feedback-ingest.mjs`だけを使う。

```bash
# ownerが公開鍵と許可をローカル登録（この操作はHTTPへ公開しない）
# 手動の bundle（v2）の鍵: 許可する build の一覧をファイルで渡す
node scripts/harness-feedback-ingest.mjs enroll \
  --root var/feedback-ingest --operator <operator-id> \
  --public-key <operator-public.pem> --allowed-builds <allowed-builds.json> \
  --approved-by <owner-id>

# 自動の bundle（v3）の鍵（運営者の端末の keys/operator-feedback-ed25519.pub.pem）: 許可するハーネスを並べる。
# 用途の違う鍵は互いに使えない（--allowed-builds は渡さない）
node scripts/harness-feedback-ingest.mjs enroll \
  --root var/feedback-ingest --operator <operator-id> \
  --public-key <operator-feedback-ed25519.pub.pem> \
  --key-use auto-feedback --allowed-harness-ids <harness-id>[,<harness-id>...] \
  --approved-by <owner-id>

# upload API。tokenは引数へ書かず環境変数で渡す
BUZZASSIST_FEEDBACK_UPLOAD_TOKEN=... \
  node scripts/harness-feedback-ingest.mjs serve --root var/feedback-ingest

# ownerがverified quarantineを確認してからcurator観測へ昇格
node scripts/harness-feedback-ingest.mjs approve \
  --root var/feedback-ingest --bundle-digest <sha256> \
  --approved-by <owner-id> --reason "確認内容"
```

受付はBearer tokenと登録済みoperator署名を両方検証する。同じbundle digestは冪等に
再接続し、同じsigner/source reportが別内容で来たらreplay conflictとして隔離する。
未登録・不正bundleはraw bytesを保存せず失敗metadataだけを残す。検証済みbundleも
即時反映せず`verified-quarantine`へ置き、owner承認後のimportも既知proposal IDの
観測回数にだけ加える。未知IDから規則本文を捏造せず、**正本は一切書き換えない**。

### 受け取り口の書き出しを取り込む（自動の bundle v3）

自動の bundle は提供元の受け取り口が受け、owner がその書き出し（JSON Lines）を `import-export` で取り込む。
受け取り口は gateId と catalog の照合を省いているので、ゲートの宣言・公開 catalog・本文の privacy の照合は
ここで必ず行う。通ったものも `verified-quarantine` に置くだけで、集計へ入るのは既存の `approve` のあと。

```bash
# まず何も書かずに照合だけ見る
node scripts/harness-feedback-ingest.mjs import-export --root var/feedback-ingest \
  --export feedback-export.jsonl --provider-key-fingerprint ed25519:<24桁hex> --dry-run

# 照合を通った bundle を verified-quarantine へ置く
node scripts/harness-feedback-ingest.mjs import-export --root var/feedback-ingest \
  --export feedback-export.jsonl --provider-key-fingerprint ed25519:<24桁hex>
```

- `--provider-key-fingerprint` は受け取り口の受領証の鍵の指紋。渡さないと照合だけして「未検証」として数え、
  隔離へは置かない（取り込みの記録だけを残して exit 2）。`--dry-run` は何も書かない
- 書き出しは差分ではなく、毎回「保持期限内の全件」。取り込みは `bundleDigest` で冪等で、前に取り込んだものは
  「取り込み済み」として数える。前に取り込んだ bundle が次の書き出しに出てこなくなるのは正常で、記録は消さない
- 運営者の公開鍵の登録と失効は、受け取り口と管理側の**両方**で行う。受け取り口だけで失効すると書き出しに出なく
  なり、管理側だけで失効すると取り込みで `FEEDBACK_SIGNER_REVOKED` になる
- 落ちた bundle は理由のコードを取り込みの記録（`export-imports/`）に残し、隔離へ入れない。本文は記録へ写さない。
  受け取る側の詳しい仕様は、リポジトリの docs/harness-feedback-receiver-spec-ja.md の「持ち主の取り込み」
