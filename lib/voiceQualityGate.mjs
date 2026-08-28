// Node wrapper for scripts/audit-voice-quality.py (ledger R194): runs the
// Japanese voice quality gates (kana-normalized CER, UTMOS floor, prosody,
// loudness, speaker anchor) and converts a report into take-selection
// penalties. Availability is always reported explicitly — a missing python
// stack degrades to a declared "unavailable", never to a silent pass.
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const VOICE_QUALITY_GATE_SCRIPT = fileURLToPath(
  new URL("../scripts/audit-voice-quality.py", import.meta.url),
);

let availabilityCache = null;

/** Cheap dependency probe so callers can degrade with an explicit reason. */
export async function voiceQualityAvailable(python = "python3") {
  if (availabilityCache !== null) return availabilityCache;
  try {
    await execFile(python, ["-c", "import numpy, soundfile, pyworld"]);
    availabilityCache = true;
  } catch {
    availabilityCache = false;
  }
  return availabilityCache;
}

export function resetVoiceQualityAvailabilityCache() {
  availabilityCache = null;
}

/** Run the gate script on one or more audio checks and return the report. */
export async function auditVoiceQuality(input = {}) {
  const checks = Array.isArray(input.checks) ? input.checks : [];
  if (checks.length === 0) throw new Error("auditVoiceQuality requires at least one check.");
  const python = typeof input.python === "string" && input.python ? input.python : "python3";
  const workDir = await mkdtemp(join(tmpdir(), "voice-quality-gate-"));
  const configPath = join(workDir, "checks.json");
  try {
    await writeFile(configPath, `${JSON.stringify({ checks }, null, 1)}\n`);
    let stdout = "";
    // Environment allowlist: the QA child runs third-party inference code and
    // must never inherit provider API keys (Codex review 2026-08-28).
    const env = Object.fromEntries(
      ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "PYTHONPATH", "HF_HOME", "VOICE_QA_SPEAKER_BACKEND"]
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]]),
    );
    try {
      ({ stdout } = await execFile(python, [VOICE_QUALITY_GATE_SCRIPT, configPath], {
        cwd: input.cwd,
        env,
        maxBuffer: 32 * 1024 * 1024,
      }));
    } catch (error) {
      if (error?.code === 3 && typeof error.stdout === "string" && error.stdout.trim()) {
        stdout = error.stdout;
      } else {
        throw new Error(`voice quality gate failed: ${String(error.stderr || error.message).slice(0, 400)}`);
      }
    }
    const report = JSON.parse(stdout);
    if (!report || !Array.isArray(report.checks)) throw new Error("voice quality gate returned no checks.");
    return report;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Convert one check result into a take-selection penalty. Selection scores
 * are "lower is better"; a hard failure pushes the take behind every clean
 * candidate while keeping relative order among equally-failing takes.
 */
export function voiceQualityPenalty(check, options = {}) {
  if (!check || !["pass", "warn", "fail"].includes(check.status)) {
    throw new Error("voiceQualityPenalty requires a gate check result.");
  }
  // Required metrics that could not be measured are treated as failures, not
  // as silent passes: an absent UTMOS or CER means the take was never judged
  // on naturalness or on what it actually said (Codex final audit).
  const requiredMetrics = options.requiredMetrics ?? [];
  const metricsPresent = check.metrics ?? {};
  const segments = Array.isArray(metricsPresent.segments) ? metricsPresent.segments : [];
  const missingRequired = requiredMetrics.filter((name) => {
    if (metricsPresent[name] !== undefined) return false;
    return !segments.some((segment) => segment?.[name] !== undefined);
  });
  const utmos = Number(check.metrics?.utmos);
  const cer = Number(check.metrics?.cer);
  let penalty = 0;
  if (Number.isFinite(utmos)) penalty += Math.max(0, 5 - utmos) * 0.15;
  if (Number.isFinite(cer)) penalty += cer * 2;
  if (check.status === "warn") penalty += 0.1;
  const hardFail = check.status === "fail" || missingRequired.length > 0;
  if (hardFail) penalty += 100;
  return {
    hardFail,
    missingRequiredMetrics: missingRequired,
    penalty: Number(penalty.toFixed(6)),
    problems: [
      ...(check.problems ?? []),
      ...missingRequired.map((name) => `required metric unavailable: ${name}`),
    ],
    warnings: check.warnings ?? [],
    unavailable: check.unavailable ?? [],
    metrics: check.metrics ?? {},
    inputSha256: check.inputSha256 ?? {},
    checkDigest: check.checkDigest ?? "",
  };
}
