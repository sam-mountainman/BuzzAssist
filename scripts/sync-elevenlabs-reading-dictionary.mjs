#!/usr/bin/env node
// Sync the channel reading dictionary to an ElevenLabs pronunciation
// dictionary (alias rules) so promoted readings apply natively inside the
// API in addition to local text substitution. Re-creates the dictionary
// whenever the active rule set changes and stores {dictionaryId, versionId,
// rulesHash} back into the dictionary file.
//
//   node scripts/sync-elevenlabs-reading-dictionary.mjs [--dictionary <path>] [--dry-run]
//
// Requires ELEVENLABS_API_KEY in the environment (never printed).
import { resolve } from "node:path";
import process from "node:process";

import {
  buildElevenLabsRules,
  readReadingDictionary,
  readingRulesHash,
  writeReadingDictionary,
} from "../lib/readingDictionary.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const pathIndex = args.indexOf("--dictionary");
const dictionaryPath = resolve(pathIndex >= 0 ? args[pathIndex + 1] : "config/koya-reading-dictionary.json");

const dictionary = await readReadingDictionary(dictionaryPath);
const rules = buildElevenLabsRules(dictionary);
if (rules.length === 0) {
  // Fail-closed: with no active rules a previously synced dictionary id must
  // not keep applying old readings — clear the binding so production stops
  // attaching the stale locator (removal on the API side stays a human step).
  if (dictionary.elevenlabs?.dictionaryId && !dryRun) {
    const stale = dictionary.elevenlabs;
    delete dictionary.elevenlabs;
    await writeReadingDictionary(dictionaryPath, dictionary);
    console.log(JSON.stringify({ status: "cleared-stale-binding", previousDictionaryId: stale.dictionaryId }));
    process.exit(0);
  }
  console.log(JSON.stringify({ status: "noop", reason: "no active entries" }));
  process.exit(0);
}
const rulesHash = readingRulesHash(rules);
if (dictionary.elevenlabs?.rulesHash === rulesHash && dictionary.elevenlabs?.dictionaryId) {
  console.log(JSON.stringify({ status: "up-to-date", dictionaryId: dictionary.elevenlabs.dictionaryId, rules: rules.length }));
  process.exit(0);
}
if (dryRun) {
  console.log(JSON.stringify({ status: "would-sync", rules: rules.length, rulesHash }));
  process.exit(0);
}
const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) {
  console.error("ELEVENLABS_API_KEY is not set");
  process.exit(1);
}
const response = await fetch("https://api.elevenlabs.io/v1/pronunciation-dictionaries/add-from-rules", {
  method: "POST",
  headers: { "xi-api-key": apiKey, "content-type": "application/json" },
  body: JSON.stringify({
    name: `koya-reading-dictionary-${rulesHash.slice(0, 8)}`,
    description: "Channel reading dictionary (auto-promoted misreadings, R194)",
    rules,
  }),
});
if (!response.ok) {
  console.error(`sync failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  process.exit(1);
}
const payload = await response.json();
dictionary.elevenlabs = {
  dictionaryId: payload.id,
  versionId: payload.version_id,
  rulesHash,
  syncedAt: new Date().toISOString(),
  ruleCount: rules.length,
};
await writeReadingDictionary(dictionaryPath, dictionary);
console.log(JSON.stringify({ status: "synced", dictionaryId: payload.id, versionId: payload.version_id, rules: rules.length }));
