import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import test from "node:test";

import {
  autoUpdateRuntimePaths,
  renderSystemdUserService,
  renderSystemdUserTimer,
  runAutoUpdateCli,
} from "../scripts/auto-update.mjs";

const ok = (stdout = "") => ({ ok: true, code: 0, stdout, stderr: "" });
const failed = (stderr = "unavailable") => ({ ok: false, code: 1, stdout: "", stderr });

function captureLogger() {
  const lines = [];
  return {
    lines,
    logger: {
      log: (value) => lines.push(String(value)),
      warn: (value) => lines.push(String(value)),
    },
  };
}

async function fixture(homeDir) {
  const marketplaceDir = join(homeDir, "plugins", "buzzassist");
  const pluginRoot = join(marketplaceDir, "plugin");
  await mkdir(join(pluginRoot, "scripts"), { recursive: true });
  await writeFile(join(pluginRoot, "scripts", "update-current.mjs"), "// provider-free fixture\n");
  return {
    marketplaceDir,
    pluginRoot,
    argv: [
      "install",
      "--agent", "codex",
      "--marketplace-dir", marketplaceDir,
      "--plugin-root", pluginRoot,
      "--project-dir", join(homeDir, "project"),
      "--canvas-dir", join(homeDir, "project", "canvas"),
    ],
  };
}

async function withHome(prefix, fn) {
  const homeDir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("systemd user units quote paths and define a persistent daily timer without secrets", () => {
  const service = renderSystemdUserService({
    nodePath: "/opt/Node Tools/node",
    updaterPath: "/home/test/Buzz%Assist/update-current.mjs",
    configPath: "/home/test/.buzzassist/updater/config.json",
  });
  const timer = renderSystemdUserTimer();
  assert.match(service, /Type=oneshot/u);
  assert.match(service, /ExecStart="\/opt\/Node Tools\/node"/u);
  assert.match(service, /Buzz%%Assist/u, "systemd percent specifiers must be escaped");
  assert.match(timer, /OnCalendar=\*-\*-\* 03:17:00/u);
  assert.match(timer, /Persistent=true/u);
  assert.match(timer, /WantedBy=timers\.target/u);
  assert.doesNotMatch(`${service}\n${timer}`, /token|authorization/iu);
});

for (const scenario of [
  {
    platform: "darwin",
    provider: "launchd-user",
    expectedCommand: "launchctl bootstrap",
    artifact: (paths) => paths.launchAgentPath,
    getuid: () => 501,
    runCommand: async () => ok("registered\n"),
  },
  {
    platform: "win32",
    provider: "windows-task-scheduler",
    expectedCommand: "schtasks.exe /Create",
    artifact: (paths) => paths.windowsRunnerPath,
    // schtasks は /Query /XML の結果をパイプへ UTF-16 で書くことがある。NUL 混じりでも読めること。
    runCommand: async (_command, args) => (args.includes("/Query")
      ? ok(`<Task>\n<Triggers><CalendarTrigger></CalendarTrigger></Triggers>\n<Settings><StartWhenAvailable>true</StartWhenAvailable></Settings></Task>`.split("").join("\u0000"))
      : ok("registered\n")),
  },
  {
    platform: "linux",
    provider: "systemd-user",
    expectedCommand: "systemctl --user enable --now",
    artifact: (paths) => paths.systemdTimerPath,
    runCommand: async (_command, args) => {
      if (args.includes("is-enabled")) return ok("enabled\n");
      if (args.includes("is-active")) return ok("active\n");
      return ok("ok\n");
    },
  },
]) {
  test(`${scenario.platform} reports enabled only after its user scheduler is registered and verified`, async () => {
    await withHome(`buzzassist-auto-${scenario.platform}-`, async (homeDir) => {
      const input = await fixture(homeDir);
      const calls = [];
      const { logger, lines } = captureLogger();
      const runCommand = async (command, args, options) => {
        calls.push([command, ...args].join(" "));
        return scenario.runCommand(command, args, options);
      };
      const options = {
        argv: input.argv,
        platform: scenario.platform,
        homeDir,
        env: {},
        // 模擬する OS の形式の path にする。Windows の上で darwin / linux の登録内容を作るとき、
        // C:\... は POSIX の絶対 path ではないので PATH に載らず、試験だけが落ちていた。
        execPath: scenario.platform === "win32" ? join(homeDir, "Node Runtime", "node") : posix.join("/opt/buzzassist-test", "Node Runtime", "node"),
        getuid: scenario.getuid,
        runCommand,
        logger,
        now: () => "2026-09-01T00:00:00.000Z",
      };
      const installed = await runAutoUpdateCli(options);
      assert.equal(installed.schedule.enabled, true);
      assert.equal(installed.schedule.provider, scenario.provider);
      assert.ok(calls.some((call) => call.startsWith(scenario.expectedCommand)), calls.join("\n"));
      const paths = autoUpdateRuntimePaths(homeDir, scenario.platform, {});
      await access(scenario.artifact(paths));
      const config = JSON.parse(await readFile(paths.configPath, "utf8"));
      assert.equal(config.enabled, true);
      assert.equal(config.scheduler.state, "enabled");
      assert.ok(lines.includes("BUZZASSIST_AUTO_UPDATE=enabled"));
      assert.ok(lines.includes("BUZZASSIST_AUTO_UPDATE_SCHEDULER_CHECK=ok"));
      assert.ok(lines.includes("BUZZASSIST_AUTO_UPDATE_SCHEDULE=daily-03:17-local-time"));

      if (scenario.platform === "linux") {
        const firstTimer = await readFile(paths.systemdTimerPath, "utf8");
        await runAutoUpdateCli({ ...options, logger: captureLogger().logger });
        assert.equal(await readFile(paths.systemdTimerPath, "utf8"), firstTimer, "reinstall must be idempotent");
        // systemd の user manager の PATH に npm / claude / codex は無いことがある。
        const service = await readFile(paths.systemdServicePath, "utf8");
        assert.match(service, /^Environment="PATH=[^"]*Node Runtime/mu, "service must carry the registering Node's directory on PATH");
      }
      if (scenario.platform === "darwin") {
        // 取りこぼし補完: 3:17 に落ちていた日はログイン時に走らせる。launchd の最小 PATH も補う。
        const plist = await readFile(paths.launchAgentPath, "utf8");
        assert.match(plist, /<key>RunAtLoad<\/key><true\/>/u);
        assert.match(plist, /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>PATH<\/key><string>[^<]*Node Runtime/u);
        assert.match(plist, /StartCalendarInterval/u);
      }
      if (scenario.platform === "win32") {
        // /SC DAILY は取りこぼしを補わない。XML で StartWhenAvailable を付け、/Query /XML で確かめる。
        const create = calls.find((call) => call.startsWith("schtasks.exe /Create"));
        assert.match(create, /\/XML /u);
        assert.doesNotMatch(create, /\/SC DAILY/u);
        assert.ok(calls.some((call) => /^schtasks\.exe \/Query .*\/XML$/u.test(call)), calls.join("\n"));
        const xmlBytes = await readFile(paths.windowsTaskXmlPath);
        assert.deepEqual([...xmlBytes.subarray(0, 2)], [0xff, 0xfe], "task XML must be UTF-16LE with BOM");
        const xml = xmlBytes.subarray(2).toString("utf16le");
        assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/u);
        assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/u);
        assert.match(xml, /<StartBoundary>2026-09-01T03:17:00<\/StartBoundary>/u);
        assert.ok(xml.includes(paths.windowsRunnerPath.replaceAll("&", "&amp;")));
      }
    });
  });
}

test("Linux without a usable user systemd manager fails closed and records manual mode", async () => {
  await withHome("buzzassist-auto-linux-manual-", async (homeDir) => {
    const input = await fixture(homeDir);
    const { logger, lines } = captureLogger();
    await assert.rejects(
      () => runAutoUpdateCli({
        argv: input.argv,
        platform: "linux",
        homeDir,
        env: {},
        runCommand: async () => failed("no user bus"),
        logger,
        now: () => "2026-09-01T00:00:00.000Z",
      }),
      /user-level systemd/u,
    );
    const paths = autoUpdateRuntimePaths(homeDir, "linux", {});
    const config = JSON.parse(await readFile(paths.configPath, "utf8"));
    assert.equal(config.enabled, false);
    assert.equal(config.scheduler.state, "manual");
    assert.ok(lines.includes("BUZZASSIST_AUTO_UPDATE=manual"));
    assert.ok(lines.includes("BUZZASSIST_AUTO_UPDATE_SCHEDULE=manual"));
    assert.equal(lines.includes("BUZZASSIST_AUTO_UPDATE=enabled"), false);
    assert.equal(lines.includes("BUZZASSIST_AUTO_UPDATE_SCHEDULE=daily-03:17-local-time"), false);
    await assert.rejects(access(paths.systemdServicePath), { code: "ENOENT" });
    await assert.rejects(access(paths.systemdTimerPath), { code: "ENOENT" });

    const statusLog = captureLogger();
    const status = await runAutoUpdateCli({
      argv: ["status"],
      platform: "linux",
      homeDir,
      env: {},
      runCommand: async () => failed("no user bus"),
      logger: statusLog.logger,
    });
    assert.equal(status.reported, "manual");
    assert.ok(statusLog.lines.includes("BUZZASSIST_AUTO_UPDATE=manual"));
    assert.ok(statusLog.lines.includes("BUZZASSIST_AUTO_UPDATE_SCHEDULE=manual"));
  });
});

test("status never trusts enabled config when the scheduler artifact is absent", async () => {
  await withHome("buzzassist-auto-status-", async (homeDir) => {
    const paths = autoUpdateRuntimePaths(homeDir, "linux", {});
    await mkdir(paths.updaterDir, { recursive: true });
    await writeFile(paths.configPath, `${JSON.stringify({ enabled: true, hosts: ["codex"] })}\n`);
    const { logger, lines } = captureLogger();
    const result = await runAutoUpdateCli({
      argv: ["status"],
      platform: "linux",
      homeDir,
      env: {},
      runCommand: async () => { throw new Error("status must not call systemctl without unit artifacts"); },
      logger,
    });
    assert.equal(result.enabled, false);
    assert.equal(result.reported, "manual");
    assert.ok(lines.includes("BUZZASSIST_AUTO_UPDATE=manual"));
    assert.ok(lines.includes("BUZZASSIST_AUTO_UPDATE_SCHEDULE=manual"));
    assert.equal(lines.some((line) => line.includes("daily-03:17")), false);
  });
});

test("explicit registration skip is manual, never enabled", async () => {
  await withHome("buzzassist-auto-skip-", async (homeDir) => {
    const input = await fixture(homeDir);
    const { logger, lines } = captureLogger();
    const result = await runAutoUpdateCli({
      argv: input.argv,
      platform: "linux",
      homeDir,
      env: {},
      skipRegister: true,
      runCommand: async () => { throw new Error("skip must not invoke a provider"); },
      logger,
    });
    assert.equal(result.schedule.enabled, false);
    assert.equal(result.config.enabled, false);
    assert.ok(lines.includes("BUZZASSIST_AUTO_UPDATE=manual"));
    assert.equal(lines.includes("BUZZASSIST_AUTO_UPDATE=enabled"), false);
  });
});

test("Windows registration without the catch-up setting is reported as manual, never enabled", async () => {
  await withHome("buzzassist-auto-win-nocatchup-", async (homeDir) => {
    const input = await fixture(homeDir);
    const { logger, lines } = captureLogger();
    await assert.rejects(
      () => runAutoUpdateCli({
        argv: input.argv,
        platform: "win32",
        homeDir,
        env: {},
        execPath: join(homeDir, "node.exe"),
        // 名前は引けるが、定義に StartWhenAvailable が無い（/SC DAILY で登録された古いタスク相当）。
        runCommand: async (_command, args) => (args.includes("/Query")
          ? ok("<Task><Triggers><CalendarTrigger/></Triggers><Settings></Settings></Task>")
          : ok("registered\n")),
        logger,
        now: () => "2026-09-01T00:00:00.000Z",
      }),
      /StartWhenAvailable/u,
    );
    const paths = autoUpdateRuntimePaths(homeDir, "win32", {});
    const config = JSON.parse(await readFile(paths.configPath, "utf8"));
    assert.equal(config.enabled, false);
    assert.ok(lines.includes("BUZZASSIST_AUTO_UPDATE=manual"));
    assert.equal(lines.includes("BUZZASSIST_AUTO_UPDATE=enabled"), false);
  });
});
