#!/usr/bin/env node
// ユーザーの訂正らしい発言に気づいたら、エージェントへ「capture すること」を短く伝える
// UserPromptSubmit フック（Claude Code / Codex 共通）。
//
// 自己改善は「エージェントが思い出したときだけ」動いていた。SKILL.md は
// 「さっきも言った」と言われたら capture せよと書いているが、言われた瞬間に
// エージェントがそれを思い出す保証は無い。ホストはユーザーの発言をフックへ渡せるので、
// 訂正・禁止・繰り返しの言い回しがあれば、エージェントの文脈へ1段落を足す。
//
// このフックがしないこと（どれも意図的）:
//
//   - **何も書き換えない・何も捕捉しない**。capture するかどうかはエージェントが決める
//     （フックが台帳へ書くと、言い回しが当たっただけの誤検知が提案として積もる）
//   - **発言本文をどこにも保存しない**。数えるときもリポジトリ外に sha256 と時刻だけ
//   - **入力を止めない**。常に exit 0、ブロックの判定は出さない。壊れた入力・遅い入力・
//     例外のどれでも、何も出さずに終わる
//   - **動画制作 Job に介入しない**。何も実行せず、何も待たない
//
// 誤検知しにくい言い回しに絞っている。「違う」単独は「違うファイル」のような普通の
// 文にも出るので、文頭か「それは違う」の形だけを見る。
//
// もう1つ、**回数で起動する振り返り**を持つ（lib/harnessLearningReflection.mjs）。
// 訂正の言い回しを伴わない好み・禁止事項・実測の事実は、この検知では拾えない。
// 会話ごとにユーザーの発言の回数だけを数え、既定で 10 回ごとに「この会話で残すものが
// あれば capture する」の短い促しを足す。capture で0に戻る。数えるのは回数と時刻だけで、
// 間隔は BUZZASSIST_LEARNING_REFLECT_EVERY（0 で止まる）。フックの定義（起動行）は変えない
// ——Codex はフックの定義の hash で信頼を記録するので、変えると信頼し直しになる。

import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import { buildReflectionContext, countPromptForReflection } from "../lib/harnessLearningReflection.mjs";
import { operatorLearningStateDir } from "../lib/harnessLearningState.mjs";

/**
 * 数えるだけの記録先。"off" で記録しない。既定は学習の状態の置き場（~/.buzzassist/learning/、
 * BUZZASSIST_LEARNING_DIR で上書き可）。どのホスト・どの版の写しから動いても同じファイルへ書く。
 */
export const HOOK_EVENT_LOG_ENV = "BUZZASSIST_LEARNING_HOOK_LOG";
const LEARNING_WRITE_FORBIDDEN_ENV = "BUZZASSIST_LEARNING_WRITE_FORBIDDEN";
const HARD_TIMEOUT_MS = 1500;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_SCAN_CHARS = 20_000;

const HOOK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CORRECTION_PATTERNS = Object.freeze([
  // 繰り返しの指摘: 「さっきも言った」「前にも伝えた」「何度も言ってる」
  { kind: "repeat", label: "繰り返しの指摘", pattern: /(?:さっき|先ほど|前に|以前に?|この前|何度|何回|昨日)も(?:言|伝え|指摘|お願い)(?:っ|い|し|え|た|わ)/u },
  { kind: "repeat", label: "繰り返しの指摘", pattern: /また同じ(?:ミス|間違い|間違え|失敗|こと)/u },
  // 否定・訂正: 文頭の「違う」、「それは違う」「そうじゃない」「間違ってる」
  { kind: "correction", label: "訂正", pattern: /^\s*(?:違う|違います|ちがう|ちゃう)(?:[。、,.!！?？\s]|よ|って|$)/u },
  { kind: "correction", label: "訂正", pattern: /(?:それ|そこ|これ|あれ)(?:は|、)?\s*(?:違う|違います|ちがう|間違(?:い|って))/u },
  { kind: "correction", label: "訂正", pattern: /そうじゃな(?:い|くて)|そうではな(?:い|く)/u },
  { kind: "correction", label: "訂正", pattern: /間違って(?:る|います|いる|ますよ)/u },
  // 禁止: 「〜しないで（ください）」「やめて」
  { kind: "constraint", label: "禁止", pattern: /[ぁ-ん]ないで(?:ください|下さい|ほしい|欲しい|くれ|ね|よ)?(?:[。！!、,\s]|$)/u },
  { kind: "constraint", label: "禁止", pattern: /やめて(?:ください|下さい|ほしい|欲しい|くれ|ね|よ)?(?:[。！!、,\s]|$)/u },
  // English
  { kind: "repeat", label: "繰り返しの指摘", pattern: /\b(?:I (?:already|just) (?:told|said)|as I (?:said|told you) before|I told you (?:already|before))\b/iu },
  { kind: "correction", label: "訂正", pattern: /\bthat'?s (?:wrong|not what I (?:asked|meant|said))\b/iu },
  { kind: "constraint", label: "禁止", pattern: /\b(?:don'?t (?:ever )?do that|stop doing (?:that|this))\b/iu },
]);

/** 発言に訂正・禁止・繰り返しの言い回しがあるか。本文は返さない。 */
export function analyzeUserPrompt(prompt) {
  const text = typeof prompt === "string" ? prompt.slice(0, MAX_SCAN_CHARS) : "";
  if (!text.trim()) return { matched: false, kinds: [], labels: [] };
  const hits = CORRECTION_PATTERNS.filter(({ pattern }) => pattern.test(text));
  const kinds = [...new Set(hits.map((hit) => hit.kind))];
  const labels = [...new Set(hits.map((hit) => hit.label))];
  return { matched: hits.length > 0, kinds, labels };
}

/** ホストが渡す JSON から発言を取り出す。Claude Code は user_prompt、Codex と旧版は prompt。 */
export function promptFromHookInput(input) {
  if (!input || typeof input !== "object") return "";
  const value = input.user_prompt ?? input.prompt;
  return typeof value === "string" ? value : "";
}

const DEFAULT_LEARN_SCRIPT = path.join(HOOK_ROOT, "scripts", "harness-learn.mjs");

export function buildAdditionalContext(analysis, { learnScript = DEFAULT_LEARN_SCRIPT, sessionToken = "" } = {}) {
  // 会話 ID が分かれば --session に入れて渡す（capture がその会話の振り返りの数を0に戻せるように）。
  const session = sessionToken || "<この会話のID>";
  return [
    `[BuzzAssist 自己改善] 直前の発言に「${analysis.labels.join("・")}」らしい言い回しがあります。`,
    "こちらの誤りの訂正・禁止事項・繰り返しの指摘に当たるなら、harness-self-improvement スキルに従い、",
    `その場で \`node "${learnScript}" capture --kind <correction|constraint|preference> --target <宛先> --text "何をどう直すか" --evidence "何を観測したか" --session "${session}"\` で提案として残してください。`,
    "発言を逐語で写さず、何を直すかの形に書き直すこと。当たらなければ何もしなくてよい（提案ゼロは正常）。",
  ].join("\n");
}

/**
 * フックの応答を作る。何も足さないときは null。副作用は無い（数えるのは呼び出し側）。
 * UserPromptSubmit 以外のイベントと、子エージェント（学習を書かない印あり）には何も返さない。
 *
 * @param reflection countPromptForReflection の結果。due のときだけ振り返りの一段落を足す。
 */
export function buildHookResponse(input, { env = process.env, learnScript, reflection = null } = {}) {
  const event = String(input?.hook_event_name ?? "UserPromptSubmit");
  if (event !== "UserPromptSubmit") return null;
  const forbidden = String(env?.[LEARNING_WRITE_FORBIDDEN_ENV] ?? "").trim();
  if (forbidden !== "" && forbidden !== "0") return null;
  if (input && typeof input === "object" && input.agent_id) return null;
  const analysis = analyzeUserPrompt(promptFromHookInput(input));
  const reflect = reflection?.counted === true && reflection?.due === true;
  if (!analysis.matched && !reflect) return null;
  const script = learnScript ? { learnScript } : {};
  const parts = [];
  if (analysis.matched) parts.push(buildAdditionalContext(analysis, { ...script, sessionToken: reflection?.sessionToken || "" }));
  if (reflect) parts.push(buildReflectionContext(reflection, { learnScript: learnScript || DEFAULT_LEARN_SCRIPT }));
  return {
    analysis,
    reflection: reflect ? { count: reflection.count, interval: reflection.interval } : null,
    output: {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: parts.join("\n\n"),
      },
    },
  };
}

/** 数えるだけの記録先。リポジトリの外に置く（台帳と混ぜない・公開面に出さない）。 */
export function hookEventLogPath(env = process.env, home = homedir()) {
  const configured = String(env?.[HOOK_EVENT_LOG_ENV] ?? "").trim();
  if (configured === "off") return null;
  if (configured) return path.resolve(configured);
  return path.join(operatorLearningStateDir({ env, homeDir: home }), "hook-events.jsonl");
}

export const HOOK_HOSTS = Object.freeze(["claude", "codex"]);

/**
 * どのホストから呼ばれたか。記録に残して、Codex で信頼されていない（動いていない）フックを
 * 記録の偏りから見つけられるようにする。
 *
 *   1. 起動行の明示（Claude Code の起動行は `--host claude` を渡す）
 *   2. Codex だけが持つ手がかり: 入力の turn_id、環境変数 PLUGIN_ROOT
 *      （Codex は互換のため CLAUDE_PLUGIN_ROOT も渡すので、こちらを先に見る）
 *   3. 写しの置き場（~/.codex/plugins/cache か ~/.claude/plugins/cache か）
 *   4. CLAUDE_PLUGIN_ROOT だけがある → Claude Code
 *
 * Codex の起動行は変えない。変えるとフックの定義の hash が変わり、運営者が信頼し直すまで動かなくなる。
 */
export function detectHookHost({ explicit = "", input = null, env = process.env, hookRoot = HOOK_ROOT } = {}) {
  const named = String(explicit || "").trim().toLowerCase();
  if (HOOK_HOSTS.includes(named)) return named;
  if (input && typeof input === "object" && typeof input.turn_id === "string" && input.turn_id) return "codex";
  if (String(env?.PLUGIN_ROOT ?? "").trim()) return "codex";
  const parts = path.resolve(String(hookRoot || "")).split(/[\\/]+/u);
  const cacheAt = parts.findIndex((part, index) => part === "plugins" && parts[index + 1] === "cache");
  if (cacheAt > 0 && parts[cacheAt - 1] === ".codex") return "codex";
  if (cacheAt > 0 && parts[cacheAt - 1] === ".claude") return "claude";
  if (String(env?.CLAUDE_PLUGIN_ROOT ?? "").trim()) return "claude";
  return "unknown";
}

/** 時刻・ホスト・sha256 だけを1行追記する。失敗しても黙って終わる（入力を止めない）。 */
export function recordHookEvent(prompt, { env = process.env, now = () => new Date().toISOString(), home = homedir(), host = "unknown" } = {}) {
  try {
    const file = hookEventLogPath(env, home);
    if (!file) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const recordedHost = HOOK_HOSTS.includes(host) ? host : "unknown";
    const line = `${JSON.stringify({ at: String(now()), host: recordedHost, sha256: createHash("sha256").update(String(prompt), "utf8").digest("hex") })}\n`;
    fs.appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
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
 * CLI 本体。どの経路でも exit 0 で終わり、応答が無ければ何も出さない。
 * Codex のフックは `node -e` の起動子からこの関数を呼ぶ（シェルに依らず plugin root を解決するため）。
 */
function hostFromArgv(argv = []) {
  const index = argv.indexOf("--host");
  return index >= 0 ? String(argv[index + 1] || "") : "";
}

export async function runHookCli({
  stdin = process.stdin,
  stdout = process.stdout,
  env = process.env,
  exit = (code) => process.exit(code),
  timeoutMs = HARD_TIMEOUT_MS,
  host = "",
  argv = process.argv.slice(2),
} = {}) {
  // 入力が閉じない・遅いときでも、ユーザーの入力を待たせない（出力なしで打ち切る）。
  const guard = setTimeout(() => exit(0), timeoutMs);
  try {
    const raw = await readStdin(stdin);
    let input = null;
    try { input = raw.trim() ? JSON.parse(raw) : null; } catch { input = null; }
    // 会話ごとの発言回数を数える（回数と時刻だけ。子エージェントと 0 設定では数えない）。
    const reflection = input && typeof input === "object" ? countPromptForReflection(input, { env }) : null;
    const response = input ? buildHookResponse(input, { env, reflection }) : null;
    if (response) {
      // 数えるだけの記録は、従来どおり訂正らしい言い回しに当たったときだけ残す。
      if (response.analysis.matched) {
        recordHookEvent(promptFromHookInput(input), {
          env,
          host: detectHookHost({ explicit: host || hostFromArgv(argv), input, env }),
        });
      }
      stdout.write(`${JSON.stringify(response.output)}\n`);
    }
  } catch {
    // 何があっても入力は止めない。
  } finally {
    clearTimeout(guard);
  }
  // 正常経路では process.exit を呼ばない。macOS のパイプへの stdout は非同期で、
  // 書いた直後に exit すると応答が途中で切れる。exitCode 0 のまま自然に終わらせる。
  return 0;
}

if (isDirectCli(import.meta.url)) {
  process.on("uncaughtException", () => process.exit(0));
  process.on("unhandledRejection", () => process.exit(0));
  runHookCli();
}
