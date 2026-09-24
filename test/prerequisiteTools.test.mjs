import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateRawSync, gzipSync } from "node:zlib";

import {
  extractFilesFromTgz,
  extractZipEntries,
  resolveManagedToolsRoot,
} from "../lib/managedToolDownload.mjs";
import {
  MANAGED_FFMPEG_VERSION,
  appendManagedToolsToPath,
  baseVenvPythonCandidates,
  ensureManagedFfmpeg,
  ensureManagedPythonVenv,
  managedFfmpegPaths,
  managedPythonVenvPaths,
  probeTesseract,
  resolveFfmpegAsset,
  resolveUvAsset,
} from "../lib/prerequisiteTools.mjs";
import { pythonRuntimeCandidates, resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

// 最小の ZIP（格納と deflate）を組み立てる。配布元の zip と同じ読み方で読めることを確かめる。
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, content, method = 8 } of entries) {
    const nameBuffer = Buffer.from(name, "utf8");
    const data = method === 8 ? deflateRawSync(content) : content;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function buildTgz(entries) {
  const blocks = [];
  for (const { name, content } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000755\0", 100);
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("0", 156);
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function fakeFetch(map, counter = { count: 0 }) {
  return async (url) => {
    counter.count += 1;
    const body = map.get(url);
    if (!body) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, headers: { get: () => String(body.length) }, arrayBuffer: async () => body };
  };
}

test("the pinned ffmpeg table covers macOS, Linux and Windows with verified-looking checksums from the named distributors", () => {
  for (const [platform, arch] of [["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"], ["linux", "arm64"], ["win32", "x64"], ["win32", "arm64"]]) {
    const asset = resolveFfmpegAsset({ platform, arch });
    assert.ok(asset, `${platform}/${arch}`);
    assert.equal(asset.version, MANAGED_FFMPEG_VERSION);
    const tools = new Set();
    for (const archive of asset.archives) {
      assert.match(archive.sha256, /^[a-f0-9]{64}$/u);
      for (const url of archive.urls) {
        assert.match(url, /^https:\/\/(?:ffmpeg\.martin-riedl\.de\/download\/|www\.gyan\.dev\/ffmpeg\/builds\/packages\/|github\.com\/GyanD\/codexffmpeg\/releases\/download\/)/u);
        assert.ok(url.includes(MANAGED_FFMPEG_VERSION), "URL must pin the version");
      }
      for (const tool of Object.keys(archive.entries)) tools.add(tool);
    }
    assert.deepEqual([...tools].sort(), ["ffmpeg", "ffprobe"]);
  }
  assert.equal(resolveFfmpegAsset({ platform: "freebsd", arch: "x64" }), null);
  for (const [platform, arch] of [["darwin", "arm64"], ["linux", "x64"], ["win32", "x64"]]) {
    const uv = resolveUvAsset({ platform, arch });
    assert.match(uv.sha256, /^[a-f0-9]{64}$/u);
    assert.match(uv.url, /^https:\/\/github\.com\/astral-sh\/uv\/releases\/download\/\d+\.\d+\.\d+\//u);
  }
});

test("ZIP and tar.gz extraction read the entries the official archives use", () => {
  const ffmpeg = Buffer.from("ffmpeg binary\n".repeat(100));
  const probe = Buffer.from("ffprobe binary");
  const zip = buildZip([
    { name: "ffmpeg-9.0.2-essentials_build/bin/", content: Buffer.alloc(0), method: 0 },
    { name: "ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe", content: ffmpeg },
    { name: "ffmpeg-9.0.2-essentials_build/bin/ffprobe.exe", content: probe, method: 0 },
  ]);
  const files = extractZipEntries(zip, (name) => name.endsWith(".exe"));
  assert.deepEqual([...files.keys()], ["ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe", "ffmpeg-9.0.2-essentials_build/bin/ffprobe.exe"]);
  assert.equal(files.get("ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe").toString(), ffmpeg.toString());
  assert.throws(() => extractZipEntries(Buffer.from("not a zip at all, no end record here"), () => true), /end-of-central-directory/u);

  const tgz = buildTgz([{ name: "uv-aarch64-apple-darwin/uv", content: Buffer.from("uv") }, { name: "uv-aarch64-apple-darwin/uvx", content: Buffer.from("uvx") }]);
  const uv = extractFilesFromTgz(tgz, (name) => path.posix.basename(name) === "uv");
  assert.deepEqual([...uv.keys()], ["uv-aarch64-apple-darwin/uv"]);
});

test("managed ffmpeg is downloaded once against the pinned SHA-256, reused, and a tampered archive leaves nothing behind", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "buzzassist-ffmpeg-"));
  try {
    const ffmpegZip = buildZip([{ name: "ffmpeg", content: Buffer.from("ffmpeg version 9.0.2 fake") }]);
    const ffprobeZip = buildZip([{ name: "ffprobe", content: Buffer.from("ffprobe version 9.0.2 fake") }]);
    const asset = {
      key: "test-x64",
      provider: "test",
      version: MANAGED_FFMPEG_VERSION,
      archives: [
        { name: "ffmpeg.zip", urls: ["https://mirror.invalid/a/ffmpeg.zip"], sha256: digest(ffmpegZip), entries: { ffmpeg: "ffmpeg" } },
        { name: "ffprobe.zip", urls: ["https://mirror.invalid/a/ffprobe.zip"], sha256: digest(ffprobeZip), entries: { ffprobe: "ffprobe" } },
      ],
    };
    const counter = { count: 0 };
    const fetchImpl = fakeFetch(new Map([
      ["https://mirror.invalid/a/ffmpeg.zip", ffmpegZip],
      ["https://mirror.invalid/a/ffprobe.zip", ffprobeZip],
    ]), counter);
    const verifyBinary = async (filePath, name) => (await readFile(filePath, "utf8")).startsWith(`${name} version`);
    const first = await ensureManagedFfmpeg({ platform: "linux", arch: "x64", homeDir, env: {}, asset, fetchImpl, verifyBinary });
    assert.equal(first.ok, true, first.detail);
    assert.equal(first.status, "managed-download");
    assert.equal(counter.count, 2);
    const paths = managedFfmpegPaths({ platform: "linux", arch: "x64", homeDir, env: {} });
    assert.equal(paths.root, path.join(homeDir, ".buzzassist", "tools"), "same place as the managed cloudflared");
    assert.equal(await readFile(paths.ffprobe, "utf8"), "ffprobe version 9.0.2 fake");
    if (process.platform !== "win32") assert.equal((await stat(paths.ffmpeg)).mode & 0o111, 0o111);
    const second = await ensureManagedFfmpeg({ platform: "linux", arch: "x64", homeDir, env: {}, asset, fetchImpl, verifyBinary });
    assert.equal(second.status, "managed-cache");
    assert.equal(counter.count, 2, "a valid cache must not download again");

    const tampered = { ...asset, key: "test-tampered", archives: [{ ...asset.archives[0], sha256: "0".repeat(64) }, asset.archives[1]] };
    const failed = await ensureManagedFfmpeg({ platform: "linux", arch: "arm64", homeDir, env: {}, asset: tampered, fetchImpl, verifyBinary });
    assert.equal(failed.ok, false);
    assert.match(failed.detail, /SHA-256 mismatch/u);
    await assert.rejects(stat(managedFfmpegPaths({ platform: "linux", arch: "arm64", homeDir, env: {} }).binDir), { code: "ENOENT" });
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("the resolver keeps explicit paths first, then PATH, then the managed tools; entrypoints append managed ffmpeg after PATH", async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), "buzzassist-tools-"));
  try {
    const env = { BUZZASSIST_TOOLS_DIR: toolsDir, PATH: "/opt/operator/bin" };
    const paths = managedFfmpegPaths({ env });
    await mkdir(paths.binDir, { recursive: true });
    await writeFile(paths.ffmpeg, "fake");
    await writeFile(paths.ffprobe, "fake");
    const calls = [];
    const runCommand = async (command) => {
      calls.push(command);
      if (command === "ffmpeg" || command === "ffprobe") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      const label = command.includes("probe") ? "ffprobe" : "ffmpeg";
      return { stdout: `${label} version 9.0.2-managed`, stderr: "" };
    };
    const resolved = await resolveFfmpegToolchain({ env, runCommand });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.ffmpeg.source, "buzzassist-tools");
    assert.equal(resolved.ffmpeg.command, paths.ffmpeg);
    assert.deepEqual(calls.slice(0, 2), ["ffmpeg", paths.ffmpeg], "PATH first, managed second");
    const explicit = await resolveFfmpegToolchain({ env: { ...env, FFMPEG_PATH: "/x/ffmpeg", FFPROBE_PATH: "/x/ffprobe" }, runCommand });
    assert.equal(explicit.ffmpeg.command, "/x/ffmpeg", "explicit env stays exclusive");

    const pathEnv = { ...env };
    assert.equal(appendManagedToolsToPath(pathEnv).changed, true);
    const separator = process.platform === "win32" ? ";" : ":";
    assert.deepEqual(pathEnv.PATH.split(separator), ["/opt/operator/bin", paths.binDir]);
    assert.equal(appendManagedToolsToPath(pathEnv).changed, false, "idempotent");

    const venv = managedPythonVenvPaths({ env, platform: "linux" });
    await mkdir(path.dirname(venv.python), { recursive: true });
    await writeFile(venv.python, "");
    const candidates = pythonRuntimeCandidates({ env, platform: "linux", projectDir: toolsDir });
    const order = candidates.map((entry) => entry.source);
    assert.ok(order.indexOf("buzzassist-tools-venv") > order.lastIndexOf("path"), "managed venv comes after PATH interpreters");
    assert.equal(pythonRuntimeCandidates({ env: { ...env, BUZZASSIST_PYTHON: "/opt/py" }, platform: "linux", projectDir: toolsDir }).length, 1, "explicit interpreter stays exclusive");
  } finally {
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test("the Python venv is built from an existing Python 3.10+, and with a verified uv when none is usable", async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), "buzzassist-venv-"));
  try {
    const env = { BUZZASSIST_TOOLS_DIR: toolsDir };
    const paths = managedPythonVenvPaths({ env, platform: "linux", arch: "x64" });
    const calls = [];
    let venvReady = false;
    const runCommand = async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args.some((arg) => arg.includes("BUZZASSIST_PY="))) {
        return command === "old-python"
          ? { ok: true, stdout: "BUZZASSIST_PY=3.9\n", stderr: "" }
          : { ok: true, stdout: "BUZZASSIST_PY=3.12\n", stderr: "" };
      }
      if (args.includes("venv") && args.includes(paths.venvDir)) {
        await mkdir(path.dirname(paths.python), { recursive: true });
        await writeFile(paths.python, "");
        return { ok: true, stdout: "", stderr: "" };
      }
      if (args.includes("install")) { venvReady = true; return { ok: true, stdout: "installed", stderr: "" }; }
      if (command === paths.python) {
        return { ok: true, stdout: `BUZZASSIST_VENV_MISSING=${venvReady ? "" : "cv2:CascadeClassifier,numpy,PIL"}\n`, stderr: "" };
      }
      return { ok: false, stdout: "", stderr: "unexpected" };
    };
    const created = await ensureManagedPythonVenv({
      platform: "linux", arch: "x64", env, runCommand,
      baseCandidates: [{ command: "old-python", args: [] }, { command: "python3.12", args: [] }],
    });
    assert.equal(created.ok, true, created.detail);
    assert.equal(created.status, "venv-created");
    assert.ok(calls.some((call) => call.startsWith(`python3.12 -m venv ${paths.venvDir}`)), calls.join("\n"));
    assert.ok(calls.some((call) => call.includes("-m pip install") && call.includes("opencv-python-headless<5") && call.includes("pillow")));
    assert.equal(calls.some((call) => /torch/u.test(call)), false, "heavy voice-quality dependencies are never installed");
    const reused = await ensureManagedPythonVenv({ platform: "linux", arch: "x64", env, runCommand, baseCandidates: [] });
    assert.equal(reused.status, "managed-cache");

    // 使える Python が無い端末: uv（SHA-256 固定）で Python ごと用意する。
    await rm(paths.venvDir, { recursive: true, force: true });
    venvReady = false;
    const uvBinary = Buffer.from("uv binary");
    const uvArchive = buildTgz([{ name: "uv-x86_64-unknown-linux-gnu/uv", content: uvBinary }]);
    const uvAsset = { name: "uv-x86_64-unknown-linux-gnu.tar.gz", sha256: digest(uvArchive), url: "https://mirror.invalid/uv.tar.gz", version: "test" };
    calls.length = 0;
    const withUv = await ensureManagedPythonVenv({
      platform: "linux", arch: "x64", env, runCommand, baseCandidates: [{ command: "old-python", args: [] }],
      uvAsset, fetchImpl: fakeFetch(new Map([[uvAsset.url, uvArchive]])),
    });
    assert.equal(withUv.ok, true, withUv.detail);
    assert.equal(withUv.status, "venv-created-with-uv");
    const uvPath = path.join(paths.uvDir, "uv");
    assert.equal(await readFile(uvPath, "utf8"), "uv binary");
    assert.ok(calls.some((call) => call.startsWith(`${uvPath} venv --python 3.12 ${paths.venvDir}`)), calls.join("\n"));
    assert.ok(calls.some((call) => call.startsWith(`${uvPath} pip install --python ${paths.python}`)));
  } finally {
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test("macOS without Command Line Tools never launches the /usr/bin/python3 installer stub", {
  skip: process.platform === "win32" ? "Windows には /usr/bin/python3 の導入スタブが無い（実行権限つきの偽 python3 を置けない）" : false,
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "buzzassist-python-candidates-"));
  try {
    await writeFile(path.join(dir, "python3"), "");
    const env = { PATH: `/usr/bin:${dir}` };
    const withoutClt = await baseVenvPythonCandidates({ env, platform: "darwin", runCommand: async () => ({ ok: false }) });
    assert.equal(withoutClt.some((entry) => entry.command.startsWith("/usr/bin/")), false);
    assert.ok(withoutClt.some((entry) => entry.command === path.join(dir, "python3")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tesseract is only reported, with an install hint when Japanese data is missing", async () => {
  const missing = await probeTesseract({ env: {}, platform: "darwin", runCommand: async () => ({ ok: false, stdout: "", stderr: "" }) });
  assert.equal(missing.status, "missing");
  assert.match(missing.hint, /brew install tesseract tesseract-lang/u);
  const noJapanese = await probeTesseract({ env: {}, platform: "linux", runCommand: async () => ({ ok: true, stdout: "List of available languages (2):\neng\nosd\n", stderr: "" }) });
  assert.equal(noJapanese.status, "missing-jpn");
  assert.match(noJapanese.hint, /tesseract-ocr-jpn/u);
  const ready = await probeTesseract({ env: {}, runCommand: async () => ({ ok: true, stdout: "eng\njpn\n", stderr: "" }) });
  assert.equal(ready.ok, true);
});

test("managed tools share one root with the cloudflared cache", () => {
  assert.equal(resolveManagedToolsRoot({ env: { BUZZASSIST_TOOLS_DIR: "/t" } }), path.resolve("/t"));
  assert.equal(resolveManagedToolsRoot({ env: {}, homeDir: "/h" }), path.resolve("/h", ".buzzassist", "tools"));
});
