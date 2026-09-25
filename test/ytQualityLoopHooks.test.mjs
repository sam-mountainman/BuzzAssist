import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runHarnessDoctor } from "../scripts/harness-doctor.mjs";
import { findActiveYtLoops, probeYtQualityLoopHooks } from "../lib/ytQualityLoopHooks.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "yt-loop-hooks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(project, { recursive: true });
  return { root, home, project };
}

async function enableBothHosts(home) {
  await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({
    enabledPlugins: { "yt-quality-loop@yt-quality-loop": true, "buzzassist@buzzassist": true },
  }));
  await writeFile(join(home, ".codex", "config.toml"), [
    "[plugins.\"yt-quality-loop@yt-quality-loop\"]",
    "enabled = true",
    "",
    "[plugins.\"buzzassist@buzzassist\"]",
    "enabled = true",
    "",
  ].join("\n"));
}

async function writeLoopState(project, sessionId, state) {
  const dir = join(project, ".yt-loop", "sessions", sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "state.json"), JSON.stringify(state));
}

test("フックが入っていても、動いているループが無ければ制作 Job には介入しないと報告する", async (t) => {
  const { home, project } = await fixture(t);
  await enableBothHosts(home);
  const result = probeYtQualityLoopHooks({ projectDirs: [project], homeDir: home, env: {} });
  assert.equal(result.ok, true);
  assert.deepEqual(result.hosts, ["Claude Code", "Codex"]);
  assert.match(result.detail, /介入しない/u);
  assert.match(result.detail, /入力は書き換えず/u);
});

test("同じ作業フォルダーで動いているループがあれば、制作 Job の会話で終了を止められると知らせる", async (t) => {
  const { home, project } = await fixture(t);
  await enableBothHosts(home);
  await writeLoopState(project, "session-a", { active: true, iteration: 2, max_iterations: 6 });
  await writeLoopState(project, "session-b", { active: false, iteration: 6, max_iterations: 6 });
  const result = probeYtQualityLoopHooks({ projectDirs: [project], homeDir: home, env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, "yt-loop-active");
  assert.deepEqual(result.activeLoops.map((loop) => loop.sessionId), ["session-a"], "終わったループは数えない");
  assert.match(result.detail, /Stop フックが終了を止め/u);
  assert.match(result.fix, /別の会話/u);
});

test("どのホストでも無効なら、ループの記録が残っていても介入しない", async (t) => {
  const { home, project } = await fixture(t);
  await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "yt-quality-loop@yt-quality-loop": false } }));
  await writeFile(join(home, ".codex", "config.toml"), "[plugins.\"yt-quality-loop@yt-quality-loop\"]\nenabled = false\n");
  await writeLoopState(project, "session-a", { active: true, iteration: 1, max_iterations: 6 });
  const result = probeYtQualityLoopHooks({ projectDirs: [project], homeDir: home, env: {} });
  assert.equal(result.ok, true);
  assert.deepEqual(result.hosts, []);
  assert.match(result.detail, /有効になっていない/u);
});

test("CODEX_HOME を尊重し、壊れた state は数えない", async (t) => {
  const { root, home, project } = await fixture(t);
  const codexHome = join(root, "custom-codex");
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, "config.toml"), "[plugins.\"yt-quality-loop@local\"]\nenabled = true\n");
  const result = probeYtQualityLoopHooks({ projectDirs: [project], homeDir: home, env: { CODEX_HOME: codexHome } });
  assert.deepEqual(result.hosts, ["Codex"]);
  const broken = join(project, ".yt-loop", "sessions", "broken");
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, "state.json"), "{壊れた");
  assert.deepEqual(findActiveYtLoops([project]), []);
});

test("doctor は yt-quality-loop のフックを任意の項目として出し、有料生成は止めない", async (t) => {
  const { home, project } = await fixture(t);
  await enableBothHosts(home);
  await writeLoopState(project, "session-a", { active: true, iteration: 1, max_iterations: 6 });
  const report = await runHarnessDoctor({
    projectDir: project,
    runtime: {
      homeDir: home,
      env: { PATH: process.env.PATH || "" },
      ffmpegToolchain: { ok: false, ffmpeg: { ok: false, detail: "fixture" }, ffprobe: { ok: false, detail: "fixture" } },
      pythonRuntime: { ok: false, detail: "fixture" },
      ttsProbe: async () => ({ ok: true, detail: "設定あり", fix: "" }),
      imageHostProbe: async (model) => ({ ok: true, host: "codex", model, detail: "fixture" }),
      svgRasterizerProbe: async () => ({ ok: true, detail: "fixture" }),
      resolveCodexCommand: async () => "codex",
      diskFreeBytes: async () => 64 * 1024 ** 3,
    },
  });
  const check = report.checks.find((entry) => entry.id === "yt-quality-loop-hooks");
  assert.ok(check, "項目がある");
  assert.equal(check.required, false);
  assert.equal(check.ok, false);
  assert.ok(report.advisory.includes("yt-quality-loop-hooks"));
  assert.ok(!report.blocking.includes("yt-quality-loop-hooks"));
});
