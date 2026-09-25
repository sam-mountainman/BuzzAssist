/**
 * ナレーション物語の台本の受け口（ジャンル層）。
 *
 * 公式経路が受け取る台本は3形式:
 *   - 台本パッケージ（script-package.json、`buzzassist-narrated-script-package-v1`）: 本編・感想・話者・
 *     読み・BGM の区分・場面の意図を機械が読める形で持つ。台本スキルの正式な出力
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
 */

import { createHash } from "node:crypto";
import { extname } from "node:path";

import { OPERATOR_REPLACEMENT_MARKER, operatorReplacementSegments } from "./narratedStoryBookends.mjs";

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
  storySegment: Object.freeze(["id", "text", "speaker", "sceneIntent", "musicSection"]),
  reviewSegment: Object.freeze(["id", "text", "speaker", "sceneIntent", "operatorReplacementRequired"]),
  reading: Object.freeze(["segmentId", "display", "spoken"]),
});

const PACKAGE_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const ROLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u;
const TERMINAL_PUNCTUATION = /[。！？!?]/u;
const CLOSING_PUNCTUATION = /[」』）】〉》〕］}]/u;
const MAX_TEXT = 2_000;

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
      return { id, text, speaker, sceneIntent: nonEmpty(segment.sceneIntent), musicSection: nonEmpty(segment.musicSection), operatorReplacementRequired: segment.operatorReplacementRequired === true };
    }).filter(Boolean);
  };
  const story = checkSegments(pkg.story, "story", NARRATED_SCRIPT_PACKAGE_FIELDS.storySegment);
  if (!Array.isArray(pkg.story) || pkg.story.length === 0) add("story-empty");
  const review = checkSegments(pkg.review, "review", NARRATED_SCRIPT_PACKAGE_FIELDS.reviewSegment);
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
 * 話者の役を声へ振り分ける関数の既定（Channel Pack に配役が無いとき）。語り手だけが声を持ち、
 * 他の役は宣言が無いので止める（黙ってナレーターへ落とさない）。
 */
function defaultResolveRole(role) {
  if (role === NARRATED_NARRATOR_ROLE) return { ok: true, role, voice: null, routedBy: "narrator" };
  return { ok: false, issue: `cast-role-undeclared:${role}` };
}

/**
 * 台本パッケージを、Core の segment（声と字幕の単位）へ展開する。
 * パッケージの1セグメントは1枚の画（imageKey）で、その中の話者の区切りと文の区切りごとに
 * 声のテイクと字幕を1つずつ作る。
 */
export function planNarratedScriptPackage(pkg, config, { resolveRole = defaultResolveRole } = {}) {
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

  const readingsBySegment = new Map();
  for (const reading of checked.readings) {
    if (!readingsBySegment.has(reading.segmentId)) readingsBySegment.set(reading.segmentId, []);
    readingsBySegment.get(reading.segmentId).push(reading);
  }
  const routingIssues = new Set();
  const expand = (list, part, idPrefix) => {
    const output = [];
    for (const source of list) {
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
          delivery: piece.kind,
          ...(piece.voice ? { voice: piece.voice } : {}),
          ...(piece.routedBy ? { routedBy: piece.routedBy } : {}),
          ...(source.musicSection ? { musicSection: source.musicSection } : {}),
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
export function planNarratedStoryInput({ script, scriptPath = "", config, planRawScript, resolveRole } = {}) {
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
    return { ...planRawScript(raw, config), input: { format: "markdown" } };
  }
  return { ...planRawScript(text, config), input: { format: "raw-text" } };
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
  if (segment.delivery) fields.delivery = segment.delivery;
  if (segment.routedBy) fields.routedBy = segment.routedBy;
  if (segment.spokenTextHash) {
    fields.reading = { spokenTextHash: segment.spokenTextHash, readingsApplied: segment.readingsApplied || 0 };
  }
  if (segment.musicSection) fields.musicSection = segment.musicSection;
  return fields;
}
