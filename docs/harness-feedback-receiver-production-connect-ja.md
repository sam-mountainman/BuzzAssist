# 自動 feedback の受け取り口を本番につなぐ手順書

作成日: 2026-10-22。状態: **ローカルの往復は確認済み。本番は未接続**。判断点は 2026-10-22 に決定（§5）、実施は 10/26〜31 の窓（§6）。
仕様の正本は [harness-feedback-receiver-spec-ja.md](harness-feedback-receiver-spec-ja.md)。受け取り口の実装と、
受け取り口側の配備の引き継ぎはオトシゴのリポジトリの `docs/engineering/feedback-intake.md` と
`docs/handoffs/2026-09-26-feedback-intake-receiver.md`（§3 が配備の手順）にある。

「配る → 使われる → 改善の声が戻る → 本体を磨く」のうち、**戻る道の最後の1本**（端末から提供元への送信）を
つなぐための手順。送信側（`lib/harnessFeedbackOutbox.mjs`）と受け取り口（オトシゴの `POST /v2/feedback/bundles`）は
どちらも実装済みで、欠けているのは「受け取り口の本番での有効化」と「送り先を端末へ配ること」だけ。

## 1. つなぐのに要るもの

| もの | どこで決まる・作る | 今の状態（2026-10-22） |
|---|---|---|
| 受け取り口のコード | オトシゴ `server/otoshigo/feedback_intake/`・`api/routes/feedback_intake.py` | main にある。本番の API は full 構成で、この経路は full にも mount される |
| 表（migration `0045_feedback_intake`、級別 A） | オトシゴの本番 DB | **適用済み**（10/16 に 0043→0048、DB は今 0052） |
| エッジの経路 `feedback_bundles`（認証なし・JSON のみ・IP 120/分・2000/時・1 MiB） | `edge/src/policy.ts` → Cloudflare Worker `otoshigo-edge-gateway` | main にある。**配備済みの Worker に入っているかは記録が無い** |
| 受領証の鍵 `OTOSHIGO_FEEDBACK_RECEIPT_SIGNING_KEY`（提供元の Ed25519） | オトシゴ本番の秘密値（age で暗号化した `full` profile） | **未注入**。未注入のあいだ受け取り口は 503 を返す（端末は再送で待つ） |
| 受領証の鍵の指紋 `ed25519:<24桁hex>` | 鍵を作ったときに出る | 未発行 |
| URL | `https://api.otoshigo.ai/v2/feedback/bundles`（予定） | 未確定（判断点 D1） |
| 送り手（運営者）の公開鍵の登録 | 受け取り口の `enroll` と、管理側の `harness-feedback-ingest.mjs enroll` の**両方** | 未登録 |
| 送り先の配布 | `config/feedback-destination.json`（配布物に同梱）か、運営者ごとの `destination` | 未作成（判断点 D3） |
| 運営者の同意 | 端末の `consent`（既定は送らない） | setup の対話でだけ聞く（判断点 D4） |

秘密値は**提供元の受領証用の鍵1本だけ**。送り手の認証は bundle の Ed25519 署名と登録簿で決まり、
token も `Authorization` も使わない。運営者の秘密鍵は端末から出ない（渡すのは公開鍵だけ）。

### プライバシーとオプトイン

- 既定は送らない。同意（`consent --enable`）が無ければ bundle を作らず、置き場のディレクトリも作らない
- 同意の範囲は `settlements`（決着の要約）・`proposals`（既知の提案の再発）・`new-candidates`（一般化した改善の文）。
  setup の対話で「はい」と答えると前の2つ、2問目にも「はい」で3つ全部
- bundle は端末で検査語彙・Channel Pack の語・端末のパス・URL・長い引用を照合し、当たる文は送らずに端末へ残す
  （`held`）。受け取り口は語彙を持たないので、owner の取り込み（`import-export`）で管理側の語彙に対して照合し直す
- 受け取り口は中身を製品のどこにも反映しない。保持は受領から1年で物理削除。オトシゴの
  データ台帳（`docs/operations/data-lifecycle-register.md` の区分 Q）に載っていて、DB の backup に含まれる

### 再送とレート制限

- 端末: 408 / 425 / 429 / 5xx / 通信断だけ指数バックオフで再送（Job の決着時は2回・全体15秒まで、
  1 bundle で合計12回まで。運営者の `send` は4回ずつ）。それ以外の 4xx と信頼できない受領証は恒久失敗で止まり、
  運営者が `send` で試し直すか `purge` で消す
- 送り先を設定した直後に溜まった bundle がまとめて出る（自動は1回20件まで）。エッジの 120/分で足りる
- 受け取り口は `bundleDigest` で冪等（同じ bytes は 200 `duplicate: true`）。同じ決着の別 bundle は 409

## 2. ローカルでの往復の確認（2026-10-22 に実施）

本番・クラウド・DNS・課金には触れていない。受け取り口はオトシゴの `origin/main` をスクラッチ領域へ
`git archive` で取り出して起動し、オトシゴのリポジトリ・本番の DB・運営者の本物の学習の置き場は使っていない。
鍵は全部その場限りのテスト用（受領証の鍵・運営者の鍵とも）。

構成: SQLite・`OTOSHIGO_SERVICE_MODE=full`・`OTOSHIGO_DEBUG=true`、`uvicorn` を `127.0.0.1` で起動
（accounts 構成は debug=false でしか起動しないので、ローカルでは full にした。経路はどちらにも mount される）。
端末側は `BUZZASSIST_LEARNING_DIR` をスクラッチ領域へ向け、送り先は `http://127.0.0.1:<port>/v2/feedback/bundles`
（送信側は localhost だけ HTTP を許す）。bundle は試験と同じ合成の Job（`narrated-story-video`、ゲート1つ失敗）から作った。

| 手順 | 結果 |
|---|---|
| 受け取り口 `generate-receipt-key --out <file>`（mode 600、標準出力は path と指紋だけ） | 成功 |
| `GET /healthz`・不正な本文の `POST` | 200・400 `FEEDBACK_INGEST_INVALID` |
| 端末 `harness-feedback.mjs consent --enable --scopes settlements,proposals,new-candidates` | 署名鍵を作り keyId を表示 |
| 受け取り口で利用者を1件作り、`enroll --user-id … --public-key-file … --allow-harness narrated-story-video` | 登録 |
| 端末 `destination --endpoint … --provider-key-fingerprint …` → `outbox` | 同意・送り先・語彙の照合とも有効 |
| 合成の決着から bundle を積む（決着・既知の提案1・未知の候補1） | `queued` |
| 端末 `send` | **202**、受領証を検証して `delivered`、`sent.jsonl` に記録 |
| 同じ bytes をもう一度 `POST` | 200 `duplicate: true`、`receivedAt` は初回のまま |
| 受け取り口 `export` | bundle 1・rejection 1・summary（`inactiveSigners: []`） |
| 管理側 `harness-feedback-ingest.mjs enroll --key-use auto-feedback` → `import-export --dry-run` → 本番実行 | `wouldQuarantine 1` → `quarantined 1`、受領証の検証 1、`bundlesMatch: true` |
| 端末の指紋を間違えて新しい bundle を `send` | 受け取り口は 202 で保存したが、端末は `receipt-untrusted` の恒久失敗で止まり「届いた」と記録しない |
| 指紋を直して `send` | `delivered`（`duplicate: true`）。設定違いは運営者の `send` で回復できる |

`import-export` は受け取り口が省いた照合（ゲート id・提案 catalog・管理側の語彙）を、合成の写し
（`--code-root`）で通した。本物の写しで流すときは検査語彙の鍵が要る（無ければ止まる）。

## 3. 本番に出す手順（順番どおりに。全部 owner の確認のあと）

### 段 0: 決める（§5。2026-10-22 に決定済み）

### 段 1: 受け取り口を開く（オトシゴ本番。オトシゴの運用手順に従う）

オトシゴの今の手順書は `docs/handoffs/2026-10-20-handoff-to-codex.md` §3・
`docs/operations/digitalocean-control-plane-runbook-20260925.md`・`digitalocean-full-window-20261018.md`。
受け取り口の引き継ぎ（9/26）§3 の「secrets.env 相当」は、今の構成では age の `full` profile のこと。

1. migration: **不要**（0045 は適用済み）。念のため本番 DB の revision が 0045 以上であることを見る
2. 受領証の鍵を作る。値を画面・ログ・repo・チャットへ出さない。本番の API と同じ image の使い捨てコンテナで
   `python -m otoshigo.feedback_intake generate-receipt-key --out <file>` を打つと、mode 600 のファイルに1行が書かれ、
   標準出力には path と指紋だけが出る。**コンテナの中に書いたファイルを取り出す手順はオトシゴに無い**
   （判断点 D2）。ホストの tmpfs をコンテナへ mount して書かせる・ホストで同じ処理を流す、のどちらかを決める
3. その値を `full` profile の秘密値へ入れる: ホストの root で
   `bash /srv/otoshigo/deploy/secrets.sh add full OTOSHIGO_FEEDBACK_RECEIPT_SIGNING_KEY`（隠し入力か標準入力）。
   元のファイルは消す。`secret_env.py` の一覧に無い名前は「空でない」ことだけを確かめる
4. API を作り直す（動いているコンテナは古い環境のまま）。full 構成の手順（full-down → deploy_api →
   config-runtime → full-up、handoff §3.1）。作り直しで止まる時間は数分（判断点 D6）
5. 確かめる: 使い捨てコンテナで `python -m otoshigo.feedback_intake receipt-key-fingerprint` が手順 2 と同じ指紋を出す
6. エッジ: 配備済みの Worker に `feedback_bundles` の経路が入っているかを見る。無ければ main の
   `edge/src/policy.ts` を含む版を wrangler で配る（`maintenance.sh` も毎回エッジを配り直すので、配る元の
   worktree が main の経路を含むことを先に確かめる）
7. 外から確かめる: 空の本文の `POST https://api.otoshigo.ai/v2/feedback/bundles` が 400
   `FEEDBACK_INGEST_INVALID`（503 なら鍵が入っていない、404 ならエッジかオリジンに経路が無い）。
   拒否の metadata が1行残るだけで害は無い

### 段 2: 送り手を登録する（運営者1人ごと）

1. 運営者が自分の端末で同意する（`consent --enable`、または setup の対話）。端末に
   `~/.buzzassist/learning/feedback/keys/operator-feedback-ed25519.pub.pem` ができる
2. 運営者がその**公開鍵だけ**を別経路で owner へ渡し、`outbox` の `signer.keyId` を owner と口頭などで突き合わせる
3. 受け取り口で登録: 使い捨てコンテナで
   `python -m otoshigo.feedback_intake enroll --user-id <オトシゴの利用者 ID> --public-key-file <pem> --allow-harness <id> … --reason "…"`。
   利用者 ID は active な実在の利用者（判断点 D5）
4. 管理側で登録: `node scripts/harness-feedback-ingest.mjs enroll --root <管理側の置き場> --operator <id>
   --public-key <pem> --key-use auto-feedback --allowed-harness-ids <同じ一覧> --approved-by <owner>`
   （許す harness は受け取り口と同じにする）

### 段 3: 送り先を配る

- 同梱する場合（D3）: `config/feedback-destination.json` を作り、`package.json` の `files` に足して次の版で配る:
  `{"version":"buzzassist-feedback-destination-v1","endpoint":"https://api.otoshigo.ai/v2/feedback/bundles","providerKeyFingerprint":"ed25519:<24桁hex>"}`
- 同梱しない場合: 運営者ごとに
  `node scripts/harness-feedback.mjs destination --endpoint https://api.otoshigo.ai/v2/feedback/bundles --provider-key-fingerprint ed25519:<24桁hex>`
- **登録（段 2）より先に送り先だけ配ると、未登録の端末の送信が 403 の恒久失敗で止まる**（自動では試し直さない）。
  同梱するなら、配る版を出す前に登録の流れを決めておく

### 段 4: 最初の1件を確かめる

1. 運営者の端末で `outbox`（送り先 `configured: true`）→ `send`。結果が `delivered`
2. owner が受け取り口で `export > feedback-export.jsonl` → 管理側で `import-export --dry-run` → 本番実行 →
   `curation/<bundleDigest>.json` を読んで `approve` / `reject`
3. 書き出しを誰がいつ回すかを決める（例: 週1回。判断点 D6）。保持期限の削除は full 構成なら scheduler が受け取りの
   たびに進め、残りは `purge-expired`

## 4. 止める・戻す

| 戻したいこと | やり方 | 影響 |
|---|---|---|
| 受け取りを止める（緊急） | `full` profile から `OTOSHIGO_FEEDBACK_RECEIPT_SIGNING_KEY` を外して API を作り直す | 受け取り口だけが 503。端末は再送の上限まで待ってから送信待ちに残す（消えない）。他の機能に影響しない |
| 特定の送り手を止める | 受け取り口 `revoke <keyId> --reason …` と、管理側 `harness-feedback-ingest.mjs revoke --operator <id> --key-id <keyId>` の両方 | その鍵の送信は 403、受理済みの分も書き出し・集計から外れる |
| 端末を送らない状態へ戻す | 運営者が `consent --disable`、送り先は `destination --clear`、溜まった分は `purge --confirm` | 以後作らない・送らない |
| 同梱した送り先を取り下げる | `config/feedback-destination.json` を外した版を出す | 運営者が自分で設定した送り先は残る |
| 受領証の鍵を替える | 新しい指紋を**先に**送り先として配ってから鍵を切り替える | 端末は1つの指紋しか信じないので、順を逆にすると全員が `receipt-untrusted` で止まる |
| API の配備を戻す | オトシゴの `rollback_api.py --list` / `--to runtime.before-<label>.env` | この作業は image を替えないので、普通は秘密値を外すだけで足りる |
| 表を消す | 0045 の downgrade はあるが行があれば拒否し、0049・0052（級別 B）も戻すことになる | **やらない**。止めるのは鍵を外すことで足りる |

## 5. 決めたこと（2026-10-22、owner が推奨案を採用）

owner の回答は「推奨案で、10/26〜31に（推奨）」。下の6点をまとめて採用した（このセッションの親セッション経由で受けた）。

| 判断点 | 決定 |
|---|---|
| D1 URL | `https://api.otoshigo.ai/v2/feedback/bundles` で確定 |
| D2 受領証の鍵 | 本番ホストの tmpfs をコンテナへ mount して `generate-receipt-key` に書かせ、その場で `secrets.sh add full OTOSHIGO_FEEDBACK_RECEIPT_SIGNING_KEY` へ標準入力で入れ、元のファイルは消す。値は画面・ログ・repo・チャットへ出さない。控えの置き場は当日までに owner が決める（§6.1） |
| D3 送り先の同梱 | 当面は同梱しない。送り手ごとに `destination` を設定する（`config/feedback-destination.json` は作らない） |
| D4 同意の聞き方 | 当面は手動の `consent --enable` を案内する。エージェントの質問 UI で聞く口は次の改善として別に扱う（設計メモ [harness-feedback-consent-agent-prompt-design-ja.md](harness-feedback-consent-agent-prompt-design-ja.md)） |
| D5 送り手の利用者 | BuzzAssist の送り手用にオトシゴの利用者を1つ作り、送り手の鍵を全部そこへ結びつける（その利用者を止めると全員の鍵が止まる。個別に止めるときは鍵の `revoke`） |
| D6 時期 | 既に予定している 10/26〜31 の本番反映の窓にまとめる。API の作り直しはその窓の作り直しと1回にまとめてよい |

## 6. 当日のチェックリスト（10/26〜31 の窓）

オトシゴ側の操作はオトシゴの手順書（`docs/handoffs/2026-10-20-handoff-to-codex.md` §3、
`docs/operations/digitalocean-control-plane-runbook-20260925.md`）に従う。下は受け取り口のために足す分だけ。
コマンドの `$DC` は `cd /srv/otoshigo/deploy && DC="docker compose --env-file runtime.full.env -f compose.full.yml --profile full"`。

### 6.1 当日までに owner が用意するもの

- [ ] **送り手用のオトシゴ利用者（D5）**: 専用のメールアドレス（例: BuzzAssist の送り手専用に作る受信箱）で
      オトシゴに会員登録し、メールの確認まで済ませて `active` にする。利用者 ID は当日 `ops find-user --email -`
      で引く（メールアドレスは標準入力で渡し、履歴に残さない）
- [ ] **受領証の鍵の控えの置き場（D2）**: 鍵を失うと、送り先を設定した端末全員の指紋を替えることになる。
      控えを持つなら置き場（例: owner のパスワード管理の秘密メモ）を決める。持たないなら「失ったら作り直して全員に
      新しい指紋を配る」と決めておく。age で暗号化した `full` profile のファイル自体が backup に入っているかも確かめる
- [ ] **最初の送り手の公開鍵**: 最初に送る運営者（owner 自身の端末でよい）が `consent --enable` を済ませ、
      `~/.buzzassist/learning/feedback/keys/operator-feedback-ed25519.pub.pem`（公開鍵だけ）と `outbox` の
      `signer.keyId` を手元に用意する
- [ ] **許す harness の一覧**: 例 `narrated-story-video`・`koya-manga-video`（受け取り口と管理側で同じにする）
- [ ] **管理側の置き場**: `harness-feedback-ingest.mjs --root` に使う場所（git で追跡しない場所。例 `var/feedback-ingest`）
- [ ] **窓の中の順番**: 同じ窓で API を作り直す予定があれば、秘密値の追加をその前に入れて作り直しを1回にする

### 6.2 事前の確認（窓を開ける前。どれかが違えば止めて理由を確かめる）

| 確かめること | コマンド（ホストで） | 期待 |
|---|---|---|
| DB の revision | `$DC run --rm --no-deps -T api alembic current`（またはオトシゴの手順の revision 確認） | 0045 以上（今は 0052） |
| 配る image に受け取り口がある | `$DC run --rm --no-deps -T api python -m otoshigo.feedback_intake --help` | 使い方が出る |
| 鍵がまだ無い | `$DC run --rm --no-deps -T api python -m otoshigo.feedback_intake receipt-key-fingerprint` | 鍵が無いという失敗（指紋が出たら誰かが既に入れている。上書きせず止める） |
| 名前がまだ無い | `bash /srv/otoshigo/deploy/secrets.sh check`（値は出ない） | `OTOSHIGO_FEEDBACK_RECEIPT_SIGNING_KEY` が無い |
| エッジの配る元に経路がある | Mac で `grep -n feedback_bundles <エッジを配る worktree>/edge/src/policy.ts` | 経路の定義がある |
| 今の外の応答 | `curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{}' https://api.otoshigo.ai/v2/feedback/bundles` | 503（鍵なし）か 404（経路なし）。どちらかを記録しておく |

### 6.3 実行順と各段の確認

1. **SSH の窓を開ける**（`ssh_window.py open … --minutes 30`）
2. **鍵を作って入れる（D2）**。ホストの root で、値を一度も表示しない:

   ```bash
   install -d -m 700 -o <API コンテナの UID> /dev/shm/otoshigo-feedback
   $DC run --rm --no-deps -T -v /dev/shm/otoshigo-feedback:/out api \
     python -m otoshigo.feedback_intake generate-receipt-key --out /out/feedback-receipt.env
   # 標準出力の「指紋: ed25519:<24桁hex>」だけを控える（値は出ない）
   cut -d= -f2- /dev/shm/otoshigo-feedback/feedback-receipt.env \
     | bash /srv/otoshigo/deploy/secrets.sh add full OTOSHIGO_FEEDBACK_RECEIPT_SIGNING_KEY
   # 控えを持つ（6.1）なら、ここで決めた置き場へ移す。持たないなら消す
   shred -u /dev/shm/otoshigo-feedback/feedback-receipt.env; rmdir /dev/shm/otoshigo-feedback
   ```

   確認: `secrets.sh check` に名前が出る。`/dev/shm/otoshigo-feedback` が無い。
   止める条件: コンテナが mount 先に書けない（UID 違い）→ ホストのファイルを残さず消してから UID を確かめてやり直す。
   `secrets.sh add` が「名前が既にある」→ 誰かが入れている。`replace` せずに止めて確かめる
3. **API を作り直す**（full-down → deploy_api → config-runtime → full-up。窓の作り直しと1回にまとめてよい）。
   確認: オトシゴの手順どおり `/healthz` が 200、既存の機能の確認が通る
4. **指紋の一致**: `$DC run --rm --no-deps -T api python -m otoshigo.feedback_intake receipt-key-fingerprint`
   → 手順 2 で控えた指紋と同じ。違えば止める（違う鍵が入っている）
5. **エッジ**: 6.2 で 404 だったときだけ、経路を含む版を wrangler で配る。確認は次の手順 6
6. **外から確かめる**: 6.2 の `curl` が **400**（本文は `{"ok":false,"code":"FEEDBACK_INGEST_INVALID",…}`）。
   503 → 鍵が API に届いていない（手順 3 をやり直す）。404 → 経路が無い（手順 5）。415/413 → エッジの形の応答
7. **送り手の登録（受け取り口）**:

   ```bash
   echo '<送り手用のメールアドレス>' | $DC run --rm --no-deps -T api python -m otoshigo.ops find-user --email - --reason "D5 feedback 送り手の登録"
   $DC run --rm --no-deps -T -v <公開鍵を置いたホストのディレクトリ>:/in:ro api python -m otoshigo.feedback_intake enroll \
     --user-id <上で引いた ID> --public-key-file /in/operator-feedback-ed25519.pub.pem \
     --allow-harness narrated-story-video --allow-harness koya-manga-video --reason "最初の送り手の登録" --yes
   $DC run --rm --no-deps -T api python -m otoshigo.feedback_intake list-keys
   ```

   確認: `登録しました: ed25519:…` が 6.1 の `signer.keyId` と同じ。`list-keys` に `active` で1行
8. **送り手の登録（管理側。owner の Mac）**:
   `node scripts/harness-feedback-ingest.mjs enroll --root <管理側の置き場> --operator <id> --public-key <pem> --key-use auto-feedback --allowed-harness-ids narrated-story-video,koya-manga-video --approved-by <owner>`
9. **端末の送り先（D3）**: 送り手の端末で
   `node scripts/harness-feedback.mjs destination --endpoint https://api.otoshigo.ai/v2/feedback/bundles --provider-key-fingerprint <手順 2 の指紋>`
   → `outbox` で `destination.configured: true`
10. **最初の1件**: 送り手の端末で `send`（送信待ちが無ければ、決着した Job を1つ待つ）。
    期待: `delivered`。`permanentFailure` の `code` が `receipt-untrusted` → 指紋の設定違い（手順 9 を直して `send`）、
    `FEEDBACK_SIGNER_NOT_ENROLLED`・`FEEDBACK_HARNESS_NOT_ALLOWED` → 登録違い（手順 7）
11. **書き出しと取り込み**: ホストで `$DC run --rm --no-deps -T api python -m otoshigo.feedback_intake export > <ホストの一時場所>`
    → owner の Mac へ移して `import-export --provider-key-fingerprint <指紋> --dry-run` → 本番実行 → `curation/` を読んで
    `approve` / `reject`。期待: `providerReceipts.verified` が bundle の数と同じ、`bundlesMatch: true`。
    書き出しのファイルはホストに残さない
12. **SSH の窓を閉じる**（`ssh_window.py close`）。手順書の §1 の「今の状態」を更新する

### 6.4 止める条件（その場で止めて、§4 で戻す）

- 手順 3 の作り直しのあとに、受け取り口と関係の無い既存の確認が落ちた → オトシゴの手順で API を戻す（秘密値の追加だけでは落ちないはず）
- 手順 4 の指紋が違う・手順 6 が 400 にならない
- 受け取り口の 5xx がログに続けて出る（`feedback intake failed unexpectedly`）
- 拒否の表が想定外に増える（認証の無い入口なので、知らない送信が来ていれば IP のレートを見直す）

### 6.5 ロールバック（窓の中で）

- **受け取りだけを止める**: `secrets.sh` で `OTOSHIGO_FEEDBACK_RECEIPT_SIGNING_KEY` を外して API を作り直す
  （受け取り口だけが 503、他は影響なし。端末は送信待ちに残す）
- **送り手を止める**: 受け取り口 `revoke <keyId> --reason …` と管理側 `revoke --operator <id> --key-id <keyId>` の両方
- **端末**: `destination --clear`（送信待ちは残る）
- API の image を戻すのはオトシゴの `rollback_api.py`。表（0045）は戻さない（§4）

### 6.6 終わったあと

- 手順書 §1 の「今の状態」と、オトシゴの `docs/product/decisions.md` の D-FEEDBACK-INTAKE の状態（未配備 → 配備済み）、
  `data-lifecycle-register.md` の区分 Q の状態を更新する（オトシゴ側の記録はオトシゴの session で）
- 書き出しと取り込みの間隔を決める（D6 の残り。例: 週1回）
- 2人目以降の送り手は 6.3 の手順 7〜9 だけを繰り返す（同じ利用者 ID に結びつける）
