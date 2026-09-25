#!/usr/bin/env node
// npm tarball（release artifact そのもの）の内容監査。
//
//   node scripts/audit-package-tarball.mjs                       # npm pack して監査
//   node scripts/audit-package-tarball.mjs --tarball <file.tgz>  # 既存 tgz を監査
//   node scripts/audit-package-tarball.mjs --json
//   node scripts/audit-package-tarball.mjs --allow-missing-signals   # 語彙ゼロでも exit 0（開発用）
//
//   # 検査語彙（鍵つき digest）を作り直す。平文一覧も鍵も git 追跡外。
//   node scripts/audit-package-tarball.mjs build-vocabulary \
//     --terms-file docs/learning/sensitive-vocabulary.local.txt \
//     [--include-channel-packs] [--new-key | --rotate-key] [--key-file <path>] \
//     --output docs/learning/sensitive-vocabulary.digest.json
//
//   鍵は BUZZASSIST_SENSITIVE_VOCABULARY_KEY（hex）か ~/.buzzassist/sensitive-vocabulary.key。
//   --new-key は鍵が無いときだけ作る（0600）。--rotate-key は作り直す。
//   CI では同名の secret を渡す。無ければ語彙は「使えない」＝未検査として止まる。
//
// 既定は fail-closed: 検査語彙（Channel Pack 由来 or digest）が1つも無ければ、
// 無検出でも exit 3 で止まる。CI には channel-packs/ が無いので、以前は語彙が
// 空のまま「無検出＝成功」で publish まで通っていた（2026-09-05 独立レビュー D-3）。

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditPackageTarball,
  buildSensitiveVocabularyDigest,
  defaultVocabularyKeyPath,
  parseSensitiveVocabularyDigest,
  PACKAGE_RUNTIME_REQUIRED_PATHS,
  resolveVocabularyKey,
  SENSITIVE_VOCABULARY_KEY_ENV,
  VocabularyKeyMissingError,
} from "../lib/packageTarballAudit.mjs";
import { collectSensitiveSignals, readAllowlist } from "./audit-public-surface.mjs";
import { stageReleaseLockfile } from "./stage-release-lock.mjs";
import { isDirectCli } from "../lib/cliEntrypoint.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const SENSITIVE_VOCABULARY_DIGEST_PATH = "docs/learning/sensitive-vocabulary.digest.json";
export const SENSITIVE_VOCABULARY_LOCAL_PATH = "docs/learning/sensitive-vocabulary.local.txt";

const FLAGS = new Set(["--json", "--require-signals", "--allow-missing-signals", "--include-channel-packs", "--new-key", "--rotate-key"]);
const VALUES = new Set(["--tarball", "--project-dir", "--vocabulary", "--terms-file", "--output", "--key-file"]);

function parseArgs(argv) {
  const out = { command: "audit" };
  let index = 0;
  if (argv[0] === "build-vocabulary" || argv[0] === "audit") {
    out.command = argv[0];
    index = 1;
  }
  for (; index < argv.length; index += 1) {
    const token = argv[index];
    if (FLAGS.has(token)) out[token.slice(2)] = true;
    else if (VALUES.has(token)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${token} には値が要る。`);
      out[token.slice(2)] = value;
      index += 1;
    } else if (token === "--new-salt") {
      throw new Error("--new-salt は廃止した（公開 salt の digest は総当たりで復元される）。--new-key か --rotate-key を使う。");
    } else throw new Error(`不明な引数: ${token}`);
  }
  return out;
}

// npm をどう起動するか。npm run から呼ばれたときは npm 本体の JS を node で直接
// 起動する（シェルを通さないので引数のパスに空白があっても壊れない）。直接呼ばれた
// Windows では npm.cmd をシェル経由で起動するので、引数を二重引用符で囲む。
// "npm" をシェルなしで起動していたので、Windows の CI で spawnSync npm ENOENT になった。
export function npmInvocation(args, { env = process.env, platform = process.platform, execPath = process.execPath } = {}) {
  const cli = String(env.npm_execpath || "");
  if (/\.(?:c?js|mjs)$/u.test(cli)) return { command: execPath, args: [cli, ...args], shell: false };
  if (platform === "win32") {
    return { command: "npm.cmd", args: args.map((value) => `"${String(value).replaceAll("\"", "\"\"")}"`), shell: true };
  }
  return { command: "npm", args, shell: false };
}

function createTarball(projectDir) {
  // --ignore-scripts で pack するので prepack が走らない。prepack と同じく lockfile を同梱物へ写す。
  stageReleaseLockfile(projectDir);
  const destination = mkdtempSync(join(tmpdir(), "buzzassist-package-audit-"));
  try {
    const npm = npmInvocation(["pack", "--json", "--ignore-scripts", "--pack-destination", destination]);
    const stdout = execFileSync(npm.command, npm.args, {
      cwd: projectDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: npm.shell,
    });
    const manifest = JSON.parse(stdout)[0];
    if (!manifest?.filename) throw new Error("npm packがfilenameを返さなかった。");
    return { bytes: readFileSync(join(destination, basename(manifest.filename))), cleanup: () => rmSync(destination, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

const readKeyFile = (file) => readFileSync(file, "utf8");

/**
 * digest 語彙を読む。状態を3つに分けて返す。
 *   available    … 照合できる
 *   missing-file … 語彙ファイルが無い
 *   missing-key  … ファイルはあるが鍵が無い（CI で secret 未設定など）
 * missing-key を「語彙なし」と同じに丸めない。ファイルがあるのは「この語を
 * 見ること」の宣言なので、鍵が無くて見られないなら未検査として扱う。
 * 壊れている・鍵が違う場合は throw。
 */
export function loadSensitiveVocabulary(file, { projectDir = REPO_ROOT, env = process.env, keyPath = "" } = {}) {
  if (!file || !existsSync(file)) return { vocabulary: null, state: "missing-file", reason: `${file} が無い` };
  const text = readFileSync(file, "utf8");
  const resolved = resolveVocabularyKey({ env, keyPath, projectDir, readKeyFile });
  if (!resolved.key) {
    // 鍵が無くても形式の検査はする（壊れた一覧や v1 を黙って通さない）。
    try {
      parseSensitiveVocabularyDigest(text, {});
    } catch (error) {
      if (!(error instanceof VocabularyKeyMissingError)) throw error;
    }
    return { vocabulary: null, state: "missing-key", reason: resolved.reason };
  }
  return { vocabulary: parseSensitiveVocabularyDigest(text, { key: resolved.key }), state: "available", keySource: resolved.source };
}

/** 互換のための薄い包み。照合できないときは null。 */
export function loadSensitiveVocabularyDigest(file, options = {}) {
  return loadSensitiveVocabulary(file, options).vocabulary;
}

export function runPackageTarballAudit({ tarballPath = "", projectDir = REPO_ROOT, vocabularyPath = "" } = {}) {
  const root = resolve(projectDir);
  const generated = tarballPath ? null : createTarball(root);
  try {
    const bytes = generated?.bytes || readFileSync(resolve(tarballPath));
    const signals = collectSensitiveSignals(root);
    const vocabularyFile = vocabularyPath ? resolve(vocabularyPath) : join(root, SENSITIVE_VOCABULARY_DIGEST_PATH);
    const loaded = loadSensitiveVocabulary(vocabularyFile, { projectDir: root });
    const vocabularyDigest = loaded.vocabulary;
    return {
      ...auditPackageTarball(bytes, {
        ...signals,
        vocabularyDigest,
        homeRoot: homedir(),
        allowlist: readAllowlist(root),
        requiredPaths: PACKAGE_RUNTIME_REQUIRED_PATHS,
      }),
      vocabularyDigestPath: vocabularyDigest ? vocabularyFile : null,
      vocabularyState: loaded.state,
      vocabularyUnavailableReason: loaded.state === "available" ? null : loaded.reason,
    };
  } finally {
    generated?.cleanup();
  }
}

/** 平文一覧（1行1語、# はコメント）を読む。語そのものは戻り値以外へ出さない。 */
export function readVocabularyTermsFile(file) {
  return readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+#.*$/u, "").trim())
    .filter((line) => line && !line.startsWith("#"));
}

/** 鍵ファイルを作る。リポジトリ配下には作らない。既にあれば rotate のときだけ作り直す。 */
export function ensureVocabularyKeyFile({ keyPath = "", projectDir = REPO_ROOT, rotate = false } = {}) {
  const file = keyPath ? resolve(keyPath) : defaultVocabularyKeyPath();
  // resolveVocabularyKey と同じ理由で、リポジトリ配下を拒否する。
  resolveVocabularyKey({ env: {}, keyPath: file, projectDir, readKeyFile: () => { throw Object.assign(new Error("probe"), { code: "ENOENT" }); } });
  if (existsSync(file) && !rotate) return { keyPath: file, created: false };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  return { keyPath: file, created: true };
}

export function buildVocabularyDigestFile({
  termsFile = "", output, projectDir = REPO_ROOT, includeChannelPacks = false,
  newKey = false, rotateKey = false, keyPath = "", env = process.env, now = new Date().toISOString(),
} = {}) {
  if (!output) throw new Error("--output が必要。");
  const terms = [];
  if (termsFile) terms.push(...readVocabularyTermsFile(resolve(termsFile)));
  if (includeChannelPacks) {
    // 表示名だけ。castId は一般語と衝突するので単独一致では使わず、
    // 従来どおり channel-roster（同居密度）で見る。
    const signals = collectSensitiveSignals(resolve(projectDir));
    terms.push(...signals.terms);
  }
  if (terms.length === 0) throw new Error("語が1つも無い。--terms-file か --include-channel-packs を指定すること。");
  let keyCreated = false;
  if (newKey || rotateKey) {
    if (String(env?.[SENSITIVE_VOCABULARY_KEY_ENV] || "").trim()) {
      throw new Error(`${SENSITIVE_VOCABULARY_KEY_ENV} が設定されている間は鍵ファイルを作らない（どちらが使われるか曖昧になる）。`);
    }
    keyCreated = ensureVocabularyKeyFile({ keyPath, projectDir, rotate: rotateKey }).created;
  }
  const resolved = resolveVocabularyKey({ env, keyPath, projectDir: resolve(projectDir), readKeyFile });
  if (!resolved.key) {
    throw new VocabularyKeyMissingError(`${resolved.reason}。初回は --new-key で作る。`);
  }
  const digest = buildSensitiveVocabularyDigest(terms, { key: resolved.key, generatedAt: now });
  const target = resolve(output);
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(digest, null, 2)}\n`);
  renameSync(temp, target);
  // 鍵そのものは返さない。
  return { output: target, termCount: digest.termCount, inputCount: terms.length, keyId: digest.keyId, keySource: resolved.source, keyCreated };
}

if (isDirectCli(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.command === "build-vocabulary") {
      const result = buildVocabularyDigestFile({
        termsFile: args["terms-file"] || "",
        output: args.output || join(args["project-dir"] || REPO_ROOT, SENSITIVE_VOCABULARY_DIGEST_PATH),
        projectDir: args["project-dir"] || REPO_ROOT,
        includeChannelPacks: Boolean(args["include-channel-packs"]),
        newKey: Boolean(args["new-key"]),
        rotateKey: Boolean(args["rotate-key"]),
        keyPath: args["key-file"] || "",
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      const report = runPackageTarballAudit({
        tarballPath: args.tarball || "",
        projectDir: args["project-dir"] || REPO_ROOT,
        vocabularyPath: args.vocabulary || "",
      });
      if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else {
        process.stdout.write(`npm tarball content audit: ${report.status} (${report.entryCount} files, ${report.findings.length} findings, ${report.accepted.length} accepted risks)\n`);
        process.stdout.write(`  signals: channel-pack=${report.channelSignalsAvailable ? "yes" : "no"} vocabulary-digest=${report.vocabularyDigestAvailable ? report.vocabularyTermCount : report.vocabularyState}\n`);
        for (const finding of report.findings) process.stdout.write(`  ${finding.type}: ${finding.path} (${finding.count || 1})\n`);
        for (const finding of report.accepted) process.stdout.write(`  accepted ${finding.type}: ${finding.path} (${finding.count || 1}/${finding.allowedCount})\n`);
        process.stdout.write(`  sha256=${report.tarballSha256}\n`);
      }
      if (!report.gateOk) process.exitCode = 2;
      // 語彙ファイルがあるのに鍵が無い＝その語を見ていない。Channel Pack の語だけで
      // 「検査した」と言わない（pack の語彙は digest の一部しか持っていない）。
      else if (report.vocabularyState === "missing-key" && !args["allow-missing-signals"]) {
        process.stderr.write(`検査語彙の鍵が無いので、${SENSITIVE_VOCABULARY_DIGEST_PATH} の語を照合していない（${report.vocabularyUnavailableReason}）。`
          + `${SENSITIVE_VOCABULARY_KEY_ENV} を渡すか、開発用途なら --allow-missing-signals を付ける。\n`);
        process.exitCode = 3;
      }
      // 語彙ゼロの無検出は成功ではない。--allow-missing-signals を明示した開発用途だけ通す。
      else if (!report.signalsAvailable && !args["allow-missing-signals"]) {
        process.stderr.write(`検査語彙が無いため無検出を成功と読めない（status=${report.status}）。${SENSITIVE_VOCABULARY_DIGEST_PATH} を置くか、開発用途なら --allow-missing-signals を付ける。\n`);
        process.exitCode = 3;
      }
    }
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
