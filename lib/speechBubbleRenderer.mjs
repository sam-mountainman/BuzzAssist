import { readFileSync } from "node:fs";

const DEFAULT_ACCENT = "#e53935";
const DEFAULT_INK = "#111111";
const DEFAULT_FILL = "#ffffff";
const DEFAULT_FONT_STACK = "'Hiragino Mincho ProN','Yu Mincho','YuMincho','Noto Serif JP',serif";
const DEFAULT_EMPHASIS_FONT_STACK = "'Hiragino Kaku Gothic ProN','Yu Gothic','Noto Sans JP',sans-serif";
const DEFAULT_FONT_WEIGHT = 400;
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
const PRESETS = new Set(["dialogue", "narration", "thought", "shout", "panic", "tremble"]);
const HARD_PROTECTED_KINDS = new Set([
  "face",
  "mouth",
  "head",
  "speaker-face",
  "speaker-head",
  "active-speaker",
  "active-speaker-face",
  "active-speaker-head",
  "protected-hand",
  "protected-prop",
  "protected-evidence",
  "protected-text",
  // Page area that leaves the visible crop at some point of the bubble's
  // display interval on a whole-page (split) camera move. Text must stay
  // readable for its entire interval, so this is as hard as a face.
  "page-offscreen",
]);

// Measured from 478 stable placement events and 378 sequential transitions
// across both supplied full-length reference videos.  Near repeats below 0.12
// were uncommon; after excluding them, the p10 center movement was 0.2085.
// Safety collisions still carry larger penalties, so variation never wins by
// covering a face, hand, important prop, or existing text.
export const REFERENCE_SEQUENCE_PLACEMENT_POLICY = Object.freeze({
  id: "reference-video-sequence-v1",
  historyDepth: 2,
  nearRepeatDistanceRatio: 0.12,
  preferredMovementDistanceRatio: 0.20,
  immediateNearRepeatPenalty: 2200,
  immediateMovementPenalty: 760,
  immediateSamePocketPenalty: 680,
  immediateSameLanePenalty: 115,
  immediateSameBandPenalty: 85,
  narrationSamePocketPenalty: 260,
  secondaryNearRepeatPenalty: 320,
  secondarySamePocketPenalty: 95,
});

const PROFILE_CATALOG = JSON.parse(readFileSync(new URL("../assets/speech-bubble-profiles.json", import.meta.url), "utf8"));
const SHAPE_TEMPLATE_CATALOG = JSON.parse(readFileSync(new URL("../assets/speech-bubble-shape-templates.json", import.meta.url), "utf8"));
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
    minimumTextClearanceRatio: finiteNumber(source.minimumTextClearanceRatio, 0.9),
    maximumEllipseContainmentScore: finiteNumber(source.maximumEllipseContainmentScore, 0.96),
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
  const fullText = graphemes(String(bubble?.text ?? "").replace(/\r?\n/g, ""));
  const requestedColumns = Array.isArray(bubble?.columns)
    ? bubble.columns.map((value) => graphemes(value)).filter((column) => column.length > 0)
    : [];
  const fullTextValue = fullText.join("");
  const requestedText = requestedColumns.flat().join("");
  // Approved phrase-group columns often intentionally omit only the final
  // closing punctuation. Preserve those semantic breaks and append that
  // punctuation to the final column. Any other mismatch is treated as stale
  // authoring data and falls back to automatic reflow, so text can never be
  // truncated or replaced by an outdated column list.
  const requestedSuffix = fullTextValue.startsWith(requestedText)
    ? fullTextValue.slice(requestedText.length)
    : "";
  const punctuationOnlySuffix = requestedSuffix.length > 0
    && /^[。！？︙、）」』】〕〉》]+$/u.test(requestedSuffix);
  const approvedColumns = punctuationOnlySuffix
    ? requestedColumns.map((column, index) => index === requestedColumns.length - 1
      ? [...column, ...graphemes(requestedSuffix)]
      : column)
    : requestedColumns;
  const approvedText = approvedColumns.flat().join("");
  const hasExplicitColumns = approvedColumns.length > 0
    && (fullText.length === 0 || approvedText === fullTextValue);
  const rawColumns = hasExplicitColumns
    ? approvedColumns.map((column) => column.join(""))
    : [fullTextValue];
  let index = 0;
  const columns = rawColumns
    .map((value) => graphemes(value).map((char) => ({ char, index: index++ })))
    .filter((column) => column.length > 0);
  const characters = columns.flat();
  return {
    characters,
    explicitColumns: hasExplicitColumns && columns.length > 1 ? columns : null,
    inputText: fullTextValue,
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
  if (HARD_PROTECTED_KINDS.has(String(kind ?? ""))) return 1600;
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
      return rect ? {
        ...rect,
        id: String(region.id ?? ""),
        kind: String(region.kind ?? "unknown"),
        weight: finiteNumber(region.weight, avoidWeight(region.kind)),
        ...(Number.isFinite(Number(region.cameraProgress))
          ? { cameraProgress: Number(region.cameraProgress) }
          : {}),
      } : null;
    })
    .filter(Boolean);
}

function normalizedPlacementHistory(history, width, height) {
  return (Array.isArray(history) ? history : [])
    .map((entry) => {
      const sourceBounds = entry?.bounds && typeof entry.bounds === "object" ? entry.bounds : entry;
      const bounds = normalizeRect(sourceBounds, width, height);
      return bounds ? {
        bounds,
        preset: PRESETS.has(entry?.preset) ? entry.preset : "dialogue",
        id: String(entry?.id ?? ""),
      } : null;
    })
    .filter(Boolean)
    .slice(-REFERENCE_SEQUENCE_PLACEMENT_POLICY.historyDepth);
}

function normalizedPlacementCenter(rect, width, height) {
  return {
    x: (rect.x + rect.width / 2) / width,
    y: (rect.y + rect.height / 2) / height,
  };
}

function placementPocket(rect, width, height) {
  const point = normalizedPlacementCenter(rect, width, height);
  const lane = point.x < 0.38 ? "left" : point.x > 0.62 ? "right" : "center";
  const band = point.y < 0.38 ? "upper" : point.y > 0.68 ? "lower" : "middle";
  return { lane, band, key: `${lane}-${band}` };
}

function sequencePlacementDiagnostics(candidate, placementHistory, width, height, preset = "dialogue") {
  const candidateCenter = normalizedPlacementCenter(candidate, width, height);
  const candidatePocket = placementPocket(candidate, width, height);
  const recent = [...placementHistory].reverse().map((entry, reverseIndex) => {
    const previousCenter = normalizedPlacementCenter(entry.bounds, width, height);
    const previousPocket = placementPocket(entry.bounds, width, height);
    return {
      historyIndex: reverseIndex,
      id: entry.id,
      preset: entry.preset,
      centerDistanceRatio: Math.hypot(
        candidateCenter.x - previousCenter.x,
        candidateCenter.y - previousCenter.y,
      ),
      laneChanged: candidatePocket.lane !== previousPocket.lane,
      bandChanged: candidatePocket.band !== previousPocket.band,
      samePocket: candidatePocket.key === previousPocket.key,
      pocket: previousPocket,
    };
  });
  const immediate = recent[0] || null;
  return {
    policyId: REFERENCE_SEQUENCE_PLACEMENT_POLICY.id,
    preset,
    historyDepth: recent.length,
    pocket: candidatePocket,
    immediate,
    recent,
    nearRepeat: Boolean(immediate && immediate.centerDistanceRatio < REFERENCE_SEQUENCE_PLACEMENT_POLICY.nearRepeatDistanceRatio),
    belowPreferredMovement: Boolean(immediate && immediate.centerDistanceRatio < REFERENCE_SEQUENCE_PLACEMENT_POLICY.preferredMovementDistanceRatio),
  };
}

function sequencePlacementPenalty(candidate, placementHistory, width, height, preset) {
  const diagnostics = sequencePlacementDiagnostics(candidate, placementHistory, width, height, preset);
  const policy = REFERENCE_SEQUENCE_PLACEMENT_POLICY;
  let penalty = 0;
  const immediate = diagnostics.immediate;
  if (immediate) {
    if (immediate.centerDistanceRatio < policy.nearRepeatDistanceRatio) {
      const severity = 1 - immediate.centerDistanceRatio / policy.nearRepeatDistanceRatio;
      penalty += policy.immediateNearRepeatPenalty * (1 + severity);
    }
    if (immediate.centerDistanceRatio < policy.preferredMovementDistanceRatio) {
      const severity = 1 - immediate.centerDistanceRatio / policy.preferredMovementDistanceRatio;
      penalty += policy.immediateMovementPenalty * severity;
    }
    if (immediate.samePocket) penalty += policy.immediateSamePocketPenalty;
    else {
      if (!immediate.laneChanged) penalty += policy.immediateSameLanePenalty;
      if (!immediate.bandChanged) penalty += policy.immediateSameBandPenalty;
    }
    if (preset === "narration" && immediate.preset === "narration" && immediate.samePocket) {
      penalty += policy.narrationSamePocketPenalty;
    }
  }
  const secondary = diagnostics.recent[1];
  if (secondary) {
    if (secondary.centerDistanceRatio < policy.nearRepeatDistanceRatio) {
      penalty += policy.secondaryNearRepeatPenalty;
    }
    if (secondary.samePocket) penalty += policy.secondarySamePocketPenalty;
  }
  return { penalty, diagnostics };
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

function candidateBounds({
  width,
  height,
  bubbleWidth,
  bubbleHeight,
  target,
  preferredSide,
  lockPlacementSide = false,
  avoidRegions = [],
}) {
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
  const speakerGutter = Math.min(width, height) * 0.015;
  // The production pipeline marks only the active speaker's swept face as a
  // hard `face`; inactive faces are downgraded to soft body regions. Generate
  // candidates immediately beside that full movement envelope so a safe
  // balloon does not have to jump all the way to the frame edge.
  const activeSpeakerAdjacentCandidates = avoidRegions
      .filter((region) => HARD_PROTECTED_KINDS.has(region.kind))
      .flatMap((region) => {
        const leftOfFace = clamp(region.x - bubbleWidth - speakerGutter, leftX, rightX);
        const rightOfFace = clamp(region.x + region.width + speakerGutter, leftX, rightX);
        const faceAlignedY = clamp(
          region.y + region.height / 2 - bubbleHeight / 2,
          safeY,
          height - safeY - bubbleHeight,
        );
        return [
          [leftOfFace, topY],
          [leftOfFace, faceAlignedY],
          [rightOfFace, topY],
          [rightOfFace, faceAlignedY],
        ];
      });
  // Reference-video order: outer negative space first, then the gap between
  // actors. A lower-third placement is the last resort because it fights the
  // video crop and covers hands/props more often.
  const gridX = [
    leftX,
    clamp(width * 0.25 - bubbleWidth / 2, leftX, rightX),
    clamp(width * 0.375 - bubbleWidth / 2, leftX, rightX),
    centerX,
    clamp(width * 0.625 - bubbleWidth / 2, leftX, rightX),
    clamp(width * 0.75 - bubbleWidth / 2, leftX, rightX),
    rightX,
  ];
  const gridY = [
    topY,
    clamp(height * 0.34 - bubbleHeight / 2, topY, lowerY),
    clamp(height * 0.50 - bubbleHeight / 2, topY, lowerY),
    clamp(height * 0.66 - bubbleHeight / 2, topY, lowerY),
    lowerY,
  ];
  // Camera sweeps often leave a narrow but perfectly valid negative-space
  // corridor between the moving speaker and the opposite actor.  A coarse
  // nine-pocket grid can skip that corridor by only a few pixels.  Add a
  // deterministic fine search so a safe placement is found before the shot
  // is rejected; the reference-derived scoring still chooses the final lane.
  const fineStepX = Math.max(12, width * 0.025);
  const fineStepY = Math.max(12, height * 0.04);
  const fineGrid = [];
  for (let x = leftX; x <= rightX + 0.01; x += fineStepX) {
    for (let y = topY; y <= lowerY + 0.01; y += fineStepY) fineGrid.push([x, y]);
  }
  fineGrid.push([rightX, lowerY]);
  const sideCandidates = [
    [primaryX, topY],
    [primaryX, middleY],
    [primaryX, lowerY],
    ...activeSpeakerAdjacentCandidates,
    [centerX, topY],
    [centerX, middleY],
    [secondaryX, topY],
    [secondaryX, middleY],
    [centerX, lowerY],
    ...gridX.flatMap((x) => gridY.map((y) => [x, y])),
    ...fineGrid,
  ];
  const unique = new Map();
  for (const [x, y] of sideCandidates) {
    const key = `${x.toFixed(3)}:${y.toFixed(3)}`;
    if (!unique.has(key)) unique.set(key, { x, y, width: bubbleWidth, height: bubbleHeight });
  }
  return [...unique.values()];
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

function scoreCandidate(candidate, {
  target,
  width,
  height,
  avoidRegions,
  preferredSide,
  lockPlacementSide = false,
  speakerProximityTargets = [],
}) {
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
  // Outer negative space is a preference, not a rule. In the reviewed
  // multi-person reference frames the nearest clean pocket beside the active
  // speaker often sits between the actors, so speaker proximity must be able
  // to beat a distant outer lane after all face collisions are rejected.
  if (preferredSide === "left" || preferredSide === "right") {
    const preferredOuterEdge = preferredSide === "left" ? safeX : width - safeX;
    const candidateOuterEdge = preferredSide === "left"
      ? candidate.x
      : candidate.x + candidate.width;
    const edgePreferenceWeight = speakerProximityTargets.length > 0 ? 36 : 120;
    score += Math.abs(candidateOuterEdge - preferredOuterEdge) / width * edgePreferenceWeight;
  }
  const area = candidate.width * candidate.height;
  for (const region of avoidRegions) {
    const overlap = rectIntersectionArea(candidate, region);
    if (overlap > 0) {
      // A face/head collision is never an aesthetic trade-off.  Camera-aware
      // placement supplies one protected rectangle per sampled camera pose,
      // so rejecting even one pixel here guarantees the speaker stays visible
      // throughout the complete on-screen interval.
      if (HARD_PROTECTED_KINDS.has(region.kind)) return Number.POSITIVE_INFINITY;
      score += (overlap / area) * region.weight;
      // A small face overlap still looks like a production failure. Use a
      // hard deterrent so the planner picks a clean outer zone whenever one
      // exists instead of trading a clipped cheek for a shorter distance.
      if (region.kind === "text") score += 2600;
    }
  }

  const attachment = nearestEllipsePoint(candidate, target);
  const targetDistance = Math.hypot(target.x - attachment.x, target.y - attachment.y);
  score += targetDistance / Math.max(width, height) * (speakerProximityTargets.length > 0 ? 20 : 55);
  if (speakerProximityTargets.length > 0) {
    const normalizedDistances = speakerProximityTargets.map((speakerTargetPoint) => {
      const nearest = nearestEllipsePoint(candidate, speakerTargetPoint);
      return Math.hypot(speakerTargetPoint.x - nearest.x, speakerTargetPoint.y - nearest.y)
        / Math.max(width, height);
    });
    const meanDistance = normalizedDistances.reduce((sum, value) => sum + value, 0)
      / normalizedDistances.length;
    const maximumDistance = Math.max(...normalizedDistances);
    // The mean keeps the balloon close throughout a continuous camera move;
    // the maximum prevents one end of the move from drifting far away.
    score += meanDistance * 155 + maximumDistance * 55;
  }
  const tailLength = Math.min(targetDistance * 0.28, width * 0.052, candidate.width * 0.28, candidate.height * 0.14);
  const tailEnd = targetDistance > 0
    ? {
        x: attachment.x + ((target.x - attachment.x) / targetDistance) * tailLength,
        y: attachment.y + ((target.y - attachment.y) / targetDistance) * tailLength,
      }
    : attachment;
  for (const region of avoidRegions.filter((entry) => (
    (HARD_PROTECTED_KINDS.has(entry.kind) || entry.kind === "hand" || entry.kind === "prop" || entry.kind === "evidence")
    // The target usually sits inside the speaker's own face box. Penalize
    // crossings over other people, not the intended pointing direction.
    && !pointInsideRect(target, entry)
  ))) {
    if (lineIntersectsRect(attachment, tailEnd, region, Math.min(width, height) * 0.008)) score += region.weight * 0.5;
  }

  const candidateSide = candidate.x + candidate.width / 2 >= width / 2 ? "right" : "left";
  if (preferredSide && candidateSide !== preferredSide) {
    // An authored side lock is strong but not absolute: a clean opposite
    // pocket must beat a locked placement that covers a face or existing
    // text. This keeps directionality without turning a composition hint into
    // a production safety failure.
    score += lockPlacementSide ? 1300 : speakerProximityTargets.length > 0 ? 24 : 95;
  }
  if (candidate.y + candidate.height / 2 > height * 0.72) score += 20;
  return score;
}

export function planSpeechBubbleLayout({
  width,
  height,
  bubbles = [],
  avoidRegions = [],
  placementHistory = [],
  profileId = DEFAULT_PROFILE_ID,
}) {
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
  const normalizedHistory = normalizedPlacementHistory(placementHistory, frameWidth, frameHeight);
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
    const speakerProximityTargets = bubble.preset === "narration"
      ? []
      : (Array.isArray(bubble.speakerProximityTargets) ? bubble.speakerProximityTargets : [])
        .filter((point) => point && typeof point === "object")
        .map((point) => normalizePoint(point, frameWidth, frameHeight, target));
    const explicitBounds = normalizeRect(bubble.bounds, frameWidth, frameHeight);
    const placementSide = normalizeSpeakerPosition(bubble.placementSide);
    const speakerPosition = normalizeSpeakerPosition(
      bubble.speakerHint?.position ?? bubble.speakerPosition ?? bubble.side,
    );
    const preferredSide = placementSide
      || (speakerPosition === "left" ? "right" : speakerPosition === "right" ? "left" : target.x >= frameWidth / 2 ? "left" : "right");
    const naturalSize = naturalBubbleSize({ bubble, width: frameWidth, height: frameHeight, profile: frameProfile });
    let placementScale = 1;
    const boundsForScale = (scale) => explicitBounds
      ? [explicitBounds]
      : candidateBounds({
          width: frameWidth,
          height: frameHeight,
          bubbleWidth: naturalSize.width * scale,
          bubbleHeight: naturalSize.height * scale,
          target,
          preferredSide,
          lockPlacementSide: bubble.lockPlacementSide === true,
          avoidRegions: normalizedAvoidRegions,
        });
    const scoreBounds = (candidates) => candidates.map((candidate) => {
      let score = scoreCandidate(candidate, {
        target,
        width: frameWidth,
        height: frameHeight,
        avoidRegions: normalizedAvoidRegions,
        preferredSide,
        lockPlacementSide: bubble.lockPlacementSide === true,
        speakerProximityTargets,
      });
      for (const previous of occupied) {
        const overlap = rectIntersectionArea(candidate, previous);
        if (overlap > 0) score += (overlap / (candidate.width * candidate.height)) * 1800;
      }
      const sequence = sequencePlacementPenalty(
        candidate,
        normalizedHistory,
        frameWidth,
        frameHeight,
        PRESETS.has(bubble.preset) ? bubble.preset : "dialogue",
      );
      score += sequence.penalty;
      return { candidate, score, sequence };
    }).sort((a, b) => a.score - b.score);
    let candidates = boundsForScale(placementScale);
    let scored = scoreBounds(candidates);
    let selected = scored[0];
    // Camera-visible margins can leave a pocket fractionally smaller than the
    // natural box because source coordinates are scaled from another raster.
    // Retry a bounded size reduction; typography still enforces its minimum
    // font and exact-text gates, and hard face/head collisions remain infinite.
    while (!explicitBounds && (!selected || !Number.isFinite(selected.score)) && placementScale > 0.86) {
      placementScale = Math.max(0.86, Number((placementScale - 0.02).toFixed(2)));
      candidates = boundsForScale(placementScale);
      scored = scoreBounds(candidates);
      selected = scored[0];
    }
    if (!selected || !Number.isFinite(selected.score)) {
      const hardRegions = normalizedAvoidRegions.filter((region) => HARD_PROTECTED_KINDS.has(region.kind));
      const hardSummary = hardRegions
        .slice(0, 12)
        .map((region) => `${region.kind}@${Math.round(region.x)},${Math.round(region.y)} ${Math.round(region.width)}x${Math.round(region.height)}`)
        .join(" | ");
      throw new Error(
        `Speech bubble ${String(bubble.id || index + 1)} has no collision-free placement. `
        + `Recompose the shot or reserve more negative space; never cover a face/head. `
        + `[candidates=${candidates.length} size=${Math.round(naturalSize.width)}x${Math.round(naturalSize.height)} `
        + `hardRegions=${hardRegions.length}${hardRegions.length > 12 ? " (first 12)" : ""}: ${hardSummary}]`,
      );
    }
    occupied.push(selected.candidate);
    planned.push({
      ...bubble,
      id: String(bubble.id ?? `bubble-${index + 1}`),
      order: finiteNumber(bubble.order, index + 1),
      preset: PRESETS.has(bubble.preset) ? bubble.preset : "dialogue",
      profileId: String(bubble.profileId || frameProfile.id),
      target,
      speakerProximityTargets,
      bounds: selected.candidate,
      placementScore: selected.score,
      sequencePlacementPenalty: selected.sequence.penalty,
      sequencePlacement: selected.sequence.diagnostics,
      placementScale,
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
  return columns.reduce((score, column, index) => {
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
    const text = column.map((character) => character.char).join("");
    const nextText = columns[index + 1]?.map((character) => character.char).join("") ?? "";
    const danglingDeterminerPenalty = nextText
      && /(?:この|その|あの|どの|こんな|そんな|あんな)$/u.test(text)
      ? 160
      : 0;
    return score + lengthPenalty + overflow * overflow * 80 + punctuationReward + danglingDeterminerPenalty;
  }, 0);
}

function balancedColumns(characters, count, { maximumCharactersPerColumn = Number.POSITIVE_INFINITY } = {}) {
  if (count <= 1) return characters.length > 0 ? [characters] : [];
  let groups = semanticJapaneseGroups(characters);
  if (Number.isFinite(maximumCharactersPerColumn)) {
    groups = groups.flatMap((group) => {
      if (group.length <= maximumCharactersPerColumn) return [group];
      return simpleBalancedColumns(group, Math.ceil(group.length / maximumCharactersPerColumn));
    });
  }
  if (groups.length < count) return simpleBalancedColumns(characters, count);
  const totalLength = characters.length;
  const targetLength = totalLength / count;
  let best = null;

  const visit = (start, remainingColumns, columns) => {
    if (remainingColumns === 1) {
      const finalColumn = groups.slice(start).flat();
      if (finalColumn.length === 0) return;
      if (Number.isFinite(maximumCharactersPerColumn) && finalColumn.length > maximumCharactersPerColumn) return;
      const candidate = [...columns, finalColumn];
      const score = partitionScore(candidate, targetLength, maximumCharactersPerColumn);
      if (!best || score < best.score) best = { columns: candidate, score };
      return;
    }
    const latestBoundary = groups.length - remainingColumns + 1;
    for (let boundary = start + 1; boundary <= latestBoundary; boundary += 1) {
      const column = groups.slice(start, boundary).flat();
      if (column.length === 0) continue;
      if (Number.isFinite(maximumCharactersPerColumn) && column.length > maximumCharactersPerColumn) continue;
      visit(boundary, remainingColumns - 1, [...columns, column]);
    }
  };

  visit(0, count, []);
  const columns = best?.columns || simpleBalancedColumns(characters, count);

  // Intl.Segmenter can separate the Japanese negative auxiliary `ない` from
  // the verb immediately before it. If a fallback split lands on that exact
  // boundary, keep the complete phrase in the preceding vertical column.
  for (let index = 0; index < columns.length - 1; index += 1) {
    const current = columns[index];
    const next = columns[index + 1];
    const currentText = current.map((character) => character.char).join("");
    const nextText = next.map((character) => character.char).join("");
    if (!/[いきぎしじちにびみりえけげせぜてでねべめれ]$/u.test(currentText) || !nextText.startsWith("ない")) continue;
    const auxiliaryLength = graphemes("ない").length;
    current.push(...next.splice(0, auxiliaryLength));
  }
  return columns.filter((column) => column.length > 0);
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
  const { characters, explicitColumns, inputText } = indexedBubbleText(bubble);
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
  const centerX = bubble.bounds.x + bubble.bounds.width / 2;
  const centerY = bubble.bounds.y + bubble.bounds.height / 2;
  const glyphBlockWidth = Math.max(fontSize, (columns.length - 1) * lineAdvance + fontSize);
  const referencePlacement = referenceShapeTextPlacement(
    bubble,
    { width: glyphBlockWidth, height: textHeight },
    fontSize,
  );
  const textCenterX = referencePlacement?.center?.x ?? centerX;
  const textCenterY = referencePlacement?.center?.y ?? centerY;
  const textBounds = {
    x: textCenterX - glyphBlockWidth / 2,
    y: textCenterY - textHeight / 2,
    width: glyphBlockWidth,
    height: textHeight,
  };
  const edgeClearance = Math.min(
    textBounds.x - bubble.bounds.x,
    bubble.bounds.x + bubble.bounds.width - textBounds.x - textBounds.width,
    textBounds.y - bubble.bounds.y,
    bubble.bounds.y + bubble.bounds.height - textBounds.y - textBounds.height,
  );
  const ellipseContainmentScore = bubble.preset === "narration"
    ? 0
    : [
        [textBounds.x, textBounds.y],
        [textBounds.x + textBounds.width, textBounds.y],
        [textBounds.x, textBounds.y + textBounds.height],
        [textBounds.x + textBounds.width, textBounds.y + textBounds.height],
      ].reduce((maximum, [x, y]) => {
        const normalizedX = (x - centerX) / Math.max(1, bubble.bounds.width / 2);
        const normalizedY = (y - centerY) / Math.max(1, bubble.bounds.height / 2);
        return Math.max(maximum, normalizedX ** 2 + normalizedY ** 2);
      }, 0);
  const rectangularOverflow = textWidth > usableWidth || textHeight > usableHeight;
  const clearanceOverflow = edgeClearance < fontSize * profile.minimumTextClearanceRatio;
  const shapeOverflow = referencePlacement
    ? !referencePlacement.fits
    : ellipseContainmentScore > profile.maximumEllipseContainmentScore;
  if ((rectangularOverflow || clearanceOverflow || shapeOverflow) && fontSize > minimumFontSize + 0.01) {
    return fitTypography({ ...bubble, fontSize: Math.max(minimumFontSize, fontSize - 2) }, frameHeight, profile);
  }
  const renderedCharacterCount = columns.reduce((total, column) => total + column.length, 0);
  const renderedText = columns.flat().map((character) => character.char).join("");
  return {
    characters,
    accentIndexes,
    columns,
    fontSize,
    lineAdvance,
    textWidth,
    textHeight,
    textCenter: { x: textCenterX, y: textCenterY },
    textBounds,
    shapeTemplateId: referencePlacement?.templateId ?? null,
    shapeContainmentPass: referencePlacement ? referencePlacement.fits : null,
    shapeTextClearance: referencePlacement?.clearance ?? null,
    edgeClearance,
    edgeClearanceRatio: edgeClearance / fontSize,
    ellipseContainmentScore,
    inputCharacterCount: characters.length,
    renderedCharacterCount,
    inputText,
    renderedText,
    exactTextMatch: renderedText === inputText,
    textLoss: renderedCharacterCount !== characters.length,
    tooSmall: false,
    overflow: rectangularOverflow || clearanceOverflow || shapeOverflow,
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

function closedSplinePath(points) {
  if (!Array.isArray(points) || points.length < 3) return "";
  const count = points.length;
  const at = (index) => points[(index + count) % count];
  const commands = [`M ${pointString(points[0])}`];
  for (let index = 0; index < count; index += 1) {
    const previous = at(index - 1);
    const current = at(index);
    const next = at(index + 1);
    const after = at(index + 2);
    const controlA = {
      x: current.x + (next.x - previous.x) / 6,
      y: current.y + (next.y - previous.y) / 6,
    };
    const controlB = {
      x: next.x - (after.x - current.x) / 6,
      y: next.y - (after.y - current.y) / 6,
    };
    commands.push(`C ${pointString(controlA)}, ${pointString(controlB)}, ${pointString(next)}`);
  }
  commands.push("Z");
  return commands.join(" ");
}

function radialPoint(bounds, angle, radialScale = 1) {
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  return {
    x: centerX + Math.cos(angle) * bounds.width * 0.5 * radialScale,
    y: centerY + Math.sin(angle) * bounds.height * 0.5 * radialScale,
  };
}

function equalArcEllipseAngles(bounds, count) {
  const radiusX = bounds.width / 2;
  const radiusY = bounds.height / 2;
  const sampleCount = 2048;
  const samples = Array.from({ length: sampleCount + 1 }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / sampleCount;
    return { angle, x: radiusX * Math.cos(angle), y: radiusY * Math.sin(angle) };
  });
  const distances = [0];
  for (let index = 1; index < samples.length; index += 1) {
    distances[index] = distances[index - 1] + Math.hypot(
      samples[index].x - samples[index - 1].x,
      samples[index].y - samples[index - 1].y,
    );
  }
  const perimeter = distances.at(-1);
  return Array.from({ length: count }, (_, index) => {
    // The reference ring is dense but not mechanically even.  The small
    // low-discrepancy offset preserves its hand-inked rhythm without random
    // output changing from render to render.
    const irregularOffset = Math.sin(index * 2.399963229728653) * 0.14;
    const target = ((index + irregularOffset + count) % count) * perimeter / count;
    let low = 0;
    let high = distances.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (distances[middle] < target) low = middle + 1;
      else high = middle;
    }
    const right = clamp(low, 1, distances.length - 1);
    const left = right - 1;
    const span = Math.max(0.0001, distances[right] - distances[left]);
    const mix = (target - distances[left]) / span;
    return samples[left].angle + (samples[right].angle - samples[left].angle) * mix;
  });
}

function ellipseNormalPoint(bounds, angle, distance) {
  const radiusX = bounds.width / 2;
  const radiusY = bounds.height / 2;
  const centerX = bounds.x + radiusX;
  const centerY = bounds.y + radiusY;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const normalX = cosine / Math.max(1, radiusX);
  const normalY = sine / Math.max(1, radiusY);
  const magnitude = Math.hypot(normalX, normalY) || 1;
  return {
    x: centerX + radiusX * cosine + normalX / magnitude * distance,
    y: centerY + radiusY * sine + normalY / magnitude * distance,
  };
}

function thoughtRadialDecoration(bounds, ink, strokeWidth) {
  // Reference frame 27 measures at roughly 150-165 separate ink strokes.
  // Equal arc-length spacing is important on a tall oval: angular spacing
  // alone leaves the long side walls visibly sparse.
  const count = 160;
  const minimumDimension = Math.min(bounds.width, bounds.height);
  const gap = clamp(minimumDimension * 0.0065, 1.8, 3.4);
  const angles = equalArcEllipseAngles(bounds, count);
  const ticks = angles.map((angle, index) => {
    const primaryWave = 0.5 + 0.5 * Math.sin(index * 2.399963229728653 + 0.31);
    const secondaryWave = 0.5 + 0.5 * Math.sin(index * 0.731 + 1.17);
    const length = minimumDimension * (0.022 + primaryWave * 0.046 + secondaryWave * 0.014);
    const inner = ellipseNormalPoint(bounds, angle, gap);
    const outer = ellipseNormalPoint(bounds, angle, gap + length);
    return `M ${pointString(inner)} L ${pointString(outer)}`;
  }).join(" ");
  return `<path d="${ticks}" data-decoration="reference-frame-27-radial-ink" fill="none" stroke="${ink}" stroke-width="${Math.max(1.05, strokeWidth * 0.36).toFixed(2)}" stroke-linecap="round"/>`;
}

function selectReferenceShapeTemplate(kind, bubble) {
  const candidates = (SHAPE_TEMPLATE_CATALOG.templates || []).filter((template) => template.kind === kind);
  if (candidates.length === 0) return null;
  const characterCount = graphemes(bubble.text).length;
  const targetAspect = bubble.bounds.width / Math.max(1, bubble.bounds.height);
  return candidates
    .map((template) => {
      const aspectDistance = Math.abs(Math.log(targetAspect / template.aspectRatio));
      const characterDistance = Math.abs(characterCount - template.characterCount)
        / Math.max(characterCount, template.characterCount, 1);
      return { template, score: aspectDistance * 3.5 + characterDistance };
    })
    .sort((left, right) => left.score - right.score || left.template.id.localeCompare(right.template.id))[0].template;
}

function referenceContourPath(bounds, template) {
  if (!template?.points?.length) return smoothEllipsePath(bounds);
  const points = template.points.map(([x, y]) => ({
    x: bounds.x + x * bounds.width,
    y: bounds.y + y * bounds.height,
  }));
  return [`M ${pointString(points[0])}`, ...points.slice(1).map((point) => `L ${pointString(point)}`), "Z"].join(" ");
}

function referenceBubbleContour(kind, bubble) {
  const template = selectReferenceShapeTemplate(kind, bubble);
  return {
    path: referenceContourPath(bubble.bounds, template),
    templateId: template?.id || "fallback-ellipse",
  };
}

function pointInsidePolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const verticalDelta = previousPoint.y - currentPoint.y;
    const crosses = (currentPoint.y > point.y) !== (previousPoint.y > point.y)
      && point.x < (previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)
        / (Math.abs(verticalDelta) < 0.000001 ? 0.000001 : verticalDelta) + currentPoint.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0.000001) return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy));
}

function rectanglePolygonClearance(rectangle, polygon) {
  const samplesPerEdge = 14;
  const samples = [];
  for (let index = 0; index <= samplesPerEdge; index += 1) {
    const ratio = index / samplesPerEdge;
    const x = rectangle.x + rectangle.width * ratio;
    const y = rectangle.y + rectangle.height * ratio;
    samples.push(
      { x, y: rectangle.y },
      { x, y: rectangle.y + rectangle.height },
      { x: rectangle.x, y },
      { x: rectangle.x + rectangle.width, y },
    );
  }
  let minimum = Number.POSITIVE_INFINITY;
  for (const point of samples) {
    if (!pointInsidePolygon(point, polygon)) return -1;
    for (let index = 0; index < polygon.length; index += 1) {
      minimum = Math.min(minimum, pointSegmentDistance(point, polygon[index], polygon[(index + 1) % polygon.length]));
    }
  }
  return minimum;
}

function referenceShapeTextPlacement(bubble, textBlock, fontSize) {
  const kind = bubble.preset === "shout" || bubble.preset === "tremble" ? bubble.preset : null;
  if (!kind) return null;
  const template = selectReferenceShapeTemplate(kind, bubble);
  if (!template?.points?.length) return null;
  const polygon = template.points.map(([x, y]) => ({
    x: bubble.bounds.x + x * bubble.bounds.width,
    y: bubble.bounds.y + y * bubble.bounds.height,
  }));
  const center = {
    x: bubble.bounds.x + bubble.bounds.width / 2,
    y: bubble.bounds.y + bubble.bounds.height / 2,
  };
  const requiredClearance = Math.max(3, fontSize * 0.13);
  let best = null;
  for (let yIndex = -12; yIndex <= 12; yIndex += 1) {
    for (let xIndex = -6; xIndex <= 6; xIndex += 1) {
      const candidateCenter = {
        x: center.x + xIndex * bubble.bounds.width * 0.012,
        y: center.y + yIndex * bubble.bounds.height * 0.012,
      };
      const rectangle = {
        x: candidateCenter.x - textBlock.width / 2,
        y: candidateCenter.y - textBlock.height / 2,
        width: textBlock.width,
        height: textBlock.height,
      };
      const clearance = rectanglePolygonClearance(rectangle, polygon);
      if (clearance < requiredClearance) continue;
      const displacement = (xIndex / 6) ** 2 + (yIndex / 12) ** 2;
      const score = displacement - clearance / Math.max(bubble.bounds.width, bubble.bounds.height) * 0.05;
      if (!best || score < best.score) best = { score, center: candidateCenter, clearance };
    }
  }
  return best
    ? { fits: true, center: best.center, clearance: best.clearance, templateId: template.id }
    : { fits: false, center, clearance: -1, templateId: template.id };
}

function panicWavyPath(bounds) {
  const count = 36;
  const points = Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + index * (Math.PI * 2 / count);
    const wave = 1 + 0.045 * Math.sin(index * Math.PI * 0.92) + 0.018 * Math.sin(index * 2.31);
    return radialPoint(bounds, angle, wave);
  });
  return closedSplinePath(points);
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
  const centerX = typography.textCenter?.x ?? bubble.bounds.x + bubble.bounds.width / 2;
  const centerY = typography.textCenter?.y ?? bubble.bounds.y + bubble.bounds.height / 2;
  const startX = centerX + typography.textWidth / 2 - typography.lineAdvance / 2;
  const startY = centerY - typography.textHeight / 2;
  const fontFamily = escapeXml(bubble.fontFamily ?? profile.fontFamily);
  const emphasisFontFamily = escapeXml(bubble.emphasisFontFamily ?? profile.emphasisFontFamily);
  const fontWeight = clamp(Math.round(finiteNumber(bubble.fontWeight, profile.fontWeight)), 400, 900);
  // Keep every glyph on the same normal Mincho weight.  The reference frames
  // communicate emotion through the balloon silhouette, acting and spacing;
  // synthesised bold produces the uneven kana and punctuation the user
  // explicitly rejected.
  const emphasisFontWeight = fontWeight;

  // Each Japanese glyph is positioned explicitly so every renderer sees the
  // same vertical columns.  Japanese commas and full stops are the exception:
  // in proper tategaki they live in the upper-right corner of the em box, not
  // on the visual centreline.  Keeping the advance unchanged preserves the
  // kinsoku/layout calculation while the optical offset matches native
  // vertical Mincho composition.
  const verticalGlyphPosition = (entry, columnX, cellY, size) => {
    if (entry.char === "、" || entry.char === "。") {
      return {
        x: columnX + size * 0.24,
        y: cellY - size * 0.20,
        kind: "punctuation",
      };
    }
    return { x: columnX, y: cellY, kind: "character" };
  };

  const text = typography.columns.map((column, index) => {
    const x = startX - index * typography.lineAdvance;
    // Place every glyph explicitly instead of depending on CSS
    // `writing-mode`. Cold headless-Chrome profiles can capture an SVG before
    // vertical layout finishes, producing a horizontal line outside an
    // otherwise valid balloon. Absolute glyph coordinates are deterministic
    // in Chrome, CoreGraphics and other SVG rasterizers while retaining the
    // font's Japanese vertical alternates.
    return column.map((entry, characterIndex) => {
      const emphasized = typography.accentIndexes.has(entry.index);
      const cellY = startY + (characterIndex + 0.5) * typography.fontSize * profile.characterAdvance;
      const glyph = verticalGlyphPosition(entry, x, cellY, typography.fontSize);
      return `<text x="${glyph.x.toFixed(2)}" y="${glyph.y.toFixed(2)}" fill="${emphasized ? accent : ink}" data-layout="explicit-vertical-glyph" data-glyph-kind="${glyph.kind}" xml:lang="ja" text-anchor="middle" dominant-baseline="central" alignment-baseline="central" font-family="${emphasized ? emphasisFontFamily : fontFamily}" font-size="${typography.fontSize.toFixed(2)}" font-weight="${emphasized ? emphasisFontWeight : fontWeight}" style="font-synthesis:none;font-kerning:none;font-feature-settings:'vert' 1,'vrt2' 1,'palt' 0">${escapeXml(entry.char)}</text>`;
    }).join("");
  }).join("");

  let bodyPath = ellipseWithIntegratedTailPath(bubble.bounds, tail);
  let decorations = "";
  let shapeTemplate = "procedural";
  if (bubble.preset === "narration") {
    bodyPath = `M ${bubble.bounds.x.toFixed(2)} ${bubble.bounds.y.toFixed(2)} H ${(bubble.bounds.x + bubble.bounds.width).toFixed(2)} V ${(bubble.bounds.y + bubble.bounds.height).toFixed(2)} H ${bubble.bounds.x.toFixed(2)} Z`;
  } else if (bubble.preset === "thought") {
    bodyPath = smoothEllipsePath(bubble.bounds);
    decorations = thoughtRadialDecoration(bubble.bounds, ink, strokeWidth);
    shapeTemplate = "reference-frame-27-radial-ink";
  } else if (bubble.preset === "shout") {
    const contour = referenceBubbleContour("shout", bubble);
    bodyPath = contour.path;
    shapeTemplate = contour.templateId;
  } else if (bubble.preset === "panic") {
    bodyPath = panicWavyPath(bubble.bounds);
  } else if (bubble.preset === "tremble") {
    const contour = referenceBubbleContour("tremble", bubble);
    bodyPath = contour.path;
    shapeTemplate = contour.templateId;
  }
  const shape = ({
    narration: "rectangle",
    thought: "thought-radial",
    shout: "shout-irregular",
    panic: "panic-wavy",
    tremble: "tremble-wavy",
  })[bubble.preset] || "ellipse";
  const shapeStrokeWidth = bubble.preset === "narration"
    ? Math.max(2.4, strokeWidth * 0.88)
    : bubble.preset === "thought"
      ? Math.max(1.2, strokeWidth * 0.45)
      : strokeWidth;
  const body = `<path d="${bodyPath}" fill="${fill}" stroke="${ink}" stroke-width="${shapeStrokeWidth.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>${decorations}`;
  return {
    svg: `<g id="${escapeXml(bubble.id)}" data-preset="${escapeXml(bubble.preset)}" data-shape="${shape}" data-shape-template="${escapeXml(shapeTemplate)}" data-profile="${escapeXml(profile.id)}" data-tail="${tail ? "integrated" : "none"}" data-text="${escapeXml(normalizeVerticalText(bubble.text).replace(/\s+/gu, ""))}">${body}${text}</g>`,
    typography,
    tail,
    strokeWidth,
    profile,
  };
}

export function renderSpeechBubbleSvg({
  width,
  height,
  bubbles = [],
  avoidRegions = [],
  placementHistory = [],
  title = "BuzzAssist speech bubbles",
  profileId = DEFAULT_PROFILE_ID,
}) {
  const profile = speechBubbleProfile(profileId);
  const plan = planSpeechBubbleLayout({
    width,
    height,
    bubbles,
    avoidRegions,
    placementHistory,
    profileId: profile.id,
  });
  plan.profileId = profile.id;
  const rendered = plan.bubbles.map((bubble) => ({ bubble, ...renderBubbleGroup(bubble, plan) }));
  const quality = rendered.map(({ bubble, typography, tail }) => {
    const bubbleArea = bubble.bounds.width * bubble.bounds.height;
    const overlapFor = (kinds) => {
      const staticRegions = [];
      const sampledByProgress = new Map();
      for (const region of plan.avoidRegions.filter((entry) => kinds.has(entry.kind))) {
        if (!Number.isFinite(Number(region.cameraProgress))) {
          staticRegions.push(region);
          continue;
        }
        const progressKey = Number(region.cameraProgress).toFixed(9);
        const sampled = sampledByProgress.get(progressKey) || [];
        sampled.push(region);
        sampledByProgress.set(progressKey, sampled);
      }
      const staticOverlap = staticRegions.reduce(
        (total, region) => total + rectIntersectionArea(bubble.bounds, region),
        0,
      );
      // Camera sweeps duplicate each semantic protection region at every
      // sampled instant. Summing those mutually exclusive instants inflated
      // overlap ratios by up to 33x (and could report ratios above 1). The
      // quality contract is the worst visible instant, not the integral over
      // time, so sum simultaneous regions and take the maximum sample.
      const worstSampleOverlap = Math.max(0, ...[...sampledByProgress.values()].map((regions) => (
        regions.reduce(
          (total, region) => total + rectIntersectionArea(bubble.bounds, region),
          0,
        )
      )));
      return staticOverlap + worstSampleOverlap;
    };
    const proximityDistances = (bubble.speakerProximityTargets || []).map((speakerTargetPoint) => {
      const nearest = nearestEllipsePoint(bubble.bounds, speakerTargetPoint);
      return Math.hypot(speakerTargetPoint.x - nearest.x, speakerTargetPoint.y - nearest.y)
        / Math.max(plan.width, plan.height);
    });
    return {
      id: bubble.id,
      fontSize: typography.fontSize,
      columns: typography.columns.length,
      columnTexts: typography.columns.map((column) => column.map((character) => character.char).join("")),
      inputCharacterCount: typography.inputCharacterCount,
      renderedCharacterCount: typography.renderedCharacterCount,
      inputText: typography.inputText,
      renderedText: typography.renderedText,
      exactTextMatch: typography.exactTextMatch,
      textLoss: typography.textLoss,
      overflow: typography.overflow,
      tooSmall: typography.tooSmall,
      edgeClearance: typography.edgeClearance,
      edgeClearanceRatio: typography.edgeClearanceRatio,
      ellipseContainmentScore: typography.ellipseContainmentScore,
      shapeTemplateId: typography.shapeTemplateId,
      shapeContainmentPass: typography.shapeContainmentPass,
      shapeTextClearance: typography.shapeTextClearance,
      placementScore: bubble.placementScore,
      sequencePlacementPenalty: bubble.sequencePlacementPenalty,
      sequencePlacementPolicyId: bubble.sequencePlacement?.policyId || null,
      sequencePlacementHistoryDepth: bubble.sequencePlacement?.historyDepth || 0,
      sequenceCenterDistanceFromPreviousRatio: bubble.sequencePlacement?.immediate?.centerDistanceRatio ?? null,
      sequenceLaneChanged: bubble.sequencePlacement?.immediate?.laneChanged ?? null,
      sequenceBandChanged: bubble.sequencePlacement?.immediate?.bandChanged ?? null,
      sequenceSamePocket: bubble.sequencePlacement?.immediate?.samePocket ?? null,
      sequenceNearRepeat: bubble.sequencePlacement?.nearRepeat ?? false,
      frameCoverage: bubbleArea / (plan.width * plan.height),
      faceOverlapRatio: overlapFor(HARD_PROTECTED_KINDS) / bubbleArea,
      hardProtectedOverlapRatio: overlapFor(HARD_PROTECTED_KINDS) / bubbleArea,
      importantOverlapRatio: overlapFor(new Set([
        "hand", "prop", "evidence", "text",
        "protected-hand", "protected-prop", "protected-evidence", "protected-text",
      ])) / bubbleArea,
      speakerProximitySampleCount: proximityDistances.length,
      speakerProximityMeanRatio: proximityDistances.length > 0
        ? proximityDistances.reduce((sum, value) => sum + value, 0) / proximityDistances.length
        : null,
      speakerProximityMaxRatio: proximityDistances.length > 0
        ? Math.max(...proximityDistances)
        : null,
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
