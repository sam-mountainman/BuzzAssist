// 回数で起動する振り返り（UserPromptSubmit フックが数え、capture が0に戻す）。
//
// 訂正らしい言い回しの検知（scripts/harness-learn-hook.mjs）は、ユーザーがはっきり
// 訂正したときにしか動かない。好み・禁止事項・実測で分かった事実の多くは、訂正の
// 言い回しを伴わずに会話の途中で出てきて、そのまま流れる。hermes-agent は「一定の
// 回数ごとに振り返りを促し、記録したら数え直す」ことでこれを拾っている。ここでも
// 同じことを、捕捉は書き換えないという大原則のまま行う:
//
//   - **数えるだけ**。会話ごとに、ユーザーの発言の回数と時刻だけをリポジトリの外
//     （学習の置き場の reflection/）に残す。発言本文も会話 ID そのものも保存しない
//     （ファイル名は会話 ID の sha256 の先頭）
//   - **促すだけ**。既定で 10 回ごとに短い一段落を文脈へ足す。capture するかどうかは
//     エージェントが決める。提案ゼロは正常で、毎回何かを書かせる圧はかけない
//   - **capture で0に戻す**。同じ会話 ID（--session）で capture したら数え直す
//   - **子エージェントでは何もしない**（BUZZASSIST_LEARNING_WRITE_FORBIDDEN、入力の agent_id）
//   - 間隔は BUZZASSIST_LEARNING_REFLECT_EVERY で変えられ、0 で数えるのも促すのも止まる
//   - どこで失敗しても例外を外へ出さない（ユーザーの入力を止めない）

import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { learningWritesForbidden } from "./harnessLearningGuard.mjs";
import { operatorLearningStateDir } from "./harnessLearningState.mjs";

/** 何回ごとに促すか。"0" / "off" で数えるのも促すのも止める。 */
export const REFLECTION_INTERVAL_ENV = "BUZZASSIST_LEARNING_REFLECT_EVERY";
export const DEFAULT_REFLECTION_INTERVAL = 10;
export const REFLECTION_STATE_VERSION = "buzzassist-learning-reflection-v1";
const MAX_REFLECTION_INTERVAL = 1000;
// 会話が終わったあとも数えた記録は残る。30 日触られていないものは新しい会話を数え始めるときに掃除する。
const STALE_COUNTER_MS = 30 * 24 * 60 * 60 * 1000;
const SAFE_SESSION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DERIVED_SESSION_TOKEN = /^conv-([a-f0-9]{32})$/u;

/** 間隔。未設定は既定の 10、"0" / "off" / "false" は 0（止める）、不正な値は既定へ戻す。 */
export function reflectionInterval(env = process.env) {
  const raw = String(env?.[REFLECTION_INTERVAL_ENV] ?? "").trim().toLowerCase();
  if (raw === "") return DEFAULT_REFLECTION_INTERVAL;
  if (raw === "0" || raw === "off" || raw === "false") return 0;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_REFLECTION_INTERVAL ? value : DEFAULT_REFLECTION_INTERVAL;
}

/** 数えた記録の置き場（学習の置き場の reflection/）。Windows でも homedir から組み立てる。 */
export function reflectionDir({ env = process.env, homeDir = homedir(), pathApi = path } = {}) {
  return pathApi.join(operatorLearningStateDir({ env, homeDir, pathApi }), "reflection");
}

/** ホストが渡す会話の識別子。Claude Code と Codex は session_id、無ければ transcript_path。 */
export function conversationIdFromHookInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  for (const key of ["session_id", "conversation_id", "thread_id", "transcript_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim() && value.length <= 1024) return value.trim();
  }
  return "";
}

/** 会話 ID から記録の鍵を作る。capture の --session に conv-<鍵> を渡した場合もそのまま鍵になる。 */
export function conversationKey(sessionId) {
  const text = String(sessionId ?? "").trim();
  if (!text) return "";
  const derived = DERIVED_SESSION_TOKEN.exec(text);
  if (derived) return derived[1];
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

/**
 * capture の --session に渡す文字列。ホストの session_id が安全な形ならそのまま、
 * transcript_path のようにパスを含む形なら conv-<鍵> にする（文脈に端末のパスを写さない）。
 */
export function sessionTokenFor(sessionId) {
  const text = String(sessionId ?? "").trim();
  if (!text) return "";
  return SAFE_SESSION_TOKEN.test(text) ? text : `conv-${conversationKey(text)}`;
}

export function reflectionStatePath(sessionId, options = {}) {
  const key = conversationKey(sessionId);
  if (!key) return null;
  return path.join(reflectionDir(options), `${key}.json`);
}

function readCounter(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && parsed.version === REFLECTION_STATE_VERSION && Number.isSafeInteger(parsed.count) && parsed.count >= 0) return parsed;
  } catch { /* 無い・壊れている＝まだ数えていない */ }
  return null;
}

function writeCounter(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.partial`;
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function pruneStaleCounters(dir, nowMs) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!/^[a-f0-9]{32}\.json$/u.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (nowMs - fs.statSync(file).mtimeMs > STALE_COUNTER_MS) {
        fs.rmSync(file, { force: true });
        removed += 1;
      }
    } catch { /* 他のフックと同時に消えても構わない */ }
  }
  return removed;
}

/**
 * ユーザーの発言を1回数え、促す回かどうかを返す。例外は投げない。
 * 戻り値: { counted, count, interval, due, sessionToken } か { counted: false, reason }
 */
export function countPromptForReflection(input, {
  env = process.env,
  homeDir = homedir(),
  now = () => new Date().toISOString(),
} = {}) {
  try {
    const interval = reflectionInterval(env);
    if (interval === 0) return { counted: false, reason: "disabled" };
    if (learningWritesForbidden(env)) return { counted: false, reason: "child-agent" };
    if (input && typeof input === "object" && input.agent_id) return { counted: false, reason: "subagent" };
    const event = String(input?.hook_event_name ?? "UserPromptSubmit");
    if (event !== "UserPromptSubmit") return { counted: false, reason: "not-user-prompt" };
    const sessionId = conversationIdFromHookInput(input);
    if (!sessionId) return { counted: false, reason: "no-session" };
    const file = reflectionStatePath(sessionId, { env, homeDir });
    const previous = readCounter(file);
    const at = String(now());
    const count = (previous?.count ?? 0) + 1;
    const due = count % interval === 0;
    writeCounter(file, {
      version: REFLECTION_STATE_VERSION,
      count,
      prompts: (Number.isSafeInteger(previous?.prompts) ? previous.prompts : 0) + 1,
      nudges: (Number.isSafeInteger(previous?.nudges) ? previous.nudges : 0) + (due ? 1 : 0),
      firstPromptAt: previous?.firstPromptAt ?? at,
      lastPromptAt: at,
      ...(due ? { lastNudgeAt: at } : previous?.lastNudgeAt ? { lastNudgeAt: previous.lastNudgeAt } : {}),
      ...(previous?.lastResetAt ? { lastResetAt: previous.lastResetAt, lastResetReason: previous.lastResetReason ?? null } : {}),
    });
    if (!previous) pruneStaleCounters(path.dirname(file), Date.parse(at) || Date.now());
    return { counted: true, count, interval, due, sessionToken: sessionTokenFor(sessionId) };
  } catch {
    return { counted: false, reason: "counter-unwritable" };
  }
}

/**
 * capture のあとに、その会話の数を0に戻す。数えた記録が無ければ何もしない。例外は投げない。
 * @param sessionId capture の --session（ホストの session_id か、促しが示した conv-<鍵>）
 */
export function resetReflectionCounter(sessionId, {
  env = process.env,
  homeDir = homedir(),
  now = () => new Date().toISOString(),
  reason = "capture",
} = {}) {
  try {
    if (learningWritesForbidden(env) || reflectionInterval(env) === 0) return false;
    const file = reflectionStatePath(sessionId, { env, homeDir });
    if (!file) return false;
    const previous = readCounter(file);
    if (!previous) return false;
    if (previous.count === 0) return false;
    writeCounter(file, { ...previous, count: 0, lastResetAt: String(now()), lastResetReason: String(reason).slice(0, 40) });
    return true;
  } catch {
    return false;
  }
}

/** 促しの一段落。発言本文は入れない。 */
export function buildReflectionContext(reflection, { learnScript = "scripts/harness-learn.mjs" } = {}) {
  const session = reflection?.sessionToken || "<この会話のID>";
  return [
    `[BuzzAssist 自己改善] この会話でユーザーの発言が ${reflection?.count ?? "?"} 回になりました（${reflection?.interval ?? DEFAULT_REFLECTION_INTERVAL} 回ごとの振り返り。capture すると数え直します）。`,
    "ここまでに受けた訂正・好み・禁止事項や、実測で分かった新しい事実のうち、まだ残していないものがあれば、harness-self-improvement スキルに従い",
    `\`node "${learnScript}" capture --kind <correction|preference|constraint|fact> --target <宛先> --text "何をどう直すか" --evidence "何を観測したか" --session "${session}"\` で提案として残してください。`,
    "無ければ何もしなくてよい（提案ゼロは正常。この促しは数えただけで、何かが起きたという合図ではありません）。",
  ].join("\n");
}
