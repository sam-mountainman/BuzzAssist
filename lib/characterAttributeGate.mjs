// Deterministic attribute gates for character candidate revisions (ledger
// R187-R190). Wraps scripts/audit-koya-candidate-attributes.py so the
// candidate/styling stage can run the same maker/checker split as episode
// production: machine gates first, human review only on survivors.
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";

import { createMangaQualityContract } from "./mangaQualityHarness.mjs";

const execFile = promisify(execFileCallback);

export const CHARACTER_ATTRIBUTE_GATE_SCRIPT = fileURLToPath(
  new URL("../scripts/audit-koya-candidate-attributes.py", import.meta.url),
);

export const CHARACTER_ATTRIBUTE_HARD_GATES = Object.freeze([
  "attribute-hair-color-delta",
  "attribute-duplicate-takes",
  "attribute-unintended-change",
  "attribute-neck-ornament-screen",
  "attribute-eye-side-fullview-human",
]);

/** Run the deterministic attribute checks and return the parsed report. */
export async function auditCandidateAttributes(input = {}) {
  const checks = Array.isArray(input.checks) ? input.checks : [];
  if (checks.length === 0) throw new Error("auditCandidateAttributes requires at least one check.");
  const python = typeof input.python === "string" && input.python ? input.python : "python3";
  const workDir = await mkdtemp(join(tmpdir(), "koya-attribute-gate-"));
  const configPath = join(workDir, "checks.json");
  try {
    await writeFile(configPath, `${JSON.stringify({ checks }, null, 1)}\n`);
    let stdout = "";
    try {
      ({ stdout } = await execFile(python, [CHARACTER_ATTRIBUTE_GATE_SCRIPT, configPath], {
        cwd: input.cwd,
        maxBuffer: 16 * 1024 * 1024,
      }));
    } catch (error) {
      // Exit code 3 means "checks ran, at least one failed" and still prints a report.
      if (error?.code === 3 && typeof error.stdout === "string" && error.stdout.trim()) {
        stdout = error.stdout;
      } else {
        throw new Error(`attribute gate script failed: ${String(error.stderr || error.message).slice(0, 400)}`);
      }
    }
    const report = JSON.parse(stdout);
    if (!report || !Array.isArray(report.checks)) throw new Error("attribute gate script returned no checks.");
    return report;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Bind an attribute report to an immutable quality contract as its hard-gate report. */
// Which python check TYPE satisfies each mandatory contract gate; the
// eye-side gate is a human judgment and needs an explicit attestation.
export const GATE_ID_TO_CHECK_TYPE = Object.freeze({
  "attribute-hair-color-delta": "hairColorDelta",
  "attribute-duplicate-takes": "duplicateTakes",
  "attribute-unintended-change": "unintendedChange",
  "attribute-neck-ornament-screen": "neckOrnament",
  "attribute-eye-side-fullview-human": "human",
});

export function attributeHardGateReport(report, contract, options = {}) {
  if (!contract?.digest) throw new Error("attributeHardGateReport requires an immutable contract.");
  if (!report || !Array.isArray(report.checks) || report.checks.length === 0) {
    throw new Error("attributeHardGateReport requires a gate report with at least one executed check.");
  }
  // Recompute pass from the individual statuses instead of trusting the
  // report's own overall verdict (self-declared summaries are not evidence).
  const gates = report.checks.map((check) => {
    if (!check?.type || !["pass", "warn", "fail"].includes(check?.status)) {
      throw new Error("Every attribute gate result needs a type and a pass/warn/fail status.");
    }
    return {
      id: check.id,
      type: check.type,
      status: check.status,
      inputSha256: check.inputSha256 ?? {},
    };
  });
  const failedGateIds = gates.filter((gate) => gate.status === "fail").map((gate) => gate.id);
  // Coverage check (Codex final audit): every mandatory gate in the contract
  // must actually have been EXECUTED — "one check ran and nothing failed" is
  // not evidence that the required five were performed. Machine gates are
  // covered by check TYPE; the human eye-side gate needs an explicit
  // attestation with a reviewer, never a default.
  const executedTypes = new Set(gates.map((gate) => gate.type));
  const humanGates = (options.humanGates ?? []).map((gate) => {
    if (!gate?.id || !["pass", "warn", "fail"].includes(gate?.status) || !gate?.reviewer) {
      throw new Error("Every human gate attestation needs id, pass/warn/fail status and a reviewer.");
    }
    return { id: gate.id, type: "human", status: gate.status, reviewer: gate.reviewer };
  });
  const attestedHuman = new Set(humanGates.map((gate) => gate.id));
  const missingGateIds = contract.hardGates
    .filter((gateId) => CHARACTER_ATTRIBUTE_HARD_GATES.includes(gateId))
    .filter((gateId) => {
      const requiredType = GATE_ID_TO_CHECK_TYPE[gateId];
      if (requiredType === "human") return !attestedHuman.has(gateId);
      return !executedTypes.has(requiredType);
    });
  const humanFailed = humanGates.filter((gate) => gate.status === "fail").map((gate) => gate.id);
  return {
    contractDigest: contract.digest,
    pass: failedGateIds.length === 0 && humanFailed.length === 0 && missingGateIds.length === 0,
    failedGateIds: [...failedGateIds, ...humanFailed],
    missingGateIds,
    gates: [...gates, ...humanGates],
  };
}

/**
 * Character candidate/styling stage contract. Reuses the episode quality
 * harness so evaluator separation, capped rounds and failure fingerprints
 * apply to candidate work exactly as they do to rendered video.
 */
export function buildCharacterCandidateQualityContract(input = {}) {
  const castId = typeof input.castId === "string" && input.castId ? input.castId : "";
  if (!castId) throw new Error("buildCharacterCandidateQualityContract requires castId.");
  const overrides = { ...(input.overrides ?? {}) };
  // The mandatory attribute gates are merged AFTER caller overrides so no
  // override can silently drop them; extra gates only ever extend the list.
  overrides.hardGates = [...new Set([
    ...CHARACTER_ATTRIBUTE_HARD_GATES,
    ...(input.extraHardGates ?? []),
    ...(Array.isArray(overrides.hardGates) ? overrides.hardGates : []),
  ])];
  overrides.maximumReviewRounds = input.maximumReviewRounds ?? overrides.maximumReviewRounds ?? 3;
  overrides.maximumStagnantRounds = input.maximumStagnantRounds ?? overrides.maximumStagnantRounds ?? 2;
  return createMangaQualityContract({
    manifest: { id: `character-${castId}` },
    channelDirectives: input.channelDirectives,
    overrides,
  });
}
