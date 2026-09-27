// スキルの棚卸し（定量と、定性の判定を頼むための材料）。
//
// スキルは放っておくと増え続け、ホストの公式機能が出て自作のものが要らなくなっても残る。
// 棚卸しは2系統で行う:
//
//   - 定量: どのスキルが、どのホストで、何回・いつ使われたかを、端末の会話の記録から数える
//   - 定性: 「このハーネスの中でこのスキルは要るか」を、別の文脈の LLM に判定させる
//     （ここでは判定を頼むシートを作るところまで。外部モデルは呼ばない）
//
// そのうえで棚卸しの日を手元に残し、doctor が「前の棚卸しから30日以上」を知らせる
// （記録が無ければ何も言わない）。棚卸しのタイミングを意図的に作るため。
//
// ここが守る規則:
//
//   - **読むだけ**。会話の記録（~/.claude/projects、~/.codex/sessions・archived_sessions）には
//     何も書かない。本文も保存しない。出すのはスキル名・回数・最後に使った日・ホストだけ
//   - **読む量と時間に上限を持つ**。Codex の記録は数十GB、1ファイル数百MBもある。更新日時で
//     期間の外のファイルを外し、新しい順に読み、行は rg（無ければ Node の逐次読み）で先に絞ってから
//     JSON を読む。上限に当たったら「数え切れていない」と明示し、数は下限として扱う
//   - **数えるのは「使った」形だけ**。スキルの一覧（Codex の skills_instructions、Claude Code の
//     skill_listing・道具の定義）にも SKILL.md のパスとスキル名は毎回出るが、それは使ったことではない。
//     Claude Code は Skill の道具の呼び出し・/コマンド・SKILL.md を読む道具の呼び出し、Codex は
//     コマンドを実行する道具の呼び出しの中の SKILL.md だけを数える。書き換え（Edit・apply_patch）は数えない
//   - **同じ名前の別物を数えない**。`skill-creator` のように端末全体の汎用スキルと名前がぶつかるものは、
//     BuzzAssist のチェックアウト・配布物の中のパスだと確かめられたときだけ数え、確かめられないものは
//     「帰属できなかった」として件数だけ出す

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { operatorLearningStateDir } from "./harnessLearningState.mjs";
import { SKILL_INVENTORY_MANIFEST_PATH, SKILL_PROFILES_MANIFEST_PATH, parseSkillFrontmatter } from "./skillInventory.mjs";

export const SKILL_USAGE_REPORT_VERSION = "buzzassist-skill-usage-v1";
export const SKILL_REVIEW_SHEET_VERSION = "buzzassist-skill-review-sheet-v1";
export const SKILL_REVIEW_RECORD_VERSION = "buzzassist-skill-review-v1";
/** 棚卸しの記録。学習の状態の置き場（~/.buzzassist/learning/、BUZZASSIST_LEARNING_DIR）に置く。リポジトリの外。 */
export const SKILL_REVIEW_LOG_FILE = "skill-reviews.jsonl";
/** doctor が「そろそろ棚卸し」と知らせるまでの日数。 */
export const SKILL_REVIEW_INTERVAL_DAYS = 30;
export const DEFAULT_USAGE_WINDOW_DAYS = 30;
export const DEFAULT_MAX_BYTES_PER_HOST = 16 * 1024 ** 3;
export const DEFAULT_MAX_SECONDS_PER_HOST = 120;
/**
 * これより長い1行は読まずに飛ばし、「数え切れていない」に数える（1行数百MBの記録でメモリを食わないため）。
 * 実測（2026-09-27、開発機の Codex の記録）で、SKILL.md を含む道具の呼び出しの行に 4MiB を超えるものがあった。
 */
export const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
export const SKILL_USAGE_SCANNER_ENV = "BUZZASSIST_SKILL_USAGE_SCANNER";
export const SKILL_USAGE_HOSTS = Object.freeze(["claude", "codex"]);

const DAY_MS = 24 * 60 * 60 * 1000;
// rg を1回起動して渡すファイルの束。起動は負荷の高い端末で1回100ms以上かかるので束ねる。
// 束の大きさは、コマンド行の長さ（Windows の上限 32,767 文字に余裕を持たせる）と、時間の上限で
// 止めたときに数え損なう量（バイト）で切る。
const RG_BATCH_MAX_FILES = 512;
const RG_BATCH_MAX_ARG_CHARS = 24_000;
const RG_BATCH_MAX_BYTES = 2 * 1024 ** 3;

// rg と Node の逐次読みで同じ形を使う（どちらも「行のどこかに当たる」正規表現）。
// Claude Code の道具の呼び出しは {"type":"tool_use","id":...,"name":"Skill","input":{...}} の順で書かれる。
// 道具の定義（prompt_snapshot）は "name":"Skill","description" なので当たらない。
const HOST_SPECS = Object.freeze({
  claude: Object.freeze({
    label: "Claude Code",
    patterns: Object.freeze([
      '"name":"Skill","input"',
      // 人の /コマンドは発言の本文が <command-message> か <command-name> で始まる。道具の結果に
      // 写った同じ文字列（会話の記録を読んだ出力など、1行数MBになる）まで拾わないように、頭で絞る。
      '"(?:content|text)":"<command-(?:message|name)>',
      '"type":"tool_use".*SKILL\\.md',
    ]),
    needles: Object.freeze(['"name":"Skill"', "<command-name>", "SKILL.md"]),
    // 長すぎて読まなかった行が「使った」形でありえたか（行の頭で判定）。一覧や道具の結果だけの行は数えない。
    longLineHead: /"type":"(?:assistant|user)"|"type":"tool_use"/u,
  }),
  codex: Object.freeze({
    label: "Codex",
    patterns: Object.freeze([
      '"type":"(?:function_call|custom_tool_call|local_shell_call)".*SKILL\\.md',
    ]),
    needles: Object.freeze(["SKILL.md"]),
    longLineHead: /"type":"(?:function_call|custom_tool_call|local_shell_call)"/u,
  }),
});
const LONG_LINE_HEAD_BYTES = 64 * 1024;

/** Claude Code で SKILL.md を「読む」と数える道具。Edit・Write は数えない。 */
const CLAUDE_READ_TOOLS = Object.freeze({
  Read: (input) => [input?.file_path],
  Bash: (input) => [input?.command],
  Grep: (input) => [input?.path],
});

/** Codex でコマンドを実行する道具（ここに無い道具＝子への伝言・apply_patch などは数えない）。 */
const CODEX_EXEC_TOOL_NAMES = new Set(["exec", "js", "exec_command", "shell", "shell_command", "local_shell", "container.exec"]);
const CODEX_CALL_TYPES = new Set(["function_call", "custom_tool_call", "local_shell_call"]);

// ---------------------------------------------------------------------------
// 期間

function localDayStart(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(text || "").trim());
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
}

/** 期間を決める。日付だけの指定は端末のその日の始まり（until はその日の終わり）。 */
export function resolveUsageWindow({ since = "", until = "", days = undefined, now = new Date() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  let untilMs = nowMs;
  if (until) {
    const day = localDayStart(until);
    untilMs = day !== null ? day + DAY_MS - 1 : Date.parse(until);
    if (!Number.isFinite(untilMs)) throw new Error(`--until の日時を読めない: ${until}`);
  }
  let sinceMs;
  if (since) {
    const day = localDayStart(since);
    sinceMs = day !== null ? day : Date.parse(since);
    if (!Number.isFinite(sinceMs)) throw new Error(`--since の日時を読めない: ${since}`);
  } else {
    const count = days === undefined || days === null || days === "" ? DEFAULT_USAGE_WINDOW_DAYS : Number(days);
    if (!Number.isFinite(count) || count <= 0) throw new Error(`--days は正の数: ${days}`);
    sinceMs = untilMs - count * DAY_MS;
  }
  if (sinceMs > untilMs) throw new Error("期間の始まりが終わりより後になっている");
  return {
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs).toISOString(),
    sinceMs,
    untilMs,
    days: Math.round(((untilMs - sinceMs) / DAY_MS) * 10) / 10,
  };
}

/** 端末の時刻での日付（YYYY-MM-DD）。人に見せる行だけで使う。 */
export function formatLocalDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ---------------------------------------------------------------------------
// スキルの目録（在庫 manifest と .agents/skills から）

function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function toPosix(value) {
  return String(value || "").replace(/\\/gu, "/");
}

function skillDirName(relativePath) {
  const posix = toPosix(relativePath);
  if (!posix.endsWith("/SKILL.md")) return "";
  return path.posix.basename(path.posix.dirname(posix));
}

function harnessBindings(repoRoot) {
  const bindings = new Map();
  const dir = path.join(repoRoot, "config", "harnesses");
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".harness.json")).sort();
  } catch {
    return bindings;
  }
  for (const name of names) {
    const declaration = readJsonOrNull(path.join(dir, name));
    const harnessId = String(declaration?.id || name.replace(/\.harness\.json$/u, ""));
    for (const skillPath of Array.isArray(declaration?.canonicalSkills) ? declaration.canonicalSkills : []) {
      const key = toPosix(skillPath);
      if (!bindings.has(key)) bindings.set(key, []);
      bindings.get(key).push(harnessId);
    }
  }
  return bindings;
}

function profilePlacement(profiles, skillId) {
  const out = [];
  for (const profile of Array.isArray(profiles?.profiles) ? profiles.profiles : []) {
    if ((profile.alwaysAllowedSkills || []).includes(skillId)) out.push({ profile: profile.id, placement: "always" });
    else if ((profile.eligibleDeclaredSkills || []).includes(skillId)) out.push({ profile: profile.id, placement: "declared" });
  }
  return out;
}

/**
 * 数える相手の一覧を作る。スキルごとに、Skill の道具で呼ばれる名前と、SKILL.md のフォルダー名を持つ。
 *
 * 名前の規則:
 *   - `<名前空間>:<名前>` と `<名前空間>:<アダプター名>`（plugin として入ったとき）
 *   - アダプター名（プロジェクトの .claude/skills から呼ばれたとき）
 *   - 素の `<名前>` は、アダプターが別名になっていないときだけ。別名にしてあるのは、素の名前が
 *     端末全体の汎用スキル（例: skill-creator）とぶつかるから。素の名前で呼ばれたものは数えない
 */
export function loadSkillUsageCatalog({ repoRoot }) {
  if (!repoRoot) throw new Error("loadSkillUsageCatalog には repoRoot が要る。");
  const root = path.resolve(repoRoot);
  const manifestPath = path.join(root, SKILL_INVENTORY_MANIFEST_PATH);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`スキルの在庫 manifest を読めない: ${manifestPath}: ${error.message}`);
  }
  const namespace = String(manifest.namespace || "buzzassist");
  const profiles = readJsonOrNull(path.join(root, SKILL_PROFILES_MANIFEST_PATH));
  const bindings = harnessBindings(root);
  const skills = [];
  const byToolName = new Map();
  const byDir = new Map();
  const genericDirs = new Set();
  const agentsSkillDirs = new Set();
  const claim = (map, key, id) => {
    if (key && !map.has(key)) map.set(key, id);
  };

  for (const entry of Array.isArray(manifest.skills) ? manifest.skills : []) {
    const name = String(entry?.name || "").trim();
    if (!name) continue;
    const id = String(entry.id || `${namespace}:${name}`);
    const canonicalPath = toPosix(entry.canonicalPath || "");
    const adapters = (Array.isArray(entry.adapters) ? entry.adapters : []).filter((adapter) => adapter && adapter.name);
    const renamed = adapters.some((adapter) => adapter.name !== name);
    let description = null;
    try {
      description = parseSkillFrontmatter(fs.readFileSync(path.join(root, canonicalPath), "utf8")).description;
    } catch {
      description = null;
    }
    const canonicalDir = skillDirName(canonicalPath);
    skills.push({
      id,
      name,
      version: entry.version || null,
      canonicalPath,
      listedInManifest: true,
      description,
      classification: entry.classification || null,
      harnesses: bindings.get(canonicalPath) || [],
      profiles: profilePlacement(profiles, id),
    });
    claim(byToolName, `${namespace}:${name}`, id);
    for (const adapter of adapters) {
      claim(byToolName, `${namespace}:${adapter.name}`, id);
      claim(byToolName, adapter.name, id);
      const adapterDir = skillDirName(adapter.path);
      claim(byDir, adapterDir, id);
      if (toPosix(adapter.path).startsWith(".agents/skills/")) agentsSkillDirs.add(adapterDir);
    }
    if (!renamed) claim(byToolName, name, id);
    claim(byDir, canonicalDir, id);
    if (renamed) genericDirs.add(canonicalDir);
    if (canonicalPath.startsWith(".agents/skills/")) agentsSkillDirs.add(canonicalDir);
  }

  // 在庫に載っていない .agents/skills の中身も棚卸しの対象（載せ忘れ・消し忘れを見つけるため）。
  // 名前の衝突を確かめようが無いので、パスが BuzzAssist の中だと確かめられたときだけ数える。
  let extraDirs = [];
  try {
    extraDirs = fs.readdirSync(path.join(root, ".agents", "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !agentsSkillDirs.has(entry.name)
        && fs.existsSync(path.join(root, ".agents", "skills", entry.name, "SKILL.md")))
      .map((entry) => entry.name)
      .sort();
  } catch {
    extraDirs = [];
  }
  for (const dir of extraDirs) {
    const id = `unlisted:${dir}`;
    let description = null;
    try {
      description = parseSkillFrontmatter(fs.readFileSync(path.join(root, ".agents", "skills", dir, "SKILL.md"), "utf8")).description;
    } catch {
      description = null;
    }
    const canonicalPath = `.agents/skills/${dir}/SKILL.md`;
    skills.push({
      id,
      name: dir,
      version: null,
      canonicalPath,
      listedInManifest: false,
      description,
      classification: null,
      harnesses: bindings.get(canonicalPath) || [],
      profiles: [],
    });
    claim(byToolName, `${namespace}:${dir}`, id);
    claim(byDir, dir, id);
    genericDirs.add(dir);
  }

  return {
    repoRoot: root,
    namespace,
    manifestVersion: manifest.manifestVersion || null,
    skills,
    byToolName,
    byDir,
    genericDirs,
  };
}

/** Skill の道具・/コマンドの名前をスキルの id へ。帰属できなければ null。 */
export function attributeSkillName(catalog, rawName) {
  const name = String(rawName || "").trim().replace(/^\//u, "");
  if (!name) return null;
  return catalog.byToolName.get(name) || null;
}

// ---------------------------------------------------------------------------
// SKILL.md のパスの帰属

// パスの区切りとみなす文字（空白・引用符・シェルの記号・括弧）。
const PATH_DELIMITER = /[\s"'`<>|;&(){}[\],]/u;
const SKILL_MD = "SKILL.md";
/** SKILL.md から前へたどるパスの長さの上限。これより長い「区切りの無い塊」はパスではないとみなす。 */
const MAX_SKILL_PATH_CHARS = 4096;

/**
 * 道具の入力の文字列から、SKILL.md で終わるパスらしいものを抜き出す（glob は後で落ちる）。
 * 書き換えは読んだことにしない: apply_patch の本文（*** Begin Patch 〜 *** End Patch）と、
 * リダイレクト（`> path`）の書き込み先は外す。
 *
 * 正規表現の `[^区切り]*SKILL\.md` で探すと、区切りの無い長い塊（1行数MBの記録に実際にある）で
 * 開始位置ごとに末尾まで読んで戻るので、長さの2乗の時間がかかる（12万字で数分）。
 * SKILL.md の出現から前へ区切りまでたどる形にして、読む量を長さに比例させる。
 */
export function extractSkillMdPaths(text) {
  const source = String(text || "").replace(/\*\*\* Begin Patch[\s\S]*?(?:\*\*\* End Patch|$)/gu, " ");
  const found = [];
  let from = 0;
  for (;;) {
    const index = source.indexOf(SKILL_MD, from);
    if (index === -1) break;
    from = index + SKILL_MD.length;
    const floor = Math.max(0, index - MAX_SKILL_PATH_CHARS);
    let start = index;
    while (start > floor && !PATH_DELIMITER.test(source[start - 1])) start -= 1;
    if (start === floor && floor > 0 && !PATH_DELIMITER.test(source[floor - 1])) continue;
    // リダイレクトの書き込み先（`> path`・`>> path`）は読んだことにしない。
    let back = start - 1;
    while (back >= 0 && /\s/u.test(source[back])) back -= 1;
    if (back >= 0 && source[back] === ">") continue;
    found.push(source.slice(start, index + SKILL_MD.length));
  }
  return [...new Set(found)];
}

/**
 * JS のソース（Codex の exec の入力）の中の文字列の escape を1回だけ戻す。
 * `\\` は `\` に、`\n` などは空白に。1回の置換で左から処理するので、Windows のパスの `\\narrated` は
 * 改行と取り違えない。
 */
export function decodeJsStringEscapes(text) {
  return String(text || "").replace(/\\([\\nrt"'`])/gu, (_match, char) => {
    if (char === "\\") return "\\";
    if (char === "n" || char === "r" || char === "t") return " ";
    return char;
  });
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isAbsoluteLike(value) {
  return value.startsWith("/") || /^[A-Za-z]:\//u.test(value);
}

/**
 * SKILL.md のパスを、数える相手のスキルへ帰属させる。
 *
 * 返り値: `{ skillId }`（数える）/ `{ ambiguous: true }`（名前がぶつかり、BuzzAssist の中だと
 * 確かめられない）/ null（BuzzAssist のスキルではない）。
 */
export function attributeSkillMdPath(catalog, rawPath, { cwd = "", homeDir = homedir(), isBuzzAssistRoot = () => false } = {}) {
  const unified = toPosix(rawPath).replace(/\/{2,}/gu, "/");
  const segments = unified.split("/");
  const count = segments.length;
  if (count < 3 || segments[count - 1] !== "SKILL.md" || segments[count - 3] !== "skills") return null;
  const dir = segments[count - 2];
  const skillId = catalog.byDir.get(dir);
  if (!skillId) return null;

  let absolute = null;
  if (unified.startsWith("~/")) absolute = path.join(homeDir, unified.slice(2));
  else if (isAbsoluteLike(unified)) absolute = path.resolve(unified);
  else if (cwd) absolute = path.resolve(cwd, unified);

  // 端末全体のスキルの置き場（~/.agents/skills・~/.claude/skills・~/.codex/skills）は BuzzAssist ではない。
  if (absolute) {
    for (const globalRoot of [[".agents", "skills"], [".claude", "skills"], [".codex", "skills"]]) {
      if (isInside(path.join(homeDir, ...globalRoot), absolute)) return null;
    }
  }
  const lowered = segments.map((segment) => segment.toLowerCase());
  // plugin の置き場（~/plugins/…、各ホストの plugins/cache/…）は、BuzzAssist の plugin の中だけ。
  if (lowered.includes("plugins")) return lowered.includes("buzzassist") ? { skillId } : null;
  if (!catalog.genericDirs.has(dir)) return { skillId };

  // 名前がぶつかるスキル: 置き場（.agents/.claude/.codex の親）が BuzzAssist のチェックアウトか配布物だと確かめる。
  const host = segments[count - 4];
  if ([".agents", ".claude", ".codex"].includes(host)) {
    const rootPath = absolute
      ? path.dirname(path.dirname(path.dirname(path.dirname(absolute))))
      : null;
    if (rootPath && isBuzzAssistRoot(rootPath)) return { skillId };
  }
  return { ambiguous: true };
}

function buzzAssistRootChecker(namespace) {
  const cache = new Map();
  return (rootPath) => {
    const key = path.resolve(rootPath);
    if (cache.has(key)) return cache.get(key);
    const manifest = readJsonOrNull(path.join(key, SKILL_INVENTORY_MANIFEST_PATH));
    const ok = !!manifest && manifest.namespace === namespace;
    cache.set(key, ok);
    return ok;
  };
}

// ---------------------------------------------------------------------------
// 1行から「使った」出来事を取り出す（本文は返さない）

function claudeUserTexts(message) {
  const content = message?.content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((item) => item && item.type === "text" && typeof item.text === "string").map((item) => item.text);
}

/** Claude Code の記録の1行（JSON を読んだもの）から出来事を取り出す。 */
export function claudeEventsFromRecord(record) {
  const events = [];
  if (!record || typeof record !== "object") return events;
  if (record.type === "assistant" && Array.isArray(record.message?.content)) {
    for (const item of record.message.content) {
      if (!item || item.type !== "tool_use") continue;
      if (item.name === "Skill") {
        const name = typeof item.input?.skill === "string" ? item.input.skill : "";
        if (name) events.push({ kind: "skill-tool", name, callId: item.id || "" });
        continue;
      }
      const pick = CLAUDE_READ_TOOLS[item.name];
      if (!pick) continue;
      const texts = pick(item.input).filter((value) => typeof value === "string");
      const paths = texts.flatMap(extractSkillMdPaths);
      if (paths.length > 0) events.push({ kind: "skill-md-read", paths, cwd: typeof record.cwd === "string" ? record.cwd : "", callId: item.id || "" });
    }
  }
  if (record.type === "user") {
    claudeUserTexts(record.message).forEach((text, textIndex) => {
      if (!text.trimStart().startsWith("<command-")) return;
      const matches = text.matchAll(/<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/gu);
      let index = 0;
      for (const match of matches) {
        events.push({ kind: "slash", name: match[1], callId: record.uuid ? `${record.uuid}:${textIndex}:${index}` : "" });
        index += 1;
      }
    });
  }
  return events;
}

function codexCallText(payload) {
  if (payload.type === "local_shell_call") {
    const command = payload.action?.command;
    const text = Array.isArray(command) ? command.join(" ") : String(command || "");
    return { text, cwd: String(payload.action?.working_directory || payload.action?.workdir || "") };
  }
  if (payload.type === "custom_tool_call") {
    const decoded = decodeJsStringEscapes(typeof payload.input === "string" ? payload.input : "");
    const cwd = /["']?workdir["']?\s*:\s*["']([^"']+)["']/u.exec(decoded)?.[1] || "";
    return { text: decoded, cwd };
  }
  const raw = typeof payload.arguments === "string" ? payload.arguments : JSON.stringify(payload.arguments || "");
  try {
    const args = JSON.parse(raw);
    const command = args?.cmd ?? args?.command ?? "";
    const text = Array.isArray(command) ? command.join(" ") : String(command || "");
    return { text, cwd: String(args?.workdir || args?.cwd || "") };
  } catch {
    return { text: raw, cwd: "" };
  }
}

/** Codex の記録の1行（JSON を読んだもの）から出来事を取り出す。 */
export function codexEventsFromRecord(record) {
  if (!record || record.type !== "response_item") return [];
  const payload = record.payload;
  if (!payload || !CODEX_CALL_TYPES.has(payload.type)) return [];
  if (payload.type !== "local_shell_call" && !CODEX_EXEC_TOOL_NAMES.has(String(payload.name || ""))) return [];
  const { text, cwd } = codexCallText(payload);
  const paths = extractSkillMdPaths(text);
  if (paths.length === 0) return [];
  return [{ kind: "skill-md-read", paths, cwd, callId: payload.call_id || payload.id || "" }];
}

// ---------------------------------------------------------------------------
// 集計

function newHostRow() {
  return { sessions: new Set(), skillToolCalls: 0, slashCommands: 0, skillMdReads: 0, lastUsedMs: null };
}

function sessionKey(host, file, record) {
  if (host === "claude") {
    if (typeof record?.sessionId === "string" && record.sessionId) return record.sessionId;
    const parent = path.basename(path.dirname(file));
    if (parent === "subagents") return path.basename(path.dirname(path.dirname(file)));
    return path.basename(file, ".jsonl");
  }
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu.exec(file);
  return match ? match[1].toLowerCase() : path.basename(file, ".jsonl");
}

function createAggregator(catalog, { window, homeDir }) {
  const rows = new Map(catalog.skills.map((skill) => [skill.id, { claude: newHostRow(), codex: newHostRow() }]));
  // 同じ道具の呼び出しが複数の記録に写っている（会話の再開・分岐）ことがある。どの記録を先に読んだかで
  // 会話の数が変わらないように、呼び出し ID ごとに一番早い（同時刻なら会話 ID の小さい）1件だけを残し、
  // 最後にまとめて数える。rg は複数のファイルを並列に読むので、読む順は毎回同じではない。
  const pending = new Map();
  let anonymous = 0;
  const unattributed = {
    claude: { ambiguousSkillMdReads: 0 },
    codex: { ambiguousSkillMdReads: 0 },
  };
  const unknownNamespaced = new Map();
  const unparsable = { claude: 0, codex: 0 };
  const isBuzzAssistRoot = buzzAssistRootChecker(catalog.namespace);

  const touch = (skillId, host, kind, sessionId, timeMs) => {
    const row = rows.get(skillId)?.[host];
    if (!row) return;
    row.sessions.add(sessionId);
    if (kind === "skill-tool") row.skillToolCalls += 1;
    else if (kind === "slash") row.slashCommands += 1;
    else row.skillMdReads += 1;
    if (row.lastUsedMs === null || timeMs > row.lastUsedMs) row.lastUsedMs = timeMs;
  };

  return {
    addLine(host, file, fileMtimeMs, text) {
      let record;
      try {
        record = JSON.parse(text);
      } catch {
        unparsable[host] += 1;
        return;
      }
      const events = host === "claude" ? claudeEventsFromRecord(record) : codexEventsFromRecord(record);
      if (events.length === 0) return;
      const parsedTime = Date.parse(record.timestamp);
      const timeMs = Number.isFinite(parsedTime) ? parsedTime : fileMtimeMs;
      if (timeMs < window.sinceMs || timeMs > window.untilMs) return;
      const sessionId = sessionKey(host, file, record);
      for (const event of events) {
        const key = event.callId ? `${host}\u001f${event.kind}\u001f${event.callId}` : `\u001fanonymous\u001f${anonymous += 1}`;
        const current = pending.get(key);
        if (current && (current.timeMs < timeMs || (current.timeMs === timeMs && current.sessionId <= sessionId))) continue;
        pending.set(key, { host, sessionId, timeMs, event });
      }
    },
    finish() {
      for (const { host, sessionId, timeMs, event } of pending.values()) {
        if (event.kind === "skill-tool" || event.kind === "slash") {
          const skillId = attributeSkillName(catalog, event.name);
          if (skillId) touch(skillId, host, event.kind, sessionId, timeMs);
          else if (String(event.name).replace(/^\//u, "").startsWith(`${catalog.namespace}:`)) {
            const name = String(event.name).replace(/^\//u, "");
            unknownNamespaced.set(name, (unknownNamespaced.get(name) || 0) + 1);
          }
          continue;
        }
        const ids = new Set();
        let ambiguous = false;
        for (const rawPath of event.paths) {
          const attributed = attributeSkillMdPath(catalog, rawPath, { cwd: event.cwd, homeDir, isBuzzAssistRoot });
          if (attributed?.skillId) ids.add(attributed.skillId);
          else if (attributed?.ambiguous) ambiguous = true;
        }
        if (ambiguous && ids.size === 0) unattributed[host].ambiguousSkillMdReads += 1;
        for (const skillId of ids) touch(skillId, host, "skill-md-read", sessionId, timeMs);
      }
      pending.clear();
      const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());
      const skills = catalog.skills.map((skill) => {
        const row = rows.get(skill.id);
        const hosts = {};
        let lastUsedMs = null;
        let sessions = 0;
        for (const host of SKILL_USAGE_HOSTS) {
          const value = row[host];
          hosts[host] = {
            sessions: value.sessions.size,
            skillToolCalls: value.skillToolCalls,
            slashCommands: value.slashCommands,
            skillMdReads: value.skillMdReads,
            lastUsedAt: iso(value.lastUsedMs),
          };
          sessions += value.sessions.size;
          if (value.lastUsedMs !== null && (lastUsedMs === null || value.lastUsedMs > lastUsedMs)) lastUsedMs = value.lastUsedMs;
        }
        return {
          id: skill.id,
          name: skill.name,
          version: skill.version,
          listedInManifest: skill.listedInManifest,
          sessions,
          lastUsedAt: iso(lastUsedMs),
          usedInWindow: sessions > 0,
          hosts,
        };
      });
      skills.sort((a, b) => b.sessions - a.sessions || a.id.localeCompare(b.id));
      return {
        skills,
        unattributed: {
          ...unattributed,
          unknownNamespacedSkillNames: [...unknownNamespaced.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([name, count]) => ({ name, count })),
        },
        unparsableLines: unparsable,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// ファイルの一覧と、行の絞り込み

/** 会話の記録の置き場。CLAUDE_CONFIG_DIR・CODEX_HOME があればそれを使う。 */
export function defaultTranscriptRoots({ env = process.env, homeDir = homedir() } = {}) {
  const claudeHome = String(env?.CLAUDE_CONFIG_DIR || "").trim() || path.join(homeDir, ".claude");
  const codexHome = String(env?.CODEX_HOME || "").trim() || path.join(homeDir, ".codex");
  return {
    claude: [path.join(claudeHome, "projects")],
    codex: [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")],
  };
}

function listTranscriptFiles(roots, { sinceMs }) {
  const files = [];
  let olderFiles = 0;
  let unreadableDirs = 0;
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        unreadableDirs += 1;
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        // symlink はたどらない（輪になる・記録の外へ出るのを避ける）
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        // 最後に書かれたのが期間の始まりより前なら、その中の出来事も全部期間の外。
        if (stat.mtimeMs < sinceMs) {
          olderFiles += 1;
          continue;
        }
        files.push({ file: full, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
  return { files, olderFiles, unreadableDirs };
}

/** rg が使えるか（使えなければ Node の逐次読みで同じことをする）。 */
export function detectRipgrep(command = "rg") {
  try {
    const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    return result.status === 0 && /ripgrep/iu.test(String(result.stdout || "")) ? command : null;
  } catch {
    return null;
  }
}

function resolveScanner(requested, env) {
  const wanted = String(requested || env?.[SKILL_USAGE_SCANNER_ENV] || "auto").trim() || "auto";
  if (!["auto", "ripgrep", "node"].includes(wanted)) throw new Error(`scanner は auto / ripgrep / node: ${wanted}`);
  if (wanted === "node") return { scanner: "node", rgCommand: null };
  const rgCommand = detectRipgrep();
  if (rgCommand) return { scanner: "ripgrep", rgCommand };
  if (wanted === "ripgrep") throw new Error("rg（ripgrep）が見つからない。--scanner node で Node の逐次読みを使える");
  return { scanner: "node", rgCommand: null };
}

// rg の版で文言が違う（"[Omitted long line with N matches]" / "[Omitted long matching line]"）。
// 会話の記録の行は必ず "{" で始まるので、これで取り違えない。
const OMITTED_LONG_LINE = /^\[Omitted long/u;

function runRipgrepBatch({ rgCommand, patterns, files, maxLineBytes, timeoutMs, onLine }) {
  return new Promise((resolve) => {
    const args = [
      "--no-config", "--text", "--null", "--no-heading", "--with-filename", "--no-line-number",
      "--color", "never", "--max-columns", String(maxLineBytes),
      ...patterns.flatMap((pattern) => ["-e", pattern]),
      "--", ...files.map((entry) => entry.file),
    ];
    const byPath = new Map(files.map((entry) => [entry.file, entry]));
    const child = spawn(rgCommand, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let pendingParts = [];
    let pendingLength = 0;
    let stderr = "";
    let timedOut = false;
    let longLines = 0;
    const handle = (buffer) => {
      if (buffer.length === 0) return;
      // 行は「パス NUL 本文」。バイトのまま切ってから文字にする（長い行を何度も連結し直さない）。
      const split = buffer.indexOf(0);
      if (split < 0) return;
      const file = buffer.subarray(0, split).toString("utf8");
      let content = buffer.subarray(split + 1).toString("utf8");
      if (content.endsWith("\r")) content = content.slice(0, -1);
      if (OMITTED_LONG_LINE.test(content)) {
        longLines += 1;
        return;
      }
      onLine(byPath.get(file) || { file, mtimeMs: Date.now() }, content);
    };
    child.stdout.on("data", (chunk) => {
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf(10, start);
        if (newline === -1) {
          if (start < chunk.length) {
            pendingParts.push(chunk.subarray(start));
            pendingLength += chunk.length - start;
          }
          break;
        }
        const piece = chunk.subarray(start, newline);
        const line = pendingLength === 0 ? piece : Buffer.concat([...pendingParts, piece], pendingLength + piece.length);
        pendingParts = [];
        pendingLength = 0;
        handle(line);
        start = newline + 1;
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, Math.max(0, timeoutMs));
    const finish = (code, error = null) => {
      clearTimeout(timer);
      if (!timedOut && pendingLength > 0) handle(Buffer.concat(pendingParts, pendingLength));
      const errorLines = stderr.split(/\r?\n/u).filter(Boolean).length;
      resolve({ timedOut, longLines, code, errorLines, spawnError: error ? String(error.message || error) : "" });
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  });
}

async function scanFileWithNode({ entry, needles, regexes, longLineHead, maxLineBytes, deadlineMs, onLine }) {
  const needleBuffers = needles.map((needle) => Buffer.from(needle, "utf8"));
  const hasNeedle = (buffer) => needleBuffers.some((needle) => buffer.includes(needle));
  let parts = [];
  let partsLength = 0;
  let overflow = false;
  let overflowHadNeedle = false;
  let overflowHead = "";
  let longLines = 0;
  const completeLine = () => {
    if (overflow) {
      // rg は正規表現に当たった長い行だけを「飛ばした」と言う。こちらは本文を持たないので、
      // 目印の語があり、行の頭が道具の呼び出しの形のものだけを飛ばしたと数える。
      if (overflowHadNeedle && longLineHead.test(overflowHead)) longLines += 1;
    } else if (partsLength > 0) {
      const line = parts.length === 1 ? parts[0] : Buffer.concat(parts, partsLength);
      if (hasNeedle(line)) {
        let text = line.toString("utf8");
        if (text.endsWith("\r")) text = text.slice(0, -1);
        if (regexes.some((regex) => regex.test(text))) onLine(entry, text);
      }
    }
    parts = [];
    partsLength = 0;
    overflow = false;
    overflowHadNeedle = false;
    overflowHead = "";
  };
  const stream = fs.createReadStream(entry.file, { highWaterMark: 1024 * 1024 });
  try {
    for await (const chunk of stream) {
      if (Date.now() >= deadlineMs) {
        stream.destroy();
        return { timedOut: true, longLines, unreadable: false };
      }
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf(10, start);
        const piece = newline === -1 ? chunk.subarray(start) : chunk.subarray(start, newline);
        if (!overflow) {
          if (partsLength + piece.length > maxLineBytes) {
            overflow = true;
            overflowHadNeedle = parts.some(hasNeedle) || hasNeedle(piece);
            overflowHead = Buffer.concat([...parts, piece]).subarray(0, LONG_LINE_HEAD_BYTES).toString("utf8");
            parts = [];
            partsLength = 0;
          } else if (piece.length > 0) {
            parts.push(piece);
            partsLength += piece.length;
          }
        } else if (!overflowHadNeedle && hasNeedle(piece)) {
          overflowHadNeedle = true;
        }
        if (newline === -1) break;
        completeLine();
        start = newline + 1;
      }
    }
    completeLine();
    return { timedOut: false, longLines, unreadable: false };
  } catch {
    stream.destroy();
    return { timedOut: false, longLines, unreadable: true };
  }
}

async function scanHost({ host, roots, window, maxBytes, maxSeconds, maxLineBytes, scannerChoice, aggregator, clock }) {
  const spec = HOST_SPECS[host];
  const regexes = spec.patterns.map((pattern) => new RegExp(pattern, "u"));
  const startedMs = clock();
  const deadlineMs = startedMs + Math.max(0, Number(maxSeconds)) * 1000;
  const listing = listTranscriptFiles(roots, { sinceMs: window.sinceMs });
  const coverage = {
    host,
    label: spec.label,
    scanner: scannerChoice.scanner,
    roots: roots.filter((root) => root && fs.existsSync(root)).length,
    filesInWindow: listing.files.length,
    bytesInWindow: listing.files.reduce((sum, entry) => sum + entry.size, 0),
    filesOlderThanWindow: listing.olderFiles,
    filesScanned: 0,
    bytesScanned: 0,
    filesSkippedForBytes: 0,
    filesSkippedForTime: 0,
    filesInterrupted: 0,
    longLinesSkipped: 0,
    unreadableFiles: 0,
    unreadableDirs: listing.unreadableDirs,
    limits: { maxBytes, maxSeconds, maxLineBytes },
    complete: true,
    reasons: [],
    fullyCountedSince: null,
  };
  // 新しい順に、読む量の上限まで。上限を超えた先は読まない（数えた範囲が時間で途切れないように連続で切る）。
  const selected = [];
  let budget = 0;
  for (let index = 0; index < listing.files.length; index += 1) {
    const entry = listing.files[index];
    if (budget + entry.size > maxBytes) {
      coverage.filesSkippedForBytes = listing.files.length - index;
      break;
    }
    budget += entry.size;
    selected.push(entry);
  }
  let newestNotCounted = null;
  const notCounted = (entry) => {
    if (newestNotCounted === null || entry.mtimeMs > newestNotCounted) newestNotCounted = entry.mtimeMs;
  };
  listing.files.slice(selected.length).forEach(notCounted);
  const onLine = (entry, text) => aggregator.addLine(host, entry.file, entry.mtimeMs, text);

  if (scannerChoice.scanner === "ripgrep") {
    let index = 0;
    while (index < selected.length) {
      const batch = [];
      let batchBytes = 0;
      let batchChars = 0;
      while (index < selected.length && batch.length < RG_BATCH_MAX_FILES
        && (batch.length === 0 || (batchBytes + selected[index].size <= RG_BATCH_MAX_BYTES
          && batchChars + selected[index].file.length + 1 <= RG_BATCH_MAX_ARG_CHARS))) {
        batch.push(selected[index]);
        batchBytes += selected[index].size;
        batchChars += selected[index].file.length + 1;
        index += 1;
      }
      const remainingMs = deadlineMs - clock();
      if (remainingMs <= 0) {
        const rest = [...batch, ...selected.slice(index)];
        coverage.filesSkippedForTime += rest.length;
        rest.forEach(notCounted);
        break;
      }
      const result = await runRipgrepBatch({
        rgCommand: scannerChoice.rgCommand,
        patterns: spec.patterns,
        files: batch,
        maxLineBytes,
        timeoutMs: remainingMs,
        onLine,
      });
      coverage.longLinesSkipped += result.longLines;
      if (result.spawnError) throw new Error(`rg を起動できない: ${result.spawnError}`);
      if (result.timedOut) {
        // 途中で止めた束の中身は一部しか数えていない（数えた分は下限として残す）。
        coverage.filesInterrupted += batch.length;
        batch.forEach(notCounted);
        const rest = selected.slice(index);
        coverage.filesSkippedForTime += rest.length;
        rest.forEach(notCounted);
        break;
      }
      if (result.code === 2 && result.errorLines > 0) coverage.unreadableFiles += result.errorLines;
      coverage.filesScanned += batch.length;
      coverage.bytesScanned += batchBytes;
    }
  } else {
    for (let index = 0; index < selected.length; index += 1) {
      const entry = selected[index];
      if (clock() >= deadlineMs) {
        const rest = selected.slice(index);
        coverage.filesSkippedForTime += rest.length;
        rest.forEach(notCounted);
        break;
      }
      const result = await scanFileWithNode({
        entry,
        needles: spec.needles,
        regexes,
        longLineHead: spec.longLineHead,
        maxLineBytes,
        deadlineMs,
        onLine,
      });
      coverage.longLinesSkipped += result.longLines;
      if (result.unreadable) {
        coverage.unreadableFiles += 1;
        notCounted(entry);
        continue;
      }
      if (result.timedOut) {
        coverage.filesInterrupted += 1;
        notCounted(entry);
        const rest = selected.slice(index + 1);
        coverage.filesSkippedForTime += rest.length;
        rest.forEach(notCounted);
        break;
      }
      coverage.filesScanned += 1;
      coverage.bytesScanned += entry.size;
    }
  }

  if (coverage.filesSkippedForBytes > 0) coverage.reasons.push("bytes");
  if (coverage.filesSkippedForTime > 0 || coverage.filesInterrupted > 0) coverage.reasons.push("time");
  if (coverage.longLinesSkipped > 0) coverage.reasons.push("long-line");
  if (coverage.unreadableFiles > 0 || coverage.unreadableDirs > 0) coverage.reasons.push("unreadable");
  coverage.complete = coverage.reasons.length === 0;
  if (!coverage.complete && newestNotCounted !== null) coverage.fullyCountedSince = new Date(newestNotCounted).toISOString();
  coverage.elapsedMs = Math.max(0, clock() - startedMs);
  return coverage;
}

// ---------------------------------------------------------------------------
// 棚卸しの記録（手元。リポジトリの外）

export function skillReviewLogPath({ env = process.env, homeDir = homedir() } = {}) {
  return path.join(operatorLearningStateDir({ env, homeDir }), SKILL_REVIEW_LOG_FILE);
}

/** 記録を読む。壊れた行は飛ばす。無ければ空。 */
export function readSkillReviews({ env = process.env, homeDir = homedir(), logPath = "" } = {}) {
  const file = logPath || skillReviewLogPath({ env, homeDir });
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.version === SKILL_REVIEW_RECORD_VERSION && Number.isFinite(Date.parse(record.reviewedAt))) out.push(record);
    } catch {
      // 壊れた行は数えない
    }
  }
  return out;
}

export function lastSkillReview(options = {}) {
  const reviews = readSkillReviews(options);
  if (reviews.length === 0) return null;
  return reviews.reduce((latest, record) => (Date.parse(record.reviewedAt) > Date.parse(latest.reviewedAt) ? record : latest));
}

function daysBetween(fromMs, toMs) {
  return Math.floor((toMs - fromMs) / DAY_MS);
}

/**
 * 棚卸しをした日を残す。残すのは日時・在庫の版・スキルの id と版・任意のメモ・判定シートの sha256 だけ
 * （シートや会話の本文は残さない）。
 */
export function recordSkillReview({ catalog, env = process.env, homeDir = homedir(), now = new Date(), note = "", sheetPath = "" } = {}) {
  if (!catalog) throw new Error("recordSkillReview には catalog が要る。");
  let sheetSha256 = null;
  if (sheetPath) {
    let bytes;
    try {
      bytes = fs.readFileSync(sheetPath);
    } catch (error) {
      throw new Error(`判定シートを読めない: ${sheetPath}: ${error.message}`);
    }
    sheetSha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  }
  const record = {
    version: SKILL_REVIEW_RECORD_VERSION,
    reviewedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    manifestVersion: catalog.manifestVersion,
    skills: catalog.skills.map((skill) => ({ id: skill.id, version: skill.version })),
    ...(String(note || "").trim() ? { note: String(note).trim().slice(0, 500) } : {}),
    ...(sheetSha256 ? { sheetSha256 } : {}),
  };
  const file = skillReviewLogPath({ env, homeDir });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  return { path: file, record };
}

/**
 * doctor の項目（skill-usage-review）。記録が無ければ null（何も言わない）。
 * 止めない（required: false）。前の棚卸しから intervalDays 日以上なら ok: false で知らせる。
 */
export function skillReviewAgeCheck({ env = process.env, homeDir = homedir(), now = new Date(), intervalDays = SKILL_REVIEW_INTERVAL_DAYS } = {}) {
  const last = lastSkillReview({ env, homeDir });
  if (!last) return null;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const lastMs = Date.parse(last.reviewedAt);
  const days = Math.max(0, daysBetween(lastMs, nowMs));
  const ok = days < intervalDays;
  const lastDate = formatLocalDate(lastMs);
  return {
    id: "skill-usage-review",
    required: false,
    ok,
    lastReviewedAt: last.reviewedAt,
    daysSinceReview: days,
    intervalDays,
    detail: ok
      ? `前のスキルの棚卸しは ${lastDate}（${days}日前）。次の目安は ${formatLocalDate(lastMs + intervalDays * DAY_MS)}`
      : `前のスキルの棚卸しから ${days} 日たった（${lastDate}）。目安は ${intervalDays} 日ごと`,
    fix: ok ? "" : "node scripts/skill-usage.mjs report で期間内の使われ方を数え、review-sheet で作った判定シートを"
      + "この会話とは別の文脈の LLM に渡して要不要を判定させる。終えたら node scripts/skill-usage.mjs record-review で日付を残す",
  };
}

// ---------------------------------------------------------------------------
// 入口

export async function buildSkillUsageReport({
  repoRoot,
  hosts = SKILL_USAGE_HOSTS,
  window,
  env = process.env,
  homeDir = homedir(),
  roots = null,
  maxBytes = DEFAULT_MAX_BYTES_PER_HOST,
  maxSeconds = DEFAULT_MAX_SECONDS_PER_HOST,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  scanner = "",
  now = new Date(),
  clock = Date.now,
} = {}) {
  const catalog = loadSkillUsageCatalog({ repoRoot });
  const resolvedWindow = window || resolveUsageWindow({ now });
  const wantedHosts = [...new Set(hosts)].filter((host) => SKILL_USAGE_HOSTS.includes(host));
  if (wantedHosts.length === 0) throw new Error(`ホストは ${SKILL_USAGE_HOSTS.join(" / ")}`);
  const transcriptRoots = roots || defaultTranscriptRoots({ env, homeDir });
  const scannerChoice = resolveScanner(scanner, env);
  const aggregator = createAggregator(catalog, { window: resolvedWindow, homeDir });
  const coverage = {};
  for (const host of wantedHosts) {
    coverage[host] = await scanHost({
      host,
      roots: transcriptRoots[host] || [],
      window: resolvedWindow,
      maxBytes: Number(maxBytes),
      maxSeconds: Number(maxSeconds),
      maxLineBytes: Number(maxLineBytes),
      scannerChoice,
      aggregator,
      clock,
    });
  }
  const aggregated = aggregator.finish();
  const last = lastSkillReview({ env, homeDir });
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  return {
    version: SKILL_USAGE_REPORT_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    manifestVersion: catalog.manifestVersion,
    window: { since: resolvedWindow.since, until: resolvedWindow.until, days: resolvedWindow.days },
    hosts: wantedHosts,
    complete: wantedHosts.every((host) => coverage[host].complete),
    coverage,
    lastReview: last ? { reviewedAt: last.reviewedAt, daysSince: Math.max(0, daysBetween(Date.parse(last.reviewedAt), nowMs)) } : null,
    skills: aggregated.skills,
    unusedInWindow: aggregated.skills.filter((skill) => !skill.usedInWindow).map((skill) => skill.id),
    unattributed: aggregated.unattributed,
    unparsableLines: aggregated.unparsableLines,
    definitions: {
      sessions: "そのスキルを使った会話の数（Claude Code は会話 ID、Codex は記録のファイル。子エージェントの会話も1つと数える）",
      skillToolCalls: "Claude Code の Skill の道具で呼んだ回数",
      slashCommands: "Claude Code で人が /コマンドとして呼んだ回数",
      skillMdReads: "道具の呼び出しで SKILL.md を読んだ回数（Claude Code は Read・Bash・Grep、Codex はコマンドの実行。書き換えは数えない）",
      incomplete: "complete が false のときは数え切れていない。数は下限で、fullyCountedSince より後の使用だけは数え切れている",
    },
  };
}

// ---------------------------------------------------------------------------
// 人に見せる形

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}MiB`;
  return `${Math.round(bytes / 1024)}KiB`;
}

const REASON_LABELS = {
  bytes: "読む量の上限",
  time: "時間の上限",
  "long-line": "長すぎる行を飛ばした",
  unreadable: "読めないファイル・フォルダーがある",
};

export function describeCoverage(coverage) {
  const read = `新しい順に ${coverage.filesScanned}/${coverage.filesInWindow} ファイル、${formatBytes(coverage.bytesScanned)}/${formatBytes(coverage.bytesInWindow)} を読んだ`;
  if (coverage.complete) return `${coverage.label}: 数え切れた（${read}、${coverage.scanner}）`;
  const reasons = coverage.reasons.map((reason) => REASON_LABELS[reason] || reason).join("・");
  const since = coverage.fullyCountedSince ? `。${formatLocalDate(coverage.fullyCountedSince)} より後の使用だけは数え切れている` : "";
  return `${coverage.label}: 数え切れていない（${reasons}。${read}${since}）。数は下限`;
}

export function renderSkillUsageReport(report) {
  const lines = [];
  lines.push(`BuzzAssist スキルの使われ方（${formatLocalDate(report.window.since)} 〜 ${formatLocalDate(report.window.until)}、${report.window.days}日）`);
  lines.push(report.lastReview
    ? `前の棚卸し: ${formatLocalDate(report.lastReview.reviewedAt)}（${report.lastReview.daysSince}日前）`
    : "前の棚卸し: 記録なし（終えたら record-review で残す）");
  lines.push("");
  const header = ["スキル", "会話", ...report.hosts.map((host) => (host === "claude" ? "Claude Code" : "Codex")), "最後に使った日"];
  const rows = report.skills.map((skill) => [
    `${skill.id}${skill.listedInManifest ? "" : "（在庫に無い）"}`,
    String(skill.sessions),
    ...report.hosts.map((host) => {
      const row = skill.hosts[host];
      if (host === "claude") return `${row.sessions}（道具${row.skillToolCalls}・/${row.slashCommands}・読${row.skillMdReads}）`;
      return `${row.sessions}（読${row.skillMdReads}）`;
    }),
    skill.lastUsedAt ? formatLocalDate(skill.lastUsedAt) : "-",
  ]);
  const width = (text) => [...String(text)].reduce((sum, char) => sum + (char.charCodeAt(0) > 0xff ? 2 : 1), 0);
  const widths = header.map((_, column) => Math.max(width(header[column]), ...rows.map((row) => width(row[column]))));
  const pad = (text, column) => `${text}${" ".repeat(Math.max(0, widths[column] - width(text)))}`;
  lines.push(`  ${header.map(pad).join("  ")}`);
  for (const row of rows) lines.push(`  ${row.map(pad).join("  ")}`);
  lines.push("");
  lines.push("  会話＝使った会話の数。道具＝Skill の道具、/＝人の /コマンド、読＝SKILL.md を読んだ回数");
  lines.push("");
  if (report.unusedInWindow.length > 0) lines.push(`期間内に使われていない: ${report.unusedInWindow.join(", ")}`);
  const ambiguous = report.hosts.reduce((sum, host) => sum + (report.unattributed[host]?.ambiguousSkillMdReads || 0), 0);
  if (ambiguous > 0) lines.push(`名前が端末全体のスキルとぶつかり、BuzzAssist のものか確かめられなかった SKILL.md の読み込み: ${ambiguous}（数に入れていない）`);
  if (report.unattributed.unknownNamespacedSkillNames.length > 0) {
    lines.push(`在庫に無い名前（BuzzAssist の名前空間）で呼ばれたもの: ${report.unattributed.unknownNamespacedSkillNames.map((entry) => `${entry.name}×${entry.count}`).join(", ")}`);
  }
  for (const host of report.hosts) lines.push(describeCoverage(report.coverage[host]));
  if (!report.complete) lines.push("数え切れていない。上限は --max-gib・--max-seconds で広げられる（期間を --days で狭めてもよい）");
  lines.push("");
  lines.push("要不要の判定は node scripts/skill-usage.mjs review-sheet で判定シートを作り、別の文脈の LLM に渡す。");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 要不要の判定（LLM-as-judge）を頼むためのシート。外部モデルは呼ばない。

const REVIEW_VERDICTS = Object.freeze([
  { verdict: "keep", label: "残す" },
  { verdict: "merge", label: "他のスキルへ統合する（mergeInto に統合先の id）" },
  { verdict: "retire", label: "外す" },
  { verdict: "rewrite", label: "残すが書き直す（description か本文。どこをかを reason に）" },
]);

const REVIEW_QUESTIONS = Object.freeze([
  "このハーネス（BuzzAssist の動画制作と、その保守）の中で、このスキルが無いと誰がどの場面で困るか。制作中に要るものか、スキルの保守・改善のときだけ要るものか",
  "ホストの公式機能（Claude Code・Codex の組み込みの道具や公式のスキル）や、一覧の他のスキルと役割が重なっていないか。重なっているなら、どちらを残すか",
  "回数は材料の1つで、回数だけで外さない。リリースのときだけ使うもの、CLAUDE.md・AGENTS.md から直接読まれるもの、ハーネスの宣言が束ねているものは、少なくても要ることがある。逆に回数が多くても、description が広すぎて関係の無い場面で呼ばれているなら書き直しの候補",
  "description が、呼ばれるべき場面と呼ばれるべきでない場面を言い当てているか",
]);

function classificationLabel(skill) {
  if (!skill.listedInManifest) return "在庫に載っていない";
  const classification = skill.classification || {};
  if (classification.developmentOnly) return "開発専用（本番の制作には出さない）";
  if (classification.productionAllowed) return "本番の制作で使える";
  return "区分なし";
}

function profileLabel(entry) {
  return `${entry.profile}（${entry.placement === "always" ? "常に許可" : "ハーネスの宣言があれば許可"}）`;
}

function usageLabel(usage, hosts) {
  if (!usage) return "数えていない";
  const parts = hosts.map((host) => {
    const row = usage.hosts[host];
    if (host === "claude") {
      return `Claude Code ${row.sessions} 会話（Skill の道具 ${row.skillToolCalls}・/コマンド ${row.slashCommands}・SKILL.md を読んだ ${row.skillMdReads}）`;
    }
    return `Codex ${row.sessions} 会話（SKILL.md を読んだ ${row.skillMdReads}）`;
  });
  return `${parts.join("、")}。最後に使った日 ${usage.lastUsedAt ? formatLocalDate(usage.lastUsedAt) : "期間内なし"}`;
}

/** 判定シートを作る。返り値の markdown を別の文脈の LLM に渡す。json は機械で扱うとき用。 */
export function buildSkillReviewSheet({ report, catalog }) {
  if (!report || !catalog) throw new Error("buildSkillReviewSheet には report と catalog が要る。");
  const usageById = new Map(report.skills.map((skill) => [skill.id, skill]));
  const items = catalog.skills.map((skill) => {
    const usage = usageById.get(skill.id) || null;
    return {
      id: skill.id,
      name: skill.name,
      version: skill.version,
      listedInManifest: skill.listedInManifest,
      classification: classificationLabel(skill),
      harnesses: skill.harnesses,
      profiles: skill.profiles.map(profileLabel),
      description: skill.description,
      usage: usage
        ? { sessions: usage.sessions, lastUsedAt: usage.lastUsedAt, hosts: usage.hosts }
        : null,
    };
  });
  const coverageLines = report.hosts.map((host) => describeCoverage(report.coverage[host]));
  const answerShape = '{"id": "<スキルの id>", "verdict": "keep | merge | retire | rewrite", "mergeInto": "<統合先の id か null>", "reason": "<1〜3文>"}';
  const md = [];
  md.push("# BuzzAssist スキルの棚卸し — 要不要の判定シート");
  md.push("");
  md.push("このシートは、スキルの要不要を LLM に判定させるための材料。作った側は外部モデルを呼んでいない。");
  md.push("判定は、このシートを作った会話とは別の新しい文脈で行う（集計した側の結論に寄せないため）。");
  md.push("");
  md.push("## 集計の範囲");
  md.push("");
  md.push(`- 期間: ${formatLocalDate(report.window.since)} 〜 ${formatLocalDate(report.window.until)}（${report.window.days}日）`);
  for (const line of coverageLines) md.push(`- ${line}`);
  md.push(`- 前の棚卸し: ${report.lastReview ? `${formatLocalDate(report.lastReview.reviewedAt)}（${report.lastReview.daysSince}日前）` : "記録なし"}`);
  md.push("- 会話＝そのスキルを使った会話の数。数えたのは Skill の道具の呼び出し・/コマンド・SKILL.md を読んだ道具の呼び出しで、スキルの一覧に名前が出ただけのものは数えていない");
  md.push("");
  md.push("## 判定のしかた");
  md.push("");
  md.push("スキルごとに、次のどれか1つを付ける。");
  md.push("");
  for (const entry of REVIEW_VERDICTS) md.push(`- \`${entry.verdict}\`: ${entry.label}`);
  md.push("");
  md.push("観点:");
  md.push("");
  REVIEW_QUESTIONS.forEach((question, index) => md.push(`${index + 1}. ${question}`));
  md.push("");
  md.push("答えは1スキル1行の JSON で返す:");
  md.push("");
  md.push("```json");
  md.push(answerShape);
  md.push("```");
  md.push("");
  md.push("判定は提案で、外す・統合するかは人が決める（正本スキルの変更は skill-creator の手順で行う）。");
  md.push("");
  md.push("## スキル一覧");
  for (const item of items) {
    md.push("");
    md.push(`### ${item.id}${item.version ? `（${item.version}）` : ""}`);
    md.push("");
    md.push(`- 区分: ${item.classification}`);
    md.push(`- 束ねるハーネス: ${item.harnesses.length > 0 ? item.harnesses.join(", ") : "なし"}`);
    md.push(`- 実行 Profile: ${item.profiles.length > 0 ? item.profiles.join("、") : "なし"}`);
    md.push(`- 使われ方: ${usageLabel(usageById.get(item.id), report.hosts)}`);
    md.push(`- description: ${item.description || "（読めない）"}`);
  }
  md.push("");
  return {
    version: SKILL_REVIEW_SHEET_VERSION,
    markdown: md.join("\n"),
    json: {
      version: SKILL_REVIEW_SHEET_VERSION,
      window: report.window,
      complete: report.complete,
      coverage: coverageLines,
      lastReview: report.lastReview,
      verdicts: REVIEW_VERDICTS,
      questions: REVIEW_QUESTIONS,
      answerShape,
      skills: items,
    },
  };
}
