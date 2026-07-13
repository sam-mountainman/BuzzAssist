import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  codexDesktopCandidates,
  codexPathCommands,
  resolveCodexCommand,
} from "../scripts/codex-image-bridge.mjs";

test("Codex image bridge probes the platform-specific CLI commands", () => {
  assert.deepEqual(codexPathCommands("darwin"), ["codex"]);
  assert.deepEqual(codexPathCommands("linux"), ["codex"]);
  assert.deepEqual(codexPathCommands("win32"), ["codex.exe", "codex.cmd", "codex"]);
});

test("explicit CODEX_COMMAND remains the highest-priority override", async () => {
  const previous = process.env.CODEX_COMMAND;
  process.env.CODEX_COMMAND = "/custom/codex";
  try {
    assert.equal(await resolveCodexCommand(), "/custom/codex");
  } finally {
    if (previous === undefined) delete process.env.CODEX_COMMAND;
    else process.env.CODEX_COMMAND = previous;
  }
});

test("ChatGPT desktop bundled Codex candidates are available without a separate CLI", () => {
  const candidates = codexDesktopCandidates({ platform: "darwin", homeDir: "/Users/test" });
  assert.deepEqual(candidates, [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Users/test/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Users/test/Applications/Codex.app/Contents/Resources/codex",
  ]);
  assert.deepEqual(
    codexDesktopCandidates({
      platform: "win32",
      homeDir: "C:\\Users\\test",
      env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    }),
    ["C:\\Users\\test\\AppData\\Local\\Programs\\ChatGPT\\resources\\codex.exe"],
  );
});

test("agent setup reuses the same ChatGPT/Codex auto-detection", async () => {
  const source = await readFile(new URL("../scripts/setup-agents.mjs", import.meta.url), "utf8");
  assert.match(source, /import \{ resolveCodexCommand \} from "\.\/codex-image-bridge\.mjs"/);
  assert.match(source, /codex = dryRun \? commandName\("codex"\) : await resolveCodexCommand\(\)/);
  assert.doesNotMatch(source, /Codex CLI was not found/);
});

test("Codex image generation recovers from deleted working directories", async () => {
  const [bridge, media] = await Promise.all([
    readFile(new URL("../scripts/codex-image-bridge.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/mediaGeneration.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(bridge, /resolveBridgeWorkingDirectory/);
  assert.match(bridge, /choices\.push\(os\.homedir\(\)\)/);
  assert.match(media, /cwd: options\.cwd \|\| safeProcessCwd\(\)/);
  assert.match(media, /cwd: getEnv\("CODEX_IMAGE_BRIDGE_CWD"\) \|\| safeProcessCwd\(\)/);
});
