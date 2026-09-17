import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve as pathResolve, sep as pathSep } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  analyzeSkillInventory,
  buildSkillInventory,
  evaluateSkillForProfile,
  defaultGlobalSkillRoots,
  findMissingInstalledCopies,
  installationForPath,
  loadSkillPolicyManifests,
  scanInstalledSkillRoots,
  shippedSkillContent,
} from "../lib/skillInventory.mjs";

const projectDir = fileURLToPath(new URL("..", import.meta.url));

test("project inventory has four explicit classifications and no ambiguous project implementation", async () => {
  const report = await buildSkillInventory({ projectDir });
  assert.deepEqual(report.classifications, ["installed", "bundled", "productionAllowed", "developmentOnly"]);
  assert.equal(report.analysis.collisions.length, 0);
  assert.equal(report.analysis.adapterIssues.length, 0);
  assert.equal(report.analysis.manifestIssues.length, 0);
  assert.equal(report.analysis.ok, true);
  assert.ok(report.skills.every((record) =>
    ["installed", "bundled", "productionAllowed", "developmentOnly"]
      .every((key) => typeof record.classification[key] === "boolean")
  ));

  const canonical = report.skills.find((record) => record.qualifiedId === "buzzassist:skill-creator" && record.sourceRole === "project-canonical");
  const adapters = report.skills.filter((record) => record.qualifiedId === "buzzassist:skill-creator" && record.sourceRole === "project-adapter");
  assert.equal(canonical.language, "ja");
  assert.equal(canonical.classification.productionAllowed, false);
  assert.equal(canonical.classification.developmentOnly, true);
  assert.deepEqual(adapters.map((record) => record.adapterHost).sort(), ["claude-code", "codex", "shared"]);
  assert.ok(adapters.every((record) => record.name === "buzzassist-skill-creator"));
  assert.ok(report.skills.filter((record) => record.scope === "buzzassist").every((record) => /^sha256:/u.test(record.shippedContentSha256)));
});

test("shipped copies that differ only by the setup-agents depth rewrite are mirrors, not collisions", () => {
  const classification = { installed: false, bundled: true, productionAllowed: true, developmentOnly: false };
  const canonicalSource = "---\nname: same\n---\nread `../../../config/x.json` and `../../../.agents/skills/y/SKILL.md`\n";
  const shippedSource = shippedSkillContent(canonicalSource);
  assert.notEqual(shippedSource, canonicalSource);
  assert.ok(!shippedSource.includes("../../../"));
  const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const canonical = {
    kind: "skill", name: "same", qualifiedId: "buzzassist:same", scope: "buzzassist", sourceRole: "project-canonical",
    path: "/repo/.agents/skills/same/SKILL.md", contentSha256: digest(canonicalSource), shippedContentSha256: digest(shippedSource), classification,
  };
  const installed = { installed: true, bundled: false, productionAllowed: false, developmentOnly: false };
  const cacheMirror = { kind: "skill", name: "same", qualifiedId: "buzzassist:same", scope: "plugin:buzzassist", sourceRole: "installed-plugin-skill", path: "/cache/0.1.25/.agents/skills/same/SKILL.md", contentSha256: digest(canonicalSource), classification: installed };
  const cacheShipped = { kind: "skill", name: "same", qualifiedId: "buzzassist:same", scope: "plugin:buzzassist", sourceRole: "installed-plugin-skill", path: "/cache/0.1.25/skills/same/SKILL.md", contentSha256: digest(shippedSource), classification: installed };
  const managedShipped = { kind: "skill", name: "same", qualifiedId: "buzzassist:same", scope: "plugin:buzzassist", sourceRole: "shipped-plugin-source", path: "/home/example/plugins/buzzassist/plugin/skills/same/SKILL.md", contentSha256: digest(shippedSource), classification: installed };

  const analysis = analyzeSkillInventory([canonical, cacheMirror, cacheShipped, managedShipped]);
  assert.equal(analysis.collisions.length, 0);
  assert.equal(analysis.staleInstalledCopies.length, 0);
  assert.equal(analysis.externalDivergentHashes.length, 0);
  assert.equal(analysis.exactMirrors.length, 1);
  assert.deepEqual(analysis.exactMirrors[0].hashes, [canonical.contentSha256]);
  assert.deepEqual(analysis.exactMirrors[0].depthRewriteEquivalents, [cacheShipped.path, managedShipped.path]);
  assert.equal(analysis.ok, true);

  // 書き換え以外の差（古い配布物）は stale として分離し、正本 collision にはしない。
  const staleCopy = { ...cacheShipped, path: "/cache/0.1.24/skills/same/SKILL.md", contentSha256: digest(`${shippedSource}\nold\n`) };
  const stale = analyzeSkillInventory([canonical, cacheMirror, cacheShipped, staleCopy]);
  assert.equal(stale.collisions.length, 0);
  assert.equal(stale.ok, true);
  assert.equal(stale.staleInstalledCopies.length, 1);
  assert.equal(stale.staleInstalledCopies[0].canonicalHash, canonical.contentSha256);
  assert.deepEqual(stale.staleInstalledCopies[0].stalePaths, [staleCopy.path]);

  // 正本側（project-canonical と plugin-runtime-source）が食い違うものは今まで通り collision。
  const runtimeSource = { ...canonical, sourceRole: "plugin-runtime-source", path: "/repo/skills/same/SKILL.md", contentSha256: "sha256:other", shippedContentSha256: "sha256:other" };
  assert.equal(analyzeSkillInventory([canonical, runtimeSource, cacheShipped]).collisions.length, 1);
});

test("plugin cache scan covers the managed shipped copy and both host caches", () => {
  const roots = defaultGlobalSkillRoots("/home/example", { includePluginCache: true });
  const paths = roots.map((root) => root.path);
  assert.ok(paths.includes(join("/home/example", "plugins", "buzzassist", "plugin", "skills")));
  assert.ok(paths.includes(join("/home/example", ".codex", "plugins", "cache")));
  assert.ok(paths.includes(join("/home/example", ".claude", "plugins", "cache")));
  const shipped = roots.find((root) => root.sourceRole === "shipped-plugin-source");
  assert.equal(shipped.namespace, "buzzassist");
  assert.equal(defaultGlobalSkillRoots("/home/example").some((root) => root.path.includes("plugins")), false);
});

test("an explicit shipped-plugin-source root keeps its role instead of being read as a host cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-shipped-root-"));
  try {
    await mkdir(join(root, "plugin", "skills", "same"), { recursive: true });
    await writeFile(join(root, "plugin", "skills", "same", "SKILL.md"), "---\nname: same\ndescription: shipped\n---\nshipped\n");
    const [record] = await scanInstalledSkillRoots([
      { path: join(root, "plugin", "skills"), namespace: "buzzassist", sourceRole: "shipped-plugin-source", host: "shared", maxDepth: 3 },
    ]);
    assert.equal(record.qualifiedId, "buzzassist:same");
    assert.equal(record.scope, "plugin:buzzassist");
    assert.equal(record.sourceRole, "shipped-plugin-source");
    assert.equal(record.classification.installed, true);
    assert.equal(record.classification.bundled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Operator Production excludes analytics, quality-loop, Cowork, and undeclared alternate video routes", async () => {
  const { profiles } = await loadSkillPolicyManifests(projectDir);
  const evaluate = (skill, declaredSkillIds = []) =>
    evaluateSkillForProfile(skill, "operator-production", profiles, { declaredSkillIds });

  assert.deepEqual(evaluate("buzzassist:platform-craft"), {
    allowed: true,
    reason: "profile-base",
    profileId: "operator-production",
    qualifiedId: "buzzassist:platform-craft",
  });
  assert.equal(evaluate("buzzassist:manga-video-production").reason, "harness-declaration-required");
  assert.equal(evaluate("buzzassist:manga-video-production", ["buzzassist:manga-video-production"]).allowed, true);
  assert.equal(evaluate("buzzassist:skill-creator").allowed, false);
  assert.equal(evaluate("yt-analytics-plugin:yt-analytics").reason, "hard-denied");
  assert.equal(evaluate("yt-quality-loop:yt-loop").reason, "hard-denied");
  assert.equal(evaluate("anthropic-skills:docx").reason, "hard-denied");

  for (const skillId of [
    "user-global:hyperframes",
    "user-global:remotion-render",
    "fable-mcp:fable",
    "grok-cli-tools:consult-grok",
    "runpod:runpod",
  ]) {
    assert.equal(evaluate(skillId).reason, "harness-declaration-required", skillId);
    assert.equal(evaluate(skillId, [skillId]).allowed, true, skillId);
  }
});

test("Development and General Work profiles keep admin and Cowork capabilities out of production", async () => {
  const { profiles } = await loadSkillPolicyManifests(projectDir);
  assert.equal(evaluateSkillForProfile("buzzassist:skill-creator", "buzzassist-development", profiles).allowed, true);
  assert.equal(evaluateSkillForProfile("user-global:run-bestofn", "buzzassist-development", profiles).allowed, true);
  assert.equal(evaluateSkillForProfile("anthropic-skills:docx", "buzzassist-development", profiles).allowed, false);
  assert.equal(evaluateSkillForProfile("anthropic-skills:docx", "general-work", profiles).allowed, true);
  assert.equal(evaluateSkillForProfile("finance:reconciliation", "general-work", profiles).allowed, true);
  assert.equal(evaluateSkillForProfile("buzzassist:manga-video-production", "general-work", profiles).allowed, false);
});

test("global installs are distinct from project adapters and divergent mirrors are reported", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzzassist-skill-roots-"));
  try {
    const sharedRoot = join(root, ".agents", "skills");
    const claudeRoot = join(root, ".claude", "skills");
    await mkdir(join(sharedRoot, "skill-creator"), { recursive: true });
    await mkdir(join(claudeRoot, "skill-creator"), { recursive: true });
    await writeFile(join(sharedRoot, "skill-creator", "SKILL.md"), "---\nname: skill-creator\ndescription: shared\n---\nshared\n");
    await writeFile(join(claudeRoot, "skill-creator", "SKILL.md"), "---\nname: skill-creator\ndescription: claude\n---\nclaude\n");

    const records = await scanInstalledSkillRoots([
      { path: sharedRoot, scope: "user-global", sourceRole: "global-install", host: "shared" },
      { path: claudeRoot, scope: "user-global", sourceRole: "global-install", host: "claude-code" },
    ]);
    assert.ok(records.every((record) => record.classification.installed === true));
    assert.ok(records.every((record) => record.sourceRole === "global-install"));
    assert.ok(records.every((record) => record.sourceRole !== "project-adapter"));
    const analysis = analyzeSkillInventory(records);
    assert.equal(analysis.collisions.length, 0);
    assert.equal(analysis.externalDivergentHashes.length, 1);
    assert.equal(analysis.externalDivergentHashes[0].id, "user-global:skill-creator");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("divergent implementations in the same BuzzAssist scope are collisions", () => {
  const classification = { installed: false, bundled: true, productionAllowed: true, developmentOnly: false };
  const analysis = analyzeSkillInventory([
    { kind: "skill", name: "same", qualifiedId: "buzzassist:same", scope: "buzzassist", sourceRole: "project-canonical", path: "/one", contentSha256: "sha256:one", classification },
    { kind: "skill", name: "same", qualifiedId: "buzzassist:same", scope: "buzzassist", sourceRole: "plugin-runtime-source", path: "/two", contentSha256: "sha256:two", classification },
  ]);
  assert.equal(analysis.collisions.length, 1);
  assert.equal(analysis.ok, false);
});


test("a same-version host cache that lacks a bundled skill is reported as missing, not silently passed", () => {
  const bundled = { installed: false, bundled: true, productionAllowed: true, developmentOnly: false };
  const installed = { installed: true, bundled: false, productionAllowed: false, developmentOnly: false };
  const plugin = { kind: "plugin", name: "buzzassist", qualifiedId: "buzzassist:core-plugin", scope: "buzzassist", sourceRole: "project-bundle", version: "0.1.25", contentSha256: "sha256:p", classification: bundled };
  const canonical = (name, relativePath) => ({
    kind: "skill", name, qualifiedId: `buzzassist:${name}`, scope: "buzzassist", sourceRole: "project-canonical",
    path: `/repo/${relativePath}`, relativePath, contentSha256: `sha256:${name}`, shippedContentSha256: `sha256:${name}`, classification: bundled,
  });
  const adapter = (name, canonicalName, relativePath) => ({
    ...canonical(name, relativePath), qualifiedId: `buzzassist:${canonicalName}`, sourceRole: "project-adapter", adapterHost: "shared",
    canonicalContentSha256: `sha256:${canonicalName}`, classification: { ...bundled, installed: false },
  });
  const hostAdapter = { ...adapter("skill-creator-host", "skill-creator", ".claude/skills/buzzassist-skill-creator/SKILL.md"), adapterHost: "claude-code" };
  const cacheCopy = (root, host, version, dirName, name = dirName) => ({
    kind: "skill", name, qualifiedId: `buzzassist:${name}`, scope: "plugin:buzzassist", sourceRole: "installed-plugin-skill",
    path: `${root}/skills/${dirName}/SKILL.md`, contentSha256: `sha256:${name}`, classification: installed,
    installation: { root, host, version, namespace: "buzzassist" }, shippedDirName: dirName,
  });
  const claudeRoot = "/home/example/.claude/plugins/cache/buzzassist/buzzassist/0.1.25";
  const codexRoot = "/home/example/.codex/plugins/cache/buzzassist/buzzassist/0.1.25";
  const oldRoot = "/home/example/.claude/plugins/cache/buzzassist/buzzassist/0.1.24";
  const records = [
    plugin,
    canonical("platform-craft", ".agents/skills/platform-craft/SKILL.md"),
    canonical("narrated-story-video", ".agents/skills/narrated-story-video/SKILL.md"),
    canonical("skill-creator", ".agents/skills/skill-creator/SKILL.md"),
    adapter("buzzassist-skill-creator", "skill-creator", ".agents/skills/buzzassist-skill-creator/SKILL.md"),
    hostAdapter,
    canonical("excalidraw-image-gen", "skills/excalidraw-image-gen/SKILL.md"),
    // Claude cache: same version, but three shipped skills are absent (the observed 2026-08-29 build).
    cacheCopy(claudeRoot, "claude-code", "0.1.25", "platform-craft"),
    cacheCopy(claudeRoot, "claude-code", "0.1.25", "excalidraw-image-gen"),
    // Codex cache: complete.
    cacheCopy(codexRoot, "codex", "0.1.25", "platform-craft"),
    cacheCopy(codexRoot, "codex", "0.1.25", "narrated-story-video"),
    cacheCopy(codexRoot, "codex", "0.1.25", "skill-creator"),
    cacheCopy(codexRoot, "codex", "0.1.25", "buzzassist-skill-creator"),
    cacheCopy(codexRoot, "codex", "0.1.25", "excalidraw-image-gen"),
    // Older cached version: legitimately lacks newer skills; must not be counted as missing.
    cacheCopy(oldRoot, "claude-code", "0.1.24", "platform-craft"),
  ];

  const { missingInstalledCopies, outdatedInstalledVersions } = findMissingInstalledCopies(records);
  assert.equal(missingInstalledCopies.length, 1);
  assert.equal(missingInstalledCopies[0].installRoot, claudeRoot);
  assert.equal(missingInstalledCopies[0].host, "claude-code");
  assert.equal(missingInstalledCopies[0].version, "0.1.25");
  assert.equal(missingInstalledCopies[0].bundledVersion, "0.1.25");
  assert.equal(missingInstalledCopies[0].expected, 5);
  assert.equal(missingInstalledCopies[0].present, 2);
  assert.deepEqual(missingInstalledCopies[0].missing, ["buzzassist-skill-creator", "narrated-story-video", "skill-creator"]);
  assert.deepEqual(missingInstalledCopies[0].missingQualifiedIds, ["buzzassist:narrated-story-video", "buzzassist:skill-creator"]);
  assert.equal(outdatedInstalledVersions.length, 1);
  assert.equal(outdatedInstalledVersions[0].installRoot, oldRoot);

  const analysis = analyzeSkillInventory(records);
  assert.equal(analysis.collisions.length, 0);
  assert.equal(analysis.ok, true, "missing host copies are an install state, not a canonical defect");
  assert.equal(analysis.hostSyncOk, false);
  assert.equal(analysis.missingInstalledCopies.length, 1);

  // Without any host installation records nothing is reported (project-only inventory).
  const projectOnly = analyzeSkillInventory(records.filter((record) => !record.installation));
  assert.deepEqual(projectOnly.missingInstalledCopies, []);
  assert.deepEqual(projectOnly.outdatedInstalledVersions, []);
  assert.equal(projectOnly.hostSyncOk, true);

  // A complete same-version cache reports nothing missing.
  const complete = findMissingInstalledCopies(records.filter((record) => !record.installation || record.installation.root === codexRoot));
  assert.deepEqual(complete.missingInstalledCopies, []);
});

test("installation root and version are derived from the host cache path or the shipped-source spec", () => {
  // 本体はパスを resolve してから "/" 区切りにする。Windows ではドライブ名が付くので、
  // 期待値も同じ正規化で作る（POSIX では元の文字列のまま）。
  const normalized = (value) => pathResolve(value).split(pathSep).join("/");
  const cache = installationForPath(
    "/home/example/.claude/plugins/cache/buzzassist/buzzassist/0.1.25/skills/platform-craft/SKILL.md",
    { path: "/home/example/.claude/plugins/cache", host: "claude-code" },
    { sourceRole: "installed-plugin-skill", namespace: "buzzassist" },
  );
  assert.deepEqual(cache, { root: normalized("/home/example/.claude/plugins/cache/buzzassist/buzzassist/0.1.25"), host: "claude-code", version: "0.1.25", namespace: "buzzassist" });
  const nested = installationForPath(
    "/home/example/.codex/plugins/cache/buzzassist/buzzassist/0.1.25/.agents/skills/skill-creator/SKILL.md",
    { path: "/home/example/.codex/plugins/cache", host: "codex" },
    { sourceRole: "installed-plugin-skill", namespace: "buzzassist" },
  );
  assert.equal(nested.root, normalized("/home/example/.codex/plugins/cache/buzzassist/buzzassist/0.1.25"));
  const shipped = installationForPath(
    "/home/example/plugins/buzzassist/plugin/skills/platform-craft/SKILL.md",
    { path: "/home/example/plugins/buzzassist/plugin/skills", host: "shared", version: "0.1.25" },
    { sourceRole: "shipped-plugin-source", namespace: "buzzassist" },
  );
  assert.deepEqual(shipped, { root: normalized("/home/example/plugins/buzzassist/plugin/skills"), host: "shared", version: "0.1.25", namespace: "buzzassist" });
  assert.equal(installationForPath("/home/example/.codex/skills/x/SKILL.md", { path: "/home/example/.codex/skills" }, { sourceRole: "global-install", namespace: "user-global" }), null);
});

test("buildSkillInventory detects a host cache missing a bundled skill end to end", async () => {
  const home = await mkdtemp(join(tmpdir(), "buzzassist-home-"));
  try {
    const cacheRoot = join(home, ".claude", "plugins", "cache", "buzzassist", "buzzassist", "0.1.25");
    await mkdir(join(cacheRoot, "skills", "platform-craft"), { recursive: true });
    await mkdir(join(cacheRoot, ".claude-plugin"), { recursive: true });
    await writeFile(join(cacheRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "buzzassist", version: "0.1.25" }));
    await writeFile(join(cacheRoot, "skills", "platform-craft", "SKILL.md"), "---\nname: platform-craft\n---\nold copy\n");
    const report = await buildSkillInventory({ projectDir, includeGlobal: true, includePluginCache: true, homeDir: home });
    assert.equal(report.analysis.ok, true);
    assert.equal(report.analysis.hostSyncOk, false);
    assert.equal(report.analysis.missingInstalledCopies.length, 1);
    const [entry] = report.analysis.missingInstalledCopies;
    assert.equal(entry.installRoot.endsWith("/0.1.25"), true);
    assert.equal(entry.host, "claude-code");
    assert.equal(entry.expected, 16);
    assert.equal(entry.present, 1);
    assert.ok(entry.missing.includes("narrated-story-video"));
    assert.ok(entry.missing.includes("skill-creator"));
    assert.ok(entry.missing.includes("buzzassist-skill-creator"));
    assert.ok(!entry.missing.includes("platform-craft"));
    assert.equal(report.analysis.staleInstalledCopies.length, 1, "the present-but-different copy is stale, not missing");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
