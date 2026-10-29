#!/usr/bin/env node
// どの工程・仕事をどのモデルへ回すかを引き、打つコマンド（呼び出しと記録）を出す。モデルは呼ばない。
//
//   node scripts/model-route.mjs list                     仕事と工程の一覧と回す先
//   node scripts/model-route.mjs <仕事か工程> [--prompt-file F] [--cwd D] [--output-file F] [--work-dir D] [--session ID] [--send <種類>,...] [--json]
//
// --send に渡す物の種類（neverSend の id）を書くと、送ってはいけない物が含まれていれば止める（終了コード 3）。
// 決まりの本体は lib/modelRouting.mjs、既定は config/model-routing.json（運営者の上書きは BUZZASSIST_MODEL_ROUTING）。

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import { SEND_REFUSED_CODE, assertSendable, loadModelRouting, routeCommands, routeFor } from "../lib/modelRouting.mjs";

const VALUE_OPTIONS = new Set(["--prompt-file", "--cwd", "--output-file", "--work-dir", "--session", "--send"]);

export function runModelRouteCli(argv = process.argv.slice(2), { stdout = process.stdout, env = process.env } = {}) {
  const [target, ...rest] = argv;
  const options = {};
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--json") { json = true; continue; }
    if (!VALUE_OPTIONS.has(token)) throw new Error(`知らない引数: ${token}`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} には値が要る`);
    options[token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  const config = loadModelRouting({ env });
  if (!target || target === "--help" || target === "-h") {
    stdout.write("node scripts/model-route.mjs list | <仕事か工程> [--prompt-file F] [--cwd D] [--send 種類,...] [--json]\n");
    return 0;
  }
  if (target === "list") {
    const rows = [
      ...Object.keys(config.tasks).map((id) => ({ key: id, kind: "task", ...routeFor(config, id) })),
      ...Object.keys(config.stages || {}).map((id) => ({ key: id, kind: "stage", ...routeFor(config, id) })),
    ];
    if (json) stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    else for (const row of rows) stdout.write(`${row.kind === "stage" ? "工程" : "仕事"} ${row.key} → ${row.provider}${row.model ? ` ${row.model}` : ""}${row.effort ? `（推論 ${row.effort}）` : ""}: ${row.what}\n`);
    return 0;
  }
  if (options.send) {
    try {
      assertSendable(config, options.send.split(",").map((value) => value.trim()).filter(Boolean));
    } catch (error) {
      if (error.code !== SEND_REFUSED_CODE) throw error;
      stdout.write(`${error.message}\n`);
      return 3;
    }
  }
  const route = routeFor(config, target);
  const commands = routeCommands(route, options);
  if (json) {
    stdout.write(`${JSON.stringify({ route, commands }, null, 2)}\n`);
  } else {
    stdout.write(`${route.taskId}（${route.what}）→ ${route.provider}${route.model ? ` ${route.model}` : ""}${route.effort ? `・推論 ${route.effort}` : ""}\n`);
    if (commands) {
      stdout.write(`呼ぶ:   ${commands.run}\n記録する: ${commands.record}\n`);
      if (commands.direct) stdout.write(`bridge が使えないとき（直に呼ぶ）: ${commands.direct}\n`);
      if (route.fallbackModels.length > 0) stdout.write(`使えないとき: ${route.fallbackModels.join(" → ")}\n`);
    } else {
      stdout.write("今動いているエージェントがする（外部のモデルは呼ばない）\n");
    }
  }
  return 0;
}

if (isDirectCli(import.meta.url)) {
  try {
    process.exitCode = runModelRouteCli();
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
