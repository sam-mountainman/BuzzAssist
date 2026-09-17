#!/usr/bin/env node
// BuzzAssist管理側の署名feedback intake。upload APIはbundle受付だけを公開し、
// operator enrollmentとowner decisionはローカルCLIに限定する。

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createHarnessFeedbackUploadHandler,
  decideHarnessFeedbackBundle,
  enrollHarnessFeedbackOperator,
  ingestHarnessFeedbackBundle,
  loadHarnessFeedbackImportLedger,
  revokeHarnessFeedbackOperator,
} from "../lib/harnessFeedbackIngest.mjs";
import { isDirectCli } from "../lib/cliEntrypoint.mjs";

function argsOf(argv) {
  const output = { command: argv[0] || "help" };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`余分な引数: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) output[key] = true;
    else { output[key] = next; index += 1; }
  }
  return output;
}

function required(args, names) {
  for (const name of names) {
    if (typeof args[name] !== "string" || !args[name].trim()) {
      throw new Error(`--${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} が要る。`);
    }
  }
}

function help() {
  return [
    "BuzzAssist central feedback ingest",
    "",
    "enroll --root DIR --operator ID --public-key FILE --allowed-builds FILE --approved-by OWNER",
    "revoke --root DIR --operator ID [--key-id ID] --revoked-by OWNER --reason TEXT",
    "ingest --root DIR --bundle FILE",
    "approve --root DIR --bundle-digest SHA --approved-by OWNER --reason TEXT",
    "reject --root DIR --bundle-digest SHA --approved-by OWNER --reason TEXT",
    "list-approved --root DIR   (署名鍵が後に失効したimportはrevokedAfterApprovalへ分離し、importsへは数えない)",
    "serve --root DIR [--host 127.0.0.1] [--port 8787] [--token-env BUZZASSIST_FEEDBACK_UPLOAD_TOKEN]",
    "",
    "serveはPOST /v1/feedback/bundlesだけを公開。Bearer tokenと登録済みEd25519署名の両方が必要。",
  ].join("\n");
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  if (["help", "--help", "-h"].includes(args.command)) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  let result;
  if (args.command === "enroll") {
    required(args, ["root", "operator", "publicKey", "allowedBuilds", "approvedBy"]);
    const buildDocument = JSON.parse(await readFile(resolve(args.allowedBuilds), "utf8"));
    result = await enrollHarnessFeedbackOperator({
      rootDir: resolve(args.root),
      operatorId: args.operator,
      publicKeyPem: await readFile(resolve(args.publicKey), "utf8"),
      allowedBuilds: Array.isArray(buildDocument) ? buildDocument : buildDocument.allowedBuilds,
      approvedBy: args.approvedBy,
    });
  } else if (args.command === "revoke") {
    required(args, ["root", "operator", "revokedBy", "reason"]);
    result = await revokeHarnessFeedbackOperator({
      rootDir: resolve(args.root),
      operatorId: args.operator,
      keyId: typeof args.keyId === "string" ? args.keyId : "",
      revokedBy: args.revokedBy,
      reason: args.reason,
    });
  } else if (args.command === "ingest") {
    required(args, ["root", "bundle"]);
    const bytes = await readFile(resolve(args.bundle));
    result = await ingestHarnessFeedbackBundle({
      rootDir: resolve(args.root),
      bundle: JSON.parse(bytes.toString("utf8")),
      bundleBytes: bytes,
    });
  } else if (["approve", "reject"].includes(args.command)) {
    required(args, ["root", "bundleDigest", "approvedBy", "reason"]);
    result = await decideHarnessFeedbackBundle({
      rootDir: resolve(args.root),
      bundleDigest: args.bundleDigest,
      decision: args.command,
      approvedBy: args.approvedBy,
      reason: args.reason,
    });
  } else if (args.command === "list-approved") {
    required(args, ["root"]);
    const ledger = await loadHarnessFeedbackImportLedger({ rootDir: resolve(args.root) });
    result = {
      ok: true,
      count: ledger.approved.length,
      imports: ledger.approved,
      revokedAfterApprovalCount: ledger.revokedAfterApproval.length,
      revokedAfterApproval: ledger.revokedAfterApproval,
    };
  } else if (args.command === "serve") {
    required(args, ["root"]);
    const host = typeof args.host === "string" ? args.host : "127.0.0.1";
    const port = args.port === undefined ? 8787 : Number(args.port);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("--portが不正。");
    const tokenEnv = typeof args.tokenEnv === "string" ? args.tokenEnv : "BUZZASSIST_FEEDBACK_UPLOAD_TOKEN";
    const token = String(process.env[tokenEnv] || "");
    if (!token) throw new Error(`${tokenEnv} が要る。token値をCLI引数へ書かないこと。`);
    const server = createServer(createHarnessFeedbackUploadHandler({
      rootDir: resolve(args.root),
      uploadToken: token,
    }));
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolveListen);
    });
    const address = server.address();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      status: "listening",
      host,
      port: typeof address === "object" ? address.port : port,
      endpoint: "/v1/feedback/bundles",
      enrollmentApiExposed: false,
      ownerDecisionApiExposed: false,
    }, null, 2)}\n`);
    return;
  } else throw new Error(`未知のcommand: ${args.command}\n${help()}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isDirectCli(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
