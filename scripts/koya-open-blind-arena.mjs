#!/usr/bin/env node
// Open an EXISTING official blind candidate packet in the bestofn judge UI.
//
//   node scripts/koya-open-blind-arena.mjs --public <public-packet.json> [--serve]
//
// The harness already anonymises candidates and holds the authoritative
// private mapping; this only gives the human a way to look at them without
// reading file names. The decision is still recorded through the official
// path (`character-approve` / `character-style-select` / recordBlindCandidateVerdict),
// never through the judge UI's own state — bon is the viewer, not the record.
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const BON_CLI = process.env.BON_CLI || "~/まさお/bestofn-repo/bin/bon.js";

function usage() {
  console.error("usage: koya-open-blind-arena.mjs --public <public-packet.json> [--serve] [--prompt TEXT]");
  process.exit(1);
}

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (!key.startsWith("--")) usage();
  if (key === "--serve") args.serve = true;
  else { args[key.slice(2)] = process.argv[i + 1]; i += 1; }
}
if (!args.public) usage();

const publicPath = isAbsolute(args.public) ? args.public : resolve(process.cwd(), args.public);
const packet = JSON.parse(await readFile(publicPath, "utf8"));
const candidates = packet.candidates || [];
if (candidates.length < 2) throw new Error("public packet needs at least two candidates");
// The packet's own digest must hold before anything is shown: an edited
// packet is not a blind set (Codex audit 2026-08-28).
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)]),
  );
}
if (packet.digest) {
  // Same canonical form the harness used when writing the packet
  // (lib/mangaBlindCandidateStore.mjs): key order must not change the digest.
  const { digest, ...body } = packet;
  const actual = createHash("sha256").update(JSON.stringify(stable(body))).digest("hex");
  if (actual !== digest) throw new Error("public packet digest mismatch; the packet was modified after it was written");
}

// Verify each artifact against the packet digest before showing it: a human
// must never judge pixels that no longer match what the packet certifies.
const files = [];
for (const candidate of candidates) {
  const ref = candidate.artifactRef;
  if (!ref) throw new Error(`candidate ${candidate.label} has no artifactRef`);
  const file = isAbsolute(ref) ? ref : resolve(dirname(publicPath), ref);
  if (!candidate.artifactSha256) {
    throw new Error(`candidate ${candidate.label} has no artifactSha256; an unbound artifact cannot be reviewed blind`);
  }
  const actual = createHash("sha256").update(await readFile(file)).digest("hex");
  if (actual !== candidate.artifactSha256) {
    throw new Error(`artifact digest mismatch for ${candidate.label}: packet ${candidate.artifactSha256.slice(0, 12)}, file ${actual.slice(0, 12)}`);
  }
  files.push(file);
}

const prompt = args.prompt || `${packet.setId}: どれが一番良いですか（出所は伏せています）`;
const { stdout } = await execFile("node", [BON_CLI, "ask", "--spec", prompt, ...files], {
  cwd: process.cwd(),
  maxBuffer: 16 * 1024 * 1024,
});
const tournamentId = (stdout.match(/\b\d{8}T\d{6}-[a-z0-9]+\b/i) || [])[0];
if (!tournamentId) throw new Error(`could not read tournament id from bon output: ${stdout.slice(0, 200)}`);

if (args.serve) await execFile("node", [BON_CLI, "serve", "-d", "--open"], { cwd: process.cwd() });

console.log(JSON.stringify({
  status: "arena-opened",
  setId: packet.setId,
  tournamentId,
  candidates: candidates.map((candidate) => candidate.label),
  viewerOnly: true,
  recordDecisionWith: "the official CLI (character-approve / character-style-select) with --selection-reason; the arena pick is not the record",
}, null, 1));
