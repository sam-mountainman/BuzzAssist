/**
 * 人は要所で選ぶだけにする（human choice。並べて選ぶ）。
 *
 * 人は最後の砦ではなく「まばらな神託」。人に聞くのは、決めた後で戻すと高くつき、正解を機械が確かめられない
 * 少数の点だけにする。その一手前では候補を惜しまず出し（設計の軸を分けた 2〜5 案。目安 4）、人は1つ選んで
 * 短い理由を言う。理由は「そのチャンネルの採点表に足す候補」として学習の台帳の承認キューへ積み
 * （lib/humanChoiceLearning.mjs）、以降の生成と採点は AI に任せる。
 *
 * 判断の振り分け（HUMAN_DECISION_ROUTES / HUMAN_DECISION_TABLE。説明は docs/human-choice-ja.md）:
 *   - どれがいいか → 並べて選ぶ（pick。ここ）
 *   - これでいいか → 1案に赤を入れる（redline。既存の人の確認 verify・台本の accept-human・完成動画の signoff）
 *   - 正解が一つで機械が確かめられる → 人に聞かない（machine。機械ゲート・測定・評価者の採点）
 *
 * 守ること:
 *   - 人の選択として数えるのは、選んだ人が自分の対話端末から --human-verified を付けた記録だけ
 *     （判定は scripts/harness-learn.mjs の attestationFor。途中の成果物の人の確認と同じ一つの実装）。
 *     機械が代わりに記録するなら --agent-attested（agent-self-attested として残るが数えない・学習にも積まない）
 *   - 候補はファイルの sha256（文の候補は文そのもの）に結ぶ。候補を並べた後でバイト列が変わったら記録しない。
 *     ページから作ったコマンドはページの digest を持ち、候補の組が変わった後の古いページの答えは記録しない
 *   - 理由は短い選択肢（工程ごとの理由の札。3つまで）か一言。どちらも無い選択は記録しない（お任せを除く）
 *   - お任せ（--delegate）は推奨の候補を選ぶ。推奨が無い組では使えない。お任せからは学習を積まない
 *   - 採点表（署名済みの Channel Pack の asset-quality.json など）は書き換えない。積むのは提案だけで、
 *     反映は harness-learn の承認キュー（pending → approve）と Pack の作者の署名し直しを通る
 *   - 見せ方は1枚の HTML（外部の読み込み無し・サーバー無し）。ページは答えのコマンドを組み立てるだけで、
 *     記録は端末のコマンドだけが書く
 *   - 状態は作業フォルダの quality/choices/<工程>--<組>.json（ページは同じ名前の .html）
 */

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readJsonIfExists, renameWithRetry, writeJsonAtomic } from "./atomicJsonFile.mjs";
import { assetQualityHarness, assetQualityStage } from "./assetQualityLoop.mjs";
import { withCanvasFileLock } from "./canvasFileLock.mjs";
import { HARNESS_LEARNING_ROUTES } from "./harnessLearningTargets.mjs";
import { sanitizeEvidence } from "./qualityLoop.mjs";
import { STRATEGY_BRIEF_RUBRIC } from "./strategyBriefQualityLoop.mjs";

export const HUMAN_CHOICE_VERSION = "buzzassist-human-choice-v1";
/** create --candidates に渡す候補の一覧の形。 */
export const HUMAN_CHOICE_CANDIDATES_VERSION = "buzzassist-human-choice-candidates-v1";
export const HUMAN_CHOICE_DIR = path.join("quality", "choices");
/** 人の選択として数える印（scripts/harness-learn.mjs の HUMAN_VERIFIED と同じ値。試験が一致を見る）。 */
export const HUMAN_CHOICE_HUMAN_VERIFIED = "human-verified";

/**
 * 数の決まり（方針値）。
 *   - 候補 2〜5・目安 4: 記事の best-of-N（4つほど）と、既存の匿名比較の決まり（2〜5 候補）に合わせる。
 *     5 を超えると見比べる負担が選ぶ価値を上回り、人が詰まりどころに戻る
 *   - 理由の札は 3 つまで: 全部が理由なら何も理由でない。決め手を絞らせ、採点表の候補の信号を鋭くする
 *   - 一言は 4 文字以上（他の人の確認の note と同じ下限）・300 文字まで
 */
export const HUMAN_CHOICE_LIMITS = Object.freeze({
  minCandidates: 2,
  maxCandidates: 5,
  recommendedCandidates: 4,
  maxReasonChips: 3,
  noteMinChars: 4,
  noteMaxChars: 300,
  axisMaxChars: 40,
  summaryMaxChars: 200,
  questionMaxChars: 200,
  textCandidateMaxChars: 2000,
  recommendationReasonMaxChars: 200,
});

/** 判断の振り分け（どう聞くか）。 */
export const HUMAN_DECISION_ROUTES = Object.freeze({
  pick: Object.freeze({
    id: "pick",
    label: "並べて選ぶ",
    ask: "どれがいいか",
    how: "候補を 2〜5 案（目安 4）、設計の軸を分けて並べ、人が1つ選んで短い理由を言う。理由は採点表に足す候補として承認キューへ積む",
  }),
  redline: Object.freeze({
    id: "redline",
    label: "1案に赤を入れる",
    ask: "これでいいか",
    how: "1案を見せ、可か否かと、否なら何を直すかを書いてもらう。聞くのは 3±1 問まで、各問の既定は「お任せ」＋推奨",
  }),
  machine: Object.freeze({
    id: "machine",
    label: "人に聞かない",
    ask: "正解が一つで、機械が確かめられる",
    how: "機械ゲート・測定・評価者の採点で決める。人に聞くと承認疲れで人が詰まりどころに戻る",
  }),
});

/**
 * 判断を振り分ける。正解が一つで機械が確かめられるなら聞かない。候補が2つ以上あれば並べて選ぶ。
 * 1案しかなければ赤を入れる。
 */
export function routeHumanDecision({ machineCheckable = false, candidateCount = 1 } = {}) {
  if (machineCheckable) return "machine";
  return Number(candidateCount) >= 2 ? "pick" : "redline";
}

/**
 * 工程ごとの振り分け（docs/human-choice-ja.md の表と同じ。試験が一致を見る）。
 * entry は、その判断を記録する入口。
 */
export const HUMAN_DECISION_TABLE = Object.freeze([
  { step: "strategy-topic", label: "企画の題材", route: "pick", entry: "node scripts/human-choice.mjs create --stage strategy-topic（題材の候補を企画ブリーフより前に並べる）" },
  { step: "strategy-brief", label: "企画ブリーフ", route: "redline", entry: "node scripts/strategy-brief.mjs（評価者が採点する。人は止まったときだけ1案に赤を入れる・stop で止める）" },
  { step: "title", label: "タイトル", route: "pick", entry: "node scripts/human-choice.mjs create --stage title" },
  { step: "script", label: "台本", route: "redline", entry: "node scripts/script-quality-loop.mjs（評価者が採点する。人がそのまま使うと認めるなら accept-human --human-verified）" },
  { step: "character-candidates", label: "人物の設定画の候補", route: "pick", entry: "漫画は generate_character_candidates → approve_character_candidate（approvalReason）。ほかは node scripts/human-choice.mjs create --stage character" },
  { step: "character-identity", label: "決まった人物の同一性・手指", route: "redline", entry: "node scripts/asset-quality-loop.mjs verify / verify-pages（公開面の画は全数を人が見る決まり）" },
  { step: "voice-casting", label: "声の人選", route: "pick", entry: "既存の声の人選の経路（匿名の試聴ページ → selectionReason つきの承認）" },
  { step: "thumbnail", label: "サムネ", route: "pick", entry: "node scripts/human-choice.mjs create --stage thumbnail（選んだ案を asset-quality-loop へ）" },
  { step: "key-scene-image", label: "要の場面の画（冒頭・山場）", route: "pick", entry: "node scripts/human-choice.mjs create --stage scene-image" },
  { step: "scene-image", label: "それ以外の本編の画", route: "machine", entry: "node scripts/asset-quality-loop.mjs（評価者の採点＋機械ゲート。同一性・手指の確認は character-identity の行）" },
  { step: "voice-take", label: "声のテイク", route: "machine", entry: "node scripts/asset-quality-loop.mjs --stage voice-take（CER・UTMOS の機械ゲート＋評価者）" },
  { step: "measurable", label: "寸法・尺・フレーム数・音量・文字のはみ出し・読み", route: "machine", entry: "各ジャンルの機械ゲートと最終監査（人に聞かない）" },
  { step: "final-video", label: "完成動画", route: "redline", entry: "各ジャンルの signoff（全編の試聴。作った文脈とは別の文脈で）" },
].map((row) => Object.freeze(row)));

/** 1つの工程の振り分け。無ければ例外。 */
export function humanDecisionFor(step) {
  const row = HUMAN_DECISION_TABLE.find((entry) => entry.step === String(step || ""));
  if (!row) throw new Error(`未知の工程: ${step}（${HUMAN_DECISION_TABLE.map((entry) => entry.step).join(" / ")}）`);
  return row;
}

function chip(id, label, criterion) {
  return Object.freeze({ id, label, ...criterion });
}

function draft(id, label, description) {
  return { draft: Object.freeze({ id, label, description }) };
}

function existing(id) {
  return { existing: id };
}

/**
 * 並べて選ぶ工程と、理由の札（短い理由の選択肢）。札は、既定の評価項目を重く見る候補（existing）か、
 * 採点表に足す評価項目の案（draft: id・label・description。重みと下限は人が決める）のどちらか。
 *   - assetStage のある工程: 反映先は Channel Pack の asset-quality.json の stages.<工程>（criteria・weights・
 *     floors）。draft の形は normalizeAssetChannelConfig がそのまま受ける形（試験が確かめる）
 *   - それ以外（企画の題材・タイトル）: チャンネルで変えられる採点表が無いので、反映先はチャンネルの要求台帳
 *     （判断の基準として人が書く）
 */
export const HUMAN_CHOICE_STAGES = Object.freeze({
  "strategy-topic": Object.freeze({
    id: "strategy-topic",
    label: "企画の題材",
    assetStage: null,
    configurableRubric: false,
    rubricHome: "チャンネルの要求台帳（企画の題材を選ぶ基準）",
    defaultRubricSource: "企画の品質ループの採点表",
    chips: Object.freeze([
      chip("first-seen-topic", "題材がまだ出ていない", draft("topic-first-seen", "題材の初出", "同じジャンルの上位の動画でまだ扱われていない題材か、扱われていても切り口が違う")),
      chip("clear-audience", "見る人がはっきりしている", existing("audience-specificity")),
      chip("strong-promise", "入口の約束が強い", existing("promise-payoff")),
      chip("emotional-peak", "感情の山がはっきりある", draft("emotional-peak", "感情の山", "見る人の感情が大きく動く場面が、題材の中にはっきり1つ以上ある")),
      chip("fits-channel", "チャンネルの色に合う", draft("channel-fit", "チャンネルの色との一致", "これまでの当たりの動画と同じ見る人に届き、チャンネルの約束（何が見られるか）から外れない")),
      chip("producible", "今の制作条件で作れる", existing("producibility")),
    ]),
  }),
  title: Object.freeze({
    id: "title",
    label: "タイトル",
    assetStage: null,
    configurableRubric: false,
    rubricHome: "チャンネルの要求台帳（タイトルの型）",
    defaultRubricSource: "",
    chips: Object.freeze([
      chip("curiosity-gap", "続きが気になる", draft("curiosity-gap", "続きが気になる", "結末や理由を伏せ、見る人が答えを知りたくなる問いが1つ立っている")),
      chip("concrete-detail", "具体的な名詞・数字がある", draft("concrete-detail", "具体的な名詞・数字", "抽象語だけでなく、場面が浮かぶ名詞か数字が入っている")),
      chip("reads-at-a-glance", "短く一目で読める", draft("title-reads-at-a-glance", "一目で読める長さ", "一覧の表示で切れる前に要点が読める（前半に要点がある）")),
      chip("pairs-with-thumbnail", "サムネと役割が分かれている", draft("pairs-with-thumbnail", "サムネとの役割分担", "サムネの文字と同じ言葉を繰り返さず、サムネの絵と合わせて1つの問いになる")),
      chip("honest-to-content", "中身と食い違わない", draft("honest-to-content", "中身と食い違わない", "動画の中で回収される約束だけを書き、見終わった人が釣りと感じない")),
    ]),
  }),
  character: Object.freeze({
    id: "character",
    label: "人物の設定画の候補",
    assetStage: "character",
    configurableRubric: true,
    rubricHome: "Channel Pack の asset-quality.json の stages.character",
    defaultRubricSource: "途中の成果物の品質ループ（人物の設定画）の採点表",
    chips: Object.freeze([
      chip("face-fits-role", "顔立ちが役柄に合う", draft("face-fits-role", "顔立ちが役柄に合う", "台本の役柄（年齢・立場・性格）が、顔立ちと表情だけで読み取れる")),
      chip("age-reads-right", "年齢感が合う", draft("age-reads-right", "年齢感", "台本の年齢に見え、若すぎ・老けすぎに見えない")),
      chip("distinct-silhouette", "他の人物と見分けやすい", draft("distinct-silhouette", "他の人物との見分けやすさ", "髪型・体つき・服のシルエットで、同じ回の他の人物と小さく写っても見分けられる")),
      chip("expressive-range", "表情に幅が出せそう", draft("expressive-range", "表情の幅", "喜怒哀楽の表情を描き分けても同じ人物に見える顔の作りになっている")),
      chip("art-style-fits", "画風がチャンネルに合う", existing("art-style-match")),
    ]),
  }),
  thumbnail: Object.freeze({
    id: "thumbnail",
    label: "サムネ",
    assetStage: "thumbnail",
    configurableRubric: true,
    rubricHome: "Channel Pack の asset-quality.json の stages.thumbnail",
    defaultRubricSource: "途中の成果物の品質ループ（サムネ）の採点表",
    chips: Object.freeze([
      chip("reads-instantly", "一瞬で読める", existing("readable-at-decided-size")),
      chip("strong-emotion", "人物の感情が強く出ている", draft("strong-emotion", "人物の感情の強さ", "主役の顔の感情（驚き・怒り・涙など）が、決定サイズで一目で分かる大きさと強さで出ている")),
      chip("situation-at-glance", "状況・対立が一目で分かる", draft("situation-at-glance", "状況が一目で分かる", "誰と誰が何で向き合っているかが、文字を読まなくても絵で分かる")),
      chip("lettering", "文字のデザインが良い", existing("lettering-design")),
      chip("stands-out-in-feed", "一覧で目立つ", draft("stands-out-in-feed", "一覧での目立ち", "関連動画の一覧に並べたとき、周りのサムネと色・明るさ・構図で埋もれない")),
      chip("not-too-busy", "情報が多すぎない", draft("not-too-busy", "情報の絞り込み", "見せ場が1つに絞られ、目で追う要素（人物・文字の塊・小物）が多すぎない")),
    ]),
  }),
  "scene-image": Object.freeze({
    id: "scene-image",
    label: "要の場面の画",
    assetStage: "scene-image",
    configurableRubric: true,
    rubricHome: "Channel Pack の asset-quality.json の stages.scene-image",
    defaultRubricSource: "途中の成果物の品質ループ（本編の画）の採点表",
    chips: Object.freeze([
      chip("scene-intent", "場面の意図が伝わる", existing("scene-intent-match")),
      chip("readable-composition", "構図が読みやすい", draft("readable-composition", "構図の読みやすさ", "視線が最初に主役へ行き、吹き出し・字幕を置く余白が主役の顔や手に掛からない")),
      chip("emotion-conveyed", "感情が伝わる", draft("emotion-conveyed", "感情の伝わり方", "人物の表情・身ぶり・距離で、その場面の感情が台詞なしでも伝わる")),
      chip("light-and-mood", "光と空気感が合う", draft("light-and-mood", "光と空気感", "時刻・天気・場面の気分に合った光と色で、前後の画と並べて浮かない")),
      chip("art-style-consistent", "画風が揃っている", existing("art-style-match")),
    ]),
  }),
});

export const HUMAN_CHOICE_STAGE_IDS = Object.freeze(Object.keys(HUMAN_CHOICE_STAGES));

const SET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const LABELS = Object.freeze(["A", "B", "C", "D", "E"]);
const PAGE_DIGEST = /^[a-f0-9]{16,64}$/u;
const MEDIA_KINDS = Object.freeze({
  image: new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]),
  audio: new Set([".wav", ".mp3", ".m4a", ".ogg", ".flac"]),
  video: new Set([".mp4", ".webm", ".mov", ".m4v"]),
  text: new Set([".txt", ".md", ".json"]),
});
const HUMAN_CHOICE_SCRIPT = fileURLToPath(new URL("../scripts/human-choice.mjs", import.meta.url));

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function chars(value) {
  return Array.from(String(value ?? "")).length;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 工程の宣言。ハーネスを渡すと、学習の宛先が無いハーネス・そのハーネスで使えない成果物の工程を拒否する。 */
export function humanChoiceStage(stage, harnessId = "") {
  const spec = HUMAN_CHOICE_STAGES[String(stage || "")];
  if (!spec) throw new Error(`並べて選ぶ工程ではない: ${stage}（${HUMAN_CHOICE_STAGE_IDS.join(" / ")}）。振り分けは routes で見る`);
  if (harnessId) {
    if (!HARNESS_LEARNING_ROUTES[harnessId]) {
      throw new Error(`未知のハーネス: ${harnessId}（${Object.keys(HARNESS_LEARNING_ROUTES).join(" / ")}）`);
    }
    if (spec.assetStage) assetQualityStage(spec.assetStage, assetQualityHarness(harnessId).id);
  }
  return spec;
}

/** 札の既定の評価項目（existing）の宣言。assetStage のある工程は成果物の採点表、企画の題材は企画の採点表。 */
export function humanChoiceDefaultRubric(stage) {
  const spec = humanChoiceStage(stage);
  if (spec.assetStage) return assetQualityStage(spec.assetStage).rubric.map((row) => ({ id: row.id, label: row.label }));
  if (spec.id === "strategy-topic") return STRATEGY_BRIEF_RUBRIC.map((row) => ({ id: row.id, label: row.label }));
  return [];
}

/**
 * 札を、採点表に足す候補にする（機械が読める形）。
 *   { chip, label, kind: "existing"|"draft", criterionId, criterionLabel, description?, rubricHome, configurableRubric }
 */
export function humanChoiceRubricProposal(stage, chipId) {
  const spec = humanChoiceStage(stage);
  const found = spec.chips.find((row) => row.id === chipId);
  if (!found) throw new Error(`工程 ${spec.id} の理由の札に無い: ${chipId}（${spec.chips.map((row) => row.id).join(" / ")}）`);
  if (found.existing) {
    const row = humanChoiceDefaultRubric(spec.id).find((entry) => entry.id === found.existing);
    return {
      chip: found.id,
      label: found.label,
      kind: "existing",
      criterionId: found.existing,
      criterionLabel: row?.label || found.existing,
      rubricHome: spec.rubricHome,
      configurableRubric: spec.configurableRubric,
    };
  }
  return {
    chip: found.id,
    label: found.label,
    kind: "draft",
    criterionId: found.draft.id,
    criterionLabel: found.draft.label,
    description: found.draft.description,
    rubricHome: spec.rubricHome,
    configurableRubric: spec.configurableRubric,
  };
}

export function humanChoicePaths(workDir, stage = "", setId = "") {
  if (!nonEmpty(workDir)) throw new Error("--work-dir に作業フォルダが要ります。");
  const root = path.resolve(workDir);
  const dir = path.join(root, HUMAN_CHOICE_DIR);
  if (!stage && !setId) return { workDir: root, dir };
  humanChoiceStage(stage);
  const set = nonEmpty(setId);
  if (!SET_ID.test(set)) throw new Error("--set に候補の組の id（英数字と . _ -、64文字まで）が要ります。");
  const base = `${stage}--${set}`;
  return {
    workDir: root,
    dir,
    statePath: path.join(dir, `${base}.json`),
    pagePath: path.join(dir, `${base}.html`),
  };
}

function workDirRelative(workDir, file, label) {
  if (!nonEmpty(file)) throw new Error(`${label} が要ります。`);
  const full = path.resolve(workDir, file);
  const rel = path.relative(workDir, full);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`${label} は作業フォルダの中に置いてください（状態は作業フォルダからの相対パスで残します）。`);
  }
  return { full, rel: rel.split(path.sep).join("/") };
}

async function candidateFileSha256(full, label) {
  let info;
  try {
    info = await lstat(full);
  } catch {
    throw new Error(`${label} が読めない。`);
  }
  if (info.isSymbolicLink()) throw new Error(`${label} はシンボリックリンク（作業フォルダの中の実物を指す）。`);
  if (!info.isFile() || info.size === 0) throw new Error(`${label} が空か、ファイルではない。`);
  return sha256(await readFile(full));
}

function mediaKind(rel) {
  const extension = path.extname(rel).toLowerCase();
  for (const [kind, extensions] of Object.entries(MEDIA_KINDS)) {
    if (extensions.has(extension)) return kind;
  }
  return "file";
}

function normalizedAxis(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/** 候補の一覧（create --candidates）を検める。返す値は並べる前の候補（入力の順）と推奨。 */
async function readCandidateInput({ workDir, input }) {
  if (!plainObject(input)) throw new Error("候補の一覧が JSON の object ではない。");
  if (input.version !== HUMAN_CHOICE_CANDIDATES_VERSION) throw new Error(`候補の一覧の version は ${HUMAN_CHOICE_CANDIDATES_VERSION}。`);
  const rows = Array.isArray(input.candidates) ? input.candidates : [];
  const { minCandidates, maxCandidates } = HUMAN_CHOICE_LIMITS;
  if (rows.length < minCandidates || rows.length > maxCandidates) {
    throw new Error(`候補は ${minCandidates}〜${maxCandidates} 案（目安 ${HUMAN_CHOICE_LIMITS.recommendedCandidates}）。1案なら並べて選ばず、1案に赤を入れる（routes を見る）。`);
  }
  const candidates = [];
  const axes = new Set();
  const digests = new Set();
  for (const [index, row] of rows.entries()) {
    const where = `candidates[${index}]`;
    if (!plainObject(row)) throw new Error(`${where} が object ではない。`);
    const axis = sanitizeEvidence(row.axis, 200);
    if (!axis) throw new Error(`${where}.axis（設計の軸）が要ります。同じ指示の乱数違いにせず、軸を分けて出す。`);
    if (chars(axis) > HUMAN_CHOICE_LIMITS.axisMaxChars) throw new Error(`${where}.axis は ${HUMAN_CHOICE_LIMITS.axisMaxChars} 文字まで。`);
    const axisKey = normalizedAxis(axis);
    if (axes.has(axisKey)) throw new Error(`${where}.axis「${axis}」が他の候補と同じ。候補ごとに設計の軸を分ける。`);
    axes.add(axisKey);
    const summary = sanitizeEvidence(row.summary, HUMAN_CHOICE_LIMITS.summaryMaxChars);
    const hasPath = nonEmpty(row.path);
    const hasText = typeof row.text === "string" && row.text.trim();
    if (Boolean(hasPath) === Boolean(hasText)) throw new Error(`${where} は path（ファイル）か text（文の候補）のどちらか1つ。`);
    let candidate;
    if (hasPath) {
      const file = workDirRelative(workDir, row.path, `${where}.path`);
      const digest = await candidateFileSha256(file.full, `${where}.path`);
      candidate = { kind: mediaKind(file.rel), path: file.rel, sha256: digest, axis, summary };
    } else {
      const text = String(row.text).replace(/\r\n?/gu, "\n").trim();
      if (chars(text) > HUMAN_CHOICE_LIMITS.textCandidateMaxChars) throw new Error(`${where}.text は ${HUMAN_CHOICE_LIMITS.textCandidateMaxChars} 文字まで。`);
      candidate = { kind: "text", text, sha256: sha256(text), axis, summary };
    }
    if (digests.has(candidate.sha256)) throw new Error(`${where} の中身が他の候補と同じ。`);
    digests.add(candidate.sha256);
    candidates.push(candidate);
  }
  let recommended = null;
  if (input.recommended !== undefined && input.recommended !== null) {
    if (!plainObject(input.recommended)) throw new Error("recommended は { index（1 から。一覧の順）, reason } の形。");
    const index = Number(input.recommended.index);
    if (!Number.isInteger(index) || index < 1 || index > candidates.length) throw new Error("recommended.index は 1 から候補の数まで（一覧の順）。");
    const reason = sanitizeEvidence(input.recommended.reason, HUMAN_CHOICE_LIMITS.recommendationReasonMaxChars);
    if (chars(reason) < 4) throw new Error("recommended.reason に、なぜその案を推すかを書く（お任せのときに人が読む）。");
    recommended = { index: index - 1, reason };
  }
  return { candidates, recommended };
}

/** 並べる順（生成の順・入力の順にしない）。組の id と中身の sha256 で決まるので、同じ組は同じ順になる。 */
function arrange(setKey, candidates) {
  return candidates
    .map((candidate, index) => ({ candidate, index, key: sha256(`${setKey}:${candidate.sha256}`) }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function setBody(state) {
  return {
    version: state.version,
    setId: state.setId,
    stage: state.stage,
    harnessId: state.harnessId,
    question: state.question,
    candidates: state.candidates,
    recommended: state.recommended,
    chips: state.chips,
  };
}

/** 候補の組の digest（ページが持ち、古いページの答えを記録しないために使う）。 */
export function humanChoiceSetDigest(state) {
  return sha256(canonicalJson(setBody(state)));
}

async function writeTextAtomic(file, text) {
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temp, text);
  await renameWithRetry(temp, file);
}

/**
 * 候補の組を作る（状態ファイルと、見せる1枚の HTML）。
 * 既に選択の記録がある組は作り直さない（restart と理由があれば、前の組を history に残して作り直す）。
 */
export async function createHumanChoiceSet({
  workDir,
  harnessId,
  stage,
  setId,
  question = "",
  input,
  restart = false,
  restartReason = "",
  now = () => new Date().toISOString(),
  scriptPath = HUMAN_CHOICE_SCRIPT,
} = {}) {
  if (!nonEmpty(harnessId)) throw new Error(`--harness が要ります（学習を積むチャンネルの台帳を決める。${Object.keys(HARNESS_LEARNING_ROUTES).join(" / ")}）。`);
  const spec = humanChoiceStage(stage, nonEmpty(harnessId));
  const paths = humanChoicePaths(workDir, spec.id, setId);
  const text = sanitizeEvidence(question || input?.question, HUMAN_CHOICE_LIMITS.questionMaxChars);
  if (chars(text) < 4) throw new Error("--question（または一覧の question）に、人に聞くこと（例: どの案で進めるか）を書く。");
  const { candidates, recommended } = await readCandidateInput({ workDir: paths.workDir, input });
  const arranged = arrange(`${spec.id}:${setId}`, candidates);
  const labelled = arranged.map((row, position) => ({ label: LABELS[position], ...row.candidate }));
  const recommendedLabel = recommended ? LABELS[arranged.findIndex((row) => row.index === recommended.index)] : "";
  return withCanvasFileLock(paths.statePath, async () => {
    const existing = await readJsonIfExists(paths.statePath, null);
    const history = Array.isArray(existing?.history) ? existing.history : [];
    if (existing && (existing.decisions || []).length > 0) {
      if (!restart) {
        return {
          created: false,
          issues: ["human-choice-set-already-decided"],
          detail: "この組には選択の記録がある。候補を出し直すなら create --restart --reason \"...\"（前の組と記録は history に残る）か、別の --set で作る",
          state: existing,
        };
      }
      if (chars(sanitizeEvidence(restartReason, 300)) < 4) throw new Error("--restart には --reason（なぜ候補を出し直すか）が要ります。");
    }
    const createdAt = new Date(now()).toISOString();
    const state = {
      version: HUMAN_CHOICE_VERSION,
      setId: nonEmpty(setId),
      stage: spec.id,
      harnessId: nonEmpty(harnessId),
      question: text,
      candidates: labelled,
      recommended: recommendedLabel ? { label: recommendedLabel, reason: recommended.reason } : null,
      chips: spec.chips.map((row) => ({ id: row.id, label: row.label })),
    };
    state.digest = humanChoiceSetDigest(state);
    state.createdAt = createdAt;
    state.pagePath = path.relative(paths.workDir, paths.pagePath).split(path.sep).join("/");
    state.decisions = [];
    state.history = existing
      ? [...history, {
        digest: existing.digest,
        createdAt: existing.createdAt,
        decisions: existing.decisions || [],
        replacedAt: createdAt,
        ...(existing.decisions?.length ? { reason: sanitizeEvidence(restartReason, 300) } : {}),
      }]
      : history;
    await writeJsonAtomic(paths.statePath, state);
    await writeTextAtomic(paths.pagePath, renderHumanChoicePage(state, { workDir: paths.workDir, pagePath: paths.pagePath, scriptPath }));
    return {
      created: true,
      state,
      pagePath: paths.pagePath,
      issues: [],
      detail: `候補 ${labelled.length} 案の組を作った（${spec.label}）。ページ ${state.pagePath} を人に開いてもらい、選んだ人が自分の端末でページのコマンドを打つ`
        + "（端末で聞かれながら答えるなら choose --reviewer <名前> --human-verified だけでよい）",
    };
  });
}

async function readState(paths) {
  const state = await readJsonIfExists(paths.statePath, null);
  if (state && state.version !== HUMAN_CHOICE_VERSION) throw new Error(`候補の組の状態の版が違う: ${state.version}`);
  return state;
}

/** 候補の組の状態（無ければ null）。 */
export async function readHumanChoiceSet({ workDir, stage, setId } = {}) {
  return readState(humanChoicePaths(workDir, humanChoiceStage(stage).id, setId));
}

/** 候補のバイト列が組を作ったときのままか（文の候補は状態に文ごと残っているので見ない）。 */
async function changedCandidates(workDir, state) {
  const changed = [];
  for (const candidate of state.candidates || []) {
    if (candidate.kind === "text") continue;
    let digest = "";
    try {
      digest = await candidateFileSha256(path.resolve(workDir, candidate.path), candidate.label);
    } catch {
      digest = "";
    }
    if (digest !== candidate.sha256) changed.push(candidate.label);
  }
  return changed;
}

/** 人の選択として数えるか。判定は scripts/harness-learn.mjs の attestationFor（一つの実装）。 */
async function choiceAttestation({ reviewer, isInteractive, agentAttested, humanVerified, attest }) {
  const attestationFor = attest || (await import("../scripts/harness-learn.mjs")).attestationFor;
  const verdict = attestationFor({ reviewer, isInteractive, agentAttested, humanVerified });
  if (!verdict.ok) throw new Error(verdict.message);
  return verdict.attestation;
}

function waiting(state, issues, detail) {
  return { recorded: false, counted: false, state, issues, detail };
}

/** 選んだ理由から、次の生成（直し・派生）の指示へ入れる一文。 */
function guidanceText(spec, candidate, reasons, note, delegated) {
  const why = delegated
    ? "お任せ（推奨の案）"
    : [reasons.map((row) => row.label).join("・"), note ? `一言「${note}」` : ""].filter(Boolean).join(" / ");
  return `${spec.label}は案 ${candidate.label}（設計の軸: ${candidate.axis}）で進める。理由: ${why}。`
    + "次の生成（直し・派生）の指示にこの方向と理由を入れる。採点表への反映は承認キューを通してから（Pack は自動で書き換えない）。";
}

/**
 * 人の選択を記録する。
 *   - pick（A〜E）か delegate（お任せ。推奨の案）のどちらか
 *   - reasons（理由の札の id。3つまで）か note（一言）の少なくとも一方（お任せは要らない）
 *   - pageDigest を渡したら、今の組の digest と照らす（候補の組が変わった後の古いページの答えを記録しない）
 *   - 候補のファイルが組を作ったときと違えば記録しない
 * 数えるのは human-verified だけ。それ以外（--agent-attested・対話端末でない主張）は記録するが数えず、学習にも積まない。
 * captureLearning（lib/humanChoiceLearning.mjs の captureHumanChoiceLearning の形）は、数える記録のときだけ呼ぶ。
 */
export async function recordHumanChoice({
  workDir,
  stage,
  setId,
  pick = "",
  delegate = false,
  reasons = [],
  note = "",
  pageDigest = "",
  reviewer = "",
  humanVerified = false,
  agentAttested = false,
  isInteractive = false,
  now = () => new Date().toISOString(),
  captureLearning = null,
  attest = null,
} = {}) {
  const spec = humanChoiceStage(stage);
  const paths = humanChoicePaths(workDir, spec.id, setId);
  const label = nonEmpty(pick).toUpperCase();
  if (label && delegate) throw new Error("--pick と --delegate は同時に使えません。");
  if (!label && !delegate) throw new Error("--pick <A〜E> か --delegate（お任せ。推奨の案）のどちらかが要ります。");
  const chipIds = [...new Set((Array.isArray(reasons) ? reasons : [reasons]).map((value) => nonEmpty(value)).filter(Boolean))];
  if (chipIds.length > HUMAN_CHOICE_LIMITS.maxReasonChips) {
    throw new Error(`理由の札は ${HUMAN_CHOICE_LIMITS.maxReasonChips} つまで（決め手を絞る）。`);
  }
  const reasonRows = chipIds.map((id) => humanChoiceRubricProposal(spec.id, id));
  const text = sanitizeEvidence(note, HUMAN_CHOICE_LIMITS.noteMaxChars);
  const digest = nonEmpty(pageDigest).toLowerCase();
  if (digest && !PAGE_DIGEST.test(digest)) throw new Error("--page-digest はページに書かれた 16 桁以上の16進数。");
  if (text && chars(text) < HUMAN_CHOICE_LIMITS.noteMinChars) throw new Error(`一言は ${HUMAN_CHOICE_LIMITS.noteMinChars} 文字以上で書く（空なら省く）。`);
  if (!delegate && reasonRows.length === 0 && !text) {
    throw new Error("選んだ理由が要ります（決め手の札 --chip <id> を1つ以上か、一言 --note \"...\"）。理由は次の生成と採点表の候補になる。");
  }
  const attestation = await choiceAttestation({ reviewer, isInteractive, agentAttested, humanVerified, attest });
  return withCanvasFileLock(paths.statePath, async () => {
    const existing = await readState(paths);
    if (!existing) return waiting(null, ["human-choice-set-not-found"], "先に create で候補の組を作る");
    if (existing.stage !== spec.id) throw new Error("状態ファイルの工程が --stage と違います。");
    if (digest && !existing.digest.startsWith(digest)) {
      return waiting(existing, ["human-choice-page-outdated"], "このページを作った後に候補の組が変わった。今のページを開き直して選ぶ（記録していない）");
    }
    const changed = await changedCandidates(paths.workDir, existing);
    if (changed.length > 0) {
      return waiting(existing, changed.map((value) => `human-choice-candidate-changed:${value}`),
        `候補 ${changed.join(", ")} のファイルが組を作ったときと違う。見比べたものと今のファイルが同じと言えないので記録しない。候補を出し直すなら create --restart`);
    }
    let candidate;
    if (delegate) {
      if (!existing.recommended?.label) {
        return waiting(existing, ["human-choice-no-recommendation"], "この組には推奨の案が無いので、お任せにできない。--pick で選ぶ");
      }
      candidate = existing.candidates.find((row) => row.label === existing.recommended.label);
    } else {
      candidate = existing.candidates.find((row) => row.label === label);
      if (!candidate) throw new Error(`候補 ${label} はこの組に無い（${existing.candidates.map((row) => row.label).join(" / ")}）。`);
    }
    const counted = attestation.attestedBy === HUMAN_CHOICE_HUMAN_VERIFIED;
    const decidedAt = new Date(now()).toISOString();
    const decision = {
      index: (existing.decisions || []).length + 1,
      decidedAt,
      reviewer: attestation.reviewer,
      attestedBy: attestation.attestedBy,
      ...(attestation.claimedReviewer ? { claimedReviewer: attestation.claimedReviewer } : {}),
      counted,
      delegated: Boolean(delegate),
      setDigest: existing.digest,
      pick: {
        label: candidate.label,
        kind: candidate.kind,
        sha256: candidate.sha256,
        axis: candidate.axis,
        ...(candidate.path ? { path: candidate.path } : {}),
      },
      reasons: reasonRows,
      ...(text ? { note: text } : {}),
      guidance: guidanceText(spec, candidate, reasonRows, text, Boolean(delegate)),
    };
    let next = { ...existing, decisions: [...(existing.decisions || []), decision] };
    await writeJsonAtomic(paths.statePath, next);
    let learning = null;
    // 学習に積むのは、数える人の選択（human-verified）だけ。機械の記録・主張だけの記録からは積まない。
    if (counted && typeof captureLearning === "function") {
      try {
        learning = await captureLearning({ state: next, decision, workDir: paths.workDir });
      } catch (error) {
        learning = { captured: 0, skippedReason: "capture-failed", detail: sanitizeEvidence(error?.message || String(error), 200) };
      }
      const summary = learningSummary(learning);
      if (summary) {
        next = { ...next, decisions: next.decisions.map((row) => (row.index === decision.index ? { ...row, learning: summary } : row)) };
        await writeJsonAtomic(paths.statePath, next);
      }
    }
    return {
      recorded: true,
      counted,
      decision: next.decisions.at(-1),
      state: next,
      learning,
      issues: counted ? [] : [`human-choice-not-counted:${attestation.attestedBy}`],
      detail: counted
        ? `人の選択（案 ${candidate.label}${delegate ? "・お任せ" : ""}）を記録した。${decision.guidance}`
        : `記録は ${attestation.attestedBy} として残したが、人の選択には数えない（学習にも積まない）。選んだ人が自分の端末から --human-verified を付けて打つ`,
    };
  });
}

function learningSummary(learning) {
  if (!learning || typeof learning !== "object") return null;
  const out = {
    captured: Number(learning.captured) || 0,
    duplicates: Number(learning.duplicates) || 0,
    ...(learning.target ? { target: String(learning.target) } : {}),
    ...(learning.channelId ? { channelId: String(learning.channelId) } : {}),
    ...(Array.isArray(learning.proposalIds) && learning.proposalIds.length > 0 ? { proposalIds: learning.proposalIds.map(String) } : {}),
    ...(learning.skippedReason ? { skippedReason: String(learning.skippedReason) } : {}),
  };
  return out;
}

/**
 * 組の今の状態。pass は、数える人の選択（human-verified）があり、選んだ候補のファイルが今も同じときだけ。
 * 後の選択が前の選択に代わる（人が選び直してよい）。
 */
export async function humanChoiceStatus({ workDir, stage, setId } = {}) {
  const spec = humanChoiceStage(stage);
  const paths = humanChoicePaths(workDir, spec.id, setId);
  const state = await readState(paths);
  if (!state) return { started: false, pass: false, issues: ["human-choice-set-not-found"], detail: "候補の組が無い（create で作る）" };
  const decisions = state.decisions || [];
  const latest = decisions.at(-1) || null;
  const latestCounted = [...decisions].reverse().find((row) => row.counted) || null;
  const changed = await changedCandidates(paths.workDir, state);
  const pickedChanged = latestCounted ? changed.includes(latestCounted.pick.label) : false;
  const issues = [];
  if (!latestCounted) issues.push(latest ? `human-choice-not-counted:${latest.attestedBy}` : "human-choice-awaiting-human");
  if (pickedChanged) issues.push(`human-choice-picked-candidate-changed:${latestCounted.pick.label}`);
  const pass = Boolean(latestCounted) && !pickedChanged;
  return {
    started: true,
    pass,
    stage: spec.id,
    setId: state.setId,
    harnessId: state.harnessId,
    digest: state.digest,
    pagePath: state.pagePath,
    candidates: state.candidates.map((row) => ({ label: row.label, kind: row.kind, axis: row.axis, sha256: row.sha256, ...(row.path ? { path: row.path } : {}) })),
    recommended: state.recommended,
    choice: latestCounted,
    latest,
    changedCandidates: changed,
    issues,
    detail: pass
      ? `人が選んだ案: ${latestCounted.pick.label}（${latestCounted.pick.axis}）。${latestCounted.guidance}`
      : latestCounted
        ? `人が選んだ案 ${latestCounted.pick.label} のファイルが選んだときと違う。選び直すか、候補を出し直す`
        : `人の選択を待っている。ページ ${state.pagePath} を開いてもらい、選んだ人が自分の端末から --human-verified で記録する`,
  };
}

/** 作業フォルダの候補の組の一覧（壊れた状態ファイルは issues に出して飛ばす）。 */
export async function listHumanChoiceSets({ workDir, stage = "" } = {}) {
  const paths = humanChoicePaths(workDir);
  let names = [];
  try {
    names = (await readdir(paths.dir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return { started: false, entries: [], issues: [] };
  }
  const entries = [];
  const issues = [];
  for (const name of names) {
    const [stageId, ...rest] = name.slice(0, -".json".length).split("--");
    const set = rest.join("--");
    if (!HUMAN_CHOICE_STAGES[stageId] || !SET_ID.test(set)) continue;
    if (stage && stageId !== stage) continue;
    try {
      const status = await humanChoiceStatus({ workDir, stage: stageId, setId: set });
      entries.push({ stage: stageId, setId: set, pass: status.pass, choice: status.choice?.pick?.label || "", issues: status.issues });
    } catch (error) {
      issues.push(`human-choice-state-unreadable:${stageId}--${set}`);
      entries.push({ stage: stageId, setId: set, pass: false, choice: "", issues: [sanitizeEvidence(error?.message, 200)] });
    }
  }
  return { started: entries.length > 0, entries, issues };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function relativeUrl(fromDir, target) {
  return path.relative(fromDir, target).split(path.sep).map((part) => encodeURIComponent(part)).join("/");
}

function candidateMedia(candidate, { workDir, pageDir }) {
  if (candidate.kind === "text") return `<div class="text">${escapeHtml(candidate.text)}</div>`;
  const url = relativeUrl(pageDir, path.resolve(workDir, candidate.path));
  const name = escapeHtml(candidate.path);
  if (candidate.kind === "image") return `<img src="${url}" alt="候補 ${candidate.label}: ${name}" loading="lazy">`;
  if (candidate.kind === "audio") return `<audio controls preload="none" src="${url}"></audio><p class="file">${name}</p>`;
  if (candidate.kind === "video") return `<video controls preload="metadata" src="${url}"></video><p class="file">${name}</p>`;
  return `<p class="file"><a href="${url}">${name}</a>（開いて見る）</p>`;
}

/**
 * 見せる1枚の HTML。外部の読み込みは無い（CSP で閉じる）。ページは答えのコマンドを組み立てるだけで、
 * 何も保存しない・どこにも送らない。記録は選んだ人が自分の端末でコマンドを打ったときだけ。
 */
export function renderHumanChoicePage(state, { workDir, pagePath, scriptPath = HUMAN_CHOICE_SCRIPT } = {}) {
  const spec = humanChoiceStage(state.stage);
  const pageDir = path.dirname(pagePath);
  const cards = state.candidates.map((candidate) => `
      <label class="card">
        <input type="radio" name="pick" value="${candidate.label}">
        <span class="head"><b>${candidate.label}</b> <span class="axis">${escapeHtml(candidate.axis)}</span></span>
        ${candidateMedia(candidate, { workDir, pageDir })}
        ${candidate.summary ? `<span class="summary">${escapeHtml(candidate.summary)}</span>` : ""}
      </label>`).join("");
  const delegate = state.recommended
    ? `<label class="delegate"><input type="radio" name="pick" value="delegate"> お任せ（推奨の ${state.recommended.label} で進める。推奨の理由: ${escapeHtml(state.recommended.reason)}）</label>`
    : "";
  const chips = state.chips.map((row) => `<label class="chip"><input type="checkbox" name="chip" value="${escapeHtml(row.id)}"> ${escapeHtml(row.label)}</label>`).join("");
  const config = {
    script: scriptPath,
    workDir,
    stage: state.stage,
    setId: state.setId,
    digest: state.digest.slice(0, 16),
    maxReasons: HUMAN_CHOICE_LIMITS.maxReasonChips,
  };
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data: 'self'; media-src file: 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>人の選択: ${escapeHtml(spec.label)}</title>
<style>
:root { --bg: #f6f4ef; --fg: #1b1b1b; --card: #ffffff; --line: #d9d4ca; --accent: #1f5fbf; --muted: #5d5a55; }
@media (prefers-color-scheme: dark) { :root { --bg: #17181a; --fg: #ececec; --card: #232427; --line: #3a3b3f; --accent: #7fb0ff; --muted: #a8a6a2; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic UI", "Noto Sans JP", sans-serif; line-height: 1.6; }
main { max-width: 1280px; margin: 0 auto; }
h1 { font-size: 1.3rem; margin: 0 0 4px; }
.lead { color: var(--muted); margin: 0 0 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
.card { display: grid; gap: 8px; align-content: start; background: var(--card); border: 2px solid var(--line); border-radius: 12px; padding: 12px; cursor: pointer; }
.card:has(input:checked) { border-color: var(--accent); }
.card img, .card video { width: 100%; height: auto; border-radius: 6px; background: #000; }
.card audio { width: 100%; }
.head { display: flex; gap: 8px; align-items: baseline; }
.head b { font-size: 1.2rem; }
.axis { font-weight: 600; }
.summary, .file { color: var(--muted); font-size: 0.9rem; }
.text { white-space: pre-wrap; font-size: 1.05rem; }
section { margin-top: 24px; }
.delegate { display: block; margin-top: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { border: 1px solid var(--line); border-radius: 999px; padding: 6px 12px; background: var(--card); cursor: pointer; }
.chip:has(input:checked) { border-color: var(--accent); color: var(--accent); }
textarea, input[type="text"] { width: 100%; font: inherit; padding: 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); }
pre { white-space: pre-wrap; word-break: break-all; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }
.warn { color: #b3261e; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(state.question)}</h1>
  <p class="lead">${escapeHtml(spec.label)}の候補 ${state.candidates.length} 案（設計の軸を分けてある）。1つ選び、決め手を ${HUMAN_CHOICE_LIMITS.maxReasonChips} つまで選ぶ。一言は任意。選んだ理由は、このチャンネルの採点表に足す候補として承認待ちの一覧に積まれる（採点表は自動では変わらない）。</p>
  <div class="grid">${cards}
  </div>
  ${delegate}
  <section>
    <h2>決め手（${HUMAN_CHOICE_LIMITS.maxReasonChips} つまで）</h2>
    <div class="chips">${chips}</div>
  </section>
  <section>
    <h2>一言（任意）</h2>
    <textarea id="note" rows="2" maxlength="${HUMAN_CHOICE_LIMITS.noteMaxChars}" placeholder="例: 表情がいちばん強い"></textarea>
  </section>
  <section>
    <h2>あなたの名前</h2>
    <input id="reviewer" type="text" autocomplete="off" placeholder="記録に残る名前">
  </section>
  <section>
    <h2>自分の端末で打つコマンド</h2>
    <p class="lead">このページは何も保存しない。下のコマンドを自分の端末に貼って打つと記録される（自分の端末から --human-verified を付けた記録だけが人の選択に数える）。</p>
    <p id="warn" class="warn"></p>
    <pre id="command"></pre>
    <button id="copy" type="button">コピー</button>
  </section>
</main>
<script>
const CONFIG = ${JSON.stringify(config).replaceAll("<", "\\u003c")};
const windows = /Windows/i.test(navigator.userAgent);
const quote = (value) => windows ? "'" + String(value).replace(/'/g, "''") + "'" : "'" + String(value).replace(/'/g, "'\\\\''") + "'";
function build() {
  const pick = document.querySelector('input[name="pick"]:checked');
  const reasons = [...document.querySelectorAll('input[name="chip"]:checked')].map((node) => node.value);
  const note = document.getElementById("note").value.replace(/\\s+/g, " ").trim();
  const reviewer = document.getElementById("reviewer").value.trim();
  const warn = [];
  if (!pick) warn.push("案を1つ選ぶ");
  if (reasons.length > CONFIG.maxReasons) warn.push("決め手は " + CONFIG.maxReasons + " つまで");
  if (pick && pick.value !== "delegate" && reasons.length === 0 && note.length < 4) warn.push("決め手を1つ以上選ぶか、一言を書く");
  if (!reviewer) warn.push("名前を書く");
  const parts = ["node", quote(CONFIG.script), "choose", "--work-dir", quote(CONFIG.workDir), "--stage", CONFIG.stage, "--set", quote(CONFIG.setId), "--page-digest", CONFIG.digest];
  if (pick) parts.push(...(pick.value === "delegate" ? ["--delegate"] : ["--pick", pick.value]));
  for (const reason of reasons) parts.push("--chip", reason);
  if (note) parts.push("--note", quote(note));
  parts.push("--reviewer", quote(reviewer || "名前"), "--human-verified");
  document.getElementById("warn").textContent = warn.join(" / ");
  document.getElementById("command").textContent = parts.join(" ");
}
document.addEventListener("input", build);
document.addEventListener("change", build);
document.getElementById("copy").addEventListener("click", async () => {
  const text = document.getElementById("command").textContent;
  try { await navigator.clipboard.writeText(text); } catch { /* コピーできない環境では、コマンドを選んで手でコピーする */ }
});
build();
</script>
</body>
</html>
`;
}
