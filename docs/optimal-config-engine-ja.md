# 最適構成エンジン（オトシゴのハーネス）

チャンネルの性格を読んで、構成表の中から「動画の構成（R01〜R18）・画像のワークフロー（W01〜W40）・使ってよいモデル・実行場所」の候補を2〜3案に絞り、権利の6層の関門を通し、同じ10カットで比べて記録するための土台。

先に正直に書いておくこと：構成表のもとになった調査は公式の資料を読んだだけで、**ここにある構成・ワークフロー・モデルは誰も実際には動かしていない**（`reproduced: false`、ベンチマークなし）。日本語の文字描画・口パク・Mac での所要時間も測っていない。だからエンジンは正解を決め打ちしない。候補を絞って、10カット試験の数字で決める。

## 全体の流れ

```
チャンネルの性格（Channel Pack の config/channel-traits.json）
  ↓ ① 選ぶ：構成表 × 権利の関門 × 機材の判定（lib/optimalConfig/selectConfig.mjs）
候補 2〜3 案（R## × W## × モデル × 実行場所）と、外したモデルの理由
  ↓ ② 10カットで試す：典型5＋難しい5（lib/optimalConfig/trialRecord.mjs）
採用秒率／採用1秒あたりの現金／採用1秒あたりの人の時間／不採用の理由
  ↓ ③ 本番1案と予備1案を運営者が決め、Channel Pack に記録する
毎話の制作（今の品質ゲートはそのまま）
```

生成は運営者の手元か運営者自身の契約先で動かす。オトシゴのサーバーは画像・動画を生成も中継もしない（権利の関門でも `OTOSHIGO_NO_MEDIA_RELAY` として常に止める）。このエンジン自体は何も生成せず、有料の呼び出しもモデルのダウンロードもしない。

## ファイル

| ファイル | 役目 |
|---|---|
| `config/optimal-config/catalog.json` | 構成表（データ）。R01〜R18、W01〜W40、モデル19件と権利の6層、高速化55件、実行場所。手で直さない |
| `config/optimal-config/catalog.schema.json` | 構成表の JSON Schema |
| `scripts/build-optimal-config-catalog.mjs` | 構成表を作り直すスクリプト。こちらの判断（R の要約・選び方・権利の判定・動く環境）を持つ |
| `lib/optimalConfig/channelTraits.mjs` | チャンネルの性格の形・検査・読み込み |
| `lib/optimalConfig/rightsGate.mjs` | 権利の6層の関門 |
| `lib/optimalConfig/selectConfig.mjs` | 候補の選定と機材の判定 |
| `lib/optimalConfig/trialRecord.mjs` | 10カット試験の記録と数字、RunReceipt への追加 |
| `scripts/optimal-config.mjs` | 入口（JSON を出す） |
| `examples/optimal-config/traits/*.json` | 4チャンネルの traits の例 |

## チャンネルの性格（traits）

Channel Pack の `config/channel-traits.json` に置く（チャンネル固有なので公開リポジトリには例だけを置く）。

| 欄 | 値 |
|---|---|
| `artStyle` 絵の種類 | `flat-2d-manga` / `anime` / `photoreal` / `diagram-mascot` / `ai-footage` / `live-footage` |
| `identityLock` 固定したいもの | `none` / `mascot` / `fixed-cast` / `person+wardrobe` |
| `motion` 動きの量 | `stills-camera`（静止＋カメラ） / `few-clips`（数カットだけ動画） / `mostly-video` |
| `budgetMonthlyJpy` 月の予算 | 円。未定なら `null`（推定しない。選定は「予算が未設定」と注意を出す） |
| `hardware` 機材 | `{ mac: { memoryGiB } \| null, cudaVramGiB, cloudGpu, contracts: [...] }`。`contracts` は `chatgpt` `codex` `grok` `google-ai` など |
| `confidentialAssets` 外に出せない素材 | `true` なら外部へ送る経路を全部止め、手元だけから選ぶ |
| `aspect` / `lengthMinutes` | 縦横比と1本の尺の目安（40分以上で「量のカット」と R13 を入れる） |
| 任意 | `publishScope`（既定 `worldwide`）、`priority`、`annualRevenueUsd`、`notes` |

足りない欄は既定値で埋めずに、欄ごとの日本語の理由で止める。絵の種類だけは、traits に無ければ画風プロファイル（`channel-visual-profiles.json`）の文章から推定でき、推定した欄は `inferred` に残る。

## 権利の関門（6層）

層は調査の権利表と同じ A コード／B 重みと全依存／C 出力／D ホスト・再販／E 素材と人物／F データの扱い。モデルごとに `code` `weights` `outputs` `hosting` `region` `data` の欄を持ち、実行場所と使い方（本番か非公開の比較か）ごとに判定する。

機械的に止めるもの（`blocks`）:

- 重みが非商用（FLUX dev、klein 9B）→ `WEIGHTS_NON_COMMERCIAL`。出力の商用利用が認められていても、収益のあるチャンネルの本番で重みを動かす許諾にはならない
- 研究用ライセンス（Qwen-Image-2.1）→ `RESEARCH_LICENSE`
- 生成物も非商用（NoobAI）→ `OUTPUTS_NON_COMMERCIAL`
- 地域の制限が出力に及ぶ（HunyuanImage、MiniMax H3）→ 全世界公開なら `REGION_RESTRICTS_OUTPUTS`
- 顔の重みが非商用（InstantID／PuLID の InsightFace）→ `FACE_ID_WEIGHTS_NON_COMMERCIAL`
- プロのアニメ制作は売上に関係なく別許諾（Pony V7）→ `PROFESSIONAL_ANIMATION_LICENSE`
- 派生の条件が重い（Illustrious v0）→ `DERIVATIVE_TERMS_RESTRICTIVE`
- サービス提供が禁止（Anima など）をオトシゴのサーバーで動かす → `HOSTING_AS_SERVICE_FORBIDDEN`（運営者の手元で使う分には止めない）
- 外に出せない素材があるのに外部へ送る経路 → `CONFIDENTIAL_EXTERNAL_SEND`
- 売上の閾値を申告どおりに超えた（LTX など）→ `REVENUE_THRESHOLD_EXCEEDED`

確定できないもの（出力の条件が未確認、売上の閾値が未申告、外部へ送る選択肢がある、など）は止めずに `warnings` に出す。権利の判定は法的助言ではない。

## 選定

1. 本編（base）の構成を、絵の種類・固定したいもの・本編の動きで点を付けて選ぶ。数カットだけ動かすチャンネルでも、本編は「静止＋カメラ」で比べる
2. 人物の連続性（R06）、量の運用（R13）、Mac 中心（R15）、外部送信ゼロ（R16）などを条件に合えば重ねる
3. 動かすカットがあれば、数カット用の構成（R03 など）を選ぶ
4. ワークフローは構成表の `workflowSelectors` から当てはまるものを優先順に出す。依存するモデルが権利で止まったワークフローは理由つきで外す
5. モデルは役目ごと（本番の画像・下書き・量のカット・動画）に、動けて権利も通る実行場所で並べる。既に払っている契約 → 手元（無料）→ 借り GPU の順。下書きは手元だけ、量のカットは尺が40分以上のときだけ
6. 機材の判定：Mac のメモリが足りない経路（LTX Desktop のローカルは 32GiB 以上）、CUDA 専用の経路と高速化、契約の無いサービス、Mac で動くか未確認のもの（未確認は選ばない）を外し、理由を返す

例の4チャンネル（id は依頼者の名前に由来しない、絵と形式を表す名前にしている）の当てはめ（`node scripts/optimal-config.mjs select --traits examples/optimal-config/traits/<id>.json`）:

| id | 構成 | ワークフロー | モデル |
|---|---|---|---|
| fixed-cast-manga | R04（動かす2カットは R03） | W07 → W03 → W06 → W04 → W17 → W01 | 本番 GPT Image、下書き klein 4B（Mac）、動画 Grok Imagine |
| photoreal-narrated-story | R01＋R06＋R13（冒頭は R03） | W07 → W12 → W23 → W22 → W40 | 本番 GPT Image、量のカット Z-Image Turbo（借り GPU） |
| diagram-mascot-explainer | R09（生成動画なし） | W25 → W28 → W01 | 本番 GPT Image、予備 klein 4B |
| iq-comparison | R09＋R03 | W07 → W28 → W29 → W23 | 下書き klein 4B（Mac）、動画 Wan2.2 TI2V-5B（借り GPU） |

## 10カット試験の記録

1カット1候補ごとに、動画生成 総合ガイド p18 の最小項目（カットID・用途・画風・入力素材ID・入力モード・固定条件・台詞と音声の有無・モデルと checkpoint の版・実行環境の版・GPU/VRAM/RAM・解像度/尺/fps・step/CFG/量子化/LoRA・初回準備の時間・待ち時間・人の操作時間・現金・生成した秒数・採用した秒数・不採用の理由・修正時間・公開権の確認先・素材の送信先）を残す。欠けた欄・矛盾した数字は止める。

比べる数字は、採用秒率（採用秒÷生成秒）、採用1秒あたりの現金、採用1秒あたりの人の時間（（操作＋修正）÷採用秒）。`recommendFromTrial` は10カットがそろった候補だけを並べて本番と予備を**提案**する（決めるのは運営者）。

RunReceipt へは `attachTrialToRunReceipt` で任意の `configTrial` 欄として足す。素材 ID は digest にして残し、プラットフォームへ返す形（`redactForPlatform`）には候補の数と数字だけを出す。この欄の無い既存の記録はそのまま読める（`configTrial: null`）。

## 静かなすり替えの禁止

`lib/mediaGeneration.mjs` の `normalizeImageModel` / `normalizeVideoModel` は、知らないモデル名を既定のモデルへ黙って置き換えていた（頼んでいないモデルで生成・課金される経路）。今は、別名・id・表示名のどれにも当たらない名前を `UNKNOWN_MEDIA_MODEL` で止める。既定への置き換えは `allowDefaultFallback: true`（生成の入口では `allowDefaultModelFallback: true`）を明示したときだけ。未指定（空）は今までどおり既定のモデル。構成表のモデルが指す生成の id（`mediaGenerationIds`）は、生成層の知っている id であることをテストで確かめている。

## 入口

```
node scripts/optimal-config.mjs select --traits <traits.json>
node scripts/optimal-config.mjs select --project-dir <作業中のプロジェクト> [--pack-id <id>]
node scripts/optimal-config.mjs gate --model <id> [--route <実行場所>] [--traits <traits.json>]
node scripts/optimal-config.mjs trial-plan --traits <traits.json>
node scripts/optimal-config.mjs trial-metrics --trial <試験の記録.json>
```

実行場所は `operator-mac` / `operator-cuda` / `operator-rented-gpu` / `operator-service` / `otoshigo-hosted`。`gate` で `--route` を省くと、そのモデルの実行場所すべてとオトシゴのサーバーを並べて判定する。

## 構成表の更新

モデルが更新されたら、調査の台帳を差し替えて作り直す。

```
node scripts/build-optimal-config-catalog.mjs --research <調査一式のフォルダ>   # 調査の JSON から取り込み直す
node scripts/build-optimal-config-catalog.mjs --check                          # コミット済みと一致するか
```

`--research` を渡さなければ、コミット済みの `catalog.json` に入っている取り込み結果をそのまま使う（テストも作り直しも手元の調査一式に依存しない）。調査の JSON は信頼しない入力として、使う欄だけを文字列で拾う。R の要約・ワークフローの選び方・モデルの権利の判定と動く環境はスクリプトの中の定数で、変えたら作り直してコミットする。

## まだやっていないこと

- 10カット試験はまだ1回も走っていない。候補はすべて未実測
- 本番1案と予備1案を Channel Pack に署名付きで記録する工程と、毎話の制作の入口（`run-video-harness`）への接続
- 借り GPU を止めて保存費を確かめる工程の自動化（選定の結果に注意として出すだけ）
- 動画モデルの調査は PDF の要約から取ったもので、Grok Imagine と Veo の出力の条件はこの調査一式では一次資料を確認していない（注意として出る）
