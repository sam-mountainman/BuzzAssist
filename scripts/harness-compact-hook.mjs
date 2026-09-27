#!/usr/bin/env node
// 会話の圧縮（compaction）のあとに、作業中の正本スキルを読み直すよう短く促す SessionStart フック
// （Claude Code / Codex 共通。source が compact のときだけ）。
//
// 圧縮のあとで文脈へ戻るのは、各スキルの先頭の一部（およそ 5,000 トークン）だけで、合計にも上限がある。
// 新しく使ったものから戻すので、会話の前半で読んだスキルは丸ごと落ちることがある。正本スキルは
// 「最後まで読む」前提で書いてあり、後半の禁則や手順が落ちたまま作業が続くと、覚えていない決まりを
// 破る。読み直しをエージェントの記憶に任せず、圧縮の直後に1段落で伝える。
//
// どのスキルを挙げるか:
//
//   1. この会話の記録（transcript_path）に、正本スキル（.agents/skills/<id>/SKILL.md、Skill ツールの
//      呼び出し）と、地図（CLAUDE.md / AGENTS.md）が指す docs の読み込みが出てくれば、それを挙げる
//   2. 記録が読めない・何も出てこないときは、プロジェクトの地図（CLAUDE.md / AGENTS.md）が BuzzAssist の
//      正本スキルを指しているときだけ、「地図のうち今の作業に当たるもの」を読み直すよう促す
//   3. どちらでもない（BuzzAssist と関係の無いプロジェクト）なら、何も出さない
//
// 何も書き換えない。記録は読むだけで、中身はどこにも保存しない。落ちても・遅くても何も出さずに終わる。
// 読み込むのは Node の組み込みと、組み込みだけを使う lib/cliEntrypoint.mjs（依存の無いプラグインの置き場からも起動するため）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectCli } from "../lib/cliEntrypoint.mjs";

// 圧縮は会話に数回しか起きないので、記録を読む時間を少し長めに認める（混んだ端末で 1〜3 秒の実測）。
// 間に合わなければ何も出さずに終わる（会話は止めない）。
const HARD_TIMEOUT_MS = 8000;
const MAX_INPUT_BYTES = 1024 * 1024;
/**
 * 記録を読む上限。長い会話でも、先頭（前半に読んだスキル）と末尾の両方を見る。
 * 数十 MB の記録を全部なめると混んだ端末で数秒かかった（実測 80MB 台で 2 秒強）ので、合計 32MB までにする。
 */
const TRANSCRIPT_HEAD_BYTES = 8 * 1024 * 1024;
const TRANSCRIPT_TAIL_BYTES = 24 * 1024 * 1024;
const MAX_LISTED = 8;
const MAX_TRANSCRIPT_LINES = 5000;
const ARGUMENT_KEYS = new Set(["file_path", "notebook_path", "path", "command", "cmd"]);
const MAX_WALK_UP = 8;
const MAP_FILES = Object.freeze(["CLAUDE.md", "AGENTS.md"]);

const HOOK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 正本スキルの id の一覧（<root>/.agents/skills/<id>/SKILL.md があるもの）。 */
export function canonicalSkillIds(roots) {
  const ids = new Set();
  for (const root of roots) {
    if (!root) continue;
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, ".agents", "skills"), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory() && fs.existsSync(path.join(root, ".agents", "skills", entry.name, "SKILL.md"))) ids.add(entry.name);
    }
  }
  return ids;
}

/** 地図（CLAUDE.md / AGENTS.md）の本文から、正本スキルの id と docs の道を、出てくる順に取り出す。 */
export function readMapReferences(mapText) {
  const text = String(mapText || "");
  const skills = [];
  const docs = [];
  for (const match of text.matchAll(/\.agents\/skills\/([a-z0-9][a-z0-9-]*)\/SKILL\.md/gu)) {
    if (!skills.includes(match[1])) skills.push(match[1]);
  }
  for (const match of text.matchAll(/`(docs\/[A-Za-z0-9._/-]+\.md)`/gu)) {
    if (!docs.includes(match[1])) docs.push(match[1]);
  }
  return { skills, docs };
}

/** cwd から上へたどり、地図が BuzzAssist の正本スキルを指しているプロジェクトの根を探す。 */
export function findProjectMap(cwd) {
  let dir = cwd ? path.resolve(String(cwd)) : "";
  for (let level = 0; dir && level < MAX_WALK_UP; level += 1) {
    for (const name of MAP_FILES) {
      let text = "";
      try { text = fs.readFileSync(path.join(dir, name), "utf8"); } catch { continue; }
      const references = readMapReferences(text);
      if (references.skills.length > 0) return { root: dir, file: name, ...references };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readTranscript(file) {
  if (typeof file !== "string" || !file) return Buffer.alloc(0);
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const readRange = (start, length) => {
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(fd, buffer, 0, length, start);
      return buffer.subarray(0, read);
    };
    if (size <= TRANSCRIPT_HEAD_BYTES + TRANSCRIPT_TAIL_BYTES) return readRange(0, size);
    return Buffer.concat([readRange(0, TRANSCRIPT_HEAD_BYTES), Buffer.from("\n"), readRange(size - TRANSCRIPT_TAIL_BYTES, TRANSCRIPT_TAIL_BYTES)]);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 読めなければ記録なしとして扱う */ } }
  }
}

/** その根が BuzzAssist の正本を持つか（共通の正本 platform-craft があるか）。端末全体のスキル置き場と見分ける。 */
function isBuzzAssistRoot(root, cache) {
  if (cache.has(root)) return cache.get(root);
  const found = fs.existsSync(path.join(root, ".agents", "skills", "platform-craft", "SKILL.md"));
  cache.set(root, found);
  return found;
}

/**
 * 記録の本文から、使った正本スキルの id と、地図が指す docs を取り出す（出てきた順）。
 *
 * 記録には地図（CLAUDE.md）の本文そのものも入るので、道が文中に出てくるだけでは数えない。
 * 記録の行（JSON）を読み、道具の呼び出しの引数に出てきたものだけを数える:
 *   - ファイルの道の引数（file_path / notebook_path / path。Read・Edit など）
 *   - シェルのコマンドの引数（command / cmd。cat・sed・rg などで読んだもの）
 *   - Skill ツールの呼び出し（skill）
 * Codex の記録は引数が JSON の文字列（arguments）の中にあるので、それもほどいて見る。
 * 長い会話の記録（数十 MB）でも速く終わるよう、候補の語を含む行だけを取り出して読む。
 *
 * さらに BuzzAssist の正本だけに絞る。同じ名前のスキル（skill-creator など）が端末全体の置き場や
 * 別のプラグインにもあるので:
 *   - 絶対の道は、BuzzAssist の根（.agents/skills/platform-craft がある根）の下のものだけ
 *   - 相対の道と、名前空間の無い Skill の呼び出しは、このプロジェクトが BuzzAssist の地図を持つときだけ
 *   - Skill の名前空間は buzzassist: だけ
 */
export function usedReferences(transcript, { knownSkills, mapDocs = [], projectRoot = "" }) {
  const buffer = Buffer.isBuffer(transcript) ? transcript : Buffer.from(String(transcript || ""), "utf8");
  const skills = [];
  const docs = [];
  const rootCache = new Map();
  const add = (id) => {
    if (knownSkills.has(id) && !skills.includes(id)) skills.push(id);
  };
  const considerSkillName = (value) => {
    const match = String(value).match(/^(?:([a-z0-9-]+):)?([a-z0-9][a-z0-9-]*)$/u);
    if (match && (match[1] === "buzzassist" || (!match[1] && projectRoot))) add(match[2]);
  };
  const considerArgument = (value) => {
    if (value.includes("SKILL.md")) {
      const pathPattern = /(?:\.agents|\.claude)[\\/]+skills[\\/]+([a-z0-9][a-z0-9-]*)[\\/]+SKILL\.md/gu;
      for (const match of value.matchAll(pathPattern)) {
        // 道の前半（根）は、後ろから道の文字が続く範囲だけを見る（前から探すと長い引数で遅くなる）。
        let start = match.index;
        while (start > 0 && match.index - start < 1024 && /[A-Za-z0-9_.~\\/:-]/u.test(value[start - 1])) start -= 1;
        const prefix = value.slice(start, match.index).replace(/\\\\/gu, "\\").replace(/[\\/]+$/u, "");
        const absolute = prefix.startsWith("/") || /^[A-Za-z]:/u.test(prefix);
        if (absolute ? isBuzzAssistRoot(path.resolve(prefix.replaceAll("\\", "/")), rootCache) : Boolean(projectRoot)) add(match[1]);
      }
    }
    for (const doc of mapDocs) if (!docs.includes(doc) && value.includes(doc)) docs.push(doc);
  };
  // 構造を持つ値だけを歩く。本文（content・text など）の文字列の中は見ない。
  const walk = (node, depth) => {
    if (depth > 24 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    for (const [key, value] of Object.entries(node)) {
      if (ARGUMENT_KEYS.has(key)) {
        if (typeof value === "string") considerArgument(value);
        else if (Array.isArray(value)) considerArgument(value.filter((item) => typeof item === "string").join(" "));
      } else if (key === "skill" && typeof value === "string") {
        considerSkillName(value);
      } else if (key === "arguments" && typeof value === "string" && value.trimStart().startsWith("{")) {
        try { walk(JSON.parse(value), depth + 1); } catch { /* 引数が JSON でなければ見ない */ }
      } else if (value && typeof value === "object") {
        walk(value, depth + 1);
      }
    }
  };
  const lineStarts = new Set();
  for (const needle of ["SKILL.md", "\"skill\"", ...mapDocs]) {
    const bytes = Buffer.from(needle, "utf8");
    let at = buffer.indexOf(bytes, 0);
    while (at !== -1 && lineStarts.size < MAX_TRANSCRIPT_LINES) {
      const start = buffer.lastIndexOf(0x0a, at) + 1;
      lineStarts.add(start);
      const end = buffer.indexOf(0x0a, at);
      if (end === -1) break;
      at = buffer.indexOf(bytes, end);
    }
  }
  for (const start of [...lineStarts].sort((left, right) => left - right)) {
    const endAt = buffer.indexOf(0x0a, start);
    const line = buffer.subarray(start, endAt === -1 ? buffer.length : endAt).toString("utf8");
    try { walk(JSON.parse(line), 0); } catch { /* JSON でない行・途中で切れた行は見ない */ }
  }
  return { skills, docs };
}

function displayPath(root, relative, projectRoot) {
  const absolute = path.join(root, ...relative.split("/"));
  if (projectRoot && root === projectRoot) return relative;
  return absolute;
}

/** 挙げるスキルの道。プロジェクトの正本があればそれを、無ければプラグインの写しを指す。 */
function skillLocation(id, { projectRoot, hookRoot }) {
  const relative = `.agents/skills/${id}/SKILL.md`;
  for (const root of [projectRoot, hookRoot]) {
    if (root && fs.existsSync(path.join(root, ...relative.split("/")))) return displayPath(root, relative, projectRoot);
  }
  return "";
}

function docLocation(doc, { projectRoot, hookRoot }) {
  for (const root of [projectRoot, hookRoot]) {
    if (root && fs.existsSync(path.join(root, ...doc.split("/")))) return displayPath(root, doc, projectRoot);
  }
  return "";
}

const HEADER = "[BuzzAssist] 会話が圧縮されました。圧縮のあとに戻るのは各スキルの先頭の一部だけで、前に読んだスキルは丸ごと落ちることがあります。";
const FOOTER = "要約に残った手順・数値・禁則が正本と食い違えば、正本に従ってください。";

/** SessionStart の応答を作る。何も足さないときは null。 */
export function buildCompactReminder(input, { hookRoot = HOOK_ROOT, transcriptText } = {}) {
  if (!input || typeof input !== "object") return null;
  const event = String(input.hook_event_name ?? "SessionStart");
  if (event !== "SessionStart") return null;
  if (String(input.source || "") !== "compact") return null;
  if (input.agent_id) return null;
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : "";
  const projectMap = findProjectMap(cwd);
  const projectRoot = projectMap?.root || "";
  const pluginMap = (() => {
    for (const name of MAP_FILES) {
      try { return readMapReferences(fs.readFileSync(path.join(hookRoot, name), "utf8")); } catch { /* 次の地図 */ }
    }
    return { skills: [], docs: [] };
  })();
  const knownSkills = canonicalSkillIds([projectRoot, hookRoot]);
  const mapDocs = [...new Set([...(projectMap?.docs || []), ...pluginMap.docs])];
  const text = transcriptText !== undefined ? transcriptText : readTranscript(input.transcript_path);
  const used = usedReferences(text, { knownSkills, mapDocs, projectRoot });
  const locations = { projectRoot, hookRoot };

  const listed = [
    ...used.skills.map((id) => skillLocation(id, locations)),
    ...used.docs.map((doc) => docLocation(doc, locations)),
  ].filter(Boolean).slice(0, MAX_LISTED);
  if (listed.length > 0) {
    return {
      mode: "used",
      listed,
      output: {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: [
            HEADER,
            "作業を続ける前に、この会話で使っていた正本を最後まで読み直してください:",
            ...listed.map((item) => `- ${item}`),
            FOOTER,
          ].join("\n"),
        },
      },
    };
  }
  if (!projectMap) return null;
  const mapped = projectMap.skills.filter((id) => knownSkills.has(id));
  if (mapped.length === 0) return null;
  return {
    mode: "map",
    listed: mapped,
    output: {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: [
          HEADER,
          `制作・修復・監査・スキルの改訂の途中なら、${projectMap.file} の地図が指す正本のうち今の作業に当たるものを、`
            + `続ける前に最後まで読み直してください（${mapped.join("・")}。場所は .agents/skills/<名前>/SKILL.md）。`,
          FOOTER,
        ].join("\n"),
      },
    },
  };
}

function readStdin(stream, limit = MAX_INPUT_BYTES) {
  return new Promise((resolve) => {
    if (!stream || stream.isTTY) { resolve(""); return; }
    const chunks = [];
    let size = 0;
    stream.on("data", (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    stream.on("end", () => resolve(size <= limit ? Buffer.concat(chunks).toString("utf8") : ""));
    stream.on("error", () => resolve(""));
  });
}

/**
 * CLI 本体。促すときだけ JSON を1行出す。どの経路でも exit 0。
 * Codex のフックは `node -e` の起動子からこの関数を呼ぶ。
 */
export async function runCompactHookCli({
  stdin = process.stdin,
  stdout = process.stdout,
  exit = (code) => process.exit(code),
  timeoutMs = HARD_TIMEOUT_MS,
  hookRoot = HOOK_ROOT,
} = {}) {
  const guard = setTimeout(() => exit(0), timeoutMs);
  try {
    const raw = await readStdin(stdin);
    let input = null;
    try { input = raw.trim() ? JSON.parse(raw) : null; } catch { input = null; }
    const response = input ? buildCompactReminder(input, { hookRoot }) : null;
    if (response) stdout.write(`${JSON.stringify(response.output)}\n`);
  } catch {
    // 促せなくても会話は止めない。
  } finally {
    clearTimeout(guard);
  }
  return 0;
}

if (isDirectCli(import.meta.url)) {
  process.on("uncaughtException", () => process.exit(0));
  process.on("unhandledRejection", () => process.exit(0));
  runCompactHookCli();
}
