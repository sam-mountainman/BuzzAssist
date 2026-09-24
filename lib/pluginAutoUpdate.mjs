import { existsSync, readFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";

export const BUZZASSIST_REPOSITORY = "sam-mountainman/BuzzAssist";
export const BUZZASSIST_UPDATE_LABEL = "ai.buzzassist.plugin-updater";
export const BUZZASSIST_WINDOWS_TASK = "BuzzAssist Plugin Update";
export const BUZZASSIST_PLUGIN_SELECTOR = "buzzassist@buzzassist";

// 更新器が setup-agents を呼ぶときに立てる印。0.1.26 以前の更新器はこれを立てないので、
// setup-agents 側は旧来の引数の組み合わせでも更新器からの呼び出しと見分ける
// （isUpdaterInstallInvocation）。
export const UPDATER_INSTALL_ENV = "BUZZASSIST_UPDATER_INSTALL";

// 定刻の確認は「前回の確認が済んでから 20 時間」経つまで何もしない。launchd の
// RunAtLoad とログオン時の取りこぼし補完で、1日に何度も起動されるため。
export const UPDATE_CHECK_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

export function normalizeVersion(value) {
  const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    raw: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || "",
  };
}

export function compareVersions(left, right) {
  const a = typeof left === "string" ? normalizeVersion(left) : left;
  const b = typeof right === "string" ? normalizeVersion(right) : right;
  if (!a || !b) throw new Error(`Invalid version comparison: ${left} / ${right}`);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
}

export function releaseVersion(release) {
  const version = normalizeVersion(release?.tag_name || release?.name || "");
  if (!version) throw new Error("GitHub Release has no valid semantic version tag.");
  if (release?.draft) throw new Error("Draft releases cannot be installed automatically.");
  if (release?.prerelease || version.prerelease) throw new Error("Prereleases are not installed on the stable channel.");
  if (!/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/(?:zipball|tarball)\//.test(String(release?.zipball_url || ""))) {
    throw new Error("GitHub Release zipball URL is missing or untrusted.");
  }
  return version.raw;
}

export function normalizeUpdateHosts(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  const hosts = [];
  for (const item of source) {
    const normalized = String(item || "").trim().toLowerCase();
    if (normalized === "both" || normalized === "all") {
      for (const host of ["codex", "claude"]) if (!hosts.includes(host)) hosts.push(host);
      continue;
    }
    if (!normalized) continue;
    if (normalized !== "codex" && normalized !== "claude") {
      throw new Error(`Unsupported auto-update host: ${item}`);
    }
    if (!hosts.includes(normalized)) hosts.push(normalized);
  }
  return hosts;
}

export function mergeUpdaterConfig(existing, next) {
  const previous = existing && typeof existing === "object" ? existing : {};
  const hosts = normalizeUpdateHosts([...(previous.hosts || []), ...(next.hosts || [])]);
  return {
    version: 1,
    enabled: next.enabled ?? previous.enabled ?? true,
    repository: next.repository || previous.repository || BUZZASSIST_REPOSITORY,
    channel: "stable",
    hosts,
    pluginRoot: next.pluginRoot || previous.pluginRoot || "",
    managedMarketplaceDir: next.managedMarketplaceDir || previous.managedMarketplaceDir || "",
    projectDir: next.projectDir || previous.projectDir || "",
    canvasDir: next.canvasDir || previous.canvasDir || "",
    installedAt: previous.installedAt || next.installedAt || new Date().toISOString(),
    updatedAt: next.updatedAt || new Date().toISOString(),
  };
}

export function updaterPaths(homeDir, platform = process.platform) {
  const updaterDir = join(homeDir, ".buzzassist", "updater");
  return {
    updaterDir,
    configPath: join(updaterDir, "config.json"),
    statePath: join(updaterDir, "state.json"),
    logPath: join(updaterDir, "update.log"),
    lockDir: join(updaterDir, "update.lock"),
    releasesDir: join(homeDir, ".buzzassist", "releases"),
    backupsDir: join(homeDir, ".buzzassist", "backups"),
    windowsRunnerPath: join(updaterDir, "run-update.cmd"),
    windowsTaskXmlPath: join(updaterDir, "run-update.task.xml"),
    launchAgentPath: platform === "darwin"
      ? join(homeDir, "Library", "LaunchAgents", `${BUZZASSIST_UPDATE_LABEL}.plist`)
      : "",
  };
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderLaunchAgentPlist({ nodePath, updaterPath, configPath, logPath, pathEnv = "", hour = 3, minute = 17 }) {
  const args = [nodePath, updaterPath, "--scheduled", "--config", configPath]
    .map((value) => `      <string>${xmlEscape(value)}</string>`)
    .join("\n");
  // launchd の既定 PATH は /usr/bin:/bin:/usr/sbin:/sbin だけで、npm も claude も
  // codex も見えない。登録したシェルの PATH を固定して渡さないと、定刻の更新は
  // npm ci か host の plugin 更新で落ちる。
  const environment = String(pathEnv || "").trim()
    ? `  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(pathEnv)}</string>
  </dict>
`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${BUZZASSIST_UPDATE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${hour}</integer>
    <key>Minute</key><integer>${minute}</integer>
  </dict>
  <!-- 3:17 に電源が落ちていた・ログアウトしていた日の分を、ログイン時に取り返す。
       1日に何度起動されても、update-current の 20 時間短絡で確認は1回に収まる。 -->
  <key>RunAtLoad</key><true/>
${environment}  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

function cmdQuote(value) {
  return `"${String(value).replaceAll("%", "%%").replaceAll('"', '""')}"`;
}

export function renderWindowsUpdateRunner({ nodePath, updaterPath, configPath, logPath }) {
  return `@echo off\r\n${cmdQuote(nodePath)} ${cmdQuote(updaterPath)} --scheduled --config ${cmdQuote(configPath)} >> ${cmdQuote(logPath)} 2>&1\r\n`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

/**
 * Windows タスクスケジューラの定義（XML）。
 *
 * `schtasks /Create /SC DAILY` は取りこぼしを補わない。3:17 に電源が落ちていた日は、
 * その日の確認が丸ごと飛ぶ。XML なら「開始予定を過ぎたら、次に動けるときに実行」
 * （StartWhenAvailable）と、バッテリー駆動でも止めない設定を管理者権限なしで付けられる。
 * ログオン時トリガーは一般ユーザーでは登録を拒まれる環境があるので使わない。
 */
export function renderWindowsTaskXml({ runnerPath, hour = 3, minute = 17, startDate = "2026-01-01" }) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(startDate))) throw new Error(`Invalid task start date: ${startDate}`);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("Windows task hour/minute are out of range.");
  }
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>BuzzAssist stable Release update (daily 03:17, runs after a missed start)</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${startDate}T${pad2(hour)}:${pad2(minute)}:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(runnerPath)}</Command>
    </Exec>
  </Actions>
</Task>
`;
}

/** Task Scheduler が読む形（UTF-16LE + BOM）。schtasks /XML は書き出しと同じこの形を確実に受け付ける。 */
export function encodeWindowsTaskXml(xml) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(String(xml).replace(/\r?\n/gu, "\r\n"), "utf16le")]);
}

/** schtasks /Query /XML の出力に、取りこぼし補完の設定が実際に載っているか。 */
export function windowsTaskXmlHasCatchUp(text) {
  // schtasks はパイプへ UTF-16 で書くことがある。NUL を落としてから見る。
  const normalized = String(text || "").replaceAll("\u0000", "");
  return /<StartWhenAvailable>\s*true\s*<\/StartWhenAvailable>/iu.test(normalized)
    && /<CalendarTrigger>/iu.test(normalized);
}

/**
 * スケジューラから起動される更新器に渡す PATH。
 *
 * launchd / systemd の既定 PATH には、Node の隣の npm も、claude / codex も無い。
 * 登録したシェルの PATH をそのままの順で先に置き（対話で使っている claude / codex と
 * 同じものが選ばれる）、登録した Node の置き場所とよく使われる置き場所を後ろに足す。
 * 相対パスは入れない（起動時の作業ディレクトリ次第で別物を指す）。
 */
export function schedulerPathEnv({ nodePath = "", env = process.env, platform = process.platform, homeDir = "" } = {}) {
  const api = platform === "win32" ? win32 : posix;
  const separator = platform === "win32" ? ";" : ":";
  const entries = [];
  const add = (value) => {
    const text = String(value || "").trim();
    if (!text || !api.isAbsolute(text) || entries.includes(text)) return;
    entries.push(text);
  };
  const pathKey = Object.keys(env || {}).find((key) => /^path$/iu.test(key));
  for (const entry of String(pathKey ? env[pathKey] : "").split(separator)) add(entry);
  if (nodePath) add(api.dirname(nodePath));
  if (platform !== "win32") {
    if (homeDir) {
      add(api.join(homeDir, ".local", "bin"));
      add(api.join(homeDir, ".claude", "local"));
    }
    for (const entry of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]) add(entry);
  }
  return entries.join(separator);
}

function readJsonFileSync(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * この端末で BuzzAssist plugin が既に入っているホスト（codex / claude）。
 *
 * CLAUDE.md は Claude Code だけ、AGENTS.md は Codex だけを設定させるので、
 * 手順どおりに両方へ入れた運営者でも、最後に setup した方しか自動更新の対象に
 * 残らなかった。入っているものは、どちらの手順で入ったかに関係なく更新対象にする。
 */
export function detectInstalledBuzzAssistHosts({ homeDir } = {}) {
  if (!homeDir) return [];
  const hosts = [];
  if (existsSync(join(homeDir, ".codex", "plugins", "cache", "buzzassist"))) hosts.push("codex");
  const claudeRecord = readJsonFileSync(join(homeDir, ".claude", "plugins", "installed_plugins.json"));
  const claudeEntries = claudeRecord?.plugins?.[BUZZASSIST_PLUGIN_SELECTOR];
  if (Array.isArray(claudeEntries) ? claudeEntries.length > 0 : Boolean(claudeEntries)) hosts.push("claude");
  return hosts;
}

function envFlag(value) {
  return /^(1|true|yes)$/iu.test(String(value || "").trim());
}

// 0.1.26 以前の更新器（update-current.mjs）が setup-agents に渡す引数の組。
const LEGACY_UPDATER_SETUP_FLAGS = Object.freeze(["--agents", "--skip-install", "--skip-build", "--no-launch", "--no-auto-update"]);

/**
 * setup-agents が自動更新器から呼ばれたか。
 *
 * 新しい更新器は UPDATER_INSTALL_ENV を立てる。既に運営者の端末で動いている古い更新器は
 * 立てないので、「--agents / --skip-install / --skip-build / --no-launch / --no-auto-update」と
 * BUZZASSIST_AUTO_UPDATE_SKIP_REGISTER=1 がそろった呼び出しも更新器として扱う。
 * 対話の setup がこの組をそろえることは無い。
 */
export function isUpdaterInstallInvocation({ argv = [], env = process.env } = {}) {
  if (envFlag(env?.[UPDATER_INSTALL_ENV])) return { updater: true, signal: "env" };
  const legacy = LEGACY_UPDATER_SETUP_FLAGS.every((flag) => argv.includes(flag))
    && envFlag(env?.BUZZASSIST_AUTO_UPDATE_SKIP_REGISTER);
  return legacy ? { updater: true, signal: "legacy-updater-arguments" } : { updater: false, signal: "" };
}

/** 更新対象ホストの和。順序は最初に現れた順で、codex / claude 以外は落とす。 */
export function unionUpdateHosts(...lists) {
  const merged = [];
  for (const list of lists) {
    for (const item of Array.isArray(list) ? list : String(list || "").split(",")) {
      const normalized = String(item || "").trim().toLowerCase();
      if ((normalized === "codex" || normalized === "claude") && !merged.includes(normalized)) merged.push(normalized);
    }
  }
  return merged;
}

/**
 * 定刻起動の短絡判定。手動実行（--scheduled なし）と明示フラグ（--force / --no-throttle）
 * では短絡しない。失敗した回は lastCompletedCheckAt を進めないので、次の起動で再試行する。
 */
export function recentCheckDecision({
  state,
  now = Date.now(),
  scheduled = false,
  force = false,
  noThrottle = false,
  minIntervalMs = UPDATE_CHECK_MIN_INTERVAL_MS,
} = {}) {
  if (!scheduled) return { skip: false, reason: "manual-run" };
  if (force || noThrottle) return { skip: false, reason: "explicit-override" };
  const lastText = String(state?.lastCompletedCheckAt || "");
  const last = Date.parse(lastText);
  if (!Number.isFinite(last)) return { skip: false, reason: "no-completed-check" };
  const ageMs = now - last;
  if (ageMs < 0) return { skip: false, reason: "clock-skew", lastCompletedCheckAt: lastText };
  if (ageMs < minIntervalMs) return { skip: true, reason: "recent-check", lastCompletedCheckAt: lastText, ageMs };
  return { skip: false, reason: "interval-elapsed", lastCompletedCheckAt: lastText, ageMs };
}

/**
 * 更新器から呼ばれた setup-agents の出力から、ハーネス前提の状況とホストの見送りを読む。
 * 更新はこれで止めない。state と更新ログに警告として残す。
 */
export function parseSetupInstallReport(stdout) {
  const values = new Map();
  for (const line of String(stdout || "").split(/\r?\n/gu)) {
    const match = line.match(/^(BUZZASSIST_(?:HARNESS_READY|HARNESS_READY_OVERRIDE|HARNESS_BLOCKING|HOST_SKIPPED|PREREQUISITES))=(.*)$/u);
    if (match) values.set(match[1], match[2].trim());
  }
  const list = (key) => String(values.get(key) || "").split(",").map((item) => item.trim()).filter(Boolean);
  const harnessReady = values.get("BUZZASSIST_HARNESS_READY") || "unreported";
  const blocking = list("BUZZASSIST_HARNESS_BLOCKING");
  const skippedHosts = list("BUZZASSIST_HOST_SKIPPED");
  const warnings = [];
  if (harnessReady !== "yes") {
    warnings.push(`harness-not-ready:${harnessReady}${blocking.length ? `:${blocking.join(",")}` : ""}`);
  }
  for (const host of skippedHosts) warnings.push(`host-skipped:${host}`);
  return {
    harnessReady,
    harnessOverride: values.get("BUZZASSIST_HARNESS_READY_OVERRIDE") || "",
    blocking,
    skippedHosts,
    prerequisites: values.get("BUZZASSIST_PREREQUISITES") || "",
    warnings,
  };
}

/**
 * 登録ホストのうち、導入済みの版が `version` より古いもの。版の分からない導入物は数えない
 * （毎晩入れ直しを繰り返さないため）。
 */
export function hostsBehindVersion({ installs = [], hosts = [], version } = {}) {
  const target = normalizeVersion(version);
  if (!target) return [];
  const wanted = new Set(unionUpdateHosts(hosts));
  const behind = [];
  for (const install of installs) {
    if (!wanted.has(install?.host)) continue;
    const installed = normalizeVersion(install.version);
    if (!installed) continue;
    if (compareVersions(installed, target) < 0) behind.push({ host: install.host, version: installed.raw });
  }
  return behind;
}

export function safeReleaseDirectoryName(version) {
  const normalized = normalizeVersion(version);
  if (!normalized) throw new Error(`Invalid release directory version: ${version}`);
  return `v${normalized.raw.replace(/[^0-9A-Za-z.-]/g, "-")}`;
}
