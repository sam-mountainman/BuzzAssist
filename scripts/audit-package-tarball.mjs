#!/usr/bin/env node
// npm tarball（release artifact そのもの）の内容監査。
//
//   node scripts/audit-package-tarball.mjs                       # npm pack して監査
//   node scripts/audit-package-tarball.mjs --tarball <file.tgz>  # 既存 tgz を監査
//   node scripts/audit-package-tarball.mjs --json
//   node scripts/audit-package-tarball.mjs --allow-missing-signals   # 語彙ゼロでも exit 0（開発用）
//
//   # 検査語彙（salted digest）を作り直す。平文一覧は git 追跡外。
//   node scripts/audit-package-tarball.mjs build-vocabulary \
//     --terms-file docs/learning/sensitive-vocabulary.local.txt \
//     [--include-channel-packs] [--new-salt] \
//     --output docs/learning/sensitive-vocabulary.digest.json
//
// 既定は fail-closed: 検査語彙（Channel Pack 由来 or digest）が1つも無ければ、
// 無検出でも exit 3 で止まる。CI には channel-packs/ が無いので、以前は語彙が
// 空のまま「無検出＝成功」で publish まで通っていた（2026-09-05 独立レビュー D-3）。

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditPackageTarball,
  buildSensitiveVocabularyDigest,
  parseSensitiveVocabularyDigest,
  PACKAGE_RUNTIME_REQUIRED_PATHS,
} from "../lib/packageTarballAudit.mjs";
import { collectSensitiveSignals, readAllowlist } from "./audit-public-surface.mjs";
import { isDirectCli } from "../lib/cliEntrypoint.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const SENSITIVE_VOCABULARY_DIGEST_PATH = "docs/learning/sensitive-vocabulary.digest.json";
export const SENSITIVE_VOCABULARY_LOCAL_PATH = "docs/learning/sensitive-vocabulary.local.txt";

const FLAGS = new Set(["--json", "--require-signals", "--allow-missing-signals", "--include-channel-packs", "--new-salt"]);
const VALUES = new Set(["--tarball", "--project-dir", "--vocabulary", "--terms-file", "--output"]);

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
    } else throw new Error(`不明な引数: ${token}`);
  }
  return out;
}

function createTarball(projectDir) {
  const destination = mkdtempSync(join(tmpdir(), "buzzassist-package-audit-"));
  try {
    const stdout = execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", destination],
      { cwd: projectDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const manifest = JSON.parse(stdout)[0];
    if (!manifest?.filename) throw new Error("npm packがfilenameを返さなかった。");
    return { bytes: readFileSync(join(destination, basename(manifest.filename))), cleanup: () => rmSync(destination, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

/** digest 語彙を読む。無ければ null（＝語彙なし。呼び出し側が fail-closed を判断する）。壊れていれば throw。 */
export function loadSensitiveVocabularyDigest(file) {
  if (!file || !existsSync(file)) return null;
  return parseSensitiveVocabularyDigest(readFileSync(file, "utf8"));
}

export function runPackageTarballAudit({ tarballPath = "", projectDir = REPO_ROOT, vocabularyPath = "" } = {}) {
  const root = resolve(projectDir);
  const generated = tarballPath ? null : createTarball(root);
  try {
    const bytes = generated?.bytes || readFileSync(resolve(tarballPath));
    const signals = collectSensitiveSignals(root);
    const vocabularyFile = vocabularyPath ? resolve(vocabularyPath) : join(root, SENSITIVE_VOCABULARY_DIGEST_PATH);
    const vocabularyDigest = loadSensitiveVocabularyDigest(vocabularyFile);
    return {
      ...auditPackageTarball(bytes, {
        ...signals,
        vocabularyDigest,
        homeRoot: homedir(),
        allowlist: readAllowlist(root),
        requiredPaths: PACKAGE_RUNTIME_REQUIRED_PATHS,
      }),
      vocabularyDigestPath: vocabularyDigest ? vocabularyFile : null,
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

export function buildVocabularyDigestFile({
  termsFile = "", output, projectDir = REPO_ROOT, includeChannelPacks = false, newSalt = false, now = new Date().toISOString(),
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
  const target = resolve(output);
  let salt = "";
  if (!newSalt && existsSync(target)) {
    // salt を維持すると同じ語は同じ digest になり、差分が「増えた語・消えた語」だけになる。
    try { salt = parseSensitiveVocabularyDigest(readFileSync(target, "utf8")).salt; } catch { salt = ""; }
  }
  const digest = buildSensitiveVocabularyDigest(terms, { salt, generatedAt: now });
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(digest, null, 2)}\n`);
  renameSync(temp, target);
  return { output: target, termCount: digest.termCount, inputCount: terms.length, saltReused: Boolean(salt) };
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
        newSalt: Boolean(args["new-salt"]),
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
        process.stdout.write(`  signals: channel-pack=${report.channelSignalsAvailable ? "yes" : "no"} vocabulary-digest=${report.vocabularyDigestAvailable ? report.vocabularyTermCount : "no"}\n`);
        for (const finding of report.findings) process.stdout.write(`  ${finding.type}: ${finding.path} (${finding.count || 1})\n`);
        for (const finding of report.accepted) process.stdout.write(`  accepted ${finding.type}: ${finding.path} (${finding.count || 1}/${finding.allowedCount})\n`);
        process.stdout.write(`  sha256=${report.tarballSha256}\n`);
      }
      if (!report.gateOk) process.exitCode = 2;
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
