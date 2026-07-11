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
