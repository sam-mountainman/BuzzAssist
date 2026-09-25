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

import {
  configuredPythonRuntime,
  formatRuntimeCommand,
  normalizePythonRuntime,
  resolvePythonRuntime,
} from "./harnessRuntimeResolver.mjs";

const execFile = promisify(execFileCallback);

export const VOICE_QUALITY_GATE_SCRIPT = fileURLToPath(
  new URL("../scripts/audit-voice-quality.py", import.meta.url),
);

// Resolve the interpreter once through the cross-platform runtime resolver.
// Windows commonly exposes `py -3` or `python.exe`, while Unix commonly uses
// a project venv or python3. A hard-coded /usr/bin path made the production
// gate impossible to run on Windows and disagreed with the doctor's PATH
// probe. The string export remains for backwards compatibility; the args
// export preserves launchers such as `py -3`.
const CONFIGURED_VOICE_QA_RUNTIME = configuredPythonRuntime({
  purposeEnv: "VOICE_QA_PYTHON",
  projectDir: fileURLToPath(new URL("..", import.meta.url)),
});
export const DEFAULT_VOICE_QA_PYTHON = CONFIGURED_VOICE_QA_RUNTIME.command;
export const DEFAULT_VOICE_QA_PYTHON_ARGS = Object.freeze([...CONFIGURED_VOICE_QA_RUNTIME.args]);
export const VOICE_QA_REQUIRED_MODULES = Object.freeze([
  "numpy", "soundfile", "pyworld", "torch", "faster_whisper", "fugashi",
]);

// Keyed by interpreter path. A single boolean cache answered for whichever
// interpreter asked first, so a probe of a working interpreter made a missing
// one look available — the doctor then reported ready for an environment that
// could not run the gate at all (Codex audit 2026-08-29).
const availabilityCache = new Map();
let resolvedDefaultRuntime = null;

async function resolveVoiceQaRuntime(python) {
  if (python) {
    if (typeof python === "string" && python === DEFAULT_VOICE_QA_PYTHON) {
      return normalizePythonRuntime(CONFIGURED_VOICE_QA_RUNTIME);
    }
    return normalizePythonRuntime(python);
  }
  if (resolvedDefaultRuntime) return resolvedDefaultRuntime;
  const resolved = await resolvePythonRuntime({
    purposeEnv: "VOICE_QA_PYTHON",
    projectDir: fileURLToPath(new URL("..", import.meta.url)),
    requiredModules: VOICE_QA_REQUIRED_MODULES,
  });
  resolvedDefaultRuntime = resolved.ok ? resolved : CONFIGURED_VOICE_QA_RUNTIME;
  return resolvedDefaultRuntime;
}

/** Cheap dependency probe so callers can degrade with an explicit reason. */
export async function voiceQualityAvailable(python) {
  const runtime = await resolveVoiceQaRuntime(python);
  const cacheKey = JSON.stringify([runtime.command, runtime.args]);
  if (availabilityCache.has(cacheKey)) return availabilityCache.get(cacheKey);
  try {
    // Probe everything the required metrics need — a shallow probe let paid
    // generation start and then hard-fail every take (Codex audit).
    await execFile(runtime.command, [...runtime.args, "-c", [
      "import numpy, soundfile, pyworld, torch, faster_whisper, fugashi",
      "from pathlib import Path",
      "hub = Path.home()/'.cache/torch/hub/tarepan_SpeechMOS_v1.2.0'",
      "ckpt = Path.home()/'.cache/torch/hub/checkpoints/utmos22_strong_step7459_v1.pt'",
      "assert hub.exists() and ckpt.exists(), 'UTMOS cache incomplete'",
      // CER と区切りの時刻は faster-whisper の2つのモデルを HF キャッシュからだけ読む
      // （監査中にダウンロードしない）。キャッシュが消えると本番では全テイクが
      // 「required metric unavailable: cer」で落ちるのに、ここは import だけを見て
      // 使えると答えていた（2026-09-25、HF キャッシュが空になって実測）。
      "import os",
      "from faster_whisper.utils import download_model",
      "download_model(os.environ.get('VOICE_QA_WHISPER_MODEL') or 'kotoba-tech/kotoba-whisper-v2.0-faster', local_files_only=True)",
      "download_model('small', local_files_only=True)",
    ].join("; ")]);
    availabilityCache.set(cacheKey, true);
  } catch {
    availabilityCache.set(cacheKey, false);
  }
  return availabilityCache.get(cacheKey);
}

export function resetVoiceQualityAvailabilityCache() {
  availabilityCache.clear();
  resolvedDefaultRuntime = null;
}

/** Run the gate script on one or more audio checks and return the report. */
export async function auditVoiceQuality(input = {}) {
  const checks = Array.isArray(input.checks) ? input.checks : [];
  if (checks.length === 0) throw new Error("auditVoiceQuality requires at least one check.");
  const runtime = await resolveVoiceQaRuntime(input.python);
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
      ({ stdout } = await execFile(runtime.command, [...runtime.args, VOICE_QUALITY_GATE_SCRIPT, configPath], {
        cwd: input.cwd,
        env,
        maxBuffer: 32 * 1024 * 1024,
      }));
    } catch (error) {
      if (error?.code === 3 && typeof error.stdout === "string" && error.stdout.trim()) {
        stdout = error.stdout;
      } else {
        throw new Error(`voice quality gate failed (${formatRuntimeCommand(runtime)}): ${String(error.stderr || error.message).slice(0, 400)}`);
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
    if (name === "utmos" && metricsPresent.segmentUtmosApplied === true) {
      return segments.length === 0 || !segments.every((segment) => Number.isFinite(Number(segment?.utmos)));
    }
    if (metricsPresent[name] !== undefined) return false;
    if (segments.length === 0) return true;
    // Per-segment metrics must be present for EVERY segment: one measured
    // utterance cannot vouch for a short one that was skipped. A `skipped`
    // segment is exactly that — never judged — so it counts as missing.
    // Accepting it here made `skipped: "too short"` produce hardFail:false,
    // which is the opposite of what the comment above promised.
    return !segments.every((segment) => Number.isFinite(Number(segment?.[name])));
  });
  const segmentUtmosValues = metricsPresent.segmentUtmosApplied === true
    ? segments.map((segment) => Number(segment?.utmos)).filter(Number.isFinite)
    : [];
  const utmos = segmentUtmosValues.length === segments.length && segmentUtmosValues.length > 0
    ? segmentUtmosValues.reduce((sum, value) => sum + value, 0) / segmentUtmosValues.length
    : Number(check.metrics?.utmos);
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
