import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";

import {
  RELEASE_LOCKFILE_PATH,
  downloadVerifiedReleasePackage,
  extractNpmTarball,
  parseSha256File,
  releasePackageFileName,
  selectReleasePackageAssets,
} from "../lib/releasePackage.mjs";

// 自動更新はソースの ZIP（zipball_url）を取っていて、Release の公開前に package:audit で
// 検査した tgz と .sha256 を使っていなかった。更新は検査済みの tgz を取り、同じ Release の
// .sha256 と照合してから展開する。照合できなければ更新しない（fail-closed）。
// 本物の Release は取らない（fetch は差し替え）。

const VERSION = "9.8.7";
const NAME = "buzzassist-canvas-mcp";

function tarHeader(path, { size = 0, type = "0", mode = 0o644, linkName = "" } = {}) {
  const header = Buffer.alloc(512, 0);
  header.write(path, 0, 100, "utf8");
  header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write(type, 156, 1, "ascii");
  header.write(linkName, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function tgz(entries) {
  const blocks = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    blocks.push(tarHeader(entry.path, { size: entry.type && entry.type !== "0" ? 0 : content.length, type: entry.type ?? "0", mode: entry.mode, linkName: entry.linkName }));
    if (!entry.type || entry.type === "0") {
      blocks.push(content, Buffer.alloc((512 - (content.length % 512)) % 512, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

function packageEntries({ version = VERSION, lockVersion = version } = {}) {
  const manifest = JSON.stringify({ name: NAME, version });
  return [
    { path: "package/package.json", content: manifest },
    { path: "package/scripts/setup-agents.mjs", content: "// setup\n", mode: 0o755 },
    { path: `package/${RELEASE_LOCKFILE_PATH}`, content: JSON.stringify({ name: NAME, version: lockVersion, lockfileVersion: 3, packages: { "": { name: NAME, version: lockVersion } } }) },
    { path: "package/dist/index.html", content: "<!doctype html>" },
  ];
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function release({ assets = true, checksum = true } = {}) {
  const fileName = releasePackageFileName(VERSION, NAME);
  return {
    tag_name: `v${VERSION}`,
    zipball_url: `https://api.github.com/repos/example/BuzzAssist/zipball/v${VERSION}`,
    assets: assets ? [
      { name: fileName, browser_download_url: `https://github.com/example/BuzzAssist/releases/download/v${VERSION}/${fileName}`, size: 1 },
      ...(checksum ? [{ name: `${fileName}.sha256`, browser_download_url: `https://github.com/example/BuzzAssist/releases/download/v${VERSION}/${fileName}.sha256`, size: 1 }] : []),
    ] : [],
  };
}

function fakeFetch(files, { finalHost = "objects.githubusercontent.com", calls = [] } = {}) {
  return async (url) => {
    calls.push(String(url));
    const body = files[String(url).split("/").at(-1)];
    if (body === undefined) return { ok: false, status: 404, url: String(url) };
    const buffer = Buffer.from(body);
    return {
      ok: true,
      status: 200,
      url: `https://${finalHost}/production/${String(url).split("/").at(-1)}`,
      arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      text: async () => buffer.toString("utf8"),
    };
  };
}

function staging(t) {
  const dir = mkdtempSync(join(tmpdir(), "release-package-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("検査済みの tgz を .sha256 と照合してから展開し、同梱の lockfile を package-lock.json に戻す", async (t) => {
  const archive = tgz(packageEntries());
  const fileName = releasePackageFileName(VERSION, NAME);
  const calls = [];
  const dir = staging(t);
  const result = await downloadVerifiedReleasePackage({
    release: release(),
    version: VERSION,
    packageName: NAME,
    stagingDir: dir,
    fetchImpl: fakeFetch({ [fileName]: archive, [`${fileName}.sha256`]: `${sha256(archive)}  ${fileName}\n` }, { calls }),
  });
  assert.equal(result.packageSha256, sha256(archive));
  assert.equal(result.sourceDir, join(dir, "extract", "package"));
  assert.ok(existsSync(join(result.sourceDir, "scripts", "setup-agents.mjs")));
  assert.ok(existsSync(join(result.sourceDir, "package-lock.json")), "npm ci できるように lockfile を戻す");
  if (process.platform !== "win32") {
    assert.ok((statSync(join(result.sourceDir, "scripts", "setup-agents.mjs")).mode & 0o100) !== 0, "実行権限を保つ");
  }
  assert.equal(calls.some((url) => url.includes("zipball")), false, "ソースの ZIP は取らない");
});

test("SHA-256 が一致しなければ展開せずに止める", async (t) => {
  const archive = tgz(packageEntries());
  const fileName = releasePackageFileName(VERSION, NAME);
  const dir = staging(t);
  await assert.rejects(() => downloadVerifiedReleasePackage({
    release: release(),
    version: VERSION,
    packageName: NAME,
    stagingDir: dir,
    fetchImpl: fakeFetch({ [fileName]: archive, [`${fileName}.sha256`]: `${"0".repeat(64)}  ${fileName}\n` }),
  }), (error) => error.code === "release-package-sha256-mismatch");
  assert.equal(existsSync(join(dir, "extract")), false);
});

test("tgz の無い古い Release では、ソースの ZIP に落ちずに更新しない", async (t) => {
  const calls = [];
  await assert.rejects(() => downloadVerifiedReleasePackage({
    release: release({ assets: false }),
    version: VERSION,
    packageName: NAME,
    stagingDir: staging(t),
    fetchImpl: fakeFetch({}, { calls }),
  }), (error) => error.code === "release-package-missing");
  assert.deepEqual(calls, [], "何も取りに行かない");
  assert.throws(() => selectReleasePackageAssets(release({ checksum: false }), { version: VERSION, packageName: NAME }),
    (error) => error.code === "release-package-checksum-missing");
});

test("信頼していない転送先・形の崩れたチェックサムは受け付けない", async (t) => {
  const archive = tgz(packageEntries());
  const fileName = releasePackageFileName(VERSION, NAME);
  await assert.rejects(() => downloadVerifiedReleasePackage({
    release: release(),
    version: VERSION,
    packageName: NAME,
    stagingDir: staging(t),
    fetchImpl: fakeFetch({ [fileName]: archive, [`${fileName}.sha256`]: `${sha256(archive)}  ${fileName}\n` }, { finalHost: "evil.example.com" }),
  }), (error) => error.code === "release-package-untrusted-host");
  assert.throws(() => parseSha256File("not-a-hash", fileName), (error) => error.code === "release-package-checksum-invalid");
  assert.throws(() => parseSha256File(`${"a".repeat(64)}  other-1.0.0.tgz`, fileName), (error) => error.code === "release-package-checksum-invalid");
  assert.equal(parseSha256File(`${"A".repeat(64)} *${fileName}\r\n`, fileName), "a".repeat(64));
});

test("展開は package/ の下の通常のファイルとディレクトリだけを受け付ける", async (t) => {
  for (const bad of [
    { path: "package/../escape.txt", content: "x" },
    { path: "/etc/escape.txt", content: "x" },
    { path: "other/file.txt", content: "x" },
    { path: "package/link", type: "2", linkName: "/etc/passwd" },
    { path: "package/hard", type: "1", linkName: "package/package.json" },
  ]) {
    const dir = staging(t);
    await assert.rejects(() => extractNpmTarball(tgz([...packageEntries(), bad]), join(dir, "extract")),
      (error) => error.code === "release-package-unsafe-entry", bad.path);
    assert.equal(existsSync(join(dir, "escape.txt")), false);
  }
});

test("同梱の lockfile が無い・版が違う配布物は npm ci できないので止める", async (t) => {
  const fileName = releasePackageFileName(VERSION, NAME);
  for (const [entries, code] of [
    [packageEntries().filter((entry) => !entry.path.endsWith(RELEASE_LOCKFILE_PATH)), "release-package-lockfile-missing"],
    [packageEntries({ lockVersion: "0.0.1" }), "release-package-lockfile-mismatch"],
  ]) {
    const archive = tgz(entries);
    await assert.rejects(() => downloadVerifiedReleasePackage({
      release: release(),
      version: VERSION,
      packageName: NAME,
      stagingDir: staging(t),
      fetchImpl: fakeFetch({ [fileName]: archive, [`${fileName}.sha256`]: `${sha256(archive)}  ${fileName}\n` }),
    }), (error) => error.code === code);
  }
  // 読み戻して中身が正しいことも確かめる（別の版の lockfile を黙って使わない）。
  const archive = tgz(packageEntries());
  const dir = staging(t);
  const result = await downloadVerifiedReleasePackage({
    release: release(), version: VERSION, packageName: NAME, stagingDir: dir,
    fetchImpl: fakeFetch({ [fileName]: archive, [`${fileName}.sha256`]: `${sha256(archive)}  ${fileName}\n` }),
  });
  assert.equal(JSON.parse(readFileSync(join(result.sourceDir, "package-lock.json"), "utf8")).version, VERSION);
});
