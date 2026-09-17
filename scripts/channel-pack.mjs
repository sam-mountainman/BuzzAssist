#!/usr/bin/env node
// 非公開Channel Packを公開Coreから分離したまま署名・検証するCLI。

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import {
  createChannelPackEnvelope,
  verifyChannelPackEnvelope,
} from "../lib/channelPackEnvelope.mjs";

function parseArgs(argv) {
  const out = { command: argv[0] || "help" };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`余分な引数: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else { out[key] = next; index += 1; }
  }
  return out;
}

function help() {
  return [
    "BuzzAssist signed Channel Pack",
    "",
    "sign   --source-dir DIR --output-dir DIR --id ID --version 1.0.0 --harness ID --private-key FILE [--public-key FILE] [--key-id ID] [--payload-kind KIND] [--core-compatibility RANGE]",
    "verify --bundle-dir DIR --public-key FILE [--harness ID]",
    "",
    "秘密鍵とprovider API keyをbundleへ入れない。受領側の公開鍵はbundleとは別経路で渡す。",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (["help", "--help", "-h"].includes(args.command)) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  let result;
  if (args.command === "sign") {
    for (const key of ["sourceDir", "outputDir", "id", "version", "harness", "privateKey"]) {
      if (typeof args[key] !== "string") throw new Error(`signには --${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} が要る。`);
    }
    result = await createChannelPackEnvelope({
      sourceDir: resolve(args.sourceDir),
      outputDir: resolve(args.outputDir),
      id: args.id,
      version: args.version,
      harnessId: args.harness,
      payloadKind: args.payloadKind,
      coreCompatibility: args.coreCompatibility,
      privateKeyPath: resolve(args.privateKey),
      publicKeyPath: typeof args.publicKey === "string" ? resolve(args.publicKey) : "",
      keyId: args.keyId,
    });
  } else if (args.command === "verify") {
    if (typeof args.bundleDir !== "string" || typeof args.publicKey !== "string") {
      throw new Error("verifyには --bundle-dir と --public-key が要る。");
    }
    result = await verifyChannelPackEnvelope({
      bundleDir: resolve(args.bundleDir),
      trustedPublicKeyPem: await readFile(resolve(args.publicKey), "utf8"),
      expectedHarnessId: typeof args.harness === "string" ? args.harness : "",
    });
  } else throw new Error(`未知のcommand: ${args.command}\n${help()}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isDirectCli(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
