import { join } from "node:path";

export const BUZZASSIST_REPOSITORY = "sam-mountainman/BuzzAssist";
export const BUZZASSIST_UPDATE_LABEL = "ai.buzzassist.plugin-updater";
export const BUZZASSIST_WINDOWS_TASK = "BuzzAssist Plugin Update";

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

export function renderLaunchAgentPlist({ nodePath, updaterPath, configPath, logPath, hour = 3, minute = 17 }) {
  const args = [nodePath, updaterPath, "--scheduled", "--config", configPath]
    .map((value) => `      <string>${xmlEscape(value)}</string>`)
    .join("\n");
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
  <key>ProcessType</key><string>Background</string>
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

export function safeReleaseDirectoryName(version) {
  const normalized = normalizeVersion(version);
  if (!normalized) throw new Error(`Invalid release directory version: ${version}`);
  return `v${normalized.raw.replace(/[^0-9A-Za-z.-]/g, "-")}`;
}
