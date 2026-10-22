#!/usr/bin/env node
// 最適構成エンジンの構成表（config/optimal-config/catalog.json）を作り直す（Claude Code / Codex 共通）
//
//   node scripts/build-optimal-config-catalog.mjs                       # 手元の台帳だけで作り直す
//   node scripts/build-optimal-config-catalog.mjs --research <調査一式>  # 調査の JSON 台帳から取り込み直す
//   node scripts/build-optimal-config-catalog.mjs --check               # 作り直した結果がコミット済みと同じか
//
// なぜスクリプトで作るか:
// 構成表は「調査の台帳をそのままデータとして持つ」もので、モデルが更新されたら台帳を差し替えて
// 作り直すだけで済むようにしたい。手で JSON を直すと、どこまでが調査の記載でどこからが
// こちらの判断かが分からなくなる。だからこのファイルは2つを分けて持つ:
//
//   - 調査から取り込むもの: W01〜W40 の各欄、モデルの重みの許諾の表記と公式 URL、権利表の危険度、
//     高速化の対応環境。--research を渡したときだけ読み直す（渡さなければ、コミット済みの
//     catalog.json に入っている取り込み結果をそのまま使う）。テストは ~/Downloads に依存しない。
//   - こちらの判断（キュレーション）: R01〜R18 の要約と当てはまるチャンネルの性格、ワークフローの
//     選び方、モデルごとの権利の6層の判定と動く環境。下の定数に書く。
//
// 調査の JSON は信頼しない入力として読む（JSON.parse だけ。中の文字列を実行しない）。
// 調査資料は公式の資料を読んだだけで、何も実際には動かしていない（reproduced=false）。
// 構成表にもその事実をそのまま残す。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectCli } from "../lib/cliEntrypoint.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OPTIMAL_CONFIG_CATALOG_PATH = path.join(REPO_ROOT, "config", "optimal-config", "catalog.json");
export const OPTIMAL_CONFIG_CATALOG_VERSION = "optimal-config-catalog-v1";
export const OPTIMAL_CONFIG_AS_OF = "2026-10-22";

const ART_STYLES = ["flat-2d-manga", "anime", "photoreal", "diagram-mascot", "ai-footage", "live-footage"];
const ALL_IDENTITY = ["none", "mascot", "fixed-cast", "person+wardrobe"];
const ALL_MOTION = ["stills-camera", "few-clips", "mostly-video"];

// ---------------------------------------------------------------------------
// 実行場所。オトシゴのサーバーは画像・動画を生成も中継もしない（運営者の手元か契約先で動かす）。
// ---------------------------------------------------------------------------
const RUNTIME_PLACES = [
  { id: "operator-mac", label: "運営者の Mac（手元）", operatorOwned: true, sendsDataExternally: false, mediaGenerationAllowed: true },
  { id: "operator-cuda", label: "運営者の NVIDIA GPU（手元）", operatorOwned: true, sendsDataExternally: false, mediaGenerationAllowed: true },
  { id: "operator-rented-gpu", label: "運営者が借りる GPU（使う日だけ動かし、終わったら止めて保存費を確かめる）", operatorOwned: true, sendsDataExternally: true, mediaGenerationAllowed: true },
  { id: "operator-service", label: "運営者が契約しているサービス（ChatGPT／Codex、Grok、Google など）", operatorOwned: true, sendsDataExternally: true, mediaGenerationAllowed: true },
  { id: "otoshigo-hosted", label: "オトシゴのサーバー（画像・動画の生成と中継はしない）", operatorOwned: false, sendsDataExternally: true, mediaGenerationAllowed: false },
];

const RIGHTS_LAYERS = [
  { id: "A", key: "code", label: "コード", question: "UI・ノード・推論コードのライセンス。これだけで重みを商用に使えるとは言えない。" },
  { id: "B", key: "weights", label: "重みと全依存", question: "base・LoRA・VAE・text/face encoder まで全部の許諾。本番・売上・地域の条件を別々に見る。" },
  { id: "C", key: "outputs", label: "出力", question: "生成物を使う・売る・公開する許諾。地域の制限が出力に及ぶものもある。" },
  { id: "D", key: "hosting", label: "ホスト・再販", question: "個人の制作と、API やサービスとしての提供は別の用途。" },
  { id: "E", key: "assets", label: "素材と人物", question: "参照画像・既存キャラ・実在人物の権利と同意。モデルの許諾とは別。" },
  { id: "F", key: "data", label: "データの扱い", question: "送信先・保存・学習利用。ローカルでも拡張機能の通信を確かめる。" },
];

// ---------------------------------------------------------------------------
// R01〜R18（動画生成 総合ガイド 第2章の要約。言い換え。原文は資料を見る）
// targetTraits はチャンネルの性格との当てはまり。role は構成の中での役目:
//   base=本編の作り方 / clips=数カットだけ動画 / identity=人物資産の連続性 / operations=量の運用
//   runtime=機材・契約に合わせた実行 / confidential=外部送信ゼロ / quality=品質と納期優先 / trial=短期比較
// ---------------------------------------------------------------------------
const VIDEO_CONFIGS = [
  {
    id: "R01", name: "全編を生成しない（静止画＋カメラ＋声）", role: "base", pdfPages: "p10",
    summary: "解説・朗読・情報整理。静止画や図で意味が伝わり、人物が常に自然に動く必要はない。",
    targetTraits: { artStyles: ["flat-2d-manga", "anime", "photoreal", "diagram-mascot", "live-footage"], identityLocks: ALL_IDENTITY, motions: ["stills-camera"] },
    motionLevel: "none", identityNeeds: "既存のキャラ絵や写真を使い回す。動きの一致は求めない。",
    runtimePlaces: ["operator-mac", "operator-cuda"], budgetBand: "zero", skillLevel: "L0-L1",
    failureModes: ["動くこと自体を価値と考えて意味のない I2V を挟む", "単調な読み上げの量産を低コストで収益化できると決めつける", "静止画を数百枚手で扱う手間を費用に数えない"],
    migrateTo: [{ to: ["R03", "R09"], when: "静止画で説明できない動作が出たら、その部分だけ" }, { to: ["R04"], when: "毎回同じキャラを動かすなら rig への投資と比べる" }],
  },
  {
    id: "R02", name: "安い雰囲気 B-roll を小型の無音 T2V で大量に試す", role: "clips", pdfPages: "p10",
    summary: "抽象背景・天候・遠景など、特定の人物や商品と一致させなくてよい素材。失敗は捨てられる。",
    targetTraits: { artStyles: ["ai-footage", "photoreal"], identityLocks: ["none"], motions: ["few-clips", "mostly-video"] },
    motionLevel: "medium", identityNeeds: "顔・ロゴ・細かい手作業は避ける設計にする。",
    runtimePlaces: ["operator-cuda"], budgetBand: "low", skillLevel: "L1-L2",
    failureModes: ["最速の T2V 重みを I2V として使う", "480p の抽象背景での成功を顔の接写に一般化する", "8GB に収まることを 8GB で速いと読む"],
    migrateTo: [{ to: ["R03"], when: "構図や主人公を固定したくなったら" }],
  },
  {
    id: "R03", name: "先頭画像を合格にしてから I2V（B-roll・数カット）", role: "clips", pdfPages: "p11",
    summary: "1カット2〜5秒。構図・色・世界観はそろえたいが、複雑な動作までは要らない。",
    targetTraits: { artStyles: ART_STYLES, identityLocks: ALL_IDENTITY, motions: ["few-clips", "mostly-video"] },
    motionLevel: "low", identityNeeds: "先頭画像の段階で人物・画風を固定し、動画では1動作ずつ指定する。",
    runtimePlaces: ["operator-cuda", "operator-rented-gpu", "operator-service"], budgetBand: "medium", skillLevel: "L1-L2",
    failureModes: ["同じ画像でもモデルを変えると同じ動きが出るとは限らない", "upscale で商品や文字の正しさは直らない", "低解像度の試作と本生成の二重費用が削減分を上回る"],
    migrateTo: [{ to: ["R06"], when: "毎回キャラが変わり、人物の連続性が要るなら" }],
  },
  {
    id: "R04", name: "アニメ会話劇（台詞が先、キャラ固定、必要な所だけ生成）", role: "base", pdfPages: "p11",
    summary: "同じ数人が毎回話す掛け合い。台詞と話者が大事で、全身の複雑な動作は少ない。",
    targetTraits: { artStyles: ["flat-2d-manga", "anime"], identityLocks: ["fixed-cast", "mascot"], motions: ["stills-camera", "few-clips"] },
    motionLevel: "low", identityNeeds: "設定画・表情差分・口形・背景をキャラ資産として持ち、話数で回収する。",
    runtimePlaces: ["operator-mac", "operator-cuda"], budgetBand: "low", skillLevel: "L1-L2",
    failureModes: ["汎用の音声駆動モデルがどの2D絵にも自然な口形を出せると思う", "複数話者を一度に生成して話者が混ざる"],
    migrateTo: [{ to: ["R03"], when: "特別な身振りの数カットだけ動画にする" }, { to: ["R10"], when: "自然な芝居が必須の接写だけ、同じ音声で比べる" }],
  },
  {
    id: "R05", name: "アニメのバトル・ダンス（動作を先に設計）", role: "base", pdfPages: "p11-12",
    summary: "動きのタイミング・手足・接触・カメラが主役。画風より動きの正確さ。",
    targetTraits: { artStyles: ["anime", "flat-2d-manga"], identityLocks: ["fixed-cast", "mascot"], motions: ["mostly-video"] },
    motionLevel: "high", identityNeeds: "動作リファレンス・簡易3D・ポーズ条件を先に作る。",
    runtimePlaces: ["operator-cuda", "operator-rented-gpu"], budgetBand: "high", skillLevel: "L2+",
    failureModes: ["始点と終点を指定しても途中の接触が正しくなる保証はない", "人間用の motion transfer を非人間キャラや高速戦闘に使う"],
    migrateTo: [{ to: ["R09"], when: "接触が何度も破綻する部分は3Dか手付けで完成させる" }],
  },
  {
    id: "R06", name: "実写調の連続物語（人物資産とショットの連続性を先に作る）", role: "identity", pdfPages: "p12",
    summary: "同じ主人公が複数の場面に出る。顔・衣装・舞台・時間帯の連続性が大事。",
    targetTraits: { artStyles: ["photoreal", "ai-footage"], identityLocks: ["person+wardrobe", "fixed-cast"], motions: ALL_MOTION },
    motionLevel: "medium", identityNeeds: "人物の正面・横顔、衣装、場所の基準画像とショット表を先に作る。",
    runtimePlaces: ["operator-cuda", "operator-rented-gpu", "operator-service"], budgetBand: "medium", skillLevel: "L1-L2",
    failureModes: ["最良の単発を並べても同じ作品に見えるとは限らない", "参照対応を完全な人物固定と書く"],
    migrateTo: [{ to: ["R04"], when: "人物の一致に費用がかかりすぎるなら、rig・3D化や許可済みの自前 LoRA と比べる" }],
  },
  {
    id: "R07", name: "猫・犬などの物語ショート（個体の特徴と単純な動作）", role: "base", pdfPages: "p12-13",
    summary: "同じ動物キャラが毎回出る短い物語。毛色・模様・体型・小物を固定したい。",
    targetTraits: { artStyles: ["anime", "photoreal", "ai-footage"], identityLocks: ["mascot"], motions: ["few-clips", "mostly-video"] },
    motionLevel: "medium", identityNeeds: "個体の設定シートと場面ごとの開始画像。人間の顔用の口パクを動物に当然のように使わない。",
    runtimePlaces: ["operator-cuda", "operator-rented-gpu"], budgetBand: "low", skillLevel: "L1-L2",
    failureModes: ["物語の表情の弱さを映像モデルの画質不足と取り違える", "似たテンプレートの大量投稿で価値も収益化も保証されると思う"],
    migrateTo: [{ to: ["R04"], when: "個体の一致に失敗し続けるなら 2D/3D キャラへ" }],
  },
  {
    id: "R08", name: "商品・建築・機構を正確に見せる（生成しない領域を決める）", role: "base", pdfPages: "p13",
    summary: "ロゴ・寸法・形状・表示など、誤りの損失が大きいもの。商品そのものは実写・3D・合成で固定する。",
    targetTraits: { artStyles: ["live-footage", "photoreal"], identityLocks: ["none"], motions: ["stills-camera", "few-clips"] },
    motionLevel: "low", identityNeeds: "商品は承認済みの素材で固定し、背景だけ生成する。",
    runtimePlaces: ["operator-mac", "operator-cuda"], budgetBand: "medium", skillLevel: "L1-L2",
    failureModes: ["I2V でもロゴや輪郭は途中で変わりうる", "生成した使用実演を性能の証拠として見せる"],
    migrateTo: [{ to: ["R01"], when: "背景生成が不安定なら静止背景とカメラ移動だけで成立させる" }],
  },
  {
    id: "R09", name: "図解・文字・正確なアニメーション（拡散動画よりタイムライン）", role: "base", pdfPages: "p13",
    summary: "仕組み・比較・ニュース説明など、値・文字・矢印・図形を正確に保ちたいもの。",
    targetTraits: { artStyles: ["diagram-mascot"], identityLocks: ["none", "mascot", "person+wardrobe"], motions: ["stills-camera", "few-clips"] },
    motionLevel: "none", identityNeeds: "生成画像は装飾・背景・人物素材に限る。図と文字は生成しない。",
    runtimePlaces: ["operator-mac", "operator-cuda"], budgetBand: "zero", skillLevel: "L0-L2",
    failureModes: ["アニメーションを作りたいを動画拡散モデルが必要と読み替える", "正しい式や日本語字幕まで生成映像に焼き込む", "クロスフェードで素材が二重に見える"],
    migrateTo: [{ to: ["R02", "R03"], when: "比喩的な数秒のイメージだけ補う" }],
  },
  {
    id: "R10", name: "話す司会・アバター（音声を先に確定）", role: "base", pdfPages: "p13-14",
    summary: "同じ司会が解説し、台詞は一字一句重要。口と音の同期と本人らしさが優先。",
    targetTraits: { artStyles: ["photoreal", "anime"], identityLocks: ["person+wardrobe"], motions: ["few-clips", "mostly-video"] },
    motionLevel: "medium", identityNeeds: "許可を得た人物の画像か動画と、完成した台詞音声。",
    runtimePlaces: ["operator-cuda", "operator-service"], budgetBand: "medium", skillLevel: "L1-L2",
    failureModes: ["TTS を併用しているのに動画モデルが日本語を正確に話すと説明する", "人物向けの S2V の結果をアニメや動物に一般化する"],
    migrateTo: [{ to: ["R04", "R05"], when: "会話相手や全身が必要なら分解する" }],
  },
  {
    id: "R11", name: "ASMR・環境映像・ループ（音を先に評価）", role: "base", pdfPages: "p14",
    summary: "長時間でも、全時間が新しい映像である必要はない。",
    targetTraits: { artStyles: ["ai-footage", "live-footage", "photoreal"], identityLocks: ["none"], motions: ["few-clips", "mostly-video"] },
    motionLevel: "low", identityNeeds: "継ぎ目の少ない構図と周期的な動き。",
    runtimePlaces: ["operator-mac", "operator-cuda"], budgetBand: "low", skillLevel: "L1",
    failureModes: ["逆再生で液体や炎が不自然になる", "クロスフェードで物体が二重になる", "周期的なクリック音が残る"],
    migrateTo: [{ to: ["R01"], when: "継ぎ目が難しければ静止画＋軽い演出に戻す" }],
  },
  {
    id: "R12", name: "ミュージックビデオ（音源を先に固定し、拍とフレーズで割る）", role: "base", pdfPages: "p14-15",
    summary: "楽曲が中心。拍・展開・歌詞に合わせた編集が大事で、長い一発生成は要らない。",
    targetTraits: { artStyles: ["anime", "photoreal", "ai-footage"], identityLocks: ALL_IDENTITY, motions: ["mostly-video"] },
    motionLevel: "high", identityNeeds: "世界観の基準画像とショットリスト。",
    runtimePlaces: ["operator-cuda", "operator-rented-gpu", "operator-service"], budgetBand: "medium", skillLevel: "L1-L2",
    failureModes: ["音楽入力への対応を歌詞どおりの口パクと取り違える", "全カットを同じプロンプトで作って展開が弱くなる"],
    migrateTo: [{ to: ["R02", "R11"], when: "抽象映像が中心なら寄せる" }],
  },
  {
    id: "R13", name: "本数・枚数が多い（生成の列より先に合格条件を自動化）", role: "operations", pdfPages: "p15",
    summary: "継続制作で新しい素材が多い。人が承認する段階を残したまま機械検査を先に作る。",
    targetTraits: { artStyles: ART_STYLES, identityLocks: ALL_IDENTITY, motions: ALL_MOTION },
    appliesWhen: { minLengthMinutes: 40 },
    motionLevel: "medium", identityNeeds: "ショット表・画像・音声・比率を構造化して持つ。",
    runtimePlaces: ["operator-mac", "operator-rented-gpu", "operator-service"], budgetBand: "medium", skillLevel: "L3",
    failureModes: ["失敗を無限に再試行する", "検品できない量を生成する", "量産・反復的な内容の収益化リスクを無視する"],
    migrateTo: [{ to: [], when: "検品が詰まったら、生成速度ではなく候補数と合格基準を調整する" }],
  },
  {
    id: "R14", name: "GPU なし・Google の既存契約あり（完成サービスと Colab の役割分担）", role: "runtime", pdfPages: "p15",
    summary: "契約内の Veo で主役の短いカット、量の補充は Colab 上のライセンス適合モデル。",
    targetTraits: { artStyles: ["ai-footage", "photoreal", "anime"], identityLocks: ALL_IDENTITY, motions: ["few-clips", "mostly-video"] },
    appliesWhen: { contractsAny: ["google-ai"], motionNot: ["stills-camera"] },
    motionLevel: "medium", identityNeeds: "サービスで作るものと自分で動かすものの入力を分ける。",
    runtimePlaces: ["operator-service"], budgetBand: "low", skillLevel: "L0-L2",
    failureModes: ["契約で API が無料になる、GPU が確約されていると説明する", "表示名やモデル ID を実際の利用先で確かめない"],
    migrateTo: [{ to: ["R18"], when: "枠を使い切った・納期が迫ったら予算内の完成サービスか借り GPU へ" }],
  },
  {
    id: "R15", name: "Mac が中心（CUDA 向けの軽量化をそのまま持ち込まない）", role: "runtime", pdfPages: "p16",
    summary: "Apple Silicon で GPU を買わずに試す。待ち時間は許容、長尺の量産はまだ要らない。",
    targetTraits: { artStyles: ART_STYLES, identityLocks: ALL_IDENTITY, motions: ["few-clips", "mostly-video"] },
    appliesWhen: { macOnly: true, motionNot: ["stills-camera"] },
    motionLevel: "low", identityNeeds: "必要なモードがある Mac 対応の実行環境だけを比べる。",
    runtimePlaces: ["operator-mac"], budgetBand: "low", skillLevel: "L0-L2",
    failureModes: ["NVFP4 や CUDA 専用の kernel が Mac で使えると思う", "最低メモリを満たせば高解像度・長尺も快適だと断定する"],
    migrateTo: [{ to: ["R18"], when: "締切を守れないなら生成だけ借り GPU かサービス、編集は Mac" }],
  },
  {
    id: "R16", name: "顧客秘密・未発表素材（外部送信ゼロの工程）", role: "confidential", pdfPages: "p16",
    summary: "顔・商品・図面・台本を外部へ送れない。生成を手元で完結させる。",
    targetTraits: { artStyles: ART_STYLES, identityLocks: ALL_IDENTITY, motions: ALL_MOTION },
    appliesWhen: { confidentialAssets: true },
    motionLevel: "medium", identityNeeds: "許可済みの手元素材と手元の text encoder。",
    runtimePlaces: ["operator-mac", "operator-cuda"], budgetBand: "high", skillLevel: "L2+",
    failureModes: ["クラウド GPU をローカルモデルだからデータは出ないと説明する", "画像は手元でも声や upscale で外へ送ってしまう"],
    migrateTo: [{ to: [], when: "クラウドが必要なら、契約とデータ範囲の承認を先に変える（黙って外に出さない）" }],
  },
  {
    id: "R17", name: "品質と納期が最優先（予算を見せ場と人の仕上げに配る）", role: "quality", pdfPages: "p17",
    summary: "案件・新番組・代表作。視聴者が注目するカットだけ上位の経路を使う。",
    targetTraits: { artStyles: ART_STYLES, identityLocks: ALL_IDENTITY, motions: ALL_MOTION },
    appliesWhen: { priority: "quality-deadline" },
    motionLevel: "medium", identityNeeds: "カットごとに合格条件を決める。",
    runtimePlaces: ["operator-cuda", "operator-rented-gpu", "operator-service"], budgetBand: "high", skillLevel: "L1-L3",
    failureModes: ["解像度やモデルの価格を品質の代わりにする", "冒頭だけきれいで残りがばらばらになる"],
    migrateTo: [{ to: [], when: "規定の試行費や時間を超えたカットは構図変更・撮影・3D・合成へ" }],
  },
  {
    id: "R18", name: "GPU も既存契約もなく低頻度で試す（購入より短期比較）", role: "trial", pdfPages: "p17",
    summary: "ジャンルも量も決まっていない。買う前に同じ5〜10ショットで短期比較する。",
    targetTraits: { artStyles: ART_STYLES, identityLocks: ALL_IDENTITY, motions: ["few-clips", "mostly-video"] },
    appliesWhen: { noGpuNoContract: true, motionNot: ["stills-camera"] },
    motionLevel: "low", identityNeeds: "同じ試験セットと合格基準で比べる。",
    runtimePlaces: ["operator-rented-gpu", "operator-service"], budgetBand: "low", skillLevel: "L0-L2",
    failureModes: ["月1時間しか使わない人に GPU 購入を最安として勧める", "GPU 時給だけ見て停止後の保存費を計算しない"],
    migrateTo: [{ to: [], when: "採用率が確認でき、需要が続き、手元実行で総費用か機密面が良くなるなら購入を比べる" }],
  },
];

// ---------------------------------------------------------------------------
// ワークフローの選び方（こちらの判断）。when の欄はすべて満たしたときに当てはまる。
// priority が小さいほど先に出す。requiresModels は、そのワークフローが特定のモデルに依存する場合だけ書く
// （依存先が権利の関門で止まれば、ワークフローごと外す）。
// ---------------------------------------------------------------------------
const WORKFLOW_SELECTORS = [
  // 2D 漫画・アニメで固定キャスト
  { workflowId: "W07", priority: 10, when: { artStyles: ["flat-2d-manga", "anime"], identityLocks: ["fixed-cast", "mascot"] }, purpose: "参照の役割を分け、1キャラ1枚ずつ渡す" },
  { workflowId: "W03", priority: 20, when: { artStyles: ["flat-2d-manga", "anime"] }, purpose: "絵は生成し、文字・吹き出しは後から決まった処理で組む" },
  { workflowId: "W06", priority: 30, when: { artStyles: ["flat-2d-manga", "anime"], identityLocks: ["fixed-cast", "mascot"] }, purpose: "絵柄・キャラ・骨格を別の条件に分ける" },
  { workflowId: "W04", priority: 40, when: { artStyles: ["flat-2d-manga", "anime"] }, purpose: "構図の決まったコマを ControlNet で清書する" },
  { workflowId: "W17", priority: 50, when: { artStyles: ["flat-2d-manga", "anime"], identityLocks: ["fixed-cast"] }, purpose: "固定キャストの LoRA。作るかどうかは10カット試験の再生成率で決める" },
  { workflowId: "W01", priority: 60, when: { artStyles: ["flat-2d-manga", "anime"] }, purpose: "サムネは絵と文字を分け、文字は編集できる形で組む" },
  // 実写調の人物＋衣装
  { workflowId: "W07", priority: 10, when: { artStyles: ["photoreal", "ai-footage"], identityLocks: ["person+wardrobe", "fixed-cast"] }, purpose: "顔の基準・衣装シート・構図を別々の参照として渡す" },
  { workflowId: "W12", priority: 20, when: { artStyles: ["photoreal"], identityLocks: ["person+wardrobe"] }, purpose: "衣装と人物の合成（低 VRAM では遅い）" },
  { workflowId: "W23", priority: 30, when: { artStyles: ["photoreal", "ai-footage"] }, purpose: "字幕の帯にかぶった所や画像内の英字だけを部分的に直す" },
  { workflowId: "W22", priority: 35, when: { artStyles: ["photoreal"], identityLocks: ["person+wardrobe"] }, purpose: "指示編集で部分修正（使うモデルは権利の関門を通ったものだけ）" },
  { workflowId: "W40", priority: 40, when: { artStyles: ["photoreal", "ai-footage", "live-footage"] }, purpose: "直せるものは生成せずに通常の編集で直す" },
  // 図解＋マスコット
  { workflowId: "W25", priority: 10, when: { artStyles: ["diagram-mascot"], identityLocks: ["mascot"] }, purpose: "マスコットの姿勢ごとの素材を最初から透過で作る" },
  { workflowId: "W28", priority: 20, when: { artStyles: ["diagram-mascot"] }, purpose: "切り抜いてレイヤーにし、溶かして重ねずに差し替える" },
  { workflowId: "W01", priority: 30, when: { artStyles: ["diagram-mascot"], identityLocks: ["none", "mascot"] }, purpose: "サムネは絵と文字を分け、文字は編集できる形で組む" },
  // 図解＋人物
  { workflowId: "W07", priority: 10, when: { artStyles: ["diagram-mascot"], identityLocks: ["person+wardrobe", "fixed-cast"] }, purpose: "人物と小道具をそろえる" },
  { workflowId: "W29", priority: 25, when: { artStyles: ["diagram-mascot"], identityLocks: ["person+wardrobe", "fixed-cast"] }, purpose: "人物を切り抜いて図解の上に合成する（前後関係は合成で直す）" },
  { workflowId: "W23", priority: 30, when: { artStyles: ["diagram-mascot"], identityLocks: ["person+wardrobe", "fixed-cast"] }, purpose: "手や指だけ部分的に直す" },
  // 実写・原資料
  { workflowId: "W29", priority: 10, when: { artStyles: ["live-footage"] }, purpose: "実物は残して背景だけ変える" },
  { workflowId: "W24", priority: 20, when: { artStyles: ["live-footage"] }, purpose: "生成モデルを使わずに不要物を消す" },
  // 外部送信ゼロ
  { workflowId: "W40", priority: 5, when: { confidentialAssets: true }, purpose: "外へ出せない素材は、まず通常の編集で済ませる" },
];

/** ワークフローが特定のモデルに依存するもの（依存先が止まればワークフローも外す）。 */
const WORKFLOW_MODEL_DEPENDENCIES = {
  W05: ["anima"],
  W09: ["pulid"],
  W10: ["instantid"],
};

// ---------------------------------------------------------------------------
// モデル（こちらの判断で選んだ、構成に関わるものだけ）。権利は6層の欄ごとに持つ:
//   code / weights / outputs / hosting / region / data
// 値の意味:
//   weights.operatorProductionUse: allowed | conditional | forbidden | unverified | not-applicable
//   weights.licenseKind: open | non-commercial | research | community | proprietary-service
//   outputs.commercialUse: allowed | conditional | forbidden | unverified
//   hosting.asService: allowed | conditional | forbidden | unverified
//   region.excludedTerritories + region.appliesToOutputs
//   data.sendsExternally: true | false | "optional"
// runtime.mac.supported: true | false | "unverified"（unverified は選ばない）
// ---------------------------------------------------------------------------
const MODELS = [
  {
    id: "gpt-image", name: "GPT Image（ChatGPT／Codex）", kind: "image", access: "service",
    contractKeys: ["chatgpt", "codex"], mediaGenerationIds: ["gpt-image-2-codex", "gpt-image-2"],
    roles: ["image-primary"], fit: { artStyles: ["flat-2d-manga", "anime", "photoreal", "diagram-mascot"] }, preference: 10,
    rights: {
      code: { license: "非公開サービス", status: "not-applicable" },
      weights: { license: "非公開サービス（重みは配布されない）", licenseKind: "proprietary-service", operatorProductionUse: "not-applicable" },
      outputs: { commercialUse: "allowed", note: "利用規約上、当事者間では出力は利用者のもの。第三者の権利や著作権の成立までは保証しない。" },
      hosting: { asService: "forbidden", note: "画像の納品とサービス・アカウントの再提供は別。個人アカウントの共有や自動アクセスの再販はしない。" },
      region: { excludedTerritories: [], appliesToOutputs: false },
      data: { sendsExternally: true, note: "プロンプトと参照画像は提供元へ送られる。API と消費者向けアプリで保持期間が違う。" },
    },
    runtime: { places: ["operator-service"], mac: { supported: "not-applicable" }, cuda: null, note: "運営者の契約の中で動かす。利用上限（429）に当たったら下書き経路へ切り替える。" },
    evidence: { rightsFindingId: "openai" },
  },
  {
    id: "flux2-klein-4b", name: "FLUX.2 [klein] 4B", kind: "image", access: "open-weights",
    catalogModelId: "black-forest-labs/FLUX.2-klein-4B",
    roles: ["image-draft", "image-primary"], fit: { artStyles: ["flat-2d-manga", "anime", "photoreal", "diagram-mascot"] }, preference: 20,
    rights: {
      code: { license: "Apache-2.0", status: "ok" },
      weights: { license: "Apache-2.0", licenseKind: "open", operatorProductionUse: "allowed", note: "配布・改変には許諾文・変更表示・NOTICE の条件。" },
      outputs: { commercialUse: "allowed", note: "Apache の表示は肖像・著作権・商標までの保証ではない。" },
      hosting: { asService: "allowed", note: "Apache の条件で商用ホストも検討できる（ただしオトシゴは画像を生成・中継しない）。" },
      region: { excludedTerritories: [], appliesToOutputs: false },
      data: { sendsExternally: false, note: "第三者アプリの『ローカル』表示だけでは通信停止を保証しない。" },
    },
    runtime: { places: ["operator-mac", "operator-cuda", "operator-rented-gpu"], mac: { supported: true, minMemoryGiB: 16, note: "Mac 版 Ollama・MFLUX の経路あり。8GB の動作例は全機種の保証ではない（未実測）。" }, cuda: { minVramGiB: 8, note: "公式に約8GB の記載。" } },
    evidence: { rightsFindingId: "flux2_klein" },
  },
  {
    id: "flux2-klein-9b", name: "FLUX.2 [klein] 9B", kind: "image", access: "open-weights",
    catalogModelId: "black-forest-labs/FLUX.2-klein-9B",
    roles: ["image-draft", "image-primary"], fit: { artStyles: ["flat-2d-manga", "anime", "photoreal", "diagram-mascot"] }, preference: 25,
    rights: {
      code: { license: "Apache-2.0", status: "ok" },
      weights: { license: "FLUX Non-Commercial", licenseKind: "non-commercial", operatorProductionUse: "forbidden", note: "同じ klein でも 9B は非商用。商用の重み契約は別。" },
      outputs: { commercialUse: "conditional", note: "dev 型の出力と重みの区別を読む必要がある。" },
      hosting: { asService: "forbidden" },
      region: { excludedTerritories: [], appliesToOutputs: false },
      data: { sendsExternally: false },
    },
    runtime: { places: ["operator-cuda", "operator-rented-gpu"], mac: { supported: "unverified" }, cuda: { minVramGiB: null } },
    evidence: { rightsFindingId: "flux2_klein" },
  },
  {
    id: "flux-dev", name: "FLUX.1 / FLUX.2 [dev]", kind: "image", access: "open-weights",
    catalogModelId: "black-forest-labs/FLUX.1-dev",
    roles: ["image-primary"], fit: { artStyles: ["anime", "photoreal", "diagram-mascot"] }, preference: 40,
    rights: {
      code: { license: "Apache-2.0", status: "ok" },
      weights: { license: "FLUX Non-Commercial v2.0", licenseKind: "non-commercial", operatorProductionUse: "forbidden", note: "重みと派生モデルは原則非商用。収益事業・内部本番での利用は区別される。" },
      outputs: { commercialUse: "allowed", note: "出力の商用利用は認められるが、重みを本番で使う許諾にはならない。" },
      hosting: { asService: "forbidden", note: "出力の商用許可だけで推論サービスは運営できない。" },
      region: { excludedTerritories: [], appliesToOutputs: false },
      data: { sendsExternally: false },
    },
    runtime: { places: ["operator-cuda", "operator-rented-gpu"], mac: { supported: "unverified" }, cuda: { minVramGiB: null, note: "dev の参照実装は H100 級。" } },
    evidence: { rightsFindingId: "flux_dev" },
  },
  {
    id: "z-image-turbo", name: "Z-Image Turbo", kind: "image", access: "open-weights",
    catalogModelId: "Tongyi-MAI/Z-Image-Turbo",
    roles: ["image-bulk", "image-primary"], fit: { artStyles: ["photoreal"] }, preference: 15,
    rights: {
      code: { license: "Apache-2.0", status: "ok" },
      weights: { license: "Apache-2.0", licenseKind: "open", operatorProductionUse: "allowed", note: "同梱・外部依存物は別に確認する。" },
      outputs: { commercialUse: "allowed", note: "生成物の第三者の権利は別に確認する。" },
      hosting: { asService: "allowed" },
      region: { excludedTerritories: [], appliesToOutputs: false },
      data: { sendsExternally: false },
    },
    runtime: { places: ["operator-cuda", "operator-rented-gpu"], mac: { supported: "unverified", note: "MFLUX・sd.cpp の経路はあるが未実測。" }, cuda: { minVramGiB: 16, note: "16GB の一般向け GPU という公式記載。8ステップ（CFG なし）。" } },
    evidence: { rightsFindingId: null },
  },
  {
    id: "z-image", name: "Z-Image（非蒸留 base）", kind: "image", access: "open-weights",
    catalogModelId: "Tongyi-MAI/Z-Image",
    roles: ["image-primary"], fit: { artStyles: ["photoreal"] }, preference: 30,
    rights: {
      code: { license: "Apache-2.0", status: "ok" },
      weights: { license: "Apache-2.0", licenseKind: "open", operatorProductionUse: "allowed" },
      outputs: { commercialUse: "allowed" },
      hosting: { asService: "allowed" },
      region: { excludedTerritories: [], appliesToOutputs: false },
      data: { sendsExternally: false },
    },
    runtime: { places: ["operator-cuda", "operator-rented-gpu"], mac: { supported: "unverified" }, cuda: { minVramGiB: null, note: "28〜50ステップ・CFG あり。必要メモリは未確認。" } },
    evidence: { rightsFindingId: null },
  },
  {
    id: "anima", name: "Anima（アニメ・イラスト）", kind: "image", access: "open-weights",
    catalogModelId: "circlestone-labs/Anima",
    roles: ["image-primary"], fit: { artStyles: ["flat-2d-manga", "anime"] }, preference: 30,
    rights: {
      code: { license: "未個別確認", status: "unverified" },
      weights: { license: "CircleStone Non-Commercial + NVIDIA Open Model の依存条件", licenseKind: "non-commercial", operatorProductionUse: "conditional", outputsCommercialExplicit: true, note: "モデル自体は非商用だが、生成画像の商用利用はモデルカードと LICENSE 2(e) に明記されている。運営者の手元で使う分には合う。" },
      outputs: { commercialUse: "allowed", note: "生成画像の販売・依頼・商用素材としての利用は可と明記。" },
      hosting: { asService: "forbidden", note: "モデルを有料 API や製品として提供するのは不可。オトシゴが代わりに動かす形にはしない。" },
      region: { excludedTerritories: [], appliesToOutputs: false },
      data: { sendsExternally: false },
    },
    runtime: { places: ["operator-cuda", "operator-rented-gpu"], mac: { supported: "unverified" }, cuda: { minVramGiB: null, note: "2B。必要メモリは一次資料で確定できず未実測。" } },
    evidence: { rightsFindingId: null },
  },
  {
    id: "qwen-image-2-1", name: "Qwen-Image-2.1 / 2.1-Turbo", kind: "image", access: "open-weights",
    catalogModelId: "Qwen/Qwen-Image-2.1",
    roles: ["image-primary", "image-edit"], fit: { artStyles: ["flat-2d-manga", "anime", "photoreal", "diagram-mascot"] }, preference: 35,
    rights: {
      code: { license: "Qwen Research License", status: "block" },
      weights: { license: "Qwen Research License (2026-09-20)", licenseKind: "research", operatorProductionUse: "forbidden", note: "研究・評価に限る。商用は別ライセンス。旧 Qwen-Image の Apache-2.0 を引き継がない。" },
      outputs: { commercialUse: "unverified", note: "一般的な商用出力の例外を本文で確認できない。" },
      hosting: { asService: "forbidden" },
      region: { excludedTerritories: [], appliesToOutputs: false },
      data: { sendsExternally: false },
    },
    runtime: { places: ["operator-cuda", "operator-rented-gpu"], mac: { supported: "unverified" }, cuda: { minVramGiB: null } },
    evidence: { rightsFindingId: "qwen21" },
  },
  {
    id: "noobai-xl", name: "NoobAI-XL 1.1", kind: "image", access: "open-weights",
    roles: ["image-primary"], fit: { artStyles: ["flat-2d-manga", "anime"] }, preference: 40,
    rights: {
      code: { license: "SDXL 系", status: "caution" },
      weights: { license: "NoobAI 独自条件", licenseKind: "non-commercial", operatorProductionUse: "forbidden", note: "モデルと派生物の商業化を禁止。" },
      outputs: { commercialUse: "forbidden", note: "モデルで作った生成物も商業化の禁止対象に含む。" },
      hosting: { asService: "forbidden" },
      region: { excludedTerritories: [], appliesToOutputs: false },
      data: { sendsExternally: false },
    },
    runtime: { places: ["operator-cuda", "operator-rented-gpu"], mac: { supported: "unverified" }, cuda: { minVramGiB: null } },
    evidence: { rightsFindingId: "noob11" },
  },
  {
    id: "pony-v7", name: "Pony V7", kind: "image", access: "open-weights",
    roles: ["image-primary"], fit: { artStyles: ["flat-2d-manga", "anime"] }, preference: 40,
    rights: {
      code: { license: "Pony Diffusion License", status: "caution" },
      weights: { license: "Pony Diffusion License（現行）", licenseKind: "community", operatorProductionUse: "conditional", revenueThresholdUsd: 1000000, professionalAnimation: "separate-license", note: "年売上 US$1M 未満の小規模商用は可。ただしホスト・API と、プロの映画・アニメ制作は売上に関係なく別許諾。" },
      outputs: { commercialUse: "conditional", note: "出力は派生物から外れるが、生成に使う商用の用途の許諾は飛ばせない。" },
      hosting: { asService: "forbidden", note: "小規模なら有料推論も可、ではない。" },
      region: { excludedTerritories: [], appliesToOutputs: false },
      data: { sendsExternally: false },
    },
    runtime: { places: ["operator-cuda", "operator-rented-gpu"], mac: { supported: "unverified" }, cuda: { minVramGiB: null } },
    evidence: { rightsFindingId: "pony7" },
  },
  {
    id: "illustrious-xl-v0", name: "Illustrious XL early-release v0", kind: "image", access: "open-weights",
    roles: ["image-primary"], fit: { artStyles: ["flat-2d-manga", "anime"] }, preference: 40,
    rights: {
      code: { license: "SDXL 系", status: "caution" },
      weights: { license: "Illustrious v0 の追加利用条件", licenseKind: "community", operatorProductionUse: "conditional", derivativeTerms: "restrictive", note: "微調整・マージの公開やレシピ開示を求め、閉じた派生の収益化を禁じる記載。研究用途の説明もある。" },
      outputs: { commercialUse: "conditional", note: "出力の拡散は制限しないが、第三者の権利と非独自性を留保。" },
      hosting: { asService: "forbidden" },
      region: { excludedTerritories: [], appliesToOutputs: false },
      data: { sendsExternally: false, note: "利用規約にコンテンツの改善・学習利用の記載がある。" },
    },
    runtime: { places: ["operator-cuda", "operator-rented-gpu"], mac: { supported: "unverified" }, cuda: { minVramGiB: null } },
    evidence: { rightsFindingId: "illustrious0" },
  },
  {
    id: "hunyuan-image-3", name: "HunyuanImage-3.0", kind: "image", access: "open-weights",
    catalogModelId: "tencent/HunyuanImage-3.0",
    roles: ["image-primary"], fit: { artStyles: ["photoreal", "anime"] }, preference: 50,
    rights: {
      code: { license: "Tencent Hunyuan Community License", status: "caution" },
      weights: { license: "Tencent Hunyuan Community License", licenseKind: "community", operatorProductionUse: "conditional", note: "許諾の領域は EU・英国・韓国を除く世界。" },
      outputs: { commercialUse: "conditional", note: "領域外での出力の使用・複製・配布・表示を明示的に禁止。" },
      hosting: { asService: "conditional" },
      region: { excludedTerritories: ["EU", "UK", "KR"], appliesToOutputs: true, note: "日本で作っても世界へ無条件に配信できるとは言えない。" },
      data: { sendsExternally: false },
    },
    runtime: { places: ["operator-rented-gpu"], mac: { supported: false }, cuda: { minVramGiB: 240, note: "推奨は 80GB×3 枚以上。" } },
    evidence: { rightsFindingId: "hunyuan3" },
  },
  {
    id: "minimax-h3", name: "MiniMax H3 系（FastH3 等の派生を含む）", kind: "video", access: "open-weights",
    roles: ["video-i2v", "video-t2v"], fit: { artStyles: ["anime", "photoreal", "ai-footage"] }, preference: 40,
    rights: {
      code: { license: "MiniMax のモデルライセンス", status: "caution" },
      weights: { license: "MiniMax H3 ライセンス（2026-10-19 確認）", licenseKind: "community", operatorProductionUse: "conditional", note: "EU・英国・韓国・米国が適用地域の外。" },
      outputs: { commercialUse: "conditional", note: "出力の地域外での使用・配布・表示も制限。公の場での AI 生成表示の条件もある。" },
      hosting: { asService: "conditional" },
      region: { excludedTerritories: ["EU", "UK", "KR", "US"], appliesToOutputs: true, note: "全世界公開を前提にするなら、許諾を確認するまで標準構成から外す。" },
      data: { sendsExternally: false },
    },
    runtime: { places: ["operator-cuda", "operator-rented-gpu"], mac: { supported: "unverified" }, cuda: { minVramGiB: null } },
    evidence: { rightsFindingId: null, videoGuidePages: "p17-18" },
  },
  {
    id: "instantid", name: "InstantID（InsightFace の顔重みに依存）", kind: "face-id", access: "open-weights",
    roles: ["face-id"], fit: { artStyles: ["photoreal", "anime"] }, preference: 50,
    rights: {
      code: { license: "Apache-2.0", status: "ok" },
      weights: { license: "公開 checkpoint は研究用途。InsightFace の学習済みモデルは非商用研究用", licenseKind: "research", operatorProductionUse: "forbidden", faceIdWeightsCommercial: false, note: "コードが Apache でも、顔の重みは非商用。自動取得も例外ではない。" },
      outputs: { commercialUse: "unverified", note: "顔一致画像を売るなら顔重みの別の商用許諾が要るかを確認する。" },
      hosting: { asService: "forbidden" },
      region: { excludedTerritories: [], appliesToOutputs: false },
      data: { sendsExternally: false, note: "顔写真と embedding の保存先・保持期間を別に審査する。" },
    },
    runtime: { places: ["operator-cuda", "operator-rented-gpu"], mac: { supported: "unverified" }, cuda: { minVramGiB: null } },
    evidence: { rightsFindingId: "instantid" },
  },
  {
    id: "pulid", name: "PuLID（InsightFace の顔エンコーダに依存）", kind: "face-id", access: "open-weights",
    roles: ["face-id"], fit: { artStyles: ["photoreal", "anime"] }, preference: 50,
    rights: {
      code: { license: "Apache-2.0", status: "ok" },
      weights: { license: "本体は Apache。標準実装の InsightFace（antelopev2）は非商用研究条件", licenseKind: "research", operatorProductionUse: "forbidden", faceIdWeightsCommercial: false, note: "PuLID の生成物であることだけでは顔エンコーダの制約を回避できない。" },
      outputs: { commercialUse: "unverified" },
      hosting: { asService: "forbidden" },
      region: { excludedTerritories: [], appliesToOutputs: false },
      data: { sendsExternally: false },
    },
    runtime: { places: ["operator-cuda", "operator-rented-gpu"], mac: { supported: "unverified" }, cuda: { minVramGiB: null } },
    evidence: { rightsFindingId: "pulid" },
  },
  {
    id: "wan2-2-ti2v-5b", name: "Wan2.2 TI2V-5B", kind: "video", access: "open-weights",
    roles: ["video-i2v", "video-t2v"], fit: { artStyles: ["flat-2d-manga", "anime", "photoreal", "diagram-mascot", "ai-footage"] }, preference: 10,
    rights: {
      code: { license: "Apache-2.0", status: "ok" },
      weights: { license: "Apache-2.0", licenseKind: "open", operatorProductionUse: "allowed" },
      outputs: { commercialUse: "allowed", note: "画像とモデルの両方に商用条件が要る（先頭画像の権利も見る）。" },
      hosting: { asService: "allowed" },
      region: { excludedTerritories: [], appliesToOutputs: false },
      data: { sendsExternally: "optional", note: "公式には API とローカルの2種類のプロンプト拡張がある。API 側を選ぶと文章が外へ出る。" },
    },
    runtime: { places: ["operator-cuda", "operator-rented-gpu"], mac: { supported: "unverified", note: "Mac でそのまま動く手順としては扱わない。" }, cuda: { minVramGiB: 8, note: "ComfyUI の標準 offload で 8GB の案内（速度は保証しない）。公式の比較の起点は 24GB 級。" } },
    evidence: { rightsFindingId: null, videoGuidePages: "p11, p25, p29-34" },
  },
  {
    id: "ltx-2-5", name: "LTX-2.5（LTX Desktop のローカル Fast 経路を含む）", kind: "video", access: "open-weights",
    roles: ["video-i2v", "video-t2v", "video-av"], fit: { artStyles: ["anime", "photoreal", "ai-footage"] }, preference: 20,
    rights: {
      code: { license: "LTX のライセンス（コードの許諾は未個別確認）", status: "unverified" },
      weights: { license: "LTX-2 系ライセンス", licenseKind: "community", operatorProductionUse: "conditional", revenueThresholdUsd: 10000000, note: "関連会社を含む年商が US$1,000万以上なら、所定の非商用用途を除き有償ライセンス。" },
      outputs: { commercialUse: "conditional", note: "売上の閾値の条件は原文で確認する。" },
      hosting: { asService: "conditional" },
      region: { excludedTerritories: [], appliesToOutputs: false },
      data: { sendsExternally: "optional", note: "LTX Desktop にはクラウドとローカルの text encoder の選択がある。API の Pro はローカル Fast とは別。" },
    },
    runtime: { places: ["operator-mac", "operator-cuda", "operator-rented-gpu"], mac: { supported: true, minMemoryGiB: 32, note: "LTX Desktop のローカル経路は Apple Silicon で 32GiB 以上が条件。32GiB 未満と Intel Mac は非対応。" }, cuda: { minVramGiB: 15, note: "Desktop の Fast 経路は CUDA で 15GiB 以上。一般の Python パイプラインは 32GB。" } },
    evidence: { rightsFindingId: null, videoGuidePages: "p16, p21-22, p25, p84-85" },
  },
  {
    id: "grok-imagine", name: "Grok Imagine（画像・動画）", kind: "video", access: "service",
    contractKeys: ["grok"], mediaGenerationIds: ["grok-imagine-video-hermes", "grok-imagine-video-api", "grok-imagine-image-hermes", "grok-imagine-image-api"],
    roles: ["video-i2v"], fit: { artStyles: ["flat-2d-manga", "anime", "photoreal", "ai-footage", "diagram-mascot"] }, preference: 10,
    rights: {
      code: { license: "非公開サービス", status: "not-applicable" },
      weights: { license: "非公開サービス", licenseKind: "proprietary-service", operatorProductionUse: "not-applicable" },
      outputs: { commercialUse: "unverified", note: "この調査一式では出力の条件を一次資料で確認していない。契約先の規約を確認する。" },
      hosting: { asService: "forbidden", note: "サービスのアクセスを再提供しない。" },
      region: { excludedTerritories: [], appliesToOutputs: false },
      data: { sendsExternally: true, note: "先頭画像とプロンプトは提供元へ送られる。" },
    },
    runtime: { places: ["operator-service"], mac: { supported: "not-applicable" }, cuda: null },
    evidence: { rightsFindingId: null },
  },
  {
    id: "veo", name: "Veo（Google の Flow・Gemini 契約の枠）", kind: "video", access: "service",
    contractKeys: ["google-ai"], mediaGenerationIds: ["lovart-veo-3-1", "lovart-veo-3-1-fast", "lovart-veo-3"],
    roles: ["video-i2v", "video-t2v"], fit: { artStyles: ["photoreal", "ai-footage", "anime"] }, preference: 15,
    rights: {
      code: { license: "非公開サービス", status: "not-applicable" },
      weights: { license: "非公開サービス", licenseKind: "proprietary-service", operatorProductionUse: "not-applicable" },
      outputs: { commercialUse: "conditional", note: "契約・地域・残り枠と、現実と誤認されうる映像の開示条件を利用先で確認する。" },
      hosting: { asService: "forbidden" },
      region: { excludedTerritories: [], appliesToOutputs: false, note: "利用資格と地域は契約先で確認する。" },
      data: { sendsExternally: true, note: "Google へ送る画像・音声・プロンプトを確認する。無料と課金でデータの扱いが違う。" },
    },
    runtime: { places: ["operator-service"], mac: { supported: "not-applicable" }, cuda: null, note: "Web/Flow の枠、API の料金、Colab の compute unit は別の財布。" },
    evidence: { rightsFindingId: "gemini_api", videoGuidePages: "p15" },
  },
];

// 高速化の対応環境（こちらの判断）。cudaOnly は Mac へ持ち込まない。macOnly は Mac 専用。
const ACCELERATION_PLATFORMS = {
  Q03: "cuda-only", Q06: "cuda-only", Q07: "cuda-only", Q08: "cuda-only", O03: "cuda-only", O09: "cuda-only", E04: "cuda-only", E09: "cuda-only",
  M01: "mac-only", M02: "mac-only", M03: "mac-only", M04: "mac-only", M05: "mac-only", A06: "mac-only",
  Q05: "cross-platform", E01: "cross-platform", E03: "cross-platform", U01: "cross-platform", U03: "cross-platform", D07: "cross-platform", D08: "cross-platform",
};

const SOURCE_DATASETS = [
  { id: "workflow_registry", title: "画像生成AI 全域調査一式 workflows_channels/workflow_registry.json", as_of: "2026-10-22", provides: "W01〜W40 の各欄" },
  { id: "rights_risk_matrix", title: "画像生成AI 全域調査一式 rights/rights_risk_matrix_ja.json", as_of: "2026-10-22", provides: "権利の6層（A〜F）と各モデルの危険度" },
  { id: "open_image_models_catalog", title: "画像生成AI 全域調査一式 models/open_image_models_catalog_20261022.json", as_of: "2026-10-22", provides: "重みの許諾の表記と公式の配布先" },
  { id: "acceleration_catalog", title: "画像生成AI 全域調査一式 acceleration_tools/catalog.json", as_of: "2026-10-22", provides: "高速化・低 VRAM の対応環境" },
  { id: "video_generation_guide", title: "動画生成 総合ガイド（全調査統合版）第2章・第3章・付録A", as_of: "2026-10-22", provides: "R01〜R18、10カット試験と記録の最小項目（p17-18）、LTX・Wan・MiniMax H3 の条件" },
];

// ---------------------------------------------------------------------------
// 取り込み
// ---------------------------------------------------------------------------

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function researchFiles(researchDir) {
  const root = path.resolve(researchDir);
  return {
    workflows: path.join(root, "workflows_channels", "workflow_registry.json"),
    rights: path.join(root, "rights", "rights_risk_matrix_ja.json"),
    models: path.join(root, "models", "open_image_models_catalog_20261022.json"),
    accelerations: path.join(root, "acceleration_tools", "catalog.json"),
  };
}

/** 調査の JSON から取り込む部分だけを返す（信頼しない入力として、使う欄だけを文字列で拾う）。 */
export function importResearch(researchDir) {
  const files = researchFiles(researchDir);
  for (const [key, file] of Object.entries(files)) {
    if (!existsSync(file)) throw new Error(`調査一式に ${key} の台帳が無い: ${path.basename(file)}`);
  }
  const workflowRegistry = readJson(files.workflows);
  const workflows = (Array.isArray(workflowRegistry.workflows) ? workflowRegistry.workflows : []).map((row) => ({
    id: text(row.id),
    category: text(row.category),
    name: text(row.name),
    tools: text(row.tools),
    workflow: text(row.workflow),
    good_for: text(row.good_for),
    caveats: text(row.caveats),
    validation: text(row.validation),
    sourceIds: (Array.isArray(row.source_ids) ? row.source_ids : []).map(text).filter(Boolean),
    reproduced: row.reproduced === true,
  }));
  const licenseCautions = (Array.isArray(workflowRegistry.license_cautions) ? workflowRegistry.license_cautions : [])
    .map((row) => ({ topic: text(row.topic), finding: text(row.finding) }));

  const rightsMatrix = readJson(files.rights);
  const rightsFindings = {};
  for (const row of Array.isArray(rightsMatrix.findings) ? rightsMatrix.findings : []) {
    rightsFindings[text(row.id)] = {
      risk: text(row.risk),
      verifiedAt: text(row.verified_at),
      sourceUrls: (Array.isArray(row.source_urls) ? row.source_urls : []).map(text).filter((url) => /^https:\/\//u.test(url)),
    };
  }

  const modelCatalog = readJson(files.models);
  const catalogVariants = {};
  for (const row of Array.isArray(modelCatalog.variants) ? modelCatalog.variants : []) {
    const id = text(row.model_id);
    if (!id) continue;
    catalogVariants[id] = {
      weightsLicense: text(row.weights_license),
      weightsUrl: /^https:\/\//u.test(text(row.weights_url)) ? text(row.weights_url) : "",
      status: text(row.status),
      evidenceDate: text(row.evidence_date),
    };
  }

  const accelerationCatalog = readJson(files.accelerations);
  const accelerations = (Array.isArray(accelerationCatalog.entries) ? accelerationCatalog.entries : []).map((row) => ({
    id: text(row.id),
    category: text(row.category),
    name: text(row.name),
    hardware: text(row.hardware),
    constraints: text(row.constraints),
    license: text(row.license),
  }));

  return { workflows, licenseCautions, rightsFindings, catalogVariants, accelerations };
}

/** コミット済みの catalog.json から、前回の取り込み結果を取り出す（--research が無いとき）。 */
export function importedFromCatalog(catalog) {
  const rightsFindings = {};
  const catalogVariants = {};
  for (const model of catalog?.models || []) {
    if (model.evidence?.rightsFindingId && model.evidence.rightsFinding) {
      rightsFindings[model.evidence.rightsFindingId] = model.evidence.rightsFinding;
    }
    if (model.catalogModelId && model.evidence?.catalogVariant) {
      catalogVariants[model.catalogModelId] = model.evidence.catalogVariant;
    }
  }
  return {
    workflows: (catalog?.imageWorkflows || []).map(({ requiresModels, ...row }) => row),
    licenseCautions: catalog?.licenseCautions || [],
    rightsFindings,
    catalogVariants,
    accelerations: (catalog?.accelerations || []).map(({ platform, ...row }) => row),
  };
}

export function buildCatalog(imported) {
  const workflows = imported.workflows.map((row) => ({
    ...row,
    ...(WORKFLOW_MODEL_DEPENDENCIES[row.id] ? { requiresModels: WORKFLOW_MODEL_DEPENDENCIES[row.id] } : {}),
  }));
  const models = MODELS.map((model) => {
    const evidence = { ...model.evidence };
    if (evidence.rightsFindingId && imported.rightsFindings[evidence.rightsFindingId]) {
      evidence.rightsFinding = imported.rightsFindings[evidence.rightsFindingId];
    }
    if (model.catalogModelId && imported.catalogVariants[model.catalogModelId]) {
      evidence.catalogVariant = imported.catalogVariants[model.catalogModelId];
    }
    return { ...model, asOf: OPTIMAL_CONFIG_AS_OF, reproduced: false, evidence };
  });
  return {
    $schema: "./catalog.schema.json",
    version: OPTIMAL_CONFIG_CATALOG_VERSION,
    as_of: OPTIMAL_CONFIG_AS_OF,
    reproduced: false,
    benchmarked: false,
    note: "調査資料は公式の資料を読んだだけで、ここにある構成・ワークフロー・モデルは誰も実際には動かしていない（reproduced=false、ベンチマークなし）。日本語の文字描画・口パク・Mac での所要時間も未実測。だから正解を決め打ちせず、候補を2〜3案に絞って同じ10カットで試し、数字で決める。権利の判定は法的助言ではない。",
    generatedBy: "scripts/build-optimal-config-catalog.mjs",
    sourceDatasets: SOURCE_DATASETS,
    runtimePlaces: RUNTIME_PLACES,
    rightsLayers: RIGHTS_LAYERS,
    videoConfigs: VIDEO_CONFIGS,
    imageWorkflows: workflows,
    workflowSelectors: WORKFLOW_SELECTORS,
    licenseCautions: imported.licenseCautions,
    models,
    accelerations: imported.accelerations.map((row) => ({ ...row, platform: ACCELERATION_PLATFORMS[row.id] || "unverified" })),
  };
}

export function serializeCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

function parseArgs(argv) {
  const args = { research: "", check: false, out: OPTIMAL_CONFIG_CATALOG_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--research") args.research = argv[++index] || "";
    else if (arg === "--check") args.check = true;
    else if (arg === "--out") args.out = path.resolve(argv[++index] || "");
    else throw new Error(`知らない引数: ${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const committed = existsSync(OPTIMAL_CONFIG_CATALOG_PATH) ? readJson(OPTIMAL_CONFIG_CATALOG_PATH) : null;
  let imported;
  if (args.research) {
    imported = importResearch(args.research);
  } else if (committed) {
    imported = importedFromCatalog(committed);
  } else {
    throw new Error("コミット済みの catalog.json が無いので、--research <調査一式のフォルダ> を渡して作る。");
  }
  const output = serializeCatalog(buildCatalog(imported));
  if (args.check) {
    const current = existsSync(args.out) ? readFileSync(args.out, "utf8") : "";
    if (current !== output) {
      process.stderr.write("catalog.json が作り直した結果と違う。node scripts/build-optimal-config-catalog.mjs で作り直す。\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write("catalog.json は作り直した結果と一致している。\n");
    return;
  }
  writeFileSync(args.out, output, "utf8");
  const catalog = JSON.parse(output);
  process.stdout.write(`${path.relative(REPO_ROOT, args.out)} を書いた（R ${catalog.videoConfigs.length} / W ${catalog.imageWorkflows.length} / モデル ${catalog.models.length} / 高速化 ${catalog.accelerations.length}）。\n`);
}

if (isDirectCli(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
