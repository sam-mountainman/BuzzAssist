import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHANNEL_SKILL_INVENTORY_MANIFEST_PATH,
  SKILL_BUNDLE_DIGEST_VERSION,
  SKILL_INVENTORY_MANIFEST_PATH,
  buildSkillInventory,
  recordSkillApproval,
  skillApprovalState,
  validateChannelSkillInventoryManifest,
} from "../lib/skillInventory.mjs";
import { runSkillInventoryCli } from "../scripts/skill-inventory.mjs";

// チャンネル名・スキル名・承認者はすべて合成の値。
const projectDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const SKILL_SOURCE = "---\nname: synthetic-script-writer\ndescription: 合成のチャンネル専用の台本スキル\n---\n\n# 合成の台本スキル\n";
const ADAPTER_SOURCE = "---\nname: synthetic-script-writer\n---\n\n正本は skills/synthetic-script-writer/SKILL.md を読む。\n";
const SKILL_ID = "synthetic-channel:synthetic-script-writer";
const REFERENCE_SOURCE = "# 合成の参照\n\n台本の決まり\n";
// 束（SKILL.md と references）の digest。実装を通さずに仕様どおり組み立てる（test/skillBundleDigest.test.mjs と同じ式）。
const hex = (value) => createHash("sha256").update(value).digest("hex");
const bundleOf = (files) => `sha256:${hex(`${SKILL_BUNDLE_DIGEST_VERSION}\n${files.map(([path, content]) => `${hex(content)} ${JSON.stringify(path)}\n`).join("")}`)}`;
const BUNDLE = bundleOf([["SKILL.md", SKILL_SOURCE], ["references/rules-ja.md", REFERENCE_SOURCE]]);

function channelManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    scope: "channel",
    manifestVersion: "0.1.0",
    namespace: "synthetic-channel",
    skills: [{
      id: SKILL_ID,
      name: "synthetic-script-writer",
      version: "0.3.0",
      contentSha256: sha(SKILL_SOURCE),
      bundleSha256: BUNDLE,
      language: "ja",
      owner: "synthetic operator",
      origin: "channel-private",
      canonicalPath: "skills/synthetic-script-writer/SKILL.md",
      hosts: ["claude-code", "codex", "antigravity"],
      adapters: [{ host: "claude-code", path: ".claude/skills/synthetic-script-writer/SKILL.md", name: "synthetic-script-writer" }],
      classification: { installed: false, bundled: false, productionAllowed: true, developmentOnly: false },
      ...overrides,
    }],
  };
}

async function channelDir(t, manifest = channelManifest()) {
  const root = await mkdtemp(join(tmpdir(), "channel-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "skills", "synthetic-script-writer"), { recursive: true });
  await mkdir(join(root, ".claude", "skills", "synthetic-script-writer"), { recursive: true });
  await writeFile(join(root, "skills", "synthetic-script-writer", "SKILL.md"), SKILL_SOURCE);
  await mkdir(join(root, "skills", "synthetic-script-writer", "references"), { recursive: true });
  await writeFile(join(root, "skills", "synthetic-script-writer", "references", "rules-ja.md"), REFERENCE_SOURCE);
  await writeFile(join(root, ".claude", "skills", "synthetic-script-writer", "SKILL.md"), ADAPTER_SOURCE);
  await writeFile(join(root, CHANNEL_SKILL_INVENTORY_MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

test("私有の在庫を公開の在庫と同じ規則で数え、未承認の本番スキルとして並べる", async (t) => {
  const root = await channelDir(t);
  const publicBefore = await readFile(join(projectDir, SKILL_INVENTORY_MANIFEST_PATH));
  const report = await buildSkillInventory({ projectDir, channelSkillsDir: root });
  const record = report.skills.find((entry) => entry.qualifiedId === SKILL_ID);
  assert.ok(record, "チャンネル専用スキルが在庫に出ない");
  assert.equal(record.sourceRole, "channel-canonical");
  assert.equal(record.scope, "channel:synthetic-channel");
  assert.equal(record.approvalState, "none");
  assert.deepEqual(report.channel, { namespace: "synthetic-channel", manifestVersion: "0.1.0", skills: 1 });
  assert.deepEqual(
    report.analysis.unapprovedProductionSkills.filter((entry) => entry.scope),
    [{ id: SKILL_ID, version: "0.3.0", approvalState: "none", scope: "channel:synthetic-channel" }],
  );
  assert.equal(report.analysis.ok, true);
  // 私有の在庫を読んでも、公開の manifest は1バイトも変わらない。
  assert.deepEqual(await readFile(join(projectDir, SKILL_INVENTORY_MANIFEST_PATH)), publicBefore);
  // 指定しなければ、今までどおり公開の在庫だけ。
  const plain = await buildSkillInventory({ projectDir });
  assert.equal(plain.skills.some((entry) => entry.sourceRole === "channel-canonical"), false);
  assert.equal(plain.channel, undefined);
});

test("私有の在庫の SHA のずれ・名前のずれ・経路のずれは manifest の問題として ok を落とす", async (t) => {
  const root = await channelDir(t, channelManifest({ contentSha256: sha("古い版") }));
  await writeFile(join(root, ".claude", "skills", "synthetic-script-writer", "SKILL.md"), "---\nname: other\n---\n");
  const report = await buildSkillInventory({ projectDir, channelSkillsDir: root });
  assert.equal(report.analysis.ok, false);
  const issues = report.analysis.manifestIssues.join("\n");
  assert.match(issues, /channel manifest hash/u);
  assert.match(issues, /channel adapter name does not match/u);
  assert.match(issues, /channel adapter does not route/u);
  const missing = await buildSkillInventory({ projectDir, channelSkillsDir: join(root, "no-such") });
  assert.match(missing.analysis.manifestIssues.join("\n"), /channel: channel skill manifest could not be read/u);
  // references だけの食い違い・digest の書き忘れも manifest の問題として数える（実物の値を出す）。
  const noBundle = await channelDir(t, channelManifest({ bundleSha256: undefined }));
  assert.match((await buildSkillInventory({ projectDir, channelSkillsDir: noBundle })).analysis.manifestIssues.join("\n"), new RegExp(`channel manifest bundleSha256 is missing \\(actual ${BUNDLE}\\)`, "u"));
  const edited = await channelDir(t);
  await writeFile(join(edited, "skills", "synthetic-script-writer", "references", "rules-ja.md"), `${REFERENCE_SOURCE}足した決まり\n`);
  const editedReport = await buildSkillInventory({ projectDir, channelSkillsDir: edited });
  assert.equal(editedReport.analysis.ok, false);
  assert.match(editedReport.analysis.manifestIssues.join("\n"), /channel manifest bundle hash/u);
});

test("私有の在庫の manifest は、公開の名前空間・在庫の外のパス・plugin・機械の承認を受け付けない", () => {
  assert.deepEqual(validateChannelSkillInventoryManifest(channelManifest()), []);
  const issuesFor = (manifest) => validateChannelSkillInventoryManifest(manifest).join("\n");
  assert.match(issuesFor({ ...channelManifest(), namespace: "buzzassist" }), /namespace/u);
  assert.match(issuesFor({ ...channelManifest(), scope: "public" }), /scope must be channel/u);
  assert.match(issuesFor({ ...channelManifest(), plugins: [] }), /must not declare plugins/u);
  assert.match(issuesFor(channelManifest({ id: "buzzassist:synthetic-script-writer" })), /must start with synthetic-channel:/u);
  assert.match(issuesFor(channelManifest({ origin: "project-canonical" })), /origin must be channel-private/u);
  assert.match(issuesFor(channelManifest({ canonicalPath: "../outside/SKILL.md" })), /inside the channel skill directory/u);
  const absolute = ["", "tmp", "synthetic", "SKILL.md"].join("/");
  assert.match(issuesFor(channelManifest({ canonicalPath: absolute })), /inside the channel skill directory/u);
  assert.match(issuesFor(channelManifest({
    approval: { reviewer: "agent", approvedAt: "2026-09-25T00:00:00.000Z", version: "0.3.0", contentSha256: sha(SKILL_SOURCE), attestedBy: "agent-self-attested" },
  })), /attestedBy must be human-verified/u);
  assert.match(issuesFor(channelManifest({ bundleSha256: "abc" })), /bundleSha256 must be SHA-256/u);
  assert.match(issuesFor({ ...channelManifest(), skills: [] }), /non-empty/u);
});

test("私有スキルの承認も、承認者の対話端末＋--human-verified の二手で、今の版と SHA に束縛して私有の manifest に書く", async (t) => {
  const root = await channelDir(t);
  const publicBefore = await readFile(join(projectDir, SKILL_INVENTORY_MANIFEST_PATH));
  const base = { projectDir, channelSkillsDir: root, skillId: SKILL_ID, reviewer: "合成の承認者", now: () => "2026-09-25T00:00:00.000Z" };
  await assert.rejects(() => recordSkillApproval({ ...base, humanVerified: false, isInteractive: true }), /--human-verified/u);
  await assert.rejects(() => recordSkillApproval({ ...base, humanVerified: true, isInteractive: false }), /対話端末/u);
  await assert.rejects(() => recordSkillApproval({ ...base, channelSkillsDir: "", humanVerified: true, isInteractive: true }), /--channel-skills/u);
  await assert.rejects(() => runSkillInventoryCli(["--approve", SKILL_ID, "--reviewer", "合成の承認者", "--human-verified", "--channel-skills", root], { isInteractive: false }), /対話端末/u);

  const result = await recordSkillApproval({ ...base, humanVerified: true, isInteractive: true });
  assert.equal(result.scope, "channel");
  assert.equal(result.approval.contentSha256, sha(SKILL_SOURCE));
  assert.equal(result.approval.bundleSha256, BUNDLE);
  const written = JSON.parse(await readFile(join(root, CHANNEL_SKILL_INVENTORY_MANIFEST_PATH), "utf8"));
  assert.equal(skillApprovalState(written.skills[0]), "current");
  assert.deepEqual(await readFile(join(projectDir, SKILL_INVENTORY_MANIFEST_PATH)), publicBefore, "公開の manifest に書いた");
  const approved = await buildSkillInventory({ projectDir, channelSkillsDir: root });
  assert.equal(approved.analysis.unapprovedProductionSkills.some((entry) => entry.id === SKILL_ID), false);

  // 正本を変えたら承認は今の版を保証しない（stale）。SHA を先に更新しないと承認を書けない。
  await writeFile(join(root, "skills", "synthetic-script-writer", "SKILL.md"), `${SKILL_SOURCE}足した行\n`);
  const stale = await buildSkillInventory({ projectDir, channelSkillsDir: root });
  assert.equal(stale.skills.find((entry) => entry.qualifiedId === SKILL_ID).approvalState, "stale");
  await assert.rejects(() => recordSkillApproval({ ...base, humanVerified: true, isInteractive: true }), /contentSha256 が正本と一致しない/u);

  // references だけを変えても承認は古くなり、在庫の bundleSha256 を直すまで承認を書けない。
  await writeFile(join(root, "skills", "synthetic-script-writer", "SKILL.md"), SKILL_SOURCE);
  await writeFile(join(root, "skills", "synthetic-script-writer", "references", "rules-ja.md"), `${REFERENCE_SOURCE}足した決まり\n`);
  const referencesOnly = await buildSkillInventory({ projectDir, channelSkillsDir: root });
  const record = referencesOnly.skills.find((entry) => entry.qualifiedId === SKILL_ID);
  assert.deepEqual([record.approvalState, record.approvalStaleReason], ["stale", "bundle-changed"]);
  await assert.rejects(() => recordSkillApproval({ ...base, humanVerified: true, isInteractive: true }), /bundleSha256 が正本の references・付属物と一致しない/u);
});

test("CLI は --channel-skills か環境変数で私有の在庫を読み、--require-approval で未承認の私有スキルを止める", async (t) => {
  const root = await channelDir(t);
  const originalWrite = process.stdout.write;
  const out = [];
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  try {
    const viaEnv = await runSkillInventoryCli(["--project-dir", projectDir, "--require-approval"], { env: { BUZZASSIST_CHANNEL_SKILLS: root } });
    assert.ok(viaEnv.skills.some((entry) => entry.qualifiedId === SKILL_ID));
    assert.equal(process.exitCode, 4);
    process.exitCode = 0;
    const viaFlag = await runSkillInventoryCli(["--project-dir", projectDir, "--channel-skills", root, "--json"], { env: {} });
    assert.ok(viaFlag.skills.some((entry) => entry.qualifiedId === SKILL_ID));
    process.exitCode = 0;
    const none = await runSkillInventoryCli(["--project-dir", projectDir, "--json"], { env: {} });
    assert.equal(none.skills.some((entry) => entry.sourceRole === "channel-canonical"), false);
    process.exitCode = 0;
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.match(out.join(""), /Channel-private skills \(namespace synthetic-channel/u);
});
