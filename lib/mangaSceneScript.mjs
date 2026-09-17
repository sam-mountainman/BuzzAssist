// Scene-script input format for manga episodes.
//
// A script tool on the client side sends scripts as a small YAML-like front
// matter block followed by 「#場面 N 場所・時間帯」 scene headings:
//
//   ---
//   タイトル: 作品のタイトル
//   登場人物:
//     - 名前: 山田花子
//       区分: 今回限り
//       主人公: はい
//   場所: オフィス／喫茶店
//   ---
//
//   #場面 1 オフィス・昼
//
//   その企画書を書いたのは私だ。
//
//   佐藤健：この企画、俺が一から考えたものでね
//   山田花子（心）：一字一句、私の文章のままだ
//
// A 「名前：セリフ」 line is dialogue, 「名前（心）：セリフ」 is inner voice,
// any other non-empty body line is narration (read in the protagonist's
// voice), and blank lines separate beats. The legacy 【カット N：…】 format
// keeps its own parser; this module only holds the pure pieces of the scene
// format (no speaker ids, presets, or file access) so the parser in
// mangaVideoPipeline.mjs can stay small.

export const SCENE_SCRIPT_FORMAT = "scene-script";
export const CUT_HEADING_FORMAT = "cut-heading";
export const SCENE_SCRIPT_DEFAULT_MAX_UTTERANCES_PER_CUT = 4;
// Cost of cutting a scene where the writer left no blank line, in the same
// unit as the squared deviation of a cut size from the scene average. At 3 a
// blank line wins over a one-line imbalance but not over a 1-line cut next to
// a 4-line cut.
export const SCENE_SCRIPT_NON_BLANK_BOUNDARY_PENALTY = 3;

const SCENE_HEADING_DETECTION = /^#場面\s*[0-9０-９]+/u;
const SCENE_HEADING = /^[#＃]場面\s*([0-9０-９]+)\s*[:：]?\s*(.*)$/u;
const LEGACY_CUT_HEADING = /^【\s*(?:カット|CUT)\s*([0-9０-９]+)\s*[：:]\s*(.*?)\s*】$/iu;
const NARRATOR_NAME = /^(?:ナレーション|ナレーター|地の文)$/u;
const INNER_VOICE_MARKER = /\s*[（(]\s*心\s*[）)]\s*$/u;
const DIGIT = /[0-9０-９]/u;

function own(object, key) {
  return Boolean(object) && typeof object === "object" && Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Front matter keys come from a file someone else wrote. defineProperty keeps
// a key such as "__proto__" an ordinary own property.
function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeSceneScriptSource(scriptText) {
  return String(scriptText ?? "").replace(/\r\n?/g, "\n").replace(/^\uFEFF/u, "");
}

function leadingSpaces(line) {
  return line.length - line.replace(/^ +/u, "").length;
}

// Split "key: value" at the first colon. The client's checker only knows the
// half-width colon; a full-width one that comes first is accepted as well, so
// 「タイトル：…」 is not silently dropped.
function splitFrontMatterPair(body) {
  const index = body.search(/[:：]/u);
  if (index < 0) return null;
  return { key: body.slice(0, index).trim(), value: body.slice(index + 1).trim() };
}

function nextBlockIsList(lines, start, indent) {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (leadingSpaces(line) <= indent) return false;
    return line.trim().startsWith("- ");
  }
  return false;
}

/**
 * Two-level YAML subset used by the scene-script front matter: maps, lists of
 * maps, and plain string values. Mirrors the client-side intake checker line
 * for line (indentation counts spaces only, values are never unquoted).
 */
export function parseSceneScriptFrontMatter(lines = []) {
  const source = Array.isArray(lines) ? lines.map((line) => String(line ?? "")) : [];
  const root = {};
  const stack = [{ indent: -1, node: root }];
  source.forEach((raw, index) => {
    if (!raw.trim()) return;
    const indent = leadingSpaces(raw);
    let body = raw.trim();
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1).node;
    if (body.startsWith("- ")) {
      body = body.slice(2).trim();
      const item = {};
      if (Array.isArray(parent)) parent.push(item);
      const pair = splitFrontMatterPair(body);
      if (pair) setOwn(item, pair.key, pair.value);
      stack.push({ indent, node: item });
      return;
    }
    const pair = splitFrontMatterPair(body);
    if (!pair) return;
    if (pair.value === "") {
      const child = nextBlockIsList(source, index + 1, indent) ? [] : {};
      if (isPlainObject(parent)) setOwn(parent, pair.key, child);
      stack.push({ indent, node: child });
    } else if (isPlainObject(parent)) {
      setOwn(parent, pair.key, pair.value);
    }
  });
  return root;
}

/**
 * Locate a front matter block the same way the legacy parser does: the first
 * non-empty line is "---" and a later line closes it. Indexes are 0-based.
 */
export function locateSceneScriptFrontMatter(lines = []) {
  const first = lines.findIndex((line) => line.trim());
  if (first < 0 || lines[first].trim() !== "---") return null;
  const close = lines.findIndex((line, index) => index > first && line.trim() === "---");
  return close > first ? { open: first, close } : null;
}

/** "scene-script" when the front matter or a body heading says so; otherwise "cut-heading". */
export function detectMangaScriptFormat(scriptText) {
  const lines = normalizeSceneScriptSource(scriptText).split("\n");
  const block = locateSceneScriptFrontMatter(lines);
  const frontMatter = block ? parseSceneScriptFrontMatter(lines.slice(block.open + 1, block.close)) : {};
  if (own(frontMatter, "タイトル") || own(frontMatter, "登場人物")) return SCENE_SCRIPT_FORMAT;
  const body = block ? lines.slice(block.close + 1) : lines;
  return body.some((line) => SCENE_HEADING_DETECTION.test(line.trim())) ? SCENE_SCRIPT_FORMAT : CUT_HEADING_FORMAT;
}

function sceneNumber(digits) {
  return Number(String(digits).normalize("NFKC"));
}

/** Split 「オフィス・昼」 on the last ・ into place and time of day. */
export function splitSceneHeading(heading) {
  const text = stringValue(heading);
  const index = text.lastIndexOf("・");
  if (index < 0) return { place: text, timeOfDay: "" };
  return { place: text.slice(0, index).trim(), timeOfDay: text.slice(index + 1).trim() };
}

/**
 * Parse 「#場面 N 見出し」. Also returns a legacy 【カット N：見出し】 line as a
 * heading (flagged) so a cut-heading script that gained a タイトル front matter
 * does not turn its headings into speakers.
 */
export function parseSceneHeadingLine(line) {
  const text = stringValue(line);
  const scene = text.match(SCENE_HEADING);
  if (scene) return { number: sceneNumber(scene[1]), heading: scene[2].trim(), legacy: false };
  const cut = text.match(LEGACY_CUT_HEADING);
  if (cut) return { number: sceneNumber(cut[1]), heading: cut[2].trim(), legacy: true };
  return null;
}

/** First place listed in the front matter 場所 value (「オフィス／喫茶店」 → 「オフィス」). */
export function firstFrontMatterPlace(frontMatter) {
  return stringValue(frontMatter?.["場所"]).split(/[／/]/u)[0].trim();
}

const CAST_CATEGORY = new Map([["固定", "fixed"], ["今回限り", "one-off"]]);

/** Normalise the front matter 登場人物 list. Entries that are not maps are ignored. */
export function sceneScriptCast(frontMatter) {
  const list = Array.isArray(frontMatter?.["登場人物"]) ? frontMatter["登場人物"] : [];
  return list.filter(isPlainObject).map((entry) => {
    const category = stringValue(entry["区分"]);
    return {
      name: stringValue(entry["名前"]),
      category: CAST_CATEGORY.get(category) ?? category,
      isProtagonist: stringValue(entry["主人公"]) === "はい",
      gender: stringValue(entry["性別"]),
      age: stringValue(entry["年齢"]),
      occupation: stringValue(entry["職業"]),
      appearance: stringValue(entry["見た目"]),
    };
  });
}

export function isSceneScriptNarratorName(name) {
  return NARRATOR_NAME.test(stringValue(name));
}

// The speaker separator is the first colon that is not part of a clock time
// such as 10:30 or １０：３０.
function speakerSeparatorIndex(line) {
  for (const match of line.matchAll(/[:：]/gu)) {
    const before = line[match.index - 1] || "";
    const after = line[match.index + 1] || "";
    if (DIGIT.test(before) && DIGIT.test(after)) continue;
    return match.index;
  }
  return -1;
}

/**
 * Split 「名前：本文」 / 「名前（心）：本文」. Returns null when the line has no
 * speaker separator. `prefix` is the raw text before the colon.
 */
export function splitSceneScriptSpeakerLine(line) {
  const text = stringValue(line);
  const index = speakerSeparatorIndex(text);
  if (index < 0) return null;
  const prefix = text.slice(0, index).trim();
  const innerVoice = INNER_VOICE_MARKER.test(prefix);
  return {
    prefix,
    speakerName: prefix.replace(INNER_VOICE_MARKER, "").trim(),
    innerVoice,
    text: text.slice(index + 1).trim(),
  };
}

const UNDECLARED_SPEAKER_MAXIMUM_LENGTH = 20;
// Sentence punctuation from the format rules, plus colons: a prefix that still
// holds a colon (a clock time was skipped) cannot be a name.
const UNDECLARED_SPEAKER_FORBIDDEN = /[、。！？!?「」:：]/u;
const LEGACY_SPEAKER_MAXIMUM_LENGTH = 80;

// Same clean-up as normalizeDialogueText in mangaVideoPipeline.mjs (outer
// 「」『』 and quotes removed). A line that is nothing but quotes has nothing
// to say, so the reader drops it the way the legacy parser does.
function stripSceneScriptDialogueQuotes(value) {
  return stringValue(value)
    .replace(/^[「『"']+/u, "")
    .replace(/[」』"']+$/u, "")
    .trim();
}

/**
 * Decide what one scene-script body line says:
 *   - "dialogue": a declared name (or, without a cast list, the legacy
 *     「名前：本文」 rule; with a cast list, a short prefix free of sentence
 *     punctuation, flagged `declared: false`);
 *   - "narration": anything else, including 「ナレーション：…」;
 *     `rejectedSpeaker` marks a line whose colon was not read as a speaker
 *     separator because the text before it cannot be a name;
 *   - "empty": a speaker line with nothing to say.
 */
export function classifySceneScriptLine(line, { declaredNames = new Set(), hasCastList = false } = {}) {
  const text = stringValue(line);
  const split = splitSceneScriptSpeakerLine(text);
  if (!split) return { kind: "narration", text };
  if (isSceneScriptNarratorName(split.speakerName)) {
    return split.text ? { kind: "narration", text: split.text } : { kind: "empty" };
  }
  const nameLength = [...split.speakerName].length;
  let accepted;
  let declared = false;
  if (hasCastList) {
    declared = declaredNames.has(split.speakerName);
    accepted = declared || (
      nameLength >= 1
      && nameLength <= UNDECLARED_SPEAKER_MAXIMUM_LENGTH
      && !UNDECLARED_SPEAKER_FORBIDDEN.test(split.speakerName)
    );
  } else {
    // No 登場人物 list: the legacy 「名前：本文」 acceptance rule (a 1–80
    // character prefix without a colon). An empty body is dropped below, as
    // the legacy parser drops it.
    accepted = nameLength >= 1
      && [...split.prefix].length <= LEGACY_SPEAKER_MAXIMUM_LENGTH
      && !/[：:]/u.test(split.prefix);
  }
  if (!accepted) return { kind: "narration", text, rejectedSpeaker: true };
  if (!stripSceneScriptDialogueQuotes(split.text)) return { kind: "empty" };
  return {
    kind: "dialogue",
    speakerName: split.speakerName,
    innerVoice: split.innerVoice,
    text: split.text,
    declared,
  };
}

/**
 * Read a scene script into scenes of classified lines, with warnings.
 * Knows nothing about speaker ids, cuts, or presets; parseMangaScript turns
 * the result into cuts and utterances.
 *
 * Each scene: { number, heading, place, timeOfDay, line, entries, blankBoundaries }.
 * `line` is the 1-based line of the heading (or of the first body line for
 * the implicit scene, number 0, that holds text before the first heading).
 * Each entry is a classified line plus its 1-based `line` number.
 * `blankBoundaries` holds entry indexes that follow a blank line.
 * Warnings are { code, line, message } sorted by line; messages are Japanese
 * because they go back to the script writer.
 */
export function readSceneScript(scriptText) {
  const lines = normalizeSceneScriptSource(scriptText).split("\n");
  const block = locateSceneScriptFrontMatter(lines);
  const frontMatter = block ? parseSceneScriptFrontMatter(lines.slice(block.open + 1, block.close)) : {};
  const bodyStart = block ? block.close + 1 : 0;
  const warnings = [];
  const warn = (code, line, message) => warnings.push({ code, line, message });

  const firstContent = lines.findIndex((line) => line.trim());
  if (!block && firstContent >= 0 && lines[firstContent].trim() === "---") {
    warn("front-matter-unclosed", firstContent + 1, "冒頭ブロックが「---」で閉じられていないため、冒頭ブロックを読めませんでした。冒頭ブロックの最後に「---」の行を入れてください");
  }

  const cast = sceneScriptCast(frontMatter);
  const declaredNames = new Set(cast.map((entry) => entry.name).filter(Boolean));
  const hasCastList = declaredNames.size > 0;
  const protagonists = cast.filter((entry) => entry.isProtagonist);
  const protagonistName = protagonists.length === 1 ? protagonists[0].name : "";
  if (protagonists.length !== 1) {
    const castLine = block
      ? lines.findIndex((line, index) => index > block.open && index < block.close && /^登場人物\s*[:：]/u.test(line))
      : -1;
    warn(
      "protagonist-count",
      castLine >= 0 ? castLine + 1 : (block ? block.open + 1 : 1),
      `登場人物で「主人公: はい」の人物が${protagonists.length}人です。主人公は1人だけにしてください`
        + (protagonists.length > 1 ? `（${protagonists.map((entry) => entry.name).join("／")}）` : ""),
    );
  }

  const bodyText = lines.slice(bodyStart).join("\n");
  const markdownTitle = stringValue(bodyText.match(/^\s*#\s+(.+)$/mu)?.[1]);
  const bodyTitle = stringValue(bodyText.match(/^\s*タイトル\s*[：:]\s*(.+)$/mu)?.[1]);

  const scenes = [];
  let scene = null;
  let pendingBlank = false;
  let expectedSceneNumber = 1;
  const warnedSpeakers = new Set();
  for (let index = bodyStart; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].trim();
    if (!line) {
      if (scene?.entries.length > 0) pendingBlank = true;
      continue;
    }
    const heading = parseSceneHeadingLine(line);
    if (heading) {
      if (heading.legacy) {
        warn("cut-heading-in-scene-script", lineNumber, `「${line}」は場面見出しとして読みました。場面見出しは「#場面 1 場所・時間帯」の形で書いてください`);
      }
      if (heading.number !== expectedSceneNumber) {
        warn("scene-number-sequence", lineNumber, `場面番号が${expectedSceneNumber}ではなく${heading.number}です。場面番号は1から順に付けてください`);
      }
      expectedSceneNumber = heading.number + 1;
      scene = {
        number: heading.number,
        heading: heading.heading,
        ...splitSceneHeading(heading.heading),
        line: lineNumber,
        entries: [],
        blankBoundaries: new Set(),
      };
      scenes.push(scene);
      pendingBlank = false;
      continue;
    }
    if (/^[#＃]/u.test(line)) {
      if (!/^#{1,6}\s+/u.test(line)) {
        warn("unrecognized-heading", lineNumber, `「${line}」は場面見出しとして読めないため読み上げません。場面見出しは「#場面 1 場所・時間帯」の形で書いてください`);
      }
      continue;
    }
    if (/^タイトル\s*[：:]/u.test(line)) continue;
    if (/^(?:-{3,}|\*{3,}|_{3,}|={3,})$/u.test(line)) {
      warn("separator-line", lineNumber, `区切り線「${line}」は読み上げません`);
      continue;
    }
    const classified = classifySceneScriptLine(line, { declaredNames, hasCastList });
    if (classified.kind === "empty") {
      warn("empty-utterance", lineNumber, `「${line}」は本文が空のため読み上げません`);
      continue;
    }
    if (!scene) {
      warn("text-before-first-scene", lineNumber, "最初の「#場面」見出しより前に本文があります。冒頭ブロックの「場所」の最初の場所の場面として扱いました");
      scene = { number: 0, heading: "", place: firstFrontMatterPlace(frontMatter), timeOfDay: "", line: lineNumber, entries: [], blankBoundaries: new Set() };
      scenes.push(scene);
    }
    if (classified.kind === "narration" && /[:：]/u.test(classified.text)) {
      warn(
        "narration-colon",
        lineNumber,
        classified.rejectedSpeaker
          ? `「${line}」はコロンの前が話者名として読めないため、行全体をナレーションとして読みます。ナレーションの中ではコロン（：）を使わないでください`
          : `「${line}」のコロンは時刻などの一部として読み、ナレーションのまま読みます。ナレーションの中ではコロン（：）を使わないでください`,
      );
    }
    if (classified.kind === "dialogue" && !classified.declared && !warnedSpeakers.has(classified.speakerName)) {
      warnedSpeakers.add(classified.speakerName);
      warn(
        "undeclared-speaker",
        lineNumber,
        hasCastList
          ? `話者「${classified.speakerName}」が登場人物欄にいません。セリフとして読みます`
          : `登場人物欄が無いため、話者「${classified.speakerName}」を確認できません。セリフとして読みます`,
      );
    }
    if (pendingBlank && scene.entries.length > 0) scene.blankBoundaries.add(scene.entries.length);
    pendingBlank = false;
    scene.entries.push({ ...classified, line: lineNumber });
  }
  for (const entry of scenes) {
    if (entry.entries.length === 0) {
      warn("empty-scene", entry.line, `場面${entry.number}「${entry.heading}」に読み上げる行がありません`);
    }
  }
  warnings.sort((left, right) => left.line - right.line);

  return { lines, frontMatter, cast, protagonistName, scenes, warnings, bodyTitle, markdownTitle };
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer.`);
  return number;
}

/**
 * Choose where a scene of `count` lines is cut. Uses k = ceil(count / max)
 * cuts and minimises the sum of squared deviations of each cut size from
 * count / k, plus `penalty` for every boundary that is not at a blank line,
 * with every cut holding at most `max` lines. Ties go to the earliest
 * boundary. Returns the boundary positions (a boundary b means a new cut
 * starts at line index b).
 */
export function planSceneCutBoundaries(count, blankBoundaries = [], options = {}) {
  const total = Number(count);
  if (!Number.isInteger(total) || total < 0) throw new Error("Scene line count must be a non-negative integer.");
  const maximum = positiveInteger(options.maxUtterancesPerCut ?? SCENE_SCRIPT_DEFAULT_MAX_UTTERANCES_PER_CUT, "maxUtterancesPerCut");
  const penalty = Number(options.nonBlankBoundaryPenalty ?? SCENE_SCRIPT_NON_BLANK_BOUNDARY_PENALTY);
  if (!Number.isFinite(penalty) || penalty < 0) throw new Error("nonBlankBoundaryPenalty must be a non-negative number.");
  if (total <= maximum) return [];
  const cutCount = Math.ceil(total / maximum);
  const blank = new Set(Array.isArray(blankBoundaries) ? blankBoundaries : [...blankBoundaries]);
  // Everything is multiplied by cutCount² so sizes compare in integers:
  // (size - total/k)² · k² = (k·size - total)².
  const boundaryCost = penalty * cutCount * cutCount;
  const segmentCost = (start, end) => ((cutCount * (end - start) - total) ** 2)
    + (end < total && !blank.has(end) ? boundaryCost : 0);
  // best[j][i]: cheapest way to cut lines i..total-1 into exactly j cuts.
  const best = Array.from({ length: cutCount + 1 }, () => new Array(total + 1).fill(Infinity));
  best[0][total] = 0;
  for (let cuts = 1; cuts <= cutCount; cuts += 1) {
    for (let start = total - 1; start >= 0; start -= 1) {
      for (let end = start + 1; end <= Math.min(total, start + maximum); end += 1) {
        const rest = best[cuts - 1][end];
        if (!Number.isFinite(rest)) continue;
        const cost = segmentCost(start, end) + rest;
        if (cost < best[cuts][start]) best[cuts][start] = cost;
      }
    }
  }
  const boundaries = [];
  let start = 0;
  for (let cuts = cutCount; cuts >= 1; cuts -= 1) {
    for (let end = start + 1; end <= Math.min(total, start + maximum); end += 1) {
      const rest = best[cuts - 1][end];
      if (Number.isFinite(rest) && segmentCost(start, end) + rest === best[cuts][start]) {
        if (end < total) boundaries.push(end);
        start = end;
        break;
      }
    }
  }
  return boundaries;
}
