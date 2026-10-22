# 設計メモ: 自動 feedback の同意をエージェントの質問 UI で聞く

作成日: 2026-10-22。状態: **案（未実装）**。きっかけは
[受け取り口の本番接続の手順書](harness-feedback-receiver-production-connect-ja.md) の判断点 D4
（当面は手動の `consent --enable` を案内し、この口は次の改善として扱う）。

## 困っていること

同意は `scripts/setup-agents.mjs` の終わりで `promptFeedbackConsent`（`lib/harnessFeedbackOutbox.mjs`）が聞く。
これは標準入力と標準出力が**両方とも端末のときだけ**聞き、そうでなければ何も記録せずに
`BUZZASSIST_FEEDBACK_CONSENT=unset (non-interactive)` を出して終わる。

ところが setup は普通エージェント（Claude Code・Codex）が Bash から流す（`CLAUDE.md`・`docs/agent-setup.md`）。
その場合は非対話なので**一度も聞かれず、誰も送らない**。手動の `consent` を知っている運営者しか送らないので、
戻ってくる声が偏り、件数も少ない。

## 変えないこと

- 既定は送らない。黙っているかぎり何も作らない
- 同意は人が決める。エージェントが代わりに答えない・推測しない・「推奨」を付けて誘導しない
- 聞く中身は今の対話の文と同じ2問（送るか／未知の改善の文も送るか）。範囲も今の `settlements,proposals` と全部の2通り
- 断ったら「送らない」を記録し、次の setup・更新では聞かない（今と同じ）
- 更新（updater）・dry-run・子エージェントでは聞かない（今と同じ）

## 案

### 1. setup が「聞いてほしい」と知らせる

非対話で記録が無いとき、`setup-agents.mjs` は今の1行に加えて、エージェント向けの1行を出す:

```
BUZZASSIST_FEEDBACK_CONSENT=unset (non-interactive)
BUZZASSIST_FEEDBACK_CONSENT_ASK=node scripts/harness-feedback.mjs consent-question
```

`consent-question`（新設）は、聞く文と選択肢と、答えごとに打つコマンドを JSON で出すだけ（何も書かない）:

```json
{
  "version": "buzzassist-feedback-consent-question-v1",
  "questions": [
    { "id": "send", "text": "BuzzAssist の提供元へ、運営で分かった改善の材料を送りますか？（既定は送りません）",
      "detail": "送るのはゲートの合否の件数・ハーネスの版・動かしたホスト・提案の ID だけで、台本・プロンプト・パス・人名・チャンネル固有の語は含みません。あとから取り消せます。",
      "options": ["送らない", "送る"] },
    { "id": "newCandidates", "askWhen": "send=送る",
      "text": "提供元がまだ知らない改善候補（チャンネル固有の語を含まないと確かめた一般化した文）も送りますか？",
      "options": ["送らない", "送る"] }
  ],
  "commands": {
    "decline": "node scripts/harness-feedback.mjs consent --disable --via agent-question",
    "basic": "node scripts/harness-feedback.mjs consent --enable --scopes settlements,proposals --via agent-question",
    "all": "node scripts/harness-feedback.mjs consent --enable --scopes settlements,proposals,new-candidates --via agent-question"
  }
}
```

文の正本は1か所に置き、対話の `promptFeedbackConsent` と `consent-question` の両方がそこから読む（文が2つに割れないように）。
選択肢の順は「送らない」を先にし、どちらにも「推奨」を付けない。

### 2. エージェントが質問 UI で聞く

`docs/agent-setup.md`（と、生成元の `config/host-instructions.template.md` の該当行）に次を足す:

- `BUZZASSIST_FEEDBACK_CONSENT_ASK` が出たら、そのコマンドを打って質問を取り、**ホストの質問 UI**（Claude Code の
  AskUserQuestion、Codex の request_user_input）で1問ずつ聞く。文と選択肢は変えない
- 答えに対応するコマンドだけを打つ。答えが得られなかった・「その他」で別のことを言われたときは何も打たない（未同意のまま）
- 送ると答えたら、公開鍵の置き場と keyId を示し、「提供元に公開鍵を渡して登録してもらい、送り先を設定するまでは
  端末に貯めるだけ」と伝える（D3 で送り先を同梱しないため）

### 3. 記録で区別する

- `FEEDBACK_CONSENT_VIAS`（`lib/harnessLearningState.mjs`）に `agent-question` を足し、CLI に `--via` を足す
  （受けるのは `cli` と `agent-question` だけ。`setup` は対話の setup の印として残す）
- `consentDigestOf` は `via` を含むので、どの経路で同意したかが bundle の `consent.consentDigest` に結び付く。
  bundle の形は変えない（v3 のまま。受け取り口の変更は要らない）

### 4. 代わりに答えさせない守り

完全には防げない（エージェントは同じコマンドを打てる）ので、次で「黙って同意される」のを減らす:

- `consent --enable --via agent-question` は、直前に `consent-question` が出した使い捨ての印（`--question-token`）を
  要るようにする。印は `consent-question` が学習の置き場へ書き、10分で切れ、1回で消える。印が無い・切れている
  ときは拒否する（質問を出さずに同意だけ打つ近道を塞ぐ）
- harness-guard-hook の人専用の操作には入れない（入れるとエージェントが質問 UI の答えを反映できなくなる）。
  代わりに `outbox` と `consent` の表示に `via` と `decidedAt` を出し、運営者が後から確かめられるようにする

## 試験

- 非対話で記録が無い → 2行が出る。記録があれば出ない。更新・dry-run・子エージェントでは出ない
- `consent-question` は何も書かない（印だけ）。文が対話の setup と同じ正本から来る
- 印なしの `--via agent-question` は拒否。印つきは1回だけ通る。切れた印は拒否
- `--via agent-question` の同意で作った bundle が今の受け取り口の試験の見本で通る（形を変えていない確認）

## 決めること（実装の前に）

- 印（`--question-token`）まで入れるか、文書の案内だけで始めるか
- 2問目（未知の改善の文）をエージェント経由でも聞くか、エージェント経由は1問目だけ（`settlements,proposals`）にするか
