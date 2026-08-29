#!/usr/bin/env node
// Blind human comparison via the locally installed bestofn (`bon`) judge UI.
//
//   node scripts/koya-blind-review.mjs open  --set <spec.json>
//   node scripts/koya-blind-review.mjs record --set <spec.json> --winner <label> --reviewer <name> [--note "..."]
//
// bestofn is executed in place from its own checkout (audio playback support
// was contributed there directly). The parts that must be trustworthy for a
// client decision live here rather than in the judge UI:
//   - candidates are salted-shuffled to anonymous labels before the reviewer
//     ever sees them, and the mapping stays in a private file
//   - every candidate is bound by SHA-256 at open time and re-verified at
//     record time, so a file swapped mid-review cannot be certified
//   - the recorded decision carries reviewer, reason, timestamps and digests
//
// Spec JSON:
// {"setId": "horo-hair-color", "kind": "image",
//  "prompt": "どの髪色が一番チャンネルに合いますか",
//  "candidates": [{"id": "akacha", "file": "canvas/assets/....png"}]}
import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const BON_CLI = process.env.BON_CLI
  || "~/まさお/bestofn-repo/bin/bon.js";

function usage() {
  console.error("usage: koya-blind-review.mjs <open|record> --set <spec.json> [--winner L --reviewer NAME --note TEXT]");
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 3; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) usage();
    args[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
}

const command = process.argv[2];
const args = parseArgs(process.argv);
if (!["open", "record"].includes(command) || !args.set) usage();

const projectDir = process.cwd();
const specPath = isAbsolute(args.set) ? args.set : resolve(projectDir, args.set);
const spec = JSON.parse(await readFile(specPath, "utf8"));
if (!spec.setId || !Array.isArray(spec.candidates) || spec.candidates.length < 2) {
  throw new Error("spec needs setId and at least two candidates");
}
const privatePath = join(dirname(specPath), `${spec.setId}.private-mapping.json`);
const decisionPath = join(dirname(specPath), `${spec.setId}.decision.json`);

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"];

if (command === "open") {
  const salt = randomBytes(16).toString("hex");
  // Deterministic-but-unguessable ordering: the reviewer cannot infer the
  // source from position, and the shuffle is reproducible from the salt.
  const ordered = [...spec.candidates]
    .map((candidate) => ({
      candidate,
      sortKey: createHash("sha256").update(`${salt}:${candidate.id}`).digest("hex"),
    }))
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey))
    .map((entry, index) => ({ label: LABELS[index], ...entry.candidate }));
  if (ordered.length > LABELS.length) throw new Error(`at most ${LABELS.length} candidates`);

  const files = [];
  const mapping = [];
  for (const entry of ordered) {
    const file = isAbsolute(entry.file) ? entry.file : resolve(projectDir, entry.file);
    mapping.push({ label: entry.label, id: entry.id, file, sha256: await sha256(file) });
    files.push(file);
  }
  const { stdout } = await execFile("node", [
    BON_CLI, "ask", "--spec", spec.prompt || `Pick the best ${spec.kind || "candidate"}`, ...files,
  ], { cwd: projectDir, maxBuffer: 8 * 1024 * 1024 });
  // bon prints ids as <timestamp>-<suffix>; take the full token, not a prefix.
  const tournamentId = (stdout.match(/\b\d{8}T\d{6}-[a-z0-9]+\b/i) || [])[0];
  if (!tournamentId) throw new Error(`could not read tournament id from bon output: ${stdout.slice(0, 200)}`);
  await mkdir(dirname(privatePath), { recursive: true });
  const body = {
    setId: spec.setId,
    kind: spec.kind || "image",
    prompt: spec.prompt || "",
    salt,
    tournamentId,
    openedAt: new Date().toISOString(),
    mapping,
  };
  // Opening commitment: the digest is computed BEFORE the review and checked
  // again at record time, so editing the mapping mid-review is detectable
  // (previously the digest was recomputed from whatever the file then held).
  const commitmentDigest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  await writeFile(privatePath, `${JSON.stringify({ ...body, commitmentDigest }, null, 1)}\n`);
  console.log(JSON.stringify({
    status: "opened", setId: spec.setId, tournamentId,
    candidates: mapping.length, privateMapping: privatePath,
    next: `node ${BON_CLI} serve -d --open   # then: koya-blind-review.mjs record --set ... --winner A --reviewer <name>`,
  }));
} else {
  if (!args.winner || !args.reviewer) usage();
  const priv = JSON.parse(await readFile(privatePath, "utf8"));
  const { commitmentDigest, ...openedBody } = priv;
  if (!commitmentDigest) throw new Error("private mapping has no opening commitment; reopen the set");
  if (createHash("sha256").update(JSON.stringify(openedBody)).digest("hex") !== commitmentDigest) {
    throw new Error("private mapping changed after the set was opened; reopen the set");
  }
  if (!args.note || String(args.note).trim().length < 4) {
    throw new Error("--note is required: a decision without a stated reason cannot be carried into the harness");
  }
  const winner = priv.mapping.find((entry) => entry.label === String(args.winner).toUpperCase());
  if (!winner) throw new Error(`unknown label ${args.winner}`);
  // Re-verify every candidate: a file replaced during the review must not be
  // certified by a decision taken on the earlier pixels.
  const drifted = [];
  for (const entry of priv.mapping) {
    if (await sha256(entry.file) !== entry.sha256) drifted.push(entry.label);
  }
  if (drifted.length > 0) {
    throw new Error(`candidate files changed during review: ${drifted.join(", ")} — reopen the set`);
  }
  const decision = {
    setId: priv.setId,
    kind: priv.kind,
    prompt: priv.prompt,
    tournamentId: priv.tournamentId,
    winner: { label: winner.label, id: winner.id, file: winner.file, sha256: winner.sha256 },
    reviewer: args.reviewer,
    note: args.note || "",
    decidedAt: new Date().toISOString(),
    openedAt: priv.openedAt,
    candidates: priv.mapping.map((entry) => ({ label: entry.label, id: entry.id, sha256: entry.sha256 })),
    openingCommitmentDigest: commitmentDigest,
    tool: "bestofn (bon) judge UI, executed from its own checkout",
  };
  await writeFile(decisionPath, `${JSON.stringify(decision, null, 1)}\n`);
  console.log(JSON.stringify({ status: "recorded", winner: decision.winner, decision: decisionPath }));
}
