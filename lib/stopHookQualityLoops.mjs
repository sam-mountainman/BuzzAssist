// 品質ループの回し忘れを止める（Stop フックの2つ目の判定。scripts/harness-stop-hook.mjs が呼ぶ）。
//
// ループの本体は会話の外にある。作る係が1周分の作業を終えて応答を閉じるたびに、この会話で start / record した
// 品質ループの状態ファイルを読み、まだ続いている（合格・人の判断待ち・止まる条件のどれでもない）なら、止まるのを
// 差し戻して「いまの周回と点数」「次に読むファイル」「次の手順」を reason に入れる。続けるかどうかを会話の中の
// 自己申告（「もう十分」）に任せない。
//
// 見るループ:
//   - 台本（scripts/script-quality-loop.mjs、状態は <work-dir>/quality/script-quality-loop.json）
//   - 途中の成果物（scripts/asset-quality-loop.mjs、<work-dir>/quality/assets/<工程>--<対象>.json。batch は対象の一覧から）
//   - 企画ブリーフ（scripts/strategy-brief.mjs、<work-dir>/quality/strategy-brief-loop.json）
//   - ナレーション物語・解説動画の完成動画（署名済みレビューの回。Job の作業領域の quality/quality-loop-state.json）
//
// 決まり:
//   - この会話の記録にある start / record の実行だけを手がかりにする（status を見ただけのループ、ツールの結果に
//     出てきた案内の文は数えない）。状態ファイルが無ければ何もしない
//   - 状態ファイルが壊れていたら（JSON として読めない・形が違う・読めない）、合格扱いで抜けずに、直すよう短く伝える
//   - 同じ周回で二重に差し戻さない（付箋: 周回の印を会話ごとの記録に残し、印が同じなら通す）
//   - 人の判断待ちは正当な停止として差し戻さない: 合格後の人の確認待ち、上限・停滞・人の止め（blocked /
//     budget-exhausted / needs-human-approval）、完成動画のループ（続きは新しい出力と人の署名が要り、Job は
//     awaiting-human-review で待つ。有料の作り直しは運営者の確認が要る）。完成動画のループは壊れた状態だけを見る
//   - 有料の生成を勧めない（要る手順は運営者の明示の確認があるときだけ、無ければ報告して止まる、と書く）
//   - 子エージェント（並列の子・worktree の子）では何もしない。子の印・subagent は呼び出し側が先に見る。
//     ここでは会話の作業場所が git の linked worktree かを見る
//   - 評価者の会話では差し戻さない。record は採点した側も打つので、この会話の ID がそのループの評価文脈として
//     記録されていれば評価者として通す。見分けられない評価者に届いたときのため、reason にも「評価者なら版を
//     直さずに報告して止まる」と書く（作る係と評価者を混ぜない）
//   - ループの状態も成果物も書き換えない。読むだけ。合格点は reason に書かない（作る係から評価者へ漏れないように）

import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const QUALITY_LOOP_REASON_PREFIX = "[BuzzAssist 品質ループの続き]";
/** 会話ごとの記録に残す付箋の数の上限（古いものから捨てる）。 */
export const MAX_LOOP_MARKS = 64;

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_NESTED_JSON_CHARS = 2 * 1024 * 1024;
const MAX_TOKENIZE_CHARS = 256 * 1024;
const TOKENIZE_WINDOW = 4_000;
const MAX_WALK_DEPTH = 12;
const MAX_LOOP_REFS = 32;
const MAX_LISTED_LOOPS = 6;
const MAX_DETAILED_LOOPS = 3;
const DETAIL_TIMEOUT_MS = 4_000;

// 状態ファイルの置き場。各ループの定義（lib/*QualityLoop.mjs）と同じ値で、試験が突き合わせる。
// フックは応答のたびに動くので、ループの本体は差し戻すときだけ読み込む。
export const LOOP_STATE_LAYOUT = Object.freeze({
  script: Object.freeze({ dir: "quality", file: "script-quality-loop.json", revisionDelta: "script-revision-delta.json" }),
  asset: Object.freeze({ dir: path.join("quality", "assets") }),
  strategy: Object.freeze({ dir: "quality", file: "strategy-brief-loop.json", revisionDelta: "strategy-brief-revision-delta.json" }),
  signedReview: Object.freeze({ dir: "quality", file: "quality-loop-state.json" }),
  narratedRunRoot: Object.freeze([".media", "narrated-story-video"]),
  explainerWorkDir: "explainer",
});
export const ASSET_LOOP_STAGES = Object.freeze(["character", "location", "scene-image", "thumbnail", "voice-take", "video-clip"]);

const CLI_KINDS = Object.freeze({
  script: Object.freeze({ cli: "script-quality-loop.mjs", label: "台本の品質ループ", section: "script" }),
  asset: Object.freeze({ cli: "asset-quality-loop.mjs", label: "途中の成果物の品質ループ", section: "asset" }),
  strategy: Object.freeze({ cli: "strategy-brief.mjs", label: "企画ブリーフの品質ループ", section: "strategy" }),
});
const JOB_BOUND_KINDS = Object.freeze({
  narrated: Object.freeze({ label: "ナレーション物語の完成動画の品質ループ", jobPrefix: "video-narrated-story-video-" }),
  explainer: Object.freeze({ label: "解説動画の完成動画の品質ループ", jobPrefix: "video-explainer-video-" }),
});
/** 完成動画の品質ループを持つ Job の ID の頭（記録にこれが無ければ、Job の記録を探しに行かない）。 */
export const JOB_BOUND_JOB_ID_PREFIXES = Object.freeze(Object.values(JOB_BOUND_KINDS).map((spec) => spec.jobPrefix));
// 回を足す動詞。status・sheet・verdict は見るだけなので、この会話が回したループの手がかりにしない。
const DRIVING_ACTIONS = new Set(["start", "record"]);
const SUBJECT_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const JOB_ID_EXACT = /^video-[a-z0-9_-]+-[a-f0-9]{16}$/u;

// ツールの結果（出力）の中の文は数えない。案内の文（「start --work-dir ... から回す」）や、ファイルを読んだ中身に
// コマンドの形があっても、この会話が回したことにはならない。
const RESULT_TYPES = new Set([
  "tool_result", "function_call_output", "custom_tool_call_output", "local_shell_call_output",
  "exec_command_end", "exec_command_output_delta", "mcp_tool_call_end", "patch_apply_end",
]);
const RESULT_KEYS = new Set(["toolUseResult", "tool_use_result", "output", "aggregated_output", "formatted_output", "stdout", "stderr"]);
// 行ごと結果だけの行（Claude Code の tool_result の行、Codex の出力の行）は JSON を解かずに飛ばす。
// 記録の大半はファイルの中身やコマンドの出力で、ループの名前を含む行を全部解くと遅い。
const RESULT_LINE_MARKERS = Object.freeze([
  "\"toolUseResult\"", "\"type\":\"function_call_output\"", "\"type\":\"custom_tool_call_output\"",
  "\"type\":\"local_shell_call_output\"", "\"type\":\"exec_command_end\"", "\"type\":\"mcp_tool_call_end\"",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function bounded(value, limit) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function isAbsoluteAnywhere(value) {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

/** Windows の絶対パス（ドライブつき）だけは win32 で組む。それ以外はこの端末の path。 */
function pathApiFor(value) {
  return path.win32.isAbsolute(value) && !path.posix.isAbsolute(value) ? path.win32 : path;
}

function expandHome(value, home) {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(home, value.slice(2));
  return value;
}

// 引数として使える値か。<作業フォルダ> のような案内の置き字・シェルの変数・ワイルドカードは使わない。
function usableValue(value) {
  const text = nonEmpty(value);
  if (!text || text.length > 1024 || text.startsWith("-")) return "";
  if (/[<>{}$*\n\r\0`]/u.test(text)) return "";
  return text;
}

function resolveFrom(base, value, home) {
  const text = usableValue(value);
  if (!text) return "";
  const expanded = expandHome(text, home);
  if (isAbsoluteAnywhere(expanded)) return pathApiFor(expanded).resolve(expanded);
  if (!base || !isAbsoluteAnywhere(base)) return "";
  return pathApiFor(base).resolve(base, expanded);
}

// ---------------------------------------------------------------------------
// 会話の記録から、この会話が start / record したループを探す
// ---------------------------------------------------------------------------

/**
 * シェルのコマンド文を、区切り（; && || | & 改行 括弧）ごとの語の列に分ける。引用符は外す。
 * 引用符の外の \ は、空白・引用符・区切り・\ の前でだけ逃がしとして扱う（Windows のパスの区切りを残す）。
 */
export function splitShellSegments(text) {
  const segments = [];
  let tokens = [];
  let current = "";
  let started = false;
  let quote = "";
  const endToken = () => {
    if (started) tokens.push(current);
    current = "";
    started = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  const source = String(text || "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quote === "'") {
      if (char === "'") quote = "";
      else current += char;
      continue;
    }
    if (quote === "\"") {
      if (char === "\\" && (next === "\"" || next === "\\" || next === "$" || next === "`")) {
        current += next;
        index += 1;
      } else if (char === "\"") {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\") {
      if (next === "\n") { index += 1; continue; }
      if (next !== undefined && /[\s"'\\;&|()]/u.test(next)) {
        current += next;
        started = true;
        index += 1;
        continue;
      }
      current += char;
      started = true;
      continue;
    }
    if (char === ";" || char === "&" || char === "|" || char === "(" || char === ")" || char === "\n" || char === "\r") {
      endSegment();
      continue;
    }
    if (/\s/u.test(char)) {
      endToken();
      continue;
    }
    current += char;
    started = true;
  }
  endSegment();
  return segments;
}

/** 判定の持ち時間を使い切った印。呼び出し側は品質ループの判定だけを諦める（完成の主張の判定は生かす）。 */
export const LOOP_CHECK_DEADLINE_CODE = "LOOP_CHECK_DEADLINE";

function deadlineError() {
  const error = new Error("quality loop check ran out of time");
  error.code = LOOP_CHECK_DEADLINE_CODE;
  return error;
}

function mentionsLoopCli(text) {
  return text.includes("quality-loop") || text.includes("strategy-brief");
}

const CWD_FIELD = /"cwd"\s*:\s*"((?:[^"\\]|\\.){1,1024})"/u;

function cwdFieldOf(line) {
  const match = CWD_FIELD.exec(line);
  if (!match) return "";
  try {
    return nonEmpty(JSON.parse(`"${match[1]}"`));
  } catch {
    return "";
  }
}

function cliKindOfToken(token) {
  const base = String(token || "").split(/[\\/]/u).pop();
  for (const [kind, spec] of Object.entries(CLI_KINDS)) if (base === spec.cli) return kind;
  return "";
}

const OPTION_KEYS = Object.freeze({
  "--work-dir": "workDir", "--stage": "stage", "--subject": "subject", "--batch": "batch", "--brief": "brief",
});

/** 語の列の start 番目（スクリプトの語）から、動詞と場所の引数を読む。同じ引数は後の方を使う（CLI と同じ）。 */
function parseInvocation(tokens, start) {
  const action = tokens[start + 1] || "";
  const options = {};
  for (let index = start + 2; index < tokens.length; index += 1) {
    const token = tokens[index];
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    if (equals > 0) {
      const key = OPTION_KEYS[token.slice(0, equals)];
      if (key) options[key] = token.slice(equals + 1);
      continue;
    }
    const key = OPTION_KEYS[token];
    if (key && index + 1 < tokens.length) {
      options[key] = tokens[index + 1];
      index += 1;
    }
  }
  return { action, options };
}

function scriptLoopRef(workDir) {
  const layout = LOOP_STATE_LAYOUT.script;
  const dir = pathApiFor(workDir).join(workDir, layout.dir);
  return {
    kind: "script",
    workDir,
    statePath: pathApiFor(workDir).join(dir, layout.file),
    revisionDeltaPath: pathApiFor(workDir).join(dir, layout.revisionDelta),
  };
}

function strategyLoopRef(workDir) {
  const layout = LOOP_STATE_LAYOUT.strategy;
  const dir = pathApiFor(workDir).join(workDir, layout.dir);
  return {
    kind: "strategy",
    workDir,
    statePath: pathApiFor(workDir).join(dir, layout.file),
    revisionDeltaPath: pathApiFor(workDir).join(dir, layout.revisionDelta),
  };
}

function assetLoopRef(workDir, stage, subjectId) {
  if (!ASSET_LOOP_STAGES.includes(stage) || !SUBJECT_LABEL.test(subjectId)) return null;
  const api = pathApiFor(workDir);
  const dir = api.join(workDir, LOOP_STATE_LAYOUT.asset.dir);
  const base = `${stage}--${subjectId}`;
  return {
    kind: "asset",
    workDir,
    stage,
    subjectId,
    statePath: api.join(dir, `${base}.json`),
    revisionDeltaPath: api.join(dir, `${base}.revision-delta.json`),
  };
}

/** batch の対象の一覧（--batch）から工程と対象 id を読む。読めなければ空（手がかりにしない）。 */
function batchSubjects(file, fsApi) {
  try {
    const size = fsApi.statSync(file).size;
    if (size > MAX_BATCH_BYTES) return { stage: "", subjects: [] };
    const manifest = JSON.parse(fsApi.readFileSync(file, "utf8"));
    const items = Array.isArray(manifest?.items) ? manifest.items.slice(0, 50) : [];
    return {
      stage: nonEmpty(manifest?.stage),
      subjects: items.map((item) => nonEmpty(item?.subjectId)).filter((id) => SUBJECT_LABEL.test(id)),
    };
  } catch {
    return { stage: "", subjects: [] };
  }
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]{0,63})=(.*)$/su;

/**
 * 同じコマンド文の中で代入したシェルの変数（W=...; ... --work-dir $W）を展開する。知らない変数・展開できない値
 * （$(...) など）を含むときは空（その引数を手がかりにしない）。HOME だけは端末のものを使う。
 */
function expandVariables(value, variables, home) {
  const text = String(value ?? "");
  if (!text.includes("$")) return text;
  let failed = false;
  const expanded = text.replace(/\$\{([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu, (_match, braced, bare) => {
    const name = braced ?? bare;
    if (!VARIABLE_NAME.test(name)) { failed = true; return ""; }
    if (name === "HOME" && !variables.has(name)) return home;
    const known = variables.get(name);
    if (typeof known !== "string") { failed = true; return ""; }
    return known;
  });
  return failed || expanded.includes("$") ? "" : expanded;
}

/** 代入だけの語の列（W=... / export W=...）なら変数を覚えて true。 */
function recordAssignments(tokens, variables, home) {
  const list = tokens[0] === "export" ? tokens.slice(1) : tokens;
  if (list.length === 0 || !list.every((token) => ASSIGNMENT.test(token))) return false;
  for (const token of list) {
    const [, name, raw] = ASSIGNMENT.exec(token);
    const value = expandVariables(raw, variables, home);
    // 展開できない値（$(...) の結果など）は「知らない」として覚える（古い値で解かない）。
    variables.set(name, value || (raw === "" ? "" : null));
  }
  return true;
}

function refsFromInvocation(kind, { action, options }, base, { home, fsApi }) {
  if (!DRIVING_ACTIONS.has(action)) return [];
  if (kind === "script") {
    const workDir = resolveFrom(base, options.workDir, home);
    return workDir ? [scriptLoopRef(workDir)] : [];
  }
  if (kind === "strategy") {
    // 作業フォルダを省くと、ブリーフのあるフォルダを作業フォルダにする（scripts/strategy-brief.mjs と同じ）。
    let workDir = resolveFrom(base, options.workDir, home);
    if (!workDir) {
      const brief = resolveFrom(base, options.brief, home);
      if (brief) workDir = pathApiFor(brief).dirname(brief);
    }
    return workDir ? [strategyLoopRef(workDir)] : [];
  }
  const workDir = resolveFrom(base, options.workDir, home);
  if (!workDir) return [];
  const batch = resolveFrom(base, options.batch, home);
  if (batch) {
    const listed = batchSubjects(batch, fsApi);
    const stage = usableValue(options.stage) || listed.stage;
    return listed.subjects.map((subjectId) => assetLoopRef(workDir, stage, subjectId)).filter(Boolean);
  }
  const ref = assetLoopRef(workDir, usableValue(options.stage), usableValue(options.subject));
  return ref ? [ref] : [];
}

/**
 * 会話の記録（JSONL の行）から、この会話が start / record した品質ループを集める。新しく触ったものが先。
 * 記録の形（Claude Code の JSONL・Codex の rollout）に依らないよう JSON を再帰的に歩き、コマンドの文字列と
 * 語の配列を見る。相対の --work-dir は、そのコマンドの作業場所（cd・行の cwd・workdir）から解く。
 */
export function collectQualityLoopReferences(lines, { cwd = "", home = homedir(), fsApi = fs, deadline = Infinity } = {}) {
  let order = 0;
  const found = new Map();
  const add = (refs) => {
    for (const ref of refs) {
      order += 1;
      found.set(ref.statePath, { ...ref, order });
    }
  };
  const fromSegments = (segments, base) => {
    let current = base;
    const variables = new Map();
    for (const tokens of segments) {
      if (recordAssignments(tokens, variables, home)) continue;
      if (tokens[0] === "cd" && tokens[1]) {
        const moved = resolveFrom(current, expandVariables(tokens[1], variables, home), home);
        if (moved) current = moved;
        continue;
      }
      for (let index = 0; index < tokens.length; index += 1) {
        const kind = cliKindOfToken(tokens[index]);
        if (!kind) continue;
        const { action, options } = parseInvocation(tokens, index);
        const expanded = Object.fromEntries(Object.entries(options).map(([key, value]) => [key, expandVariables(value, variables, home)]));
        add(refsFromInvocation(kind, { action, options: expanded }, current, { home, fsApi }));
      }
    }
  };
  const fromText = (text, base) => {
    if (text.length <= MAX_TOKENIZE_CHARS) {
      fromSegments(splitShellSegments(text), base);
      return;
    }
    // 大きな文字列は、スクリプトの名前の前後だけを見る。
    const pattern = /script-quality-loop|asset-quality-loop|strategy-brief/gu;
    let seen = 0;
    for (const match of text.matchAll(pattern)) {
      if ((seen += 1) > 20) break;
      const from = Math.max(0, text.lastIndexOf("\n", Math.max(0, match.index - TOKENIZE_WINDOW)));
      const to = text.indexOf("\n", match.index + TOKENIZE_WINDOW);
      fromSegments(splitShellSegments(text.slice(from, to < 0 ? undefined : to)), base);
    }
  };
  const walk = (value, base, depth, inResult) => {
    if (depth > MAX_WALK_DEPTH || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (inResult || !mentionsLoopCli(value)) return;
      const trimmed = value.trimStart();
      if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && value.length <= MAX_NESTED_JSON_CHARS) {
        try {
          walk(JSON.parse(value), base, depth + 1, inResult);
          return;
        } catch { /* JSON でない文字列 */ }
      }
      fromText(value, base);
      return;
    }
    if (Array.isArray(value)) {
      // Codex の command: ["node", "scripts/script-quality-loop.mjs", "record", ...] のような語の配列。
      if (!inResult && value.length > 1 && value.every((item) => typeof item === "string") && value.some((item) => cliKindOfToken(item))) {
        fromSegments([value], base);
        return;
      }
      for (const item of value) walk(item, base, depth + 1, inResult);
      return;
    }
    if (typeof value === "object") {
      const inside = inResult || RESULT_TYPES.has(typeof value.type === "string" ? value.type : "");
      let here = base;
      for (const key of ["workdir", "working_directory", "cwd"]) {
        const dir = nonEmpty(value[key]);
        if (dir && isAbsoluteAnywhere(dir)) {
          here = dir;
          break;
        }
      }
      for (const [key, child] of Object.entries(value)) walk(child, here, depth + 1, inside || RESULT_KEYS.has(key));
    }
  };
  // 会話の作業場所（Claude Code は各行の cwd、Codex は turn_context / session_meta の payload.cwd）。
  // ループに触れない行は JSON を解かない（記録は数十 MB になる）。行に cwd の無いコマンドのときだけ、
  // 前の行を遡って cwd の欄を拾う。
  const list = Array.isArray(lines) ? lines : [];
  const inputBase = nonEmpty(cwd) && isAbsoluteAnywhere(nonEmpty(cwd)) ? nonEmpty(cwd) : "";
  const baseBefore = (lineIndex) => {
    for (let index = lineIndex - 1; index >= 0 && index >= lineIndex - 2_000; index -= 1) {
      const line = list[index];
      if (typeof line !== "string" || !line.includes("\"cwd\"")) continue;
      const lineCwd = cwdFieldOf(line);
      if (lineCwd && isAbsoluteAnywhere(lineCwd)) return lineCwd;
    }
    return inputBase;
  };
  for (const [lineIndex, line] of list.entries()) {
    if ((lineIndex & 255) === 0 && Date.now() > deadline) throw deadlineError();
    if (typeof line !== "string" || !line || !mentionsLoopCli(line)) continue;
    if (RESULT_LINE_MARKERS.some((marker) => line.includes(marker))) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { entry = line; }
    const own = plainObject(entry) ? nonEmpty(entry.cwd) || nonEmpty(entry.payload?.cwd) : "";
    walk(entry, own && isAbsoluteAnywhere(own) ? own : baseBefore(lineIndex), 0, false);
  }
  return [...found.values()]
    .sort((left, right) => right.order - left.order)
    .slice(0, MAX_LOOP_REFS)
    .map(({ order: _order, ...ref }) => ref);
}

// ---------------------------------------------------------------------------
// 完成動画のループ（Job の作業領域）
// ---------------------------------------------------------------------------

/** Job ID から、完成動画の品質ループを持つハーネスかを見る。 */
export function jobBoundLoopKind(jobId) {
  const id = String(jobId || "");
  if (!JOB_ID_EXACT.test(id)) return "";
  for (const [kind, spec] of Object.entries(JOB_BOUND_KINDS)) if (id.startsWith(spec.jobPrefix)) return kind;
  return "";
}

/**
 * 完成動画のループの状態ファイル。ナレーション物語は <project>/.media/narrated-story-video/<Job>/quality/、
 * 解説動画は <project>/canvas/harness-runs/<Job>/explainer/quality/（lib/narratedStoryPipeline.mjs の
 * narratedStoryRunPaths、lib/explainerVideo.mjs の EXPLAINER_WORK_DIR と同じ置き場）。
 */
export function jobBoundLoopRef({ jobId, projectDir, runDir }) {
  const kind = jobBoundLoopKind(jobId);
  if (!kind) return null;
  const layout = LOOP_STATE_LAYOUT.signedReview;
  if (kind === "narrated") {
    if (!nonEmpty(projectDir)) return null;
    const api = pathApiFor(projectDir);
    return { kind, jobId, statePath: api.join(projectDir, ...LOOP_STATE_LAYOUT.narratedRunRoot, jobId, layout.dir, layout.file) };
  }
  if (!nonEmpty(runDir)) return null;
  const api = pathApiFor(runDir);
  return { kind, jobId, statePath: api.join(runDir, LOOP_STATE_LAYOUT.explainerWorkDir, layout.dir, layout.file) };
}

// ---------------------------------------------------------------------------
// 子の作業場所（linked worktree）
// ---------------------------------------------------------------------------

/**
 * 会話の作業場所が git の linked worktree（並列の子が使う作業場所）か。.git がファイルで、gitdir が
 * <本体>/.git/worktrees/<名前> を指すものだけを数える（submodule の .git ファイルは数えない）。
 */
export function isLinkedWorktreeDir(cwd, { fsApi = fs } = {}) {
  const start = nonEmpty(cwd);
  if (!start || !isAbsoluteAnywhere(start)) return false;
  if (/[\\/]\.(?:claude|codex)[\\/]worktrees[\\/]/u.test(`${start}/`)) return true;
  const api = pathApiFor(start);
  let dir = api.resolve(start);
  for (let depth = 0; depth < 64; depth += 1) {
    const gitPath = api.join(dir, ".git");
    let info = null;
    try { info = fsApi.statSync(gitPath); } catch { info = null; }
    if (info) {
      if (!info.isFile() || info.size > 4096) return false;
      let text = "";
      try { text = fsApi.readFileSync(gitPath, "utf8"); } catch { return false; }
      const match = /^gitdir:\s*(.+?)\s*$/mu.exec(text);
      return Boolean(match && /[\\/]worktrees[\\/][^\\/]+[\\/]?$/u.test(match[1]));
    }
    const parent = api.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 状態ファイルを読んで分ける
// ---------------------------------------------------------------------------

/** 状態ファイルを読む。{ missing } / { broken, problem, digest } / { state, digest }。 */
export function readLoopStateFile(statePath, { fsApi = fs } = {}) {
  let bytes;
  try {
    const info = fsApi.statSync(statePath);
    if (!info.isFile()) return { broken: true, problem: "not-a-file", digest: "" };
    if (info.size > MAX_STATE_BYTES) return { broken: true, problem: "too-large", digest: "" };
    bytes = fsApi.readFileSync(statePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { missing: true };
    return { broken: true, problem: "unreadable", digest: "" };
  }
  const digest = sha256(bytes);
  let state;
  try {
    state = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { broken: true, problem: "json", digest };
  }
  if (!plainObject(state) || !nonEmpty(state.status) || !Array.isArray(state.rounds)) {
    return { broken: true, problem: "shape", digest };
  }
  return { state, digest };
}

/** そのループで採点に使われた評価文脈（回の評価と、開いている評価の組）。 */
function evaluatorContextsOf(state) {
  const contexts = [];
  for (const round of Array.isArray(state?.rounds) ? state.rounds : []) {
    for (const review of Array.isArray(round?.reviews) ? round.reviews : []) contexts.push(nonEmpty(review?.evaluatorContextId));
  }
  const panel = state?.script?.pendingPanel?.reviews;
  for (const review of Array.isArray(panel) ? panel : []) contexts.push(nonEmpty(review?.evaluatorContextId));
  return contexts.filter(Boolean);
}

/** この会話（会話の ID）が、そのループの評価者として記録されているか。 */
export function sessionIsLoopEvaluator(state, sessionId) {
  const id = nonEmpty(sessionId);
  if (id.length < 8) return false;
  return evaluatorContextsOf(state).some((context) => context === id || context.includes(id));
}

function pendingPanelReviews(state) {
  const reviews = state?.script?.pendingPanel?.reviews;
  return Array.isArray(reviews) ? reviews.length : 0;
}

/** 同じ周回かを見分ける印。始めた時刻（始め直しで変わる）・記録した回の数・組に入った採点の数。 */
function activeMark(state) {
  return `active|${nonEmpty(state.startedAt)}|${state.rounds.length}|${pendingPanelReviews(state)}`;
}

/**
 * ループを分ける。category は missing / broken / active（差し戻す）/ human（人の判断待ち）/ settled（合格）/
 * evaluator（この会話がそのループの評価者）。続いているのは status が active のものだけ。知らない状態名は
 * 人の判断待ちとして扱う（止めない側）。
 */
export function classifyLoopState(ref, read, { sessionId = "" } = {}) {
  if (read.missing) return { category: "missing" };
  if (read.broken) return { category: "broken", problem: read.problem, mark: `broken|${read.digest || read.problem}` };
  const { state } = read;
  const section = CLI_KINDS[ref.kind]?.section;
  if (section && !plainObject(state[section])) return { category: "broken", problem: "shape", mark: `broken|${read.digest}` };
  if (state.status === "passed") return { category: "settled" };
  if (state.status !== "active") return { category: "human" };
  // 完成動画のループは、続きに新しい出力（有料の作り直しか、チャンネルの新しい納品）と人の署名が要る。
  // Job は awaiting-human-review で待っているので、正当な停止として扱う。
  if (JOB_BOUND_KINDS[ref.kind]) return { category: "human" };
  if (sessionIsLoopEvaluator(state, sessionId)) return { category: "evaluator" };
  return { category: "active", mark: activeMark(state) };
}

export function loopMarkKey(statePath) {
  return sha256(String(statePath)).slice(0, 32);
}

// ---------------------------------------------------------------------------
// reason
// ---------------------------------------------------------------------------

function contractOf(ref, state) {
  const section = CLI_KINDS[ref.kind]?.section;
  return section ? state?.[section]?.contract : null;
}

function listText(label, values) {
  const list = (Array.isArray(values) ? values : []).map((value) => bounded(value, 60)).filter(Boolean);
  if (list.length === 0) return "";
  return `${label}: ${list.slice(0, 4).join(", ")}${list.length > 4 ? ` 他${list.length - 4}件` : ""}`;
}

/** いまの周回と点数。合格点は書かない（作る係の文脈から評価者へ渡る道を作らない）。 */
export function loopRoundSummary(ref, state) {
  const rounds = Array.isArray(state?.rounds) ? state.rounds : [];
  const last = rounds.at(-1);
  const parts = [];
  if (!last) parts.push("まだ1回も採点を記録していない");
  else {
    const target = Number(contractOf(ref, state)?.limits?.targetScore);
    const notes = [];
    if (Number.isFinite(target) && Number(last.score) < target) notes.push("目標未達");
    for (const text of [
      listText("下限割れ", last.floorFailures),
      listText("落ちた機械ゲート", last.failedGateIds),
      listText("直っていない指摘", last.unresolvedFindingIds),
    ]) if (text) notes.push(text);
    parts.push(`${rounds.length} 回目まで記録。直近 ${bounded(last.score, 12)} 点（${notes.join("・") || "合格の条件を満たしていない"}）`);
    if (nonEmpty(last.failureFingerprint)) parts.push(`失敗指紋 ${bounded(last.failureFingerprint, 80)}`);
  }
  const panel = state?.script?.pendingPanel;
  if (plainObject(panel)) {
    const declared = Array.isArray(panel.declaredEvaluators) ? panel.declaredEvaluators.length : 0;
    parts.push(`版 ${bounded(panel.versionLabel, 40)} の評価の組は ${pendingPanelReviews(state)}/${declared} 件そろった`);
  }
  return parts.join("。");
}

function lastVersionFile(ref, state) {
  const field = { script: ["script", "scriptPath"], asset: ["asset", "assetPath"], strategy: ["strategy", "briefPath"] }[ref.kind];
  if (!field) return "";
  const versions = state?.[field[0]]?.versions;
  const rel = nonEmpty(Array.isArray(versions) ? versions.at(-1)?.[field[1]] : "");
  if (!rel || !ref.workDir) return "";
  return pathApiFor(ref.workDir).resolve(ref.workDir, rel);
}

function quoted(value) {
  return `"${bounded(value, 300)}"`;
}

function statusCommand(ref) {
  const cli = CLI_KINDS[ref.kind]?.cli;
  if (!cli) return "";
  const where = `--work-dir ${quoted(ref.workDir)}`;
  if (ref.kind === "asset") return `node scripts/${cli} status ${where} --stage ${ref.stage} --subject ${ref.subjectId}`;
  return `node scripts/${cli} status ${where}`;
}

function loopPlace(ref) {
  if (JOB_BOUND_KINDS[ref.kind]) return `Job ${ref.jobId}`;
  if (ref.kind === "asset") return `${ref.stage} / ${ref.subjectId}、作業フォルダ ${bounded(ref.workDir, 300)}`;
  return `作業フォルダ ${bounded(ref.workDir, 300)}`;
}

function loopLabel(ref) {
  return CLI_KINDS[ref.kind]?.label || JOB_BOUND_KINDS[ref.kind]?.label || "品質ループ";
}

const BROKEN_PROBLEMS = Object.freeze({
  json: "JSON として壊れている",
  shape: "品質ループの状態の形になっていない",
  unreadable: "開けない",
  "not-a-file": "ファイルではない",
  "too-large": "大きすぎる",
});

// 5つの手順。記事の Stop フックが毎周 reason に入れる「次にやること」を、BuzzAssist のループの動詞で書いた。
const NEXT_STEPS = "次の手順: 1) status で前の回の点数と指摘を読む 2) 指摘ごとに採否を決めて版を直し、何をどう直したかを revision-delta に書く"
  + " 3) sheet の出力と直した版だけを、作った文脈とも前の回とも別の新しい評価文脈に渡して採点させる（合格点・前の回の点・ループのソースは渡さない）"
  + " 4) record で記録する 5) 合格・上限・人の判断待ちのどれかになるまで 1〜4 を繰り返す。";
const PAID_AND_HUMAN = "有料の生成・外部モデルの呼び出しが要る手順は、運営者の明示の確認があるときだけ進める。確認が無い、または人の判断が要るなら、"
  + "周回・点数・次の手順を報告して止まる（この差し戻しは同じ周回では1回だけ）。stop・accept-human・--human-verified は人が打つもので、自分では打たない。"
  + "この会話が採点する側（評価者）なら、版を直さず、記録した採点だけを報告して止まる（作る係と評価者を混ぜない）。";

// 時計は unref しない（待っている間にイベントループが空になると、差し戻しを書かずにプロセスが終わる）。
async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 途中の成果物のループが続いているときの案内。lib/assetQualityLoop.mjs の nextStepDetail の active の枝と同じ文
 * （試験が assetQualityStatus の detail と突き合わせる）。あちらを import すると canvasScene.mjs 経由で npm の依存を
 * 読み、フックが走るホストの plugin キャッシュ（node_modules が無い）では読み込めないため、ここに写す。
 */
export function assetActiveLoopDetail(state, ref) {
  const round = Array.isArray(state?.rounds) ? state.rounds.at(-1) : null;
  if (!round) return "最初の版を、作った文脈とは別の評価文脈で採点して record する";
  return `次の版には、前回の失敗指紋（${round.failureFingerprint}）と、それをどう直したかの両方が要る。`
    + ` --previous-failure ${round.failureFingerprint} --revision-delta "直した内容" を付けるか、`
    + `${ref.revisionDeltaPath} に { "previousFailureFingerprint": "${round.failureFingerprint}", "revisionDelta": "直した内容" } を書く。`
    + "採点は、前の回で使っていない評価文脈で行う";
}

/**
 * 各ループの status の detail（ループが自分で書く「次に何をすれば進むか」の文）を読む。差し戻すときだけ読み込む。
 * 台本と企画ブリーフのループは Node の組み込みしか import しないので、そのまま status を呼ぶ。
 */
export async function defaultLoopDetail(ref, state = null) {
  if (ref.kind === "script") {
    const { scriptQualityStatus } = await import("./scriptQualityLoop.mjs");
    return (await scriptQualityStatus({ workDir: ref.workDir })).detail;
  }
  if (ref.kind === "asset") return assetActiveLoopDetail(state, ref);
  if (ref.kind === "strategy") {
    const { strategyBriefStatus } = await import("./strategyBriefQualityLoop.mjs");
    return (await strategyBriefStatus({ workDir: ref.workDir })).detail;
  }
  return "";
}

async function detailText(ref, state, loadDetail, timeoutMs) {
  try {
    const detail = await withTimeout(Promise.resolve().then(() => loadDetail(ref, state)), timeoutMs);
    return typeof detail === "string" ? bounded(detail, 700) : "";
  } catch {
    return "";
  }
}

/** 差し戻しの reason。続いているループは周回・点数・次に読むファイル・次の手順、壊れた状態は直すよう短く。 */
export async function buildQualityLoopStopReason(findings, { loadDetail = defaultLoopDetail, timeoutMs = DETAIL_TIMEOUT_MS } = {}) {
  const lines = [];
  const active = findings.filter((entry) => entry.verdict.category === "active");
  const broken = findings.filter((entry) => entry.verdict.category === "broken");
  if (active.length > 0) {
    lines.push(`${QUALITY_LOOP_REASON_PREFIX} この会話で回した品質ループが、合格・人の判断待ち・止まる条件のどれにもならないまま止まろうとしている。`);
    for (const [index, { ref, state }] of active.entries()) {
      lines.push(`・${loopLabel(ref)}（${loopPlace(ref)}）: ${loopRoundSummary(ref, state)}。`);
      if (index < MAX_DETAILED_LOOPS) {
        const detail = await detailText(ref, state, loadDetail, timeoutMs);
        lines.push(`  ループの案内: ${detail ||"直した版を、作った文脈とも前の回とも別の評価文脈で採点して record する"}`);
      }
      const files = [
        `状態 ${bounded(ref.statePath, 300)}（前の回の点数と指摘）`,
        lastVersionFile(ref, state) ? `最後の版 ${bounded(lastVersionFile(ref, state), 300)}` : "",
        ref.revisionDeltaPath && (state.rounds || []).length > 0 ? `直した内容の置き場 ${bounded(ref.revisionDeltaPath, 300)}` : "",
      ].filter(Boolean);
      lines.push(`  次に読むファイル: ${files.join("、")}`);
      lines.push(`  確かめる: ${statusCommand(ref)}`);
    }
    lines.push(NEXT_STEPS);
    lines.push(PAID_AND_HUMAN);
  }
  for (const { ref, verdict } of broken) {
    lines.push(`${QUALITY_LOOP_REASON_PREFIX} ${loopLabel(ref)}（${loopPlace(ref)}）の状態ファイルが読めない`
      + `（${BROKEN_PROBLEMS[verdict.problem] || "開けない"}）: ${bounded(ref.statePath, 300)}。合格とは扱わない。手で合格に書き換えず、壊れた原因（途中で切れた書き込み・手での編集など）を確かめて直す。`
      + "直せなければ、読めないことを運営者に伝えて止まる。");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 判定の本体
// ---------------------------------------------------------------------------

/**
 * 品質ループの続きの判定。呼び出し側（scripts/harness-stop-hook.mjs）は、Stop 以外・子の印・subagent・
 * stop_hook_active・会話の ID が無いときを先に落としてから呼ぶ。
 * 戻り値の action は none か block。block のときは loopMarks（付箋: { key, mark }）を記録してから差し戻す。
 *
 * - lines: 会話の記録の行、blockState: 会話ごとの差し戻しの記録（loops に付箋）
 * - sessionId: この会話の ID（評価者として記録されたループを見分ける）
 * - jobLoopRefs: この会話で扱った Job の完成動画のループ（jobBoundLoopRef の形）
 * - loadDetail: ループの status の detail を読む関数（試験で差し替える）
 * - deadline: この時刻（Date.now() の値）を過ぎたら判定を諦めて none（見張りの時計より前に置く）
 */
export async function evaluateQualityLoopStop({
  cwd = "",
  sessionId = "",
  lines = [],
  home = homedir(),
  fsApi = fs,
  blockState = null,
  jobLoopRefs = [],
  loadDetail = defaultLoopDetail,
  detailTimeoutMs = DETAIL_TIMEOUT_MS,
  deadline = Infinity,
} = {}) {
  if (isLinkedWorktreeDir(cwd, { fsApi })) return { action: "none", why: "worktree-child" };
  let collected;
  try {
    collected = collectQualityLoopReferences(lines, { cwd, home, fsApi, deadline });
  } catch (error) {
    if (error?.code === LOOP_CHECK_DEADLINE_CODE) return { action: "none", why: "loop-check-timeout" };
    throw error;
  }
  const refs = [...collected, ...(Array.isArray(jobLoopRefs) ? jobLoopRefs.filter(Boolean) : [])];
  if (refs.length === 0) return { action: "none", why: "no-loop" };
  const marks = plainObject(blockState?.loops) ? blockState.loops : {};
  const findings = [];
  const seen = new Set();
  for (const ref of refs) {
    if (seen.has(ref.statePath)) continue;
    seen.add(ref.statePath);
    const read = readLoopStateFile(ref.statePath, { fsApi });
    const verdict = classifyLoopState(ref, read, { sessionId });
    if (verdict.category !== "active" && verdict.category !== "broken") continue;
    const key = loopMarkKey(ref.statePath);
    // 付箋: この周回（壊れた状態なら、この中身）では、もう差し戻した。
    if (marks[key]?.mark === verdict.mark) continue;
    findings.push({ ref, verdict, state: read.state || null, key });
    if (findings.length >= MAX_LISTED_LOOPS) break;
  }
  if (findings.length === 0) return { action: "none", why: "loops-settled-or-noted" };
  // 案内の文を読む時間は、持ち時間の残りから（残りが無ければ読まずに既定の文で差し戻す）。
  const remaining = Number.isFinite(deadline) ? deadline - Date.now() - 500 : detailTimeoutMs;
  return {
    action: "block",
    why: findings.some((entry) => entry.verdict.category === "active") ? "loop-active" : "loop-state-broken",
    reason: await buildQualityLoopStopReason(findings, {
      loadDetail: remaining > 0 ? loadDetail : () => "",
      timeoutMs: Math.max(1, Math.min(detailTimeoutMs, remaining)),
    }),
    loopMarks: findings.map((entry) => ({ key: entry.key, mark: entry.verdict.mark })),
  };
}

/** 付箋を足した loops を返す（古いものから MAX_LOOP_MARKS を超えた分を捨てる）。 */
export function withLoopMarks(loops, loopMarks, at) {
  const next = { ...(plainObject(loops) ? loops : {}) };
  for (const { key, mark } of Array.isArray(loopMarks) ? loopMarks : []) {
    const previous = Number(next[key]?.blocks || 0);
    next[key] = { mark: String(mark), blocks: previous + 1, lastBlockedAt: String(at) };
  }
  const entries = Object.entries(next);
  if (entries.length <= MAX_LOOP_MARKS) return next;
  entries.sort((left, right) => String(right[1]?.lastBlockedAt || "").localeCompare(String(left[1]?.lastBlockedAt || "")));
  return Object.fromEntries(entries.slice(0, MAX_LOOP_MARKS));
}
