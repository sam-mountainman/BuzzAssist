import { createHash } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

/**
 * BuzzAssist が自分で入れる道具（cloudflared、ffmpeg、uv、Python venv）の共通の置き場所と
 * 取得手順。管理者権限は使わず、システムの道具には触らない。
 *
 * 置き場所: BUZZASSIST_TOOLS_DIR → BUZZASSIST_HOME/tools → <home>/.buzzassist/tools
 * （cloudflared の自動取得と同じ規則。lib/cloudflaredProvision.mjs もこれを使う）
 */
export function resolveManagedToolsRoot({ env = process.env, homeDir, toolsDir } = {}) {
  const userHome = resolve(homeDir || env.BUZZASSIST_SETUP_HOME || env.HOME || env.USERPROFILE || homedir());
  return resolve(
    toolsDir
      || env.BUZZASSIST_TOOLS_DIR
      || (env.BUZZASSIST_HOME ? join(env.BUZZASSIST_HOME, "tools") : join(userHome, ".buzzassist", "tools")),
  );
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * 固定した SHA-256 と一致したときだけ中身を返す。URL は同じ中身の mirror を順に試す。
 * 一致しない中身は1バイトも書かない（呼び出し側は検証済みの Buffer しか受け取らない）。
 */
export async function downloadVerified({
  urls,
  sha256,
  label = "download",
  maxBytes = 256 * 1024 * 1024,
  fetchImpl = globalThis.fetch,
  userAgent = "BuzzAssist-tool-installer",
  attemptsPerUrl = 2,
  timeoutMs = 10 * 60 * 1000,
} = {}) {
  if (!/^[a-f0-9]{64}$/u.test(String(sha256 || ""))) throw new Error(`${label}: pinned SHA-256 is missing or malformed.`);
  const sources = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (sources.length === 0) throw new Error(`${label}: no download URL.`);
  const failures = [];
  for (const url of sources) {
    for (let attempt = 1; attempt <= attemptsPerUrl; attempt += 1) {
      try {
        const response = await fetchImpl(url, {
          redirect: "follow",
          headers: { "user-agent": userAgent },
          signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const declared = Number(response.headers?.get?.("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`download is too large (${declared} bytes)`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length === 0 || bytes.length > maxBytes) throw new Error(`invalid download size (${bytes.length} bytes)`);
        const actual = sha256Hex(bytes);
        if (actual !== sha256) throw new Error(`SHA-256 mismatch (expected ${sha256}, received ${actual})`);
        return { bytes, url };
      } catch (error) {
        failures.push(`${url}: ${error?.message || error}`);
        // 中身の不一致は、同じ URL を何度取り直しても直らない。次の mirror へ。
        if (/SHA-256 mismatch/u.test(String(error?.message))) break;
        if (attempt < attemptsPerUrl) await new Promise((resolveWait) => setTimeout(resolveWait, 500 * attempt));
      }
    }
  }
  throw new Error(`${label}: verified download failed (${failures.join(" / ")})`);
}

export async function atomicWriteFile(filePath, data, options = {}) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, data, options);
    if (options.mode) await chmod(tempPath, options.mode).catch(() => undefined);
    await rm(filePath, { force: true });
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function tarText(buffer, start, length) {
  return buffer.subarray(start, start + length).toString("utf8").replace(/\0.*$/su, "").trim();
}

/** gzip した tar から、名前が matcher に合う通常ファイルを取り出す（Map<名前, Buffer>）。 */
export function extractFilesFromTgz(archiveBuffer, matcher) {
  const tar = gunzipSync(archiveBuffer);
  const found = new Map();
  let longName = "";
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = tarText(tar, offset, 100);
    const prefix = tarText(tar, offset + 345, 155);
    const size = Number.parseInt(tarText(tar, offset + 124, 12) || "0", 8);
    const type = String.fromCharCode(tar[offset + 156] || 0);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (!Number.isFinite(size) || size < 0 || dataEnd > tar.length) throw new Error("The archive is truncated.");
    if (type === "L") {
      // GNU の長い名前。次の見出しの名前を置き換える。
      longName = tar.subarray(dataStart, dataEnd).toString("utf8").replace(/\0.*$/su, "");
    } else {
      const fullName = longName || (prefix ? `${prefix}/${name}` : name);
      longName = "";
      if ((type === "0" || type === "\0") && matcher(fullName.replace(/^\.\//u, ""))) {
        found.set(fullName.replace(/^\.\//u, ""), Buffer.from(tar.subarray(dataStart, dataEnd)));
      }
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return found;
}

function zip64Field(extra, want) {
  // want: 取り出したい 64bit 値の並び（uncompressed, compressed, offset のうち 0xFFFFFFFF だったもの）
  for (let pos = 0; pos + 4 <= extra.length;) {
    const id = extra.readUInt16LE(pos);
    const length = extra.readUInt16LE(pos + 2);
    if (id === 0x0001) {
      const values = [];
      for (let index = 0; index < want && index * 8 + 8 <= length; index += 1) {
        values.push(Number(extra.readBigUInt64LE(pos + 4 + index * 8)));
      }
      return values;
    }
    pos += 4 + length;
  }
  return [];
}

/**
 * ZIP から、名前が matcher に合うファイルを取り出す（Map<名前, Buffer>）。
 * 格納（0）と deflate（8）だけを扱う。システムの unzip / Expand-Archive に頼らないのは、
 * 最小構成の Linux に unzip が無く、Windows の PowerShell 実行ポリシーで止まることがあるため。
 */
export function extractZipEntries(archiveBuffer, matcher) {
  const buffer = Buffer.from(archiveBuffer);
  const minimum = Math.max(0, buffer.length - (22 + 0xffff));
  let eocd = -1;
  for (let pos = buffer.length - 22; pos >= minimum; pos -= 1) {
    if (buffer.readUInt32LE(pos) === 0x06054b50) { eocd = pos; break; }
  }
  if (eocd < 0) throw new Error("The ZIP archive has no end-of-central-directory record.");
  let entryCount = buffer.readUInt16LE(eocd + 10);
  let directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || directoryOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || buffer.readUInt32LE(locator) !== 0x07064b50) throw new Error("The ZIP64 locator is missing.");
    const zip64Eocd = Number(buffer.readBigUInt64LE(locator + 8));
    if (buffer.readUInt32LE(zip64Eocd) !== 0x06064b50) throw new Error("The ZIP64 end record is missing.");
    entryCount = Number(buffer.readBigUInt64LE(zip64Eocd + 32));
    directoryOffset = Number(buffer.readBigUInt64LE(zip64Eocd + 48));
  }
  const found = new Map();
  let pos = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error("The ZIP central directory is corrupt.");
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    let compressedSize = buffer.readUInt32LE(pos + 20);
    let uncompressedSize = buffer.readUInt32LE(pos + 24);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    let localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.subarray(pos + 46, pos + 46 + nameLength).toString(flags & 0x0800 ? "utf8" : "latin1");
    const extra = buffer.subarray(pos + 46 + nameLength, pos + 46 + nameLength + extraLength);
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      const values = zip64Field(extra, 3);
      let cursor = 0;
      if (uncompressedSize === 0xffffffff) uncompressedSize = values[cursor++];
      if (compressedSize === 0xffffffff) compressedSize = values[cursor++];
      if (localOffset === 0xffffffff) localOffset = values[cursor++];
    }
    pos += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/") || !matcher(name)) continue;
    if (flags & 0x0001) throw new Error(`Encrypted ZIP entry is not supported: ${name}`);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`The ZIP local header is corrupt: ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    let content;
    if (method === 0) content = Buffer.from(data);
    else if (method === 8) content = inflateRawSync(data);
    else throw new Error(`Unsupported ZIP compression method ${method}: ${name}`);
    if (content.length !== uncompressedSize) throw new Error(`The ZIP entry size does not match: ${name}`);
    found.set(name, content);
  }
  return found;
}
