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

// The QA stack lives in a specific interpreter; PATH order differs between
// an interactive shell and a Node child process (anaconda vs /usr/bin), so
// the interpreter is explicit and overridable rather than "whatever python3
// resolves to today" (Codex audit 2026-08-28).
export const DEFAULT_VOICE_QA_PYTHON = process.env.VOICE_QA_PYTHON || "/usr/bin/python3";

// Keyed by interpreter path. A single boolean cache answered for whichever
// interpreter asked first, so a probe of a working interpreter made a missing
// one look available — the doctor then reported ready for an environment that
// could not run the gate at all (Codex audit 2026-08-29).
const availabilityCache = new Map();

/** Cheap dependency probe so callers can degrade with an explicit reason. */
export async function voiceQualityAvailable(python = DEFAULT_VOICE_QA_PYTHON) {
  if (availabilityCache.has(python)) return availabilityCache.get(python);
  try {
    // Probe everything the required metrics need — a shallow probe let paid
    // generation start and then hard-fail every take (Codex audit).
    await execFile(python, ["-c", [
      "import numpy, soundfile, pyworld, torch, faster_whisper, fugashi",
      "from pathlib import Path",
      "hub = Path.home()/'.cache/torch/hub/tarepan_SpeechMOS_v1.2.0'",
      "ckpt = Path.home()/'.cache/torch/hub/checkpoints/utmos22_strong_step7459_v1.pt'",
      "assert hub.exists() and ckpt.exists(), 'UTMOS cache incomplete'",
    ].join("; ")]);
    availabilityCache.set(python, true);
  } catch {
    availabilityCache.set(python, false);
  }
  return availabilityCache.get(python);
}

export function resetVoiceQualityAvailabilityCache() {
  availabilityCache.clear();
}

/** Run the gate script on one or more audio checks and return the report. */
export async function auditVoiceQuality(input = {}) {
  const checks = Array.isArray(input.checks) ? input.checks : [];
  if (checks.length === 0) throw new Error("auditVoiceQuality requires at least one check.");
  const python = typeof input.python === "string" && input.python ? input.python : DEFAULT_VOICE_QA_PYTHON;
  const workDir = await mkdtemp(join(tmpdir(), "voice-quality-gate-"));
  const configPath = join(workDir, "checks.json");
  try {
    await writeFile(configPath, `${JSON.stringify({ checks }, null, 1)}\n`);
    let stdout = "";
    // Environment allowlist: the QA child runs third-party inference code and
    // must never inherit provider API keys (Codex review 2026-08-28).
    const env = Object.fromEntries(
      ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "PYTHONPATH", "HF_HOME",
        "VOICE_QA_SPEAKER_BACKEND", "VOICE_QA_ALLOW_DOWNLOAD"]
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
    if (segments.length === 0) return true;
    // Per-segment metrics must be present for EVERY segment: one measured
    // utterance cannot vouch for a short one that was skipped. A `skipped`
    // segment is exactly that — never judged — so it counts as missing.
    // Accepting it here made `skipped: "too short"` produce hardFail:false,
    // which is the opposite of what the comment above promised.
    return !segments.every((segment) => Number.isFinite(Number(segment?.[name])));
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
