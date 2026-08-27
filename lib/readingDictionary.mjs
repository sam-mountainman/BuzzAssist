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

export async function readReadingDictionary(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return { version: VERSION, entries: [], ...parsed };
  } catch {
    return { version: VERSION, entries: [] };
  }
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
export function recordMisreading(dictionary, input = {}) {
  const surface = nonEmptyString(input.surface);
  const reading = nonEmptyString(input.reading);
  const context = nonEmptyString(input.context);
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
    existing.occurrences += 1;
    existing.lastSeen = observedAt;
    if (context && !existing.contexts.includes(context)) existing.contexts.push(context);
    if (existing.occurrences >= 2) existing.status = "active";
    return existing;
  }
  const entry = {
    from: surface,
    to: reading,
    status: "candidate",
    occurrences: 1,
    firstSeen: observedAt,
    lastSeen: observedAt,
    contexts: context ? [context] : [],
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
