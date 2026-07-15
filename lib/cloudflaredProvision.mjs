import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

export const MANAGED_CLOUDFLARED_VERSION = "2026.7.1";
const MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024;

const RELEASE_ASSETS = {
  "darwin-x64": {
    name: "cloudflared-darwin-amd64.tgz",
    sha256: "05871d772745b0f8398c7be89113a0b178474936ff20638b3b07c0e7262f717e",
    archive: "tgz",
  },
  "darwin-arm64": {
    name: "cloudflared-darwin-arm64.tgz",
    sha256: "6d4b59383cdad387834d7ae5704fc512882b2d078074bf5770e02b186a0981ed",
    archive: "tgz",
  },
  "linux-ia32": {
    name: "cloudflared-linux-386",
    sha256: "8452c2b93f2bfa89f1249bceaec128c90424e25a6ef600f57d92b1fbd0cb502f",
  },
  "linux-x64": {
    name: "cloudflared-linux-amd64",
    sha256: "79a0ade7fc854f62c1aaef48424d9d979e8c2fcd039189d24db82b84cd146be1",
  },
  "linux-arm": {
    name: "cloudflared-linux-arm",
    sha256: "17cedcb83d8239c5f81f6d57b7d50a384f0d57fd523af2763f47ac6cade77bf9",
  },
  "linux-arm64": {
    name: "cloudflared-linux-arm64",
    sha256: "18f2c9bfc7a67a971bd96f1a5a1935def3c1e52aa386626f1566f04e9b5478d6",
  },
  "win32-ia32": {
    name: "cloudflared-windows-386.exe",
    sha256: "627fe6e42c5e92e42de962afec19bcbf14a60d43c352dbe4b605f1e3246462ed",
  },
  "win32-x64": {
    name: "cloudflared-windows-amd64.exe",
    sha256: "ccb0756de288d3c2c076d19764ca53e0849a10f2dd9c23f8656ac42bdeb45001",
  },
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function executableName(platform) {
  return platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

export function resolveCloudflaredReleaseAsset({ platform = process.platform, arch = process.arch } = {}) {
  const normalizedArch = platform === "win32" && arch === "arm64" ? "x64" : arch;
  const asset = RELEASE_ASSETS[`${platform}-${normalizedArch}`];
  if (!asset) {
    throw new Error(`BuzzAssist cannot auto-download cloudflared for ${platform}/${arch}.`);
  }
  return {
    ...asset,
    version: MANAGED_CLOUDFLARED_VERSION,
    url: `https://github.com/cloudflare/cloudflared/releases/download/${MANAGED_CLOUDFLARED_VERSION}/${asset.name}`,
  };
}

export function resolveManagedCloudflaredPaths({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  homeDir,
  toolsDir,
} = {}) {
  const userHome = resolve(homeDir || env.BUZZASSIST_SETUP_HOME || env.HOME || env.USERPROFILE || homedir());
  const root = resolve(
    toolsDir ||
      env.BUZZASSIST_TOOLS_DIR ||
      (env.BUZZASSIST_HOME ? join(env.BUZZASSIST_HOME, "tools") : join(userHome, ".buzzassist", "tools")),
  );
  const installDir = join(root, "cloudflared", MANAGED_CLOUDFLARED_VERSION, `${platform}-${arch}`);
  return {
    root,
    installDir,
    executablePath: join(installDir, executableName(platform)),
    metadataPath: join(installDir, "install.json"),
  };
}

function tarText(buffer, start, length) {
  return buffer.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "").trim();
}

export function extractCloudflaredFromTgz(archiveBuffer) {
  const tar = gunzipSync(archiveBuffer);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = tarText(tar, offset, 100);
    const prefix = tarText(tar, offset + 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(tarText(tar, offset + 124, 12) || "0", 8);
    const type = String.fromCharCode(tar[offset + 156] || 0);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error("The cloudflared archive is truncated.");
    if (fullName.split("/").pop() === "cloudflared" && (type === "0" || type === "\0")) {
      const executable = tar.subarray(dataStart, dataEnd);
      if (executable.length === 0) throw new Error("The cloudflared archive contained an empty executable.");
      return Buffer.from(executable);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error("The cloudflared executable was not found in the official archive.");
}

async function downloadReleaseAsset(asset, fetchImpl) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(asset.url, {
        redirect: "follow",
        headers: { "user-agent": `BuzzAssist/${MANAGED_CLOUDFLARED_VERSION}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const declaredSize = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredSize) && declaredSize > MAX_DOWNLOAD_BYTES) {
        throw new Error(`download is too large (${declaredSize} bytes)`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_DOWNLOAD_BYTES) {
        throw new Error(`invalid download size (${bytes.length} bytes)`);
      }
      const actualSha256 = sha256(bytes);
      if (actualSha256 !== asset.sha256) {
        throw new Error(`SHA-256 mismatch (expected ${asset.sha256}, received ${actualSha256})`);
      }
      return bytes;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolveWait) => setTimeout(resolveWait, 250 * attempt));
    }
  }
  throw new Error(`Failed to download verified cloudflared ${asset.version}: ${lastError?.message || String(lastError)}`);
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolveExec, rejectExec) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        rejectExec(error);
        return;
      }
      resolveExec({ stdout, stderr });
    });
  });
}

async function defaultVerifyExecutable(executablePath) {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, ["--version"], { timeout: 10_000 });
    return /cloudflared/i.test(`${stdout}\n${stderr}`);
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function cachedInstallIsValid(paths, asset, verifyExecutable) {
  const metadata = await readJson(paths.metadataPath);
  if (
    metadata?.version !== MANAGED_CLOUDFLARED_VERSION ||
    metadata?.assetName !== asset.name ||
    metadata?.assetSha256 !== asset.sha256 ||
    typeof metadata?.executableSha256 !== "string"
  ) return false;
  try {
    const info = await stat(paths.executablePath);
    if (!info.isFile() || info.size === 0) return false;
    const executable = await readFile(paths.executablePath);
    if (sha256(executable) !== metadata.executableSha256) return false;
    return await verifyExecutable(paths.executablePath);
  } catch {
    return false;
  }
}

async function atomicWrite(filePath, data, options = {}) {
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

export async function ensureManagedCloudflared(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const asset = options.asset || resolveCloudflaredReleaseAsset({ platform, arch });
  const paths = resolveManagedCloudflaredPaths({
    platform,
    arch,
    env: options.env || process.env,
    homeDir: options.homeDir,
    toolsDir: options.toolsDir,
  });
  const verifyExecutable = options.verifyExecutable || defaultVerifyExecutable;
  if (await cachedInstallIsValid(paths, asset, verifyExecutable)) {
    return { ...paths, asset, downloaded: false, source: "managed-cache" };
  }

  await rm(paths.installDir, { recursive: true, force: true });
  await mkdir(paths.installDir, { recursive: true });
  try {
    const archive = await downloadReleaseAsset(asset, options.fetchImpl || globalThis.fetch);
    const executable = asset.archive === "tgz" ? extractCloudflaredFromTgz(archive) : archive;
    const executableSha256 = sha256(executable);
    await atomicWrite(paths.executablePath, executable, { mode: 0o755 });
    if (!await verifyExecutable(paths.executablePath)) {
      throw new Error(`Downloaded cloudflared ${asset.version} could not be executed on ${platform}/${arch}.`);
    }
    await atomicWrite(paths.metadataPath, `${JSON.stringify({
      version: MANAGED_CLOUDFLARED_VERSION,
      platform,
      arch,
      assetName: asset.name,
      sourceUrl: asset.url,
      assetSha256: asset.sha256,
      executableSha256,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    return { ...paths, asset, downloaded: true, source: "managed-download" };
  } catch (error) {
    await rm(paths.installDir, { recursive: true, force: true });
    throw error;
  }
}
