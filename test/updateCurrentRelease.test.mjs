import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { releasePackageFileName } from "../lib/releasePackage.mjs";

// 自動更新（scripts/update-current.mjs）を、一時 HOME と差し替えた fetch で実際に走らせる。
// 本物の Release も本物の HOME も触らない。npm ci より前で止まる経路（古い Release・照合失敗）
// だけを見る（その先は検査済みの配布物を入れる経路で、releasePackage の試験が照合と展開を見る）。

const ROOT = join(import.meta.dirname, "..");
const LATEST = "99.0.0";
const REPOSITORY = "example-owner/BuzzAssist";

function fetchStubSource() {
  return `
import { appendFileSync, readFileSync } from "node:fs";
const fixture = JSON.parse(readFileSync(process.env.UPDATE_TEST_FIXTURE, "utf8"));
globalThis.fetch = async (url) => {
  const href = String(url);
  appendFileSync(process.env.UPDATE_TEST_CALLS, href + "\\n");
  if (href.endsWith("/releases/latest")) {
    return { ok: true, status: 200, url: href, json: async () => fixture.release };
  }
  const body = fixture.files[href];
  if (body === undefined) return { ok: false, status: 404, url: href, text: async () => "", json: async () => ({}) };
  const buffer = Buffer.from(body, "base64");
  return {
    ok: true,
    status: 200,
    url: href,
    text: async () => buffer.toString("utf8"),
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
};
`;
}

function runUpdater(t, { assets }) {
  const home = mkdtempSync(join(tmpdir(), "update-current-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const marketplaceDir = join(home, "plugins", "buzzassist");
  const pluginRoot = join(marketplaceDir, "plugin");
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(join(pluginRoot, "package.json"), JSON.stringify({ name: "buzzassist-canvas-mcp", version: "0.0.1" }));
  const configPath = join(home, ".buzzassist", "updater", "config.json");
  mkdirSync(join(home, ".buzzassist", "updater"), { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    enabled: true,
    hosts: ["claude"],
    repository: REPOSITORY,
    pluginRoot,
    managedMarketplaceDir: marketplaceDir,
    projectDir: join(home, "project"),
    canvasDir: join(home, "project", "canvas"),
  }));
  const fileName = releasePackageFileName(LATEST);
  const base = `https://github.com/${REPOSITORY}/releases/download/v${LATEST}`;
  const release = {
    tag_name: `v${LATEST}`,
    draft: false,
    prerelease: false,
    zipball_url: `https://api.github.com/repos/${REPOSITORY}/zipball/v${LATEST}`,
    assets: assets
      ? [
        { name: fileName, browser_download_url: `${base}/${fileName}` },
        { name: `${fileName}.sha256`, browser_download_url: `${base}/${fileName}.sha256` },
      ]
      : [],
  };
  const fixturePath = join(home, "fixture.json");
  const callsPath = join(home, "calls.txt");
  writeFileSync(callsPath, "");
  writeFileSync(fixturePath, JSON.stringify({
    release,
    files: assets ? {
      [`${base}/${fileName}`]: Buffer.from("not the audited package").toString("base64"),
      [`${base}/${fileName}.sha256`]: Buffer.from(`${"0".repeat(64)}  ${fileName}\n`).toString("base64"),
    } : {},
  }));
  const stubPath = join(home, "fetch-stub.mjs");
  writeFileSync(stubPath, fetchStubSource());
  const result = spawnSync(process.execPath, [
    "--import", pathToFileURL(stubPath).href,
    join(ROOT, "scripts", "update-current.mjs"),
    "--config", configPath,
    "--no-throttle",
  ], {
    cwd: home,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      BUZZASSIST_SETUP_HOME: home,
      UPDATE_TEST_FIXTURE: fixturePath,
      UPDATE_TEST_CALLS: callsPath,
      GITHUB_TOKEN: "",
      GH_TOKEN: "",
    },
  });
  const state = JSON.parse(readFileSync(join(home, ".buzzassist", "updater", "state.json"), "utf8"));
  const calls = readFileSync(callsPath, "utf8").split("\n").filter(Boolean);
  const releasesDir = join(home, ".buzzassist", "releases");
  return { result, state, calls, releasesEntries: existsSync(releasesDir) ? readdirSync(releasesDir) : [], pluginRoot };
}

test("tgz の無い古い Release では、ソースの ZIP に落ちずに更新しないと記録する", { timeout: 90_000 }, (t) => {
  const { result, state, calls, releasesEntries, pluginRoot } = runUpdater(t, { assets: false });
  assert.match(result.stdout, /BUZZASSIST_UPDATE=release-unverifiable/u, result.stderr);
  assert.equal(result.status, 1, "手動の実行では気づけるように非0");
  assert.equal(state.status, "release-unverifiable");
  assert.match(state.lastError, /release-package-missing/u);
  assert.equal(calls.some((url) => url.includes("zipball")), false, "ソースの ZIP を取りに行かない");
  assert.deepEqual(releasesEntries, [], "何も展開しない");
  assert.equal(JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")).version, "0.0.1", "入っている版は変えない");
});

test("取得した tgz が .sha256 と合わなければ、展開も導入もせずに失敗として残す", { timeout: 90_000 }, (t) => {
  const { result, state, calls, releasesEntries, pluginRoot } = runUpdater(t, { assets: true });
  assert.equal(result.status, 1, result.stdout);
  assert.equal(state.status, "failed");
  assert.match(state.lastError, /release-package-sha256-mismatch/u);
  assert.equal(state.rollbackAttempted, false, "入っている plugin には触れていない");
  assert.ok(calls.some((url) => url.endsWith(".tgz.sha256")), "同じ Release の .sha256 を取った");
  assert.equal(calls.some((url) => url.includes("zipball")), false);
  assert.deepEqual(releasesEntries.filter((name) => !name.startsWith(".")), [], "展開済みの版を作らない");
  assert.deepEqual(releasesEntries.filter((name) => name.startsWith(".staging-")), [], "作業場所を残さない");
  assert.equal(JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")).version, "0.0.1");
});
