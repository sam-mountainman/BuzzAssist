import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * Release の配布物（npm pack の tgz）を、同じ Release の .sha256 と照合してから展開する。
 *
 * 自動更新はソースの ZIP（zipball_url）を取っていて、公開前に package:audit で検査した tgz を
 * 使っていなかった。検査していない中身を運営者の端末へ入れないよう、更新は tgz だけを取る。
 * - tgz か .sha256 が無い（古い Release・公開の途中）なら取らない。ZIP には落ちない
 * - SHA-256 が合わなければ展開しない
 * - 展開は Node だけで行う（Windows の tar の違いに左右されない）。package/ の下の通常の
 *   ファイルとディレクトリだけを受け付け、リンク・絶対パス・".." は拒否する
 * - npm pack は package-lock.json を tgz に入れないので、prepack が release/package-lock.json に
 *   写したものを package-lock.json へ戻す（npm ci と setup-agents の検査がこれを要る）
 */

export const RELEASE_PACKAGE_NAME = "buzzassist-canvas-mcp";
export const RELEASE_LOCKFILE_PATH = "release/package-lock.json";
export const TRUSTED_RELEASE_DOWNLOAD_HOSTS = Object.freeze([
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

function coded(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

/** npm pack と同じ規則のファイル名（release.yml の package_file と同じ）。 */
export function releasePackageFileName(version, packageName = RELEASE_PACKAGE_NAME) {
  return `${String(packageName).replace(/^@/u, "").replace(/\//gu, "-")}-${String(version).replace(/^v/u, "")}.tgz`;
}

function trustedUrl(value, label) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw coded("release-package-untrusted-host", `${label} の URL が読めない。`);
  }
  if (url.protocol !== "https:" || !TRUSTED_RELEASE_DOWNLOAD_HOSTS.includes(url.hostname)) {
    throw coded("release-package-untrusted-host", `${label} の取得先 ${url.hostname} は信頼していない。`);
  }
  return url.href;
}

/** Release の asset から tgz と .sha256 を選ぶ。どちらかが無ければ更新しない。 */
export function selectReleasePackageAssets(release, { version, packageName = RELEASE_PACKAGE_NAME } = {}) {
  const fileName = releasePackageFileName(version, packageName);
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const tarball = assets.find((asset) => asset?.name === fileName);
  const checksum = assets.find((asset) => asset?.name === `${fileName}.sha256`);
  if (!tarball) {
    throw coded(
      "release-package-missing",
      `Release ${release?.tag_name || version} に検査済みの配布物 ${fileName} が無い（古い Release か、公開の途中）。`
      + "ソースの ZIP では更新しない。",
    );
  }
  if (!checksum) {
    throw coded("release-package-checksum-missing", `Release ${release?.tag_name || version} に ${fileName}.sha256 が無い。照合できないものは入れない。`);
  }
  return {
    fileName,
    tarballUrl: trustedUrl(tarball.browser_download_url, fileName),
    checksumUrl: trustedUrl(checksum.browser_download_url, `${fileName}.sha256`),
    size: Number(tarball.size) || null,
  };
}

/** `sha256sum` の出力（"<hex>  <file>"）から期待値を読む。ファイル名があれば一致を確かめる。 */
export function parseSha256File(text, fileName) {
  const line = String(text ?? "").replace(/^﻿/u, "").trim().split(/\r?\n/u)[0] || "";
  const [hash = "", name = ""] = line.trim().split(/\s+/u);
  if (!/^[a-f0-9]{64}$/iu.test(hash)) throw coded("release-package-checksum-invalid", "チェックサムの形が不正。");
  const listed = name.replace(/^\*/u, "");
  if (listed && path.posix.basename(listed.replaceAll("\\", "/")) !== fileName) {
    throw coded("release-package-checksum-invalid", `チェックサムは別のファイル（${listed}）のもの。`);
  }
  return hash.toLowerCase();
}

async function fetchTrusted(url, { fetchImpl, headers, timeoutMs, label }) {
  let response;
  try {
    response = await fetchImpl(url, { headers, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw coded("release-package-download-failed", `${label} を取得できない: ${error?.message || error}`);
  }
  if (!response?.ok) throw coded("release-package-download-failed", `${label} を取得できない（HTTP ${response?.status ?? "?"}）。`);
  const finalHost = new URL(response.url || url).hostname;
  if (!TRUSTED_RELEASE_DOWNLOAD_HOSTS.includes(finalHost)) {
    throw coded("release-package-untrusted-host", `${label} の転送先 ${finalHost} は信頼していない。`);
  }
  return response;
}

function readString(block, start, length) {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? slice.length : end).toString("utf8");
}

function readOctal(block, start, length) {
  const text = readString(block, start, length).trim();
  if (!text) return 0;
  if (!/^[0-7]+$/u.test(text)) throw coded("release-package-unsafe-entry", "tar の数値欄が読めない。");
  return Number.parseInt(text, 8);
}

function parsePax(content) {
  const values = {};
  let offset = 0;
  const text = content.toString("utf8");
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space < 0) break;
    const length = Number(text.slice(offset, space));
    if (!Number.isInteger(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length - 1);
    const equals = record.indexOf("=");
    if (equals > 0) values[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return values;
}

/** tar の中身を読む（ustar・pax の path・GNU の長い名前）。 */
export function readTarEntries(tar) {
  const entries = [];
  let offset = 0;
  let nextPath = "";
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const name = readString(header, 0, 100);
    const prefix = readString(header, 257, 6).startsWith("ustar") ? readString(header, 345, 155) : "";
    const content = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      nextPath = parsePax(content).path || nextPath;
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      nextPath = readString(content, 0, content.length);
      continue;
    }
    entries.push({
      path: nextPath || (prefix ? `${prefix}/${name}` : name),
      type: type === "\0" ? "0" : type,
      mode: readOctal(header, 100, 8),
      content,
    });
    nextPath = "";
  }
  return entries;
}

function safeRelative(entryPath) {
  const normalized = String(entryPath).replaceAll("\\", "/");
  if (!normalized.startsWith("package/") && normalized !== "package" && normalized !== "package/") return null;
  if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) return null;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === ".." || part === ".")) return null;
  return parts;
}

/** npm pack の tgz を targetDir へ展開する。危ない項目が1つでもあれば、何も書かずに止める。 */
export async function extractNpmTarball(tgzBuffer, targetDir) {
  let tar;
  try {
    tar = gunzipSync(tgzBuffer);
  } catch (error) {
    throw coded("release-package-unsafe-entry", `tgz を解凍できない: ${error?.message || error}`);
  }
  const entries = readTarEntries(tar);
  const planned = entries.map((entry) => {
    const parts = safeRelative(entry.path);
    if (!parts || !["0", "5"].includes(entry.type)) {
      throw coded("release-package-unsafe-entry", `展開しない項目: ${entry.path}（種類 ${entry.type}）`);
    }
    return { ...entry, parts };
  });
  if (!planned.some((entry) => entry.parts.join("/") === "package/package.json")) {
    throw coded("release-package-unsafe-entry", "配布物に package/package.json が無い。");
  }
  const root = path.resolve(targetDir);
  for (const entry of planned) {
    const destination = path.join(root, ...entry.parts);
    if (entry.type === "5") {
      await mkdir(destination, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entry.content);
    if (process.platform !== "win32" && (entry.mode & 0o111)) await chmod(destination, 0o755);
  }
  return { root, fileCount: planned.filter((entry) => entry.type === "0").length };
}

/** prepack が写した lockfile を package-lock.json へ戻す（版が合わなければ止める）。 */
export async function restoreReleaseLockfile(sourceDir) {
  const target = path.join(sourceDir, "package-lock.json");
  const staged = path.join(sourceDir, ...RELEASE_LOCKFILE_PATH.split("/"));
  if (!existsSync(staged)) {
    if (existsSync(target)) return { restored: false };
    throw coded("release-package-lockfile-missing", `配布物に ${RELEASE_LOCKFILE_PATH} が無く、依存を固定して入れられない。`);
  }
  const manifest = JSON.parse(await readFile(path.join(sourceDir, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(staged, "utf8"));
  if (lock?.name !== manifest?.name || lock?.version !== manifest?.version) {
    throw coded("release-package-lockfile-mismatch", `同梱の lockfile（${lock?.name}@${lock?.version}）が配布物（${manifest?.name}@${manifest?.version}）と合わない。`);
  }
  await copyFile(staged, target);
  return { restored: true };
}

/** .sha256 だけを取って期待値を返す（展開済みの版を使い回してよいかの判定にも使う）。 */
export async function fetchReleasePackageChecksum({ release, version, packageName = RELEASE_PACKAGE_NAME, fetchImpl = fetch, headers = {} } = {}) {
  const assets = selectReleasePackageAssets(release, { version, packageName });
  const response = await fetchTrusted(assets.checksumUrl, { fetchImpl, headers, timeoutMs: 20_000, label: `${assets.fileName}.sha256` });
  return { ...assets, expectedSha256: parseSha256File(await response.text(), assets.fileName) };
}

/**
 * tgz を取り、.sha256 と照合し、stagingDir/extract へ展開して、展開した package/ の場所を返す。
 */
export async function downloadVerifiedReleasePackage({
  release,
  version,
  packageName = RELEASE_PACKAGE_NAME,
  stagingDir,
  fetchImpl = fetch,
  headers = {},
  expectedSha256 = "",
} = {}) {
  const checksum = expectedSha256
    ? { ...selectReleasePackageAssets(release, { version, packageName }), expectedSha256 }
    : await fetchReleasePackageChecksum({ release, version, packageName, fetchImpl, headers });
  const response = await fetchTrusted(checksum.tarballUrl, { fetchImpl, headers, timeoutMs: 300_000, label: checksum.fileName });
  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (actual !== checksum.expectedSha256) {
    throw coded(
      "release-package-sha256-mismatch",
      `取得した ${checksum.fileName} の SHA-256 が Release の .sha256 と合わない（期待 ${checksum.expectedSha256} / 実際 ${actual}）。壊れた・差し替えられた可能性があるので使わない。`,
    );
  }
  await mkdir(stagingDir, { recursive: true });
  await writeFile(path.join(stagingDir, checksum.fileName), buffer);
  const extractDir = path.join(stagingDir, "extract");
  await extractNpmTarball(buffer, extractDir);
  const sourceDir = path.join(extractDir, "package");
  await restoreReleaseLockfile(sourceDir);
  return { sourceDir, packageSha256: actual, fileName: checksum.fileName };
}
