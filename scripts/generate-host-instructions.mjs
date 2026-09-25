#!/usr/bin/env node
// CLAUDE.md / AGENTS.md / GEMINI.md を config/host-instructions.template.md から作る。
//
//   node scripts/generate-host-instructions.mjs          3つを書き直す
//   node scripts/generate-host-instructions.mjs --check  書かずに照合し、ずれていれば非0で終わる（CI）
//
// 指示ファイルを直すときはテンプレートを直してから、これを走らせる。3つを手で直すと、
// 次の --check が落ちる（手で直した1つだけが先へ進み、ほかのホストが古い規則のまま残るのを防ぐ）。

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HOST_INSTRUCTION_TEMPLATE, generateHostInstructionFiles } from "../lib/hostInstructionFiles.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { check: false, help: false };
  for (const token of argv) {
    if (token === "--check") args.check = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`未知の引数: ${token}（使えるのは --check / --help）`);
  }
  return args;
}

function firstDifference(expected, actual) {
  const left = expected.split("\n");
  const right = actual.split("\n");
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) {
      const a = left[index] ?? "(無し)";
      const b = right[index] ?? "(無し)";
      // 長い行は、食い違った位置の前後だけを見せる。
      let column = 0;
      while (column < a.length && column < b.length && a[column] === b[column]) column += 1;
      const from = Math.max(0, column - 40);
      const excerpt = (text) => `${from > 0 ? "…" : ""}${text.slice(from, from + 140)}`;
      return { line: index + 1, column: column + 1, expected: excerpt(a), actual: excerpt(b) };
    }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("Usage: node scripts/generate-host-instructions.mjs [--check]\n"
      + `\n${HOST_INSTRUCTION_TEMPLATE} から CLAUDE.md / AGENTS.md / GEMINI.md を作る。--check は書かずに照合だけする。\n`);
    return;
  }
  const files = await generateHostInstructionFiles(repoRoot);
  const drifted = [];
  for (const file of files) {
    let current = "";
    try {
      current = (await readFile(file.path, "utf8")).replace(/\r\n/gu, "\n");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (current === file.content) continue;
    if (args.check) {
      drifted.push({ fileName: file.fileName, difference: firstDifference(file.content, current) });
      continue;
    }
    await writeFile(file.path, file.content, "utf8");
    process.stdout.write(`書き直した: ${file.fileName}\n`);
  }
  if (!args.check) {
    process.stdout.write(`${files.map((file) => file.fileName).join(" / ")} はテンプレートと一致\n`);
    return;
  }
  if (drifted.length === 0) {
    process.stdout.write(`${files.map((file) => file.fileName).join(" / ")} はテンプレート（${HOST_INSTRUCTION_TEMPLATE}）と一致\n`);
    return;
  }
  for (const entry of drifted) {
    const diff = entry.difference;
    process.stdout.write(`${entry.fileName} がテンプレートとずれている（${diff?.line} 行目 ${diff?.column} 文字目）\n`
      + `  テンプレートから: ${diff?.expected}\n  いまのファイル:   ${diff?.actual}\n`);
  }
  process.stdout.write(`\n指示ファイルは手で直さず、${HOST_INSTRUCTION_TEMPLATE} を直してから `
    + "`node scripts/generate-host-instructions.mjs` を走らせること。\n");
  process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.message || error}\n`);
  process.exitCode = 1;
});
