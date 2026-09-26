# 戦略の道具から制作へ渡す仕様（戦略ブリーフの受け渡し）

この文書は、運営者が BuzzAssist とは別に保守している YouTube 戦略の道具（以下 HYP）と、BuzzAssist の
制作ハーネスをつなぐ仕様です。HYP の側（HYP を保守・実行するセッション）と BuzzAssist の上位ハーネスの側が、
同じ形・同じ手順で受け渡すために書きます。

BuzzAssist は HYP を取り込みません。HYP の手順・文面・スクリプトを写さず、実行もしません。BuzzAssist が
持つのは、受け取る形・ファイルの SHA・機械で決まる照合だけです。企画の判断（何を作るか、なぜ作るか）は
HYP と、HYP を使うホストの AI がします。

実装の正本:

- `scripts/strategy-brief.mjs`（入口。`draft` / `validate` / `applicability` / `start` / `sheet` / `record` / `verdict` / `next`）
- `lib/strategyBriefDraft.mjs`（HYP の作業フォルダから下書きを組み立てる）
- `lib/strategyBrief.mjs`（ブリーフの形・根拠の照合・前提と当てはまり）
- `lib/strategyBriefQualityLoop.mjs`（企画の品質ループと verdict）
- `config/strategy-brief.schema.json`（ブリーフの形。版は `buzzassist-strategy-brief-v1`）

## 1. 何を解くか

これまでブリーフは誰かが手で書く前提でした。それでは HYP の判断が制作へ届いたかを機械で確かめられず、
毎回の手作業が制作の前提になります。ここでは次のように分けます。

| 担当 | すること |
|---|---|
| HYP の側 | 調査・分析・企画の判断をして、作業フォルダに成果物を置く。できれば機械が読める受け渡しファイル（`strategy-handoff.json`）も書く |
| BuzzAssist（機械） | 作業フォルダから集められるもの（ファイルの SHA、4分析の run が現行か、分析の出力の形、根拠の表の行）を集め、ブリーフの下書きにする。形・対応・根拠を照合する |
| 上位の AI（ホスト） | 下書きの「機械で埋められない欄」を、HYP の成果物を読んで埋める。前提を変えたら、根拠ごとに今の前提へ当てはまるかを判定して記録する |
| 別の文脈の評価者 | ブリーフを企画の品質ループで採点する（作った文脈は採点できない） |

人が毎回ブリーフを手で書くことは前提にしません。人が見るのは、品質ループが人の判断を求めて止まったときです。

## 2. 作業フォルダの置き方

1つのチャンネルに1つの作業フォルダを使うのを勧めます（前の回の根拠を相対パスのまま引き継げるため）。
作業フォルダは運営者の私有側に置き、BuzzAssist のリポジトリや Channel Pack の中には置きません。

```text
<チャンネルの作業フォルダ>/
  brief.md                 HYP の作業文書（初期化が作る5つの名前。中身は上位の AI が読む）
  diagnosis.md
  content-plan.md
  experiments.md
  data-dictionary.md
  evidence.csv             根拠の表（任意。列は下の 3.4）
  strategy-handoff.json    機械が読める受け渡し（任意。形は下の 4）
  <任意のフォルダ>/<run>/run.json …          視聴者の4分析の run
  <任意のフォルダ>/metrics.json など          指標の集計・関連元の集計・取得スナップショット
  strategy-brief-r1.json   draft の出力（上位の AI が埋める。BuzzAssist が書く）
  quality/                 BuzzAssist の企画の品質ループの状態（HYP の側は書かない）
```

守ること:

- ブリーフの根拠は作業フォルダからの相対パスで指します。絶対パス・ドライブ名・`..` は受けません
  （Windows の `\` 区切りは `/` として読みます）
- シンボリックリンクはたどりません。作業フォルダの外のファイルは根拠になりません
- `quality/` の下は読み飛ばします。HYP の側はここへ書かないでください

## 3. `draft --from-hyp` が読むもの

```bash
node scripts/strategy-brief.mjs draft --from-hyp <作業フォルダ> --channel <チャンネルの id> \
  [--previous <前のブリーフ>] [--strategy-skill-dir <HYP の採用版の置き場>] [--work-dir <dir>] --out <作業フォルダ>/strategy-brief-r1.json
```

HYP のスクリプトは実行しません（`--help` も呼びません）。作業文書の中身も読みません。読むのは次だけです。
集めた根拠の状態は、どれも既定で `provisional` です。`verified` へ自動では上げません。

### 3.1 視聴者の4分析の run

`run.json` のあるフォルダを run として扱い、その中へは降りません。`run.json`・`snapshot.json`・
`completed/<stage>.json`・`results/`・`stages/<stage>/packet.json` と入力4ファイル・`report.md`・
`report-manifest.json` の SHA の対応を照合し、`report-manifest.json` が今の結果と一致する（current）run だけを
根拠にします。根拠の SHA は `report-manifest.json` の SHA です。

| run の状態 | 扱い |
|---|---|
| current | 根拠（`kind: audience-run`） |
| stale | 外す（`strategy-evidence-audience-run-stale`）。結果を登録し直したらレポートを作り直す |
| none | 外す（`strategy-evidence-audience-run-none`）。レポートがまだ無い |
| invalid | 外す（`strategy-evidence-audience-run-invalid`） |

### 3.2 分析の出力の JSON

作業フォルダの `.json` を読み、次の形のものだけを根拠にします。ほかの JSON は `sources.ignoredJson` に名前だけ出します。

| 形 | 見分け方 | 根拠の種類 | 前提 |
|---|---|---|---|
| 指標の集計 | `schema_version: "1.1"` と `groups` 配列 | `metrics` | 前提に依らない（所有者の実測） |
| 関連元の集計 | `schema_version: "1.0"` と `categories` | `referrals` | 前提に依らない（所有者の実測） |
| 取得スナップショット | `schema_version: 1`・`video_id`・`comments` か `transcript` | `snapshot` | 前提に結び付く |

### 3.3 作業文書

作業フォルダの直下にある `brief.md`・`diagnosis.md`・`content-plan.md`・`experiments.md`・`data-dictionary.md` を、
種類と SHA だけの根拠（`kind: planning-document`）にします。`data-dictionary.md` はデータの定義なので前提に
依らない根拠とし、ほかは前提に結び付けます。どの欄をどの文書から埋めるかは `needsAuthoring[].from` に出ます。

### 3.4 根拠の表 `evidence.csv`

1行目が見出しの CSV（RFC 4180。引用符・引用符の中の改行・CRLF・BOM を読めます）。列は
`evidence_id, observation, source_type, source_url_or_file, accessed_at, period_and_conditions, limitations`
で、`evidence_id` だけ必須です。

- 1行ごとに根拠の行（`kind: other`、id は `csv-<evidence_id>`）を作ります
- `source_url_or_file` が作業フォルダの中のファイルを指していれば、そのファイルの SHA に結びます。URL や
  見つからないものは `evidence.csv` そのものの SHA に結びます
- `accessed_at` が日付なら `collected.at` に、`period_and_conditions` を `collected.conditions` に入れます
- `observation` の列は `observations[]` にも入れます（id は `obs-<evidence_id>`、根拠はその行）
- `evidence_id` の無い行は飛ばし、行番号を `sources.evidenceCsv.skipped` に出します

### 3.5 前のブリーフ（`--previous`）

前のブリーフから、問い・見る人・入口の約束・回収・制作条件・公開後の指標・仮説・未確認事項と、根拠の行を
引き継ぎます。前提に結び付く根拠の行には、集めたときの前提（前のブリーフの前提の digest）を
`collected.premise` に書きます。同じファイルを作業フォルダから読んだ行とは二重にせず、前のブリーフの行の
id を保ちます（ファイルが書き直されていれば、今の SHA で取り直した根拠にします）。根拠の表の行は `evidence_id` で
前のブリーフの行と突き合わせ、同じ `evidence_id` の行は前のブリーフの id（と種類・状態）のまま、今の表のパス・SHA・
`collected`・注記に置き換えます（`-2` などの添字は、別の根拠と id がぶつかったときだけ付きます）。ファイルも SHA も
同じ行（表そのものに結ぶ行は、その行の記載が同じ行）は集めたときの前提と当てはまりの判定を引き継ぎ、ファイルか SHA が
変わった行は取り直した根拠として前の前提と判定を外します（6）。チャンネルが違う前のブリーフは受けません。

### 3.6 返すもの

```json
{
  "version": "buzzassist-strategy-brief-draft-v1",
  "modelCallsAttempted": false,
  "strategyToolScriptsRun": false,
  "sources": { "handoff": {}, "documents": [], "audienceRuns": [], "dataFiles": [], "evidenceCsv": {}, "ignoredJson": [] },
  "strategySkill": { "fingerprint": "sha256:…", "fileCount": 42 },
  "briefDraft": { "version": "buzzassist-strategy-brief-v1", "question": null, "evidence": [] },
  "needsAuthoring": [
    { "field": "question", "priority": "required", "action": "author",
      "from": [{ "path": "brief.md", "role": "decision-premise" }, { "path": "content-plan.md", "role": "content-plan" }],
      "how": "動画が答える問いを1つだけ書く（…）" }
  ],
  "excludedEvidence": [{ "source": "scan", "kind": "audience-run", "path": "research/run-002", "reasonCode": "strategy-evidence-audience-run-stale" }],
  "issues": ["strategy-skill-version-unrecorded"],
  "draftIssues": ["missing:question"],
  "written": { "path": "strategy-brief-r1.json", "sha256": "…" },
  "nextSteps": []
}
```

- 機械で埋められない欄は `null`・空のまま返します。仮の文言では埋めません（形の検査を通らないので、埋め忘れが残りません）
- `needsAuthoring[].action` は `author`（埋める）か `confirm`（受け渡しファイル・前のブリーフから入れたので確かめる）
- `priority: required` の欄: 問い・見る人・見る理由・入口の約束・回収・制作条件の形式と条件・公開後の指標・
  チャンネル設計の版・作った文脈（ホストと会話の ID）。`recommended`: 残す点と変える点・仮説・未確認事項
- 成果物が作業フォルダに無い欄は、`how` に「HYP の工程を実行してから埋める（推測で埋めない）」と出ます

## 4. 受け渡しファイル `strategy-handoff.json`（任意・優先）

HYP の側が機械の読める形で判断を書けるなら、作業フォルダの直下にこのファイルを置いてください。
`draft` はこれを作業文書より優先して取り込み、上位の AI が埋める欄を減らします。書かない欄は、前のブリーフ
（あれば）か `needsAuthoring` に回ります。

```json
{
  "version": "buzzassist-strategy-tool-handoff-v1",
  "channel": { "id": "sample-channel", "designVersion": "design-v2" },
  "strategySkill": { "fingerprint": "sha256:<HYP の採用版の指紋>" },
  "producedBy": { "host": "codex", "contextId": "<HYP を実行した会話の ID>" },
  "question": "動画の問い（1つ）",
  "audience": { "who": "見る人", "whyWatch": "見る理由" },
  "entry": { "promises": [{ "id": "p-title", "surface": "title", "text": "入口の約束" }] },
  "payoffs": [{ "promiseId": "p-title", "where": "本文で回収する箇所" }],
  "production": { "format": "long", "conditions": ["制作条件"], "targetDurationSeconds": 1200 },
  "changes": { "keep": [{ "point": "残す点", "evidenceIds": ["e-01"] }], "change": [] },
  "observations": [{ "id": "o-01", "statement": "観測したこと", "evidenceIds": ["e-01"] }],
  "hypotheses": [{ "id": "h-01", "statement": "仮説", "evidenceIds": [], "status": "untested" }],
  "openQuestions": [{ "id": "q-01", "question": "未確認のこと", "blocksProduction": true, "plannedCheck": "確かめ方" }],
  "postPublish": { "metrics": [{ "id": "m-ctr", "source": "metrics", "metric": "estimated_weighted_ctr_pct",
    "comparison": { "format": "long", "window": "first_7d", "traffic_source": "browse", "metric_definition": "…" },
    "expectation": "期待" }] },
  "evidence": [
    { "id": "e-01", "kind": "market-research", "path": "research/competitors.md",
      "collected": { "at": "2026-09-24", "conditions": "取得の条件" } },
    { "id": "e-02", "kind": "audience-run", "path": "research/run-001",
      "collected": { "at": "2026-09-20", "conditions": "選定動画の4分析" } }
  ],
  "steps": [{ "id": "audience-analysis", "status": "partial", "outputs": ["research/run-001"], "note": "…" }]
}
```

欄の意味と規則:

- `version` は `buzzassist-strategy-tool-handoff-v1` だけを受けます。違う版・読めない JSON は取り込まず、
  `issues` に `strategy-handoff-version-unknown` / `strategy-handoff-unreadable` を出して作業フォルダの読み取りだけで進めます
- `channel.id` が `--channel` と違えば `draft` は止まります（`strategy-draft-channel-mismatch`）。別のチャンネルの判断を混ぜません
- `question` から `postPublish` までと `observations` / `hypotheses` / `openQuestions` は、ブリーフの同じ名前の欄と同じ形です
  （`config/strategy-brief.schema.json`）。形の誤りは `draftIssues` に出ます
- `evidence[]` は、`id`・`kind`・`path`（作業フォルダからの相対）・`collected` を書きます。`sha256` は書かなくてよく、
  `draft` がファイルから計算します。書いた `sha256` がファイルと違えば、その根拠は外します
  （`strategy-handoff-evidence-changed`）。`audience-run` は 3.1 と同じく current のものだけを受けます
- `state: "verified"` は `verification.method`（何をどう確かめたか）があるときだけ受けます。無ければ `provisional` に下げて
  `strategy-handoff-evidence-state-downgraded:<id>` を出します
- 前提に依らない根拠（公開済みの動画の実測など）は `premiseBound: false` と `premiseIndependenceReason` を書きます
- `strategySkill.fingerprint` は HYP の側が自分の版を申告する欄です。`draft` は `--strategy-skill-dir` で測った指紋と比べ、
  違えば `strategy-skill-fingerprint-mismatch-with-handoff` を出します。ブリーフに書くのは測った指紋だけです
- `steps[]` は HYP の工程ごとの実施状況（`id`・`status`・`outputs`・`note`）で、`sources.handoff.steps` にそのまま出します。
  ブリーフには入れません。上位の AI が「必要な工程が実際に済んだか」を読むためのものです
- 知らない欄は `strategy-handoff-unknown-field:<名前>` を出して無視します

## 5. 観測・仮説・未確認事項の書き方

ブリーフの任意の欄です。書かないブリーフも今までどおり通ります。

| 欄 | 形 | 規則 |
|---|---|---|
| `observations[]` | `{ id, statement, evidenceIds, note? }` | 観測したことだけを書き、根拠の id（1つ以上）に結ぶ。解釈は仮説へ分ける |
| `hypotheses[]` | `{ id, statement, evidenceIds, status, note? }` | `status` は `untested` / `supported` / `weakened`。`supported` と `weakened` には根拠が要る |
| `openQuestions[]` | `{ id, question, blocksProduction, plannedCheck, status?, resolution? }` | `status` は `open`（既定）か `resolved`。`resolved` には `resolution: { evidenceIds, note }` が要る |

- `blocksProduction: true` の未確認事項が `open` のまま残るブリーフは、品質ループで合格していても `verdict` が制作へ渡しません
  （`strategy-brief-open-question-blocks-production:<id>`）
- 前の版で `open` だった事項を `resolved` にする・仮説の状態を変えるには、その版で新しく足した根拠（前の版に無い id か、
  ファイルや SHA が変わった根拠）を指す必要があります。品質ループの機械ゲート `claims-updated-with-new-evidence` が見ます。
  比べる基準は、このゲートが落ちた版を飛ばした直近の版です（同じ書き換えを繰り返して変化を消せないように）
- 未確認事項を黙って消すのも同じゲートで落ちます。確かめたなら `resolved` にして根拠を指してください
- 採点した後にブリーフを書き換えた場合、`verdict` は書き換えを名指しします
  （`strategy-brief-open-question-resolved-without-new-evidence:<id>`、`...-dropped-without-review:<id>`、
  `...-unblocked-without-review:<id>`、`strategy-brief-hypothesis-changed-without-new-evidence:<id>` など）

## 6. 前提の変更と、根拠の当てはまりの確認

前提は「動画の問い・見る人・制作条件（形式・条件・尺）」の3つです。入口の約束（タイトル・サムネ・冒頭の言い方）は
前提に入れません。言い方を変えただけで、その前に集めた調査を無効にしないためです。ハーネスの id も経路なので
入れません。日数では決めません（古いという理由だけで取り直さない）。

前提を変えた版では、前の前提で集めた根拠（`collected.premise` か、品質ループの記録で最初に現れた版の前提に
結び付く行）が「当てはまりの確認待ち」になります。上位の AI が根拠を開いて、今の前提に当てはまるかを判定し、
理由と一緒に記録します。

```bash
# 判定が要る根拠の一覧（何も書かない）
node scripts/strategy-brief.mjs applicability --brief <ブリーフ>
# 1件ずつ判定を書く（ブリーフの SHA が変わる。--out で別のファイルへ書いてもよい）
node scripts/strategy-brief.mjs applicability --brief <ブリーフ> --evidence <id> --applies yes|no \
  --reason "今の問い・見る人・条件に当てはまる／当てはまらない理由" --context <判定した会話の ID>
```

| 状態 | 意味 | verdict の理由コード |
|---|---|---|
| 判定なし | 前提を変えた後、まだ判定していない | `strategy-evidence-applicability-review-required:<id>` |
| `applies: yes` | 今の前提に当てはまる。再利用する | なし（評価シートに理由が載る） |
| `applies: no` | 当てはまらない。その根拠だけ取り直す | `strategy-evidence-refresh-required:<id>` |

- 判定は根拠の行の `applicability`（`premiseDigest`・`applies`・`reason`・`decidedBy`・`decidedAt`）に入り、今の前提の digest に
  縛られます。前提をもう一度変えたら判定は効かず、また確認待ちになります
- 取り直した根拠（別のファイル・別の SHA）は今の版の前提に結び付くので、確認は要りません
- 前提に依らない根拠（`premiseBound: false`）と、前提が変わっていない根拠には判定を書けません

## 7. 制作へ渡すまでの手順

1. `node scripts/run-video-harness.mjs plan-request --channel <id> --request "<依頼文>"` で、どの制作の仕組みで作るか・
   前提の不足・次にやる工程を確かめる（モデルも有料 API も呼ばず、Job も作らない）。MCP では `plan_video_request` に
   `channelId` を渡す。返る `workflow.recommended` が次の工程で、`alternatives` が代案（7.1）
2. `workflow.recommended` が HYP の工程（`hyp-*`）なら、上位の AI が HYP でその工程を実行する（有効な既存の分析は再利用する）。
   成果物を作業フォルダへ置き、できれば `strategy-handoff.json` を書く
3. `node scripts/strategy-brief.mjs draft --from-hyp <作業フォルダ> --channel <id> [--previous <前のブリーフ>] --strategy-skill-dir <HYP の採用版> --out <作業フォルダ>/strategy-brief-rN.json`
4. 上位の AI が `needsAuthoring` の `author` を HYP の成果物から埋め、`confirm` を確かめる。確かめられないことは
   `openQuestions` に書く（制作の前に確かめる必要があれば `blocksProduction: true`）
5. `node scripts/strategy-brief.mjs validate --brief <ブリーフ>`
6. 前提を変えたなら `applicability` で根拠ごとに判定を記録する
7. 企画の品質ループ: `start --work-dir <作業フォルダ> --generator-context <埋めた会話の ID>` → `sheet` → 別の文脈で採点 → `record`
8. `node scripts/strategy-brief.mjs verdict --brief <ブリーフ> --require-pass`
9. `node scripts/run-video-harness.mjs plan-request --channel <id> ... --strategy-brief <ブリーフ>` で合否と根拠の状態を確かめ、
   `start --channel <id> ... --strategy-brief <ブリーフ>` で制作 Job に渡す（ブリーフの SHA が Job の識別子に入る）

公開後は `node scripts/strategy-brief.mjs next --from <ブリーフ> --metrics <指標の集計>` で数字を照らし、次の版の下書きへ進みます。

### 7.1 チャンネルの台帳と、次の工程の決め方

チャンネルごとの設定は、運営者の端末の `config/harness-deployments.json` の `channels` に書きます（追跡しないファイル。
書き方は `config/harness-deployments.example.json` の `channelTemplate`）。1チャンネルにつき、作業フォルダ・署名済み
Channel Pack・制作の仕組み（`{ "kind": "harness", "harnessId": ... }` か、BuzzAssist の外で作る `{ "kind": "external" }`）・
戦略の作業フォルダ（`strategy.workDir`）・合格したブリーフを制作の条件にするか（`strategy.requireBrief`）・台本の品質ループの
ジャンルを持ちます。チャンネルどうしで場所が重なる台帳と、公開リポジトリの追跡される場所を指す台帳は読み込みで拒みます。

学習（要求台帳・提案・反映記録）の保存先もチャンネルごとに分けます。台帳のチャンネルで作った Job（`start --channel`、
または Pack・作業フォルダが台帳のチャンネルに一致した Job。Job の `metadata.channel` に残ります）の確定時の自動の捕捉と
Canvas feedback は、そのチャンネルの保存先へ積みます。保存先は `channelLearning` の
`{ "target": "channel-pack:<id>", "channel": "<チャンネルの id>", "root": "<dir>" }`、宣言が無ければ学習の置き場の
`channels/<チャンネルの id>` です。同じハーネスのチャンネルが2つあっても、片方の提案・承認待ちの変更はもう片方に出ません。
見る・直すときは `node scripts/harness-learn.mjs status --channel <id>`（`pending` / `approve` も同じ `--channel`）。
共有層（`genre:` / `platform:`）の宛先には `--channel` を付けられません（チャンネル固有の事実を共有層へ上げないため）。
保存先が別のチャンネルの場所・保存先に重なる台帳は読み込みで拒みます。チャンネルの無い Job は従来どおりハーネス単位の
Channel Pack の台帳へ積みます。

品質ループ（台本・途中の成果物・企画ブリーフ）の不合格の回から自動で拾う学習も、チャンネルが分かればそのチャンネルの
保存先へ積みます。チャンネルは、制作の Job の `metadata.channel`、ループの作業フォルダが台帳のチャンネルの Job の
`options.scriptQualityWorkDir`・`projectDir`・`strategy.workDir` と同じかその中であること、企画ブリーフの `channel.id` の
順に決めます（Job を優先。ブリーフと作業フォルダが別のチャンネルを指したら決めずに積みません）。チャンネルが決まったのに
保存先を決められないときは `channel-learning-store-unresolved` で積まず、どれにも当たらなければ従来どおりです。
台帳を `BUZZASSIST_CHANNEL_REGISTRY` で別のファイルにした端末では、チャンネルの無い Job の保存先（`channelLearning` の
宛先単位の行）もそのファイルから読みます。

**既存の台帳を1つ目のチャンネルへ引き継ぐ**: 開発用チェックアウトで `channel-packs/<id>/`（`docs/learning/` の提案・反映記録と
`docs/` の要求台帳）に学習を持っていたチャンネルを台帳に登録するときは、チャンネルごとの宣言の root をその Pack の
フォルダにします。書かずに登録すると、登録後の学習は新しい保存先（`channels/<チャンネルの id>`）へ積まれ、従来の台帳は
`--channel` なしの一覧に残ります。例（id はどちらも合成）:

```json
"channelLearning": [
  { "target": "channel-pack:sample-pack", "channel": "sample-channel", "root": "channel-packs/sample-pack" }
]
```

- 引き継げるのは、その宛先を使うチャンネルが台帳に1つだけのとき（2つ目の同じハーネスのチャンネルは別の root にする。
  重なると `channel-learning-store-unscoped-overlap` で拒みます）。宛先単位の宣言 `{ "target", "root" }` で従来の保存先を
  別の場所にしていたなら、その root を書きます
- 印（`channel`）の無い従来の行は、そのチャンネルの行として読みます。反映記録の照合も同じ要求台帳のファイルを見るので、
  反映済みの数えは変わりません。引き継ぐ前に置いた承認待ちの変更は `--channel` を付けずに当てるか、`pending` を作り直します
- 配布された写し（運営者の端末）の従来の台帳は `~/.buzzassist/learning/channel-packs/<id>/` に `docs/learning/` を挟まずに
  あるので、root では指せません。引き継ぐなら、その中の `*.jsonl` を新しい root の `docs/learning/` へ写します

plan-request は依頼の種類（`requestKind`）とブリーフの状態から次の工程を返します。種類が決めきれないときは `question` を1問
返すので、答えを `requestKind` に入れて呼び直します。

| 依頼の種類 | 返る工程の例 |
|---|---|
| `new-design`（新しく企画を立てる） | `hyp-design` |
| `next-video`（次の1本） | ブリーフが無ければ `hyp-design`、未合格なら `strategy-brief-review`、根拠の取り直しが要れば `hyp-additional-research`。合格したブリーフがまだ使われていなければ `reuse-brief`、使った後なら `hyp-next-video` |
| `script-review`（台本を見る） | `hyp-script-review` のあと台本の品質ループ |
| `produce`（作る） | `requireBrief` のチャンネルで合格したブリーフが無ければ、直す工程（`hyp-design` など）。あれば `produce` |
| `rerender`（作り直し） | 既存の Job の `resume` だけ（HYP も採点も回さない） |
| `post-publish`（公開後の数字から次へ） | `hyp-post-publish`（前のブリーフがあれば `next --from`） |
| `research`（調べる） | `hyp-research` |

**`requireBrief` の決め方。** 合格したブリーフを制作の条件にするかは運営者が決めます。完成済みの納品を取り込むだけのチャンネル
（解説動画のハーネス `explainer-video` の import-delivery。`docs/explainer-video-harness-ja.md`）で、ブリーフの独立評価がまだ
済んでいない・直している間は `false` にしておきます。取り込みは有料の呼び出しをせず、ブリーフの書き方の直し待ちで止める
理由が無いためです。ブリーフの状態は plan-request の理由（`strategyBrief.summary`）と、`--strategy-brief` を渡した start の
Job（`options.strategyBriefSha256` と `metadata.strategyBrief`）に残ります。運営者が「ブリーフの合格を制作の条件にする」と
決めたら `true` に変えます（`true` で合格していないブリーフを渡すと、start は Job を作る前に `channel-strategy-brief-not-passed`
で止まります）。なお `--strategy-brief` を渡して作った Job は、そのブリーフを書き直すと resume が
`strategy-brief-changed-since-start` で止まるので、書き直したブリーフでは新しい Job として start します。

**ブリーフの `production.harnessId`。** 任意です。台帳のチャンネルで start するときハーネスは台帳の `production.harnessId` から
決まり、ブリーフに harnessId が無くても止まりません。書くなら台帳と同じ id を書きます（違う id は plan-request の理由に出ます）。

HYP の工程について返すのは、工程の名前・作業フォルダ・HYP の採用版の指紋・終わったら作るもの（ブリーフ）・その後のコマンドの順番
だけで、HYP の文面は持ちません。`requireBrief` のチャンネルでは、合格したブリーフが無いと `start` が Job を作る前に止まります
（`channel-strategy-brief-required` / `channel-strategy-brief-not-passed`）。`resume` は、start のときのブリーフが書き換わって
いれば有料の処理の前に止まります（`strategy-brief-changed-since-start`）。

## 8. HYP の採用版を固定する

- `node scripts/strategy-brief.mjs fingerprint --skill-dir <HYP の採用版の置き場>` が、SKILL.md・scripts/・references/・assets/
  の各ファイルの sha256 から版の指紋を作ります（中身は写しません）
- `draft --strategy-skill-dir` はその指紋をブリーフの `provenance.strategySkill` に書きます。指定しなければ
  `strategy-skill-version-unrecorded` を出します
- 前のブリーフと違う指紋なら `strategy-skill-changed-from-previous` を出します。プロジェクトの途中で別の版へ黙って
  切り替えないためです（切り替えるなら、理由を持って判断してください）
- 採用版の置き場は HYP の保守元が1つに決めます。導入先の写しが保守元と違う場合は、どちらを採用版とするかを HYP の側で決めます

## 9. HYP の側に頼むこと

- 作業フォルダを 2 の形で置く（1チャンネル1フォルダ。`quality/` には書かない）
- 可能なら `strategy-handoff.json`（4 の形）を書く。書けない欄は書かずに残す（仮の文言で埋めない）
- 根拠の表 `evidence.csv` の `evidence_id` を行ごとに一意にし、`source_url_or_file` に作業フォルダからの相対パスを書く
- 4分析の run は結果を登録し直したらレポートを作り直す（stale のままでは根拠にならない）
- 観測と解釈を分け、確かめていないことは未確認事項として書く。制作の前に確かめる必要があるものには `blocksProduction: true`
- 採用版の置き場を1つに決め、その版で実行する
