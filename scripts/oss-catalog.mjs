#!/usr/bin/env node
// OSS の台帳（使う・使わない OSS・重み・素材の入手先・手元のスキル）を引く・照らす。何も取りに行かない・入れない。
//
//   node scripts/oss-catalog.mjs list [--area A] [--status S] [--json | --markdown]
//   node scripts/oss-catalog.mjs check [--json]     形・使い所の実在・reject の物が依存に入っていないか（違反は終了コード 1）
//
// 決まりの本体は lib/ossCatalog.mjs、台帳は config/oss-catalog.json。

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import { OSS_CATALOG_STATUSES, checkOssCatalog, loadOssCatalog, ossCatalogMarkdown, ossCatalogRows } from "../lib/ossCatalog.mjs";

const VALUE_OPTIONS = new Set(["--area", "--status"]);

export function runOssCatalogCli(argv = process.argv.slice(2), { stdout = process.stdout, catalogPath, rootDir } = {}) {
  const [command, ...rest] = argv;
  const options = {};
  let format = "text";
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--json") { format = "json"; continue; }
    if (token === "--markdown") { format = "markdown"; continue; }
    if (!VALUE_OPTIONS.has(token)) throw new Error(`知らない引数: ${token}`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} には値が要る`);
    options[token.slice(2)] = value;
    index += 1;
  }
  const paths = { ...(catalogPath ? { catalogPath } : {}), ...(rootDir ? { rootDir } : {}) };
  if (!command || command === "--help" || command === "-h") {
    stdout.write(`node scripts/oss-catalog.mjs list [--area A] [--status ${OSS_CATALOG_STATUSES.join("|")}] [--json|--markdown]\nnode scripts/oss-catalog.mjs check [--json]\n`);
    return 0;
  }
  if (command === "check") {
    const result = checkOssCatalog(paths);
    if (format === "json") stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stdout.write(result.ok ? `OSS の台帳: ${result.entries} 行、問題なし\n` : `OSS の台帳に問題:\n${result.problems.map((line) => `- ${line}`).join("\n")}\n`);
    return result.ok ? 0 : 1;
  }
  if (command === "list") {
    if (options.status && !OSS_CATALOG_STATUSES.includes(options.status)) throw new Error(`--status は ${OSS_CATALOG_STATUSES.join(" / ")}`);
    const rows = ossCatalogRows(loadOssCatalog(paths), options);
    if (format === "json") stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    else if (format === "markdown") stdout.write(ossCatalogMarkdown(rows));
    else for (const row of rows) stdout.write(`${row.status}\t${row.area}\t${row.id}\t${row.license}\t顧客の仕組み:${row.customerKit}\n`);
    return 0;
  }
  throw new Error(`知らないコマンド: ${command}（list / check）`);
}

if (isDirectCli(import.meta.url)) {
  try {
    process.exitCode = runOssCatalogCli();
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
