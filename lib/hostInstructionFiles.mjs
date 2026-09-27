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
//
// 指示ファイルは「地図」にする（2026-09-27）。常に読み込まれる文書が長いほど、1つ1つの決まりが
// 「関係があるかもしれない情報」として任意に扱われ、守られにくくなる。地図には「どの依頼で何を読むか」と
// コードで強制できない重要な決まりの要点だけを置き、決まりの全文は docs/host-instructions-detail-ja.md、
// セットアップの手順は docs/agent-setup.md に置く。地図が HOST_INSTRUCTION_MAX_LINES を超えたら生成を止める
// （書き足すたびに少しずつ百科事典へ戻るのを、目視ではなく生成の時点で止める）。

import { readFile } from "node:fs/promises";
import path from "node:path";

export const HOST_INSTRUCTION_TEMPLATE = "config/host-instructions.template.md";
export const MANAGED_BLOCK_MARKER = "BUZZASSIST";

/** 地図の行数の上限。超えたら詳細を docs/host-instructions-detail-ja.md か正本スキルへ移す。 */
export const HOST_INSTRUCTION_MAX_LINES = 60;

export const HOST_INSTRUCTION_OUTPUTS = Object.freeze({
  claude: "CLAUDE.md",
  codex: "AGENTS.md",
  antigravity: "GEMINI.md",
});

/**
 * Antigravity 用のセットアップ手順。setup-agents が運営者のプロジェクトの GEMINI.md へ
 * 管理ブロックとして書き込み、このリポジトリの GEMINI.md の末尾にも同じものが入る。
 *
 * 地図の行数に収めるため、手順の要点（自分のホストだけを設定する・in-app browser を先に開く・
 * スマホは Canvas Tunnel・ポートが埋まっていたら canvas/.server.json の URL）だけを置く。
 * トンネルの取得と止め方・手動の代替手順は docs/agent-setup.md（配布物にも入る）へ移した。
 */
export function antigravitySetupBlock() {
  return `# BuzzAssist Agent Setup

When the user gives this repository URL and asks to set it up, do the setup end to end for Antigravity only.

1. Clone or open this repository, then run \`node scripts/setup-agents.mjs --agent antigravity --project-dir <active-user-project-dir>\` from the repository root. If there is no separate active project, use this repository root as the project dir.
2. The script must configure Antigravity only. Do not configure Codex, Claude Code, or Cursor unless the user explicitly asks for those hosts too.
3. After the script prints \`BUZZASSIST_CANVAS_URL=...\` and \`BUZZASSIST_CANVAS_CHECK=ok\`, first open that URL in Antigravity's in-app browser. Only if that capability is unavailable, use Chrome/the external-browser fallback.
4. For phone/mobile access or the exact same Excalidraw UI outside the machine, use Canvas Tunnel: run setup with \`--tunnel\` or run \`npm run tunnel:start -- --project-dir <active-user-project-dir>\`, and give the printed \`BUZZASSIST_TUNNEL_ACCESS_URL\` for the phone.

Use the live URL from \`canvas/.server.json\` when a requested port is busy. The full procedure (tunnel download and opt-out, manual fallback) is \`docs/agent-setup.md\` in the BuzzAssist repository and in the installed plugin (\`~/plugins/buzzassist/plugin/docs/agent-setup.md\`).
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

// 地図に差し込むホストの語。セットアップの細かな違い（プラグインの登録コマンド・新しい会話の呼び方など）は
// docs/agent-setup.md の表と手順に移したので、ここには地図に出る語だけを置く。
const claudeProfile = Object.freeze({
  hostName: "Claude Code",
  agentId: "claude",
  otherHost: "Codex",
  // Claude Code は .agents/skills を直接読まないので、.claude/skills のアダプターから正本へ届く。
  skillNote: "`.claude/skills` の項目はこの正本へのアダプター。",
  inAppBrowser: "Claude Code の in-app browser（ブラウザーツールが出ていれば必ず）",
  widgetRule: "Claude Code は MCP Apps のウィジェットを描かないので、ローカルのキャンバス URL と MCP ツールを使う。",
});

const codexProfile = Object.freeze({
  hostName: "Codex",
  agentId: "codex",
  otherHost: "Claude Code",
  // Codex はリポジトリの .agents/skills を直接読む（公式仕様）。アダプターの説明は置かない。
  skillNote: "",
  inAppBrowser: "Codex の in-app browser（操作できるなら必ず）",
  widgetRule: "",
});

const antigravityProfile = Object.freeze({
  hostName: "Antigravity",
  agentId: "antigravity",
  skillNote: "そこに書かれた品質ゲート（声の品質・キャラの属性ゲート・ブラインド比較）は Antigravity でも同じに効く。",
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

/** 行数（末尾の改行は1行に数えない）。 */
export function countInstructionLines(text) {
  const normalized = String(text).replace(/\r\n/gu, "\n");
  if (normalized === "") return 0;
  return normalized.replace(/\n$/u, "").split("\n").length;
}

// 地図が指すリポジトリ内のファイル（`docs/…`・`.agents/skills/…`・`node scripts/….mjs` など）。
// 地図は「どこを見ればいいか」だけを持つので、指す先が無い・配布物に入っていない地図は、
// 運営者の端末で行き止まりになる。試験がこの一覧で実在と配布を確かめる。
const REFERENCE_PATTERN = /(?:^|[\s`(（])((?:\.agents|docs|scripts|config|lib)\/[A-Za-z0-9_.\/*<>-]+)/gu;

/** 指示ファイルの本文から、リポジトリ内のファイルへの参照を重複なく取り出す（<…> や * を含むものは除く）。 */
export function referencedRepoPaths(text) {
  const found = new Set();
  for (const match of String(text).matchAll(REFERENCE_PATTERN)) {
    const ref = match[1].replace(/[.,]+$/u, "");
    if (/[*<>]/u.test(ref) || ref.endsWith("/")) continue;
    found.add(ref);
  }
  return [...found].sort();
}

/** 3つのファイルの中身を作る（書き込みはしない）。地図が上限の行数を超えたら例外にする。 */
export async function generateHostInstructionFiles(repoRoot) {
  const template = await readHostInstructionTemplate(repoRoot);
  return Object.entries(HOST_INSTRUCTION_OUTPUTS).map(([hostId, fileName]) => {
    const content = renderHostInstructions(template, hostId);
    const lines = countInstructionLines(content);
    if (lines > HOST_INSTRUCTION_MAX_LINES) {
      throw new Error(`${fileName} が ${lines} 行で、地図の上限 ${HOST_INSTRUCTION_MAX_LINES} 行を超えている。`
        + "詳細は docs/host-instructions-detail-ja.md か正本スキルへ移し、地図には「どの依頼で何を読むか」と要点だけを置く");
    }
    return { hostId, fileName, path: path.join(repoRoot, fileName), content };
  });
}
