#!/usr/bin/env node
// npm pack は package-lock.json を tgz に入れない（npm の決まり）。そのままでは Release の tgz から
// 依存を固定して入れられず（npm ci できない）、setup-agents の配布物の検査（package-lock.json が
// 要る）も通らない。prepack でこのファイルを release/package-lock.json へ写し、配布物に同梱する。
// 展開する側（scripts/update-current.mjs・install.sh・install.ps1）が package-lock.json へ戻す。
// package:audit が自分で pack するとき（--ignore-scripts）も、同じ関数を先に呼ぶ。
//
//   node scripts/stage-release-lock.mjs            # package.json の prepack から呼ばれる

import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectCli } from "../lib/cliEntrypoint.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function stageReleaseLockfile(root = REPO_ROOT) {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  if (lock.name !== manifest.name || lock.version !== manifest.version) {
    throw new Error(
      `package-lock.json（${lock.name}@${lock.version}）が package.json（${manifest.name}@${manifest.version}）と合わない。`
      + "npm install で揃えてから pack すること。",
    );
  }
  const target = path.join(root, "release", "package-lock.json");
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(root, "package-lock.json"), target);
  return target;
}

if (isDirectCli(import.meta.url)) {
  try {
    stageReleaseLockfile();
    process.stdout.write("release/package-lock.json を配布物へ同梱する準備をした。\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
