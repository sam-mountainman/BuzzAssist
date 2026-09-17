import assert from "node:assert/strict";
import test from "node:test";

import {
  formatRuntimeCommand,
  imageHostForModel,
  probeCodexImageHost,
  pythonRuntimeCandidates,
  requirePythonRuntime,
  resolveFfmpegToolchain,
  resolvePythonRuntime,
} from "../lib/harnessRuntimeResolver.mjs";

test("Python candidates are platform-aware and keep the Windows launcher args", () => {
  const windows = pythonRuntimeCandidates({
    env: {},
    platform: "win32",
    projectDir: "C:\\empty-project",
  });
  assert.deepEqual(windows[0], { command: "py.exe", args: ["-3"], source: "windows-launcher" });
  assert.ok(windows.some((entry) => entry.command === "python.exe"));
  assert.equal(windows.some((entry) => entry.command === "python3"), false);

  const explicit = pythonRuntimeCandidates({
    env: { VOICE_QA_PYTHON: "C:\\Python QA\\python.exe" },
    platform: "win32",
    projectDir: "C:\\empty-project",
    purposeEnv: "VOICE_QA_PYTHON",
  });
  assert.equal(explicit[0].command, "C:\\Python QA\\python.exe");
  assert.equal(explicit[0].source, "env:VOICE_QA_PYTHON");
  assert.equal(explicit.length, 1, "explicit interpreter failures must not silently fall through to PATH");

  const multiplePurposes = pythonRuntimeCandidates({
    env: { KOYA_GATE_PYTHON: "visual-python", VOICE_QA_PYTHON: "voice-python" },
    platform: "linux",
    projectDir: "/empty-project",
    purposeEnv: ["KOYA_GATE_PYTHON", "VOICE_QA_PYTHON"],
  });
  assert.deepEqual(multiplePurposes.slice(0, 2).map((entry) => entry.command), ["visual-python", "voice-python"]);
});

test("Python resolver rejects a runnable interpreter when required modules are absent", async () => {
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push({ command, args });
    if (command === "missing-python") {
      const error = new Error("ENOENT missing-python");
      error.code = "ENOENT";
      throw error;
    }
    return {
      stdout: `BUZZASSIST_PYTHON_RUNTIME=${JSON.stringify({
        version: [3, 12, 2],
        modules: { numpy: true, soundfile: false },
      })}\n`,
      stderr: "",
    };
  };
  const result = await resolvePythonRuntime({
    candidates: [
      { command: "missing-python", args: [] },
      { command: "py", args: ["-3"] },
    ],
    requiredModules: ["numpy", "soundfile"],
    runCommand,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingModules, ["soundfile"]);
  assert.equal(formatRuntimeCommand(result), "py -3");
  assert.deepEqual(calls[1].args.slice(0, 2), ["-3", "-c"]);
});

test("required Python resolution fails closed and preserves preverified launcher args", async () => {
  await assert.rejects(
    () => requirePythonRuntime({
      runtime: { command: "py", args: ["-3"] },
      requiredModules: ["cv2"],
      runCommand: async () => ({
        stdout: `BUZZASSIST_PYTHON_RUNTIME=${JSON.stringify({ version: [3, 12, 1], modules: { cv2: false } })}\n`,
        stderr: "",
      }),
    }),
    /cv2/u,
  );
  const trusted = await requirePythonRuntime({
    runtime: { ok: true, command: "py.exe", args: ["-3"], version: "3.12.1" },
    requiredModules: ["cv2"],
  });
  assert.equal(trusted.command, "py.exe");
  assert.deepEqual(trusted.args, ["-3"]);
});

test("Python resolver requires an attribute when asked, not only a successful import", async () => {
  // OpenCV 5 は cv2.CascadeClassifier を本体から外した。import だけを見ていたので
  // 解決は通り、顔検出を使う監査が本番で AttributeError になった。
  // 属性の判定は解決器が作る Python スクリプトの中にあるので、本物の Python で確かめる。
  const present = await resolvePythonRuntime({ requiredModules: ["json", "json:dumps"] });
  assert.equal(present.ok, true, `Python を解決できない: ${present.detail}`);
  const interpreter = { command: present.command, args: present.args };
  const absent = await resolvePythonRuntime({
    candidates: [interpreter],
    requiredModules: ["json", "json:NoSuchAttributeForBuzzAssist"],
  });
  assert.equal(absent.ok, false, "import できても、要求した属性が無ければ使えないと判定すること");
  assert.deepEqual(absent.missingModules, ["json:NoSuchAttributeForBuzzAssist"]);
  const missingModule = await resolvePythonRuntime({
    candidates: [interpreter],
    requiredModules: ["buzzassist_no_such_module:anything"],
  });
  assert.deepEqual(missingModule.missingModules, ["buzzassist_no_such_module:anything"]);

  // 止めるときは、版を固定する直し方まで言う。
  await assert.rejects(
    () => requirePythonRuntime({
      runtime: { command: "python3", args: [] },
      requiredModules: ["cv2", "cv2:CascadeClassifier"],
      runCommand: async () => ({
        stdout: `BUZZASSIST_PYTHON_RUNTIME=${JSON.stringify({
          version: [3, 11, 9],
          modules: { cv2: true, "cv2:CascadeClassifier": false },
        })}\n`,
        stderr: "",
      }),
    }),
    /不足 cv2:CascadeClassifier.*opencv-python-headless<5/u,
  );
});

test("ffmpeg and ffprobe resolution honors explicit cross-platform paths", async () => {
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push([command, ...args]);
    const label = command.includes("probe") ? "ffprobe" : "ffmpeg";
    return { stdout: `${label} version 7.1.1 Copyright`, stderr: "" };
  };
  const result = await resolveFfmpegToolchain({
    env: { FFMPEG_PATH: "C:\\Tools\\ffmpeg.exe", FFPROBE_PATH: "C:\\Tools\\ffprobe.exe" },
    runCommand,
  });
  assert.equal(result.ok, true);
  assert.equal(result.ffmpeg.command, "C:\\Tools\\ffmpeg.exe");
  assert.equal(result.ffprobe.command, "C:\\Tools\\ffprobe.exe");
  assert.deepEqual(calls.map((call) => call.at(-1)), ["-version", "-version"]);
});

test("Codex image probe requires an authenticated host and reports the requested model", async () => {
  const accepted = await probeCodexImageHost({
    model: "gpt-image-2-codex",
    command: "/opt/codex",
    env: { CODEX_IMAGE_BRIDGE_MODEL: "gpt-5.6" },
    runCommand: async () => ({ stdout: "Logged in using ChatGPT\n", stderr: "" }),
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.host, "codex");
  assert.equal(accepted.model, "gpt-image-2-codex");
  assert.equal(accepted.bridgeModel, "gpt-5.6");

  const rejected = await probeCodexImageHost({
    model: "gpt-image-2-codex",
    command: "codex",
    runCommand: async () => ({ stdout: "Not logged in", stderr: "" }),
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.detail, /認証/u);

  assert.equal(imageHostForModel("gpt-image-2-codex"), "codex");
  assert.equal(imageHostForModel("lovart-midjourney"), "lovart");
  assert.equal(imageHostForModel("grok-imagine-image-hermes"), "grok");
  assert.equal(imageHostForModel("nano-banana-2"), "buzzassist");
});
