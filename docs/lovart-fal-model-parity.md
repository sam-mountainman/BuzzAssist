# Lovart 33モデル × fal.ai パラメータ対応表

調査日: 2026-07-10。fal.ai仕様は各モデルのAPIページ・OpenAPIスキーマから取得。Lovart側は公式スキル（lovartai/lovart-skill）のソースコード・`/v1/openapi/tools/catalog`・実生成テスト（クレジット消費）で検証。

## 前提: Lovart APIの構造

Lovart OpenAPI (`/v1/openapi/chat`) が受け取る構造化フィールドは以下で**全部**:

| フィールド | 内容 |
|---|---|
| `prompt` | 文章（設定指示もここに書く） |
| `project_id` / `thread_id` | プロジェクト・スレッド |
| `attachments` | アップロード済みファイルURL配列 |
| `mode` | `thinking` / `fast`（スレッド初回で固定） |
| `tool_config.include_tools` | モデル（ツール）固定 |
| `tool_config.exclude_tools` / `prefer_tool_categories` | 除外・ソフト優先 |

**aspect ratio・duration・seed等の構造化パラメータは存在しない。** `/tools/catalog` もツール名・表示名・カテゴリ・`is_premium` のみでパラメータスキーマは非公開。Lovart内部エージェントがプロンプト文章を読んで下流モデルの引数に翻訳する設計。

### 凡例（各fal.aiパラメータのLovart対応度）

- **◎ 構造化保証** — Lovart APIのフィールドで確実に指定できる（モデル固定、添付ファイル送達）
- **○ 反映実証済み** — プロンプト文章指示で実結果への反映を実生成テストで確認
- **△ 指示可・未検証** — プロンプトで指示は書けるが、下流引数に翻訳される保証なし
- **✕ 不可** — 実証で効かないと判明、またはAPI機構上到達不能

### 実生成テスト結果（2026-07-10、本リポジトリの本番経路で実施）

| テスト | モデル | 指示 | 実結果 | 判定 |
|---|---|---|---|---|
| T1 | Nano Banana 2 | 16:9 + 2K | 2752×1536（Gemini系2K 16:9ネイティブサイズ） | ○ 反映 |
| T2 | GPT Image 1.5 | 1:1 + 背景透過 | 1024×1024 PNG、実アルファ（透過79.3%） | ○ 反映 |
| T3 | NB2 Lite ×2回 | seed 424242 固定 | 2枚は別画像（目の色・構図が相違） | ✕ 再現せず |
| T4/T5 | Seedance 2.0 Mini | 動画生成 | `done`+空`items`×2回、エラーなし | ✕ プレミアム動画は無反応 |
| T6 | Wan 2.6 | 9:16 + 5秒 + 無音 | 1080×1920、5.000秒、音声トラックなし | ○ 完全一致 |

付随発見:
- T1はPNG希望でもJPEG返却 → 形式未指示時のフォーマットは不定
- 全テストで `pending_confirmation`（クレジット見積）は発生せず → 見積コストは取得できないまま消費される
- アカウントは従量（credit）モード、`unlimited: false`

### 追加実生成テスト: UI未実装のfal.ai設定項目（2026-07-10 ラウンド3、Lovart API直叩き）

| テスト | モデル | UI未実装の設定 | 実結果 | 判定 |
|---|---|---|---|---|
| R3-1 | NB2 Lite | **4枚同時生成**（num_images相当） | 4アーティファクト返却、全て別画像・1024×1024 | ○ 使える |
| R3-2 | NB2 | **極端比率 8:1** | 5856×704（8.3:1、ネイティブバケット） | ○ 使える |
| R3-3 | Flux.2 Max | **カスタム1280×720ピクセル指定** | 1024×576（比率だけ合致、指定pxは無視） | ✕ 比率バケットのみ |
| R3-4 | Luma Uni-1 | **Mangaスタイル**（`style: manga`相当） | 完全な白黒漫画（トーン・スピード線） | ○ 使える |
| R3-5 | Ideogram 4 | **出力形式PNG指定**（fal既定はJPEG） | image/pngで返却 | ○ 明示すれば通る |
| R3-6 | Wan 2.6 | **タイムコード式マルチショット＋10秒＋音声ON** | 10.03秒・1080p・AAC音声あり・5秒地点で正確にカット（赤ボール→宇宙のキューブ）。5秒×2ショットの中間素材も返却 | ○ 全て反映 |
| R3-7 | Vidu Q2 | **2秒動画**（最短duration） | 2.083秒 ○／ただし16:9指示に反し縦型784×1176で返却 | △ 秒数○・比率外れ |

R3-7が示す重要な性質: **プロンプト指示は確率的**。同カテゴリの指示（比率）が他テストでは全て通っているのに、この1回はエージェントが縦キー画像→i2vの経路を選んで外した。`include_tools`のモデル固定のような契約的保証はプロンプト指示には無い。

### 参照素材・キーフレームの実証（2026-07-10 ラウンド5、役割注釈付き添付）

添付に役割注釈（`Attachment 1 is the START frame…`等）を付けて送る方式を実装し、本番経路で検証:

| テスト | モデル | 内容 | 実結果 | 判定 |
|---|---|---|---|---|
| R5-A | Seedance 2.0 Mini | 参照画像1枚→動画 | 中間フレームが参照画像のキャラ・小物と完全一致、指示どおり尻尾のみ動く | ○ 参照反映 |
| R5-B | Vidu Q2 | 開始+終了フレーム指定 | 最初のフレーム=開始画像、最後のフレーム=終了画像のモーフ動画（見積36cr） | ○ 両フレーム反映 |

修正済みの旧バグ: 以前の実装は `endFramePath` を添付リストに含めておらず、**終了フレームがLovartに送信されていなかった**。また添付の役割（開始/終了/参照画像/動画/音声）が無注釈だった。

## プレミアム動画モデル: 2026-07-10夜の再検証で全て利用可能に

2026-07-10昼の初回検証では `is_premium: true` の動画ツールがエラーなしの空応答（`done`+`items: []`）で失敗していたが、**同日夜の再検証（ラウンド4）で全カテゴリの生成成功と設定反映を確認**。Lovart側の開放またはアカウント状態の変化とみられる。

| テスト | モデル | 指示 | 実結果 | 判定 |
|---|---|---|---|---|
| R4-1 | Seedance 2.0 Mini | 9:16・480p・4秒・無音 | 496×864、4.04秒、音声なし | ○ 全反映 |
| R4-2 | Veo 3.1 Fast | 16:9・720p・4秒・音声ON | 1280×720、4.06秒、音声あり（見積48cr） | ○ 全反映 |
| R4-3 | Gemini Omni Flash | 9:16・3秒 | 720×1280、3.008秒、音声あり=常時ON仕様どおり（見積72cr） | ○ 全反映 |
| R4-4 | Kling 2.6 | 16:9・5秒・無音 | 1920×1080、5.04秒、音声なし（見積22cr） | ○ 全反映 |

プレミアム動画では `pending_confirmation`（クレジット見積→承認）フローが発生する（画像・非プレミアム動画では未発生）。空`items`失敗は再発しうるため、エラーハンドリングは残す価値あり。

---

# 画像モデル (18)

## GPT Image 2 系（Auto / Low / Medium / High の4ツール）

fal.ai: `openai/gpt-image-2`, `openai/gpt-image-2/edit`

| fal.aiパラメータ | 仕様 | Lovart対応 |
|---|---|---|
| `quality` | auto/low/medium/high（既定high） | ◎ Lovartはツール自体が品質別（`_low`/`_medium`/`_high`）なのでモデル固定で保証 |
| `image_size` | 6プリセット + カスタムW×H（16の倍数、最大辺3840px、AR≤3:1、655K–8.3Mpx） | ○ 比率はプロンプトで反映実証（同系）。カスタムpxは△ |
| `num_images` | 1–N | ✕ 現実装は1枚返し。「N枚」指示は△（未検証） |
| `output_format` | jpeg/png/webp（既定png） | ✕ 保証されない（T1でJPEG返却の実例） |
| `image_urls`（edit） | 複数参照画像 | ◎ attachmentsで送達保証（使い方はエージェント判断） |
| `mask_url`（edit） | インペイントマスク | △ マスク画像は添付できるが「マスクとして」使う保証なし |
| `sync_mode` | データURI返却 | ✕ API機構（Lovartに概念なし） |
| 透過背景 | **fal側にパラメータなし**（1.5のみ） | —（モデル自体が非対応） |
| seed / negative prompt | fal側にもなし | — |

## GPT Image 1.5

fal.ai: `fal-ai/gpt-image-1.5`, `/edit`

| fal.aiパラメータ | 仕様 | Lovart対応 |
|---|---|---|
| `image_size` | 1024×1024 / 1536×1024 / 1024×1536 の3固定のみ | ○ 1:1指示→1024×1024を実証（T2） |
| `background` | auto/transparent/opaque | ○ **透過をプロンプト指示で実証**（T2、実アルファ確認） |
| `quality` | low/medium/high（autoなし） | △ プロンプト指示可・未検証 |
| `input_fidelity`（edit） | low/high — 入力画像の保持度 | △ 「元画像を忠実に」等の文章指示のみ |
| `mask_image_url`（edit） | マスク | △ 同上 |
| `num_images` / `output_format` / `sync_mode` | — | ✕（枚数・形式は保証なし） |

## Nano Banana 系（Pro / 2 / 2 Lite / 無印）

fal.ai: `fal-ai/nano-banana-pro`, `fal-ai/nano-banana-2`, `google/nano-banana-2-lite`, `fal-ai/nano-banana`（各 `/edit` あり）

| fal.aiパラメータ | 仕様（モデル差） | Lovart対応 |
|---|---|---|
| `aspect_ratio` | Pro: 10種+auto / 2・2Lite: 14種（4:1, 8:1等の超横長含む）+auto / 無印: 10種 | ○ 16:9反映実証（T1、NB2）。極端比率(8:1等)は△ |
| `resolution` | Pro: 1K/2K/4K、2: 0.5K/1K/2K/4K、**Lite・無印: なし** | ○ 2K反映実証（T1: 2752×1536） |
| `num_images` | 1–4 | ✕ 現実装1枚。「4枚」指示は△ |
| `seed` | 整数 | ✕ **再現しないことを実証**（T3、Lite） |
| `thinking_level` | 2・Lite: minimal/high | △ 未検証 |
| `enable_web_search` | Pro・2のみ | △ 「Web検索して正確に」等の指示は書けるが未検証 |
| `system_prompt` | Pro・2・Lite | △（Lovartのプロンプト内に混ぜるしかない） |
| `safety_tolerance` | 1–6 | ✕ API専用ダイヤル、到達不能 |
| `image_urls`（edit） | 参照最大14枚 | ◎ 添付送達は保証。**現UIの3枚制限は自主制限**（fal上限14） |
| `video_url`/`audio_url`/`pdf_url`（2のedit） | 動画/音声/PDFを編集コンテキストに | △ Lovartの添付が画像以外をどう扱うか未検証 |
| `output_format` / `sync_mode` / `limit_generations` | — | ✕ |

## Seedream 系（5.0 Lite / 4.5 / 4）

fal.ai: `fal-ai/bytedance/seedream/v5/lite/*`, `v4.5/*`, `v4/*`（text-to-image / edit）

| fal.aiパラメータ | 仕様（モデル差） | Lovart対応 |
|---|---|---|
| `image_size` | 6プリセット+カスタム。5Lite: auto_2K/3K/4K（2560×1440–4096×4096）、4.5: auto_2K/4K（辺1920–4096）、4: auto/auto_2K/auto_4K（960²–4096²） | ○ 比率・解像度カテゴリは同系実証。カスタムpxは△ |
| `num_images` × `max_images` | 各1–6（最大36枚/回、edit系は入出力計15枚まで） | ✕ 現実装1枚。複数枚指示は△ |
| `seed` | 4・4.5: あり / **5Lite: 入力不可（出力のみ）** | ✕（実証はNB2 Liteだが同経路） |
| `enhance_prompt_mode` | 4のみ: standard/fast | △ |
| `enable_safety_checker` | 全機種 | ✕ |
| `image_urls`（edit） | **最大10枚**（超過分は末尾10枚採用） | ◎ 添付送達保証。現UI 3枚制限 < fal上限10 |
| `return_byteplus_urls`（5Lite t2i） | 24h期限URL | ✕ |
| `sync_mode` | — | ✕ |

## Flux.2 系（Max / Pro）

fal.ai: `fal-ai/flux-2-max`, `fal-ai/flux-2-pro`（各 `/edit`、Proは `/outpaint` も）

| fal.aiパラメータ | 仕様 | Lovart対応 |
|---|---|---|
| `image_size` | 6プリセット+カスタムW×H | ○ 比率は同系実証。カスタムpxは△ |
| `seed` | 入出力あり | ✕（プロンプト指示では再現保証なし） |
| `safety_tolerance` | "1"–"5"（既定"2"） | ✕ |
| `enable_safety_checker` | bool | ✕ |
| `output_format` | jpeg/png（既定jpeg） | ✕ 保証なし |
| `image_urls`（edit） | Pro editは**最大9枚**の参照合成 | ◎ 添付送達保証 |
| `num_images` | パラメータ自体なし（1枚/回） | — |

## Luma Uni-1 系（無印 / Max）

fal.ai: `luma/agent/uni-1/v1/text-to-image`, `/v1/max`（各 edit あり）

| fal.aiパラメータ | 仕様 | Lovart対応 |
|---|---|---|
| `aspect_ratio` | 9種（3:1〜1:3）。カスタムW×Hなし、最大2048px | ○ 同系実証 |
| `style` | auto / **manga** | △ 「マンガスタイルで」指示は書けるが`style`引数化は未検証 |
| `enable_web_search` | T2Iのみ | △ |
| `reference_image_urls` | **最大8枚**（T2I・editとも） | ◎ 添付送達保証 |
| `output_format` | png/jpeg | ✕ |
| seed / safety / num_images | fal側にもなし | — |

## Ideogram 4

fal.ai: `ideogram/v4`, `/image-to-image`（`/fast`, `/lora` 変種あり）

| fal.aiパラメータ | 仕様 | Lovart対応 |
|---|---|---|
| `image_size` | 6プリセット+カスタム（i2iはauto既定） | ○ 比率同系実証。カスタム△ |
| `rendering_speed` | TURBO/BALANCED/QUALITY（価格3倍差） | △ 「高品質で」指示の翻訳は未検証 |
| `expansion_model` | None/Medium/**Large（Magic Prompt）** | △ |
| `num_images` | 1–4 | ✕ 現実装1枚 |
| `seed` | あり | ✕ |
| `strength`（i2i） | 0.0–1.0（既定0.8） | △ 「元画像に忠実に」等の文章のみ |
| `output_format` | jpeg/png | ✕ |
| `acceleration` / `enable_safety_checker` / `sync_mode` | — | ✕ |
| ※Ideogram本家のstyle preset・カラーパレットはfal未公開 | — | — |

## Midjourney

**fal.aiに存在しない**（Midjourneyは2026年7月時点でも公式APIなし。サードパーティはApiframe等の非公式ラッパーのみで、PiAPI/GoAPIは撤退済み。現行モデルはv8.1が既定、niji 7が最新niji）。Lovartは独自ルートでMidjourneyを提供しており、これは**Lovartでしか使えない付加価値**。

2026-07-11 実生成検証（4回）:
- ○ **比率は反映**: 16:9指示→1456×816、1:1→1024×1024
- ✕ **バージョン指定は効かない**: LovartのWeb UIにはv8.1/v7/niji/niji7ピッカーがあるが、API経由では括弧書きヒント（`use the Midjourney niji model (--niji 7)`）も**正規の末尾フラグ直付け（`... --niji 7`）も無視**され、写実ポートレートプロンプトが2回とも完全な写真調で返却（niji 7なら確実にアニメ絵になる）。Web UIのピッカーはUI側の構造化パラメータで、エージェントAPIには露出していない
- 高精細レンダリングも同様に到達不能とみなす（v8.1ではHDが既定のため実害も小さい）

このためUIのバージョン選択・高精細トグルは撤去済み（比率・枚数のみ提供）。

---

# 動画モデル (15)

## Seedance 2.0 系（無印 / Fast / Mini）premium・利用可能（R4/R5検証済み）

fal.ai: `bytedance/seedance-2.0/{,fast/,mini/}{text-to-video,image-to-video,reference-to-video}`

| fal.aiパラメータ | 仕様（モデル差） | Lovart対応 |
|---|---|---|
| `resolution` | 無印: 480p/720p/1080p/**4k** / Fast・Mini: 480p/720pのみ | ○ 480p反映実証（R4-1: 496×864） |
| `duration` | auto, 4–15秒 | ○ 4秒反映実証（R4-1: 4.04s） |
| `aspect_ratio` | auto + 6種（21:9〜9:16） | ○ 9:16反映実証（R4-1） |
| `generate_audio` | bool（既定true、SFX+リップシンク） | ○ 無音指示実証（R4-1: 音声トラックなし） |
| `bitrate_mode` | 無印・Fast: standard/high（Miniなし） | △ 指示可・未検証 |
| 参照入力（r2v） | **画像9 + 動画3 + 音声3（計12ファイルまで）**、`@Image1`等で参照 | ◎ 添付送達保証＋役割注釈。参照画像→動画のキャラ一致を実証（R5-A） |
| `end_image_url`（i2v） | 終了フレーム | ◎ 役割注釈付き添付で送信（R5で同系実証） |
| seed | 入力不可（出力のみ） | — |

※初回検証（07-10昼）ではサイレント失敗していたが同日夜に開放（冒頭の「プレミアム動画モデル」参照）。UIの参照上限はfal仕様（9/3/3）に合わせて実装済み。

## Seedance 1.5 Pro（非premium・API利用可能）

fal.ai: `fal-ai/bytedance/seedance/v1.5/pro/{text-to-video,image-to-video}`

| fal.aiパラメータ | 仕様 | Lovart対応 |
|---|---|---|
| `duration` | 4–12秒（既定5、autoなし） | ○ 秒数指示は同系実証（T6） |
| `resolution` | 480p/720p/1080p | △ 指示可・未検証 |
| `aspect_ratio` | 7種（既定16:9） | ○ 同系実証 |
| `generate_audio` | bool（既定true、音声ありは2倍価格） | ○ 無音指示は同系実証 |
| `seed` | **入力あり**（-1でランダム） | ✕ プロンプト経由の再現保証なし |
| `camera_fixed` | bool（三脚固定） | △ 「カメラ固定で」指示は書ける |
| `end_image_url`（i2v） | 終了フレーム | ◎ 添付送達は保証（開始/終了の割当はエージェント判断） |
| `enable_safety_checker` | bool | ✕ |
| 参照r2vエンドポイント | **なし**（開始+終了フレームのみ） | — |

## Kling 系（3.0 / 3.0 Omni / 2.6 / O1）premium・利用可能（R4検証済み）

fal.ai: `fal-ai/kling-video/v3/*`, `o3/*`（=3.0 Omni）, `v2.6/*`, `o1/*`（=O1）

主要仕様（API開放時の参考）:

| 機能 | v3 | o3 (Omni) | v2.6 | O1 |
|---|---|---|---|---|
| duration | 3–15秒 | 3–15秒 | **5/10秒のみ** | 3–10秒 |
| 解像度 | 1080p | 1080p / **4kティアあり** | 1080p | 1080p |
| `generate_audio` | ○（既定true） | ○ | ○（音声ありは2倍） | **✕（keep_audioのみ）** |
| `negative_prompt` + `cfg_scale` | ○ | pro t2vのみ | ○ | ✕ |
| `multi_prompt`（マルチショット+秒数指定） | ○ | ○ | ✕ | ✕ |
| `elements`（キャラ参照） | i2v | ○（参照計4枚） | ✕ | ○（画像7枚+多角度） |
| 開始+終了フレーム | ○ | ○ | ○ | ○（デュアルキーフレーム） |
| 動画編集（v2v edit） | ✕ | ○ | ✕ | ○ |
| モーションコントロール | ✕ | ✕ | ○（専用EP、参照動画の動きコピー） | ✕ |
| `voice_ids`（ボイス指定） | ✕ | ✕ | pro i2vのみ | ✕ |

Lovart対応: Kling 2.6で実生成検証済み（R4-4: 1920×1080・5.04秒・無音指示反映、見積22クレジット）。秒数・比率・音声のプロンプト指示は反映される。negative_prompt・cfg_scale・multi_prompt・elementsは△（指示可・未検証）。UIはfal仕様どおり秒数（2.6は5/10固定、v3/o3は3–15）・音声トグル・参照上限を実装済み。

## Veo 系（3.1 / 3.1 Fast / 3）premium・利用可能（R4検証済み）

fal.ai: `fal-ai/veo3.1{,/fast}` + `/image-to-video`, `/first-last-frame-to-video`, `/reference-to-video`, `/extend-video`。Veo 3は**fal側で非推奨（サポート終了）**。

主要仕様（API開放時の参考）:
- `duration`: 4s/6s/8s、`resolution`: 720p/1080p/**4k**（Veo3は1080pまで）
- `generate_audio`（既定true）、`negative_prompt`、`seed`、`auto_fix`（ポリシー违反プロンプト自動修正）、`safety_tolerance` 1–6
- 開始/終了フレーム、参照画像（reference-to-video）、**動画延長（7秒/回×最大20回=約148秒）**

Lovart対応: Veo 3.1 Fastで実生成検証済み（R4-2: 1280×720・4.06秒・音声あり、見積48クレジット）。秒数・解像度・比率・音声の指示は反映される。UIは4/6/8秒ボタン＋720p/1080p/4K＋音声トグルを実装済み。negative_prompt・seed・動画延長は△/✕。

## Gemini Omni Flash premium・利用可能（R4検証済み）

fal.ai: `google/gemini-omni-flash`（+ `/image-to-video`, `/reference-to-video`, `/edit`）

- パラメータは3つだけ: `prompt` / `aspect_ratio`（16:9・9:16のみ） / `duration`（整数3–10秒）
- 解像度・seed・negative promptなし。**音声は常時生成**（オフ不可、プロンプトで内容指示）
- ユニーク機能: `<IMAGE_REF_n>`タグでの参照バインド、会話的動画編集EP

Lovart対応: 実生成検証済み（R4-3: 720×1280・3.008秒・音声あり、見積72クレジット）。秒数・比率の指示は反映される。UIは3–10秒スライダー＋16:9/9:16＋「音声常時オン」バッジを実装済み。

## Hailuo 2.3（非premium・API利用可能）

fal.ai: `fal-ai/minimax/hailuo-2.3/{standard,pro}/{text-to-video,image-to-video}`（+ fast i2v変種）

| fal.aiパラメータ | 仕様 | Lovart対応 |
|---|---|---|
| `duration` | standardのみ 6/10秒（**proは固定・指定不可**） | △ 6/10秒指示は可・未検証。それ以外の秒数はモデル非対応 |
| `prompt_optimizer` | bool（既定true） | △ |
| 解像度 | パラメータなし（standard=768p、pro=1080p、エンドポイントで決まる） | △ 「1080pで」指示がpro選択に翻訳されるかは未検証 |
| aspect_ratio / seed / negative / 音声 | **fal側に一切なし**（i2vは画像から継承、音声非対応） | — |
| `image_url`（i2v開始フレーム） | 単一 | ◎ 添付送達保証 |

## Wan 2.6（非premium・**生成実証済み**）

fal.ai: `wan/v2.6/{text-to-video,image-to-video{,/flash},reference-to-video{,/flash}}`

| fal.aiパラメータ | 仕様 | Lovart対応 |
|---|---|---|
| `aspect_ratio` | 5種（16:9/9:16/1:1/4:3/3:4） | ○ **9:16→1080×1920を実証**（T6） |
| `duration` | 5/10/15秒（r2vは5/10） | ○ **5秒→5.000秒を実証**（T6） |
| `resolution` | 720p/1080p（既定1080p） | ○ 1080p級出力を確認（T6） |
| 音声 | 標準EP: `audio_url`（BGM持込のみ）/ flash EP: `generate_audio`（既定true、無音は25%価格） | ○ **無音指示→音声トラックなしを実証**（T6） |
| `negative_prompt` | 最大500字 | △ 指示可・未検証 |
| `enable_prompt_expansion` + `multi_shots` | LLMリライト+自動マルチショット（既定true） | △ |
| `seed` | あり | ✕ 再現保証なし |
| マルチショット記法 | プロンプト内 `[0-3s] ショット1. [3-6s] ショット2.` | ○ プロンプト文字列なのでそのまま通せる（構造上Lovartと相性良） |
| `video_urls`（r2v） | 参照動画1–3本（`@Video1`参照） | ◎ 添付送達保証 |
| `image_urls`（r2v flash） | 参照画像0–5枚 | ◎ 同上 |
| `enable_safety_checker` | bool | ✕ |

## Vidu Q2（非premium・API利用可能）

fal.ai: `fal-ai/vidu/q2/{text-to-video,image-to-video/{pro,turbo},reference-to-video/pro}`

| fal.aiパラメータ | 仕様 | Lovart対応 |
|---|---|---|
| `duration` | **2–8秒（1秒刻み、既定4）** — 最短2秒はこの中で唯一 | △ 指示可・未検証（同系実証はあり） |
| `resolution` | t2v: 360p/520p/720p/1080p、i2v: 720p/1080p | △ |
| `aspect_ratio` | 16:9/9:16/1:1（r2vはカスタムW:Hも） | ○ 同系実証 |
| `movement_amplitude` | auto/small/medium/large（動きの量） | △ 「動きを控えめに」等の文章指示 |
| `bgm` | bool（**4秒動画のみ**、canned BGM） | △ |
| `seed` | あり | ✕ |
| `end_image_url`（i2v） | 終了フレーム | ◎ 添付送達保証 |
| 参照（r2v pro） | **画像最大7枚**（動画併用時4枚）+ **動画最大2本** | ◎ 添付送達保証 |
| negative prompt / prompt optimizer | fal側になし | — |

---

# まとめ: UI設計への示唆

1. **3段階表示の裏付けが取れた**
   - ◎「Lovartで保証」: モデル固定（品質別ツール含む）、参照ファイル送達
   - ○「指示で反映（実証済み）」: 比率、画像解像度ティア、透過、動画秒数、無音
   - △/✕「未確認・不可」: seed（✕実証）、negative/CFG、枚数、出力形式（✕実例あり）、safety系（✕構造上不可）

2. **動画15モデルすべてAPI経由で利用可能**（2026-07-10夜の再検証・R4で確認）。premiumモデルは `pending_confirmation`（クレジット見積→承認）フローが挟まる。初回検証時の空`items`サイレント失敗は再発しうるため、発生時は「Lovartのプラン・クレジットを確認」の誘導（https://www.lovart.ai/ja/pricing）を表示する。

3. **参照3枚制限は緩和余地あり**: fal実上限は Nano Banana系14枚 / Seedream edit 10枚 / Flux.2 Pro edit 9枚 / Luma 8枚 / Vidu Q2画像7枚。Lovartのattachmentsは構造化送達されるので、モデル別に上限を変えるのが正確。

4. **プロンプトで通せる「隠れ機能」**: Wan 2.6のタイムコード式マルチショット記法（`[0-3s]...`）はプロンプト文字列そのものなのでLovart経由でも損失なく届く。同様にKling `@Element1`/Seedance `@Image1` 参照記法も、該当モデルがAPI開放されれば添付+プロンプトの組合せで使える見込み。

5. **保証できないものはUIに書かない方が安全**: seed・CFG・negative promptは、Lovartが実引数を返さない限り「未確認」表示が正確（seedは「効かない」を実証済み）。

6. **ラウンド3で「使える」に昇格した設定**（UI未実装だが実証済み）: 複数枚生成（4枚・NB系）、極端比率8:1、Mangaスタイル（Luma）、出力形式の明示指定、Wan 2.6のタイムコード式マルチショット・音声ON・10秒。カスタムピクセル指定だけは✕（比率バケットに丸められる）。ただし全てプロンプト指示＝確率的なので、UIに載せるなら生成後の自動検査（ピクセル・ffprobe）とセットが望ましい。注意: 本番経路は現在プロンプト末尾に「Generate exactly one image.」を固定付加しているため、複数枚生成を実装する場合はこの接尾辞を可変にする必要がある（lib/lovartMediaGeneration.mjs buildLovartPrompt）。
