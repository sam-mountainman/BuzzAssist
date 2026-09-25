// ホストの指示ファイル（CLAUDE.md / AGENTS.md / GEMINI.md）を1つのテンプレートから作る。
//
// なぜ要るか:
// 3つを手で保守していて、同じ規則の文面がホストごとにずれていた（2026-09-25 の外部レビュー）。
// AGENTS.md だけが旧スクリプトを「新規回では使わない」と書き、CLAUDE.md だけがアダプターの
// 説明を持ち、GEMINI.md は直接起動を拒否されるようになった内部 runner を「唯一の入口」と
// 書いたままだった。同じ規則が3か所にあると、直すときに1か所だけ直る。
//
// ホストごとに違ってよいのは、ホスト名・ブラウザーの呼び方・ウィジェットの扱い・
// セットアップの手順のような「そのホストの語」だけ。それを HOST_INSTRUCTION_PROFILES に置き、
// テンプレート（config/host-instructions.template.md）へ差し込む。
//
// テンプレートの書式:
//   {{name}}                 ホストの語を差し込む（未定義の名前は例外。黙って空にしない）
//   {{#hosts claude codex}}  その行から {{/hosts}} の行までを、挙げたホストのときだけ残す
//
// Antigravity のセットアップ手順は、setup が運営者のプロジェクトの GEMINI.md へ書き込む
// 管理ブロックと同じもの。ここに1つだけ置き、setup もこのリポジトリの GEMINI.md も
// 同じ関数から作る（リポジトリで setup を走らせても GEMINI.md が変わらない）。

import { readFile } from "node:fs/promises";
import path from "node:path";

export const HOST_INSTRUCTION_TEMPLATE = "config/host-instructions.template.md";
export const MANAGED_BLOCK_MARKER = "BUZZASSIST";

export const HOST_INSTRUCTION_OUTPUTS = Object.freeze({
  claude: "CLAUDE.md",
  codex: "AGENTS.md",
  antigravity: "GEMINI.md",
});

/**
 * Antigravity 用のセットアップ手順。setup-agents が運営者のプロジェクトの GEMINI.md へ
 * 管理ブロックとして書き込み、このリポジトリの GEMINI.md の末尾にも同じものが入る。
 */
export function antigravitySetupBlock() {
  return `# BuzzAssist Agent Setup

When the user gives this repository URL and asks to set it up, do the setup end to end for Antigravity only.

1. Clone or open this repository.
2. Run \`node scripts/setup-agents.mjs --agent antigravity --project-dir <active-user-project-dir>\` from the repository root. If there is no separate active project, use this repository root as the project dir.
3. The script must configure Antigravity only. Do not configure Codex, Claude Code, or Cursor unless the user explicitly asks for those hosts too.
4. After the script prints \`BUZZASSIST_CANVAS_URL=...\` and \`BUZZASSIST_CANVAS_CHECK=ok\`, first open that URL in Antigravity's in-app browser. Only if that capability is unavailable, use Chrome/the external-browser fallback.
5. If the user wants phone/mobile access or says they want the exact same Excalidraw UI outside the machine, use Canvas Tunnel: run setup with \`--tunnel\` or run \`npm run tunnel:start -- --project-dir <active-user-project-dir>\`. The tunnel uses Cloudflare (\`cloudflared\`) by default — no account is needed. If a system copy is not installed, BuzzAssist downloads the pinned official release into the user's \`~/.buzzassist/tools/\` cache, verifies its SHA-256 checksum, and runs it without administrator privileges. Use \`--no-auto-download\` or \`BUZZASSIST_CLOUDFLARED_AUTO_DOWNLOAD=0\` to opt out. Give the printed \`BUZZASSIST_TUNNEL_ACCESS_URL\` for the phone.

Manual fallback:

\`\`\`bash
node scripts/setup-agents.mjs --agent antigravity --project-dir <active-user-project-dir> --no-launch
node scripts/serve-canvas.mjs <active-user-project-dir>
npm run tunnel:start -- --project-dir <active-user-project-dir>
\`\`\`

Use the live URL from \`canvas/.server.json\` when a requested port is busy.
`;
}

/**
 * 管理ブロック（<!-- MARKER:START --> 〜 <!-- MARKER:END -->）を差し替えるか、末尾へ足す。
 * setup-agents の書き込みと、生成したファイルの冪等性の試験が同じ関数を使う。
 */
export function applyManagedBlock(current, marker, body) {
  const start = `<!-- ${marker}:START -->`;
  const end = `<!-- ${marker}:END -->`;
  const block = `${start}\n${String(body).trim()}\n${end}\n`;
  const text = String(current || "");
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end);
  if (startIndex >= 0 && endIndex > startIndex) {
    return `${text.slice(0, startIndex)}${block}${text.slice(endIndex + end.length).replace(/^\n/u, "")}`;
  }
  const prefix = text.trimEnd();
  return `${prefix}${prefix ? "\n\n" : ""}${block}`;
}

const claudeProfile = Object.freeze({
  hostShort: "Claude",
  hostName: "Claude Code",
  agentId: "claude",
  otherHost: "Codex",
  otherCommand: "codex",
  adapterSentence: "The `.claude/skills` entries are host adapters to that shared source. ",
  mangaHostNote: "",
  openCanvasSentence: "first open that URL with Claude Code's browser tool when it is exposed. This is mandatory when the tool is available.",
  newSession: "Claude Code session",
  inAppBrowser: "Claude Code's in-app browser",
  widgetRule: "Claude Code itself does not render MCP Apps widgets. Always use the local canvas URL plus MCP tools in Claude Code.",
  widgetFallbackHosts: "Claude Code",
  chatName: "Claude Code",
  wrongChat: "the wrong chat or a new Cowork chat",
  pluginInstallCommands: "claude plugin marketplace add ~/plugins/buzzassist --scope user\nclaude plugin install buzzassist@buzzassist --scope user",
});

const codexProfile = Object.freeze({
  hostShort: "Codex",
  hostName: "Codex",
  agentId: "codex",
  otherHost: "Claude Code",
  otherCommand: "claude",
  // Codex はリポジトリの .agents/skills を直接読む（公式仕様）。アダプターの説明は置かない。
  adapterSentence: "",
  mangaHostNote: "",
  openCanvasSentence: "first open `BUZZASSIST_CANVAS_URL` in Codex's in-app browser. This is mandatory when browser control is available.",
  newSession: "Codex task",
  inAppBrowser: "Codex's in-app browser",
  widgetRule: "Claude Code follows the same local-canvas rule: open `BUZZASSIST_CANVAS_URL` in Claude Code's browser tool when it is exposed, and use MCP tools for stable reads/writes.",
  widgetFallbackHosts: "Codex or Claude Code",
  chatName: "Codex",
  wrongChat: "the wrong chat",
  pluginInstallCommands: "codex plugin marketplace add ~/plugins/buzzassist\ncodex plugin add buzzassist@buzzassist",
});

const antigravityProfile = Object.freeze({
  hostShort: "Antigravity",
  hostName: "Antigravity",
  agentId: "antigravity",
  adapterSentence: "",
  mangaHostNote: "The quality gates documented in those skills (voice quality, character attribute gate, blind comparison) are host-agnostic and apply here identically. ",
});

export const HOST_INSTRUCTION_PROFILES = Object.freeze({
  claude: claudeProfile,
  codex: codexProfile,
  antigravity: antigravityProfile,
});

function managedSetupBlockFor(hostId) {
  if (hostId !== "antigravity") return "";
  return applyManagedBlock("", MANAGED_BLOCK_MARKER, antigravitySetupBlock()).trimEnd();
}

/**
 * テンプレートを1つのホスト向けに展開する。書式の誤り（閉じ忘れ・未知の名前）は例外にする。
 */
export function renderHostInstructions(template, hostId) {
  const profile = HOST_INSTRUCTION_PROFILES[hostId];
  if (!profile) throw new Error(`未知のホスト: ${hostId}`);
  const values = { ...profile, managedSetupBlock: managedSetupBlockFor(hostId) };
  const lines = String(template).replace(/\r\n/gu, "\n").split("\n");
  const stack = [];
  const output = [];
  lines.forEach((line, index) => {
    const open = line.match(/^\{\{#hosts\s+([a-z\s]+)\}\}\s*$/u);
    if (open) {
      const hosts = open[1].trim().split(/\s+/u);
      for (const host of hosts) {
        if (!HOST_INSTRUCTION_PROFILES[host]) throw new Error(`テンプレート ${index + 1} 行目: 未知のホスト ${host}`);
      }
      stack.push({ line: index + 1, active: hosts.includes(hostId) });
      return;
    }
    if (/^\{\{\/hosts\}\}\s*$/u.test(line)) {
      if (stack.length === 0) throw new Error(`テンプレート ${index + 1} 行目: 対応する {{#hosts}} が無い`);
      stack.pop();
      return;
    }
    if (stack.some((entry) => !entry.active)) return;
    output.push(line.replace(/\{\{([A-Za-z]+)\}\}/gu, (_match, name) => {
      if (!Object.hasOwn(values, name)) {
        throw new Error(`テンプレート ${index + 1} 行目: ${hostId} に ${name} が定義されていない`);
      }
      return values[name];
    }));
  });
  if (stack.length > 0) throw new Error(`テンプレート ${stack.at(-1).line} 行目の {{#hosts}} が閉じていない`);
  return output.join("\n");
}

export async function readHostInstructionTemplate(repoRoot) {
  return readFile(path.join(repoRoot, HOST_INSTRUCTION_TEMPLATE), "utf8");
}

/** 3つのファイルの中身を作る（書き込みはしない）。 */
export async function generateHostInstructionFiles(repoRoot) {
  const template = await readHostInstructionTemplate(repoRoot);
  return Object.entries(HOST_INSTRUCTION_OUTPUTS).map(([hostId, fileName]) => ({
    hostId,
    fileName,
    path: path.join(repoRoot, fileName),
    content: renderHostInstructions(template, hostId),
  }));
}
