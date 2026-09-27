#!/usr/bin/env node
// エージェントの道具の呼び出しのうち、人がやるべき操作を実行前に止める PreToolUse フック
// （Claude Code / Codex 共通）。
//
// 人の確認は、今まで文章（スキル・CLAUDE.md）と TTY の確認で守っていた。だが TTY は証明にならない
// （PTY を通せばエージェントも対話端末を名乗れる。scripts/harness-learn.mjs の attestationFor の注記）。
// 文章のお願いは、エージェントが「今回は例外」と理由を見つけた時点で効かなくなる。ここでは、
// よくある形の呼び出しを道具の実行前に止め、「人が自分の端末で打つ操作だ」という理由を返す。
//
// 止めるもの（BuzzAssist 固有のものと、署名済みの束の書き換えだけ）:
//
//   1. `--human-verified` を渡すコマンド（人の確認の印。どの CLI でも人が自分の端末で打つ）
//   2. `skill-inventory` の `--approve`（配布前の人の承認。リリースの1回だけ人が打つ）
//   3. 品質ループの人専用の操作（旗に関わらず、エージェントが打っても何も数えられないもの）:
//        script-quality-loop.mjs の accept-human・reset-cumulative・stop
//        asset-quality-loop.mjs の stop・verify-pages
//        strategy-brief.mjs の stop
//      （harness-learn の approve・reject・rollback・promote・apply・curate --archive は、
//        エージェントが「機械の判断」として打つ経路があるので、1 の旗が付いたときだけ止める）
//   4. 署名済みの Channel Pack の封筒の書き換え（Edit/Write/apply_patch と、シェルからの書き込み）。
//      封筒は、祖先に封筒の目録（channel-pack.json、版 buzzassist-channel-pack-envelope-v*）があるもの。
//      `*-signed-*`（か `signed-*`）の名前の階層は、実在を確かめられる道ならその階層に目録があるときだけ、
//      確かめられない道（glob・変数・cwd の無い相対の道）なら名前だけで封筒と数える
//      （ほかのプロジェクトの self-signed の証明書置き場などを止めないため）。
//
// 止めないもの（どれも意図的）:
//
//   - 一般の git 操作や、ほかのプロジェクトの普通のコマンド。このプラグインは運営者の全プロジェクトで
//     有効になるので、BuzzAssist の旗・CLI の名前・封筒に当たらない呼び出しには何も言わない
//   - `--human-verified` を「話題にする」だけのコマンド（rg・grep・git commit -m・echo など）。
//     止めるのは、それを引数として受け取るプログラムを起動するときだけ
//   - 人が自分で打つシェル（自分の端末、Claude Code の `!` の入力）。Claude Code の説明では、`!` の入力は
//     Claude を通さずに直接動き（承認も要らない）、PreToolUse は Claude が道具を呼ぶときに走る。
//     Codex の TUI の `!` がフックを通るかは、Codex の説明に書かれていない（2026-09 時点）
//
// これは関門ではなく「既定の経路から外す」仕掛け。変数で旗を組み立てる・スクリプトファイルに書いて
// 実行する、のような形は見抜けない（コマンドの文字列しか見ていない）。本当の歯止めは、人の確認の記録を
// 人が読むこと（git の差分・Release の承認）にある。
//
// フックが落ちた・時間切れ・入力が壊れているときは、何も出さずに exit 0 で終わる（道具を全部止めない）。
// 止めるときは、ホストの共通の形（hookSpecificOutput.permissionDecision = "deny"）で理由を返す。
// 読み込むのは Node の組み込みと、組み込みだけを使う lib/cliEntrypoint.mjs（依存の無いプラグインの置き場からも起動するため）。

import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { isDirectCli } from "../lib/cliEntrypoint.mjs";

/** 運営者がこのフックを止めるための環境変数（"0" / "off"）。ホストを起動するシェルで設定する。 */
export const GUARD_DISABLE_ENV = "BUZZASSIST_TOOL_GUARD";
const HARD_TIMEOUT_MS = 1500;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_CHARS = 200_000;
const MAX_DEPTH = 4;

export const HUMAN_VERIFIED_FLAG = "--human-verified";

/** 旗に関わらず人だけが打つ操作。キーは CLI のファイル名、値はその操作（最初の位置引数）。 */
export const HUMAN_ONLY_ACTIONS = Object.freeze({
  "script-quality-loop.mjs": Object.freeze(["accept-human", "reset-cumulative", "stop"]),
  "asset-quality-loop.mjs": Object.freeze(["stop", "verify-pages"]),
  "strategy-brief.mjs": Object.freeze(["stop"]),
});

/** `--human-verified` を「話題にする」だけで、引数として受け取って動かすことのないプログラム。 */
const MENTION_ONLY_PROGRAMS = new Set([
  "echo", "printf", "print", "rg", "grep", "egrep", "fgrep", "ag", "ack", "git", "gh", "cat", "bat", "less", "more",
  "head", "tail", "wc", "sort", "uniq", "cut", "tr", "awk", "gawk", "sed", "gsed", "jq", "yq", "diff", "cmp", "ls",
  "test", "[", "true", "false", ":", "pbcopy", "clip", "man", "which", "type", "whatis", "column", "fold", "fmt",
  "nl", "tee", "base64", "shasum", "sha256sum", "md5", "md5sum", "file", "stat", "read", "export", "set", "local",
  "declare", "typeset", "readonly", "unset", "alias", "history", "write-output", "write-host", "select-string",
  "get-content", "out-file", "set-content", "add-content",
]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const POWERSHELLS = new Set(["powershell", "pwsh"]);
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const INLINE_CODE_FLAGS = Object.freeze({
  node: ["-e", "--eval", "-p", "--print"],
  nodejs: ["-e", "--eval", "-p", "--print"],
  bun: ["-e", "--eval", "-p", "--print"],
  deno: ["eval"],
  python: ["-c"],
  python3: ["-c"],
  ruby: ["-e"],
  perl: ["-e", "-E"],
});
const SPAWN_API = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|subprocess|os\.system|popen|system\s*\()/u;
const WRITE_API = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|rmSync|rm\s*\(|rmdir|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|cpSync|cp\s*\(|mkdir|mkdirSync|truncate|symlink|createWriteStream|write_text|write_bytes|shutil\.|os\.remove|os\.rename|os\.unlink|open\s*\([^)]*["'][wax+])/u;

const ENVELOPE_NAME = /(?:^|-)signed-/iu;
const ENVELOPE_MANIFEST = "channel-pack.json";
const ENVELOPE_VERSION_MARK = "buzzassist-channel-pack-envelope-v";
const MAX_ANCESTOR_LEVELS = 16;

const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
const ANY_PATH_WRITERS = new Set([
  "rm", "rmdir", "unlink", "touch", "truncate", "shred", "srm", "chmod", "chown", "chgrp", "chflags", "xattr",
  "setfacl", "mkdir", "tee", "mv", "gmv", "remove-item", "rename-item", "move-item", "new-item", "set-content",
  "add-content", "out-file", "clear-content", "del", "erase", "rd",
]);
const DEST_WRITERS = new Set(["cp", "gcp", "ln", "install", "rsync", "ditto", "scp", "copy-item"]);
const GIT_WRITE_SUBCOMMANDS = new Set(["rm", "mv", "restore", "checkout", "clean", "apply", "am", "stash", "reset"]);
const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for", "case", "esac", "!", "{", "}", "function", "select", "in"]);

// ---------------------------------------------------------------------------------------------
// シェルの字句の分解（完全な構文解析ではない。止める判定に要る形だけを取り出す）

/**
 * コマンドの文字列を、単純コマンドの並びに分ける。
 * 返り値: { commands: [{ words, redirects: [{ op, target }], heredocs: [body] }], substitutions: [string] }
 * substitutions は $(...) と `...` の中身（呼び出し側が同じ判定にかける）。
 */
export function splitShellCommand(source, { powershell = false } = {}) {
  const text = String(source ?? "").slice(0, MAX_COMMAND_CHARS);
  const commands = [];
  const substitutions = [];
  let words = [];
  let redirects = [];
  let heredocs = [];
  let pendingHeredocs = [];
  let cur = "";
  let inWord = false;
  let pendingRedirect = null;
  const escapeChar = powershell ? "`" : "\\";

  const endWord = () => {
    if (!inWord) return;
    if (pendingRedirect) {
      if (pendingRedirect.op === "<<" || pendingRedirect.op === "<<-") {
        pendingHeredocs.push({ delimiter: cur, stripTabs: pendingRedirect.op === "<<-", owner: null });
      } else if (pendingRedirect.op !== "<<<") {
        redirects.push({ op: pendingRedirect.op, target: cur });
      }
      pendingRedirect = null;
    } else {
      words.push(cur);
    }
    cur = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    pendingRedirect = null;
    if (words.length > 0 || redirects.length > 0 || heredocs.length > 0) {
      const command = { words, redirects, heredocs };
      commands.push(command);
      for (const pending of pendingHeredocs) if (!pending.owner) pending.owner = command;
    } else {
      for (const pending of pendingHeredocs) if (!pending.owner) pending.owner = { heredocs: [] };
    }
    words = [];
    redirects = [];
    heredocs = [];
  };
  const readHeredocBodies = (start) => {
    // start は改行の直後。溜まったヒアドキュメントの本文を順に読み、次の位置を返す。
    let index = start;
    for (const pending of pendingHeredocs) {
      const lines = [];
      while (index <= text.length) {
        const newline = text.indexOf("\n", index);
        const end = newline === -1 ? text.length : newline;
        const raw = text.slice(index, end);
        const line = pending.stripTabs ? raw.replace(/^\t+/u, "") : raw;
        index = newline === -1 ? text.length + 1 : newline + 1;
        if (line === pending.delimiter) break;
        lines.push(raw);
        if (newline === -1) break;
      }
      (pending.owner?.heredocs || []).push(lines.join("\n"));
    }
    pendingHeredocs = [];
    return Math.min(index, text.length);
  };
  const readBalanced = (start, open, close) => {
    // start は open の直後。対応する close の位置を返す（引用符の中は数えない）。
    let depth = 1;
    let index = start;
    let quote = "";
    while (index < text.length) {
      const char = text[index];
      if (quote) {
        if (char === escapeChar && quote === "\"") { index += 2; continue; }
        if (char === quote) quote = "";
        index += 1;
        continue;
      }
      if (char === escapeChar) { index += 2; continue; }
      if (char === "'" || char === "\"") { quote = char; index += 1; continue; }
      if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) return index;
      }
      index += 1;
    }
    return text.length;
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (char === escapeChar) {
      if (next === "\n") { index += 2; continue; }
      if (next !== undefined) { cur += next; inWord = true; }
      index += 2;
      continue;
    }
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      const stop = end === -1 ? text.length : end;
      cur += text.slice(index + 1, stop);
      inWord = true;
      index = stop + 1;
      continue;
    }
    if (char === "$" && next === "'" && !powershell) {
      let scan = index + 2;
      let value = "";
      while (scan < text.length && text[scan] !== "'") {
        if (text[scan] === "\\" && scan + 1 < text.length) { value += text[scan + 1]; scan += 2; continue; }
        value += text[scan];
        scan += 1;
      }
      cur += value;
      inWord = true;
      index = scan + 1;
      continue;
    }
    if (char === "\"") {
      let scan = index + 1;
      while (scan < text.length && text[scan] !== "\"") {
        const inner = text[scan];
        if (inner === escapeChar && scan + 1 < text.length) {
          // POSIX の "..." の中で \ が効くのは $ ` " \ と改行だけ。ほかの \ は文字のまま残す。
          const escaped = text[scan + 1];
          if (powershell || "$`\"\\\n".includes(escaped)) {
            if (escaped !== "\n") cur += escaped;
            scan += 2;
            continue;
          }
          cur += inner;
          scan += 1;
          continue;
        }
        if (inner === "$" && text[scan + 1] === "(" && text[scan + 2] !== "(") {
          const close = readBalanced(scan + 2, "(", ")");
          substitutions.push(text.slice(scan + 2, close));
          cur += text.slice(scan, close + 1);
          scan = close + 1;
          continue;
        }
        if (inner === "`" && !powershell) {
          const close = text.indexOf("`", scan + 1);
          const stop = close === -1 ? text.length : close;
          substitutions.push(text.slice(scan + 1, stop));
          scan = stop + 1;
          continue;
        }
        cur += inner;
        scan += 1;
      }
      inWord = true;
      index = scan + 1;
      continue;
    }
    if (char === "$" && next === "(" && text[index + 2] !== "(") {
      const close = readBalanced(index + 2, "(", ")");
      substitutions.push(text.slice(index + 2, close));
      cur += text.slice(index, close + 1);
      inWord = true;
      index = close + 1;
      continue;
    }
    if (char === "`" && !powershell) {
      const close = text.indexOf("`", index + 1);
      const stop = close === -1 ? text.length : close;
      substitutions.push(text.slice(index + 1, stop));
      inWord = true;
      index = stop + 1;
      continue;
    }
    if (char === "#" && !inWord) {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
      continue;
    }
    if (char === "\n") {
      endCommand();
      index += 1;
      if (pendingHeredocs.length > 0) index = readHeredocBodies(index);
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") {
      endWord();
      index += 1;
      continue;
    }
    if (char === ";" || char === "(" || char === ")") {
      endCommand();
      index += 1;
      continue;
    }
    if (char === "|") {
      endCommand();
      index += next === "|" || next === "&" ? 2 : 1;
      continue;
    }
    if (char === "&") {
      if (next === ">") {
        endWord();
        const op = text[index + 2] === ">" ? "&>>" : "&>";
        pendingRedirect = { op };
        index += op.length;
        continue;
      }
      endCommand();
      index += next === "&" ? 2 : 1;
      continue;
    }
    if (char === ">" || char === "<") {
      // 直前の語が数字だけなら fd の番号（2> など）。語としては数えない。
      if (inWord && /^\d+$/u.test(cur)) { cur = ""; inWord = false; }
      endWord();
      let op = char;
      if (char === ">" && (next === ">" || next === "|")) op += next;
      else if (char === "<" && next === "<") op = text[index + 2] === "<" ? "<<<" : text[index + 2] === "-" ? "<<-" : "<<";
      else if (char === "<" && next === ">") op = "<>";
      index += op.length;
      if (text[index] === "&") {
        // >&2 / <&0 は fd の複製（書き込み先ではない）。>&file は bash の &> と同じ。
        const dup = text.slice(index + 1).match(/^(\d+|-)/u);
        index += 1;
        if (dup) { index += dup[0].length; continue; }
        op = "&>";
      }
      pendingRedirect = { op };
      continue;
    }
    cur += char;
    inWord = true;
    index += 1;
  }
  endCommand();
  if (pendingHeredocs.length > 0) readHeredocBodies(text.length);
  return { commands, substitutions };
}

// ---------------------------------------------------------------------------------------------
// 道の判定

function baseName(word) {
  const parts = String(word || "").split(/[\\/]+/u);
  return parts[parts.length - 1] || "";
}

function programName(word) {
  return baseName(word).toLowerCase().replace(/\.(?:exe|cmd|bat)$/u, "");
}

function expandHome(word, env) {
  const text = String(word || "");
  const home = String(env?.HOME || env?.USERPROFILE || homedir() || "");
  if (text === "~") return home;
  if (text.startsWith("~/") || text.startsWith("~\\")) return `${home}${text.slice(1)}`;
  if (text.startsWith("$HOME/") || text.startsWith("${HOME}/")) return `${home}${text.slice(text.indexOf("/"))}`;
  return text;
}

function isAbsolutePath(text) {
  return text.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(text) || text.startsWith("\\\\");
}

/** cwd を基準に道を解決する（Windows の書き方は分けたまま返す）。 */
export function resolveToolPath(word, cwd, env = process.env) {
  const text = expandHome(word, env);
  if (!text) return "";
  if (isAbsolutePath(text)) return text;
  const base = String(cwd || "");
  if (!base) return text;
  if (/^[A-Za-z]:[\\/]/u.test(base) || base.includes("\\")) return `${base.replace(/[\\/]+$/u, "")}\\${text}`;
  return path.posix.resolve(base, text);
}

function looksLikePath(word) {
  const text = String(word || "");
  if (!text || text.startsWith("-") || text.includes("://")) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(text)) return false;
  return true;
}

function readHead(file, bytes = 4096) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 読めなければ封筒として数えない */ } }
  }
}

/** そのディレクトリに封筒の目録（版 buzzassist-channel-pack-envelope-v*）があるか。 */
function isEnvelopeDir(dir) {
  const manifest = path.join(dir, ENVELOPE_MANIFEST);
  return fs.existsSync(manifest) && readHead(manifest).includes(ENVELOPE_VERSION_MARK);
}

const PATTERN_CHARS = /[*?[\]$]/u;

/**
 * 道が署名済みの封筒の中（か封筒そのもの）なら、封筒のディレクトリを返す。違えば "".
 *
 * `*-signed-*` / `signed-*` の名前の階層は、実在の場所として確かめられる道（絶対の道で、そこまでに glob・変数が
 * 無い）なら、その階層に封筒の目録があるときだけ封筒と数える。このフックは運営者の全プロジェクトで動くので、
 * 名前だけで決めると、ほかのプロジェクトの self-signed の証明書置き場や signed-urls のような階層まで止めてしまう。
 * 確かめられない道（相対の道で cwd が無い・glob・変数）は、名前の規則で数える。
 * 名前が当たらなくても、祖先に封筒の目録があれば封筒と数える。
 */
export function signedEnvelopeFor(resolved, { checkDisk = true } = {}) {
  const text = String(resolved || "");
  if (!text) return "";
  const separator = text.includes("\\") && !text.includes("/") ? "\\" : "/";
  const segments = text.split(/[\\/]+/u);
  const onDisk = checkDisk && isAbsolutePath(text);
  for (let index = 0; index < segments.length; index += 1) {
    // 最後の階層は、拡張子の付いたファイル名（contact-sheet-signed-off.json など）なら封筒の名前として数えない。
    // operator-signed-1.0.0 のような版つきの名前は数える（拡張子が数字だけ）。
    const last = index === segments.length - 1;
    if (last && /\.[A-Za-z][A-Za-z0-9]{0,7}$/u.test(segments[index])) continue;
    if (!ENVELOPE_NAME.test(segments[index])) continue;
    const dir = segments.slice(0, index + 1).join(separator) || segments[index];
    if (onDisk && !PATTERN_CHARS.test(dir)) {
      // まだ無い階層への書き込みは、署名済みの中身の書き換えではない（新しく作る封筒は署名が無ければ通らない）。
      if (isEnvelopeDir(dir)) return dir;
      continue;
    }
    return dir;
  }
  if (!onDisk) return "";
  // glob・変数を含む道は、その手前（確かめられる所）から祖先をたどる。
  const firstPattern = segments.findIndex((segment) => PATTERN_CHARS.test(segment));
  let dir = firstPattern === -1 ? text : segments.slice(0, firstPattern).join(separator);
  if (!dir || !isAbsolutePath(dir)) return "";
  for (let level = 0; level < MAX_ANCESTOR_LEVELS; level += 1) {
    if (isEnvelopeDir(dir)) return dir;
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return "";
}

// ---------------------------------------------------------------------------------------------
// 判定

function finding(rule, detail, extra = {}) {
  return { rule, detail, ...extra };
}

/** 包みのコマンド（env・timeout・script など）を外し、実際に動くプログラムと引数を返す。 */
export function unwrapCommand(words) {
  let rest = [...words];
  const inner = [];
  for (let guard = 0; guard < 12 && rest.length > 0; guard += 1) {
    while (rest.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(rest[0]) || SHELL_KEYWORDS.has(rest[0]))) rest = rest.slice(1);
    if (rest.length === 0) break;
    const name = programName(rest[0]);
    const args = rest.slice(1);
    const skipOptions = (list, valued = new Set()) => {
      let position = 0;
      while (position < list.length && list[position].startsWith("-") && list[position] !== "--") {
        position += valued.has(list[position]) ? 2 : 1;
      }
      if (list[position] === "--") position += 1;
      return list.slice(position);
    };
    if (name === "env") {
      let position = 0;
      while (position < args.length) {
        const word = args[position];
        if (word === "-S" || word === "--split-string") { inner.push(args.slice(position + 1).join(" ")); return { program: "", args: [], inner }; }
        if (word === "-u" || word === "-C" || word === "-P") { position += 2; continue; }
        if (word.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) { position += 1; continue; }
        break;
      }
      rest = args.slice(position);
      continue;
    }
    if (["command", "builtin", "exec", "nohup", "noglob", "nocorrect", "unbuffer", "chronic", "setsid", "caffeinate", "taskpolicy"].includes(name)) {
      if (name === "command" && (args[0] === "-v" || args[0] === "-V")) return { program: name, args, inner };
      rest = skipOptions(args, new Set(["-t", "-w", "-c", "-b"]));
      continue;
    }
    if (name === "time") { rest = skipOptions(args); continue; }
    if (name === "nice" || name === "ionice") { rest = skipOptions(args, new Set(["-n", "-c", "-t"])); continue; }
    if (name === "sudo" || name === "doas") { rest = skipOptions(args, new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"])); continue; }
    if (name === "stdbuf") { rest = skipOptions(args, new Set(["-i", "-o", "-e"])); continue; }
    if (name === "timeout" || name === "gtimeout") {
      const after = skipOptions(args, new Set(["-s", "-k", "--signal", "--kill-after"]));
      rest = after.slice(1);
      continue;
    }
    if (name === "xargs") { rest = skipOptions(args, new Set(["-n", "-L", "-P", "-s", "-d", "-E", "-I", "-a", "-J", "-R", "-S"])); continue; }
    if (name === "flock") { const after = skipOptions(args, new Set(["-w", "-E", "-c"])); rest = after.slice(1); continue; }
    if (name === "watch") {
      const after = skipOptions(args, new Set(["-n", "-d", "--interval"]));
      inner.push(after.join(" "));
      return { program: "", args: [], inner };
    }
    if (name === "script") {
      const cIndex = args.indexOf("-c");
      if (cIndex >= 0 && args[cIndex + 1] !== undefined) { inner.push(args[cIndex + 1]); return { program: "", args: [], inner }; }
      const after = skipOptions(args, new Set(["-F", "-t", "-T", "-E"]));
      rest = after.slice(1);
      continue;
    }
    if (SHELLS.has(name)) {
      const cIndex = args.findIndex((word) => /^-[A-Za-z]*c[A-Za-z]*$/u.test(word) || word === "--command");
      if (cIndex >= 0) {
        const command = args.slice(cIndex + 1).find((word) => !word.startsWith("-") || word === "-");
        if (command !== undefined) inner.push(command);
        return { program: "", args: [], inner };
      }
      return { program: name, args, inner, shell: true };
    }
    if (POWERSHELLS.has(name)) {
      const cIndex = args.findIndex((word) => /^-(?:c|command|encodedcommand)$/iu.test(word));
      if (cIndex >= 0 && !/^-encodedcommand$/iu.test(args[cIndex])) {
        inner.push({ command: args.slice(cIndex + 1).join(" "), powershell: true });
        return { program: "", args: [], inner };
      }
      return { program: name, args, inner };
    }
    if (name === "cmd" && args.length > 0 && /^\/[ck]$/iu.test(args[0])) {
      inner.push(args.slice(1).join(" "));
      return { program: "", args: [], inner };
    }
    if (name === "eval") { inner.push(args.join(" ")); return { program: "", args: [], inner }; }
    return { program: rest[0], args, inner };
  }
  return { program: "", args: [], inner };
}

function hasHumanVerified(words) {
  return words.some((word) => word === HUMAN_VERIFIED_FLAG || word.startsWith(`${HUMAN_VERIFIED_FLAG}=`));
}

function hasHelp(words) {
  return words.some((word) => word === "--help" || word === "-h");
}

function inlineCodeOf(name, args) {
  const flags = INLINE_CODE_FLAGS[name];
  if (!flags) return [];
  const codes = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (flags.includes(word) && args[index + 1] !== undefined) codes.push(args[index + 1]);
    else if (name === "perl" && /^-[a-zA-Z]*[eE]$/u.test(word) && args[index + 1] !== undefined) codes.push(args[index + 1]);
  }
  return codes;
}

function quotedStrings(code) {
  const found = [];
  const pattern = /(["'`])((?:\\.|(?!\1).)*?)\1/gu;
  let match;
  while ((match = pattern.exec(code)) !== null) found.push(match[2]);
  return found;
}

/** apply_patch の本文から、書き換える道を取り出す。 */
export function patchTargets(patchText) {
  const targets = [];
  for (const line of String(patchText || "").split(/\r?\n/u)) {
    const match = line.match(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/u);
    if (match) targets.push(match[1]);
  }
  return targets;
}

function isHumanOnlyAction(words) {
  for (let index = 0; index < words.length; index += 1) {
    const actions = HUMAN_ONLY_ACTIONS[baseName(words[index])];
    if (!actions) continue;
    const action = words.slice(index + 1).find((word) => !word.startsWith("-"));
    if (action && actions.includes(action)) return { cli: baseName(words[index]), action };
  }
  return null;
}

function runsSkillInventoryApprove(programWords) {
  const approve = programWords.some((word) => word === "--approve" || word.startsWith("--approve="));
  if (!approve) return false;
  if (programWords.some((word) => /^skill-inventory(?:\.mjs)?$/u.test(baseName(word)))) return true;
  // npm run skills:check -- --approve <id>（package.json の skills:* は skill-inventory を起動する）
  const name = programName(programWords[0]);
  if (SCRIPT_RUNNERS.has(name)) return programWords.some((word) => /^skills:/u.test(word));
  return false;
}

function envelopeHit(word, ctx) {
  if (!looksLikePath(word)) return "";
  if (/\$/u.test(word) && !/^\$\{?HOME\}?[\\/]/u.test(word) && !ENVELOPE_NAME.test(word)) return "";
  return signedEnvelopeFor(resolveToolPath(word, ctx.cwd, ctx.env), ctx);
}

function firstEnvelope(words, ctx) {
  for (const word of words) {
    const hit = envelopeHit(word, ctx);
    if (hit) return hit;
  }
  return "";
}

function positional(args, valued = new Set()) {
  const out = [];
  let afterDoubleDash = false;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (!afterDoubleDash && word === "--") { afterDoubleDash = true; continue; }
    if (!afterDoubleDash && word.startsWith("-") && word !== "-") {
      if (valued.has(word)) index += 1;
      continue;
    }
    out.push(word);
  }
  return out;
}

function optionValue(args, names) {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    for (const name of names) {
      if (word === name && args[index + 1] !== undefined) return args[index + 1];
      if (name.startsWith("--") && word.startsWith(`${name}=`)) return word.slice(name.length + 1);
      if (!name.startsWith("--") && word.startsWith(name) && word.length > name.length && name.length === 2) return word.slice(2);
    }
  }
  return "";
}

/** シェルの1つの単純コマンドが封筒へ書き込むか。書き込むなら封筒のディレクトリを返す。 */
function envelopeWrite(program, args, command, ctx) {
  for (const redirect of command.redirects) {
    if (WRITE_REDIRECTS.has(redirect.op)) {
      const hit = envelopeHit(redirect.target, ctx);
      if (hit) return hit;
    }
  }
  const name = programName(program);
  if (!name) return "";
  if (ANY_PATH_WRITERS.has(name)) return firstEnvelope(positional(args, new Set(["-m", "-o", "-g"])), ctx);
  if (DEST_WRITERS.has(name)) {
    const target = optionValue(args, ["-t", "--target-directory", "-Destination", "-destination"]);
    if (target) return envelopeHit(target, ctx);
    const list = positional(args, new Set(["-e", "--rsh", "-S", "--suffix"]));
    return list.length > 1 ? envelopeHit(list[list.length - 1], ctx) : "";
  }
  if (name === "sed" || name === "gsed") {
    if (!args.some((word) => /^-[A-Za-z]*i/u.test(word) || word.startsWith("--in-place"))) return "";
    return firstEnvelope(positional(args, new Set(["-e", "-f", "--expression", "--file"])), ctx);
  }
  if (name === "perl") {
    if (!args.some((word) => /^-[A-Za-z]*i/u.test(word))) return "";
    return firstEnvelope(positional(args, new Set(["-e", "-E", "-M", "-I"])), ctx);
  }
  if (name === "dd") {
    const of = args.find((word) => word.startsWith("of="));
    return of ? envelopeHit(of.slice(3), ctx) : "";
  }
  if (name === "tar" || name === "gtar" || name === "bsdtar") {
    // 旗の束は、先頭の語（tar xzf の形）と、- 1つで始まる語だけを見る（-C の値やファイル名は見ない）。
    const flagWords = args.filter((word, index) => (index === 0 && /^[A-Za-z]+$/u.test(word)) || /^-[A-Za-z]+$/u.test(word));
    const extracting = args.includes("--extract") || args.includes("--get") || flagWords.some((word) => word.includes("x"));
    if (extracting) {
      const target = optionValue(args, ["-C", "--directory"]);
      return target ? envelopeHit(target, ctx) : signedEnvelopeFor(ctx.cwd, ctx);
    }
    const creating = args.includes("--create") || flagWords.some((word) => /[cru]/u.test(word.replace(/^-/u, "")));
    if (creating) {
      const fIndex = args.findIndex((word) => /^-?[A-Za-z]*f$/u.test(word) && !word.startsWith("--"));
      if (fIndex >= 0 && args[fIndex + 1]) return envelopeHit(args[fIndex + 1], ctx);
    }
    return "";
  }
  if (name === "unzip") {
    const target = optionValue(args, ["-d"]);
    return target ? envelopeHit(target, ctx) : signedEnvelopeFor(ctx.cwd, ctx);
  }
  if (name === "7z" || name === "7za") {
    const attached = args.find((word) => word.startsWith("-o") && word.length > 2);
    return attached ? envelopeHit(attached.slice(2), ctx) : "";
  }
  if (name === "patch") {
    const dir = optionValue(args, ["-d", "--directory"]);
    if (dir) return envelopeHit(dir, ctx);
    return firstEnvelope(positional(args, new Set(["-p", "-i", "-o", "-r", "-B", "-z", "-F"])), ctx) || signedEnvelopeFor(ctx.cwd, ctx);
  }
  if (name === "apply_patch" || name === "applypatch") {
    for (const body of [...command.heredocs, ...args]) {
      for (const target of patchTargets(body)) {
        const hit = envelopeHit(target, ctx);
        if (hit) return hit;
      }
    }
    return "";
  }
  if (name === "git") {
    let position = 0;
    let gitCwd = ctx.cwd;
    while (position < args.length && args[position].startsWith("-")) {
      const word = args[position];
      if (word === "-C" && args[position + 1] !== undefined) { gitCwd = resolveToolPath(args[position + 1], gitCwd, ctx.env); position += 2; continue; }
      if (word === "-c" || word === "--git-dir" || word === "--work-tree" || word === "--namespace") { position += 2; continue; }
      position += 1;
    }
    const sub = args[position];
    if (!GIT_WRITE_SUBCOMMANDS.has(sub)) return "";
    const local = { ...ctx, cwd: gitCwd };
    const inGit = signedEnvelopeFor(gitCwd, local);
    if (inGit && ["clean", "stash", "reset", "checkout", "restore"].includes(sub)) return inGit;
    return firstEnvelope(positional(args.slice(position + 1), new Set(["-m", "-s", "--source", "-b", "-B"])), local);
  }
  if (name === "find") {
    const acts = args.some((word) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(word));
    if (!acts) return "";
    const roots = [];
    for (const word of args) {
      if (word.startsWith("-") || word === "(" || word === "!") break;
      roots.push(word);
    }
    return roots.length > 0 ? firstEnvelope(roots, ctx) : signedEnvelopeFor(ctx.cwd, ctx);
  }
  const codes = [...inlineCodeOf(name, args), ...(INLINE_CODE_FLAGS[name] ? command.heredocs : [])];
  for (const code of codes) {
    if (!WRITE_API.test(code)) continue;
    for (const literal of quotedStrings(code)) {
      const hit = envelopeHit(literal, ctx);
      if (hit) return hit;
    }
  }
  return "";
}

function analyzeSimpleCommand(command, ctx, depth) {
  const unwrapped = unwrapCommand(command.words);
  for (const inner of unwrapped.inner) {
    const nested = typeof inner === "string"
      ? analyzeShell(inner, ctx, depth + 1)
      : analyzeShell(inner.command, { ...ctx, powershell: inner.powershell === true }, depth + 1);
    if (nested) return nested;
  }
  const program = unwrapped.program;
  const args = unwrapped.args;
  const name = programName(program);
  // ヒアドキュメントで本文を渡すシェル（bash <<EOF ... EOF）は、本文も同じ判定にかける。
  if (unwrapped.shell && positional(args).length === 0) {
    for (const body of command.heredocs) {
      const nested = analyzeShell(body, ctx, depth + 1);
      if (nested) return nested;
    }
  }
  const programWords = program ? [program, ...args] : [];
  if (programWords.length > 0 && !MENTION_ONLY_PROGRAMS.has(name)) {
    if (hasHumanVerified(programWords)) {
      return finding("human-verified-flag", "`--human-verified` を渡すコマンド");
    }
    if (runsSkillInventoryApprove(programWords)) {
      return finding("skill-inventory-approve", "`skill-inventory` の `--approve`");
    }
    const humanOnly = hasHelp(programWords) ? null : isHumanOnlyAction(programWords);
    if (humanOnly) {
      return finding("human-only-action", `\`${humanOnly.cli} ${humanOnly.action}\``, humanOnly);
    }
    const codes = [...inlineCodeOf(name, args), ...(INLINE_CODE_FLAGS[name] ? command.heredocs : [])];
    if (codes.some((code) => code.includes("human-verified") && SPAWN_API.test(code))) {
      return finding("human-verified-flag", "`--human-verified` を渡すコマンドを起動するコード");
    }
  }
  const envelope = envelopeWrite(program, args, command, ctx);
  if (envelope) return finding("signed-pack-write", `署名済みの Channel Pack の封筒（${envelope}）への書き込み`, { envelope });
  return null;
}

function analyzeShell(commandText, ctx, depth = 0) {
  if (depth > MAX_DEPTH) return null;
  const { commands, substitutions } = splitShellCommand(commandText, { powershell: ctx.powershell === true });
  let cwd = ctx.cwd;
  for (const command of commands) {
    const local = { ...ctx, cwd };
    const result = analyzeSimpleCommand(command, local, depth);
    if (result) return result;
    const first = programName(command.words[0]);
    if ((first === "cd" || first === "pushd" || first === "set-location") && command.words[1] && !command.words[1].startsWith("-")) {
      cwd = resolveToolPath(command.words[1], cwd, ctx.env);
    }
  }
  for (const inner of substitutions) {
    const result = analyzeShell(inner, { ...ctx, cwd }, depth + 1);
    if (result) return result;
  }
  return null;
}

function shellCommandText(toolInput) {
  const command = toolInput?.command;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    // Codex の古い形（["bash", "-lc", "..."]）。シェルの -c の中身があればそれを見る。
    if (command.length >= 3 && SHELLS.has(programName(command[0])) && /^-[A-Za-z]*c[A-Za-z]*$/u.test(command[1])) return command[2];
    return command.map((part) => (/[\s"'\\$`]/u.test(part) ? `'${part.replaceAll("'", "'\\''")}'` : part)).join(" ");
  }
  return "";
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * ホストが渡す PreToolUse の入力から、止めるべき呼び出しかを判定する。止めないなら null。
 * 副作用は無い（封筒の目録を読むだけ）。
 */
export function evaluateToolCall(input, { env = process.env, checkDisk = true } = {}) {
  if (!input || typeof input !== "object") return null;
  const event = String(input.hook_event_name ?? "PreToolUse");
  if (event !== "PreToolUse") return null;
  const tool = String(input.tool_name || "");
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const cwd = typeof input.cwd === "string" ? input.cwd : "";
  const ctx = { cwd, env, checkDisk };
  if (EDIT_TOOLS.has(tool)) {
    const target = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
    if (typeof target !== "string" || !target) return null;
    const envelope = signedEnvelopeFor(resolveToolPath(target, cwd, env), ctx);
    return envelope ? finding("signed-pack-write", `署名済みの Channel Pack の封筒（${envelope}）の書き換え`, { envelope }) : null;
  }
  if (tool === "apply_patch") {
    const body = typeof toolInput.command === "string" ? toolInput.command : typeof toolInput.patch === "string" ? toolInput.patch : typeof toolInput.input === "string" ? toolInput.input : "";
    for (const target of patchTargets(body)) {
      const envelope = signedEnvelopeFor(resolveToolPath(target, cwd, env), ctx);
      if (envelope) return finding("signed-pack-write", `署名済みの Channel Pack の封筒（${envelope}）の書き換え`, { envelope });
    }
    return null;
  }
  if (tool === "Bash" || tool === "PowerShell" || tool === "shell" || tool === "exec_command" || tool === "local_shell") {
    const command = shellCommandText(toolInput);
    if (!command) return null;
    if (command.includes("*** Begin Patch")) {
      for (const target of patchTargets(command)) {
        const envelope = signedEnvelopeFor(resolveToolPath(target, cwd, env), ctx);
        if (envelope) return finding("signed-pack-write", `署名済みの Channel Pack の封筒（${envelope}）の書き換え`, { envelope });
      }
    }
    return analyzeShell(command, { ...ctx, powershell: tool === "PowerShell" });
  }
  return null;
}

const RULE_GUIDANCE = Object.freeze({
  "human-verified-flag":
    "`--human-verified` は、確認した人が自分の対話端末から打つ印です。エージェントが打つと、機械の判断が人の確認として"
    + "記録されます。打たずに、決めてほしいことと打つコマンドをそのまま人に渡してください。"
    + "機械の判断として残すなら、`--human-verified` を外して `--agent-attested` を付けます（その CLI が受け付けるとき）。",
  "skill-inventory-approve":
    "正本スキルの人の承認は、運営者へ配る版（Release）を出す前に、承認者が自分の端末で打つ1回だけの操作です。"
    + "エージェントは打たず、`npm run skills:check:release` の結果と打つコマンドを承認者に渡してください。",
  "human-only-action":
    "これは人が決める操作です（ループを採点なしで止める・台本をそのまま使うと認める・費用の累計を戻す・"
    + "ページ画像で人の確認をする）。エージェントが打っても人の判断として数えられません。打たずに、"
    + "決めてほしいことと打つコマンドを人に渡してください。使い方を見るだけなら `--help` を付けます。",
  "signed-pack-write":
    "署名済みの封筒は、送り手が署名した時点の中身で検証されます。中を書き換えると署名が合わなくなり、"
    + "誰が何を変えたかも残りません。直すなら署名前の元の束を直し、署名する人が `node scripts/channel-pack.mjs sign` で"
    + "新しい封筒を作ります（出力先は新しい名前にする）。読むだけなら止めません。",
});

export function denyReason(result) {
  return [
    `[BuzzAssist] 止めました: ${result.detail}。`,
    RULE_GUIDANCE[result.rule] || "",
    "（BuzzAssist の PreToolUse フック。人が自分の端末で打つコマンドは止めません。Claude Code の `!` の入力も、エージェントの道具の呼び出しではないので通ります）",
  ].filter(Boolean).join("\n");
}

/** フックの応答。止めないときは null。 */
export function buildGuardResponse(input, { env = process.env, checkDisk = true } = {}) {
  const disabled = String(env?.[GUARD_DISABLE_ENV] ?? "").trim().toLowerCase();
  if (disabled === "0" || disabled === "off" || disabled === "false") return null;
  const result = evaluateToolCall(input, { env, checkDisk });
  if (!result) return null;
  return {
    result,
    output: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: denyReason(result),
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
 * CLI 本体。止めるときだけ deny の JSON を1行出す。どの経路でも exit 0（落ちても道具を止めない）。
 * Codex のフックは `node -e` の起動子からこの関数を呼ぶ（シェルに依らず plugin root を解決するため）。
 */
export async function runGuardHookCli({
  stdin = process.stdin,
  stdout = process.stdout,
  env = process.env,
  exit = (code) => process.exit(code),
  timeoutMs = HARD_TIMEOUT_MS,
} = {}) {
  const guard = setTimeout(() => exit(0), timeoutMs);
  try {
    const raw = await readStdin(stdin);
    let input = null;
    try { input = raw.trim() ? JSON.parse(raw) : null; } catch { input = null; }
    const response = input ? buildGuardResponse(input, { env }) : null;
    if (response) stdout.write(`${JSON.stringify(response.output)}\n`);
  } catch {
    // 判定が落ちても道具は止めない（fail-open）。
  } finally {
    clearTimeout(guard);
  }
  // 正常経路では process.exit を呼ばない（macOS のパイプへの書き込みが途中で切れるため）。
  return 0;
}

if (isDirectCli(import.meta.url)) {
  process.on("uncaughtException", () => process.exit(0));
  process.on("unhandledRejection", () => process.exit(0));
  runGuardHookCli();
}
