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
  assert.equal(verdict.developmentCheckout, false, "合成のリポジトリは .git もアダプターも持たない＝運営者の端末と同じ扱い");
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

test("開発用チェックアウトではアダプターが正本を直接読むので、ずれは知らせるだけで止めない", async () => {
  const { base, repo, home } = await fixture();
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(repo, ".claude", "skills"), { recursive: true });
  await mkdir(join(repo, ".codex", "skills"), { recursive: true });
  await installClaude(home, "0.1.9", { skill: "古い指示\n" });
  const verdict = probeHostSkillSync({ repoRoot: repo, homeDir: home, declaration: DECLARATION });
  assert.equal(verdict.developmentCheckout, true);
  assert.equal(verdict.ok, false, "ずれ自体は報告すること");
  assert.equal(verdict.required, false, "開発用チェックアウトでは本番を止めない");
  assert.match(verdict.detail, /正本を直接読む/u);
  await rm(base, { recursive: true, force: true });
});

// 外部レビューの指摘: SKILL.md しか比べておらず、references/・scripts/・assets/ のずれを
// 見落としていた。Codex の使用中の版は cache の最大の版からの推定だった。

async function addSkillFile(root, relative, content) {
  const target = join(root, ...relative.split("/"));
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content);
}

test("スキルのディレクトリ内の全ファイル（references・scripts・assets）を比べる", async () => {
  const { base, repo, home } = await fixture();
  const canonical = join(repo, ".agents", "skills", "alpha");
  await addSkillFile(canonical, "references/quality.md", "正本の手順は ../../../docs/x.md\n");
  await addSkillFile(canonical, "scripts/check.py", "print('new')\n");
  await addSkillFile(canonical, "assets/sheet.bin", "binary-new");
  const root = await installCodex(home, "0.2.0");
  const installed = join(root, "skills", "alpha");
  // references の .md は配布時に相対参照が1階層浅くなる。その差は差にしない。
  await addSkillFile(installed, "references/quality.md", "正本の手順は ../../docs/x.md\n");
  await addSkillFile(installed, "scripts/check.py", "print('old')\n");
  // assets/sheet.bin は入っていない。代わりに正本に無いファイルが残っている。
  await addSkillFile(installed, "assets/leftover.bin", "stale");
  const { drift } = compareHostSkillSync({ repoRoot: repo, homeDir: home });
  const found = drift.filter((entry) => entry.skill === "alpha").map((entry) => `${entry.file}:${entry.reason}`).sort();
  assert.deepEqual(found, ["assets/leftover.bin:extra", "assets/sheet.bin:missing", "scripts/check.py:stale"]);
  await rm(base, { recursive: true, force: true });
});

test("機械が書く references/learned-auto.md は全ファイルの比較に入れず、overlay として1件だけ報告する", async () => {
  const { base, repo, home } = await fixture();
  await installCodex(home, "0.2.0", { overlay: "# 機械が書く層（古い）\n" });
  const { drift } = compareHostSkillSync({ repoRoot: repo, homeDir: home });
  assert.deepEqual(drift.map((entry) => `${entry.skill}:${entry.file}:${entry.reason}`), ["alpha:learned-auto:stale"]);
  await rm(base, { recursive: true, force: true });
});

async function codexConfig(home, text) {
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex", "config.toml"), text);
}

async function codexMarketplace(home, version) {
  const source = join(home, "plugins", "buzzassist");
  await mkdir(join(source, "plugin", ".codex-plugin"), { recursive: true });
  await writeFile(join(source, "plugin", ".codex-plugin", "plugin.json"), JSON.stringify({ name: "buzzassist", version }));
  return source;
}

test("Codex の使用中の版は、設定の plugin の記録（有効か・どの marketplace か）から決める", async () => {
  const { base, repo, home } = await fixture();
  await installCodex(home, "0.2.0");
  await installCodex(home, "0.3.0", { skill: "まだ有効になっていない新しい版\n" });
  const source = await codexMarketplace(home, "0.2.0");
  await codexConfig(home, [
    "# 利用者の設定",
    "[marketplaces.buzzassist]",
    'source_type = "local"',
    `source = ${JSON.stringify(source)}`,
    "",
    '[plugins."buzzassist@buzzassist"]',
    "enabled = true",
    "",
  ].join("\n"));
  const codex = resolveHostPluginInstalls({ homeDir: home }).find((install) => install.host === "codex");
  assert.equal(codex.version, "0.2.0", "cache の最大の版（0.3.0）ではなく、設定が指す marketplace の版");
  assert.equal(codex.versionSource, "codex-config");
  assert.equal(codex.estimated, false);
  assert.equal(compareHostSkillSync({ repoRoot: repo, homeDir: home }).drift.length, 0);
  await rm(base, { recursive: true, force: true });
});

test("Codex の設定が読めないときは cache から推定し、推定であることを結果に出す", async () => {
  const { base, repo, home } = await fixture();
  await installCodex(home, "0.2.0");
  const codex = resolveHostPluginInstalls({ homeDir: home }).find((install) => install.host === "codex");
  assert.equal(codex.version, "0.2.0");
  assert.equal(codex.estimated, true);
  assert.equal(codex.versionSource, "estimated-newest-cache");
  const verdict = probeHostSkillSync({ repoRoot: repo, homeDir: home });
  assert.match(verdict.detail, /codex 0\.2\.0（推定）/u);
  await rm(base, { recursive: true, force: true });
});

test("Codex の設定で BuzzAssist が無効なら、Codex は読んでいないとして比べない", async () => {
  const { base, repo, home } = await fixture();
  await installCodex(home, "0.1.9", { skill: "古い\n" });
  await codexConfig(home, '[plugins."buzzassist@buzzassist"]\nenabled = false\n');
  assert.deepEqual(resolveHostPluginInstalls({ homeDir: home }).map((install) => install.host), []);
  await rm(base, { recursive: true, force: true });
});
