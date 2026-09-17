import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const PYTHON_RESULT_PREFIX = "BUZZASSIST_PYTHON_RUNTIME=";

function nonEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueSpecs(specs) {
  const seen = new Set();
  const result = [];
  for (const spec of specs) {
    if (!spec?.command) continue;
    const key = JSON.stringify([spec.command, spec.args ?? []]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ command: spec.command, args: [...(spec.args ?? [])], source: spec.source || "candidate" });
  }
  return result;
}

export function formatRuntimeCommand(spec) {
  if (!spec?.command) return "(unresolved)";
  return [spec.command, ...(spec.args ?? [])].join(" ");
}

/**
 * Return Python launch candidates without assuming that `python3` exists.
 *
 * Windows' standard launcher needs `py -3`, while virtualenv paths differ by
 * platform. Callers probe these candidates before selecting one; a name being
 * present in this list is never itself treated as evidence that it works.
 */
export function pythonRuntimeCandidates({
  env = process.env,
  platform = process.platform,
  projectDir = process.cwd(),
  purposeEnv = "",
} = {}) {
  const pathApi = platform === "win32" ? win32 : posix;
  const purposeNames = Array.isArray(purposeEnv) ? purposeEnv : [purposeEnv];
  const explicitNames = [...purposeNames, "BUZZASSIST_PYTHON", "PYTHON"]
    .filter(Boolean)
    .map((name) => ({ name, value: nonEmpty(env?.[name]) }))
    .filter((entry) => entry.value);
  const explicit = explicitNames.map(({ name, value }) => ({ command: value, args: [], source: `env:${name}` }));
  const virtualenvs = platform === "win32"
    ? [".venv\\Scripts\\python.exe", "venv\\Scripts\\python.exe"]
    : [".venv/bin/python", "venv/bin/python"];
  const local = virtualenvs
    .map((relative) => pathApi.resolve(projectDir, relative))
    .filter((command) => existsSync(command))
    .map((command) => ({ command, args: [], source: "project-venv" }));
  const ambient = platform === "win32"
    ? [
        { command: "py.exe", args: ["-3"], source: "windows-launcher" },
        { command: "py", args: ["-3"], source: "windows-launcher" },
        { command: "python.exe", args: [], source: "path" },
        { command: "python", args: [], source: "path" },
      ]
    : [
        { command: "python3", args: [], source: "path" },
        { command: "python", args: [], source: "path" },
        // Last resort only: on macOS/Linux the system interpreter lives at a
        // fixed path even when PATH is fronted by a distribution (Anaconda,
        // pyenv) whose extension modules are mismatched against its own NumPy.
        // Reached only after the PATH candidates fail the real-import probe,
        // so it never overrides a working operator interpreter.
        { command: "/usr/bin/python3", args: [], source: "system-path" },
      ].filter((entry) => !entry.command.startsWith("/") || existsSync(entry.command));
  // An explicit interpreter is an operator decision, not a hint. Falling
  // through to another PATH interpreter after it fails would make production
  // run under a different dependency set than the configured one.
  return explicit.length > 0 ? uniqueSpecs(explicit) : uniqueSpecs([...local, ...ambient]);
}

// import は通るのに、スクリプトが使う属性が版で消えることがある。直し方が
// 版の固定なら、止めるときにそれを言う。
const PYTHON_REQUIREMENT_HINTS = Object.freeze({
  "cv2:CascadeClassifier": "OpenCV 5 は Haar cascade（cv2.CascadeClassifier）を本体から外した。`pip install \"opencv-python-headless<5\"` で 4 系を入れること",
});

/** Resolve a usable interpreter or stop before the caller starts production. */
export async function requirePythonRuntime(options = {}) {
  const supplied = options.runtime ? normalizePythonRuntime(options.runtime) : null;
  const runtime = supplied && options.runtime?.ok === true
    ? { ...supplied, ok: true, version: options.runtime.version, modules: options.runtime.modules }
    : supplied && options.runtime?.ok === false
      ? { ...supplied, ok: false, detail: options.runtime.detail }
      : await resolvePythonRuntime({ ...options, ...(supplied ? { candidates: [supplied] } : {}) });
  if (runtime?.ok === false || !runtime?.command) {
    const modules = [...new Set((options.requiredModules ?? []).map((value) => nonEmpty(value)).filter(Boolean))];
    const suffix = runtime?.detail ? `: ${runtime.detail}` : "";
    const hints = [...new Set((runtime?.missingModules ?? []).map((name) => PYTHON_REQUIREMENT_HINTS[name]).filter(Boolean))];
    throw new Error(`必要なPython実行環境を解決できない（${modules.join(", ") || "Python 3.9+"}）${suffix}`
      + hints.map((hint) => `。${hint}`).join(""));
  }
  return runtime;
}

export function configuredPythonRuntime(options = {}) {
  return pythonRuntimeCandidates(options)[0];
}

export function normalizePythonRuntime(value, fallback) {
  if (value && typeof value === "object" && nonEmpty(value.command)) {
    return { command: nonEmpty(value.command), args: [...(value.args ?? [])], source: value.source || "explicit" };
  }
  if (nonEmpty(value)) return { command: nonEmpty(value), args: [], source: "explicit" };
  return fallback ? normalizePythonRuntime(fallback) : null;
}

async function defaultRunCommand(command, args, options = {}) {
  return execFile(command, args, options);
}

/** Probe candidates and select one that really imports every required module. */
export async function resolvePythonRuntime({
  candidates,
  requiredModules = [],
  env = process.env,
  platform = process.platform,
  projectDir = process.cwd(),
  purposeEnv = "",
  runCommand = defaultRunCommand,
  timeoutMs = 20_000,
} = {}) {
  const requested = candidates ?? pythonRuntimeCandidates({ env, platform, projectDir, purposeEnv });
  const modules = [...new Set(requiredModules.map((value) => nonEmpty(value)).filter(Boolean))];
  // Import each module for real instead of asking find_spec whether a file
  // exists. A package can be present on disk and still be unusable -- an
  // onnxruntime built against NumPy 1.x raises ImportError under NumPy 2.x,
  // yet find_spec reports it as available. A probe that cannot fail on a
  // known-broken install is not evidence, so pay the import cost here rather
  // than discover the breakage inside a production gate.
  //
  // "module:attribute" also requires that attribute. An import alone can still
  // pass on a release that dropped what the scripts call: OpenCV 5 removed
  // cv2.CascadeClassifier, so resolution succeeded and every face-detection
  // audit then failed with an AttributeError.
  const script = [
    "import importlib,json,sys",
    `mods=${JSON.stringify(modules)}`,
    "found={}",
    "for m in mods:",
    "    name,_,attr=m.partition(':')",
    "    try:",
    "        mod=importlib.import_module(name)",
    "        found[m]=(not attr) or hasattr(mod,attr)",
    "    except BaseException:",
    "        found[m]=False",
    `print(${JSON.stringify(PYTHON_RESULT_PREFIX)}+json.dumps({'version':list(sys.version_info[:3]),'modules':found}))`,
  ].join("\n");
  const attempts = [];
  for (const candidate of requested) {
    const spec = normalizePythonRuntime(candidate);
    if (!spec) continue;
    try {
      const { stdout = "", stderr = "" } = await runCommand(
        spec.command,
        [...spec.args, "-c", script],
        { timeout: timeoutMs, env },
      );
      const output = `${stdout}\n${stderr}`;
      const line = output.split(/\r?\n/u).find((entry) => entry.startsWith(PYTHON_RESULT_PREFIX));
      if (!line) throw new Error("interpreter did not return the BuzzAssist runtime signature");
      const parsed = JSON.parse(line.slice(PYTHON_RESULT_PREFIX.length));
      const version = Array.isArray(parsed.version) ? parsed.version.map(Number) : [];
      const versionOk = version.length === 3 && (version[0] > 3 || (version[0] === 3 && version[1] >= 9));
      const missingModules = modules.filter((name) => parsed.modules?.[name] !== true);
      const attempt = {
        ...spec,
        version: version.join("."),
        versionOk,
        modules: parsed.modules ?? {},
        missingModules,
      };
      attempts.push(attempt);
      if (versionOk && missingModules.length === 0) return { ok: true, ...attempt, attempts };
    } catch (error) {
      attempts.push({
        ...spec,
        error: String(error?.message || error).slice(0, 180),
      });
    }
  }
  const usable = attempts.find((attempt) => attempt.versionOk);
  return {
    ok: false,
    ...(usable ?? requested[0] ?? {}),
    attempts,
    missingModules: usable?.missingModules ?? modules,
    detail: attempts.length === 0
      ? "Python候補が1つも無い"
      : attempts.map((attempt) => {
          const label = formatRuntimeCommand(attempt);
          if (attempt.error) return `${label}: ${attempt.error}`;
          if (!attempt.versionOk) return `${label}: Python ${attempt.version || "unknown"} は古い`;
          return `${label}: 不足 ${attempt.missingModules.join(", ")}`;
        }).join(" / "),
  };
}

function binaryCandidates(name, envNames, env) {
  const explicit = envNames
    .map((envName) => ({ command: nonEmpty(env?.[envName]), args: [], source: `env:${envName}` }))
    .filter((entry) => entry.command);
  return explicit.length > 0
    ? uniqueSpecs(explicit)
    : uniqueSpecs([{ command: name, args: [], source: "path" }]);
}

export async function resolveBinaryRuntime({
  name,
  envNames = [],
  signature,
  env = process.env,
  runCommand = defaultRunCommand,
  timeoutMs = 15_000,
} = {}) {
  const attempts = [];
  for (const spec of binaryCandidates(name, envNames, env)) {
    try {
      const { stdout = "", stderr = "" } = await runCommand(spec.command, ["-version"], { timeout: timeoutMs, env });
      const text = `${stdout}${stderr}`;
      const match = text.match(/(\d+\.\d+(?:\.\d+)?)/u);
      if (!signature?.test(text) || !match) throw new Error(`${name} の版署名が無い`);
      return { ok: true, ...spec, version: match[1], attempts };
    } catch (error) {
      attempts.push({ ...spec, error: String(error?.message || error).slice(0, 180) });
    }
  }
  return {
    ok: false,
    command: binaryCandidates(name, envNames, env)[0]?.command || name,
    args: [],
    attempts,
    detail: attempts.map((attempt) => `${formatRuntimeCommand(attempt)}: ${attempt.error}`).join(" / "),
  };
}

export async function resolveFfmpegToolchain(options = {}) {
  const ffmpeg = await resolveBinaryRuntime({
    ...options,
    name: "ffmpeg",
    envNames: ["BUZZASSIST_FFMPEG", "FFMPEG_PATH"],
    signature: /ffmpeg version/iu,
  });
  const ffprobe = await resolveBinaryRuntime({
    ...options,
    name: "ffprobe",
    envNames: ["BUZZASSIST_FFPROBE", "FFPROBE_PATH"],
    signature: /ffprobe version/iu,
  });
  return { ok: ffmpeg.ok && ffprobe.ok, ffmpeg, ffprobe };
}

export function imageHostForModel(model) {
  const value = nonEmpty(model).toLowerCase();
  if (!value) return "unknown";
  if (value.endsWith("-codex")) return "codex";
  if (value.startsWith("lovart-")) return "lovart";
  if (value.endsWith("-hermes")) return "grok";
  return "buzzassist";
}

/**
 * Verify the actual Codex image execution host without starting a paid image
 * generation. `login status` is read-only and is stronger evidence than an
 * unrelated provider key merely existing in the environment.
 */
export async function probeCodexImageHost({
  model,
  command,
  env = process.env,
  runCommand = defaultRunCommand,
  timeoutMs = 15_000,
} = {}) {
  if (!nonEmpty(command)) {
    return { ok: false, host: "codex", model, detail: "Codex実行ファイルを解決できない" };
  }
  try {
    const { stdout = "", stderr = "" } = await runCommand(command, ["login", "status"], { timeout: timeoutMs, env });
    const output = `${stdout}\n${stderr}`.trim();
    const rejected = /not logged in|login required|unauthenticated|unauthori[sz]ed/iu.test(output);
    const authenticated = !rejected && /logged in|authenticated|chatgpt|api key/iu.test(output);
    if (!authenticated) {
      return {
        ok: false,
        host: "codex",
        model,
        command,
        // Do not echo arbitrary login output. A provider CLI may include an
        // account identifier or credential fragment in a failure message.
        detail: output
          ? "Codex認証を確認できない（login statusが認証済みの署名を返さない）"
          : "Codex login status が認証状態を返さない",
      };
    }
    return {
      ok: true,
      host: "codex",
      model,
      command,
      authentication: /api key/iu.test(output) ? "api-key" : "chatgpt",
      bridgeModel: nonEmpty(env.CODEX_IMAGE_BRIDGE_MODEL) || null,
      detail: `画像ホスト認証済み（Codex / ${model}${nonEmpty(env.CODEX_IMAGE_BRIDGE_MODEL) ? ` / bridge ${nonEmpty(env.CODEX_IMAGE_BRIDGE_MODEL)}` : ""}）`,
    };
  } catch (error) {
    return {
      ok: false,
      host: "codex",
      model,
      command,
      detail: `Codex認証プローブを起動できない: ${String(error?.message || error).slice(0, 160)}`,
    };
  }
}

export const _testing = Object.freeze({ defaultRunCommand });
