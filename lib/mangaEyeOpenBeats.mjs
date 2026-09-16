// Eye-open (開眼) beats for script-driven manga images.
//
// Some approved characters are drawn with their eyes closed by default and
// open them only at a dramatic moment. Those moments must bind the approved
// eyes-open sheet; every other image must keep the default eyes. This module
// decides, per utterance image, which characters are in their eyes-open state
// and which approved variant applies. It is pure: the image plan checks the
// registry sheets and the reference budget.
//
// Two sources, never mixed:
//   - reviewed beats (an independent reviewer bound utterance ids), which
//     replace detection entirely when supplied;
//   - detection from the script text, used only when no reviewed list exists.

const SENTENCE_SPLIT = /[。！？!?\n]/u;
// Explicit 開眼 wording is character-specific enough to apply to the only
// eye-open candidate on screen even when the sentence names nobody.
const STRONG_CUE = /開眼|糸目(?:が|を)[^。\n]{0,8}?(?:開|ひら)/u;
// Common "eyes open wide" wording is also used for plain surprise, so it only
// counts when the sentence names the eye-open candidate.
const WEAK_CUE = /見開|カッと[^。\n]{0,2}(?:目|眼)|(?:目|眼)を?カッと|(?:目|眼|瞳)(?:を|が)(?:(?!閉|細|伏|つむ|つぶ|瞑|口)[^。\n]){0,6}?(?:開|ひら|剥|む[いきく])/u;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isNarration(utterance) {
  return utterance?.speakerId === "narration" || utterance?.preset === "narration";
}

export function normalizeEyeOpenCandidates(candidates = []) {
  const seen = new Set();
  return (Array.isArray(candidates) ? candidates : []).map((entry) => {
    const characterId = nonEmptyString(entry?.characterId);
    const names = [...new Set([characterId, ...(Array.isArray(entry?.names) ? entry.names : [])].map(nonEmptyString).filter(Boolean))];
    return {
      characterId,
      label: nonEmptyString(entry?.label) || names.find((name) => name !== characterId) || characterId,
      names,
      variants: (Array.isArray(entry?.variants) ? entry.variants : []).map((variant) => ({
        id: nonEmptyString(variant?.id),
        label: nonEmptyString(variant?.label) || nonEmptyString(variant?.id),
        cues: (Array.isArray(variant?.cues) ? variant.cues : []).map(nonEmptyString).filter(Boolean),
      })).filter((variant) => variant.id),
    };
  }).filter((entry) => {
    if (!entry.characterId || seen.has(entry.characterId)) return false;
    seen.add(entry.characterId);
    return true;
  });
}

function mentions(text, candidate) {
  // One-character names collide with ordinary words; require two or more.
  return candidate.names.some((name) => name.length >= 2 && text.includes(name));
}

function speaks(utterance, candidate) {
  return candidate.names.includes(nonEmptyString(utterance?.speakerId))
    || candidate.names.includes(nonEmptyString(utterance?.speakerName));
}

function visibleCandidates(cut, candidates) {
  const text = [cut.purpose, ...(cut.utterances || []).map((entry) => entry.text)].join("\n");
  return candidates.filter((candidate) => (cut.utterances || []).some((entry) => speaks(entry, candidate)) || mentions(text, candidate));
}

function cueSubjects(text, candidates, onScreen) {
  const subjects = new Map();
  const ambiguous = [];
  for (const sentence of String(text || "").split(SENTENCE_SPLIT).map((entry) => entry.trim()).filter(Boolean)) {
    const strong = STRONG_CUE.test(sentence);
    if (!strong && !WEAK_CUE.test(sentence)) continue;
    const named = candidates.filter((candidate) => mentions(sentence, candidate));
    if (named.length > 0) {
      for (const candidate of named) subjects.set(candidate.characterId, [...(subjects.get(candidate.characterId) || []), sentence]);
    } else if (strong && onScreen.length === 1) {
      subjects.set(onScreen[0].characterId, [...(subjects.get(onScreen[0].characterId) || []), sentence]);
    } else if (strong && onScreen.length > 1) {
      ambiguous.push(sentence);
    }
  }
  return { subjects, ambiguous };
}

function chooseVariant(candidate, contextText) {
  if (candidate.variants.length <= 1) return { variant: candidate.variants[0]?.id || "", matched: [] };
  const scored = candidate.variants.map((variant) => ({
    id: variant.id,
    score: variant.cues.reduce((sum, cue) => sum + (contextText.split(cue).length - 1), 0),
  }));
  const best = Math.max(...scored.map((entry) => entry.score));
  const winners = scored.filter((entry) => entry.score === best && best > 0);
  return winners.length === 1
    ? { variant: winners[0].id, matched: winners }
    : { variant: "", matched: scored.filter((entry) => entry.score > 0) };
}

/**
 * Detect eye-open beats from the script text.
 *
 * A cue in the cut heading opens the eyes for the whole cut; a cue in a
 * narration line opens them from that line to the end of the cut. Dialogue
 * text is never a cue source ("open your eyes and look" is not a beat).
 * Returns beats plus unresolved findings; callers decide whether to stop.
 */
export function detectMangaEyeOpenBeats({ cuts = [], candidates = [] } = {}) {
  const normalized = normalizeEyeOpenCandidates(candidates);
  const beats = [];
  const unresolved = [];
  for (const cut of Array.isArray(cuts) ? cuts : []) {
    const utterances = Array.isArray(cut?.utterances) ? cut.utterances : [];
    const onScreen = visibleCandidates(cut, normalized);
    if (onScreen.length === 0) continue;
    const openedAt = new Map();
    const cueText = new Map();
    const record = (found, index) => {
      for (const [characterId, sentences] of found.subjects) {
        if (!openedAt.has(characterId)) openedAt.set(characterId, index);
        cueText.set(characterId, [...(cueText.get(characterId) || []), ...sentences]);
      }
      for (const sentence of found.ambiguous) {
        unresolved.push({ kind: "subject", cutId: cut.id, utteranceId: utterances[index]?.id || "", sentence, candidates: onScreen.map((entry) => entry.characterId) });
      }
    };
    record(cueSubjects(cut.purpose, normalized, onScreen), 0);
    utterances.forEach((utterance, index) => {
      if (isNarration(utterance)) record(cueSubjects(utterance.text, normalized, onScreen), index);
    });
    for (const [characterId, start] of openedAt) {
      const candidate = normalized.find((entry) => entry.characterId === characterId);
      const contextText = [
        cut.purpose,
        ...(cueText.get(characterId) || []),
        ...utterances.filter((entry) => speaks(entry, candidate)).map((entry) => entry.text),
      ].join("\n");
      const choice = chooseVariant(candidate, contextText);
      if (candidate.variants.length > 1 && !choice.variant) {
        unresolved.push({
          kind: "variant",
          cutId: cut.id,
          utteranceId: utterances[start]?.id || "",
          characterId,
          variants: candidate.variants.map((variant) => variant.id),
          matched: choice.matched.map((entry) => entry.id),
        });
      }
      for (const utterance of utterances.slice(start)) {
        beats.push({
          utteranceId: utterance.id,
          cutId: cut.id,
          characterId,
          variant: choice.variant,
          source: "script-cue",
          cue: (cueText.get(characterId) || [])[0] || "",
        });
      }
    }
  }
  return { beats, unresolved };
}

/**
 * Resolve the beats a plan must honour. Reviewed beats, when supplied as an
 * array, are authoritative; otherwise detection runs and any unresolved
 * subject or variant stops the plan.
 */
export function resolveMangaEyeOpenBeats({ cuts = [], candidates = [], reviewedBeats = null } = {}) {
  if (Array.isArray(reviewedBeats)) {
    const utteranceIds = new Set((Array.isArray(cuts) ? cuts : []).flatMap((cut) => (cut.utterances || []).map((entry) => entry.id)));
    const cutByUtterance = new Map((Array.isArray(cuts) ? cuts : []).flatMap((cut) => (cut.utterances || []).map((entry) => [entry.id, cut.id])));
    const seen = new Set();
    const beats = reviewedBeats.map((entry) => ({
      utteranceId: nonEmptyString(entry?.utteranceId),
      cutId: cutByUtterance.get(nonEmptyString(entry?.utteranceId)) || "",
      characterId: nonEmptyString(entry?.characterId),
      variant: nonEmptyString(entry?.variant),
      source: "review",
      cue: nonEmptyString(entry?.reason),
    }));
    for (const beat of beats) {
      if (!utteranceIds.has(beat.utteranceId)) throw new Error(`Reviewed eye-open beat names an unknown utterance: ${beat.utteranceId || "(missing)"}.`);
      if (!beat.characterId) throw new Error(`Reviewed eye-open beat ${beat.utteranceId} has no character.`);
      const key = `${beat.utteranceId}\n${beat.characterId}`;
      if (seen.has(key)) throw new Error(`Reviewed eye-open beat ${beat.utteranceId} lists ${beat.characterId} twice.`);
      seen.add(key);
    }
    return { beats, source: "review" };
  }
  const detected = detectMangaEyeOpenBeats({ cuts, candidates });
  if (detected.unresolved.length > 0) {
    const detail = detected.unresolved.map((entry) => (entry.kind === "variant"
      ? `${entry.utteranceId}: ${entry.characterId} opens their eyes but the lines do not select one of ${entry.variants.join("/")}${entry.matched.length > 0 ? ` (cues matched ${entry.matched.join(", ")})` : ""}`
      : `${entry.utteranceId}: "${entry.sentence}" does not say which of ${entry.candidates.join("/")} opens their eyes`));
    throw new Error(`Eye-open beats need a reviewed binding before generation:\n- ${detail.join("\n- ")}`);
  }
  return { beats: detected.beats, source: "script-cue" };
}
