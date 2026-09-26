/**
 * ナレーション物語の台本の受け口（ジャンル層）。
 *
 * 公式経路が受け取る台本は3形式:
 *   - 台本パッケージ（script-package.json、`buzzassist-narrated-script-package-v1`）: 本編・感想・話者・
 *     読み・BGM の区分・場面の意図・場面のカメラ（型 camera と、本編の場面の焦点 cameraFocus）を機械が読める
 *     形で持つ。台本スキルの正式な出力。焦点は画に属する値なので、画の後で決める焦点は運営者の画の取り込みの
 *     記録（lib/operatorImageImport.mjs）の行に書く。台本パッケージに書き足すとバイト列が変わり、台本の品質
 *     ループの合格が外れる。両方に書いて値が違えば有料生成の前に止まる（lib/narratedStoryCamera.mjs の
 *     applyNarratedSceneCameraFocus）
 *   - Markdown（script.md）: 見出しは声にしない。どの見出しの下が本編・感想かは Channel Pack の
 *     `scriptIntake.markdown` で宣言する（宣言が無ければ推測せず止める）
 *   - 生テキスト: 従来どおり全行を語りにする（見出しらしい行があれば止める）
 *
 * 以前は生テキストしか読まず、script.md をそのまま渡すと見出し・タイトル案・運営者向けの注記まで
 * 声と字幕になった。変換器は運営者の私有側にしか無かった。
 *
 * ここはジャンル共通の形だけを持つ。役名・声・曲・区切り行の文言などチャンネル固有の値は
 * Channel Pack と台本パッケージが持ち、ここには1つも書かない。
 *
 * 台本は Job が SHA-256 で束縛したファイル1つ。パッケージの中身（本編・感想・話者・読み・区分・
 * 場面の意図）はそのファイルの SHA で束縛され、パッケージが指す script.md は `sourceMarkdown.sha256`
 * として生成記録に残す。
 *
 * 感想パートの声: Pack が `bookends.review.voice: "none"` を宣言したら、感想の文は全部字幕だけ（声の Media Job を
 * 作らない）。字幕の秒数は文の captionOnlySeconds か、無ければ読む速さの既定（narratedVoicelessCaptionSeconds）。
 * 感想の文に話者・読み（声への指定）が書かれていれば、宣言と食い違うので有料生成の前に止める
 * （review-voice-none-mismatch:<speaker|reading>:<文の id>）。3形式（パッケージ・Markdown・生テキスト）で同じ。
 */

import { createHash } from "node:crypto";
import { extname } from "node:path";

import { OPERATOR_REPLACEMENT_MARKER, narratedReviewVoiceless, operatorReplacementSegments } from "./narratedStoryBookends.mjs";
import { NARRATED_CAMERA_MOVES, normalizeNarratedCameraFocus } from "./narratedStoryCamera.mjs";
import { NARRATED_REVIEW_LAYOUTS } from "./narratedStoryReviewLayout.mjs";
import { createNarratedRoleResolver } from "./narratedStoryCast.mjs";
import { planNarratedMusicBlocks } from "./narratedStoryMusicPlan.mjs";

export const NARRATED_SCRIPT_PACKAGE_FORMAT = "buzzassist-narrated-script-package-v1";
/** 台本パッケージで、地の文を読む話者の id（予約語）。Channel Pack の語りの声で読む。 */
export const NARRATED_NARRATOR_SPEAKER_ID = "narrator";
/** 語りの役の id（予約語）。Pack の `voice` がこの役の声。 */
export const NARRATED_NARRATOR_ROLE = "narrator";

/** スキーマ（config/narrated-story-script-package.schema.json）と同じ項目の一覧。試験が突き合わせる。 */
export const NARRATED_SCRIPT_PACKAGE_FIELDS = Object.freeze({
  top: Object.freeze(["format", "title", "sourceMarkdown", "speakers", "story", "reviewMarker", "review", "readings"]),
  sourceMarkdown: Object.freeze(["sha256", "bytes"]),
  speaker: Object.freeze(["id", "castRole"]),
  storySegment: Object.freeze(["id", "text", "speaker", "sceneIntent", "musicSection", "camera", "cameraFocus"]),
  reviewSegment: Object.freeze(["id", "text", "speaker", "sceneIntent", "operatorReplacementRequired", "camera", "layout", "tvScene", "captionOnlySeconds"]),
  reading: Object.freeze(["segmentId", "display", "spoken"]),
});

const PACKAGE_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const ROLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u;
const TERMINAL_PUNCTUATION = /[。！？!?]/u;
const CLOSING_PUNCTUATION = /[」』）】〉》〕］}]/u;
const MAX_TEXT = 2_000;

/** 字幕だけの文の秒数の範囲（台本パッケージの captionOnlySeconds と、声なしの感想の既定の秒数の両方）。 */
export const NARRATED_CAPTION_ONLY_SECONDS = Object.freeze({ minimum: 0.5, maximum: 30 });
/**
 * 声なしの感想パート（Pack の bookends.review.voice: none）で、台本が captionOnlySeconds を書かなかった文の
 * 字幕の秒数の既定（方針値。実測から決めた値ではない）。
 * - 読む速さ: 日本語の字幕翻訳で広く使われる「1秒4文字」の目安。語りが無く、字幕だけで読み切る文なので、
 *   語りの速さ（1秒あたり 6〜8 字前後）ではなく字幕を読む速さで取る。空白は数えず、句読点・括弧は数える
 *   （画面の上で字の場所を取り、読む目が止まるため）
 * - 下限 1.5 秒: 短い文（「ありがとうございました。」など）でも、字幕が出たことに気付いてから読み終えるまでの
 *   間を取る（4 字/秒で 6 字ぶん）
 * - 0.1 秒単位で切り上げる（読む速さを下回らない側）。上限（30 秒＝120 字ぶん）を越える文は、黙って縮めず
 *   有料生成の前に止める（台本で文を分けるか、captionOnlySeconds を書く）
 * 秒数を変えたいときは、台本パッケージの感想の文に captionOnlySeconds を書く（そちらが優先）。
 */
export const NARRATED_VOICELESS_CAPTION_CHARACTERS_PER_SECOND = 4;
export const NARRATED_VOICELESS_CAPTION_MIN_SECONDS = 1.5;

/** 声なしの感想の文の、字幕を出す秒数の既定（上限を越えれば null）。 */
export function narratedVoicelessCaptionSeconds(text) {
  const characters = [...String(text ?? "").replace(/\s/gu, "")].length;
  const seconds = Math.max(
    NARRATED_VOICELESS_CAPTION_MIN_SECONDS,
    Math.ceil((characters / NARRATED_VOICELESS_CAPTION_CHARACTERS_PER_SECOND) * 10 - 1e-9) / 10,
  );
  return seconds <= NARRATED_CAPTION_ONLY_SECONDS.maximum ? seconds : null;
}

/**
 * 字幕だけの文（声を作らない。宣言の秒数の無音を声の代わりに置き、字幕と BGM だけで進む）の segment。
 * captionSecondsBasis は秒数の出どころ（declared: 台本の captionOnlySeconds / reading-speed: 声なしの感想の既定）。
 */
function captionOnlySegment({ id, text, plainText, part, source, speakerId = "", seconds, basis }) {
  return {
    id,
    text,
    textHash: sha256(text),
    characterCount: [...plainText].length,
    part,
    sourceSegmentId: source.id,
    imageKey: source.id,
    imagePrompt: source.sceneIntent ? `${source.sceneIntent}\n${source.text}` : source.text,
    ...(speakerId ? { speakerId } : {}),
    delivery: "caption-only",
    captionOnly: true,
    captionOnlySeconds: seconds,
    ...(basis === "reading-speed" ? { captionSecondsBasis: basis } : {}),
    ...(source.camera ? { cameraMove: source.camera } : {}),
    // 場面の焦点は場面の全部の文に同じ値で付ける（話者・文ごとに分けても1つのショットで通す）。
    ...(source.cameraFocus ? { cameraFocus: { ...source.cameraFocus } } : {}),
    ...(source.layout ? { reviewLayout: source.layout } : {}),
    ...(source.tvScene ? { tvScene: source.tvScene } : {}),
  };
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** 地の文の文分割（Core の生テキスト分割と同じ規則。閉じ括弧は前の文に付ける）。 */
export function splitNarrationSentences(text) {
  const output = [];
  let current = "";
  let terminalSeen = false;
  for (const character of String(text ?? "")) {
    if (terminalSeen && !CLOSING_PUNCTUATION.test(character)) {
      if (current.trim()) output.push(current.trim());
      current = "";
      terminalSeen = false;
    }
    current += character;
    if (TERMINAL_PUNCTUATION.test(character)) terminalSeen = true;
  }
  if (current.trim()) output.push(current.trim());
  return output;
}

/**
 * 1つのセグメントの本文を、話者の台詞（「」の中）と地の文に分ける。
 * - 話者が語り手なら全文が地の文（語り手が引用を読む）
 * - 話者が登場人物で「」があれば、「」の部分が台詞、それ以外が地の文
 * - 話者が登場人物で「」が無ければ全文がその話者の台詞（感想パートの案内役など）
 * 『』は画面に映る文字などに使うので台詞として扱わない。
 */
export function splitSpeakerTurns(text, { dialogue = false } = {}) {
  const source = String(text ?? "").trim();
  if (!dialogue) return [{ kind: "narration", text: source }];
  if (!source.includes("「")) return [{ kind: "dialogue", text: source }];
  const turns = [];
  let depth = 0;
  let current = "";
  let currentKind = "narration";
  const flush = () => {
    if (current.trim()) turns.push({ kind: currentKind, text: current.trim() });
    current = "";
  };
  for (const character of source) {
    if (character === "「") {
      if (depth === 0) {
        flush();
        currentKind = "dialogue";
      }
      depth += 1;
      current += character;
      continue;
    }
    current += character;
    if (character === "」" && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        flush();
        currentKind = "narration";
      }
    }
  }
  flush();
  return turns;
}

/** 読みの指定を本文へ当てる（表示はそのまま、声に渡す文だけを変える）。 */
function applyReadings(text, readings) {
  let spoken = text;
  for (const reading of readings) spoken = spoken.split(reading.display).join(reading.spoken);
  return spoken;
}

function detectFormat(script, scriptPath) {
  const trimmed = String(script ?? "").trim();
  const extension = extname(String(scriptPath || "")).toLowerCase();
  if (extension === ".json" || trimmed.startsWith("{")) return "script-package";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  if (trimmed.split("\n").some((line) => HEADING.test(line.trim()))) return "markdown";
  return "raw-text";
}

function normalizeHeading(value) {
  return nonEmpty(value).replace(/^#+\s*/u, "").trim();
}

/**
 * Channel Pack の `scriptIntake`（任意）。Markdown の台本を受けるときに、どの見出しの下が
 * 本編・感想かを宣言する。見出しの文言はチャンネル固有なので Pack が持つ。
 */
export function normalizeNarratedScriptIntakeConfig(source) {
  if (source === undefined || source === null) return { config: { markdown: null }, blockers: [] };
  if (!plainObject(source)) return { config: { markdown: null }, blockers: ["scriptIntake"] };
  const blockers = [];
  const unknown = Object.keys(source).filter((key) => key !== "markdown");
  for (const key of unknown) blockers.push(`scriptIntake.${key}-unknown`);
  let markdown = null;
  if (source.markdown !== undefined) {
    if (!plainObject(source.markdown)) blockers.push("scriptIntake.markdown");
    else {
      for (const key of Object.keys(source.markdown)) {
        if (!["storyHeading", "reviewHeading"].includes(key)) blockers.push(`scriptIntake.markdown.${key}-unknown`);
      }
      const storyHeading = normalizeHeading(source.markdown.storyHeading);
      const reviewHeading = normalizeHeading(source.markdown.reviewHeading);
      if (!storyHeading) blockers.push("scriptIntake.markdown.storyHeading");
      if (source.markdown.reviewHeading !== undefined && !reviewHeading) blockers.push("scriptIntake.markdown.reviewHeading");
      markdown = { storyHeading, reviewHeading };
    }
  }
  return { config: { markdown }, blockers };
}

/**
 * Markdown の台本から、宣言した見出しの下の本文だけを取り出す。見出し・下位見出し・
 * HTML コメント・引用（> で始まる注記）は声にしない。
 */
export function extractMarkdownSections(markdown, { storyHeading, reviewHeading = "" } = {}) {
  const lines = String(markdown ?? "").replaceAll("\r", "").replace(/<!--[\s\S]*?-->/gu, "").split("\n");
  const sections = { story: null, review: null };
  let current = null;
  let currentLevel = 0;
  for (const raw of lines) {
    const line = raw.trim();
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      if (current && level > currentLevel) continue;
      current = null;
      if (title === storyHeading && sections.story === null) {
        current = "story";
        currentLevel = level;
        sections.story = [];
      } else if (reviewHeading && title === reviewHeading && sections.review === null) {
        current = "review";
        currentLevel = level;
        sections.review = [];
      }
      continue;
    }
    if (!current || !line || line.startsWith(">")) continue;
    sections[current].push(line);
  }
  return sections;
}

function issue(stage, issues) {
  return { stage, issues, storySegments: [], reviewSegments: [] };
}

/** 台本パッケージの形を検査する。問題は issue の文字列で返す（有料生成の前に止める材料）。 */
export function validateNarratedScriptPackage(pkg) {
  const problems = [];
  const add = (code) => problems.push(`script-package-invalid:${code}`);
  if (!plainObject(pkg)) return { ok: false, problems: ["script-package-invalid:not-an-object"] };
  if (pkg.format !== NARRATED_SCRIPT_PACKAGE_FORMAT) {
    return { ok: false, problems: [`script-package-format-unsupported:${nonEmpty(pkg.format) || "missing"}`] };
  }
  for (const key of Object.keys(pkg)) if (!NARRATED_SCRIPT_PACKAGE_FIELDS.top.includes(key)) add(`${key}-unknown`);
  if (pkg.title !== undefined && (typeof pkg.title !== "string" || pkg.title.length > MAX_TEXT)) add("title");
  if (pkg.sourceMarkdown !== undefined) {
    if (!plainObject(pkg.sourceMarkdown)) add("sourceMarkdown");
    else {
      for (const key of Object.keys(pkg.sourceMarkdown)) if (!NARRATED_SCRIPT_PACKAGE_FIELDS.sourceMarkdown.includes(key)) add(`sourceMarkdown.${key}-unknown`);
      if (!SHA256_HEX.test(String(pkg.sourceMarkdown.sha256 || ""))) add("sourceMarkdown.sha256");
      if (pkg.sourceMarkdown.bytes !== undefined && !(Number.isSafeInteger(pkg.sourceMarkdown.bytes) && pkg.sourceMarkdown.bytes > 0)) add("sourceMarkdown.bytes");
    }
  }
  const speakers = new Map([[NARRATED_NARRATOR_SPEAKER_ID, NARRATED_NARRATOR_ROLE]]);
  if (pkg.speakers !== undefined) {
    if (!Array.isArray(pkg.speakers)) add("speakers");
    else {
      pkg.speakers.forEach((speaker, index) => {
        if (!plainObject(speaker)) { add(`speakers[${index}]`); return; }
        for (const key of Object.keys(speaker)) if (!NARRATED_SCRIPT_PACKAGE_FIELDS.speaker.includes(key)) add(`speakers[${index}].${key}-unknown`);
        const id = nonEmpty(speaker.id);
        const role = nonEmpty(speaker.castRole);
        if (!PACKAGE_ID.test(id)) add(`speakers[${index}].id`);
        else if (speakers.has(id)) add(`speakers[${index}].id-duplicated`);
        if (!ROLE_ID.test(role)) add(`speakers[${index}].castRole`);
        if (PACKAGE_ID.test(id) && !speakers.has(id) && ROLE_ID.test(role)) speakers.set(id, role);
      });
    }
  }
  const ids = new Set();
  const checkSegments = (list, label, fields) => {
    if (!Array.isArray(list)) {
      if (list !== undefined) add(label);
      return [];
    }
    return list.map((segment, index) => {
      const at = `${label}[${index}]`;
      if (!plainObject(segment)) { add(at); return null; }
      for (const key of Object.keys(segment)) if (!fields.includes(key)) add(`${at}.${key}-unknown`);
      const id = nonEmpty(segment.id);
      if (!PACKAGE_ID.test(id)) add(`${at}.id`);
      else if (ids.has(id)) add(`${at}.id-duplicated`);
      else ids.add(id);
      const text = typeof segment.text === "string" ? segment.text.trim() : "";
      if (!text) add(`${at}.text`);
      else if (/[\r\n]/u.test(text)) add(`${at}.text-line-break`);
      else if (text.startsWith("#")) add(`${at}.text-heading-mark`);
      else if ([...text].length > MAX_TEXT) add(`${at}.text-too-long`);
      const speaker = segment.speaker === undefined ? NARRATED_NARRATOR_SPEAKER_ID : nonEmpty(segment.speaker);
      if (!speakers.has(speaker)) add(`${at}.speaker-undeclared`);
      if (segment.sceneIntent !== undefined && (typeof segment.sceneIntent !== "string" || [...segment.sceneIntent].length > MAX_TEXT)) {
        add(`${at}.sceneIntent`);
      }
      if (segment.musicSection !== undefined && !ROLE_ID.test(nonEmpty(segment.musicSection))) add(`${at}.musicSection`);
      if (segment.operatorReplacementRequired !== undefined && typeof segment.operatorReplacementRequired !== "boolean") {
        add(`${at}.operatorReplacementRequired`);
      }
      // 場面のカメラの型（Channel Pack の camera.moves に宣言した型。宣言の照合は見た目の計画で行う）。
      if (segment.camera !== undefined && !NARRATED_CAMERA_MOVES.includes(nonEmpty(segment.camera))) add(`${at}.camera`);
      // 場面ごとの焦点（本編の場面だけ。画の中の顔の位置など { x, y }、0〜1。lib/narratedStoryCamera.mjs）。
      // 感想の文には欄が無い（上の知らない欄の検査で止まる）。
      const focus = fields.includes("cameraFocus") ? normalizeNarratedCameraFocus(segment.cameraFocus) : { focus: null, problem: "" };
      if (focus.problem) add(`${at}.${focus.problem}`);
      // 感想パートの配置の型と、TV の中に出す本編の場面（lib/narratedStoryReviewLayout.mjs）。
      if (segment.layout !== undefined && !NARRATED_REVIEW_LAYOUTS.includes(nonEmpty(segment.layout))) add(`${at}.layout`);
      if (segment.tvScene !== undefined && !PACKAGE_ID.test(nonEmpty(segment.tvScene))) add(`${at}.tvScene`);
      // 声を作らず字幕だけを出す文の秒数（0.5〜30）。
      const captionOnlySeconds = segment.captionOnlySeconds === undefined ? null : Number(segment.captionOnlySeconds);
      const captionOnlyValid = Number.isFinite(captionOnlySeconds)
        && captionOnlySeconds >= NARRATED_CAPTION_ONLY_SECONDS.minimum && captionOnlySeconds <= NARRATED_CAPTION_ONLY_SECONDS.maximum;
      if (segment.captionOnlySeconds !== undefined && !captionOnlyValid) add(`${at}.captionOnlySeconds`);
      return {
        id,
        text,
        speaker,
        // 話者を台本が書いたか（書かなければ語り手）。声なしの感想パートとの食い違いの判定に使う。
        speakerDeclared: segment.speaker !== undefined,
        sceneIntent: nonEmpty(segment.sceneIntent),
        musicSection: nonEmpty(segment.musicSection),
        operatorReplacementRequired: segment.operatorReplacementRequired === true,
        camera: NARRATED_CAMERA_MOVES.includes(nonEmpty(segment.camera)) ? nonEmpty(segment.camera) : "",
        cameraFocus: focus.focus,
        layout: NARRATED_REVIEW_LAYOUTS.includes(nonEmpty(segment.layout)) ? nonEmpty(segment.layout) : "",
        tvScene: PACKAGE_ID.test(nonEmpty(segment.tvScene)) ? nonEmpty(segment.tvScene) : "",
        captionOnlySeconds: captionOnlyValid ? captionOnlySeconds : null,
      };
    }).filter(Boolean);
  };
  const story = checkSegments(pkg.story, "story", NARRATED_SCRIPT_PACKAGE_FIELDS.storySegment);
  const storyIds = new Set(story.map((segment) => segment.id));
  if (!Array.isArray(pkg.story) || pkg.story.length === 0) add("story-empty");
  const review = checkSegments(pkg.review, "review", NARRATED_SCRIPT_PACKAGE_FIELDS.reviewSegment);
  review.forEach((segment, index) => {
    if (segment.tvScene && !storyIds.has(segment.tvScene)) add(`review[${index}].tvScene-not-a-story-scene`);
  });
  if (pkg.reviewMarker !== undefined && !nonEmpty(pkg.reviewMarker)) add("reviewMarker");
  const readings = [];
  if (pkg.readings !== undefined) {
    if (!Array.isArray(pkg.readings)) add("readings");
    else {
      const byId = new Map([...story, ...review].map((segment) => [segment.id, segment]));
      pkg.readings.forEach((reading, index) => {
        const at = `readings[${index}]`;
        if (!plainObject(reading)) { add(at); return; }
        for (const key of Object.keys(reading)) if (!NARRATED_SCRIPT_PACKAGE_FIELDS.reading.includes(key)) add(`${at}.${key}-unknown`);
        const segmentId = nonEmpty(reading.segmentId);
        const display = typeof reading.display === "string" ? reading.display.trim() : "";
        const spoken = typeof reading.spoken === "string" ? reading.spoken.trim() : "";
        if (!display) add(`${at}.display`);
        if (!spoken) add(`${at}.spoken`);
        if (/[\r\n]/u.test(`${display}${spoken}`)) add(`${at}.line-break`);
        const segment = byId.get(segmentId);
        if (!segment) add(`${at}.segmentId-unknown`);
        else if (display && !segment.text.includes(display)) add(`${at}.display-not-in-segment`);
        if (segment && display && spoken) readings.push({ segmentId, display, spoken });
      });
    }
  }
  return {
    ok: problems.length === 0,
    problems: [...new Set(problems)],
    speakers,
    story,
    review,
    readings,
    reviewMarker: nonEmpty(pkg.reviewMarker),
    sourceMarkdown: plainObject(pkg.sourceMarkdown) && SHA256_HEX.test(String(pkg.sourceMarkdown.sha256 || ""))
      ? { sha256: pkg.sourceMarkdown.sha256, ...(Number.isSafeInteger(pkg.sourceMarkdown.bytes) ? { bytes: pkg.sourceMarkdown.bytes } : {}) }
      : null,
  };
}

/**
 * 台本パッケージを、Core の segment（声と字幕の単位）へ展開する。
 * パッケージの1セグメントは1枚の画（imageKey）で、その中の話者の区切りと文の区切りごとに
 * 声のテイクと字幕を1つずつ作る。
 */
export function planNarratedScriptPackage(pkg, config, { resolveRole = createNarratedRoleResolver(config) } = {}) {
  const checked = validateNarratedScriptPackage(pkg);
  if (!checked.ok) return issue("script-package", checked.problems);
  const bookends = config?.bookends || { enabled: false };
  const reviewDeclared = bookends.enabled === true && Boolean(bookends.review);
  const issues = [];
  const marker = nonEmpty(bookends.review?.scriptMarker);
  if (checked.reviewMarker && (!reviewDeclared || checked.reviewMarker !== marker)) {
    issues.push("script-structure-required:script-package-review-marker-mismatch");
  }
  if (reviewDeclared && checked.review.length === 0) issues.push("script-structure-required:script-review-section-empty");
  if (!reviewDeclared && checked.review.length > 0) issues.push("script-structure-required:script-review-not-declared-by-channel-pack");
  if (issues.length > 0) return issue("script-partition", issues);
  // 声なしの感想パート（Pack の bookends.review.voice: none）: 感想の文は全部字幕だけにする。台本が感想の文に
  // 話者や読み（声への指定）を書いていれば、どちらのつもりか分からないので有料生成の前に止める。
  const voiceless = narratedReviewVoiceless(config);
  if (voiceless) {
    const mismatches = new Set();
    for (const segment of checked.review) if (segment.speakerDeclared) mismatches.add(`review-voice-none-mismatch:speaker:${segment.id}`);
    const reviewIds = new Set(checked.review.map((segment) => segment.id));
    for (const reading of checked.readings) if (reviewIds.has(reading.segmentId)) mismatches.add(`review-voice-none-mismatch:reading:${reading.segmentId}`);
    if (mismatches.size > 0) return { ...issue("review-voice", [...mismatches]), input: packageInputSummary(checked) };
  }

  const readingsBySegment = new Map();
  for (const reading of checked.readings) {
    if (!readingsBySegment.has(reading.segmentId)) readingsBySegment.set(reading.segmentId, []);
    readingsBySegment.get(reading.segmentId).push(reading);
  }
  const routingIssues = new Set();
  const captionIssues = new Set();
  const expand = (list, part, idPrefix) => {
    const output = [];
    for (const source of list) {
      const marked = (text) => (part === "review" && source.operatorReplacementRequired ? `${OPERATOR_REPLACEMENT_MARKER}${text}` : text);
      // 字幕だけの文: 声を作らないので話者の声の経路も文の分割も要らない（1つの文として宣言の秒数だけ出す）。
      if (source.captionOnlySeconds) {
        output.push({
          ...captionOnlySegment({
            id: source.id,
            text: marked(source.text),
            plainText: source.text,
            part,
            source,
            // 声なしの感想パートでは誰も読まない（話者を記録しない）。
            speakerId: part === "review" && voiceless ? "" : source.speaker,
            seconds: source.captionOnlySeconds,
            basis: "declared",
          }),
          idPrefix,
        });
        continue;
      }
      // 声なしの感想パートで秒数の書かれていない文: 語りの文と同じ規則で文に分け、文ごとに字幕を1枚、
      // 読む速さの既定の秒数で出す（声の文と同じく、1枚の字幕に1文）。
      if (part === "review" && voiceless) {
        const sentences = splitNarrationSentences(source.text);
        sentences.forEach((sentence, index) => {
          const seconds = narratedVoicelessCaptionSeconds(sentence);
          const id = sentences.length === 1 ? source.id : `${source.id}.t${index + 1}`;
          if (seconds === null) {
            captionIssues.add(`caption-only-seconds-exceed-limit:${id}`);
            return;
          }
          output.push({
            ...captionOnlySegment({ id, text: marked(sentence), plainText: sentence, part, source, seconds, basis: "reading-speed" }),
            idPrefix,
          });
        });
        continue;
      }
      const role = checked.speakers.get(source.speaker) || NARRATED_NARRATOR_ROLE;
      const speakerRoute = resolveRole(role);
      const narratorRoute = resolveRole(NARRATED_NARRATOR_ROLE);
      const turns = splitSpeakerTurns(source.text, { dialogue: source.speaker !== NARRATED_NARRATOR_SPEAKER_ID });
      const readings = readingsBySegment.get(source.id) || [];
      const pieces = [];
      for (const turn of turns) {
        const route = turn.kind === "dialogue" ? speakerRoute : narratorRoute;
        if (!route.ok) routingIssues.add(route.issue);
        const sentences = turn.kind === "dialogue" ? [turn.text] : splitNarrationSentences(turn.text);
        for (const sentence of sentences) {
          pieces.push({
            text: sentence,
            kind: turn.kind,
            speakerId: turn.kind === "dialogue" ? source.speaker : NARRATED_NARRATOR_SPEAKER_ID,
            castRole: route.ok ? route.role : (turn.kind === "dialogue" ? role : NARRATED_NARRATOR_ROLE),
            requestedCastRole: turn.kind === "dialogue" ? role : NARRATED_NARRATOR_ROLE,
            voice: route.ok ? route.voice : null,
            routedBy: route.ok ? route.routedBy : "",
          });
        }
      }
      pieces.forEach((piece, index) => {
        const display = part === "review" && source.operatorReplacementRequired
          ? `${OPERATOR_REPLACEMENT_MARKER}${piece.text}`
          : piece.text;
        const spoken = applyReadings(piece.text, readings);
        output.push({
          id: pieces.length === 1 ? source.id : `${source.id}.t${index + 1}`,
          text: display,
          textHash: sha256(display),
          characterCount: [...spoken].length,
          ...(spoken !== piece.text ? { spokenText: spoken, spokenTextHash: sha256(spoken), readingsApplied: readings.filter((reading) => piece.text.includes(reading.display)).length } : {}),
          part,
          sourceSegmentId: source.id,
          imageKey: source.id,
          imagePrompt: source.sceneIntent ? `${source.sceneIntent}\n${source.text}` : source.text,
          speakerId: piece.speakerId,
          castRole: piece.castRole,
          ...(piece.requestedCastRole !== piece.castRole ? { requestedCastRole: piece.requestedCastRole } : {}),
          delivery: piece.kind,
          ...(piece.voice ? { voice: piece.voice } : {}),
          ...(piece.routedBy ? { routedBy: piece.routedBy } : {}),
          ...(source.musicSection ? { musicSection: source.musicSection } : {}),
          ...(source.camera ? { cameraMove: source.camera } : {}),
          // 場面の焦点は場面の全部の文に同じ値で付ける（話者・文ごとに分けても1つのショットで通す）。
          ...(source.cameraFocus ? { cameraFocus: { ...source.cameraFocus } } : {}),
          ...(source.layout ? { reviewLayout: source.layout } : {}),
          ...(source.tvScene ? { tvScene: source.tvScene } : {}),
          idPrefix,
        });
      });
    }
    return output;
  };
  const storySegments = expand(checked.story, "story", "s").map((segment, order) => {
    const { idPrefix, ...rest } = segment;
    return { ...rest, order };
  });
  const reviewSegments = (reviewDeclared ? expand(checked.review, "review", "r") : []).map((segment, index) => {
    const { idPrefix, ...rest } = segment;
    return { ...rest, order: storySegments.length + index };
  });
  if (routingIssues.size > 0) {
    return { ...issue("cast-routing", [...routingIssues].sort()), input: packageInputSummary(checked) };
  }
  if (captionIssues.size > 0) {
    return { ...issue("review-voice", [...captionIssues]), input: packageInputSummary(checked) };
  }
  // 生テキストと同じく、差し替え必須の印が残る文は声にも字幕にもせず止める（最終監査でも再確認する）。
  const unreplaced = operatorReplacementSegments([...storySegments, ...reviewSegments], {
    extraMarker: bookends.review?.operatorReplacementMarker || "",
  });
  return {
    stage: unreplaced.length ? "operator-replacement" : "",
    issues: unreplaced.map((id) => `operator-replacement-required:${id}`),
    storySegments,
    reviewSegments,
    input: packageInputSummary(checked),
  };
}

function packageInputSummary(checked) {
  return {
    format: NARRATED_SCRIPT_PACKAGE_FORMAT,
    storySegments: checked.story.length,
    reviewSegments: checked.review.length,
    speakers: checked.speakers.size,
    readings: checked.readings.length,
    ...(checked.sourceMarkdown ? { sourceMarkdown: checked.sourceMarkdown } : {}),
  };
}

/**
 * 台本（Job が束縛したファイルの本文）を形式ごとに読み、Core の segment 計画を返す。
 * 生テキストは `planRawScript`（lib/narratedStoryPipeline.mjs の planNarratedStoryScript）へ渡す。
 * 戻り値は planNarratedStoryScript と同じ形に `input`（どの形式で読んだか）を足したもの。
 */
export function planNarratedStoryInput(options = {}) {
  const plan = planNarratedStoryInputSegments(options);
  // BGM の区分（Pack の musicPlan）。本編の場面へ区分を当て、置き方の規則と曲の受領を有料生成の前に見る。
  const musicPlan = options.config?.musicPlan;
  if (!musicPlan?.enabled || plan.storySegments.length === 0) return plan;
  const music = planNarratedMusicBlocks(plan.storySegments, musicPlan);
  if (music.issues.length === 0) return { ...plan, musicBlocks: music.blocks };
  return {
    ...plan,
    stage: plan.stage || "music-plan",
    issues: [...plan.issues, ...music.issues],
    musicBlocks: music.blocks,
  };
}

function planNarratedStoryInputSegments({ script, scriptPath = "", config, planRawScript, resolveRole } = {}) {
  if (typeof planRawScript !== "function") throw new Error("planNarratedStoryInput requires planRawScript.");
  const text = String(script ?? "").replaceAll("\r", "").trim();
  const format = detectFormat(text, scriptPath);
  if (format === "script-package") {
    let pkg;
    try {
      pkg = JSON.parse(text);
    } catch {
      return { ...issue("script-package", ["script-package-invalid:json"]), input: { format: "script-package" } };
    }
    return planNarratedScriptPackage(pkg, config, resolveRole ? { resolveRole } : {});
  }
  if (format === "markdown") {
    const markdown = config?.scriptIntake?.markdown;
    if (!markdown) {
      return { ...issue("script-intake", ["script-markdown-structure-undeclared"]), input: { format: "markdown" } };
    }
    const sections = extractMarkdownSections(text, markdown);
    const problems = [];
    if (!sections.story || sections.story.length === 0) problems.push("script-markdown-story-section-missing");
    const bookends = config?.bookends || { enabled: false };
    const reviewDeclared = bookends.enabled === true && Boolean(bookends.review);
    if (reviewDeclared && !markdown.reviewHeading) problems.push("script-markdown-review-heading-undeclared");
    if (reviewDeclared && markdown.reviewHeading && (!sections.review || sections.review.length === 0)) {
      problems.push("script-markdown-review-section-missing");
    }
    if (problems.length > 0) return { ...issue("script-intake", problems), input: { format: "markdown" } };
    const raw = reviewDeclared
      ? [...sections.story, bookends.review.scriptMarker, ...sections.review].join("\n")
      : sections.story.join("\n");
    return { ...withVoicelessReview(planRawScript(raw, config), config), input: { format: "markdown" } };
  }
  return { ...withVoicelessReview(planRawScript(text, config), config), input: { format: "raw-text" } };
}

/**
 * 生テキスト・Markdown の台本で、声なしの感想パート（Pack の bookends.review.voice: none）の文を字幕だけにする。
 * 生テキストの感想の文はもう1文ずつに分かれているので、文ごとに読む速さの既定の秒数を当てる（台本パッケージの
 * 秒数の書かれていない文と同じ規則）。声なしの宣言が無ければ何も変えない。
 */
function withVoicelessReview(plan, config) {
  if (!narratedReviewVoiceless(config) || plan.reviewSegments.length === 0) return plan;
  const issues = [];
  const reviewSegments = plan.reviewSegments.map((segment) => {
    const seconds = narratedVoicelessCaptionSeconds(segment.text);
    if (seconds === null) {
      issues.push(`caption-only-seconds-exceed-limit:${segment.id}`);
      return segment;
    }
    return { ...segment, delivery: "caption-only", captionOnly: true, captionOnlySeconds: seconds, captionSecondsBasis: "reading-speed" };
  });
  if (issues.length === 0) return { ...plan, reviewSegments };
  return { ...plan, stage: plan.stage || "review-voice", issues: [...plan.issues, ...issues], reviewSegments };
}

/**
 * generation manifest に残す segment の出自（台本の文は残さない。id・役・読みの有無と SHA だけ）。
 * 生テキストの segment には何も足さない（従来の manifest と同じ形）。
 */
export function narratedSegmentManifestFields(segment = {}) {
  const fields = {};
  if (segment.sourceSegmentId) fields.sourceSegmentId = segment.sourceSegmentId;
  if (segment.imageKey) fields.imageKey = segment.imageKey;
  if (segment.speakerId) fields.speakerId = segment.speakerId;
  if (segment.castRole) fields.castRole = segment.castRole;
  if (segment.requestedCastRole) fields.requestedCastRole = segment.requestedCastRole;
  if (segment.delivery) fields.delivery = segment.delivery;
  if (segment.routedBy) fields.routedBy = segment.routedBy;
  if (segment.spokenTextHash) {
    fields.reading = { spokenTextHash: segment.spokenTextHash, readingsApplied: segment.readingsApplied || 0 };
  }
  if (segment.musicSection) fields.musicSection = segment.musicSection;
  if (segment.cameraMove) fields.cameraMove = segment.cameraMove;
  if (segment.cameraFocus) fields.cameraFocus = { x: segment.cameraFocus.x, y: segment.cameraFocus.y };
  if (segment.reviewLayout) fields.reviewLayout = segment.reviewLayout;
  if (segment.tvScene) fields.tvScene = segment.tvScene;
  if (segment.captionOnly) fields.captionOnlySeconds = segment.captionOnlySeconds;
  // 声なしの感想の文で、秒数を読む速さの既定から決めたもの（台本が captionOnlySeconds を書いた文には付けない）。
  if (segment.captionOnly && segment.captionSecondsBasis) fields.captionSecondsBasis = segment.captionSecondsBasis;
  return fields;
}
