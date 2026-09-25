// チャンネルの台帳（lib/channelRegistry.mjs）の試験。チャンネル・フォルダの名前はすべて合成。
// 端末の本物の配置表は読まない（明示の path か一時フォルダだけを読む）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHANNEL_REGISTRY_INVALID_CODE,
  CHANNEL_REGISTRY_PATH_ENV,
  CHANNEL_UNKNOWN_CODE,
  channelView,
  channelsMatchingPaths,
  findChannel,
  loadChannelRegistry,
  pathOverlap,
  publicTreePlacement,
  validateChannelRegistry,
} from "../lib/channelRegistry.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS_IDS = ["koya-manga-video", "narrated-story-video"];
const GENRES = ["narrated-story", "manga", "explainer"];

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "channel-registry-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function channel(root, id, overrides = {}) {
  return {
    id,
    projectDir: path.join(root, id, "project"),
    channelPack: path.join(root, id, "pack"),
    production: { kind: "harness", harnessId: "narrated-story-video" },
    strategy: { workDir: path.join(root, id, "strategy"), requireBrief: true },
    scriptQuality: { genre: "narrated-story" },
    ...overrides,
  };
}

function validate(channels, options = {}) {
  return validateChannelRegistry({ channels }, { repoRoot: REPO_ROOT, harnessIds: HARNESS_IDS, genres: GENRES, ...options });
}

function issueCodes(fn) {
  try {
    fn();
  } catch (error) {
    assert.equal(error.code, CHANNEL_REGISTRY_INVALID_CODE, error.message);
    return error.issues.map((issue) => issue.code);
  }
  assert.fail("台帳が拒否されなかった");
  return [];
}

test("台帳: 形の揃ったチャンネルを絶対 path に直し、学習の宛先を制作のハーネスと台本のジャンルから決める", (t) => {
  const root = tempRoot(t);
  const channels = validate([
    channel(root, "alpha"),
    channel(root, "beta", { production: { kind: "harness", harnessId: "koya-manga-video" }, scriptQuality: { genre: "manga" } }),
    channel(root, "gamma", { production: { kind: "external", note: "合成: チャンネルの既存の書き出しの仕組み" }, scriptQuality: undefined }),
  ]);
  assert.deepEqual(channels.map((entry) => entry.id), ["alpha", "beta", "gamma"]);
  const [alpha, beta, gamma] = channels;
  assert.equal(alpha.projectDir, path.join(root, "alpha", "project"));
  assert.equal(alpha.strategy.workDir, path.join(root, "alpha", "strategy"));
  assert.equal(alpha.strategy.requireBrief, true);
  assert.deepEqual(alpha.learning.map((entry) => entry.target), ["channel-pack:narrated-story", "channel-pack:narrated-story-script"]);
  assert.deepEqual(alpha.learning.map((entry) => entry.sharedWith), [[], []]);
  assert.deepEqual(beta.learning.map((entry) => entry.target), ["channel-pack:koya"]);
  // 外部の制作のチャンネルは制作の学習の宛先を持たない（別のハーネスの宛先へ寄せない）。
  assert.deepEqual(gamma.learning, []);
  assert.deepEqual(gamma.production, { kind: "external", note: "合成: チャンネルの既存の書き出しの仕組み" });
  // 出力用の形は台帳の値だけ。
  const view = channelView(alpha);
  assert.ok(!JSON.stringify(view).includes(path.join(root, "beta")));
  assert.equal(view.scriptQuality.genre, "narrated-story");
});

test("台帳: チャンネルどうしで projectDir・channelPack・strategy.workDir が重なれば理由つきで拒否する", (t) => {
  const root = tempRoot(t);
  const alpha = channel(root, "alpha");
  // 同じ projectDir。
  assert.ok(issueCodes(() => validate([alpha, channel(root, "beta", { projectDir: alpha.projectDir })]))
    .includes("channel-paths-overlap:alpha.projectDir:beta.projectDir"));
  // 別のチャンネルの projectDir の中に戦略の作業フォルダ。
  const nested = issueCodes(() => validate([alpha, channel(root, "beta", { strategy: { workDir: path.join(alpha.projectDir, "strategy"), requireBrief: false } })]));
  assert.ok(nested.includes("channel-paths-overlap:alpha.projectDir:beta.strategy.workDir"), nested.join("\n"));
  // 同じ Pack。
  assert.ok(issueCodes(() => validate([alpha, channel(root, "beta", { channelPack: alpha.channelPack })]))
    .includes("channel-paths-overlap:alpha.channelPack:beta.channelPack"));
  // 同じ id。
  assert.ok(issueCodes(() => validate([alpha, channel(root, "alpha", { projectDir: path.join(root, "x"), channelPack: path.join(root, "y"), strategy: { workDir: path.join(root, "z"), requireBrief: true } })]))
    .includes("channel-id-duplicate:alpha"));
  // 同じチャンネルの中の入れ子（projectDir の中の workDir・Pack）は許す。
  const inside = channel(root, "solo", {
    channelPack: path.join(root, "solo", "project", "pack"),
    strategy: { workDir: path.join(root, "solo", "project", "strategy"), requireBrief: false },
  });
  assert.equal(validate([inside]).length, 1);
});

test("台帳: 公開リポジトリの作業木の直下・作業木を含む場所・追跡される場所を拒み、追跡しない場所は許す", (t) => {
  const root = tempRoot(t);
  const at = (overrides) => issueCodes(() => validate([channel(root, "alpha", overrides)]));
  assert.ok(at({ projectDir: REPO_ROOT }).includes("channel-path-repo-root:alpha"));
  assert.ok(at({ projectDir: path.dirname(REPO_ROOT) }).includes("channel-path-contains-repo:alpha"));
  assert.ok(at({ strategy: { workDir: path.join(REPO_ROOT, "docs", "strategy"), requireBrief: true } }).includes("channel-path-in-public-tree:alpha"));
  assert.ok(at({ channelPack: path.join(REPO_ROOT, "config", "pack") }).includes("channel-path-in-public-tree:alpha"));
  // 相対 path はリポジトリ基準。"." はリポジトリの直下。
  assert.ok(at({ projectDir: "." }).includes("channel-path-repo-root:alpha"));
  const allowed = validate([channel(root, "alpha", {
    channelPack: path.join(REPO_ROOT, "channel-packs", "synthetic-alpha"),
    strategy: { workDir: path.join(REPO_ROOT, "canvas", "synthetic-alpha-strategy"), requireBrief: false },
  })]);
  assert.equal(allowed[0].channelPack, path.join(REPO_ROOT, "channel-packs", "synthetic-alpha"));
  assert.equal(publicTreePlacement(path.join(REPO_ROOT, "client-work", "x"), REPO_ROOT), null);
  assert.equal(publicTreePlacement(path.join(REPO_ROOT, "lib"), REPO_ROOT), "public-tree");
  assert.equal(publicTreePlacement(path.join(root, "outside"), REPO_ROOT), null);
});

test("台帳: 形の誤り（requireBrief の省略・知らない欄・未完成・宣言に無いハーネス・note の無い external）を名指しで拒む", (t) => {
  const root = tempRoot(t);
  const codes = issueCodes(() => validate([
    channel(root, "alpha", { strategy: { workDir: path.join(root, "alpha", "strategy") } }),
    channel(root, "beta", { requireBreif: true }),
    channel(root, "gamma", { projectDir: "<作業フォルダ>" }),
    channel(root, "delta", { production: { kind: "harness", harnessId: "synthetic-unknown-harness" } }),
    channel(root, "epsilon", { production: { kind: "external" } }),
    channel(root, "zeta", { scriptQuality: { genre: "synthetic-genre" } }),
    channel(root, "Bad Id"),
  ]));
  for (const expected of [
    "channel-strategy-invalid:alpha",
    "channel-unknown-key:beta",
    "channel-path-placeholder:gamma",
    "channel-harness-unknown:delta",
    "channel-production-invalid:epsilon",
    "channel-script-quality-genre-unknown:zeta",
    "channel-id-invalid:Bad Id",
  ]) assert.ok(codes.includes(expected), `${expected} が無い: ${codes.join(", ")}`);
  assert.throws(() => validateChannelRegistry({ channels: {} }), { code: CHANNEL_REGISTRY_INVALID_CODE });
  // 台本のジャンルは、制作のハーネスが有料の処理の前に問うジャンルとそろえる（外部の制作は問わない）。
  const genreForHarness = (harnessId) => ({ "narrated-story-video": "narrated-story", "koya-manga-video": "manga" })[harnessId] || "";
  const mismatch = issueCodes(() => validate([channel(root, "alpha", { scriptQuality: { genre: "manga" } })], { genreForHarness }));
  assert.ok(mismatch.includes("channel-script-quality-genre-mismatch:alpha"), mismatch.join(", "));
  assert.equal(validate([
    channel(root, "alpha"),
    channel(root, "beta", { production: { kind: "external", note: "合成: 既存の仕組み" }, scriptQuality: { genre: "explainer" } }),
  ], { genreForHarness }).length, 2);
  // channels が無ければ空の台帳。
  assert.deepEqual(validateChannelRegistry({ deployments: [] }), []);
});

test("台帳: 同じ学習の宛先を使うチャンネルは sharedWith に出し、学習の保存先が別のチャンネルの場所に重なれば拒む", (t) => {
  const root = tempRoot(t);
  const shared = validate([channel(root, "alpha"), channel(root, "beta")]);
  assert.deepEqual(shared[0].learning[0], { area: "production", target: "channel-pack:narrated-story", store: { source: "channel-pack-default" }, sharedWith: ["beta"] });
  const koya = channel(root, "beta", { production: { kind: "harness", harnessId: "koya-manga-video" }, scriptQuality: undefined });
  const codes = issueCodes(() => validateChannelRegistry({
    channels: [channel(root, "alpha"), koya],
    channelLearning: [{ target: "channel-pack:narrated-story", root: path.join(koya.projectDir, "learning") }],
  }, { repoRoot: REPO_ROOT, harnessIds: HARNESS_IDS, genres: GENRES }));
  assert.ok(codes.includes("channel-learning-store-overlap:alpha:beta.projectDir"), codes.join("\n"));
  const ok = validateChannelRegistry({
    channels: [channel(root, "alpha"), koya],
    channelLearning: [{ target: "channel-pack:narrated-story", root: path.join(root, "alpha", "project", "learning") }],
  }, { repoRoot: REPO_ROOT, harnessIds: HARNESS_IDS, genres: GENRES });
  assert.deepEqual(ok[0].learning[0].store, { source: "channel-learning", root: path.join(root, "alpha", "project", "learning") });
});

test("Windows の path: ドライブ名と大文字小文字を無視して重なりを見て、作業木の直下を拒む", () => {
  const win = path.win32;
  assert.equal(pathOverlap("C:\\Channels\\Alpha", "c:\\channels\\alpha", win), "same");
  assert.equal(pathOverlap("C:\\Channels\\Alpha\\strategy", "c:\\channels\\alpha", win), "inside");
  assert.equal(pathOverlap("C:\\Channels", "C:\\Channels\\Alpha", win), "contains");
  assert.equal(pathOverlap("D:\\Channels\\Alpha", "C:\\Channels\\Alpha", win), null);
  assert.equal(pathOverlap("C:\\Channels\\Alpha2", "C:\\Channels\\Alpha", win), null);
  const repoRoot = "C:\\Users\\operator\\BuzzAssist";
  const base = (id) => ({
    id,
    projectDir: `D:\\Channels\\${id}\\project`,
    channelPack: `D:\\Channels\\${id}\\pack`,
    production: { kind: "harness", harnessId: "narrated-story-video" },
    strategy: { workDir: `D:\\Channels\\${id}\\strategy`, requireBrief: false },
  });
  const channels = validateChannelRegistry({ channels: [base("alpha"), base("beta")] }, { repoRoot, pathApi: win });
  assert.equal(channels[0].projectDir, "D:\\Channels\\alpha\\project");
  // 相対 path はリポジトリ基準で、Windows の区切りで解決する。
  const relative = validateChannelRegistry({ channels: [{ ...base("alpha"), channelPack: "channel-packs/alpha" }] }, { repoRoot, pathApi: win });
  assert.equal(relative[0].channelPack, "C:\\Users\\operator\\BuzzAssist\\channel-packs\\alpha");
  const codes = issueCodes(() => validateChannelRegistry({
    channels: [
      { ...base("alpha"), projectDir: "c:\\users\\OPERATOR\\buzzassist" },
      { ...base("beta"), projectDir: "D:\\CHANNELS\\ALPHA\\PACK\\inner" },
    ],
  }, { repoRoot, pathApi: win }));
  assert.ok(codes.includes("channel-path-repo-root:alpha"), codes.join("\n"));
  assert.ok(codes.includes("channel-paths-overlap:alpha.channelPack:beta.projectDir"), codes.join("\n"));
});

test("読み込み: 例のファイルは空の台帳で、書き方の channelTemplate は使わない。明示・環境変数の台帳は source に出る", (t) => {
  const root = tempRoot(t);
  const example = loadChannelRegistry({ repoRoot: REPO_ROOT, deploymentPath: path.join(REPO_ROOT, "config", "harness-deployments.example.json"), env: {} });
  assert.deepEqual(example.channels, []);
  const exampleJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "config", "harness-deployments.example.json"), "utf8"));
  assert.equal(exampleJson.channelTemplate.id, "sample-channel");

  const registryPath = path.join(root, "registry.json");
  fs.writeFileSync(registryPath, JSON.stringify({ channels: [channel(root, "alpha")] }));
  const fromEnv = loadChannelRegistry({ env: { [CHANNEL_REGISTRY_PATH_ENV]: registryPath }, harnessIds: HARNESS_IDS });
  assert.equal(fromEnv.source, "env");
  assert.equal(fromEnv.sourcePath, registryPath);
  assert.deepEqual(fromEnv.channels.map((entry) => entry.id), ["alpha"]);
  const explicit = loadChannelRegistry({ deploymentPath: registryPath, env: { [CHANNEL_REGISTRY_PATH_ENV]: path.join(root, "other.json") } });
  assert.equal(explicit.source, "explicit");
  assert.throws(() => loadChannelRegistry({ env: { [CHANNEL_REGISTRY_PATH_ENV]: path.join(root, "missing.json") } }), { code: CHANNEL_REGISTRY_INVALID_CODE });
  fs.writeFileSync(path.join(root, "broken.json"), "{");
  assert.throws(() => loadChannelRegistry({ deploymentPath: path.join(root, "broken.json") }), { code: CHANNEL_REGISTRY_INVALID_CODE });
  // 配置表の無いリポジトリ（例も無い）は空の台帳。
  assert.deepEqual(loadChannelRegistry({ repoRoot: root, env: {} }).channels, []);
});

test("チャンネルを引く: 無い id は既定へ落ちずに止め、path から向き先のチャンネルを探す", (t) => {
  const root = tempRoot(t);
  const registry = { channels: validate([channel(root, "alpha"), channel(root, "beta")]) };
  assert.equal(findChannel(registry, "beta").id, "beta");
  assert.throws(() => findChannel(registry, "gamma"), (error) => error.code === CHANNEL_UNKNOWN_CODE && error.knownChannels.join(",") === "alpha,beta");
  assert.throws(() => findChannel({ channels: [] }, ""), { code: CHANNEL_UNKNOWN_CODE });
  const match = channelsMatchingPaths(registry, { channelPackPath: path.join(root, "beta", "pack"), projectDir: path.join(root, "alpha", "project") });
  assert.deepEqual(match.byPack.map((entry) => entry.id), ["beta"]);
  assert.deepEqual(match.byProject.map((entry) => entry.id), ["alpha"]);
  assert.deepEqual(channelsMatchingPaths(registry, {}), { byPack: [], byProject: [] });
});
