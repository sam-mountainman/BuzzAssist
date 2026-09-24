import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

export const SUPPORTED_SETUP_AGENTS = ["codex", "claude-desktop", "claude", "cursor", "antigravity"];
export const MINIMUM_NODE_MAJOR = 20;

export function normalizeSetupAgentName(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (!normalized || normalized === "auto" || normalized === "current") return null;
  if (["claude-desktop", "claude-app", "claude-desktop-app"].includes(normalized)) return "claude-desktop";
  if (["claude-code", "claude"].includes(normalized)) return "claude";
  if (["google-antigravity", "gemini", "antigravity"].includes(normalized)) return "antigravity";
  if (["cursor", "cursor-ide"].includes(normalized)) return "cursor";
  if (normalized === "codex") return "codex";
  throw new Error(`Unsupported agent "${value}". Use one of: ${SUPPORTED_SETUP_AGENTS.join(", ")}.`);
}

export function detectSetupAgent({ env = process.env, argv = process.argv } = {}) {
  // Explicit BuzzAssist hints win over generic terminal/process names. Codex
  // and Claude Code set different environment markers, while desktop app
  // shells can both report a generic TERM_PROGRAM value.
  for (const value of [env.BUZZASSIST_SETUP_AGENT, env.BUZZASSIST_AGENT, env.BUZZASSIST_HOST]) {
    const explicit = normalizeSetupAgentName(value);
    if (explicit) return explicit;
  }

  const hints = [
    env.CURSOR_TRACE_ID ? "cursor" : "",
    env.CURSOR_AGENT ? "cursor" : "",
    env.ANTIGRAVITY ? "antigravity" : "",
    env.GEMINI_CLI ? "gemini" : "",
    env.CLAUDE_CODE ? "claude" : "",
    env.CLAUDECODE ? "claude" : "",
    env.CODEX ? "codex" : "",
    env.CODEX_THREAD_ID ? "codex" : "",
    env.TERM_PROGRAM,
    env.npm_config_user_agent,
    env._,
    argv.join(" "),
  ].filter(Boolean).join(" ").toLowerCase();

  if (hints.includes("cursor")) return "cursor";
  if (hints.includes("antigravity") || hints.includes("gemini")) return "antigravity";
  if (hints.includes("claude")) return "claude";
  if (hints.includes("codex")) return "codex";
  // The public setup instructions always pass --agent. This fallback keeps a
  // direct `node scripts/setup-agents.mjs` invocation useful in Codex without
  // ever configuring multiple hosts implicitly.
  return "codex";
}

export function commandNameForPlatform(name, platform = process.platform) {
  return platform === "win32" ? `${name}.cmd` : name;
}

/**
 * ホストの CLI（claude / codex）の起動名。
 *
 * Windows のネイティブインストーラが入れる Claude Code は claude.exe で、claude.cmd は無い。
 * 名前を claude.cmd に決め打ちすると、シェル経由で「認識されません」が exit 1 で返り、
 * CLI が入っているのに plugin の導入が失敗していた。PATH をディレクトリ順に見て、
 * 各ディレクトリの中は Windows と同じく .exe → .cmd の順で最初に見つかったものを使う。
 * 見つからなければ従来どおり <name>.cmd（npm で入れた CLI）。
 */
export function resolveHostCommandForPlatform(name, {
  platform = process.platform,
  env = process.env,
  exists = existsSync,
} = {}) {
  if (platform !== "win32") return name;
  const pathKey = Object.keys(env || {}).find((key) => /^path$/iu.test(key));
  const dirs = String(pathKey ? env[pathKey] : "").split(";").map((entry) => entry.trim().replace(/^"(.*)"$/u, "$1")).filter(Boolean);
  const localBin = env.USERPROFILE ? win32.join(env.USERPROFILE, ".local", "bin") : "";
  if (localBin && !dirs.includes(localBin)) dirs.push(localBin);
  for (const dir of dirs) {
    for (const extension of [".exe", ".cmd"]) {
      const candidate = win32.join(dir, `${name}${extension}`);
      if (exists(candidate)) return candidate;
    }
  }
  return `${name}.cmd`;
}

export function claudeDesktopConfigPathForPlatform({
  homeDir,
  env = process.env,
  platform = process.platform,
} = {}) {
  if (!homeDir) throw new Error("homeDir is required.");
  if (platform === "darwin") {
    return posix.join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (platform === "win32") {
    const appData = env.APPDATA || win32.join(homeDir, "AppData", "Roaming");
    return win32.join(appData, "Claude", "claude_desktop_config.json");
  }
  return posix.join(homeDir, ".config", "Claude", "claude_desktop_config.json");
}

export function assertSupportedNodeVersion(version = process.versions.node) {
  const major = Number.parseInt(String(version || "").split(".")[0], 10);
  if (Number.isFinite(major) && major >= MINIMUM_NODE_MAJOR) return major;
  throw new Error(
    `BuzzAssist requires Node.js ${MINIMUM_NODE_MAJOR} or newer (detected: ${version || "unknown"}). ` +
      "Install Node.js LTS, then run setup again. macOS: brew install node. Windows: winget install OpenJS.NodeJS.LTS.",
  );
}

export function hostInstallHelp(agent, platform = process.platform) {
  if (agent === "codex") {
    return platform === "win32"
      ? "Install the ChatGPT desktop app from https://chatgpt.com/download/ or install Codex CLI, then rerun setup."
      : "Install the ChatGPT desktop app from https://chatgpt.com/download/ or install Codex CLI, then rerun setup.";
  }
  if (agent === "claude") {
    return platform === "win32"
      ? "Install Claude Code from https://docs.anthropic.com/en/docs/claude-code/setup, restart PowerShell, then rerun setup."
      : "Install Claude Code from https://docs.anthropic.com/en/docs/claude-code/setup, then rerun setup.";
  }
  return "Install the selected host, then rerun setup.";
}
