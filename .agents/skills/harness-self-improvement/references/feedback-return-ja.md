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
受け取る側が満たす仕様は `docs/harness-feedback-receiver-spec-ja.md`。

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
# ownerが公開鍵と許可Harnessをローカル登録（この操作はHTTPへ公開しない）
node scripts/harness-feedback-ingest.mjs enroll \
  --root var/feedback-ingest --operator <operator-id> \
  --public-key <operator-public.pem> --harnesses <harness-id> \
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
