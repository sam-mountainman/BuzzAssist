import { createHash } from "node:crypto";

export const MANGA_SCENE_COMPOSITION_VERSION = 4;

export const MANGA_COMPOSITION_SETUPS = [
  { id: "establishing-deep", shotSize: "wide", azimuth: "three-quarter-left", elevation: "eye", arrangement: "three-plane-environment", lens: "24mm", foreground: "shop prop or doorway edge", depth: "three-plane" },
  { id: "doorway-low-intrusion", shotSize: "medium-wide", azimuth: "frontal", elevation: "low", arrangement: "doorway-frame", lens: "28mm", foreground: "one soft foreground shoulder silhouette or a strong doorway edge", depth: "three-plane" },
  { id: "overhead-workbench", shotSize: "insert-wide", azimuth: "top", elevation: "overhead", arrangement: "object-led", lens: "35mm", foreground: "hands and tools", depth: "flat-graphic" },
  { id: "counter-level-object", shotSize: "medium", azimuth: "profile-left", elevation: "counter-level", arrangement: "object-led-two-plane", lens: "35mm", foreground: "hero object very large", depth: "three-plane" },
  { id: "macro-hands", shotSize: "extreme-close", azimuth: "three-quarter-right", elevation: "high", arrangement: "hands-insert", lens: "85mm-macro", foreground: "hands and evidence", depth: "shallow" },
  { id: "ots-entry", shotSize: "medium-wide", azimuth: "over-shoulder-left", elevation: "eye", arrangement: "reverse-ots", lens: "40mm", foreground: "blurred shoulder and head", depth: "three-plane" },
  { id: "ots-reaction", shotSize: "close", azimuth: "over-shoulder-right", elevation: "eye", arrangement: "listener-reaction", lens: "65mm", foreground: "soft shoulder edge", depth: "two-plane" },
  { id: "window-profile-reflection", shotSize: "close", azimuth: "profile-right", elevation: "eye", arrangement: "reflection-single", lens: "85mm", foreground: "rain streaks on glass", depth: "two-plane" },
  { id: "foreground-occlusion", shotSize: "medium-close", azimuth: "three-quarter-left", elevation: "eye", arrangement: "foreground-occluded-single", lens: "50mm", foreground: "large soft prop crossing frame", depth: "three-plane" },
  { id: "negative-space-profile", shotSize: "medium-close", azimuth: "profile-left", elevation: "eye", arrangement: "single-negative-space", lens: "70mm", foreground: "none", depth: "two-plane" },
  { id: "low-dominant-close", shotSize: "close", azimuth: "three-quarter-right", elevation: "low", arrangement: "dominant-single", lens: "55mm", foreground: "counter edge", depth: "two-plane" },
  { id: "high-vulnerable-single", shotSize: "medium-close", azimuth: "three-quarter-right", elevation: "high", arrangement: "vulnerable-single", lens: "65mm", foreground: "bag strap or photo edge", depth: "two-plane" },
  { id: "triangular-confrontation", shotSize: "wide", azimuth: "three-quarter-right", elevation: "eye", arrangement: "triangular-depth", lens: "30mm", foreground: "one character in profile", depth: "three-plane" },
  { id: "reverse-profile-duel", shotSize: "medium", azimuth: "profile-right", elevation: "eye", arrangement: "opposed-profiles", lens: "45mm", foreground: "one soft face edge", depth: "two-plane" },
  { id: "phone-over-shoulder", shotSize: "close", azimuth: "over-shoulder-left", elevation: "high", arrangement: "action-insert-ots", lens: "55mm", foreground: "phone and thumb", depth: "three-plane" },
  { id: "floor-level-memory", shotSize: "wide", azimuth: "three-quarter-left", elevation: "child-eye", arrangement: "environmental-two-shot", lens: "28mm", foreground: "grass, curb, or scattered photos", depth: "three-plane" },
  { id: "birdseye-memory", shotSize: "wide", azimuth: "top", elevation: "overhead", arrangement: "graphic-two-shot", lens: "35mm", foreground: "none", depth: "flat-graphic" },
  { id: "intimate-side-two-shot", shotSize: "medium-close", azimuth: "profile-right", elevation: "eye", arrangement: "layered-two-shot", lens: "75mm", foreground: "one soft shoulder", depth: "two-plane" },
  { id: "staircase-diagonal", shotSize: "wide", azimuth: "three-quarter-right", elevation: "high", arrangement: "architectural-diagonal", lens: "28mm", foreground: "stair rail or hanging frames", depth: "three-plane" },
  { id: "exterior-through-glass", shotSize: "wide", azimuth: "frontal", elevation: "eye", arrangement: "through-glass-environment", lens: "35mm", foreground: "rainy window reflections", depth: "three-plane" },
];

const SETUP_BY_ID = new Map(MANGA_COMPOSITION_SETUPS.map((setup) => [setup.id, setup]));

const INTENT_RULES = [
  { intent: "scene-establishing", pattern: /同窓会|華やかな会場|音楽室|講義室|大学の講義|街中|待ち合わせ場所|社会人になって|卒業した|結婚した|子供も二人/u, hardPreferred: true, setups: ["establishing-deep", "exterior-through-glass"] },
  { intent: "time-transition", pattern: /新学期|秋の放課後|夏休みが終わり|10月に入り|春、|ある金曜日の夜/u, hardPreferred: true, setups: ["exterior-through-glass", "establishing-deep", "window-profile-reflection"] },
  { intent: "purpose-reflection", pattern: /志望校|英語を専門的|英語力を活か|学歴がすべて|何を学びたいか/u, hardPreferred: true, setups: ["foreground-occlusion", "window-profile-reflection", "negative-space-profile", "counter-level-object"] },
  { intent: "departure", pattern: /(?:無視して|通り過ぎて?|残して)?(?:去って|出ていって|立ち去って)|映画に向かった/u, hardPreferred: true, setups: ["ots-entry", "doorway-low-intrusion", "exterior-through-glass"] },
  { intent: "arrival", pattern: /到着した|やって来た|現れた|そこへ.+(?:来た|近づいて)/u, hardPreferred: true, setups: ["ots-entry", "doorway-low-intrusion", "exterior-through-glass", "ots-reaction"] },
  { intent: "deflation-reaction", pattern: /勢いは.*削がれ|言葉を失|黙り込|うつむ|意気消沈/u, hardPreferred: true, setups: ["ots-reaction", "high-vulnerable-single", "negative-space-profile"] },
  { intent: "thought", preset: "thought", setups: ["ots-reaction", "foreground-occlusion", "window-profile-reflection", "negative-space-profile"] },
  { intent: "narration", preset: "narration", setups: ["establishing-deep", "exterior-through-glass", "overhead-workbench", "birdseye-memory"] },
  { intent: "evidence", pattern: /ネガ|元データ|作成日時|依頼票|主催者へ送る|撮影者が誰|証拠/, setups: ["macro-hands", "overhead-workbench", "counter-level-object", "phone-over-shoulder"] },
  { intent: "work", pattern: /現像|補修|戻せ|二階|スタジオ|仕事/, setups: ["overhead-workbench", "counter-level-object", "establishing-deep", "staircase-diagonal"] },
  { intent: "memory", pattern: /十年前|子供|約束|昔|祖母|夏/, setups: ["floor-level-memory", "birdseye-memory", "macro-hands", "window-profile-reflection"] },
  { intent: "arrival", pattern: /帰って|東京|迎えに来た|連絡を無視|おかえり/, setups: ["ots-entry", "doorway-low-intrusion", "exterior-through-glass", "ots-reaction"] },
  { intent: "vulnerability", pattern: /分からなく|信じていた|居場所|隣にいたい|ゆっくり|困る/, setups: ["window-profile-reflection", "high-vulnerable-single", "negative-space-profile", "intimate-side-two-shot"] },
  { intent: "challenge", pattern: /戻らない|勝手|売れる側|何になる|失うつもり|中止|解除|確かめ/, setups: ["low-dominant-close", "reverse-profile-duel", "triangular-confrontation", "foreground-occlusion"] },
  { intent: "evidence", pattern: /証明|記録|写真|作品|データ|撮影/, setups: ["macro-hands", "overhead-workbench", "counter-level-object", "phone-over-shoulder"] },
  { intent: "dialogue", pattern: /.*/, setups: ["ots-entry", "ots-reaction", "negative-space-profile", "intimate-side-two-shot", "reverse-profile-duel"] },
];

const INTENT_VISIBLE_ACTION = {
  "scene-establishing": "the new location, time period, crowd scale, and the characters' spatial relationship before closer coverage",
  "time-transition": "the changed season, time of day, and a concrete environmental cue while the characters remain readable",
  "purpose-reflection": "the character's considered choice, motivation, and emotional resolve expressed through face, posture, and one simple text-free prop",
  departure: "the departing character moving decisively toward an exit, the ignored or remaining people reacting behind them, and a clear direction of travel",
  "deflation-reaction": "the challenged character visibly losing momentum through posture, gaze, and expression while the person who caused the reaction remains spatially clear",
  memory: "physical memory cue in the scene: an old photograph, childhood place, or remembered promise",
  evidence: "the exact evidence or recording medium being handled and inspected",
  arrival: "the entrance, distance between people, and the first recognition reaction",
  vulnerability: "restrained body language, averted gaze, and a small protective hand gesture",
  challenge: "opposing eyelines and a visible shift in control between the characters",
  work: "the concrete photographic task, tools, hands, and the unfinished print",
  thought: "the listener's private reaction while the surrounding action falls visually quiet",
  narration: "the location or object that carries the narration without requiring a speaking face",
  dialogue: "the speaker's purposeful gesture and the listener's distinct reaction",
};

const INTENT_MOOD = {
  "scene-establishing": "clear scene orientation with a deliberate sense of arrival",
  "time-transition": "a clear passage of time grounded in the physical environment",
  "purpose-reflection": "quiet conviction and forward-looking resolve",
  departure: "a decisive break in the relationship, with emotional distance widening through blocking",
  "deflation-reaction": "a visible collapse of confidence after a decisive rebuttal",
  memory: "tender, slightly faded warmth",
  evidence: "precise, tense clarity",
  arrival: "held breath and sudden recognition",
  vulnerability: "quiet unease and emotional distance",
  challenge: "compressed tension and unequal power",
  work: "focused, tactile concentration",
  thought: "interior hesitation and narrowed attention",
  narration: "editorial pause with strong negative space",
  dialogue: "natural conversational tension",
};

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function stableIndex(value, length) {
  if (length <= 0) return 0;
  const digest = createHash("sha256").update(String(value)).digest();
  return digest.readUInt32BE(0) % length;
}

function inferIntent(utterance = {}, context = {}) {
  const text = nonEmptyString(utterance.text);
  const preset = nonEmptyString(utterance.preset);
  if (context.sceneStart) {
    return { intent: "scene-establishing", hardPreferred: true, setups: ["establishing-deep", "exterior-through-glass"] };
  }
  return INTENT_RULES.find((rule) => (rule.preset ? rule.preset === preset : rule.pattern?.test(text))) || INTENT_RULES.at(-1);
}

function axisDistance(left, right) {
  if (!left || !right) return 6;
  return ["shotSize", "azimuth", "elevation", "arrangement", "lens", "depth"]
    .reduce((total, key) => total + Number(left[key] !== right[key]), 0);
}

function candidateScore(setup, recent, preferredRank, sequenceIndex) {
  const previous = recent.at(-1);
  const axisChange = axisDistance(previous, setup);
  const duplicatePenalty = recent.some((entry) => entry.id === setup.id) ? 40 : 0;
  const sameArrangementPenalty = recent.slice(-2).some((entry) => entry.arrangement === setup.arrangement) ? 12 : 0;
  const sameSizePenalty = previous?.shotSize === setup.shotSize ? 8 : 0;
  const insufficientChangePenalty = previous && axisChange < 3 ? 60 : 0;
  const deterministicNudge = stableIndex(`${setup.id}:${sequenceIndex}`, 7) / 10;
  return (axisChange * 18) - (preferredRank * 5) - duplicatePenalty - sameArrangementPenalty - sameSizePenalty - insufficientChangePenalty + deterministicNudge;
}

function selectSetup(rule, recent, utterance, sequenceIndex) {
  const preferred = rule.setups.map((id) => SETUP_BY_ID.get(id)).filter(Boolean);
  const fallback = MANGA_COMPOSITION_SETUPS.filter((setup) => !preferred.includes(setup));
  const candidates = rule.hardPreferred ? preferred : [...preferred, ...fallback];
  return candidates
    .map((setup, index) => ({ setup, score: candidateScore(setup, recent, index, sequenceIndex) }))
    .sort((a, b) => b.score - a.score || a.setup.id.localeCompare(b.setup.id))[0].setup;
}

function inferBeatPurpose(utterance, intent) {
  const speaker = nonEmptyString(utterance.speakerName) || nonEmptyString(utterance.speakerId) || "the current speaker";
  if (intent === "scene-establishing") return `Establish the new story location and time period before showing: ${utterance.text}`;
  if (intent === "time-transition") return `Show the season and time transition physically, without relying on written labels: ${utterance.text}`;
  if (intent === "purpose-reflection") return `Show the personal choice and resolve behind: ${utterance.text}`;
  if (intent === "departure") return `Show the departure and the widening emotional distance physically: ${utterance.text}`;
  if (intent === "deflation-reaction") return `Show the loss of confidence as a readable reaction rather than an abstract prop: ${utterance.text}`;
  if (intent === "narration") return `Let the location or a story object carry the meaning of: ${utterance.text}`;
  if (intent === "thought") return `Show ${speaker}'s private recognition rather than a public speaking pose.`;
  return `Make ${speaker}'s line visually specific: ${utterance.text}`;
}

function bubbleReserve(index, setup) {
  const side = index % 2 === 0 ? "right" : "left";
  if (setup.arrangement.includes("ots") || setup.arrangement.includes("single")) return `reserve clean negative space on the ${side}, opposite the face and eyeline`;
  if (setup.arrangement.includes("object")) return `reserve a clean upper-${side} pocket away from the focal object`;
  return `reserve one clean ${side}-side pocket without centering every subject`;
}

export function buildMangaSceneImagePrompt(plan, context = {}) {
  const location = nonEmptyString(context.location) || "the established photo shop location for this episode";
  const cast = Array.isArray(context.cast) && context.cast.length > 0 ? context.cast.join(", ") : "only the story characters required for this beat";
  const continuity = nonEmptyString(context.continuity) || "preserve approved character identity, wardrobe, props, time of day, and shop geography";
  return [
    "Create a new original 16:9 Japanese motion-comic scene image, 1920x1080.",
    `Story beat: ${plan.purpose}`,
    `Visible action: ${plan.visibleAction}.`,
    `Location: ${location}. Cast: ${cast}.`,
    `Camera: ${plan.setup.shotSize}, ${plan.setup.azimuth}, ${plan.setup.elevation} viewpoint, ${plan.setup.lens} visual language.`,
    `Composition: ${plan.setup.arrangement}; ${plan.setup.foreground} in the foreground; ${plan.setup.depth} depth staging.`,
    `Mood and light: ${plan.mood}; make the light source and rain/day continuity physically coherent.`,
    `Editorial space: ${plan.bubbleReserve}.`,
    plan.intent === "departure"
      ? "Departure staging: show one small, soft-focus group of classmates reacting supportively in the background when the story mentions them. They are non-primary crowd, not additional approved cast. Keep the departing character in active mid-stride motion and the protagonist in clear reaction."
      : "",
    `Continuity: ${continuity}.`,
    "The reference images are identity, location, and rendering-style references only. Do not copy their camera position or pose.",
    "No speech bubble, no captions, no readable text, no logo, no watermark, no unintended prominent bystanders, no duplicated body parts. Include a natural background crowd only when the story explicitly requires a reunion, public venue, graduation, workplace, or street activity.",
    "Avoid a centered eye-level two-shot and avoid the same camera setup as the immediately preceding scene.",
  ].filter(Boolean).join("\n");
}

export function planMangaSceneCompositions(input = {}) {
  const manifest = input.manifest;
  if (!manifest?.id || !Array.isArray(manifest.utterances)) {
    throw new Error("A manifest with utterances is required.");
  }
  const recent = [];
  const cutById = new Map((manifest.cuts || []).map((cut) => [cut.id, cut]));
  const beats = manifest.utterances.map((utterance, index) => {
    const cut = cutById.get(utterance.cutId);
    const sceneStart = cut?.utteranceIds?.[0] === utterance.id;
    const rule = inferIntent(utterance, { cutPurpose: cut?.description || cut?.purpose, sceneStart });
    const setup = selectSetup(rule, recent, utterance, index);
    const previous = recent.at(-1);
    const plan = {
      id: `composition:${utterance.id}`,
      utteranceId: utterance.id,
      cutId: utterance.cutId,
      sequenceIndex: index,
      intent: rule.intent,
      purpose: inferBeatPurpose(utterance, rule.intent),
      visibleAction: INTENT_VISIBLE_ACTION[rule.intent],
      mood: INTENT_MOOD[rule.intent],
      setup,
      bubbleReserve: bubbleReserve(index, setup),
      changeFromPreviousAxes: axisDistance(previous, setup),
      speakerId: utterance.speakerId,
      text: utterance.text,
    };
    recent.push(setup);
    if (recent.length > 6) recent.shift();
    return plan;
  });
  const consecutiveTooSimilar = beats.filter((beat, index) => index > 0 && beat.changeFromPreviousAxes < 3);
  const setupCounts = Object.fromEntries([...new Set(beats.map((beat) => beat.setup.id))]
    .sort()
    .map((id) => [id, beats.filter((beat) => beat.setup.id === id).length]));
  return {
    version: MANGA_SCENE_COMPOSITION_VERSION,
    episodeId: manifest.id,
    policy: {
      minimumChangedAxesBetweenConsecutiveBeats: 3,
      recentSetupExclusionWindow: 6,
      dialoguePolicy: "alternate speaker OTS, listener reaction, object-led insert, profile, and depth staging; never default every line to the same two-shot",
      sameLocationPolicy: "change shot size, azimuth, elevation, arrangement, foreground, and depth while preserving geography",
      referencePolicy: "reference images lock identity/location/style only; prompts explicitly forbid copying reference camera and pose",
    },
    diagnostics: {
      beatCount: beats.length,
      uniqueSetupCount: Object.keys(setupCounts).length,
      setupCounts,
      consecutiveTooSimilarCount: consecutiveTooSimilar.length,
      minimumObservedChangedAxes: beats.length > 1 ? Math.min(...beats.slice(1).map((beat) => beat.changeFromPreviousAxes)) : null,
    },
    beats,
  };
}

export function auditMangaCompositionSequence(plan) {
  const beats = Array.isArray(plan?.beats) ? plan.beats : [];
  const issues = [];
  for (let index = 1; index < beats.length; index += 1) {
    const previous = beats[index - 1];
    const current = beats[index];
    const changedAxes = axisDistance(previous.setup, current.setup);
    if (changedAxes < 3) issues.push({ type: "consecutive-camera-similarity", previous: previous.utteranceId, current: current.utteranceId, changedAxes });
    if (previous.setup.id === current.setup.id) issues.push({ type: "consecutive-setup-repeat", previous: previous.utteranceId, current: current.utteranceId });
  }
  return { ok: issues.length === 0, issueCount: issues.length, issues };
}
