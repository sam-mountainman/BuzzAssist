// どの工程・仕事をどのモデルへ回すか（モデルの振り分け）。既定は config/model-routing.json。
//
// 決まり:
//   - 論理の検証・事実の確認・情報集め・バックエンドの実装とレビュー・ライセンスの確認は Codex、
//     完成動画・画像・声を見て聞いて判断する・長い資料を通しで読む・Google 検索に根ざした調べものは Antigravity、
//     段取り・統合・人への報告は今動いているエージェント（host）
//   - 呼び出しは agent-cli-bridge（Codex は codex exec、Gemini は Antigravity の agy）。呼ぶたびに
//     node scripts/harness-external-call.mjs record で記録する（本文は残さず SHA と byte 数だけ）
//   - 端末ごとに使えるモデルが違うので、運営者は BUZZASSIST_MODEL_ROUTING（JSON のパス）で上書きできる。
//     上書きでも、送ってはいけない物（neverSend）は外せない（足すことだけできる）
//   - ここは振り分けを決めて、打つコマンドを組み立てるだけ。モデルを呼ばない

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MODEL_ROUTING_PATH = path.join(MODULE_ROOT, "config", "model-routing.json");
export const MODEL_ROUTING_ENV = "BUZZASSIST_MODEL_ROUTING";
export const MODEL_ROUTING_VERSION = "buzzassist-model-routing-v1";
export const SEND_REFUSED_CODE = "model-routing-send-refused";

const ID = /^[a-z][a-z0-9-]{0,63}$/u;
const MODES = new Set(["", "ask", "review", "plan", "edit"]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** 設定の形を確かめる。直せない値は例外（黙って既定へ戻すと、宣言した側は効いているつもりになる）。 */
export function validateModelRouting(config) {
  const problems = [];
  if (!plainObject(config) || config.version !== MODEL_ROUTING_VERSION) problems.push(`version は ${MODEL_ROUTING_VERSION}`);
  const providers = plainObject(config?.providers) ? config.providers : {};
  for (const [id, provider] of Object.entries(providers)) {
    if (!ID.test(id)) problems.push(`providers の id ${id} の形`);
    if (!Array.isArray(provider?.models)) problems.push(`providers.${id}.models は配列`);
    if (id !== "host" && !String(provider?.bridgeProvider || "")) problems.push(`providers.${id}.bridgeProvider が要る`);
    if (id !== "host" && !["codex", "antigravity", "claude"].includes(provider?.ledgerHost)) problems.push(`providers.${id}.ledgerHost は codex / antigravity / claude`);
  }
  if (!plainObject(providers.host)) problems.push("providers.host が要る（段取りをする今のエージェント）");
  const tasks = plainObject(config?.tasks) ? config.tasks : {};
  for (const [id, task] of Object.entries(tasks)) {
    if (!ID.test(id)) problems.push(`tasks の id ${id} の形`);
    if (!plainObject(providers[task?.provider])) problems.push(`tasks.${id}.provider ${task?.provider} が providers に無い`);
    if (!MODES.has(String(task?.mode ?? ""))) problems.push(`tasks.${id}.mode は ask / review / plan / edit`);
  }
  for (const [stage, task] of Object.entries(plainObject(config?.stages) ? config.stages : {})) {
    if (!plainObject(tasks[task])) problems.push(`stages.${stage} の仕事 ${task} が tasks に無い`);
  }
  if (!Array.isArray(config?.neverSend) || config.neverSend.length === 0) problems.push("neverSend が要る");
  if (problems.length > 0) throw new Error(`モデルの振り分けの設定が使えない: ${problems.join(" / ")}`);
  return config;
}

/** 既定に運営者の上書きを重ねる。neverSend は和集合（上書きで外せない）。 */
export function mergeModelRouting(base, override) {
  if (!plainObject(override)) return base;
  const neverSend = new Map([...(base.neverSend || []), ...(override.neverSend || [])].map((row) => [row.id, row]));
  return {
    ...base,
    providers: { ...base.providers, ...(override.providers || {}) },
    tasks: { ...base.tasks, ...(override.tasks || {}) },
    stages: { ...base.stages, ...(override.stages || {}) },
    neverSend: [...neverSend.values()],
  };
}

export function loadModelRouting({ env = process.env, basePath = MODEL_ROUTING_PATH } = {}) {
  const base = readJson(basePath);
  const overridePath = String(env?.[MODEL_ROUTING_ENV] || "").trim();
  const merged = overridePath ? mergeModelRouting(base, readJson(path.resolve(overridePath))) : base;
  return validateModelRouting(merged);
}

/** 仕事（tasks の id）か工程（stages の id）から、回す先を決める。 */
export function routeFor(config, taskOrStage) {
  const key = String(taskOrStage || "");
  const taskId = config.tasks[key] ? key : config.stages?.[key];
  const task = taskId ? config.tasks[taskId] : null;
  if (!task) throw new Error(`モデルの振り分けに無い仕事・工程: ${key}（node scripts/model-route.mjs list で一覧）`);
  const provider = config.providers[task.provider];
  return {
    taskId,
    stage: config.tasks[key] ? "" : key,
    provider: task.provider,
    mode: task.mode || "",
    model: provider.models[0] || "",
    fallbackModels: provider.models.slice(1),
    effort: provider.effort || "",
    bridgeProvider: provider.bridgeProvider || "",
    ledgerHost: provider.ledgerHost || "",
    what: task.what || "",
  };
}

/**
 * 送ってよいかを確かめる。categories は渡す物の種類（neverSend の id）。当たれば理由つきの例外。
 * 呼び出し側は、渡す前に自分で種類を宣言する（中身を見て当てる仕組みではない）。
 */
export function assertSendable(config, categories = []) {
  const blocked = new Set((config.neverSend || []).map((row) => row.id));
  const hits = (Array.isArray(categories) ? categories : [categories]).map(String).filter((id) => blocked.has(id));
  if (hits.length > 0) {
    const error = new Error(`${SEND_REFUSED_CODE}: 外部のモデルへ送らない物が含まれる（${hits.join(", ")}）。`);
    error.code = SEND_REFUSED_CODE;
    error.categories = hits;
    throw error;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, "'\\''")}'`;
}

/**
 * 打つコマンドを組み立てる（呼ばない）。bridgeScript は agent-cli-bridge の bridge.sh。host の仕事は null。
 * record は呼んだ後に打つ記録のコマンド（入力・出力のファイルと作業フォルダを渡す）。
 */
export function routeCommands(route, { bridgeScript = "~/.agents/skills/agent-cli-bridge/scripts/bridge.sh", promptFile = "<依頼の本文のファイル>", cwd = "<作業場所>", outputFile = "<返った本文のファイル>", workDir = "<記録を残す作業フォルダ>", session = "<この会話の ID>" } = {}) {
  if (!route.bridgeProvider) return null;
  const run = [
    "sh", bridgeScript, "run", route.bridgeProvider,
    "--cwd", shellQuote(cwd), "--prompt-file", shellQuote(promptFile),
    ...(route.mode ? ["--mode", route.mode] : []),
    "--model", route.model, ...(route.effort ? ["--effort", route.effort] : []),
    "--selection-source", "preference",
  ].join(" ");
  const record = [
    "node scripts/harness-external-call.mjs record",
    "--host", route.ledgerHost, "--model", route.model,
    "--purpose", shellQuote(route.what || route.taskId),
    "--input", shellQuote(promptFile), "--output", shellQuote(outputFile),
    "--work-dir", shellQuote(workDir), "--session", shellQuote(session),
  ].join(" ");
  // bridge が端末の古い codex を引いてモデルを使えないとき（2026-10-29 に model_unavailable を実測）の直の呼び出し。
  // 書き込みを許すのは edit の仕事だけで、ほかは read-only。
  const direct = route.bridgeProvider === "codex"
    ? [
      "codex exec", "-m", route.model,
      ...(route.effort ? ["-c", shellQuote(`model_reasoning_effort="${route.effort}"`)] : []),
      "-s", route.mode === "edit" ? "workspace-write" : "read-only",
      "-C", shellQuote(cwd), "--skip-git-repo-check",
      `"$(cat ${shellQuote(promptFile)})"`, "<", "/dev/null", ">", shellQuote(outputFile),
    ].join(" ")
    : "";
  return { run, record, ...(direct ? { direct } : {}) };
}
