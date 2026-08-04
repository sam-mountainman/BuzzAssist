import { readFileSync } from "node:fs";

const DEFAULT_ACCENT = "#e53935";
const DEFAULT_INK = "#111111";
const DEFAULT_FILL = "#ffffff";
const DEFAULT_FONT_STACK = "'Hiragino Mincho ProN','Yu Mincho','YuMincho','Noto Serif JP',serif";
const DEFAULT_EMPHASIS_FONT_STACK = "'Hiragino Kaku Gothic ProN','Yu Gothic','Noto Sans JP',sans-serif";
const DEFAULT_FONT_WEIGHT = 500;
const DEFAULT_MAX_COLUMNS = 3;
const CLOSING_PUNCTUATION = new Set(["、", "。", "！", "？", "!", "?", "）", "］", "】", "」", "』", "〉", "》", "〕", "〗", "〙", "〛", "ぁ", "ぃ", "ぅ", "ぇ", "ぉ", "ゃ", "ゅ", "ょ", "っ", "ァ", "ィ", "ゥ", "ェ", "ォ", "ャ", "ュ", "ョ", "ッ", "ー"]);
const OPENING_PUNCTUATION = new Set(["（", "［", "【", "「", "『", "〈", "《", "〔", "〖", "〘", "〚"]);
const JAPANESE_ATTACH_PREVIOUS = new Set([
  "は", "が", "を", "に", "へ", "と", "も", "の", "で", "や", "か", "ね", "よ", "ぞ", "さ",
  "から", "まで", "より", "だけ", "しか", "ほど", "くらい", "ぐらい", "など", "って",
  "ない", "たい", "ます", "です", "でした", "ません", "だった", "だ", "た", "て", "てい",
  "れる", "られる", "せる", "させる", "ん", "んじゃ", "なら", "たら", "ので", "けど",
  "する", "ある", "いる", "し", "ろ",
]);
const PRESETS = new Set(["dialogue", "narration", "thought", "shout"]);

const PROFILE_CATALOG = JSON.parse(readFileSync(new URL("../assets/speech-bubble-profiles.json", import.meta.url), "utf8"));
const DEFAULT_PROFILE_ID = PROFILE_CATALOG.defaultProfileId || "reference-video-locked-v3";

export function speechBubbleProfile(profileId = DEFAULT_PROFILE_ID) {
  const id = String(profileId || DEFAULT_PROFILE_ID);
  const source = PROFILE_CATALOG.profiles?.[id] || PROFILE_CATALOG.profiles?.[DEFAULT_PROFILE_ID] || {};
  return {
    id: PROFILE_CATALOG.profiles?.[id] ? id : DEFAULT_PROFILE_ID,
    name: source.name || id,
    fontFamily: source.fontFamily || DEFAULT_FONT_STACK,
    emphasisFontFamily: source.emphasisFontFamily || DEFAULT_EMPHASIS_FONT_STACK,
    fontWeight: finiteNumber(source.fontWeight, DEFAULT_FONT_WEIGHT),
    shoutFontWeight: finiteNumber(source.shoutFontWeight, 800),
    fontSizeRatio: finiteNumber(source.fontSizeRatio, 0.047),
    minimumFontSizeRatio: finiteNumber(source.minimumFontSizeRatio, 0.035),
    lineAdvance: finiteNumber(source.lineAdvance, 1.08),
    characterAdvance: finiteNumber(source.characterAdvance, 1.02),
    horizontalPadding: finiteNumber(source.horizontalPadding, 0.72),
    verticalPadding: finiteNumber(source.verticalPadding, 0.66),
    extraColumnHeightPadding: finiteNumber(source.extraColumnHeightPadding, 0),
    charactersPerColumn: clamp(Math.round(finiteNumber(source.charactersPerColumn, 11)), 6, 16),
    minimumBubbleWidthRatio: finiteNumber(source.minimumBubbleWidthRatio, 0.13),
    maximumBubbleWidthRatio: finiteNumber(source.maximumBubbleWidthRatio, 0.22),
    minimumBubbleHeightRatio: finiteNumber(source.minimumBubbleHeightRatio, 0.42),
    maximumBubbleHeightRatio: finiteNumber(source.maximumBubbleHeightRatio, 0.72),
    shortTextThreshold: clamp(Math.round(finiteNumber(source.shortTextThreshold, 5)), 1, 8),
    shortMinimumBubbleWidthRatio: finiteNumber(source.shortMinimumBubbleWidthRatio, 0.085),
    shortMaximumBubbleWidthRatio: finiteNumber(source.shortMaximumBubbleWidthRatio, 0.13),
    shortMinimumBubbleHeightRatio: finiteNumber(source.shortMinimumBubbleHeightRatio, 0.20),
    shortMaximumBubbleHeightRatio: finiteNumber(source.shortMaximumBubbleHeightRatio, 0.34),
    narrationMinimumBubbleWidthRatio: finiteNumber(source.narrationMinimumBubbleWidthRatio, 0.11),
    narrationMaximumBubbleWidthRatio: finiteNumber(source.narrationMaximumBubbleWidthRatio, 0.20),
    narrationMinimumBubbleHeightRatio: finiteNumber(source.narrationMinimumBubbleHeightRatio, 0.32),
    narrationMaximumBubbleHeightRatio: finiteNumber(source.narrationMaximumBubbleHeightRatio, 0.72),
    strokeRatio: finiteNumber(source.strokeRatio, 0.0033),
    minimumStrokeWidth: finiteNumber(source.minimumStrokeWidth, 2.8),
    maximumStrokeWidth: finiteNumber(source.maximumStrokeWidth, 5.2),
    inkColor: normalizeHexColor(source.inkColor, DEFAULT_INK),
    fillColor: normalizeHexColor(source.fillColor, DEFAULT_FILL),
    accentColor: normalizeHexColor(source.accentColor, DEFAULT_ACCENT),
    tailDefault: source.tailDefault === true,
    tailMaximumFrameRatio: finiteNumber(source.tailMaximumFrameRatio, 0.034),
    tailMaximumBodyWidthRatio: finiteNumber(source.tailMaximumBodyWidthRatio, 0.22),
    tailMaximumBodyHeightRatio: finiteNumber(source.tailMaximumBodyHeightRatio, 0.11),
    tailGapRatio: finiteNumber(source.tailGapRatio, 0.008),
    maxColumns: clamp(Math.round(finiteNumber(source.maxColumns, 5)), 1, DEFAULT_MAX_COLUMNS),
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[character]);
}

function normalizeHexColor(value, fallback) {
  const raw = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : fallback;
}

function normalizeVerticalText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\.{2,}|…+|⋯+|・{3,}/gu, "︙")
    .replace(/[0-9]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) + 0xfee0))
    .replace(/!/g, "！")
    .replace(/\?/g, "？");
}

function graphemes(value) {
  const text = normalizeVerticalText(value).replace(/\s+/g, "").trim();
  if (!text) return [];
  if (typeof Intl?.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
    return [...segmenter.segment(text)].map((entry) => entry.segment);
  }
  return [...text];
}

function indexedBubbleText(bubble) {
  // Script line breaks are soft authoring hints. The reference videos reflow
  // dialogue into a tall 1-3-column oval instead of turning every newline into
  // another narrow column. Only the explicit `columns` API locks columns.
  const hasExplicitColumns = Array.isArray(bubble?.columns);
  const rawColumns = hasExplicitColumns
    ? bubble.columns
    : [String(bubble?.text ?? "").replace(/\r?\n/g, "")];
  let index = 0;
  const columns = rawColumns
    .map((value) => graphemes(value).map((char) => ({ char, index: index++ })))
    .filter((column) => column.length > 0);
  const characters = columns.flat();
  return {
    characters,
    explicitColumns: hasExplicitColumns && columns.length > 1 ? columns : null,
  };
}

function normalizePoint(point, width, height, fallback = { x: width / 2, y: height / 2 }) {
  if (!point || typeof point !== "object") return fallback;
  const rawX = finiteNumber(point.x, fallback.x);
  const rawY = finiteNumber(point.y, fallback.y);
  return {
    x: Math.abs(rawX) <= 1 ? rawX * width : rawX,
    y: Math.abs(rawY) <= 1 ? rawY * height : rawY,
  };
}

function normalizeSpeakerPosition(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["left", "左"].includes(raw)) return "left";
  if (["right", "右"].includes(raw)) return "right";
  if (["center", "centre", "中央"].includes(raw)) return "center";
  return "";
}

function normalizeFaceBand(value) {
  const raw = String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (["top", "upper", "upperthird", "上", "上1/3", "上三分の一"].includes(raw)) return "upper";
  if (["middle", "center", "中央"].includes(raw)) return "middle";
  if (["lower", "下", "下1/3", "下三分の一"].includes(raw)) return "lower";
  return "upper";
}

function speakerTarget(bubble, width, height) {
  if (bubble.target && typeof bubble.target === "object") {
    return normalizePoint(bubble.target, width, height);
  }
  const hint = bubble.speakerHint && typeof bubble.speakerHint === "object" ? bubble.speakerHint : {};
  const faceBounds = normalizeRect(hint.faceBounds ?? bubble.faceBounds, width, height);
  if (faceBounds) {
    const facing = String(hint.facing ?? bubble.speakerFacing ?? "").toLowerCase();
    const horizontalOffset = facing === "left" ? -0.08 : facing === "right" ? 0.08 : 0;
    return {
      x: faceBounds.x + faceBounds.width * (0.5 + horizontalOffset),
      y: faceBounds.y + faceBounds.height * 0.69,
    };
  }

  const position = normalizeSpeakerPosition(hint.position ?? bubble.speakerPosition ?? bubble.side)
    || (bubble.side === "left" ? "left" : "right");
  const band = normalizeFaceBand(hint.faceBand ?? bubble.faceBand);
  const xByPosition = { left: 0.24, center: 0.50, right: 0.76 };
  const yByBand = { upper: 0.285, middle: 0.49, lower: 0.72 };
  return { x: width * xByPosition[position], y: height * yByBand[band] };
}

function normalizeRect(rect, width, height) {
  if (!rect || typeof rect !== "object") return null;
  const rawX = finiteNumber(rect.x, 0);
  const rawY = finiteNumber(rect.y, 0);
  const rawWidth = finiteNumber(rect.width, 0);
  const rawHeight = finiteNumber(rect.height, 0);
  if (rawWidth <= 0 || rawHeight <= 0) return null;
  const normalized = Math.abs(rawX) <= 1 && Math.abs(rawY) <= 1 && rawWidth <= 1 && rawHeight <= 1;
  return normalized
    ? { x: rawX * width, y: rawY * height, width: rawWidth * width, height: rawHeight * height }
    : { x: rawX, y: rawY, width: rawWidth, height: rawHeight };
}

function rectIntersectionArea(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

function pointInsideRect(point, rect, padding = 0) {
  return point.x >= rect.x - padding
    && point.x <= rect.x + rect.width + padding
    && point.y >= rect.y - padding
    && point.y <= rect.y + rect.height + padding;
}

function lineIntersectsRect(start, end, rect, padding = 0) {
  const expanded = {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
  if (pointInsideRect(start, expanded) || pointInsideRect(end, expanded)) return true;
  const steps = 18;
  for (let index = 1; index < steps; index += 1) {
    const ratio = index / steps;
    const point = {
      x: start.x + (end.x - start.x) * ratio,
      y: start.y + (end.y - start.y) * ratio,
    };
    if (pointInsideRect(point, expanded)) return true;
  }
  return false;
}

function avoidWeight(kind) {
  if (kind === "face" || kind === "mouth") return 1200;
  if (kind === "hand") return 520;
  if (kind === "prop" || kind === "evidence") return 460;
  if (kind === "text") return 800;
  if (kind === "body") return 80;
  return 220;
}

function normalizeAvoidRegions(regions, width, height) {
  return (Array.isArray(regions) ? regions : [])
    .map((region) => {
      const rect = normalizeRect(region, width, height);
      return rect ? { ...rect, kind: String(region.kind ?? "unknown"), weight: finiteNumber(region.weight, avoidWeight(region.kind)) } : null;
    })
    .filter(Boolean);
}

function naturalBubbleSize({ bubble, width, height, profile }) {
  const { characters, explicitColumns } = indexedBubbleText(bubble);
  const estimatedColumns = explicitColumns?.length
    || clamp(Math.ceil(characters.length / profile.charactersPerColumn), 1, profile.maxColumns);
  const estimatedColumnLayout = explicitColumns || balancedColumns(characters, estimatedColumns);
  const perColumn = Math.max(...estimatedColumnLayout.map((column) => column.length), 1);
  const fontSize = clamp(height * profile.fontSizeRatio, 30, 68);
  const preset = PRESETS.has(bubble.preset) ? bubble.preset : "dialogue";
  const isShortReply = preset !== "narration"
    && estimatedColumns === 1
    && characters.length <= profile.shortTextThreshold;
  const widthRange = isShortReply
    ? [profile.shortMinimumBubbleWidthRatio, profile.shortMaximumBubbleWidthRatio]
    : preset === "narration"
      ? [profile.narrationMinimumBubbleWidthRatio, profile.narrationMaximumBubbleWidthRatio]
      : [profile.minimumBubbleWidthRatio, profile.maximumBubbleWidthRatio];
  const heightRange = isShortReply
    ? [profile.shortMinimumBubbleHeightRatio, profile.shortMaximumBubbleHeightRatio]
    : preset === "narration"
      ? [profile.narrationMinimumBubbleHeightRatio, profile.narrationMaximumBubbleHeightRatio]
      : [profile.minimumBubbleHeightRatio, profile.maximumBubbleHeightRatio];
  const minimumWidth = width * widthRange[0];
  const maximumWidth = width * widthRange[1];
  const bubbleWidth = clamp(
    fontSize * (estimatedColumns * profile.lineAdvance + profile.horizontalPadding * 2 + 0.12),
    minimumWidth,
    maximumWidth,
  );
  const bubbleHeight = clamp(
    fontSize * (
      perColumn * profile.characterAdvance
      + profile.verticalPadding * 2
      + Math.max(0, estimatedColumns - 2) * profile.extraColumnHeightPadding
    ),
    height * heightRange[0],
    height * heightRange[1],
  );
  return { width: bubbleWidth, height: bubbleHeight };
}

function candidateBounds({ width, height, bubbleWidth, bubbleHeight, target, preferredSide }) {
  const safeX = width * 0.045;
  const safeY = height * 0.055;
  const rightX = width - safeX - bubbleWidth;
  const leftX = safeX;
  const centerX = (width - bubbleWidth) / 2;
  const topY = safeY;
  const middleY = clamp(target.y - bubbleHeight * 0.35, safeY, height - safeY - bubbleHeight);
  const lowerY = height - safeY - bubbleHeight;
  const primaryX = preferredSide === "left" ? leftX : rightX;
  const secondaryX = preferredSide === "left" ? rightX : leftX;
  // Reference-video order: outer negative space first, then the gap between
  // actors. A lower-third placement is the last resort because it fights the
  // video crop and covers hands/props more often.
  const sideCandidates = [
    [primaryX, topY],
    [primaryX, middleY],
    [centerX, topY],
    [secondaryX, topY],
    [secondaryX, middleY],
    [primaryX, lowerY],
  ];
  return sideCandidates.map(([x, y]) => ({ x, y, width: bubbleWidth, height: bubbleHeight }));
}

function nearestEllipsePoint(rect, target) {
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const radiusX = rect.width / 2;
  const radiusY = rect.height / 2;
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  const denominator = Math.sqrt((dx * dx) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY)) || 1;
  return { x: center.x + dx / denominator, y: center.y + dy / denominator };
}

function scoreCandidate(candidate, { target, width, height, avoidRegions, preferredSide }) {
  const safeX = width * 0.045;
  const safeY = height * 0.055;
  const epsilon = Math.max(width, height) * 1e-9;
  if (
    candidate.x < safeX - epsilon
    || candidate.y < safeY - epsilon
    || candidate.x + candidate.width > width - safeX + epsilon
    || candidate.y + candidate.height > height - safeY + epsilon
  ) return Number.POSITIVE_INFINITY;

  let score = 0;
  const area = candidate.width * candidate.height;
  for (const region of avoidRegions) {
    const overlap = rectIntersectionArea(candidate, region);
    if (overlap > 0) {
      score += (overlap / area) * region.weight;
      // A small face overlap still looks like a production failure. Use a
      // hard deterrent so the planner picks a clean outer zone whenever one
      // exists instead of trading a clipped cheek for a shorter distance.
      if (region.kind === "face" || region.kind === "mouth") score += 5000;
      if (region.kind === "text") score += 2600;
    }
  }

  const attachment = nearestEllipsePoint(candidate, target);
  const targetDistance = Math.hypot(target.x - attachment.x, target.y - attachment.y);
  score += targetDistance / Math.max(width, height) * 55;
  const tailLength = Math.min(targetDistance * 0.28, width * 0.052, candidate.width * 0.28, candidate.height * 0.14);
  const tailEnd = targetDistance > 0
    ? {
        x: attachment.x + ((target.x - attachment.x) / targetDistance) * tailLength,
        y: attachment.y + ((target.y - attachment.y) / targetDistance) * tailLength,
      }
    : attachment;
  for (const region of avoidRegions.filter((entry) => (
    (entry.kind === "face" || entry.kind === "hand" || entry.kind === "prop" || entry.kind === "evidence")
    // The target usually sits inside the speaker's own face box. Penalize
    // crossings over other people, not the intended pointing direction.
    && !pointInsideRect(target, entry)
  ))) {
    if (lineIntersectsRect(attachment, tailEnd, region, Math.min(width, height) * 0.008)) score += region.weight * 0.5;
  }

  const candidateSide = candidate.x + candidate.width / 2 >= width / 2 ? "right" : "left";
  if (preferredSide && candidateSide !== preferredSide) score += 95;
  if (candidate.y + candidate.height / 2 > height * 0.72) score += 20;
  return score;
}

export function planSpeechBubbleLayout({ width, height, bubbles = [], avoidRegions = [], profileId = DEFAULT_PROFILE_ID }) {
  const frameWidth = Math.max(1, finiteNumber(width, 1920));
  const frameHeight = Math.max(1, finiteNumber(height, 1080));
  const frameProfile = speechBubbleProfile(profileId);
  const hintedFaces = bubbles
    .map((bubble) => bubble.speakerHint?.faceBounds ?? bubble.faceBounds)
    .filter(Boolean)
    .map((faceBounds) => ({ ...faceBounds, kind: "face" }));
  const normalizedAvoidRegions = normalizeAvoidRegions(
    [...(Array.isArray(avoidRegions) ? avoidRegions : []), ...hintedFaces],
    frameWidth,
    frameHeight,
  );
  const occupied = [];
  const planned = [];

  for (const [index, bubble] of bubbles.entries()) {
    const indexedText = indexedBubbleText(bubble);
    const characters = indexedText.characters;
    if (characters.length === 0) throw new Error(`Speech bubble ${index + 1} has no text.`);
    const allowedColumns = clamp(
      Math.round(finiteNumber(bubble.maxColumns, frameProfile.maxColumns)),
      1,
      DEFAULT_MAX_COLUMNS,
    );
    if ((indexedText.explicitColumns?.length ?? 0) > allowedColumns) {
      throw new Error(`Speech bubble ${index + 1} has more than ${allowedColumns} explicit columns. Remove manual line breaks or split it into another bubble so the reference-video vertical oval stays narrow.`);
    }
    const target = speakerTarget(bubble, frameWidth, frameHeight);
    const explicitBounds = normalizeRect(bubble.bounds, frameWidth, frameHeight);
    const placementSide = normalizeSpeakerPosition(bubble.placementSide);
    const speakerPosition = normalizeSpeakerPosition(
      bubble.speakerHint?.position ?? bubble.speakerPosition ?? bubble.side,
    );
    const preferredSide = placementSide
      || (speakerPosition === "left" ? "right" : speakerPosition === "right" ? "left" : target.x >= frameWidth / 2 ? "left" : "right");
    const naturalSize = naturalBubbleSize({ bubble, width: frameWidth, height: frameHeight, profile: frameProfile });
    const candidates = explicitBounds
      ? [explicitBounds]
      : candidateBounds({ width: frameWidth, height: frameHeight, bubbleWidth: naturalSize.width, bubbleHeight: naturalSize.height, target, preferredSide });

    const scored = candidates.map((candidate) => {
      let score = scoreCandidate(candidate, {
        target,
        width: frameWidth,
        height: frameHeight,
        avoidRegions: normalizedAvoidRegions,
        preferredSide,
      });
      for (const previous of occupied) {
        const overlap = rectIntersectionArea(candidate, previous);
        if (overlap > 0) score += (overlap / (candidate.width * candidate.height)) * 1800;
      }
      return { candidate, score };
    }).sort((a, b) => a.score - b.score);

    const selected = scored[0];
    occupied.push(selected.candidate);
    planned.push({
      ...bubble,
      id: String(bubble.id ?? `bubble-${index + 1}`),
      order: finiteNumber(bubble.order, index + 1),
      preset: PRESETS.has(bubble.preset) ? bubble.preset : "dialogue",
      profileId: String(bubble.profileId || frameProfile.id),
      target,
      bounds: selected.candidate,
      placementScore: selected.score,
    });
  }

  return { width: frameWidth, height: frameHeight, avoidRegions: normalizedAvoidRegions, bubbles: planned };
}

function simpleBalancedColumns(characters, count) {
  const columns = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const remaining = characters.length - cursor;
    const remainingColumns = count - index;
    let take = Math.ceil(remaining / remainingColumns);
    // Basic kinsoku for the August renderer: do not begin the next column with
    // closing punctuation/small kana, and do not end this column with opening
    // brackets. Full line-breaking and tate-chu-yoko stay outside v1.
    if (index < count - 1 && CLOSING_PUNCTUATION.has(characters[cursor + take]?.char)) take += 1;
    if (take > 1 && OPENING_PUNCTUATION.has(characters[cursor + take - 1]?.char)) take -= 1;
    columns.push(characters.slice(cursor, cursor + take));
    cursor += take;
  }
  return columns.filter((column) => column.length > 0);
}

function semanticJapaneseGroups(characters) {
  if (characters.length <= 1 || typeof Intl?.Segmenter !== "function") {
    return characters.map((character) => [character]);
  }
  const source = characters.map((character) => character.char).join("");
  const segmenter = new Intl.Segmenter("ja", { granularity: "word" });
  const groups = [];
  let pendingOpening = [];
  let cursor = 0;
  for (const entry of segmenter.segment(source)) {
    const tokenLength = graphemes(entry.segment).length;
    let tokenCharacters = characters.slice(cursor, cursor + tokenLength);
    cursor += tokenLength;
    if (tokenCharacters.length === 0) continue;
    const token = tokenCharacters.map((character) => character.char).join("");
    if ([...token].every((character) => OPENING_PUNCTUATION.has(character))) {
      pendingOpening.push(...tokenCharacters);
      continue;
    }
    if (pendingOpening.length > 0) {
      tokenCharacters = [...pendingOpening, ...tokenCharacters];
      pendingOpening = [];
    }
    const previous = groups.at(-1);
    const previousText = previous?.map((character) => character.char).join("") ?? "";
    const isPunctuation = entry.isWordLike === false;
    const isSingleKana = /^[ぁ-ゖァ-ヺー]$/u.test(token);
    const isNounChunk = /^[\p{Script=Han}０-９]+$/u.test(token);
    const previousEndsInNounChunk = /[\p{Script=Han}０-９]$/u.test(previousText);
    const attachToPrevious = previous && (
      isPunctuation
      || JAPANESE_ATTACH_PREVIOUS.has(token)
      || isSingleKana
      || (isNounChunk && previousEndsInNounChunk)
    );
    if (attachToPrevious) previous.push(...tokenCharacters);
    else groups.push(tokenCharacters);
  }
  if (pendingOpening.length > 0) {
    if (groups.length > 0) groups.at(-1).push(...pendingOpening);
    else groups.push(pendingOpening);
  }
  return groups.filter((group) => group.length > 0);
}

function partitionScore(columns, targetLength, maximumCharactersPerColumn) {
  return columns.reduce((score, column) => {
    const lengthPenalty = (column.length - targetLength) ** 2;
    const overflow = Number.isFinite(maximumCharactersPerColumn)
      ? Math.max(0, column.length - maximumCharactersPerColumn)
      : 0;
    const finalCharacter = column.at(-1)?.char;
    const punctuationReward = ["。", "！", "？"].includes(finalCharacter)
      ? -10
      : finalCharacter === "、"
        ? -5
        : 0;
    return score + lengthPenalty + overflow * overflow * 80 + punctuationReward;
  }, 0);
}

function balancedColumns(characters, count, { maximumCharactersPerColumn = Number.POSITIVE_INFINITY } = {}) {
  if (count <= 1) return characters.length > 0 ? [characters] : [];
  const groups = semanticJapaneseGroups(characters);
  if (groups.length < count) return simpleBalancedColumns(characters, count);
  const totalLength = characters.length;
  const targetLength = totalLength / count;
  let best = null;

  const visit = (start, remainingColumns, columns) => {
    if (remainingColumns === 1) {
      const finalColumn = groups.slice(start).flat();
      if (finalColumn.length === 0) return;
      const candidate = [...columns, finalColumn];
      const score = partitionScore(candidate, targetLength, maximumCharactersPerColumn);
      if (!best || score < best.score) best = { columns: candidate, score };
      return;
    }
    const latestBoundary = groups.length - remainingColumns + 1;
    for (let boundary = start + 1; boundary <= latestBoundary; boundary += 1) {
      const column = groups.slice(start, boundary).flat();
      if (column.length === 0) continue;
      visit(boundary, remainingColumns - 1, [...columns, column]);
    }
  };

  visit(0, count, []);
  return best?.columns || simpleBalancedColumns(characters, count);
}

function emphasisIndexes(text, emphasis) {
  const source = graphemes(text);
  const phrases = Array.isArray(emphasis) ? emphasis : [emphasis];
  const marked = new Set();
  for (const phraseValue of phrases) {
    const phrase = graphemes(phraseValue);
    if (phrase.length === 0) continue;
    outer: for (let start = 0; start <= source.length - phrase.length; start += 1) {
      for (let offset = 0; offset < phrase.length; offset += 1) {
        if (source[start + offset] !== phrase[offset]) continue outer;
      }
      for (let offset = 0; offset < phrase.length; offset += 1) marked.add(start + offset);
      break;
    }
  }
  return marked;
}

function fitTypography(bubble, frameHeight, profile) {
  const { characters, explicitColumns } = indexedBubbleText(bubble);
  const accentIndexes = emphasisIndexes(bubble.text, bubble.emphasis ?? bubble.emphasisText);
  const minimumFontSize = Math.max(28, frameHeight * profile.minimumFontSizeRatio);
  let fontSize = finiteNumber(bubble.fontSize, clamp(frameHeight * profile.fontSizeRatio, 30, 68));
  const configuredMaxColumns = clamp(
    Math.round(finiteNumber(bubble.maxColumns, profile.maxColumns)),
    1,
    DEFAULT_MAX_COLUMNS,
  );
  let columnCount = explicitColumns?.length || configuredMaxColumns;
  let usableHeight = 0;
  let usableWidth = 0;
  let maxColumnsByWidth = 1;

  while (fontSize >= minimumFontSize) {
    const horizontalPadding = fontSize * profile.horizontalPadding;
    const verticalPadding = fontSize * profile.verticalPadding;
    usableHeight = Math.max(fontSize * 2, bubble.bounds.height - verticalPadding * 2);
    usableWidth = Math.max(fontSize * 1.4, bubble.bounds.width - horizontalPadding * 2);
    maxColumnsByWidth = clamp(Math.floor(usableWidth / (fontSize * profile.lineAdvance)), 1, configuredMaxColumns);
    const charactersPerColumn = Math.max(1, Math.floor(usableHeight / (fontSize * profile.characterAdvance)));
    if (explicitColumns) {
      const longestColumn = Math.max(...explicitColumns.map((column) => column.length), 1);
      if (explicitColumns.length <= maxColumnsByWidth && longestColumn <= charactersPerColumn) {
        columnCount = explicitColumns.length;
        break;
      }
      fontSize -= 2;
      continue;
    }
    const neededColumns = Math.ceil(characters.length / charactersPerColumn);
    if (neededColumns <= maxColumnsByWidth && neededColumns <= configuredMaxColumns) {
      columnCount = Math.max(1, neededColumns);
      break;
    }
    fontSize -= 2;
  }

  // Never shrink below the channel's readability floor. If a fixed box cannot
  // hold the complete text at this size, report overflow and keep every glyph.
  fontSize = Math.max(fontSize, minimumFontSize);

  const horizontalPadding = fontSize * profile.horizontalPadding;
  const verticalPadding = fontSize * profile.verticalPadding;
  usableHeight = Math.max(fontSize * 2, bubble.bounds.height - verticalPadding * 2);
  usableWidth = Math.max(fontSize * 1.4, bubble.bounds.width - horizontalPadding * 2);
  maxColumnsByWidth = clamp(Math.floor(usableWidth / (fontSize * profile.lineAdvance)), 1, configuredMaxColumns);
  const neededColumns = explicitColumns?.length
    || Math.ceil(characters.length / Math.max(1, Math.floor(usableHeight / (fontSize * profile.characterAdvance))));
  columnCount = explicitColumns
    ? explicitColumns.length
    : clamp(neededColumns, 1, Math.min(configuredMaxColumns, maxColumnsByWidth));

  const maximumCharactersPerColumn = Math.max(1, Math.floor(usableHeight / (fontSize * profile.characterAdvance)));
  const firstAccentIndex = accentIndexes.size > 0 ? Math.min(...accentIndexes) : -1;
  const canSplitAtEmphasis = !explicitColumns
    && columnCount === 2
    && firstAccentIndex > 0
    && firstAccentIndex < characters.length
    && firstAccentIndex <= maximumCharactersPerColumn
    && characters.length - firstAccentIndex <= maximumCharactersPerColumn;
  const columns = explicitColumns
    ? explicitColumns
    : canSplitAtEmphasis
      ? [characters.slice(0, firstAccentIndex), characters.slice(firstAccentIndex)]
      : balancedColumns(characters, columnCount, { maximumCharactersPerColumn });
  const lineAdvance = fontSize * profile.lineAdvance;
  const textWidth = columns.length * lineAdvance;
  const textHeight = Math.max(...columns.map((column) => column.length), 1) * fontSize * profile.characterAdvance;
  const renderedCharacterCount = columns.reduce((total, column) => total + column.length, 0);
  return {
    characters,
    accentIndexes,
    columns,
    fontSize,
    lineAdvance,
    textWidth,
    textHeight,
    inputCharacterCount: characters.length,
    renderedCharacterCount,
    textLoss: renderedCharacterCount !== characters.length,
    tooSmall: false,
    overflow: textWidth > usableWidth || textHeight > usableHeight,
  };
}

function pointString(point) {
  return `${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
}

function ellipsePoint(bounds, angle, radiusScale = 1) {
  return {
    x: bounds.x + bounds.width / 2 + Math.cos(angle) * bounds.width / 2 * radiusScale,
    y: bounds.y + bounds.height / 2 + Math.sin(angle) * bounds.height / 2 * radiusScale,
  };
}

function ellipseDerivative(bounds, angle) {
  return {
    x: -Math.sin(angle) * bounds.width / 2,
    y: Math.cos(angle) * bounds.height / 2,
  };
}

function normalizedVector(vector) {
  const length = Math.hypot(vector.x, vector.y) || 1;
  return { x: vector.x / length, y: vector.y / length };
}

function rotateVector(vector, radians) {
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return { x: vector.x * cosine - vector.y * sine, y: vector.x * sine + vector.y * cosine };
}

function smoothEllipsePath(bounds) {
  const kappa = 0.552284749831;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const radiusX = bounds.width / 2;
  const radiusY = bounds.height / 2;
  return [
    `M ${centerX.toFixed(2)} ${bounds.y.toFixed(2)}`,
    `C ${(centerX + radiusX * kappa).toFixed(2)} ${bounds.y.toFixed(2)}, ${(bounds.x + bounds.width).toFixed(2)} ${(centerY - radiusY * kappa).toFixed(2)}, ${(bounds.x + bounds.width).toFixed(2)} ${centerY.toFixed(2)}`,
    `C ${(bounds.x + bounds.width).toFixed(2)} ${(centerY + radiusY * kappa).toFixed(2)}, ${(centerX + radiusX * kappa).toFixed(2)} ${(bounds.y + bounds.height).toFixed(2)}, ${centerX.toFixed(2)} ${(bounds.y + bounds.height).toFixed(2)}`,
    `C ${(centerX - radiusX * kappa).toFixed(2)} ${(bounds.y + bounds.height).toFixed(2)}, ${bounds.x.toFixed(2)} ${(centerY + radiusY * kappa).toFixed(2)}, ${bounds.x.toFixed(2)} ${centerY.toFixed(2)}`,
    `C ${bounds.x.toFixed(2)} ${(centerY - radiusY * kappa).toFixed(2)}, ${(centerX - radiusX * kappa).toFixed(2)} ${bounds.y.toFixed(2)}, ${centerX.toFixed(2)} ${bounds.y.toFixed(2)} Z`,
  ].join(" ");
}

function tailGeometry(bounds, target, frame, strokeWidth, avoidRegions, profile, bubble) {
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const radiusX = bounds.width / 2;
  const radiusY = bounds.height / 2;
  const attachmentAngle = Math.atan2((target.y - center.y) / radiusY, (target.x - center.x) / radiusX);
  const attachment = ellipsePoint(bounds, attachmentAngle);
  const dx = target.x - attachment.x;
  const dy = target.y - attachment.y;
  const distance = Math.hypot(dx, dy) || 1;
  const angleOffset = clamp(finiteNumber(bubble.tailAngleOffset, 0), -60, 60) * Math.PI / 180;
  const unit = rotateVector({ x: dx / distance, y: dy / distance }, angleOffset);
  const maximumLength = Math.min(
    frame.width * profile.tailMaximumFrameRatio,
    bounds.width * profile.tailMaximumBodyWidthRatio,
    bounds.height * profile.tailMaximumBodyHeightRatio,
  );
  const lengthScale = clamp(finiteNumber(bubble.tailLengthScale, 1), 0.45, 1.55);
  let length = clamp(distance * 0.24, strokeWidth * 1.7, maximumLength) * lengthScale;
  const protectedFaces = avoidRegions.filter((region) => region.kind === "face" || region.kind === "mouth");
  for (const region of protectedFaces) {
    const steps = 48;
    for (let index = 1; index <= steps; index += 1) {
      const sampleLength = length * (index / steps);
      const point = {
        x: attachment.x + unit.x * sampleLength,
        y: attachment.y + unit.y * sampleLength,
      };
      if (!pointInsideRect(point, region, strokeWidth * 0.45)) continue;
      const visualGap = Math.max(strokeWidth * 1.1, Math.max(frame.width, frame.height) * profile.tailGapRatio);
      length = Math.max(0, sampleLength - visualGap);
      break;
    }
  }
  if (length < strokeWidth * 1.6) return null;
  const baseHalf = clamp(Math.min(bounds.width, bounds.height) * 0.031, strokeWidth * 1.55, frame.width * 0.0095);
  const tip = { x: attachment.x + unit.x * length, y: attachment.y + unit.y * length };
  const localArcScale = Math.hypot(
    Math.sin(attachmentAngle) * radiusX,
    Math.cos(attachmentAngle) * radiusY,
  ) || 1;
  const baseDelta = clamp(baseHalf / localArcScale, 0.055, 0.18);
  return { attachmentAngle, attachment, tip, length, baseHalf, baseDelta, unit };
}

function ellipseWithIntegratedTailPath(bounds, tail) {
  if (!tail) return smoothEllipsePath(bounds);
  const startAngle = tail.attachmentAngle - tail.baseDelta;
  const endAngle = tail.attachmentAngle + tail.baseDelta - Math.PI * 2;
  const segmentCount = Math.max(8, Math.ceil(Math.abs(endAngle - startAngle) / (Math.PI / 6)));
  const commands = [`M ${pointString(ellipsePoint(bounds, startAngle))}`];
  for (let index = 0; index < segmentCount; index += 1) {
    const angleA = startAngle + (endAngle - startAngle) * (index / segmentCount);
    const angleB = startAngle + (endAngle - startAngle) * ((index + 1) / segmentCount);
    const pointA = ellipsePoint(bounds, angleA);
    const pointB = ellipsePoint(bounds, angleB);
    const derivativeA = ellipseDerivative(bounds, angleA);
    const derivativeB = ellipseDerivative(bounds, angleB);
    const step = (angleB - angleA) / 3;
    const controlA = { x: pointA.x + derivativeA.x * step, y: pointA.y + derivativeA.y * step };
    const controlB = { x: pointB.x - derivativeB.x * step, y: pointB.y - derivativeB.y * step };
    commands.push(`C ${pointString(controlA)}, ${pointString(controlB)}, ${pointString(pointB)}`);
  }
  const baseB = ellipsePoint(bounds, endAngle);
  const baseA = ellipsePoint(bounds, startAngle);
  const travelTangentB = normalizedVector({
    x: -ellipseDerivative(bounds, endAngle).x,
    y: -ellipseDerivative(bounds, endAngle).y,
  });
  const travelTangentA = normalizedVector({
    x: -ellipseDerivative(bounds, startAngle).x,
    y: -ellipseDerivative(bounds, startAngle).y,
  });
  const controlB = {
    x: baseB.x + travelTangentB.x * tail.baseHalf * 0.7 + tail.unit.x * tail.length * 0.33,
    y: baseB.y + travelTangentB.y * tail.baseHalf * 0.7 + tail.unit.y * tail.length * 0.33,
  };
  const controlA = {
    x: baseA.x - travelTangentA.x * tail.baseHalf * 0.7 + tail.unit.x * tail.length * 0.33,
    y: baseA.y - travelTangentA.y * tail.baseHalf * 0.7 + tail.unit.y * tail.length * 0.33,
  };
  commands.push(`Q ${pointString(controlB)} ${pointString(tail.tip)}`);
  commands.push(`Q ${pointString(controlA)} ${pointString(baseA)} Z`);
  return commands.join(" ");
}

function columnRuns(column, accentIndexes, ink, accent) {
  const runs = [];
  for (const entry of column) {
    const emphasized = accentIndexes.has(entry.index);
    const color = emphasized ? accent : ink;
    const last = runs.at(-1);
    if (last?.color === color && last?.emphasized === emphasized) last.text += entry.char;
    else runs.push({ color, emphasized, text: entry.char });
  }
  return runs;
}

function renderBubbleGroup(bubble, frame) {
  const profile = speechBubbleProfile(bubble.profileId || frame.profileId);
  const ink = normalizeHexColor(bubble.inkColor, profile.inkColor);
  const accent = normalizeHexColor(bubble.accentColor, profile.accentColor);
  const fill = normalizeHexColor(bubble.fillColor, profile.fillColor);
  const strokeWidth = clamp(
    Math.min(frame.width, frame.height) * profile.strokeRatio,
    profile.minimumStrokeWidth,
    profile.maximumStrokeWidth,
  );
  const typography = fitTypography(bubble, frame.height, profile);
  const wantsTail = bubble.tail === true || (bubble.tail !== false && profile.tailDefault);
  const tail = bubble.preset === "narration" || !wantsTail
    ? null
    : tailGeometry(bubble.bounds, bubble.target, frame, strokeWidth, frame.avoidRegions, profile, bubble);
  const centerX = bubble.bounds.x + bubble.bounds.width / 2;
  const centerY = bubble.bounds.y + bubble.bounds.height / 2;
  const startX = centerX + typography.textWidth / 2 - typography.lineAdvance / 2;
  const startY = centerY - typography.textHeight / 2;
  const fontFamily = escapeXml(bubble.fontFamily ?? profile.fontFamily);
  const emphasisFontFamily = escapeXml(bubble.emphasisFontFamily ?? profile.emphasisFontFamily);
  const fontWeight = clamp(Math.round(finiteNumber(bubble.fontWeight, profile.fontWeight)), 400, 900);

  const text = typography.columns.map((column, index) => {
    const runs = columnRuns(column, typography.accentIndexes, ink, accent)
      .map((run) => `<tspan fill="${run.color}"${run.emphasized ? ` font-family="${emphasisFontFamily}" font-weight="${Math.max(700, fontWeight)}"` : ""}>${escapeXml(run.text)}</tspan>`)
      .join("");
    const x = startX - index * typography.lineAdvance;
    return `<text x="${x.toFixed(2)}" y="${startY.toFixed(2)}" writing-mode="vertical-rl" text-orientation="upright" dominant-baseline="central" font-family="${fontFamily}" font-size="${typography.fontSize.toFixed(2)}" font-weight="${fontWeight}" letter-spacing="0.01em" style="font-kerning:normal;font-feature-settings:'vert' 1,'vrt2' 1,'palt' 0">${runs}</text>`;
  }).join("");

  let bodyPath = ellipseWithIntegratedTailPath(bubble.bounds, tail);
  let decorations = "";
  if (bubble.preset === "narration") {
    bodyPath = `M ${bubble.bounds.x.toFixed(2)} ${bubble.bounds.y.toFixed(2)} H ${(bubble.bounds.x + bubble.bounds.width).toFixed(2)} V ${(bubble.bounds.y + bubble.bounds.height).toFixed(2)} H ${bubble.bounds.x.toFixed(2)} Z`;
  }
  // In the two locked reference videos, spoken dialogue keeps the same smooth
  // oval even when the acting is angry or internal. Emotion comes from the
  // artwork and wording, not from generic cloud/starburst balloon shapes.
  const shape = bubble.preset === "narration" ? "rectangle" : "ellipse";
  const body = `<path d="${bodyPath}" fill="${fill}" stroke="${ink}" stroke-width="${(bubble.preset === "narration" ? Math.max(2.4, strokeWidth * 0.88) : strokeWidth).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>${decorations}`;
  return {
    svg: `<g id="${escapeXml(bubble.id)}" data-preset="${escapeXml(bubble.preset)}" data-shape="${shape}" data-profile="${escapeXml(profile.id)}" data-tail="${tail ? "integrated" : "none"}">${body}${text}</g>`,
    typography,
    tail,
    strokeWidth,
    profile,
  };
}

export function renderSpeechBubbleSvg({ width, height, bubbles = [], avoidRegions = [], title = "BuzzAssist speech bubbles", profileId = DEFAULT_PROFILE_ID }) {
  const profile = speechBubbleProfile(profileId);
  const plan = planSpeechBubbleLayout({ width, height, bubbles, avoidRegions, profileId: profile.id });
  plan.profileId = profile.id;
  const rendered = plan.bubbles.map((bubble) => ({ bubble, ...renderBubbleGroup(bubble, plan) }));
  const quality = rendered.map(({ bubble, typography, tail }) => {
    const bubbleArea = bubble.bounds.width * bubble.bounds.height;
    const overlapFor = (kinds) => plan.avoidRegions
      .filter((region) => kinds.has(region.kind))
      .reduce((total, region) => total + rectIntersectionArea(bubble.bounds, region), 0);
    return {
      id: bubble.id,
      fontSize: typography.fontSize,
      columns: typography.columns.length,
      columnTexts: typography.columns.map((column) => column.map((character) => character.char).join("")),
      inputCharacterCount: typography.inputCharacterCount,
      renderedCharacterCount: typography.renderedCharacterCount,
      textLoss: typography.textLoss,
      overflow: typography.overflow,
      tooSmall: typography.tooSmall,
      placementScore: bubble.placementScore,
      frameCoverage: bubbleArea / (plan.width * plan.height),
      faceOverlapRatio: overlapFor(new Set(["face", "mouth"])) / bubbleArea,
      importantOverlapRatio: overlapFor(new Set(["hand", "prop", "evidence", "text"])) / bubbleArea,
      tailLength: tail?.length ?? 0,
      tailLengthRatio: tail ? tail.length / plan.width : 0,
    };
  });
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(plan.width)}" height="${Math.round(plan.height)}" viewBox="0 0 ${plan.width} ${plan.height}" shape-rendering="geometricPrecision" text-rendering="optimizeLegibility">`,
    `<title>${escapeXml(title)}</title>`,
    `<g fill="none">${rendered.map((entry) => entry.svg).join("")}</g>`,
    `</svg>`,
  ].join("");
  return {
    svg,
    plan,
    quality,
    profile,
    exportStrategy: {
      renderer: "browser-svg",
      transparent: true,
      nativeDependencies: [],
      fallback: "excalidraw-export-to-blob",
    },
  };
}

export function buildBubbleAwareCompositionPrompt({ bubbles = [], preferredZones = [] } = {}) {
  const count = Math.max(1, Array.isArray(bubbles) ? bubbles.length : 1);
  const zones = (Array.isArray(preferredZones) ? preferredZones : []).filter(Boolean).join(", ");
  const zoneInstruction = zones
    ? `Reserve clean negative space in these areas: ${zones}.`
    : "Reserve clean negative space beside each speaker, favoring the upper outer thirds of the frame.";
  return [
    `Bubble-aware manga composition for ${count} dialogue beat${count === 1 ? "" : "s"}.`,
    zoneInstruction,
    "Keep every face, mouth, hand, and story-critical prop outside the reserved speech-balloon zones.",
    "Leave a short unobstructed visual path from each reserved zone toward its speaker, but do not draw balloons, tails, captions, or readable text in the generated artwork.",
    "Compose characters around the dialogue layout instead of placing all characters evenly across the frame.",
  ].join(" ");
}
