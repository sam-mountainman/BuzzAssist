import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compareHostSkillSync, probeHostSkillSync, resolveHostPluginInstalls } from "../lib/hostSkillSync.mjs";

const CANONICAL = "---\nname: alpha\ndescription: 試験用\n---\n\n正本は ../../../lib/x.mjs を参照する。\n";
const SHIPPED = CANONICAL.replaceAll("../../../", "../../");
const OVERLAY = "# 機械が書く層\n- 教訓 1\n";

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "host-skill-sync-"));
  const repo = join(base, "repo");
  const home = join(base, "home");
  await mkdir(join(repo, ".agents", "skills", "alpha", "references"), { recursive: true });
  await mkdir(join(repo, ".agents", "skills", "beta"), { recursive: true });
  await mkdir(join(repo, ".claude-plugin"), { recursive: true });
  await writeFile(join(repo, ".agents", "skills", "alpha", "SKILL.md"), CANONICAL);
  await writeFile(join(repo, ".agents", "skills", "alpha", "references", "learned-auto.md"), OVERLAY);
  await writeFile(join(repo, ".agents", "skills", "beta", "SKILL.md"), "---\nname: beta\ndescription: 束縛外\n---\n");
  await writeFile(join(repo, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.2.0" }));
  return { base, repo, home };
}

async function installCopy(root, { skill = SHIPPED, overlay = OVERLAY, beta = "---\nname: beta\ndescription: 束縛外\n---\n" } = {}) {
  await mkdir(join(root, "skills", "alpha", "references"), { recursive: true });
  await mkdir(join(root, "skills", "beta"), { recursive: true });
  await writeFile(join(root, "skills", "alpha", "SKILL.md"), skill);
  if (overlay !== null) await writeFile(join(root, "skills", "alpha", "references", "learned-auto.md"), overlay);
  await writeFile(join(root, "skills", "beta", "SKILL.md"), beta);
}

async function installClaude(home, version, options) {
  const root = join(home, ".claude", "plugins", "cache", "buzzassist", "buzzassist", version);
  await installCopy(root, options);
  await mkdir(join(home, ".claude", "plugins"), { recursive: true });
  await writeFile(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: { "buzzassist@buzzassist": [{ scope: "user", installPath: root, version }] },
  }));
  return root;
}

async function installCodex(home, version, options) {
  const root = join(home, ".codex", "plugins", "cache", "buzzassist", "buzzassist", version);
  await installCopy(root, options);
  return root;
}

const DECLARATION = { canonicalSkills: [".agents/skills/alpha/SKILL.md"] };

test("ホストに入っていなければ比べる相手が無いだけで、止めない", async () => {
  const { base, repo, home } = await fixture();
  const verdict = probeHostSkillSync({ repoRoot: repo, homeDir: home, declaration: DECLARATION });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.required, false);
  assert.deepEqual(verdict.installs, []);
  await rm(base, { recursive: true, force: true });
});

test("両ホストが正本と同じ中身なら一致と報告する（配布時の相対参照の書き換えは差にしない）", async () => {
  const { base, repo, home } = await fixture();
  await installClaude(home, "0.2.0");
  await installCodex(home, "0.2.0");
  const verdict = probeHostSkillSync({ repoRoot: repo, homeDir: home, declaration: DECLARATION });
  assert.equal(verdict.ok, true, verdict.detail);
  assert.deepEqual(verdict.installs.map((install) => install.host).sort(), ["claude", "codex"]);
  await rm(base, { recursive: true, force: true });
});

test("Codex は cache の一番新しい版を読むものとして比べる", async () => {
  const { base, repo, home } = await fixture();
  await installCodex(home, "0.1.9", { skill: "古い\n" });
  await installCodex(home, "0.2.0");
  const [codex] = resolveHostPluginInstalls({ homeDir: home });
  assert.equal(codex.version, "0.2.0", "0.1.9 と 0.2.0 を文字列順でなく版の順で比べること");
  assert.equal(compareHostSkillSync({ repoRoot: repo, homeDir: home }).drift.length, 0);
  await rm(base, { recursive: true, force: true });
});

test("ハーネスが束縛するスキルが古いホストがあれば止め、どのホストの何かを言う", async () => {
  // 2026-09-24 の実測: 正本 0.1.26 に対し、両ホストの cache が 0.1.25 だった。
  const { base, repo, home } = await fixture();
  await installClaude(home, "0.1.9", { skill: "古い指示\n" });
  await installCodex(home, "0.2.0");
  const verdict = probeHostSkillSync({ repoRoot: repo, homeDir: home, declaration: DECLARATION });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.required, true, "束縛スキルのずれは本番を止めること");
  assert.deepEqual(verdict.blockingSkills, ["alpha"]);
  assert.match(verdict.detail, /claude:alpha\/SKILL\.md\(古い\)/u);
  assert.match(verdict.fix, /update-current\.mjs/u, "直し方を示すこと");
  await rm(base, { recursive: true, force: true });
});

test("版が同じでも overlay だけずれていれば見つける（自己改善の sync 後に配り直していない）", async () => {
  const { base, repo, home } = await fixture();
  await installCodex(home, "0.2.0", { overlay: "# 機械が書く層\n" });
  const verdict = probeHostSkillSync({ repoRoot: repo, homeDir: home, declaration: DECLARATION });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.drift.some((entry) => entry.file === "learned-auto" && entry.host === "codex"));
  await rm(base, { recursive: true, force: true });
});

test("束縛外のスキルのずれと、ハーネス未指定の確認では止めずに知らせる", async () => {
  const { base, repo, home } = await fixture();
  await installClaude(home, "0.2.0", { beta: "古い beta\n" });
  const bound = probeHostSkillSync({ repoRoot: repo, homeDir: home, declaration: DECLARATION });
  assert.equal(bound.ok, false);
  assert.equal(bound.required, false, "束縛外のずれで本番を止めない");
  const setupOnly = probeHostSkillSync({ repoRoot: repo, homeDir: home });
  assert.equal(setupOnly.required, false);
  await rm(base, { recursive: true, force: true });
});
