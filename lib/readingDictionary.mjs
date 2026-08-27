// Channel reading dictionary with incident escalation (ledger R194 / Phase 3):
// a misreading caught once becomes a candidate; caught twice it becomes an
// active entry that is merged into every episode's speech pronunciations
// automatically. Entries can also be exported as an ElevenLabs pronunciation
// lexicon (PLS, alias replacement) for official dictionary registration.
import { readFile, writeFile } from "node:fs/promises";

const VERSION = "koya-reading-dictionary-v1";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

// Surfaces that must never auto-promote to global: context decides their
// reading, so a global alias would corrupt other lines (Codex review).
export const READING_PROMOTION_BLOCKLIST = new Set([
  "方", "他", "何", "辛い", "行った", "行って", "人気", "大人気", "上手", "下手",
  "一日", "二日", "今日", "明日", "昨日", "一人", "二人", "大事", "見物", "生物",
]);

export async function readReadingDictionary(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { version: VERSION, entries: [] };
    throw error;
  }
  // A corrupt dictionary must stop the pipeline, not silently become empty.
  const parsed = JSON.parse(raw);
  return { version: VERSION, entries: [], ...parsed };
}

export async function writeReadingDictionary(path, dictionary) {
  await writeFile(path, `${JSON.stringify(dictionary, null, 1)}\n`);
}

/**
 * Record one observed misreading. First observation registers a candidate;
 * the second observation of the same surface promotes it to active so it is
 * applied automatically from then on. A conflicting reading for an already
 * known surface is rejected instead of silently overwritten.
 */
function promotionBlocked(surface) {
  return [...surface].length === 1 || READING_PROMOTION_BLOCKLIST.has(surface);
}

export function recordMisreading(dictionary, input = {}) {
  const surface = nonEmptyString(input.surface);
  const reading = nonEmptyString(input.reading);
  const context = nonEmptyString(input.context);
  const eventId = nonEmptyString(input.eventId);
  const observedAt = nonEmptyString(input.observedAt) || new Date().toISOString();
  if (!surface || !reading) throw new Error("recordMisreading requires surface and reading.");
  const entries = Array.isArray(dictionary.entries) ? dictionary.entries : [];
  const existing = entries.find((entry) => entry.from === surface);
  if (existing) {
    if (existing.to !== reading) {
      throw new Error(
        `conflicting reading for ${surface}: recorded "${existing.to}", observed "${reading}" — resolve by hand.`,
      );
    }
    // The same incident retried must not count twice toward promotion.
    if (eventId && (existing.eventIds ?? []).includes(eventId)) return existing;
    if (eventId) existing.eventIds = [...(existing.eventIds ?? []), eventId];
    existing.occurrences += 1;
    existing.lastSeen = observedAt;
    if (context && !existing.contexts.includes(context)) existing.contexts.push(context);
    if (existing.occurrences >= 2) {
      if (promotionBlocked(surface)) {
        existing.status = "needs-human-review";
      } else {
        existing.status = "active";
      }
    }
    return existing;
  }
  const entry = {
    from: surface,
    to: reading,
    status: "candidate",
    scope: nonEmptyString(input.scope) || "global",
    occurrences: 1,
    firstSeen: observedAt,
    lastSeen: observedAt,
    contexts: context ? [context] : [],
    eventIds: eventId ? [eventId] : [],
  };
  entries.push(entry);
  dictionary.entries = entries;
  return entry;
}

export function activeReadingEntries(dictionary) {
  return (dictionary.entries ?? []).filter((entry) => entry.status === "active");
}

/**
 * Merge active dictionary entries into an episode's pronunciation list.
 * Episode-authored entries win over the channel dictionary on conflicts.
 */
export function mergeIntoPronunciations(dictionary, episodeEntries = []) {
  const bySurface = new Map();
  for (const entry of activeReadingEntries(dictionary)) {
    bySurface.set(entry.from, { from: entry.from, to: entry.to });
  }
  for (const entry of episodeEntries) {
    const from = nonEmptyString(entry?.from);
    const to = nonEmptyString(entry?.to);
    if (from && to) bySurface.set(from, { from, to });
  }
  return [...bySurface.values()];
}

/**
 * Build ElevenLabs pronunciation-dictionary alias rules from active entries.
 * word_boundaries is false because Japanese text has no space-delimited word
 * boundaries — a true value would prevent every match.
 */
export function buildElevenLabsRules(dictionary) {
  // Longest surface first: ElevenLabs applies the first matching rule, so a
  // short surface must never shadow a longer compound containing it.
  return [...activeReadingEntries(dictionary)]
    .sort((left, right) => [...right.from].length - [...left.from].length)
    .map((entry) => ({
    string_to_replace: entry.from,
    type: "alias",
    alias: entry.to,
    case_sensitive: true,
    word_boundaries: false,
  }));
}

export function readingRulesHash(rules) {
  const canonical = JSON.stringify(rules);
  let hash = 0n;
  for (const ch of canonical) hash = (hash * 131n + BigInt(ch.codePointAt(0))) % (2n ** 64n);
  return hash.toString(16).padStart(16, "0");
}

function escapeXml(value) {
  return value.replace(/[<>&'"]/gu, (ch) => (
    { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[ch]
  ));
}

/** Export active entries as an ElevenLabs-compatible PLS alias lexicon. */
export function exportElevenLabsLexicon(dictionary, { language = "ja" } = {}) {
  const lexemes = activeReadingEntries(dictionary).map((entry) => [
    "  <lexeme>",
    `    <grapheme>${escapeXml(entry.from)}</grapheme>`,
    `    <alias>${escapeXml(entry.to)}</alias>`,
    "  </lexeme>",
  ].join("\n"));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<lexicon version="1.0"',
    '  xmlns="http://www.w3.org/2005/01/pronunciation-lexicon"',
    `  alphabet="ipa" xml:lang="${escapeXml(language)}">`,
    ...lexemes,
    "</lexicon>",
    "",
  ].join("\n");
}
