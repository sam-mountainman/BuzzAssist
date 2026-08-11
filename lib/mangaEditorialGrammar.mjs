export const MANGA_EDITORIAL_GRAMMAR_VERSION = "reference-v33-thought-face-spotlight-r1";

const TEMPORAL_MONTAGE = /(?:翌(?:日|週|月|年)|その後|それから|各地|それぞれ|同時|何度も|繰り返|過ごす時間|日々|年月)/u;
const REFLECTIVE_NARRATION = /(?:思い出|記憶|約束|未来|いつか|あの日|十年|雨上がり|静かに|光|胸|帰る道|一枚目)/u;
const CONFRONTATION = /(?:戻らない|絶対|二度と|ふざけ|やめて|待って|許さ|居場所なんてない|何になる|違う|困る)/u;
const APOLOGY = /(?:ごめんなさ|ごめん|すみません|申し訳)/u;
const STUTTER = /^([ぁ-んァ-ヶ一-龠])[、,]\1{1,}/u;
const PRIVATE_UNCERTAINTY = /(?:なのか|かもしれない|はずじゃ|どうしよう|本当に|俺だけ|私だけ|心の中|胸の内)/u;
const BLACK_PLATE_REFLECTION = /(?:けれど|ではない|わけではない|失(?:う|った)|中止|解除|裏切|後悔|嫌な|孤独|痛み|暗闇|照らし返|守ってくれ)/u;
const PASTEL_PLATE_REFLECTION = /(?:約束|未来|帰る道|灯り|雨上がり|新しい|胸|宝物|輝き|いつか|一枚目|静かに写真)/u;
const WHITE_PLATE_PREMISE = /(?:目が覚め|見慣れ|写真は|証明する|前提|名前|季節|朝|冒頭)/u;
const EDITORIAL_PLATE_TYPES = new Set(["white-solid", "black-solid", "pastel-sky"]);

function textOf(value) {
  return String(value ?? "").replace(/\s+/gu, "");
}

function promptOf(value) {
  return String(value ?? "").toLowerCase();
}

/**
 * Classifies one script beat using the editorial grammar measured from the two
 * locked reference videos. The result is advisory: a director may override it,
 * but every recommendation includes the semantic evidence that triggered it.
 */
export function classifyMangaEditorialBeat(input = {}) {
  const utterance = input.utterance && typeof input.utterance === "object" ? input.utterance : input;
  const text = textOf(utterance.text);
  const preset = String(utterance.preset || "dialogue");
  const prompt = promptOf(utterance.performancePrompt ?? utterance.performance_prompt);
  const isNarration = preset === "narration" || utterance.role === "narration";
  // Narration performance prompts often contain words such as "thoughtful".
  // That is delivery direction, not an instruction to turn narration into a
  // private thought balloon.
  const explicitThought = preset === "thought" || (!isNarration && /(?:^|[\s[])\s*(?:thought|inner|internal|心の声)(?:[\s\]])|心の声/u.test(prompt));
  const inferredThought = !isNarration && PRIVATE_UNCERTAINTY.test(text) && input.allowThoughtInference === true;
  const isThought = explicitThought || inferredThought;
  const isTremble = !isThought
    && APOLOGY.test(text)
    && (STUTTER.test(text) || /(?:ぁ|あ|ー|！|!){2,}/u.test(text) || /panic|cry|sob|breathless/u.test(prompt));
  const isRaisedVoice = !isThought
    && !isTremble
    && (
      /shout|angry|urgent|determined|reprimand|protest/u.test(prompt)
      || (CONFRONTATION.test(text) && (/[！!]/u.test(text) || /戻らない/u.test(text)))
    );

  let bubblePreset = preset;
  let bubbleReason = "ordinary spoken dialogue";
  if (isThought) {
    bubblePreset = "thought";
    bubbleReason = "private interior reaction; use radial thought balloon and face-only spotlight";
  } else if (isTremble) {
    bubblePreset = "tremble";
    bubbleReason = "rare stammered or breathless apology; use the soft dense wavy outline";
  } else if (isRaisedVoice) {
    bubblePreset = "shout";
    bubbleReason = "overt refusal, protest, or reprimand; use the curved concave burst outline";
  } else if (isNarration) {
    bubblePreset = "narration";
    bubbleReason = "external narration; use a square caption card rather than a speech balloon";
  }

  const temporalMontage = TEMPORAL_MONTAGE.test(text);
  const reflectiveNarration = isNarration && REFLECTIVE_NARRATION.test(text);
  const requestedPlateType = String(input.editorialPlateType ?? input.editorial_plate_type ?? "");
  let plateType = EDITORIAL_PLATE_TYPES.has(requestedPlateType) ? requestedPlateType : null;
  if (!plateType && isNarration && input.disableEditorialPlate !== true) {
    if (BLACK_PLATE_REFLECTION.test(text) && (reflectiveNarration || temporalMontage || input.openingExposition === true)) {
      plateType = "black-solid";
    } else if (PASTEL_PLATE_REFLECTION.test(text) && reflectiveNarration) {
      plateType = "pastel-sky";
    } else if (input.openingExposition === true || input.recognitionPause === true || WHITE_PLATE_PREMISE.test(text) && input.allowNeutralPlate === true) {
      plateType = "white-solid";
    }
  }
  const backgroundOnly = Boolean(plateType);
  const confrontationSplit = !isNarration
    && finiteNumber(input.visibleParticipantCount, 0) >= 2
    && (CONFRONTATION.test(text) || input.parallelLocations === true);
  const splitType = temporalMontage && finiteNumber(input.montageBeatCount, 0) >= 3
    ? "story-3"
    : confrontationSplit || input.parallelLocations === true
      ? "vertical-2"
      : null;

  return {
    version: MANGA_EDITORIAL_GRAMMAR_VERSION,
    utteranceId: String(utterance.id || ""),
    bubble: {
      preset: bubblePreset,
      recommended: bubblePreset !== preset,
      reason: bubbleReason,
    },
    thoughtFocus: {
      recommended: isThought,
      dimOpacity: 0.31,
      faceBrightnessLift: 0.1,
      faceRadiusScale: { x: 0.69, y: 0.7 },
      reason: isThought ? "private interior voice" : "not private interior voice",
    },
    editorialPlate: {
      recommended: backgroundOnly,
      type: plateType,
      characterPolicy: "strictly-none",
      environmentPolicy: "none",
      motion: plateType === "pastel-sky" ? "atmosphere-only" : "none",
      reason: backgroundOnly
        ? plateType === "black-solid"
          ? "negative consequence or heavy reflection; isolate the caption on pure black"
          : plateType === "pastel-sky"
            ? "tender promise, future, or release; use the characterless pastel-sky plate"
            : "neutral premise, recognition pause, or opening reset; isolate the caption on pure white"
        : "active dialogue, concrete action, and ordinary narration remain character-led",
    },
    // Compatibility alias for manifests produced before v30.  It now means a
    // strict graphic plate, never an empty room or other illustrated location.
    backgroundOnly: {
      recommended: backgroundOnly,
      type: plateType,
      style: plateType,
      characterPolicy: "strictly-none",
      environmentPolicy: "none",
      reason: backgroundOnly
        ? "reference-matched characterless editorial plate"
        : "active dialogue, concrete action, and ordinary narration remain character-led",
    },
    split: {
      recommended: Boolean(splitType),
      type: splitType,
      composition: splitType ? "post-composite-on-black-then-flatten" : null,
      separatorWidthRatio: splitType ? 0.0145 : null,
      panelCamera: splitType ? "static" : null,
      pageCamera: splitType ? "single-continuous" : null,
      flattenBeforeCamera: Boolean(splitType),
      reason: splitType === "story-3"
        ? "three or more compressed story beats across time/space"
        : splitType === "vertical-2"
          ? "parallel locations, confrontation, or reaction contrast"
          : "single continuous beat",
    },
  };
}

export function auditMangaEditorialPlan(entries = []) {
  const decisions = entries.map((entry) => classifyMangaEditorialBeat(entry));
  return {
    version: MANGA_EDITORIAL_GRAMMAR_VERSION,
    decisionCount: decisions.length,
    counts: {
      backgroundOnly: decisions.filter((entry) => entry.backgroundOnly.recommended).length,
      whitePlate: decisions.filter((entry) => entry.editorialPlate.type === "white-solid").length,
      blackPlate: decisions.filter((entry) => entry.editorialPlate.type === "black-solid").length,
      pastelPlate: decisions.filter((entry) => entry.editorialPlate.type === "pastel-sky").length,
      split2: decisions.filter((entry) => entry.split.type === "vertical-2").length,
      split3: decisions.filter((entry) => entry.split.type === "story-3").length,
      thoughtFocus: decisions.filter((entry) => entry.thoughtFocus.recommended).length,
      shout: decisions.filter((entry) => entry.bubble.preset === "shout").length,
      tremble: decisions.filter((entry) => entry.bubble.preset === "tremble").length,
    },
    decisions,
  };
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
