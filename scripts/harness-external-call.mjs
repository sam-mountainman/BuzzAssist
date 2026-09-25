#!/usr/bin/env node
// 外部モデル呼び出しの記録（Claude Code / Codex 共通）
//
//   node scripts/harness-external-call.mjs record \
//     --host antigravity --model <モデルid> --purpose "台本の語り口の手直し" \
//     --input <渡した本文のファイル> --output <返った本文のファイル> \
//     --work-dir <台本の作業フォルダ> --session <この会話・タスクのID>
//   node scripts/harness-external-call.mjs show --work-dir <台本の作業フォルダ> [--id <id>]
//
// Antigravity にはフックの仕組みが無いので、Antigravity 側では呼び出しを自動で記録できない。
// **呼び出した側のホスト（Claude Code / Codex）が、呼び出しのたびにこれを叩く。**
// 本文は保存しない（入出力の SHA-256・byte 数・モデル・時刻・呼び出し元の会話 ID だけ）。
// 返った id を、台本の品質ループ（scripts/script-quality-loop.mjs record --external-call <id>）へ渡す。
// 実装の正本は lib/externalModelCallLedger.mjs。

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import {
  EXTERNAL_CALL_HOSTS,
  EXTERNAL_CALL_STATUSES,
  externalCallLedgerPath,
  readExternalCallLedger,
  recordExternalCall,
} from "../lib/externalModelCallLedger.mjs";

const VALUE_OPTIONS = new Set([
  "--host", "--model", "--purpose", "--input", "--output", "--work-dir", "--ledger", "--session",
  "--caller-host", "--status", "--incomplete-reason", "--started-at", "--finished-at", "--id",
]);
const FLAG_OPTIONS = new Set(["--json", "--help", "-h"]);

function camel(option) {
  return option.replace(/^--?/u, "").replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
}

export function parseExternalCallArgs(argv) {
  const [action, ...rest] = argv;
  const args = { action: action || "" };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (FLAG_OPTIONS.has(token)) {
      args[token === "-h" ? "help" : camel(token)] = true;
      continue;
    }
    if (VALUE_OPTIONS.has(token)) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${token} に値が要ります。`);
      args[camel(token)] = value;
      index += 1;
      continue;
    }
    throw new Error(`不明なオプション: ${token}`);
  }
  return args;
}

export function externalCallHelp() {
  return `外部モデル呼び出しの記録（本文は保存しない）

  record   呼び出し1回を私有の台帳へ追記し、id を出す（同じ内容なら追記せず同じ id）
    --host <${EXTERNAL_CALL_HOSTS.join("|")}>   外部モデルを実行したホスト
    --model <id>                  使ったモデルの id
    --purpose "<用途>"             何のために呼んだか（200文字以内。本文・人名・パスは書かない）
    --input <file>                外部モデルへ渡した本文のファイル
    --output <file>               返ってきた本文のファイル（空返答なら空のファイルか、無いパス）
    --work-dir <dir> | --ledger <file.jsonl>
                                  台帳の置き場。--work-dir なら <dir>/quality/external-calls.jsonl
                                  （公開リポジトリの追跡対象の中には書かない）
    --session <id>                呼び出し元（このホスト）の会話・タスクの ID
    --caller-host <claude-code|codex>   省略時は環境から推す
    --status <${EXTERNAL_CALL_STATUSES.join("|")}>
                                  既定 complete。出力が空なら complete でも empty として残す
    --incomplete-reason <code>    未完の理由のコード（例: empty-response, usage-limit, connection-reset）
    --started-at <ISO> --finished-at <ISO>
    --json                        記録を JSON で出す

  show     台帳の記録を出す（--id で1件）

  Antigravity にはフックが無いので、Antigravity 側では記録されない。呼び出した側の
  Claude Code / Codex が、呼び出しのたびにこれを叩く。返った id は台本の品質ループの
  record --external-call <id> に渡す。
`;
}

export async function runExternalCallCli(argv = process.argv.slice(2), {
  env = process.env,
  stdout = process.stdout,
  now,
  repoRoot,
  isIgnored,
} = {}) {
  const args = parseExternalCallArgs(argv);
  if (!args.action || args.action === "--help" || args.action === "-h" || args.action === "help" || args.help) {
    stdout.write(externalCallHelp());
    return { exitCode: args.action ? 0 : 2 };
  }
  if (!["record", "show"].includes(args.action)) throw new Error(`不明なアクション: ${args.action}（record / show）`);
  const ledgerPath = externalCallLedgerPath({ workDir: args.workDir, ledger: args.ledger });
  if (args.action === "record") {
    const result = await recordExternalCall({
      ledgerPath,
      host: args.host,
      model: args.model,
      purpose: args.purpose,
      inputPath: args.input,
      outputPath: args.output,
      status: args.status,
      incompleteReason: args.incompleteReason,
      callerHost: args.callerHost,
      callerSession: args.session,
      startedAt: args.startedAt,
      finishedAt: args.finishedAt,
      env,
      ...(now ? { now } : {}),
      ...(repoRoot ? { repoRoot } : {}),
      ...(isIgnored ? { isIgnored } : {}),
    });
    if (args.json) {
      stdout.write(`${JSON.stringify({ id: result.id, appended: result.appended, status: result.record.status, record: result.record }, null, 2)}\n`);
    } else {
      stdout.write(`${result.id}\n`);
      const note = result.record.status === "complete" ? "" : `（未完: ${result.record.status}${result.record.incompleteReason ? ` / ${result.record.incompleteReason}` : ""}）`;
      stdout.write(`${result.appended ? "記録しました" : "同じ記録が既にあります"}${note}\n`);
      if (result.record.statusCorrected) stdout.write("  出力が空だったので、complete ではなく empty として残しました。\n");
    }
    return { exitCode: 0, result };
  }
  if (args.action === "show") {
    const rows = (await readExternalCallLedger(ledgerPath)).filter((row) => !args.id || row?.id === args.id);
    if (args.json) stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    else if (rows.length === 0) stdout.write("記録はありません\n");
    else {
      for (const row of rows) {
        stdout.write(`${row.id}  ${row.status}  ${row.host}/${row.model}  ${row.recordedAt}  ${row.purpose}\n`);
      }
    }
    return { exitCode: 0, rows };
  }
  return { exitCode: 2 };
}

if (isDirectCli(import.meta.url)) {
  runExternalCallCli().then(({ exitCode }) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
