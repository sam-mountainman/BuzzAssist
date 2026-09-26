/**
 * 台本の品質ループ（ジャンル層の共通 Core）。
 *
 * 中核（採点・下限・失敗指紋・止まる条件・作る係と評価する係の分離）は lib/qualityLoop.mjs の
 * 共通部品で、ここが決めるのは次の4つだけ:
 *   - ジャンル既定の評価項目と下限（ナレーション物語の台本なら、拍の型・意味の保持・語り口・
 *     尺・感想パートの一人称の差し替え印・読み）
 *   - 機械ゲート（台本が読める、外部モデルの手直しに呼び出しの記録が付いていて全部完了している）
 *   - 上限の既定と、Channel Pack（非公開）からの上書きの範囲
 *   - 台本の「版」を1回の採点へ結び付ける配線（台本 SHA・版・前の版・評価文脈・外部呼び出し）
 *
 * 台本づくりは「ホストの初稿 → 外部モデルの手直し → ホストの意味照合」の3段で、初稿を
 * 書いた文脈がそのまま照合もしていた。ここでは版ごとに、**その版を作った文脈（初稿の文脈・
 * 追加の作り手・外部モデルを呼んだ文脈）とは別の評価文脈**の採点を1回として記録する。
 *
 * 守ること:
 *   - 採点は台本ファイルの SHA と版に縛る。採点ファイルの scriptSha256 が今の台本と違えば
 *     記録しない。前の版から作った版は、前の版の SHA と比べたこと（baseScriptSha256）を要求する
 *   - 2回目以降は「前の失敗をどう直したか」が要る。無ければ例外ではなく人待ちで止める
 *   - Channel Pack はジャンルの下限を**上げる**・評価項目を**足す**・重みを変えることだけできる。
 *     下限を下げる・ジャンルの項目を消す・範囲外の上限は blocker（黙って既定へ戻さない）
 *   - 状態は台本と同じ作業フォルダ（私有側）の quality/ に原子的に書く。本文は持たない
 *   - 合格した版の後に台本が変わったら、その合格は今の台本を保証しない（status が示す）
 *   - Pack が評価者を宣言したら、1つの版は宣言した評価者全員の「評価の組」で1回になる。受け入れ方は
 *     average（既定）か each-evaluator。宣言しないチャンネルは今までどおり1件で1回
 *   - 始め直しても、同じ作業フォルダの回数・費用・時間を持ち越し、止まる条件は累計でも判定する。累計を
 *     戻せるのは理由と人の確認つきの reset-cumulative だけ。費用の分からない呼び出しは 0 円として数えない
 *   - 指摘には id を付け、次の版では指摘ごとの採否と理由を要求する。採用した指摘が次の回でも出たら停滞に数える
 *   - 制作側は scriptQualityVerdict だけを見る（合格した版と同じ SHA か、人がそのまま使うと認めた SHA か）
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { readJsonIfExists, writeJsonAtomic } from "./atomicJsonFile.mjs";
import { withCanvasFileLock } from "./canvasFileLock.mjs";
import { trustedChannelPackKeyFromEnvironment, verifyChannelPackEnvelope } from "./channelPackEnvelope.mjs";
import { externalCallLedgerPath, findExternalCalls, isExternalCallId } from "./externalModelCallLedger.mjs";
import {
  QUALITY_ACCEPTANCE_MODES,
  createQualityLoopState,
  findStaleQualityFeedback,
  normalizeCarriedOver,
  normalizeQualityAcceptance,
  normalizeQualityRubric,
  recordQualityRound,
  sanitizeEvidence,
} from "./qualityLoop.mjs";

export const SCRIPT_QUALITY_CONTRACT_VERSION = "buzzassist-script-quality-contract-v1";
export const SCRIPT_QUALITY_STATE_VERSION = "buzzassist-script-quality-loop-v1";
export const SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION = "buzzassist-script-quality-channel-v1";
/** Channel Pack の payload に置く、チャンネル固有の評価項目と下限。 */
export const SCRIPT_QUALITY_CHANNEL_CONFIG_FILE = "script-quality.json";
export const SCRIPT_QUALITY_DIR = "quality";
export const SCRIPT_QUALITY_STATE_FILE = "script-quality-loop.json";
export const SCRIPT_REVISION_DELTA_FILE = "script-revision-delta.json";
/** 人が台本をそのまま使うと認めた記録（運営者が自分で書いた台本など）。ループの状態とは別のファイル。 */
export const SCRIPT_HUMAN_ACCEPTANCE_FILE = "script-human-acceptance.json";
export const SCRIPT_HUMAN_ACCEPTANCE_VERSION = "buzzassist-script-human-acceptance-v1";
/** 作る係の役割 id。評価者がこれを名乗っても採点できない。 */
export const SCRIPT_GENERATOR_ID = "script-writer";
/** 版を作った工程。 */
export const SCRIPT_STAGES = Object.freeze(["draft", "external-rewrite", "meaning-check", "revision"]);

/** 機械ゲート。採点より前に、ファイルと台帳だけから決まる。 */
export const SCRIPT_MACHINE_GATES = Object.freeze({
  "script-readable": "台本ファイルが UTF-8 で読めて、空でない",
  "external-call-recorded": "外部モデルの手直しの版に、外部モデル呼び出しの記録（harness-external-call）が付いていて、参照した id が全部台帳にある",
  "external-calls-complete": "参照した外部モデル呼び出しが全部 complete（空返答・途中切れ・上限・時間切れが無い）",
});

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CONTEXT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const EVALUATOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/u;
/** 1つの評価の組に宣言できる評価者の数の上限。 */
export const SCRIPT_PANEL_MAX_EVALUATORS = 5;
const CRITERION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

// ナレーション物語の台本の評価項目。重みと下限は実測から決めた閾値ではなく方針値。
// 視聴者や制作ラインが「話が違う」と気づく意味の保持は下限 90、生成した体験を本人の体験に
// 見せない差し替え印は満点（1つでも欠ければ不合格）、ほかは致命傷の足切りとして 60〜70。
// 重みは合計 100。外部モデルの手直しで最も壊れやすいのが意味なので、意味の保持を一番重くした。
const NARRATED_STORY_SCRIPT_RUBRIC = Object.freeze([
  {
    id: "beat-structure",
    label: "拍の型への適合",
    weight: 20,
    minimumScore: 70,
    description: "チャンネルが宣言した拍（場面の順・山場の位置・回収する言葉・締め）に沿っている。欠けた拍、順番の入れ替わり、山場の前寄りが無い",
  },
  {
    id: "meaning-preservation",
    label: "意味の保持",
    weight: 30,
    minimumScore: 90,
    description: "前の版から、人物・年齢・数字・否定・条件・因果・台詞の語順（鉤括弧の中の句読点を含む）が変わっていない。新しい出来事が足されていない。初稿では、依頼された題材と拍の表に対して見る",
  },
  {
    id: "narration-voice",
    label: "語り口",
    weight: 15,
    minimumScore: 60,
    description: "1行1文で、耳で聞いて自然。同じ説明・反省の繰り返し、説教、誰の台詞か分からない行が無い",
  },
  {
    id: "duration-fit",
    label: "尺",
    weight: 10,
    minimumScore: 60,
    description: "実測の話速で見積もった尺がチャンネルの宣言した範囲に入り、山場が宣言した位置までに来る",
  },
  {
    id: "review-first-person-marker",
    label: "感想パートの一人称の差し替え印",
    weight: 10,
    minimumScore: 100,
    description: "感想パートで案内役が自分の体験として語る文すべてに、差し替え印（Channel Pack が宣言した印）が付いている。生成した体験を本人の体験として確定させていない（該当する文が無ければ満点）",
  },
  {
    id: "reading-clarity",
    label: "読み",
    weight: 15,
    minimumScore: 70,
    description: "読みが割れる語・同音で意味が変わる語を避けるか、読みを指定している。人名の読みが一意",
  },
]);

// 漫画の台本の評価項目。BuzzAssist 独自の評価基準で、特定の講座・コミュニティの教えではない。
// チャンネル固有の型（番組の筋の型・固定の登場人物・号砲の合図など）は入れない。それは Channel Pack が
// criteria で足す。出典はリポジトリの漫画ジャンルの正本:
//   - .agents/skills/manga-video-production/references/quality-contract-ja.md「台本と編集」
//     （原文の人物名・読み・時系列・ナレーション・台詞・感情曲線を省略しない／カット見出しは場面情報で、
//      場面冒頭は地理、以降は反応・対面・行動・証拠へ進む／「去る」「届く」などの動詞は主体・進行方向・
//      残された人物が読める画にする／連続ナレーションでも可視事実が変われば画を分ける／台詞間の間）
//   - 同「人物と絵」（三人称ナレーションの明示主語を主人公へ置換しない）
//   - 同「吹き出し」と SKILL.md「絶対条件」（縦書き最大3列・意味の切れ目で分割し、固有名詞・複合語・
//     活用語の途中で切らない／読み仮名の括弧注記を表示に残さず、読みは音声側にだけ持たせる）
//   - .agents/skills/manga-video-production/SKILL.md「制作手順」1・2・5・10（台本を省略・要約せず解析する／
//     主人公を一意に決める／発話ごとの意味から構図を設計する／統合の前に各文の可視事実を比べる）
// 下限は方針値: 原文の保持はナレーション物語の「意味の保持」と同じ 90、話者の一意性は漫画の動画の品質ループの
// 同一性・意味の一致と同じ 80、ほかは致命傷の足切りとして 60〜70。重みは合計 100。
const MANGA_SCRIPT_RUBRIC = Object.freeze([
  {
    id: "source-fidelity",
    label: "原文の保持",
    weight: 25,
    minimumScore: 90,
    description: "前の版から、人物名・読み・時系列・ナレーション・台詞・感情の流れが省かれたり要約されたりしていない。新しい出来事が足されていない。初稿では、依頼された題材と場面の表に対して見る",
  },
  {
    id: "speaker-attribution",
    label: "話者の一意性",
    weight: 15,
    minimumScore: 80,
    description: "どの行も、ナレーションか・どの人物の台詞か・心の声かが一意に読める。主人公が1人に決まり、三人称の地の文の主語が主人公へすり替わっていない",
  },
  {
    id: "panel-premise",
    label: "画にする前提の読みやすさ",
    weight: 20,
    minimumScore: 70,
    description: "カット見出しが場面（場所・時間・その場にいる人物）として読め、各発話の動作の主体・向き・残された人物と、見せるべき証拠（書類・画面・贈り物など）が画にできる具体さで書かれている。見える事実が変わる文を1つの場面に詰め込んでいない",
  },
  {
    id: "bubble-fit",
    label: "台詞の吹き出し適性",
    weight: 15,
    minimumScore: 70,
    description: "1つの台詞が縦書きの吹き出し（最大3列）に収まるか、意味の切れ目で分けられる。固有名詞・複合語・活用語の途中でしか切れない長文や、表示に残る読み仮名の括弧注記が無い",
  },
  {
    id: "reading-clarity",
    label: "読み",
    weight: 15,
    minimumScore: 70,
    description: "人名・地名・読みが割れる語の読みが一意か、読みを指定している（読みは音声の側にだけ持たせ、表示する文は原文のまま）",
  },
  {
    id: "beat-pacing",
    label: "間と感情の流れ",
    weight: 10,
    minimumScore: 60,
    description: "話者の交代・問い返し・感情の転換に間を取れる並びになっている。同じ説明の繰り返しや、早口の紙芝居になる詰め込みが無い",
  },
]);

// 解説動画の台本の評価項目。BuzzAssist 独自の評価基準で、特定の講座・コミュニティの教えではない。
// ジャンル固有の正本スキルはまだ無い（解説動画のハーネス explainer-video は、この項目の id・名前・重み・下限を
// 完成動画の人の評価にも使う。lib/explainerQualityLoop.mjs）。基準はリポジトリの一般原則から引いた:
//   - .agents/skills/platform-craft/SKILL.md「この層で繰り返し見つかった不具合の型」（検証したと書いてあるのに
//     検証していない・欠落を許可として扱う）と「実行の記録」（走っていないゲートを通ったと書けない）
//     → 根拠が支える範囲を越えた主張・確かめていないことを確かめたように言う文を落とす（evidence-scope）
//   - .agents/skills/platform-craft/references/learned-auto.md（過去の報告や名前だけで断定せず、実物を測って
//     区別して記録する）→ 推測と確かめた事実を分けて言う（evidence-scope）
//   - このファイルのナレーション物語の基準（語り口: 同じ説明の繰り返しが無い／読み）
//     → 発見の積み上がり（discovery-progression）・読み（reading-clarity）
// 問いの明確さ・初見での理解・冒頭の約束の回収は、BuzzAssist が解説動画の台本に求める形として置いた方針値。
// 図解と説明の対応（visual-narration-alignment）とテンポ（pacing）は、ジャンルに共通の観点（面白さ・導入・
// 分かりやすさ・テンポ・内容の整合性。SCRIPT_QUALITY_COMMON_PERSPECTIVES）との対応を確かめたときに足した
// 解説動画に要る項目: 画面の図・表・文字と読み上げが別の物として作られる形式なので、両者の食い違いを
// 整合性・分かりやすさの項目として見る。テンポは「発見の積み上がり」が段の順だけを見ていて、1段の詰め込みと
// 切り替えの間を見る項目が無かった。漫画の吹き出しのような別形式の項目は持ち込まない。
// 下限は方針値: 根拠の範囲は誤った主張が致命傷になるので 85、画面と読み上げの食い違いと冒頭の約束の回収は 80、
// ほかは足切りとして 60〜70。重みは合計 100（項目を足したので既存の項目の重みを配り直した）。
const EXPLAINER_SCRIPT_RUBRIC = Object.freeze([
  {
    id: "question-clarity",
    label: "問いの明確さ",
    weight: 10,
    minimumScore: 70,
    description: "動画が答える問いが冒頭で1つに定まり、見終えたときに何が分かるかが最初に伝わる。途中で問いがすり替わっていない",
  },
  {
    id: "first-view-comprehension",
    label: "初見での理解",
    weight: 15,
    minimumScore: 70,
    description: "前提の知識が無い人が1回聞いて追える。用語は初めて出たところで説明し、1文に1つの情報で、指示語の指す先が明確",
  },
  {
    id: "evidence-scope",
    label: "根拠が支える範囲",
    weight: 20,
    minimumScore: 85,
    description: "どの主張も、示した根拠が支える範囲を越えない。数字には出所があり、推測・仮説と確かめた事実を言い分けている。一例からの一般化や、確かめていないことを確かめたように言う文が無い",
  },
  {
    id: "discovery-progression",
    label: "発見の積み上がり",
    weight: 10,
    minimumScore: 60,
    description: "各段が前の段で分かったことを使って新しい発見を1つ足している。同じ説明の繰り返しや、前提を飛ばした段の飛躍が無い",
  },
  {
    id: "opening-promise-payoff",
    label: "冒頭の約束の回収",
    weight: 10,
    minimumScore: 80,
    description: "冒頭で約束した答え・見せ場が本編で回収されている。回収されない約束や、本編に無い内容を匂わせる冒頭が無い",
  },
  {
    id: "visual-narration-alignment",
    label: "図解と説明の対応",
    weight: 15,
    minimumScore: 80,
    description: "画面に出す図・表・文字（台本の図解の指示）が、その時に読み上げる説明と同じことを指している。画面の数字・用語と読み上げが食い違わず（表示と読みを分けるなら読みを指定している）、説明より先に図が答えを見せる・説明に無いことを図だけで言う箇所が無い。図解の指示の無い台本では、図無しで説明を追えるかで見る",
  },
  {
    id: "pacing",
    label: "テンポ",
    weight: 10,
    minimumScore: 60,
    description: "1つの段に詰め込む情報が1回聞いて追える量で、段や章が切り替わるところで間を取れる並びになっている。同じ説明の言い直しで間延びする箇所や、図と説明が追いつかないほど詰め込んだ箇所が無い",
  },
  {
    id: "reading-clarity",
    label: "読み",
    weight: 10,
    minimumScore: 70,
    description: "専門用語・人名・読みが割れる語の読みが一意か、読みを指定している。同音で意味が変わる語を避けている",
  },
]);

// 上限の既定（方針値）。ナレーション物語の動画の品質ループ（目標 92・3回・72時間）との違い:
// - 目標 90・回数 5: 台本は3段（初稿・手直し・照合）を毎回それぞれ1回として採点するので、
//   直しの回を2つ足した数を上限にする。目標は動画より 2 点低い（台本の後に画・声の工程がある）
// - 時間 7 日: 外部モデルの利用枠が切れると戻るまで数日かかることがある
// - 停滞 2: 手直しの回は語り口を上げる代わりに他の項目が少し下がることがあり、1回の停滞で
//   止めると3段の途中で止まる
export const SCRIPT_QUALITY_LIMIT_DEFAULTS = Object.freeze({
  targetScore: 90,
  maximumReviewRounds: 5,
  maximumElapsedMs: 7 * 24 * 60 * 60 * 1_000,
  maximumCost: 100,
  minimumImprovement: 1,
  maximumStagnantRounds: 2,
});

const LIMIT_FIELDS = Object.freeze({
  targetScore: { key: "targetScore", minimum: 80, maximum: 100, integer: false },
  maximumReviewRounds: { key: "maximumReviewRounds", minimum: 1, maximum: 10, integer: true },
  maximumElapsedMinutes: { key: "maximumElapsedMs", minimum: 1, maximum: 14 * 24 * 60, integer: false, scale: 60_000 },
  maximumCostUnits: { key: "maximumCost", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, integer: false },
  minimumImprovementPoints: { key: "minimumImprovement", minimum: 0, maximum: 100, integer: false },
  maximumStagnantRounds: { key: "maximumStagnantRounds", minimum: 1, maximum: 5, integer: true },
});

/**
 * ジャンルに共通の観点。どのジャンルの評価項目も、この5つの観点のどれかに対応が付く（対応は各ジャンルの
 * perspectives。契約の digest には入れない。採点は評価項目の id で行い、観点は項目の対応を確かめるための表）。
 * 特定の評価者・点数・反復採点を決めるものではない。
 */
export const SCRIPT_QUALITY_COMMON_PERSPECTIVES = Object.freeze([
  Object.freeze({ id: "interest", label: "面白さ" }),
  Object.freeze({ id: "opening", label: "導入" }),
  Object.freeze({ id: "clarity", label: "分かりやすさ" }),
  Object.freeze({ id: "tempo", label: "テンポ" }),
  Object.freeze({ id: "consistency", label: "内容の整合性" }),
]);

function perspectiveMap(map) {
  return Object.freeze(Object.fromEntries(Object.entries(map).map(([key, ids]) => [key, Object.freeze([...ids])])));
}

/**
 * ジャンルごとの定義。ジャンルが決めるのは評価項目・下限・機械ゲート・上限だけ。
 * harnessId は、そのジャンルの署名済み Channel Pack を検証するときに照らすハーネス。解説動画は null のまま
 * （台本の品質ループを作ったときにはハーネスが無かった。harnessId は台本の契約の digest に入るので、後から
 * explainer-video を書くと、走っている解説動画の台本のループが別の契約になって止まる）。その Pack の
 * script-quality.json には genre の明記を求める。学習の宛先は lib/harnessLearningTargets.mjs の SCRIPT_LEARNING_ROUTES。
 */
export const SCRIPT_QUALITY_GENRES = Object.freeze({
  "narrated-story": Object.freeze({
    id: "narrated-story",
    harnessId: "narrated-story-video",
    rubric: NARRATED_STORY_SCRIPT_RUBRIC,
    limits: SCRIPT_QUALITY_LIMIT_DEFAULTS,
    machineGates: Object.freeze(Object.keys(SCRIPT_MACHINE_GATES)),
    // 導入はチャンネルが宣言した拍（最初の拍）で見る。感想パートの差し替え印はこのジャンルだけの安全の項目。
    perspectives: perspectiveMap({
      interest: ["beat-structure"],
      opening: ["beat-structure"],
      clarity: ["narration-voice", "reading-clarity"],
      tempo: ["duration-fit", "narration-voice"],
      consistency: ["meaning-preservation"],
    }),
    genreSpecific: Object.freeze(["review-first-person-marker"]),
  }),
  manga: Object.freeze({
    id: "manga",
    harnessId: "koya-manga-video",
    rubric: MANGA_SCRIPT_RUBRIC,
    limits: SCRIPT_QUALITY_LIMIT_DEFAULTS,
    machineGates: Object.freeze(Object.keys(SCRIPT_MACHINE_GATES)),
    // 漫画は原作の台本を画にするので、面白さと導入は原文の保持（原作の流れと感情の曲線を省かない）と
    // 場面の立ち上げ（場面冒頭の地理）で見る。吹き出しの収まりはテンポの側に数える。
    perspectives: perspectiveMap({
      interest: ["source-fidelity", "beat-pacing"],
      opening: ["panel-premise"],
      clarity: ["speaker-attribution", "panel-premise", "reading-clarity"],
      tempo: ["beat-pacing", "bubble-fit"],
      consistency: ["source-fidelity", "speaker-attribution"],
    }),
    genreSpecific: Object.freeze([]),
  }),
  explainer: Object.freeze({
    id: "explainer",
    harnessId: null,
    rubric: EXPLAINER_SCRIPT_RUBRIC,
    limits: SCRIPT_QUALITY_LIMIT_DEFAULTS,
    machineGates: Object.freeze(Object.keys(SCRIPT_MACHINE_GATES)),
    perspectives: perspectiveMap({
      interest: ["discovery-progression", "opening-promise-payoff"],
      opening: ["question-clarity", "opening-promise-payoff"],
      clarity: ["first-view-comprehension", "reading-clarity", "visual-narration-alignment"],
      tempo: ["pacing", "discovery-progression"],
      consistency: ["evidence-scope", "visual-narration-alignment"],
    }),
    genreSpecific: Object.freeze([]),
  }),
});

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

export function scriptQualityGenre(genre = "narrated-story") {
  const spec = SCRIPT_QUALITY_GENRES[String(genre || "")];
  if (!spec) throw new Error(`未知の台本ジャンル: ${genre}（${Object.keys(SCRIPT_QUALITY_GENRES).join(" / ")}）`);
  return spec;
}

/**
 * ジャンルの評価項目と共通の観点の対応表。どの観点にも項目が1つ以上あり、どの項目もどれかの観点か、
 * そのジャンルだけの項目（genreSpecific）に入っているかを issues で返す（試験と contract の表示が読む）。
 */
export function scriptQualityPerspectiveCoverage(genre = "narrated-story") {
  const spec = scriptQualityGenre(genre);
  const ids = spec.rubric.map((row) => row.id);
  const issues = [];
  const perspectives = SCRIPT_QUALITY_COMMON_PERSPECTIVES.map(({ id, label }) => {
    const items = [...(spec.perspectives?.[id] || [])];
    if (items.length === 0) issues.push(`perspective-uncovered:${id}`);
    for (const item of items) if (!ids.includes(item)) issues.push(`perspective-unknown-item:${id}:${item}`);
    return { id, label, items };
  });
  for (const key of Object.keys(spec.perspectives || {})) {
    if (!SCRIPT_QUALITY_COMMON_PERSPECTIVES.some((row) => row.id === key)) issues.push(`perspective-unknown:${key}`);
  }
  const mapped = new Set(perspectives.flatMap((row) => row.items));
  const genreSpecific = [...(spec.genreSpecific || [])];
  for (const id of ids) if (!mapped.has(id) && !genreSpecific.includes(id)) issues.push(`rubric-item-unmapped:${id}`);
  return { genre: spec.id, perspectives, genreSpecific, issues };
}

function boundedNumber(value, minimum, maximum) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

/**
 * Channel Pack の script-quality.json を検査する。直せない値は blocker にする
 * （黙って既定へ戻すと、Pack の作者は効いているつもりになる）。
 *
 * 形:
 * {
 *   "version": "buzzassist-script-quality-channel-v1",
 *   "genre": "narrated-story",
 *   "criteria": [{ "id", "label", "weight", "minimumScore", "description" }],   // 足す項目
 *   "floors": { "<ジャンルの項目 id>": 下限 },                                   // 上げるだけ
 *   "weights": { "<ジャンルの項目 id>": 重み },
 *   "limits": { "targetScore", "maximumReviewRounds", "maximumElapsedMinutes", ... },
 *   "acceptance": {                                                             // 任意。無ければ今までどおり
 *     "mode": "average" | "each-evaluator",
 *     "evaluators": ["<評価者 id>", ...],
 *     "minimumEvaluatorScore": 88                                               // each-evaluator だけ。無ければ目標点
 *   }
 * }
 *
 * acceptance を書いたチャンネルだけ、1つの版を「宣言した評価者の全員」で採点する（評価の組）。
 * average は評価者の平均で、each-evaluator は評価者それぞれの総合点と項目の下限で合否を決める。
 * 書かなければ組は1人・平均で、今までの1件ずつの記録と同じに動く。既定をどのチャンネルにも強制しない。
 */
export function normalizeScriptChannelConfig(source, genreSpec = scriptQualityGenre()) {
  const empty = { criteria: [], floors: {}, weights: {}, limits: {}, acceptance: null, blockers: [] };
  if (source === undefined || source === null) return empty;
  if (!plainObject(source)) return { ...empty, blockers: ["script-quality"] };
  const blockers = [];
  const allowed = new Set(["version", "genre", "criteria", "floors", "weights", "limits", "acceptance"]);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) blockers.push(key === "rubric" ? "script-quality.rubric-not-replaceable" : `script-quality.${key}-unknown`);
  }
  if (source.version !== SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION) blockers.push("script-quality.version");
  if (source.genre !== undefined && source.genre !== genreSpec.id) blockers.push("script-quality.genre-mismatch");
  // ハーネスの無いジャンルは、Pack の検証でハーネスを照らせない。別のジャンルの設定を取り違えないよう、明記を求める。
  if (source.genre === undefined && !genreSpec.harnessId) blockers.push("script-quality.genre-required");
  const genreIds = new Set(genreSpec.rubric.map((row) => row.id));
  const genreFloors = new Map(genreSpec.rubric.map((row) => [row.id, row.minimumScore]));

  const criteria = [];
  if (source.criteria !== undefined) {
    if (!Array.isArray(source.criteria) || source.criteria.length > 12) blockers.push("script-quality.criteria");
    else {
      const seen = new Set();
      for (const [index, row] of source.criteria.entries()) {
        const id = nonEmpty(row?.id);
        const field = `script-quality.criteria[${index}]`;
        if (!plainObject(row) || !CRITERION_ID.test(id) || id.length > 48) { blockers.push(`${field}.id`); continue; }
        if (genreIds.has(id)) { blockers.push(`script-quality.criteria.${id}-collides-with-genre`); continue; }
        if (seen.has(id)) { blockers.push(`script-quality.criteria.${id}-duplicated`); continue; }
        seen.add(id);
        const label = nonEmpty(row.label);
        const description = nonEmpty(row.description);
        if (!label || Array.from(label).length > 60) blockers.push(`script-quality.criteria.${id}.label`);
        if (Array.from(description).length < 4 || Array.from(description).length > 300) blockers.push(`script-quality.criteria.${id}.description`);
        if (!boundedNumber(row.weight, 1, 100)) blockers.push(`script-quality.criteria.${id}.weight`);
        if (!boundedNumber(row.minimumScore, 0, 100)) blockers.push(`script-quality.criteria.${id}.minimumScore`);
        criteria.push({ id, label, weight: row.weight, minimumScore: row.minimumScore, description });
      }
    }
  }

  const floors = {};
  if (source.floors !== undefined) {
    if (!plainObject(source.floors)) blockers.push("script-quality.floors");
    else {
      for (const [id, value] of Object.entries(source.floors)) {
        if (!genreIds.has(id)) { blockers.push(`script-quality.floors.${id}-unknown`); continue; }
        if (!boundedNumber(value, 0, 100)) { blockers.push(`script-quality.floors.${id}`); continue; }
        // ジャンルの足切りを番組ごとに緩められると、この保証の意味が無くなる。
        if (value < genreFloors.get(id)) { blockers.push(`script-quality.floors.${id}-cannot-lower`); continue; }
        floors[id] = value;
      }
    }
  }

  const weights = {};
  if (source.weights !== undefined) {
    if (!plainObject(source.weights)) blockers.push("script-quality.weights");
    else {
      for (const [id, value] of Object.entries(source.weights)) {
        if (!genreIds.has(id)) { blockers.push(`script-quality.weights.${id}-unknown`); continue; }
        if (!boundedNumber(value, 1, 100)) { blockers.push(`script-quality.weights.${id}`); continue; }
        weights[id] = value;
      }
    }
  }

  const limits = {};
  if (source.limits !== undefined) {
    if (!plainObject(source.limits)) blockers.push("script-quality.limits");
    else {
      for (const [field, value] of Object.entries(source.limits)) {
        const spec = LIMIT_FIELDS[field];
        if (!spec) { blockers.push(`script-quality.limits.${field}-unknown`); continue; }
        if (!boundedNumber(value, spec.minimum, spec.maximum) || (spec.integer && !Number.isInteger(value))) {
          blockers.push(`script-quality.limits.${field}`);
          continue;
        }
        limits[spec.key] = spec.scale ? Math.round(value * spec.scale) : value;
      }
    }
  }
  const acceptance = source.acceptance === undefined ? null : normalizeAcceptanceConfig(source.acceptance, blockers);
  return { criteria, floors, weights, limits, acceptance, blockers };
}

function normalizeAcceptanceConfig(value, blockers) {
  if (!plainObject(value)) {
    blockers.push("script-quality.acceptance");
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!["mode", "evaluators", "minimumEvaluatorScore"].includes(key)) blockers.push(`script-quality.acceptance.${key}-unknown`);
  }
  const mode = value.mode === undefined ? "average" : value.mode;
  if (!QUALITY_ACCEPTANCE_MODES.includes(mode)) {
    blockers.push("script-quality.acceptance.mode");
    blockers.push("script-quality.acceptance");
    return null;
  }
  const evaluators = [];
  if (value.evaluators !== undefined) {
    if (!Array.isArray(value.evaluators) || value.evaluators.length > SCRIPT_PANEL_MAX_EVALUATORS) {
      blockers.push("script-quality.acceptance.evaluators");
    } else {
      for (const entry of value.evaluators) {
        const id = nonEmpty(entry);
        if (!EVALUATOR_ID.test(id) || id === SCRIPT_GENERATOR_ID) { blockers.push("script-quality.acceptance.evaluators.id"); continue; }
        if (evaluators.includes(id)) { blockers.push(`script-quality.acceptance.evaluators.${id}-duplicated`); continue; }
        evaluators.push(id);
      }
    }
  }
  if (mode === "each-evaluator" && evaluators.length === 0 && value.evaluators === undefined) {
    blockers.push("script-quality.acceptance.evaluators-required");
    return null;
  }
  const acceptance = { mode, evaluators };
  if (value.minimumEvaluatorScore !== undefined) {
    // 評価者ごとの総合点の下限。目標点と同じ範囲（80〜100）でだけ受ける。
    if (mode !== "each-evaluator") blockers.push("script-quality.acceptance.minimumEvaluatorScore-each-evaluator-only");
    else if (!boundedNumber(value.minimumEvaluatorScore, LIMIT_FIELDS.targetScore.minimum, LIMIT_FIELDS.targetScore.maximum)) {
      blockers.push("script-quality.acceptance.minimumEvaluatorScore");
    } else acceptance.minimumEvaluatorScore = value.minimumEvaluatorScore;
    if (blockers.some((row) => row.startsWith("script-quality.acceptance.minimumEvaluatorScore"))) return null;
  }
  try {
    normalizeQualityAcceptance(acceptance);
  } catch {
    blockers.push("script-quality.acceptance");
  }
  return acceptance;
}

/** 1つの版を採点する評価者の宣言（無ければ1人で、評価者を名指ししない）。 */
function panelEvaluators(contract) {
  return normalizeQualityAcceptance(contract?.acceptance).evaluators;
}

function panelSize(contract) {
  return Math.max(1, panelEvaluators(contract).length);
}

/**
 * 台本の品質契約。走行中は変えない（digest が変われば同じループを続けない）。
 * channelSource は契約に入る（どの Pack・どの設定で採点したかが digest に残る）。パスは入れない。
 */
export function createScriptQualityContract({ genre = "narrated-story", channelConfig = null, channelSource = { kind: "none" } } = {}) {
  const spec = scriptQualityGenre(genre);
  const channel = normalizeScriptChannelConfig(channelConfig, spec);
  if (channel.blockers.length > 0) return { contract: null, blockers: channel.blockers };
  const rows = [
    ...spec.rubric.map((row) => ({
      ...row,
      weight: channel.weights[row.id] ?? row.weight,
      minimumScore: channel.floors[row.id] ?? row.minimumScore,
      origin: "genre",
    })),
    ...channel.criteria.map((row) => ({ ...row, origin: "channel" })),
  ];
  const rubric = normalizeQualityRubric(rows).map((row, index) => ({ ...row, origin: rows[index].origin }));
  const body = {
    version: SCRIPT_QUALITY_CONTRACT_VERSION,
    genre: spec.id,
    harnessId: spec.harnessId,
    universalRules: {
      generatorEvaluatorSeparation: true,
      producerContextsExcludedFromEvaluation: true,
      distinctEvaluatorContextRequired: true,
      reviewBoundToScriptSha256: true,
      derivedVersionReviewBoundToBaseSha256: true,
      deterministicGatesBeforeJudgment: true,
      completeRubricRequired: true,
      rubricFloorsRequired: true,
      failureFingerprintRequired: true,
      revisionDeltaRequired: true,
      externalCallsRecordedWithoutBodies: true,
      channelMayOnlyTightenGenreFloors: true,
      immutableDuringRun: true,
    },
    machineGates: [...spec.machineGates],
    rubric,
    limits: { ...spec.limits, ...channel.limits },
    channelSource: normalizeChannelSource(channelSource),
    // 受け入れ方は宣言したチャンネルの契約にだけ入れる（宣言の無い契約の digest は今までと同じ値）。
    ...(channel.acceptance ? { acceptance: channel.acceptance } : {}),
  };
  return { contract: deepFreeze({ ...body, digest: sha256(canonicalJson(body)) }), blockers: [] };
}

function normalizeChannelSource(source = {}) {
  const kind = nonEmpty(source?.kind) || "none";
  if (kind === "signed-channel-pack") {
    return {
      kind,
      packId: nonEmpty(source.packId),
      packVersion: nonEmpty(source.packVersion),
      payloadSha256: nonEmpty(source.payloadSha256),
      configSha256: SHA256.test(String(source.configSha256 || "")) ? source.configSha256 : null,
    };
  }
  if (kind === "unsigned-file") return { kind, configSha256: nonEmpty(source.configSha256) };
  return { kind: "none" };
}

/**
 * チャンネル固有の評価項目の読み込み元を解決する。
 * - channelPack: 署名済み Channel Pack（envelope）。受領側が信頼した公開鍵
 *   （BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY）で検証し、payload/script-quality.json を読む
 * - channelConfig: 署名の無い設定ファイル（手元の試行用）。契約に unsigned-file と刻まれる
 */
export async function loadScriptChannelConfig({
  channelPack = "",
  channelConfig = "",
  env = process.env,
  expectedHarnessId = "",
  verifyEnvelope = verifyChannelPackEnvelope,
  trustedKey = trustedChannelPackKeyFromEnvironment,
} = {}) {
  if (nonEmpty(channelPack) && nonEmpty(channelConfig)) {
    throw new Error("--channel-pack と --channel-config はどちらか1つにしてください。");
  }
  if (nonEmpty(channelPack)) {
    const bundleDir = resolve(channelPack);
    const verified = await verifyEnvelope({ bundleDir, ...(await trustedKey(env)), expectedHarnessId });
    const configPath = join(verified.payloadDir, SCRIPT_QUALITY_CHANNEL_CONFIG_FILE);
    let bytes = null;
    try {
      bytes = await readFile(configPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return {
      config: bytes ? JSON.parse(bytes.toString("utf8")) : null,
      source: {
        kind: "signed-channel-pack",
        packId: verified.id,
        packVersion: verified.packVersion,
        payloadSha256: verified.payloadSha256,
        configSha256: bytes ? sha256(bytes) : null,
      },
      spec: { kind: "signed-channel-pack", bundleDir },
    };
  }
  if (nonEmpty(channelConfig)) {
    const file = resolve(channelConfig);
    const bytes = await readFile(file);
    return {
      config: JSON.parse(bytes.toString("utf8")),
      source: { kind: "unsigned-file", configSha256: sha256(bytes) },
      spec: { kind: "unsigned-file", file },
    };
  }
  return { config: null, source: { kind: "none" }, spec: { kind: "none" } };
}

function channelArgsFromSpec(spec = {}) {
  if (spec.kind === "signed-channel-pack") return { channelPack: spec.bundleDir };
  if (spec.kind === "unsigned-file") return { channelConfig: spec.file };
  return {};
}

export function scriptQualityPaths(workDir) {
  if (!nonEmpty(workDir)) throw new Error("--work-dir に台本の作業フォルダが要ります。");
  const root = resolve(workDir);
  const dir = join(root, SCRIPT_QUALITY_DIR);
  return {
    workDir: root,
    dir,
    statePath: join(dir, SCRIPT_QUALITY_STATE_FILE),
    revisionDeltaPath: join(dir, SCRIPT_REVISION_DELTA_FILE),
    humanAcceptancePath: join(dir, SCRIPT_HUMAN_ACCEPTANCE_FILE),
    externalCallLedgerPath: externalCallLedgerPath({ workDir: root }),
  };
}

/** 作業フォルダの中のファイルだけを受け、フォルダからの相対パス（/ 区切り）を返す。 */
function insideWorkDir(workDir, file, label) {
  if (!nonEmpty(file)) throw new Error(`${label} が要ります。`);
  const full = resolve(workDir, file);
  const rel = relative(workDir, full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} は台本の作業フォルダの中に置いてください（状態は作業フォルダからの相対パスで残します）。`);
  }
  return { full, rel: rel.split(sep).join("/") };
}

async function inspectScript(path) {
  const bytes = await readFile(path);
  let text = "";
  let decoded = true;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    decoded = false;
  }
  const nonEmptyLines = text.split(/\r?\n/u).filter((line) => line.trim()).length;
  return { sha256: sha256(bytes), bytes: bytes.length, nonEmptyLines, readable: decoded && nonEmptyLines > 0 };
}

function lastOf(list) {
  return Array.isArray(list) && list.length > 0 ? list[list.length - 1] : null;
}

/** 評価者へ渡す採点表（契約の写し）。 */
export function scriptQualityReviewSheet(contract) {
  return {
    contractVersion: contract.version,
    contractDigest: contract.digest,
    genre: contract.genre,
    targetScore: contract.limits.targetScore,
    rubric: contract.rubric.map((row) => ({
      id: row.id,
      label: row.label,
      weight: row.weight,
      minimumScore: row.minimumScore,
      origin: row.origin,
      description: row.description,
    })),
    machineGates: contract.machineGates.map((id) => ({ id, description: SCRIPT_MACHINE_GATES[id] })),
    // ジャンルに共通の観点（面白さ・導入・分かりやすさ・テンポ・内容の整合性）と、それを見る評価項目の対応。
    commonPerspectives: SCRIPT_QUALITY_GENRES[contract.genre]
      ? scriptQualityPerspectiveCoverage(contract.genre).perspectives
      : [],
  };
}

function issuesFromState(state) {
  if (!state || state.status === "passed") return [];
  const round = lastOf(state.rounds);
  const target = state.script?.contract?.limits?.targetScore;
  const issues = [];
  if (round) {
    issues.push(`script-quality-round-${round.index}-not-passed:${round.failureFingerprint}`);
    for (const id of round.floorFailures || []) issues.push(`script-quality-floor-failed:${id}`);
    if (Number.isFinite(target) && round.score < target) issues.push(`script-quality-below-target:${round.score}<${target}`);
    for (const id of round.failedGateIds || []) issues.push(`script-quality-machine-gate-failed:${id}`);
    for (const failure of round.acceptance?.failures || []) issues.push(`script-quality-acceptance-failed:${failure}`);
    if ((round.unresolvedFindingIds || []).length > 0) issues.push(`script-quality-unresolved-findings:${round.unresolvedFindingIds.join(",")}`);
  }
  if (state.status === "active") {
    const panel = state.script?.pendingPanel;
    if (panel) issues.push(`script-quality-panel-waiting:${panelMissing(panel).join(",")}`);
    else if (round) issues.push("script-quality-revision-and-fresh-review-required");
    else issues.push("script-quality-first-review-required");
  } else issues.push(`script-quality-stopped:${state.status}:${state.stopReason || "unknown"}`);
  return issues;
}

/** 組がまだ待っている評価者（宣言した順）。 */
function panelMissing(panel) {
  const received = new Set((panel?.reviews || []).map((row) => row.evaluatorId));
  return (panel?.declaredEvaluators || []).filter((id) => !received.has(id));
}

function panelSummary(panel) {
  if (!panel) return null;
  return {
    versionLabel: panel.versionLabel,
    stage: panel.stage,
    scriptSha256: panel.scriptSha256,
    declaredEvaluators: [...(panel.declaredEvaluators || [])],
    received: (panel.reviews || []).map((row) => row.evaluatorId),
    missing: panelMissing(panel),
  };
}

function nextStepDetail(state, paths) {
  const round = lastOf(state?.rounds);
  if (!state) return "先に start でループを始める";
  if (state.status === "passed") return "合格した。台本をこの後で変えたら、その合格は今の台本を保証しない";
  if (state.status !== "active") {
    const cumulative = scriptQualityCumulative(state);
    return `品質ループは ${state.status}（${state.stopReason}）で止まった。続けるかどうかは人が決める`
      + (cumulative.reached.length > 0
        ? `。この作業フォルダの累計（${cumulative.rounds} 回・費用 ${cumulative.cost}${cumulative.unpricedCount ? `＋不明 ${cumulative.unpricedCount} 件` : ""}）が上限に届いているので、`
          + "始め直す前に、その人が自分の端末から reset-cumulative --reason \"...\" --reviewer <名前> --human-verified で累計を戻す"
        : "");
  }
  const panel = state.script?.pendingPanel;
  if (panel) {
    return `版 ${panel.versionLabel} の評価の組は ${panelMissing(panel).join(", ")} の採点を待っている。`
      + "record --review <採点ファイル> で組に入れる（同じ台本 SHA を、組の中でも前の回とも別の評価文脈で採点する）。全員そろった時点で1回として閉じる";
  }
  if (!round) return "最初の版を、作った文脈とは別の評価文脈で採点して record する";
  const pendingFindings = pendingFindingIds(state);
  const dispositionsStep = pendingFindings.length > 0
    ? `前の回の指摘（${pendingFindings.join(", ")}）ごとに採用／不採用と理由を、--finding-dispositions <file> か ${paths.revisionDeltaPath} の `
      + "findingDispositions に [{ \"findingId\", \"decision\": \"adopted|rejected\", \"reason\" }] で書く（書かなければ次の版を記録しない）。"
    : "";
  return `次の版には、前回の失敗（${round.failureFingerprint}）をどう直したかが要る。--revision-delta "直した内容" を付けるか、`
    + `${paths.revisionDeltaPath} に { "previousFailureFingerprint": "${round.failureFingerprint}", "revisionDelta": "直した内容" } を書く。`
    + dispositionsStep
    + "採点は、前の回で使っていない評価文脈で行う";
}

/** 次の版を記録するときに採否が要る、前の回の指摘の id（続いているループで、組が開いていないときだけ）。 */
function pendingFindingIds(state) {
  if (state?.status !== "active" || state?.script?.pendingPanel) return [];
  return (lastOf(state?.script?.versions)?.findingRecords || []).map((row) => row.id);
}

function checkFor(state, extra = {}) {
  const round = lastOf(state?.rounds);
  const version = lastOf(state?.script?.versions);
  return {
    pass: state?.status === "passed",
    status: state?.status || "not-started",
    stopReason: state?.stopReason || "",
    rounds: state?.rounds?.length || 0,
    score: round ? round.score : null,
    targetScore: state?.script?.contract?.limits?.targetScore ?? null,
    floorFailures: round ? [...(round.floorFailures || [])] : [],
    failedGateIds: round ? [...(round.failedGateIds || [])] : [],
    failureFingerprint: round?.failureFingerprint || "",
    versionLabel: version?.label || "",
    stage: version?.stage || "",
    scriptSha256: version?.scriptSha256 || "",
    contractDigest: state?.contractDigest || "",
    ...(state?.script?.pendingPanel ? { pendingPanel: panelSummary(state.script.pendingPanel) } : {}),
    ...(state?.script ? { cumulative: scriptQualityCumulative(state) } : {}),
    ...(pendingFindingIds(state).length > 0 ? { pendingFindingIds: pendingFindingIds(state) } : {}),
    ...(round?.unresolvedFindingIds?.length ? { unresolvedFindingIds: [...round.unresolvedFindingIds] } : {}),
    ...extra,
  };
}

function waiting(state, issues, detail) {
  return { recorded: false, state, issues, detail, check: checkFor(state) };
}

const ZERO_TOTALS = Object.freeze({ loops: 0, rounds: 0, cost: 0, elapsedMs: 0, unpricedCount: 0 });

function addTotals(left, right) {
  return {
    loops: left.loops + right.loops,
    rounds: left.rounds + right.rounds,
    cost: Number((left.cost + right.cost).toFixed(6)),
    elapsedMs: left.elapsedMs + right.elapsedMs,
    unpricedCount: left.unpricedCount + right.unpricedCount,
  };
}

/** このループだけの回数・費用・時間と、費用の分からなかった呼び出しの件数。 */
function ownLoopTotals(state) {
  const rounds = Array.isArray(state?.rounds) ? state.rounds : [];
  return {
    loops: 1,
    rounds: rounds.length,
    cost: Math.max(0, Number(state?.totalCost) || 0),
    elapsedMs: Math.max(0, Number(state?.elapsedMs) || 0),
    unpricedCount: rounds.reduce((sum, round) => sum + Math.max(0, Number(round?.costAccounting?.unpricedCount) || 0), 0),
  };
}

/**
 * 前のループから持ち越した分。持ち越しの記録（carriedOver）の無い古い状態は、history に残した
 * ループを足し上げる（始め直しで上限を消せないようにするため、古い状態でも数える）。
 */
function carriedTotals(state) {
  const carried = normalizeCarriedOver(state?.carriedOver);
  if (carried) return carried;
  return (state?.script?.history || []).reduce((sum, entry) => addTotals(sum, ownLoopTotals(entry?.state)), { ...ZERO_TOTALS });
}

function limitsReached(total, limits = {}) {
  const reached = [];
  if (Number.isFinite(limits.maximumCost) && total.cost >= limits.maximumCost) reached.push("cost-limit");
  if (Number.isFinite(limits.maximumElapsedMs) && total.elapsedMs >= limits.maximumElapsedMs) reached.push("time-limit");
  if (Number.isFinite(limits.maximumReviewRounds) && total.rounds >= limits.maximumReviewRounds) reached.push("round-limit");
  return reached;
}

/**
 * この作業フォルダ（台本の回）の累計: 前のループから持ち越した分と、このループの分。
 * 人が累計を戻した後（reset-cumulative）は、戻した時点のループの分を数えない。
 * 費用の分からなかった呼び出しは 0 円として足さず、unpricedCount に残す（costIncomplete が true）。
 */
export function scriptQualityCumulative(state, contract = state?.script?.contract) {
  const carried = carriedTotals(state);
  const total = state?.script?.cumulativeExcludesCurrentLoop === true ? carried : addTotals(carried, ownLoopTotals(state));
  const limits = contract?.limits || {};
  return {
    ...total,
    costIncomplete: total.unpricedCount > 0,
    limits: {
      maximumReviewRounds: limits.maximumReviewRounds ?? null,
      maximumCost: limits.maximumCost ?? null,
      maximumElapsedMs: limits.maximumElapsedMs ?? null,
    },
    reached: limitsReached(total, limits),
  };
}

function totalsOnly(cumulative) {
  const { loops, rounds, cost, elapsedMs, unpricedCount } = cumulative;
  return { loops, rounds, cost, elapsedMs, unpricedCount };
}

/**
 * ループを始める。既に状態があれば始め直さない（restart は、止まったループだけ。続いている
 * ループを始め直せると、回数・停滞の上限を消せてしまう）。始め直しても前の状態は history に残す。
 */
export async function startScriptQualityLoop({
  workDir,
  genre = "narrated-story",
  generatorContextId,
  generatorHost = "",
  channelPack = "",
  channelConfig = "",
  restart = false,
  restartReason = "",
  env = process.env,
  now = () => new Date().toISOString(),
  loadChannel = loadScriptChannelConfig,
} = {}) {
  const paths = scriptQualityPaths(workDir);
  const spec = scriptQualityGenre(genre);
  const context = nonEmpty(generatorContextId);
  if (!CONTEXT_ID.test(context)) {
    throw new Error("--generator-context に初稿を書いた会話・タスクの ID が要ります（英数字と . _ : @ -）。この文脈は採点できない。");
  }
  const channel = await loadChannel({ channelPack, channelConfig, env, expectedHarnessId: spec.harnessId });
  const { contract, blockers } = createScriptQualityContract({ genre: spec.id, channelConfig: channel.config, channelSource: channel.source });
  if (!contract) {
    return {
      started: false,
      state: null,
      issues: blockers.map((blocker) => `script-quality-channel-config-invalid:${blocker}`),
      detail: "Channel Pack の script-quality.json に直せない値がある。黙って既定へ戻さないので、Pack を直してから始める",
    };
  }
  return withCanvasFileLock(paths.statePath, async () => {
    const existing = await readJsonIfExists(paths.statePath, null);
    let history = [];
    let carriedOver = null;
    let cumulativeReached = [];
    let costedKeys = [];
    let cumulativeResets = [];
    if (existing) {
      if (!restart) {
        return { started: false, state: existing, issues: ["script-quality-loop-already-started"], detail: "この作業フォルダのループは始まっている。record で回を足すか、止まった後に --restart で始め直す" };
      }
      if (existing.status === "active") {
        return {
          started: false,
          state: existing,
          issues: ["script-quality-loop-active-cannot-restart"],
          detail: "続いているループは始め直せない（回数と停滞の上限を消せてしまう）。合格・人待ち・上限で止まってから始め直す",
        };
      }
      const reason = sanitizeEvidence(restartReason, 500);
      if (Array.from(reason).length < 4) throw new Error("--restart には --reason で始め直す理由が要ります（何が変わったか）。");
      // 始め直しても、同じ作業フォルダの回数・費用・時間は持ち越す（始め直しで上限を消せると、止まる条件の
      // 意味が無くなる）。累計が上限に届いていれば、新しいループは始めた時点で止まっている。戻すのは
      // reset-cumulative（理由と人の確認つき）だけ。
      carriedOver = existing.script?.cumulativeExcludesCurrentLoop === true
        ? carriedTotals(existing)
        : addTotals(carriedTotals(existing), ownLoopTotals(existing));
      cumulativeReached = limitsReached(carriedOver, contract.limits);
      costedKeys = [...new Set(existing.costedKeys || [])];
      cumulativeResets = [...(existing.script?.cumulativeResets || [])];
      const { script: previousScript, ...previousCore } = existing;
      history = [
        ...(previousScript?.history || []),
        {
          archivedAt: new Date(now()).toISOString(),
          reason,
          status: existing.status,
          stopReason: existing.stopReason || "",
          contractDigest: existing.contractDigest,
          state: { ...previousCore, script: { ...previousScript, history: [] } },
        },
      ];
    }
    const core = createQualityLoopState({
      contract,
      episodeId: `script-quality:${spec.id}`,
      generatorHost: nonEmpty(generatorHost),
      generatorId: SCRIPT_GENERATOR_ID,
      generatorContextId: context,
      startedAt: now(),
      ...(carriedOver ? { carriedOver } : {}),
    });
    const state = {
      ...core,
      // 前のループで数えた外部モデルの呼び出し。同じ呼び出しを新しいループで二重に数えない。
      ...(costedKeys.length > 0 ? { costedKeys } : {}),
      script: {
        version: SCRIPT_QUALITY_STATE_VERSION,
        genre: spec.id,
        contract,
        channelSource: contract.channelSource,
        channelSpec: channel.spec,
        versions: [],
        history,
        ...(cumulativeResets.length > 0 ? { cumulativeResets } : {}),
      },
    };
    if (cumulativeReached.length > 0) {
      // 中核（lib/qualityLoop.mjs）と同じ順・同じ状態名で止める: 費用・時間は budget-exhausted、回数は needs-human-approval。
      const stopReason = cumulativeReached[0];
      state.status = stopReason === "round-limit" ? "needs-human-approval" : "budget-exhausted";
      state.stopReason = stopReason;
      state.nextAction = "human-review";
      state.stoppedByCumulative = [...cumulativeReached];
    }
    await writeJsonAtomic(paths.statePath, state);
    if (cumulativeReached.length > 0) {
      return {
        started: true,
        state,
        issues: cumulativeReached.map((code) => `script-quality-cumulative-limit-reached:${code}`),
        detail: `始め直したが、この作業フォルダの累計（${carriedOver.loops} ループ・${carriedOver.rounds} 回・費用 ${carriedOver.cost}`
          + `${carriedOver.unpricedCount ? `＋不明 ${carriedOver.unpricedCount} 件` : ""}）が上限に届いているので、新しいループは止まっている。`
          + "続けるかは人が決める。続けるなら、その人が自分の端末から reset-cumulative --reason \"...\" --reviewer <名前> --human-verified で"
          + "累計を戻してから、もう一度 start --restart する",
      };
    }
    return { started: true, state, issues: [], detail: nextStepDetail(state, paths), sheet: scriptQualityReviewSheet(contract) };
  });
}

function validateReviewScores(review, contract) {
  const scores = review?.rubricScores;
  if (!plainObject(scores)) return ["rubricScores-missing"];
  const ids = contract.rubric.map((row) => row.id);
  const problems = [];
  for (const id of ids) {
    const value = scores[id];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) problems.push(`score-invalid:${id}`);
  }
  for (const id of Object.keys(scores)) if (!ids.includes(id)) problems.push(`score-unknown:${id}`);
  return problems;
}

/**
 * 1つの版の採点を記録する。組の評価者が1人（既定）なら、その採点で1回が閉じる（今までと同じ）。
 * Channel Pack が評価者を宣言していれば、採点は組に入り、宣言した評価者が全員そろった時点で1回として閉じる。
 * 例外は入力の形が壊れているときだけで、人の判断や直しが要る状態は issues で返す（recorded: false）。
 *
 * 組に入れないもの: 別の版（台本 SHA 違い）の採点・その版を作った文脈・前の回か組の中で使った評価文脈・
 * 宣言に無い評価者・同じ評価者の2件目・組の中の別の評価と同じ所見。
 * 組が開いている間の record は --review だけでよい（版・工程・台本は組を開いた記録のものを使う）。
 */
export async function recordScriptQualityRound({
  workDir,
  scriptPath = "",
  versionLabel = "",
  stage = "",
  reviewPath,
  producerContexts = [],
  externalCallIds = [],
  baseVersion = "",
  revisionDelta = "",
  blockingCondition = "",
  cost = null,
  findingDispositions = null,
  findingDispositionsPath = "",
  ledgerPath = "",
  env = process.env,
  now = () => new Date().toISOString(),
  loadChannel = loadScriptChannelConfig,
  captureLearning = null,
} = {}) {
  const paths = scriptQualityPaths(workDir);
  // 費用は書いたときだけ数える。書かなければ「分からない」で、外部モデルの呼び出しがあれば
  // 0円として足さずに不明の件数へ残す。
  const declaredCost = cost === null || cost === undefined || cost === "" ? null : Number(cost);
  if (declaredCost !== null && (!Number.isFinite(declaredCost) || declaredCost < 0)) throw new Error("--cost は 0 以上の数にしてください。");
  const stageName = nonEmpty(stage);
  if (stageName && !SCRIPT_STAGES.includes(stageName)) throw new Error(`--stage は ${SCRIPT_STAGES.join(" / ")} のどれかにしてください。`);
  const label = nonEmpty(versionLabel);
  if (label && !LABEL.test(label)) throw new Error("--version に版の名前（英数字と . _ -、64文字まで）が要ります。");
  const script = nonEmpty(scriptPath) ? insideWorkDir(paths.workDir, scriptPath, "--script") : null;
  const reviewFile = insideWorkDir(paths.workDir, reviewPath, "--review");
  const dispositionsFile = nonEmpty(findingDispositionsPath)
    ? insideWorkDir(paths.workDir, findingDispositionsPath, "--finding-dispositions")
    : null;
  const producers = [...new Set(producerContexts.map((value) => nonEmpty(value)).filter(Boolean))];
  for (const producer of producers) {
    if (!CONTEXT_ID.test(producer)) throw new Error("--producer-context は会話・タスクの ID（英数字と . _ : @ -）にしてください。");
  }
  const callIds = [...new Set(externalCallIds.map((value) => nonEmpty(value)).filter(Boolean))];
  for (const id of callIds) if (!isExternalCallId(id)) throw new Error(`--external-call の id の形が違います: ${id}`);
  const base = nonEmpty(baseVersion);
  if (base && !LABEL.test(base)) throw new Error("--base-version は版の名前にしてください。");

  return withCanvasFileLock(paths.statePath, async () => {
    const existing = await readJsonIfExists(paths.statePath, null);
    if (!existing?.script) return waiting(null, ["script-quality-loop-not-started"], "先に start でループを始める");
    const genreSpec = scriptQualityGenre(existing.script.genre);

    // 契約は走行中に変えない。Pack の設定が変わっていれば、同じループとして続けない。
    // 採点に使うのは状態ファイルに写した契約ではなく、いま作り直した契約（digest が一致したもの）。
    // 状態ファイルの写しを書き換えて評価項目や下限を緩める道を残さないため。
    let contract = null;
    try {
      const channel = await loadChannel({ ...channelArgsFromSpec(existing.script.channelSpec), env, expectedHarnessId: genreSpec.harnessId });
      contract = createScriptQualityContract({ genre: genreSpec.id, channelConfig: channel.config, channelSource: channel.source }).contract;
    } catch (error) {
      return waiting(existing, ["script-quality-channel-config-unavailable"], `始めたときの Channel Pack の設定を読み直せない: ${sanitizeEvidence(error?.message || String(error), 300)}`);
    }
    if (!contract || contract.digest !== existing.contractDigest) {
      return waiting(existing, ["script-quality-contract-changed"], "このループは別の契約（評価項目・下限・上限・Pack の設定）で始まっている。続けるか始め直すかは人が決める");
    }

    const scriptInfo = script ? await inspectScript(script.full) : null;
    const reviewBytes = await readFile(reviewFile.full);
    const reviewSha256 = sha256(reviewBytes);
    let review;
    try {
      review = JSON.parse(reviewBytes.toString("utf8"));
    } catch {
      return waiting(existing, ["script-quality-review-unreadable"], "採点ファイルが JSON として読めない");
    }
    const versions = existing.script.versions || [];
    const pending = existing.script.pendingPanel || null;

    // 同じ採点で既に記録した回・組に入れた採点なら、記録し直さずにその結果を返す（再実行・二重起動）。
    if (pending && (pending.reviews || []).some((row) => row.reviewSha256 === reviewSha256)) {
      return { recorded: false, alreadyRecorded: true, pending: true, state: existing, issues: issuesFromState(existing), detail: nextStepDetail(existing, paths), check: checkFor(existing) };
    }
    const previousVersion = lastOf(versions);
    if (previousVersion
      && versionReviewShas(previousVersion).includes(reviewSha256)
      && (!scriptInfo || previousVersion.scriptSha256 === scriptInfo.sha256)) {
      return { recorded: false, alreadyRecorded: true, state: existing, issues: issuesFromState(existing), detail: nextStepDetail(existing, paths), check: checkFor(existing) };
    }
    if (existing.status === "passed") {
      const changed = previousVersion && scriptInfo && previousVersion.scriptSha256 !== scriptInfo.sha256;
      return waiting(
        existing,
        ["script-quality-loop-already-passed", ...(changed ? ["script-quality-script-changed-after-pass"] : [])],
        "このループは合格で止まっている。台本を変えたなら、start --restart --reason \"何を変えたか\" で新しいループを始める",
      );
    }
    if (existing.status !== "active") return waiting(existing, issuesFromState(existing), nextStepDetail(existing, paths));

    const context = { existing, contract, paths, review, reviewSha256, reviewFile };
    if (pending) {
      return joinPanel({
        ...context, pending, scriptInfo, label, stageName, producers, callIds, blockingCondition, now, captureLearning,
      });
    }
    if (!stageName) throw new Error(`--stage は ${SCRIPT_STAGES.join(" / ")} のどれかにしてください。`);
    if (!label) throw new Error("--version に版の名前（英数字と . _ -、64文字まで）が要ります。");
    if (!script) throw new Error("--script が要ります。");

    if (versions.some((row) => row.label === label)) {
      return waiting(existing, [`script-quality-version-label-reused:${label}`], "版の名前は回ごとに変える（同じ名前の版は既に採点した）");
    }
    const sameText = versions.find((row) => row.scriptSha256 === scriptInfo.sha256);
    if (sameText) {
      return waiting(existing, [`script-quality-script-unchanged:${sameText.label}`], `この台本は版 ${sameText.label} と同じバイト列。直していない版を別の評価者に採点し直させない`);
    }
    if (review?.scriptSha256 !== scriptInfo.sha256) {
      return waiting(existing, ["script-quality-review-script-mismatch"], "採点ファイルの scriptSha256 が今の台本と違う。今の台本を採点し直す");
    }
    let baseRow = null;
    if (stageName !== "draft") {
      baseRow = base ? versions.find((row) => row.label === base) : previousVersion;
      if (base && !baseRow) return waiting(existing, [`script-quality-base-version-unknown:${base}`], "--base-version の版はこのループに無い");
      if (baseRow) {
        if (!SHA256.test(String(review?.baseScriptSha256 || ""))) {
          return waiting(existing, ["script-quality-review-base-missing"], `前の版（${baseRow.label}）と比べて採点したことを baseScriptSha256 に書く（意味の保持は前の版との比較で決まる）`);
        }
        if (review.baseScriptSha256 !== baseRow.scriptSha256) {
          return waiting(existing, ["script-quality-review-base-mismatch"], `採点ファイルの baseScriptSha256 が前の版（${baseRow.label}）と違う`);
        }
      }
    }

    // 外部モデルの呼び出しを台帳から引く。呼んだ文脈も「作った文脈」に数える。
    const ledger = nonEmpty(ledgerPath) ? resolve(ledgerPath) : paths.externalCallLedgerPath;
    const calls = callIds.length > 0 ? await findExternalCalls(ledger, callIds) : new Map();
    const producerContextsAll = [...new Set([existing.generatorContextId, ...producers, ...[...calls.values()].map((row) => row.callerSession)].filter(Boolean))];
    const panelDraft = {
      declaredEvaluators: panelEvaluators(contract),
      producerContextsAll,
      reviews: [],
    };
    const rejected = validatePanelReview({ ...context, panel: panelDraft });
    if (rejected) return rejected;

    // 機械ゲート（ファイルと台帳だけから決まる）。
    const missingCalls = callIds.filter((id) => !calls.has(id));
    const gates = {
      "script-readable": scriptInfo.readable,
      "external-call-recorded": missingCalls.length === 0 && (stageName !== "external-rewrite" || callIds.length > 0),
      "external-calls-complete": [...calls.values()].every((row) => row.status === "complete"),
    };
    const failedGateIds = contract.machineGates.filter((id) => gates[id] !== true).sort();

    let revision = {};
    let dispositions = [];
    if ((existing.rounds || []).length > 0) {
      const expected = lastOf(existing.rounds).failureFingerprint;
      const deltaFile = await readJsonIfExists(paths.revisionDeltaPath, null).catch(() => null);
      const delta = nonEmpty(deltaFile?.previousFailureFingerprint) === expected ? deltaFile : null;
      let text = sanitizeEvidence(revisionDelta);
      if (!text && delta) text = sanitizeEvidence(delta.revisionDelta);
      if (Array.from(text).length < 4) {
        return waiting(existing, [`script-quality-revision-delta-required:${expected}`], nextStepDetail(existing, paths));
      }
      revision = { previousFailureFingerprint: expected, revisionDelta: text };
      // 前の回の指摘ごとの採否（書かなければ次の版を記録しない）。引数 → ファイル → 修正内容のファイルの順に読む。
      let source = findingDispositions;
      if (!source && dispositionsFile) {
        try {
          source = JSON.parse(await readFile(dispositionsFile.full, "utf8"));
        } catch {
          return waiting(existing, ["script-quality-finding-dispositions-unreadable"], "--finding-dispositions のファイルが JSON として読めない");
        }
      }
      if (!source && delta) source = delta.findingDispositions;
      const previousFindings = lastOf(versions)?.findingRecords || [];
      const read = readFindingDispositions(source, previousFindings);
      if (read.issues.length > 0) return waiting(existing, read.issues, nextStepDetail(existing, paths));
      dispositions = read.rows;
    }

    const panel = {
      versionLabel: label,
      stage: stageName,
      scriptPath: script.rel,
      scriptSha256: scriptInfo.sha256,
      scriptBytes: scriptInfo.bytes,
      nonEmptyLines: scriptInfo.nonEmptyLines,
      ...(baseRow ? { baseVersion: baseRow.label, baseScriptSha256: baseRow.scriptSha256, baseScriptPath: baseRow.scriptPath } : {}),
      producerContexts: producers,
      producerContextsAll,
      externalCalls: callIds.map((id) => {
        const row = calls.get(id);
        return row
          ? { id, status: row.status, host: row.host, model: row.model, callerSession: row.callerSession, outputSha256: row.output?.sha256 || null, inputSha256: row.input?.sha256 || null }
          : { id, status: "missing" };
      }),
      machineGates: gates,
      failedGateIds,
      revision,
      ...(dispositions.length > 0 ? { findingDispositions: dispositions } : {}),
      blockingCondition: sanitizeEvidence(blockingCondition),
      cost: declaredCost,
      declaredEvaluators: panelDraft.declaredEvaluators,
      openedAt: new Date(now()).toISOString(),
      reviews: [panelReviewEntry({ existing, contract, review, reviewFile, reviewSha256, blockingCondition })],
    };
    return settlePanel({ existing, contract, paths, panel, now, captureLearning });
  });
}

function versionReviewShas(version) {
  const rows = Array.isArray(version?.reviews) ? version.reviews.map((row) => row.reviewSha256) : [];
  return [...new Set([nonEmpty(version?.reviewSha256), ...rows].filter(Boolean))];
}

/**
 * 組に入れる採点の1行。blockingCondition は、その採点を記録した record の --blocking-condition（CLI の値）を
 * 先に、無ければ採点ファイルの blockingCondition を残す。組が閉じるとき（closePanel）は、組を開いた record の値か
 * どれかの行の値を使うので、2件目以降の record に付けた値もここに残せば効く（以前は2件目以降の CLI の値を
 * 捨てていて、組の最後の評価者の record で止めようとしても止まらなかった）。
 */
function panelReviewEntry({ existing, contract, review, reviewFile, reviewSha256, blockingCondition = "" }) {
  return {
    evaluatorId: nonEmpty(review.evaluatorId),
    evaluatorContextId: nonEmpty(review.evaluatorContextId),
    evaluatorHost: nonEmpty(review.evaluatorHost),
    reviewPath: reviewFile.rel,
    reviewSha256,
    rubricScores: { ...review.rubricScores },
    notes: sanitizeEvidence(review.notes),
    findings: readReviewFindings(review, contract, new Set(loopFindingRecords(existing).map((row) => row.id))).rows,
    blockingCondition: sanitizeEvidence(blockingCondition) || sanitizeEvidence(review.blockingCondition),
  };
}

/**
 * 組に入れてよい採点かを確かめる。入れてよければ null、だめなら人待ちの結果を返す。
 * 評価者の独立（作った文脈でない・前の回でも組の中でも使っていない文脈）・宣言した評価者・
 * 全項目の点・所見・前の回や組の中の写しでない所見を見る。
 */
function validatePanelReview({ existing, contract, review, panel }) {
  const evaluatorId = nonEmpty(review?.evaluatorId);
  const evaluatorContextId = nonEmpty(review?.evaluatorContextId);
  if (!evaluatorId || !CONTEXT_ID.test(evaluatorContextId)) {
    return waiting(existing, ["script-quality-review-evaluator-missing"], "採点ファイルに evaluatorId と evaluatorContextId（評価した会話・タスクの ID）が要る");
  }
  if (evaluatorId === SCRIPT_GENERATOR_ID || panel.producerContextsAll.includes(evaluatorContextId)) {
    return waiting(existing, ["script-quality-evaluator-not-independent"], "この版を作った文脈（初稿の文脈・作り手・外部モデルを呼んだ文脈）は採点できない。別の文脈で採点する");
  }
  const usedContexts = new Set((existing.rounds || []).flatMap((round) => (round.reviews || []).map((row) => row.evaluatorContextId)));
  if (usedContexts.has(evaluatorContextId)) {
    return waiting(existing, ["script-quality-fresh-review-required"], "この評価文脈は前の回で採点している。回ごとに新しい文脈で採点する");
  }
  if (panel.reviews.some((row) => row.evaluatorContextId === evaluatorContextId)) {
    return waiting(existing, ["script-quality-panel-context-reused"], "この評価文脈は同じ組で既に採点している。組の評価者はそれぞれ別の文脈で採点する");
  }
  const declared = panel.declaredEvaluators || [];
  if (declared.length > 0 && !declared.includes(evaluatorId)) {
    return waiting(existing, [`script-quality-panel-evaluator-undeclared:${evaluatorId}`], `この組の評価者は ${declared.join(", ")}（Channel Pack の宣言）。宣言に無い評価者の採点は組に入れない`);
  }
  if (panel.reviews.some((row) => row.evaluatorId === evaluatorId)) {
    return waiting(existing, [`script-quality-panel-evaluator-duplicate:${evaluatorId}`], `評価者 ${evaluatorId} はこの組で既に採点している。同じ評価者の2件目は組に入れない`);
  }
  const scoreProblems = validateReviewScores(review, contract);
  if (scoreProblems.length > 0) {
    return waiting(existing, scoreProblems.map((problem) => `script-quality-review-${problem}`), `採点ファイルの rubricScores は全項目（${contract.rubric.map((row) => row.id).join(", ")}）を 0〜100 で埋める`);
  }
  const notes = sanitizeEvidence(review.notes);
  if (Array.from(notes).length < 4) return waiting(existing, ["script-quality-review-notes-required"], "採点ファイルの notes に、何を読んで何を見たかを書く");
  const stale = findStaleQualityFeedback({ state: existing, reviews: [{ notes, evaluatorContextId }] });
  if (stale) return waiting(existing, [`script-quality-${stale.reasonCode}`], stale.detail);
  const normalized = normalizeNotes(notes);
  if (panel.reviews.some((row) => normalizeNotes(row.notes) === normalized)) {
    return waiting(existing, ["script-quality-panel-notes-duplicated"], "組の中の別の評価と同じ所見。評価者ごとに、自分で読んだ所見を書く");
  }
  const findings = readReviewFindings(review, contract, new Set(loopFindingRecords(existing).map((row) => row.id)));
  if (findings.problems.length > 0) {
    return waiting(existing, findings.problems.map((problem) => `script-quality-review-${problem}`),
      "採点ファイルの findings は文か { text, criterionId, recurrenceOf } の一覧。recurrenceOf には前の回の指摘の id（採点表の previousFindings）を書く");
  }
  return null;
}

function normalizeNotes(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
}

/** 指摘の id（r<回>-f<番号>）。回ごとに、組の評価者の順・指摘の順で振る。 */
const FINDING_ID = /^r[1-9][0-9]{0,3}-f[1-9][0-9]{0,2}$/u;
/** 1つの版に残す指摘の上限（今までの findings の上限と同じ）。 */
const MAX_FINDINGS_PER_VERSION = 50;
/** 次の版を記録するときに、前の回の指摘ごとに書く採否。 */
export const SCRIPT_FINDING_DECISIONS = Object.freeze(["adopted", "rejected"]);

function findingDigest(text) {
  return sha256(normalizeNotes(text)).slice(0, 16);
}

function loopFindingRecords(existing) {
  return (existing?.script?.versions || []).flatMap((row) => row.findingRecords || []);
}

/**
 * 採点ファイルの findings を読む。1件は文か { text, criterionId, recurrenceOf }。
 * recurrenceOf は、前の回の指摘がまだ当てはまるときにその id を書く（採点表の previousFindings）。
 */
function readReviewFindings(review, contract, knownIds) {
  const problems = [];
  const rows = [];
  if (review?.findings === undefined || review?.findings === null) return { rows, problems };
  if (!Array.isArray(review.findings)) return { rows, problems: ["findings-invalid"] };
  for (const entry of review.findings) {
    const object = plainObject(entry);
    const text = sanitizeEvidence(object ? entry.text : entry, 500);
    if (!text) {
      if (object) problems.push("finding-text-missing");
      continue;
    }
    const criterionId = object ? nonEmpty(entry.criterionId) : "";
    if (criterionId && !contract.rubric.some((row) => row.id === criterionId)) {
      problems.push(CRITERION_ID.test(criterionId) ? `finding-criterion-unknown:${criterionId}` : "finding-criterion-invalid");
    }
    const recurrenceOf = object ? nonEmpty(entry.recurrenceOf) : "";
    if (recurrenceOf && !FINDING_ID.test(recurrenceOf)) problems.push("recurrence-invalid");
    else if (recurrenceOf && !knownIds.has(recurrenceOf)) problems.push(`recurrence-unknown:${recurrenceOf}`);
    rows.push({ text, ...(criterionId ? { criterionId } : {}), ...(recurrenceOf ? { recurrenceOf } : {}) });
  }
  return { rows, problems };
}

/**
 * 前の回の指摘ごとの採否を読む。前の回に id つきの指摘があれば、全部に adopted / rejected と理由（4文字以上）が
 * 要る。形: [{ "findingId": "r1-f1", "decision": "adopted", "reason": "何をどう直したか / なぜ採らないか" }]
 * （{ "dispositions": [...] } でもよい）。
 */
function readFindingDispositions(value, previousFindings) {
  const expected = previousFindings.map((row) => row.id);
  const list = Array.isArray(value) ? value : plainObject(value) && Array.isArray(value.dispositions) ? value.dispositions : [];
  if (expected.length === 0 && list.length === 0) return { rows: [], issues: [] };
  if (list.length === 0) return { rows: [], issues: [`script-quality-finding-dispositions-required:${expected.join(",")}`] };
  const issues = [];
  const seen = new Map();
  for (const entry of list) {
    const id = nonEmpty(entry?.findingId);
    if (!FINDING_ID.test(id) || !expected.includes(id)) {
      issues.push(`script-quality-finding-disposition-unknown:${FINDING_ID.test(id) ? id : "invalid-id"}`);
      continue;
    }
    if (seen.has(id)) {
      issues.push(`script-quality-finding-disposition-duplicated:${id}`);
      continue;
    }
    const decision = nonEmpty(entry?.decision);
    if (!SCRIPT_FINDING_DECISIONS.includes(decision)) {
      issues.push(`script-quality-finding-disposition-invalid:${id}`);
      seen.set(id, null);
      continue;
    }
    const reason = sanitizeEvidence(entry?.reason, 500);
    if (Array.from(reason).length < 4) {
      issues.push(`script-quality-finding-disposition-reason-required:${id}`);
      seen.set(id, null);
      continue;
    }
    seen.set(id, { findingId: id, decision, reason });
  }
  const missing = expected.filter((id) => !seen.has(id));
  if (missing.length > 0) issues.push(`script-quality-finding-dispositions-required:${missing.join(",")}`);
  return { rows: issues.length > 0 ? [] : expected.map((id) => seen.get(id)), issues };
}

/**
 * この回の指摘に id を振り、採用した前の指摘がまた出ていないかを見る。同じ指摘とみなすのは、
 * 評価者が recurrenceOf で前の id を挙げたときと、正規化した文が前の指摘と同じときだけ（推測で寄せない）。
 * 却下した指摘の再登場は「直っていない指摘」に数えない（直すと言っていない）。
 */
function assignRoundFindings({ existing, panel }) {
  const roundIndex = (existing.rounds || []).length + 1;
  const versions = existing.script?.versions || [];
  const decisions = new Map();
  for (const row of versions.flatMap((version) => version.findingDispositions || [])) decisions.set(row.findingId, row.decision);
  for (const row of panel.findingDispositions || []) decisions.set(row.findingId, row.decision);
  const adoptedByDigest = new Map();
  for (const finding of loopFindingRecords(existing)) {
    if (decisions.get(finding.id) !== "adopted") continue;
    adoptedByDigest.set(finding.textDigest, [...(adoptedByDigest.get(finding.textDigest) || []), finding.id]);
  }
  const records = [];
  for (const review of panel.reviews) {
    for (const finding of review.findings || []) {
      if (records.length >= MAX_FINDINGS_PER_VERSION) break;
      const textDigest = findingDigest(finding.text);
      const hits = new Set(adoptedByDigest.get(textDigest) || []);
      if (finding.recurrenceOf && decisions.get(finding.recurrenceOf) === "adopted") hits.add(finding.recurrenceOf);
      records.push({
        id: `r${roundIndex}-f${records.length + 1}`,
        text: finding.text,
        textDigest,
        evaluatorContextId: review.evaluatorContextId,
        ...(finding.criterionId ? { criterionId: finding.criterionId } : {}),
        ...(finding.recurrenceOf ? { recurrenceOf: finding.recurrenceOf } : {}),
        ...(hits.size > 0 ? { unresolvedOf: [...hits].sort() } : {}),
      });
    }
  }
  const unresolved = [...new Set(records.flatMap((row) => row.unresolvedOf || []))].sort();
  return { records, unresolved };
}

/** 組が開いている版に、別の評価者の採点を足す。全員そろえば1回として閉じる。 */
async function joinPanel({
  existing, contract, paths, review, reviewSha256, reviewFile, pending, scriptInfo, label, stageName, producers, callIds, blockingCondition = "", now, captureLearning,
}) {
  const mismatch = (label && label !== pending.versionLabel)
    || (stageName && stageName !== pending.stage)
    || (scriptInfo && scriptInfo.sha256 !== pending.scriptSha256)
    || review?.scriptSha256 !== pending.scriptSha256;
  if (mismatch) {
    return waiting(existing, ["script-quality-panel-version-mismatch"], `評価の組は版 ${pending.versionLabel}（台本 ${pending.scriptSha256.slice(0, 12)}）を採点している。別の版の採点は組に入れない`);
  }
  const extraProducers = producers.filter((id) => !pending.producerContexts.includes(id));
  const extraCalls = callIds.filter((id) => !pending.externalCalls.some((row) => row.id === id));
  if (extraProducers.length > 0 || extraCalls.length > 0) {
    return waiting(existing, ["script-quality-panel-inputs-differ"], "組に入る採点では、作った文脈と外部モデルの呼び出しは組を開いた記録のものを使う（足せない）");
  }
  if (pending.baseScriptSha256 && review?.baseScriptSha256 !== pending.baseScriptSha256) {
    return waiting(existing, [review?.baseScriptSha256 ? "script-quality-review-base-mismatch" : "script-quality-review-base-missing"], `前の版（${pending.baseVersion}）と比べて採点したことを baseScriptSha256 に書く`);
  }
  const rejected = validatePanelReview({ existing, contract, review, panel: pending });
  if (rejected) return rejected;
  const panel = { ...pending, reviews: [...pending.reviews, panelReviewEntry({ existing, contract, review, reviewFile, reviewSha256, blockingCondition })] };
  return settlePanel({ existing, contract, paths, panel, now, captureLearning });
}

/** 組が全員そろっていれば1回として閉じ、そろっていなければ組を状態に残す。 */
async function settlePanel({ existing, contract, paths, panel, now, captureLearning }) {
  if (panel.reviews.length < panelSize(contract)) {
    const next = { ...existing, script: { ...existing.script, pendingPanel: panel } };
    await writeJsonAtomic(paths.statePath, next);
    return {
      recorded: false,
      panelAccepted: true,
      state: next,
      panel: panelSummary(panel),
      issues: issuesFromState(next),
      detail: `採点を版 ${panel.versionLabel} の評価の組に入れた（${panel.reviews.length}/${panelSize(contract)}）。${nextStepDetail(next, paths)}`,
      check: checkFor(next),
    };
  }
  return closePanel({ existing, contract, paths, panel, now, captureLearning });
}

async function closePanel({ existing, contract, paths, panel, now, captureLearning }) {
  const observedAt = now();
  const scriptRow = { path: panel.scriptPath, sha256: panel.scriptSha256, note: `この回に採点した台本（版 ${panel.versionLabel}・${panel.stage}）` };
  const reviewShas = panel.reviews.map((row) => row.reviewSha256);
  const reviewDigest = reviewShas.length === 1 ? reviewShas[0] : sha256(canonicalJson([...reviewShas].sort()));
  const evidence = [
    scriptRow,
    ...panel.reviews.map((row) => ({
      path: row.reviewPath,
      sha256: row.reviewSha256,
      note: panel.reviews.length === 1
        ? "別の評価文脈の採点ファイル（評価項目の点数つき）"
        : `別の評価文脈の採点ファイル（評価者 ${row.evaluatorId}、評価項目の点数つき）`,
    })),
    ...(panel.baseScriptSha256 ? [{ path: panel.baseScriptPath, sha256: panel.baseScriptSha256, note: `意味の保持を比べた前の版（${panel.baseVersion}）` }] : []),
    ...panel.externalCalls.filter((row) => row.status !== "missing").map((row) => ({
      path: `external-call:${row.id}`,
      sha256: row.outputSha256 || row.inputSha256,
      note: `外部モデル呼び出しの記録（${row.host}/${row.model}、状態 ${row.status}）`,
    })),
  ];
  const { pendingPanel: _closed, ...scriptRest } = existing.script;
  const stateForCore = { ...existing, script: scriptRest };
  // 外部モデルの呼び出しは id で1回だけ数える（前の回・前のループで数えたものは数えない）。
  // 費用を書いていない回の呼び出しは、0円ではなく不明の件数として残す。
  const counted = new Set(existing.costedKeys || []);
  const newKeys = [...new Set(panel.externalCalls
    .filter((row) => row.status !== "missing")
    .map((row) => `external-call:${row.id}`))]
    .filter((key) => !counted.has(key));
  const declaredCost = typeof panel.cost === "number" && Number.isFinite(panel.cost) ? panel.cost : null;
  const costAccounting = {
    cost: declaredCost ?? 0,
    unit: "unspecified",
    units: [],
    source: null,
    countedKeys: newKeys,
    newJobCount: newKeys.length,
    pricedCount: declaredCost === null ? 0 : newKeys.length,
    estimatedCount: 0,
    unpricedCount: declaredCost === null ? newKeys.length : 0,
    freeCount: 0,
  };
  // この回の指摘に id を振り、採用した前の指摘が直っていないものを数える（停滞の判定に使う）。
  const roundFindings = assignRoundFindings({ existing, panel });
  let recorded;
  try {
    recorded = recordQualityRound({
      contract,
      state: stateForCore,
      unresolvedFindingIds: roundFindings.unresolved,
      hardGateReport: { pass: panel.failedGateIds.length === 0, failedGateIds: panel.failedGateIds, contractDigest: contract.digest },
      reviews: panel.reviews.map((row) => ({
        evaluatorId: row.evaluatorId,
        evaluatorContextId: row.evaluatorContextId,
        evaluatorHost: row.evaluatorHost,
        scores: row.rubricScores,
        notes: row.notes,
        evidence: [scriptRow],
        // 組の評価はどれも同じ台本 SHA を採点した（中核が別の版の点の混入を拒む）。
        artifactSha256: panel.scriptSha256,
      })),
      // この回に採点した台本の SHA。合格せずに止まったときの bestRound に残る。
      artifactSha256: panel.scriptSha256,
      evidence,
      reviewDigest,
      ...(declaredCost === null ? {} : { cost: declaredCost }),
      costAccounting,
      observedAt,
      blockingCondition: panel.blockingCondition || panel.reviews.map((row) => row.blockingCondition).find(Boolean) || "",
      ...panel.revision,
    });
  } catch (error) {
    return waiting(existing, ["script-quality-round-rejected"], `この採点は品質ループの回として記録できない: ${sanitizeEvidence(error?.message || String(error), 300)}`);
  }
  const version = {
    round: recorded.rounds.length,
    label: panel.versionLabel,
    stage: panel.stage,
    scriptPath: panel.scriptPath,
    scriptSha256: panel.scriptSha256,
    scriptBytes: panel.scriptBytes,
    nonEmptyLines: panel.nonEmptyLines,
    reviewPath: panel.reviews[0].reviewPath,
    reviewSha256: panel.reviews[0].reviewSha256,
    ...(panel.baseScriptSha256 ? { baseVersion: panel.baseVersion, baseScriptSha256: panel.baseScriptSha256 } : {}),
    producerContexts: panel.producerContexts,
    externalCalls: panel.externalCalls.map((row) => (row.status === "missing"
      ? { id: row.id, status: "missing" }
      : { id: row.id, status: row.status, host: row.host, model: row.model, outputSha256: row.outputSha256 })),
    machineGates: panel.machineGates,
    // 項目ごとの点（組なら評価者の平均）。学習の自動捕捉が「どの項目が低かったか」を本文なしで言うのに使う。
    rubricScores: Object.fromEntries(contract.rubric.map((row) => [
      row.id,
      Number((panel.reviews.reduce((sum, entry) => sum + entry.rubricScores[row.id], 0) / panel.reviews.length).toFixed(3)),
    ])),
    reviews: panel.reviews.map((row) => ({
      evaluatorId: row.evaluatorId,
      evaluatorContextId: row.evaluatorContextId,
      evaluatorHost: row.evaluatorHost,
      reviewPath: row.reviewPath,
      reviewSha256: row.reviewSha256,
      rubricScores: Object.fromEntries(contract.rubric.map((criterion) => [criterion.id, row.rubricScores[criterion.id]])),
    })),
    // 指摘の文の一覧（今までの形）と、id つきの指摘（次の版で採否を書く相手）。
    findings: roundFindings.records.map((row) => row.text),
    findingRecords: roundFindings.records,
    // この版を作るときに、前の回の指摘ごとに書いた採否と理由。
    ...(panel.findingDispositions ? { findingDispositions: panel.findingDispositions } : {}),
    recordedAt: new Date(observedAt).toISOString(),
  };
  const next = { ...recorded, script: { ...recorded.script, versions: [...(recorded.script.versions || []), version] } };
  await writeJsonAtomic(paths.statePath, next);
  const stateSha256 = sha256(await readFile(paths.statePath));
  const round = lastOf(next.rounds);
  let learning = null;
  if (next.status !== "passed" && typeof captureLearning === "function") {
    // 学習の捕捉に失敗しても、回の記録は変えない。
    try {
      // workDir は、学習を積むチャンネルを台帳から引く手がかり（lib/learningChannelResolver.mjs）。
      learning = await captureLearning({ state: next, round, version, contract, workDir: paths.workDir });
    } catch (error) {
      learning = { captured: 0, skippedReason: "capture-failed", detail: sanitizeEvidence(error?.message || String(error), 200) };
    }
  }
  const label = panel.versionLabel;
  return {
    recorded: true,
    state: next,
    round,
    version,
    issues: issuesFromState(next),
    detail: next.status === "passed"
      ? `品質ループ ${next.rounds.length} 回目（版 ${label}）で合格（${round.score} ≥ ${contract.limits.targetScore}、下限割れなし、機械ゲート全通過）`
      : `品質ループ ${next.rounds.length} 回目（版 ${label}）は不合格（${round.score}/${contract.limits.targetScore}`
        + `${round.floorFailures.length ? `、下限割れ: ${round.floorFailures.join(", ")}` : ""}`
        + `${round.failedGateIds.length ? `、落ちた機械ゲート: ${round.failedGateIds.join(", ")}` : ""}`
        + `${round.acceptance?.failures?.length ? `、受け入れ方: ${round.acceptance.failures.join(", ")}` : ""}`
        + `${round.unresolvedFindingIds?.length ? `、採用したのに直っていない指摘: ${round.unresolvedFindingIds.join(", ")}` : ""}）。${nextStepDetail(next, paths)}`,
    check: checkFor(next, { stateSha256 }),
    learning,
  };
}

/**
 * 今の状態。deliverable は「合格していて、合格した版の台本ファイルが今も同じバイト列」のときだけ true。
 */
export async function scriptQualityStatus({ workDir } = {}) {
  const paths = scriptQualityPaths(workDir);
  const state = await readJsonIfExists(paths.statePath, null);
  if (!state?.script) {
    return { started: false, deliverable: false, issues: ["script-quality-loop-not-started"], detail: nextStepDetail(null, paths), check: checkFor(null) };
  }
  const version = lastOf(state.script.versions);
  let currentSha256 = "";
  if (version) {
    try {
      currentSha256 = sha256(await readFile(resolve(paths.workDir, version.scriptPath)));
    } catch {
      currentSha256 = "";
    }
  }
  const unchanged = Boolean(version) && currentSha256 === version.scriptSha256;
  const issues = issuesFromState(state);
  if (version && !unchanged) issues.push(currentSha256 ? "script-quality-script-changed-after-review" : "script-quality-script-missing");
  const deliverable = state.status === "passed" && unchanged;
  return {
    started: true,
    deliverable,
    state,
    issues,
    detail: nextStepDetail(state, paths),
    check: checkFor(state, { currentScriptSha256: currentSha256, scriptUnchangedSinceReview: unchanged }),
    sheet: scriptQualityReviewSheet(state.script.contract),
    rounds: (state.rounds || []).map((round, index) => ({
      index: round.index,
      version: state.script.versions[index]?.label || "",
      stage: state.script.versions[index]?.stage || "",
      score: round.score,
      floorFailures: round.floorFailures,
      failedGateIds: round.failedGateIds,
      failureFingerprint: round.failureFingerprint,
      evaluatorContextId: round.reviews?.[0]?.evaluatorContextId || "",
      evaluatorContextIds: (round.reviews || []).map((row) => row.evaluatorContextId),
      ...(round.acceptance ? { acceptanceFailures: [...(round.acceptance.failures || [])] } : {}),
      ...(round.unresolvedFindingIds?.length ? { unresolvedFindingIds: [...round.unresolvedFindingIds] } : {}),
    })),
  };
}

/**
 * この作業フォルダの累計（回数・費用・時間・不明の件数）を 0 へ戻す。戻せるのは、理由があり、
 * 人の確認（その人の対話端末から --human-verified。判定は scripts/harness-learn.mjs の attestationFor で、
 * 途中の成果物の品質ループの verify と同じ一つの実装）があるときだけ。--agent-attested は記録せず
 * 数えない。続いているループの累計は戻さない（止まってから戻し、start --restart で始め直す）。
 * 戻す前の累計は cumulativeResets に残る。
 */
export async function resetScriptQualityCumulative({
  workDir,
  reviewer = "",
  reason = "",
  humanVerified = false,
  agentAttested = false,
  isInteractive = false,
  now = () => new Date().toISOString(),
  attest = null,
} = {}) {
  const paths = scriptQualityPaths(workDir);
  const text = sanitizeEvidence(reason, 500);
  if (Array.from(text).length < 4) throw new Error("--reason に、累計を戻す理由（何が変わったか）を書いてください。");
  const attestationFor = attest || (await import("../scripts/harness-learn.mjs")).attestationFor;
  const verdict = attestationFor({ reviewer, isInteractive, agentAttested, humanVerified });
  if (!verdict.ok) throw new Error(verdict.message);
  const attestation = verdict.attestation;
  return withCanvasFileLock(paths.statePath, async () => {
    const existing = await readJsonIfExists(paths.statePath, null);
    if (!existing?.script) return { reset: false, issues: ["script-quality-loop-not-started"], detail: "先に start でループを始める" };
    if (existing.status === "active") {
      return { reset: false, state: existing, issues: ["script-quality-cumulative-reset-loop-active"], detail: "続いているループの累計は戻さない。ループが止まってから戻す" };
    }
    const before = scriptQualityCumulative(existing);
    if (attestation.attestedBy !== "human-verified") {
      return {
        reset: false,
        counted: false,
        state: existing,
        before,
        issues: [`script-quality-cumulative-reset-not-counted:${attestation.attestedBy}`],
        detail: "累計を戻すのは、人の確認（その人の対話端末から --human-verified）があるときだけ。何も変えていない",
      };
    }
    const row = {
      resetAt: new Date(now()).toISOString(),
      reason: text,
      reviewer: attestation.reviewer,
      attestedBy: attestation.attestedBy,
      before: totalsOnly(before),
    };
    const next = {
      ...existing,
      carriedOver: { ...ZERO_TOTALS },
      script: {
        ...existing.script,
        cumulativeExcludesCurrentLoop: true,
        cumulativeResets: [...(existing.script.cumulativeResets || []), row],
      },
    };
    await writeJsonAtomic(paths.statePath, next);
    const after = scriptQualityCumulative(next);
    return {
      reset: true,
      counted: true,
      state: next,
      before,
      after,
      issues: [],
      detail: `累計（${before.loops} ループ・${before.rounds} 回・費用 ${before.cost}${before.unpricedCount ? `＋不明 ${before.unpricedCount} 件` : ""}）を 0 へ戻した。`
        + "start --restart --reason \"...\" で始め直せる",
    };
  });
}

/** 評価者へ渡す採点ファイルの雛形。scriptSha256 と baseScriptSha256 はここで計算して埋める。 */
export async function scriptQualityReviewTemplate({ workDir, scriptPath, baseVersion = "", stage = "draft" } = {}) {
  const paths = scriptQualityPaths(workDir);
  const state = await readJsonIfExists(paths.statePath, null);
  if (!state?.script) throw new Error("先に start でループを始めてください。");
  const script = insideWorkDir(paths.workDir, scriptPath, "--script");
  const info = await inspectScript(script.full);
  const versions = state.script.versions || [];
  const baseRow = stage === "draft" ? null : (nonEmpty(baseVersion) ? versions.find((row) => row.label === baseVersion) : lastOf(versions));
  const declared = panelEvaluators(state.script.contract);
  // 前の回の指摘（id と文だけ。点数は載せない）。まだ当てはまる指摘は findings に recurrenceOf で書く。
  const previousFindings = (lastOf(versions)?.findingRecords || []).map((row) => ({ id: row.id, text: row.text }));
  return {
    sheet: scriptQualityReviewSheet(state.script.contract),
    template: {
      evaluatorId: declared.length > 0
        ? `<宣言した評価者のどれか: ${declared.join(" / ")}>`
        : "<評価者の名前（作る係の script-writer は不可）>",
      evaluatorContextId: "<この採点をする会話・タスクの ID（作った文脈・前の回の文脈は不可）>",
      evaluatorHost: "<claude-code|codex|human>",
      scriptSha256: info.sha256,
      ...(baseRow ? { baseScriptSha256: baseRow.scriptSha256 } : {}),
      rubricScores: Object.fromEntries(state.script.contract.rubric.map((row) => [row.id, null])),
      notes: "<何を読んで、何を見たか>",
      findings: [],
      ...(previousFindings.length > 0 ? {
        previousFindings,
        findingsFormat: "findings は文か { \"text\", \"criterionId\", \"recurrenceOf\" } の一覧。前の回の指摘がまだ当てはまるなら recurrenceOf にその id を書く",
      } : {}),
    },
  };
}

/**
 * 人が「この台本（SHA）をそのまま使う」と認めた記録を残す。運営者が自分で書いた台本や、依頼者が書いた台本を
 * AI の点で止めないための口で、品質ループの合格とは別の理由として scriptQualityVerdict が返す。
 * 数えるのは、その人の対話端末から --human-verified を付けた記録だけ（判定は scripts/harness-learn.mjs の
 * attestationFor。途中の成果物の verify と同じ一つの実装）。--agent-attested は記録するが数えない。
 * 記録は作業フォルダの quality/script-human-acceptance.json に、台本の SHA と理由だけを残す（本文は持たない）。
 */
export async function acceptScriptAsHumanVerified({
  workDir,
  scriptPath,
  reviewer = "",
  reason = "",
  humanVerified = false,
  agentAttested = false,
  isInteractive = false,
  now = () => new Date().toISOString(),
  attest = null,
} = {}) {
  const paths = scriptQualityPaths(workDir);
  const script = insideWorkDir(paths.workDir, scriptPath, "--script");
  const text = sanitizeEvidence(reason, 500);
  if (Array.from(text).length < 4) throw new Error("--reason に、この台本をそのまま使う理由（誰が書いた台本か・何を確かめたか）を書いてください。");
  const attestationFor = attest || (await import("../scripts/harness-learn.mjs")).attestationFor;
  const verdict = attestationFor({ reviewer, isInteractive, agentAttested, humanVerified });
  if (!verdict.ok) throw new Error(verdict.message);
  const attestation = verdict.attestation;
  const info = await inspectScript(script.full);
  if (!info.readable) throw new Error("--script の台本が UTF-8 で読めないか、空です。");
  return withCanvasFileLock(paths.humanAcceptancePath, async () => {
    const existing = await readJsonIfExists(paths.humanAcceptancePath, null);
    const acceptance = {
      scriptPath: script.rel,
      scriptSha256: info.sha256,
      reason: text,
      reviewer: attestation.reviewer,
      attestedBy: attestation.attestedBy,
      ...(attestation.claimedReviewer ? { claimedReviewer: attestation.claimedReviewer } : {}),
      recordedAt: new Date(now()).toISOString(),
    };
    const next = {
      version: SCRIPT_HUMAN_ACCEPTANCE_VERSION,
      acceptances: [...(Array.isArray(existing?.acceptances) ? existing.acceptances : []), acceptance],
    };
    await writeJsonAtomic(paths.humanAcceptancePath, next);
    const counted = attestation.attestedBy === "human-verified";
    return {
      recorded: true,
      counted,
      acceptance,
      issues: counted ? [] : [`script-quality-human-acceptance-not-counted:${attestation.attestedBy}`],
      detail: counted
        ? `台本 ${info.sha256.slice(0, 12)} を、人の確認つきでそのまま使うと記録した（品質ループの合格とは別の理由として扱う）`
        : `記録は ${attestation.attestedBy} として残したが、人の受け入れには数えない。確認した人が自分の端末から --human-verified を付けて打つ`,
    };
  });
}

/** scriptQualityVerdict が返す理由コード。制作側はこのコードだけを見る（ループの issues や状態名を読まない）。 */
export const SCRIPT_QUALITY_VERDICT_CODES = Object.freeze({
  passed: "script-quality-passed",
  humanAccepted: "script-quality-human-accepted",
  notStarted: "script-quality-loop-not-started",
  noRound: "script-quality-no-round",
  panelIncomplete: "script-quality-panel-incomplete",
  notPassed: "script-quality-not-passed",
  stopped: "script-quality-stopped",
  changedAfterPass: "script-changed-after-pass",
  scriptMissing: "script-quality-script-missing",
  stateInconsistent: "script-quality-state-inconsistent",
  // 制作側が genre を渡したときだけ: 合格したループが別ジャンルの採点表で採点していた（漫画の Job に物語の台本の合格など）。
  genreMismatch: "script-quality-genre-mismatch",
});

function weightedScore(scores, contract) {
  let weighted = 0;
  let total = 0;
  for (const row of contract.rubric || []) {
    const value = Number(scores?.[row.id]);
    if (!Number.isFinite(value)) return null;
    weighted += Math.min(100, Math.max(0, value)) * row.weight;
    total += row.weight;
  }
  return total > 0 ? Number((weighted / total).toFixed(3)) : null;
}

/**
 * 合格と書かれた状態が、状態に写した契約と採点から本当に合格になるかを確かめ直す（状態ファイルを手で
 * 書き換えた「合格」を制作に通さないため）。見るのは: 契約の digest が契約の中身と一致する、最後の回が
 * 機械ゲート全通過・下限割れなし・受け入れ方の失敗なし、版の採点から計算し直した総合点が目標以上で
 * どの項目も下限以上、each-evaluator なら評価者ごとの点も下限以上、宣言した評価者が全員そろっている。
 * Channel Pack の署名はここでは検証しない（それは start / record が行う）。
 */
function verifyPassedRecord(state) {
  const problems = [];
  const contract = state?.script?.contract;
  if (!plainObject(contract) || !nonEmpty(state?.contractDigest)) return ["contract-missing"];
  const { digest, ...body } = contract;
  if (digest !== state.contractDigest || sha256(canonicalJson(body)) !== digest) problems.push("contract-digest");
  const round = lastOf(state.rounds);
  const version = lastOf(state.script?.versions);
  if (!round || !version || Number(version.round) !== Number(round.index)) return [...problems, "round-missing"];
  if (round.hardGatePass !== true || (round.failedGateIds || []).length > 0) problems.push("machine-gates");
  if ((round.floorFailures || []).length > 0) problems.push("floors");
  if ((round.acceptance?.failures || []).length > 0) problems.push("acceptance");
  const reviews = Array.isArray(version.reviews) && version.reviews.length > 0
    ? version.reviews
    : [{ rubricScores: version.rubricScores }];
  const scores = reviews.map((row) => weightedScore(row.rubricScores, contract));
  if (scores.some((value) => value === null)) return [...problems, "scores"];
  for (const row of reviews) {
    for (const criterion of contract.rubric || []) {
      if (Number.isFinite(criterion.minimumScore) && Number(row.rubricScores[criterion.id]) < criterion.minimumScore) {
        problems.push("floors");
      }
    }
  }
  const average = Number((scores.reduce((sum, value) => sum + value, 0) / scores.length).toFixed(3));
  if (average < Number(contract.limits?.targetScore)) problems.push("below-target");
  let acceptance = null;
  try {
    acceptance = normalizeQualityAcceptance(contract.acceptance);
  } catch {
    problems.push("acceptance");
  }
  if (acceptance) {
    const ids = reviews.map((row) => nonEmpty(row.evaluatorId));
    if (acceptance.evaluators.some((id) => !ids.includes(id))) problems.push("evaluator-missing");
    if (acceptance.mode === "each-evaluator") {
      const minimum = acceptance.minimumEvaluatorScore ?? Number(contract.limits?.targetScore);
      if (scores.some((value) => value < minimum)) problems.push("evaluator-below-minimum");
    }
  }
  return [...new Set(problems)];
}

async function readHumanAcceptance(paths, scriptSha256) {
  const record = await readJsonIfExists(paths.humanAcceptancePath, null).catch(() => null);
  const rows = Array.isArray(record?.acceptances) ? record.acceptances : [];
  return rows.filter((row) => row?.scriptSha256 === scriptSha256 && row?.attestedBy === "human-verified").at(-1) || null;
}

/**
 * 制作側が使う「この台本（SHA）は使ってよいか」の答え。
 *
 *   const verdict = await scriptQualityVerdict({ workDir, scriptPath });   // または { workDir, scriptSha256 }
 *   if (!verdict.pass) stop(verdict.reasonCode);
 *
 * pass が true になるのは2つだけで、理由を分けて返す:
 *   - script-quality-passed: 今のループが合格していて、合格した版と同じ SHA（acceptedBy: "quality-loop"）
 *   - script-quality-human-accepted: 人の確認つきでそのまま使うと記録した SHA（acceptedBy: "human"）
 * 不合格の理由: 合格した版と違う SHA（script-changed-after-pass）・ループが無い・回が無い・組が欠けている・
 * 合格していない・止まった・台本が読めない・状態ファイルが契約と採点に合わない（script-quality-state-inconsistent）。
 * 見るのは今のループだけ（始め直す前のループの合格は、始め直した理由で置き換わっている）。何も書かない。
 * scriptPath は作業フォルダの外でもよい（制作の Job の作業フォルダへ写した台本など。SHA だけを見る）。
 * genre（任意）を渡すと、ループの合格はそのジャンルの採点表で採点したものだけを数える（違えば
 * script-quality-genre-mismatch）。人の受け入れはジャンルを問わない（人がその台本をそのまま使うと決めた記録）。
 */
export async function scriptQualityVerdict({ workDir, scriptPath = "", scriptSha256 = "", genre = "" } = {}) {
  const paths = scriptQualityPaths(workDir);
  const hasPath = Boolean(nonEmpty(scriptPath));
  const hasSha = Boolean(nonEmpty(scriptSha256));
  if (hasPath === hasSha) {
    throw new Error(hasPath ? "scriptPath と scriptSha256 はどちらか1つにしてください。" : "scriptPath か scriptSha256 のどちらかが要ります。");
  }
  const expectedGenre = nonEmpty(genre) ? scriptQualityGenre(nonEmpty(genre)).id : "";
  const codes = SCRIPT_QUALITY_VERDICT_CODES;
  let sha = "";
  if (hasSha) {
    sha = nonEmpty(scriptSha256).toLowerCase();
    if (!SHA256.test(sha)) throw new Error("scriptSha256 は 64桁の小文字の16進にしてください。");
  } else {
    try {
      sha = sha256(await readFile(resolve(paths.workDir, scriptPath)));
    } catch {
      return { pass: false, reasonCode: codes.scriptMissing, acceptedBy: null, scriptSha256: "", detail: "台本のファイルが読めない" };
    }
  }
  const state = await readJsonIfExists(paths.statePath, null).catch(() => null);
  const humanAcceptance = await readHumanAcceptance(paths, sha);
  const version = lastOf(state?.script?.versions);
  const round = lastOf(state?.rounds);
  const base = {
    scriptSha256: sha,
    status: state?.status || "not-started",
    stopReason: state?.stopReason || "",
    genre: state?.script?.genre || "",
    contractDigest: state?.contractDigest || "",
    versionLabel: version?.label || "",
    score: round ? round.score : null,
    targetScore: state?.script?.contract?.limits?.targetScore ?? null,
    failureFingerprint: round?.failureFingerprint || "",
    humanAcceptance: humanAcceptance
      ? { scriptPath: humanAcceptance.scriptPath, reviewer: humanAcceptance.reviewer, reason: humanAcceptance.reason, recordedAt: humanAcceptance.recordedAt }
      : null,
  };
  let loopResult = null;
  if (state?.script && state.status === "passed") {
    const problems = verifyPassedRecord(state);
    if (problems.length > 0) {
      loopResult = { pass: false, reasonCode: codes.stateInconsistent, problems, detail: `合格と書かれた状態が、契約と採点から合格にならない（${problems.join(", ")}）` };
    } else if (expectedGenre && state.script.genre !== expectedGenre) {
      loopResult = { pass: false, reasonCode: codes.genreMismatch, detail: `合格したループは ${state.script.genre || "(不明)"} の採点表で、この制作（${expectedGenre}）の台本の採点ではない` };
    } else if (version.scriptSha256 === sha) {
      return { ...base, pass: true, reasonCode: codes.passed, acceptedBy: "quality-loop", passedScriptSha256: version.scriptSha256, detail: `品質ループの版 ${version.label} が合格している` };
    } else {
      loopResult = { pass: false, reasonCode: codes.changedAfterPass, passedScriptSha256: version.scriptSha256, detail: `合格したのは版 ${version.label}（${version.scriptSha256.slice(0, 12)}）で、この台本とは違う` };
    }
  }
  if (humanAcceptance) {
    return { ...base, pass: true, reasonCode: codes.humanAccepted, acceptedBy: "human", passedScriptSha256: loopResult?.passedScriptSha256 || "", detail: "人の確認つきでそのまま使うと記録した台本（品質ループの合格ではない）" };
  }
  if (loopResult) return { ...base, acceptedBy: null, passedScriptSha256: "", ...loopResult };
  const notPass = (reasonCode, detail) => ({ ...base, pass: false, reasonCode, acceptedBy: null, passedScriptSha256: "", detail });
  if (!state?.script) return notPass(codes.notStarted, "この作業フォルダに台本の品質ループが無い");
  if (state.status === "active") {
    if (state.script.pendingPanel) return notPass(codes.panelIncomplete, `版 ${state.script.pendingPanel.versionLabel} の評価の組が ${panelMissing(state.script.pendingPanel).join(", ")} を待っている`);
    if (!round) return notPass(codes.noRound, "まだ1回も採点していない");
    return notPass(codes.notPassed, `${state.rounds.length} 回目まで合格していない（${round.score}/${base.targetScore}）`);
  }
  return notPass(codes.stopped, `品質ループは ${state.status}（${state.stopReason || "unknown"}）で止まった。続けるかは人が決める`);
}
