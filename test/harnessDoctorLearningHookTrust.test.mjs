// Codex が BuzzAssist の学習フックを信頼しているかを、doctor が読むだけで確かめる試験（learning-hook-trust）。
// Codex は信頼を ~/.codex/config.toml の [hooks.state."<plugin>@<marketplace>:<定義>:<イベント>:<群>:<番号>"]
// と trusted_hash に残し、表の無いフックを黙って飛ばす。設定は合成の CODEX_HOME にだけ置く。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODEX_HOOK_TRUST_FIX,
  inspectCodexHookTrust,
  parseCodexHookState,
  probeCodexLearningHookTrust,
  probeCodexStopHookTrust,
} from "../lib/codexHookTrust.mjs";
import { runHarnessDoctor } from "../scripts/harness-doctor.mjs";

const KEY = "buzzassist@buzzassist:hooks/codex-hooks.json:user_prompt_submit:0:0";
const HASH = `sha256:${"a".repeat(64)}`;

function tempHome(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-hook-trust-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function stageCodex(home, configText, { cache = true } = {}) {
  const codexHome = path.join(home, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  if (cache) fs.mkdirSync(path.join(codexHome, "plugins", "cache", "buzzassist", "buzzassist", "9.9.1"), { recursive: true });
  if (configText !== null) fs.writeFileSync(path.join(codexHome, "config.toml"), configText);
  return codexHome;
}

const PLUGIN_ENABLED = '[plugins."buzzassist@buzzassist"]\nenabled = true\n';

test("config.toml の hooks.state を、引用の中の . や : を崩さずに読む", () => {
  const parsed = parseCodexHookState([
    "[features]",
    "memories = false",
    "",
    "[hooks.state]",
    "",
    '[hooks.state."/sandbox/codex-config/hooks.json:stop:0:0"]',
    `trusted_hash = "${HASH}"`,
    "",
    `[hooks.state."${KEY}"]`,
    `trusted_hash = "${HASH}" # コメント`,
    "",
    '[hooks.state."other@market:hooks/hooks.json:session_start:0:0"]',
    "enabled = false",
    "",
    PLUGIN_ENABLED,
  ].join("\n"));
  assert.deepEqual([...parsed.hooks.keys()], ["/sandbox/codex-config/hooks.json:stop:0:0", KEY, "other@market:hooks/hooks.json:session_start:0:0"]);
  assert.equal(parsed.hooks.get(KEY).trustedHash, HASH);
  assert.equal(parsed.hooks.get("other@market:hooks/hooks.json:session_start:0:0").enabled, false);
  assert.equal(parsed.plugins.get("buzzassist@buzzassist").enabled, true);

  const inline = parseCodexHookState(`[hooks.state]\n"${KEY}" = { trusted_hash = "${HASH}" }\n`);
  assert.equal(inline.hooks.get(KEY).trustedHash, HASH);
});

test("信頼の状態を見分ける（未導入・プラグイン無効・信頼済み・無効化・未信頼）", (t) => {
  const home = tempHome(t);
  assert.equal(inspectCodexHookTrust({ env: {}, homeDir: home }).status, "not-installed");

  stageCodex(home, PLUGIN_ENABLED);
  const untrusted = probeCodexLearningHookTrust({ env: {}, homeDir: home });
  assert.equal(untrusted.status, "untrusted");
  assert.equal(untrusted.ok, false);
  assert.match(untrusted.detail, new RegExp(KEY.replaceAll(".", "\\."), "u"));
  assert.equal(untrusted.fix, CODEX_HOOK_TRUST_FIX);
  assert.match(untrusted.fix, /\/hooks/u);

  stageCodex(home, `${PLUGIN_ENABLED}\n[hooks.state."${KEY}"]\ntrusted_hash = "${HASH}"\n`);
  assert.deepEqual(
    (({ ok, status, fix }) => ({ ok, status, fix }))(probeCodexLearningHookTrust({ env: {}, homeDir: home })),
    { ok: true, status: "trusted", fix: "" },
  );

  stageCodex(home, `${PLUGIN_ENABLED}\n[hooks.state."${KEY}"]\ntrusted_hash = "${HASH}"\nenabled = false\n`);
  assert.equal(probeCodexLearningHookTrust({ env: {}, homeDir: home }).status, "disabled");

  stageCodex(home, '[plugins."buzzassist@buzzassist"]\nenabled = false\n');
  assert.equal(probeCodexLearningHookTrust({ env: {}, homeDir: home }).status, "plugin-disabled");

  // 形の崩れた hash は信頼として数えない。
  stageCodex(home, `${PLUGIN_ENABLED}\n[hooks.state."${KEY}"]\ntrusted_hash = "not-a-hash"\n`);
  assert.equal(probeCodexLearningHookTrust({ env: {}, homeDir: home }).status, "untrusted");
});

test("完成前チェック（Stop）のフックの信頼は、学習フックとは別に見分ける", (t) => {
  const home = tempHome(t);
  const stopKey = "buzzassist@buzzassist:hooks/codex-hooks.json:stop:0:0";
  stageCodex(home, PLUGIN_ENABLED);
  const neither = probeCodexStopHookTrust({ env: {}, homeDir: home });
  assert.equal(neither.status, "untrusted");
  assert.match(neither.detail, /Stop/u);
  assert.match(neither.fix, /harness-stop-hook/u);

  // 学習フックだけを信頼しても、Stop は未信頼のまま（逆も同じ）。
  stageCodex(home, `${PLUGIN_ENABLED}\n[hooks.state."${KEY}"]\ntrusted_hash = "${HASH}"\n`);
  assert.equal(probeCodexLearningHookTrust({ env: {}, homeDir: home }).status, "trusted");
  assert.equal(probeCodexStopHookTrust({ env: {}, homeDir: home }).status, "untrusted");
  stageCodex(home, `${PLUGIN_ENABLED}\n[hooks.state."${stopKey}"]\ntrusted_hash = "${HASH}"\n`);
  assert.equal(probeCodexLearningHookTrust({ env: {}, homeDir: home }).status, "untrusted");
  assert.equal(probeCodexStopHookTrust({ env: {}, homeDir: home }).status, "trusted");

  stageCodex(home, `${PLUGIN_ENABLED}\n[hooks.state."${stopKey}"]\ntrusted_hash = "${HASH}"\nenabled = false\n`);
  assert.equal(probeCodexStopHookTrust({ env: {}, homeDir: home }).status, "disabled");
});

test("CODEX_HOME を尊重し、config.toml は読むだけで書き換えない", (t) => {
  const home = tempHome(t);
  const elsewhere = path.join(home, "custom-codex-home");
  fs.mkdirSync(path.join(elsewhere, "plugins", "cache", "buzzassist", "buzzassist"), { recursive: true });
  const config = path.join(elsewhere, "config.toml");
  fs.writeFileSync(config, PLUGIN_ENABLED);
  const before = fs.readFileSync(config, "utf8");
  const result = inspectCodexHookTrust({ env: { CODEX_HOME: elsewhere }, homeDir: home });
  assert.equal(result.status, "untrusted");
  assert.equal(result.configPath, config);
  assert.equal(fs.readFileSync(config, "utf8"), before);
});

test("doctor に advisory の learning-hook-trust が出て、止めずに直し方を出す", async (t) => {
  const home = tempHome(t);
  const codexHome = stageCodex(home, PLUGIN_ENABLED);
  const binary = (command) => ({ ok: true, command, args: [], version: "7.1.1" });
  const report = await runHarnessDoctor({
    runtime: {
      homeDir: home,
      env: { CODEX_HOME: codexHome, PATH: process.env.PATH || "" },
      ffmpegToolchain: { ok: true, ffmpeg: binary("ffmpeg"), ffprobe: binary("ffprobe") },
      runCommand: async (_command, args = []) => {
        if (args.includes("-encoders")) return { stdout: "libx264 aac pcm_s24le", stderr: "" };
        if (args.includes("-filters")) return { stdout: "scale crop overlay fps loudnorm aresample", stderr: "" };
        if (args.includes("-show_streams")) return { stdout: JSON.stringify({ streams: [{ codec_type: "video" }, { codec_type: "audio" }] }), stderr: "" };
        return { stdout: "", stderr: "" };
      },
      pythonRuntime: { ok: true, command: "python", args: [], version: "3.12.2" },
      voiceQualityProbe: async () => true,
      diskFreeBytes: async () => 64 * 1024 ** 3,
      ttsProbe: async () => ({ ok: true, detail: "設定あり", fix: "" }),
      imageModel: "gpt-image-2-codex",
      imageHostProbe: async (model) => ({ ok: true, host: "codex", model, detail: `Codex / ${model}` }),
    },
  });
  const check = report.checks.find((entry) => entry.id === "learning-hook-trust");
  assert.ok(check, "learning-hook-trust の検査が無い");
  assert.equal(check.required, false);
  assert.equal(check.ok, false);
  assert.equal(check.status, "untrusted");
  assert.ok(report.advisory.includes("learning-hook-trust"));
  assert.equal(report.blocking.includes("learning-hook-trust"), false, "信頼の欠落で本番を止めた");
  const stop = report.checks.find((entry) => entry.id === "completion-hook-trust");
  assert.ok(stop, "completion-hook-trust の検査が無い");
  assert.equal(stop.required, false);
  assert.equal(stop.status, "untrusted");
  assert.ok(report.advisory.includes("completion-hook-trust"));
  assert.equal(report.blocking.includes("completion-hook-trust"), false, "信頼の欠落で本番を止めた");
});
