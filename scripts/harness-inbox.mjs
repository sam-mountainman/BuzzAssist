#!/usr/bin/env node
// 外側のループ：止まっている仕事・人の確認待ち・台帳の食い違いを並べ、次の仕事をコマンドつきで返す（読むだけ）。
//
//   node scripts/harness-inbox.mjs                       次の仕事（最大3件）と打つコマンド
//   node scripts/harness-inbox.mjs --json                全部を JSON で
//   node scripts/harness-inbox.mjs --stale-days 2        人の確認待ちを「古い」とみなす日数（既定 3）
//   node scripts/harness-inbox.mjs --deployment-path F   台帳のファイル（既定は config/harness-deployments.json）
//
// 中身の決め方は lib/harnessInbox.mjs。有料の処理は起動しない（コマンドを示すだけ）。

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import { DEFAULT_STALE_DAYS, harnessInbox, harnessInboxText } from "../lib/harnessInbox.mjs";

export async function runHarnessInboxCli(argv = process.argv.slice(2), { stdout = process.stdout, inbox = harnessInbox } = {}) {
  let json = false;
  let staleDays = DEFAULT_STALE_DAYS;
  let deploymentPath = "";
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") json = true;
    else if (token === "--stale-days") {
      staleDays = Number(argv[index += 1]);
      if (!Number.isFinite(staleDays) || staleDays < 0) throw new Error("--stale-days には 0 以上の日数が要る。");
    } else if (token === "--deployment-path") {
      deploymentPath = String(argv[index += 1] || "");
      if (!deploymentPath) throw new Error("--deployment-path には台帳のファイルが要る。");
    } else if (token === "--help" || token === "-h") {
      stdout.write("node scripts/harness-inbox.mjs [--json] [--stale-days N] [--deployment-path FILE]\n");
      return 0;
    } else throw new Error(`知らない引数: ${token}`);
  }
  const report = await inbox({ staleDays, deploymentPath });
  stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${harnessInboxText(report)}\n`);
  return 0;
}

if (isDirectCli(import.meta.url)) {
  runHarnessInboxCli().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
