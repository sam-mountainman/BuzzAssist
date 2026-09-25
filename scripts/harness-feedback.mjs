#!/usr/bin/env node
// read-only curator reportを、本文無しの署名feedback bundleへ変換・検証する。
// 運営者の端末から提供元へ自動で返す流れ（同意・送信待ち・送信・削除）の入口も兼ねる
// （本体は lib/harnessFeedbackOutbox.mjs）。

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "../lib/atomicJsonFile.mjs";
import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import {
  clearFeedbackDestination,
  flushFeedbackOutbox,
  listFeedbackOutbox,
  purgeFeedbackOutbox,
  readFeedbackDestination,
  recordFeedbackConsent,
  writeFeedbackDestination,
} from "../lib/harnessFeedbackOutbox.mjs";
import { assertLearningWriteAllowed } from "../lib/harnessLearningGuard.mjs";
import { FEEDBACK_CONSENT_SCOPES, readFeedbackConsent, resolveLearningState } from "../lib/harnessLearningState.mjs";
import {
  HARNESS_FEEDBACK_PUBLIC_CATALOG_PATH,
  buildHarnessFeedbackPayload,
  buildUnregisteredProposalDraft,
  parseHarnessFeedbackProposalCatalog,
  partitionCuratorPendingByCatalog,
  signHarnessFeedbackBundle,
  verifyHarnessFeedbackBundle,
} from "../lib/harnessFeedbackBundle.mjs";
import { collectSensitiveSignals } from "./audit-public-surface.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
import {
  syncHarnessFeedbackBundles,
  uploadHarnessFeedbackBundle,
} from "../lib/harnessFeedbackUploadClient.mjs";

function argsOf(argv) {
  const result = { command: argv[0] || "help" };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`余分な引数: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) result[key] = true;
    else { result[key] = next; index += 1; }
  }
  return result;
}

function required(args, keys) {
  for (const key of keys) if (typeof args[key] !== "string" || !args[key].trim()) throw new Error(`--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} が要る。`);
}

function help() {
  return [
    "BuzzAssist signed feedback bundle",
    "",
    "create --report FILE --output FILE --private-key FILE --core-version VERSION --harness ID --harness-version VERSION --channel-pack-id ID --channel-pack-version VERSION --channel-pack-sha SHA256 --source-host HOST [--skill-shas SHA,SHA] [--catalog FILE] [--unregistered-output FILE] [--upload --endpoint HTTPS_URL]",
    "verify --bundle FILE --public-key FILE [--harness ID] [--core-version VERSION]",
    "upload --bundle FILE --endpoint HTTPS_URL [--journal-dir DIR] [--token-env BUZZASSIST_FEEDBACK_UPLOAD_TOKEN]",
    "sync --bundle-dir DIR --endpoint HTTPS_URL [--journal-dir DIR] [--token-env BUZZASSIST_FEEDBACK_UPLOAD_TOKEN]",
    "",
    "report本文・台本・Channel Pack payload・provider secretはbundleへ入らない。公開鍵はbundle外から渡す。",
    "createは管理側catalog（既定: 同梱の docs/learning/proposals.public.jsonl）に無いproposalをbundleへ入れず、",
    "匿名化した草案 <outputのdir>/unregistered-candidates/<name>.unregistered-candidates.json（--unregistered-outputで変更可）へ書く。",
    "草案はuploadされず、sync --bundle-dir の対象にも入らない（bundle dir直下ではなく子dirに置くため）。ownerへは人手で渡す。",
    "",
    "運営者の端末から提供元へ自動で返す（既定は送らない。Job の決着時に bundle を作って送信待ちに積む）:",
    `consent [--enable [--scopes ${FEEDBACK_CONSENT_SCOPES.join(",")}] | --disable]`,
    "    引数なしで今の同意を表示。--enable は範囲を省くと settlements,proposals（未知の提案の文は明示したときだけ）。",
    "    同意すると、この端末の署名鍵（Ed25519）を作り、提供元へ渡す公開鍵の置き場と keyId を表示する。",
    "destination [--endpoint HTTPS_URL --provider-key-fingerprint ed25519:<24hex> | --clear]",
    "    送り先（受け取る側の /v2/feedback/bundles と、受領証に署名する提供元の鍵の指紋）。未設定なら貯めるだけ。",
    "outbox    同意・送り先・照合の可否・送信待ち・届いた件数・送らずに残した提案の件数を表示",
    "send [--max-attempts N]    送信待ちを今送る（上限つきで再送。届いたものは二度と送らない）",
    "purge [--sent] [--confirm]    送信待ちを消す（--confirm が無ければ件数だけ表示）。--sent は届いた控えも消す",
  ].join("\n");
}

function feedbackState() {
  return resolveLearningState({ codeRoot: PACKAGE_ROOT, env: process.env });
}

async function runOutboxCommand(args) {
  const state = feedbackState();
  const now = new Date().toISOString();
  if (args.command === "consent") {
    if (args.enable === true && args.disable === true) throw new Error("--enable と --disable は同時に使えない。");
    if (args.enable !== true && args.disable !== true) return { consent: readFeedbackConsent(state) };
    assertLearningWriteAllowed(process.env, "feedback consent");
    const scopes = typeof args.scopes === "string" ? args.scopes.split(",").map((scope) => scope.trim()).filter(Boolean) : [];
    const recorded = recordFeedbackConsent({
      state,
      enabled: args.enable === true,
      scopes,
      via: "cli",
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      now,
    });
    return {
      ok: true,
      ...recorded,
      next: recorded.signer
        ? "公開鍵（signer.publicKeyPath）を提供元へ渡して登録してもらい、destination で送り先を設定する。送り先が無いあいだは貯めるだけ。"
        : "以後の決着では bundle を作らない。貯まった送信待ちは purge で消せる。",
    };
  }
  if (args.command === "destination") {
    if (args.clear === true) {
      assertLearningWriteAllowed(process.env, "feedback destination");
      return { ok: true, ...clearFeedbackDestination({ state }) };
    }
    if (args.endpoint === undefined && args.providerKeyFingerprint === undefined) {
      return { destination: readFeedbackDestination({ state, codeRoot: PACKAGE_ROOT }) };
    }
    required(args, ["endpoint", "providerKeyFingerprint"]);
    assertLearningWriteAllowed(process.env, "feedback destination");
    return { ok: true, destination: writeFeedbackDestination({ state, endpoint: args.endpoint, providerKeyFingerprint: args.providerKeyFingerprint, now }) };
  }
  if (args.command === "outbox") return listFeedbackOutbox({ state, codeRoot: PACKAGE_ROOT });
  if (args.command === "send") {
    assertLearningWriteAllowed(process.env, "feedback send");
    const maxAttempts = args.maxAttempts === undefined ? undefined : Number(args.maxAttempts);
    return flushFeedbackOutbox({ state, codeRoot: PACKAGE_ROOT, mode: "manual", ...(maxAttempts === undefined ? {} : { maxAttempts }) });
  }
  if (args.command === "purge") {
    if (args.confirm === true) assertLearningWriteAllowed(process.env, "feedback purge");
    return purgeFeedbackOutbox({ state, includeSent: args.sent === true, confirm: args.confirm === true });
  }
  return null;
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  if (["help", "--help", "-h"].includes(args.command)) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  let result;
  if (["consent", "destination", "outbox", "send", "purge"].includes(args.command)) {
    process.stdout.write(`${JSON.stringify(await runOutboxCommand(args), null, 2)}\n`);
    return;
  }
  const uploadToken = (commandArgs) => {
    const tokenEnv = typeof commandArgs.tokenEnv === "string"
      ? commandArgs.tokenEnv
      : "BUZZASSIST_FEEDBACK_UPLOAD_TOKEN";
    const token = String(process.env[tokenEnv] || "");
    if (!token) throw new Error(`${tokenEnv} が要る。token値をCLI引数へ書かないこと。`);
    return token;
  };
  if (args.command === "create") {
    required(args, ["report", "output", "privateKey", "coreVersion", "harness", "harnessVersion", "channelPackId", "channelPackVersion", "channelPackSha", "sourceHost"]);
    const curatorReport = JSON.parse(await readFile(resolve(args.report), "utf8"));
    const catalogPath = typeof args.catalog === "string" ? resolve(args.catalog) : HARNESS_FEEDBACK_PUBLIC_CATALOG_PATH;
    const catalogBytes = await readFile(catalogPath);
    const catalog = parseHarnessFeedbackProposalCatalog(catalogBytes.toString("utf8"));
    const partition = partitionCuratorPendingByCatalog({ curatorReport, catalog });
    const payload = buildHarnessFeedbackPayload({
      curatorReport: partition.registeredReport,
      coreVersion: args.coreVersion,
      harnessId: args.harness,
      harnessVersion: args.harnessVersion,
      skillDigests: typeof args.skillShas === "string" ? args.skillShas.split(",").map((value) => value.trim()).filter(Boolean) : [],
      channelPack: { id: args.channelPackId, version: args.channelPackVersion, payloadSha256: args.channelPackSha },
      sourceHost: args.sourceHost,
    });
    const bundle = await signHarnessFeedbackBundle({ payload, outputPath: resolve(args.output), privateKeyPath: resolve(args.privateKey) });
    result = {
      ok: true,
      outputPath: resolve(args.output),
      harnessId: bundle.build.harnessId,
      proposalCount: bundle.proposals.length,
      observedGateCount: bundle.observedGates.length,
      signerKeyId: bundle.signer.keyId,
      catalogPath,
      catalogEntries: catalog.size,
      unregisteredProposalCount: partition.unregistered.length,
      semanticMismatchProposalCount: partition.semanticMismatch.length,
    };
    if (partition.unregistered.length > 0 || partition.semanticMismatch.length > 0) {
      // 管理側が知らない提案は本文を送れない。bundleの外に、ownerへ人手で渡す
      // 匿名化草案を置く。ここから正本・catalogを書き換える経路は無い。
      const outputPath = resolve(args.output);
      // 既定はbundleと同じdirではなく子dirへ置く。`sync --bundle-dir` はdir直下の
      // *.json を全部bundleとして送ろうとするので、草案が隣にあると送信失敗として
      // 数えられる（送信前検証で必ず落ちるが、結果がok:falseになる）。
      const draftPath = typeof args.unregisteredOutput === "string"
        ? resolve(args.unregisteredOutput)
        : join(dirname(outputPath), "unregistered-candidates", `${basename(outputPath, extname(outputPath))}.unregistered-candidates.json`);
      const draft = buildUnregisteredProposalDraft({
        unregistered: partition.unregistered,
        semanticMismatch: partition.semanticMismatch,
        catalogSha256: createHash("sha256").update(catalogBytes).digest("hex"),
        build: bundle.build,
        sourceHost: bundle.sourceHost,
        signals: collectSensitiveSignals(PACKAGE_ROOT),
        homeRoot: homedir(),
      });
      await writeJsonAtomic(draftPath, draft);
      result.unregisteredDraftPath = draftPath;
      result.unregisteredDraftCounts = draft.counts;
      result.unregisteredDraftTransmitted = false;
    }
    if (args.upload === true) {
      required(args, ["endpoint"]);
      result.upload = await uploadHarnessFeedbackBundle({
        bundlePath: resolve(args.output),
        endpoint: args.endpoint,
        uploadToken: uploadToken(args),
        journalDir: typeof args.journalDir === "string"
          ? resolve(args.journalDir)
          : join(dirname(resolve(args.output)), ".feedback-upload-journal"),
      });
    }
  } else if (args.command === "verify") {
    required(args, ["bundle", "publicKey"]);
    result = await verifyHarnessFeedbackBundle({
      bundlePath: resolve(args.bundle),
      trustedPublicKeyPath: resolve(args.publicKey),
      expectedHarnessId: typeof args.harness === "string" ? args.harness : "",
      expectedCoreVersion: typeof args.coreVersion === "string" ? args.coreVersion : "",
    });
  } else if (args.command === "upload") {
    required(args, ["bundle", "endpoint"]);
    result = await uploadHarnessFeedbackBundle({
      bundlePath: resolve(args.bundle),
      endpoint: args.endpoint,
      uploadToken: uploadToken(args),
      journalDir: typeof args.journalDir === "string"
        ? resolve(args.journalDir)
        : join(dirname(resolve(args.bundle)), ".feedback-upload-journal"),
    });
  } else if (args.command === "sync") {
    required(args, ["bundleDir", "endpoint"]);
    result = await syncHarnessFeedbackBundles({
      bundleDir: resolve(args.bundleDir),
      endpoint: args.endpoint,
      uploadToken: uploadToken(args),
      journalDir: typeof args.journalDir === "string"
        ? resolve(args.journalDir)
        : join(resolve(args.bundleDir), ".feedback-upload-journal"),
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
