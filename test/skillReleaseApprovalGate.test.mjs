// 運営者の決定（2026-09-26）: 正本スキルはエージェントも直してよく、人が確かめるのは運営者へ配る版を
// 出すときの1回。その1回（npm run skills:check:release = skill-inventory --require-approval）が、
// エージェントが直して在庫の SHA を更新した版を、人の承認なしには通さないことを確かめる。
// リポジトリの写しを一時ディレクトリへ作り、承認は合成する（実際の承認状態に試験を依存させない）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SKILL_INVENTORY_MANIFEST_PATH, computeSkillBundle, recordSkillApproval, skillApprovalState } from "../lib/skillInventory.mjs";
import { runSkillInventoryCli } from "../scripts/skill-inventory.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function stageRepository(t) {
  const copy = realpathSync(mkdtempSync(join(tmpdir(), "skill-release-gate-")));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  for (const entry of [".agents", join(".claude", "skills"), ".claude-plugin", ".codex-plugin", "skills", "package.json"]) {
    if (existsSync(join(root, entry))) cpSync(join(root, entry), join(copy, entry), { recursive: true });
  }
  return copy;
}

function readManifest(copy) {
  return JSON.parse(readFileSync(join(copy, SKILL_INVENTORY_MANIFEST_PATH), "utf8"));
}

function writeManifest(copy, manifest) {
  writeFileSync(join(copy, SKILL_INVENTORY_MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function bundleOf(copy, skill) {
  return (await computeSkillBundle(dirname(join(copy, skill.canonicalPath)))).bundleSha256;
}

/** 正本の本番スキルすべてに、今の版・内容・束への人の承認を合成して付ける（承認者は合成の名前）。 */
function approveAll(copy) {
  const manifest = readManifest(copy);
  for (const skill of manifest.skills) {
    if (skill.origin !== "project-canonical" || skill.classification?.productionAllowed !== true) continue;
    skill.approval = { reviewer: "synthetic-approver", approvedAt: "2026-09-26T00:00:00.000Z", version: skill.version, contentSha256: skill.contentSha256, bundleSha256: skill.bundleSha256, attestedBy: "human-verified" };
  }
  writeManifest(copy, manifest);
  return manifest;
}

async function stagedWithHome(t) {
  const copy = stageRepository(t);
  const home = realpathSync(mkdtempSync(join(tmpdir(), "skill-release-gate-home-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { copy, home };
}

// 関門は別の process で流す。この process の標準出力を差し替えると、試験の実行器が同じ標準出力で送る
// 他の試験の結果まで捨ててしまう（試験が複数あると、最後の1件しか数えられなかった）。
const inventoryCli = join(root, "scripts", "skill-inventory.mjs");

async function releaseGate(copy, home) {
  const result = spawnSync(process.execPath, [inventoryCli, "--project-dir", copy, "--require-approval", "--json"], {
    cwd: copy,
    env: { PATH: process.env.PATH || "", HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot || "" },
    encoding: "utf8",
  });
  if (result.status !== 0 && result.status !== 4) {
    throw new Error(`skill-inventory が exit ${result.status} で止まった: ${result.stderr}`);
  }
  return { report: JSON.parse(result.stdout), exitCode: result.status };
}

test("エージェントが正本を直して在庫の SHA を更新しても、リリースの関門は人の承認が付くまで止める", async (t) => {
  const copy = stageRepository(t);
  const home = realpathSync(mkdtempSync(join(tmpdir(), "skill-release-gate-home-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  // 出発点: 正本の本番スキルすべてに、今の版と内容への人の承認が付いている（合成の承認者）。
  const manifest = readManifest(copy);
  for (const skill of manifest.skills) {
    if (skill.origin !== "project-canonical" || skill.classification?.productionAllowed !== true) continue;
    skill.approval = { reviewer: "synthetic-approver", approvedAt: "2026-09-26T00:00:00.000Z", version: skill.version, contentSha256: skill.contentSha256, bundleSha256: skill.bundleSha256, attestedBy: "human-verified" };
  }
  writeManifest(copy, manifest);
  const approved = await releaseGate(copy, home);
  assert.deepEqual(approved.report.analysis.unapprovedProductionSkills, []);
  assert.notEqual(approved.exitCode, 4, "承認済みなのにリリースの関門で止まった");

  // エージェントが正本スキルを直し（差分の承認キューの approve か skill-creator の直接の編集）、
  // skill-creator の手順どおり在庫の contentSha256 と bundleSha256 を今の内容へ更新した。版は据え置き。
  const target = manifest.skills.find((skill) => skill.id === "buzzassist:platform-craft");
  const skillPath = join(copy, target.canonicalPath);
  const edited = `${readFileSync(skillPath, "utf8")}\n<!-- 合成の追記: エージェントが当てた変更 -->\n`;
  writeFileSync(skillPath, edited);
  const afterEdit = readManifest(copy);
  const entry = afterEdit.skills.find((skill) => skill.id === target.id);
  entry.contentSha256 = sha(edited);
  entry.bundleSha256 = await bundleOf(copy, entry);
  writeManifest(copy, afterEdit);
  assert.equal(skillApprovalState(entry), "stale", "承認は前の内容に束縛されたまま");

  const gated = await releaseGate(copy, home);
  assert.equal(gated.report.analysis.ok, true, "在庫の SHA は正本と一致している（整合の問題ではない）");
  assert.deepEqual(
    gated.report.analysis.unapprovedProductionSkills.map((row) => [row.id, row.approvalState]),
    [[target.id, "stale"]],
  );
  assert.equal(gated.exitCode, 4, "承認の無い版をリリースの関門が通した");

  // 機械が名乗った承認（human-verified でない）は、在庫そのものが壊れているとして読まない（fail-closed）。
  entry.approval = { reviewer: "agent", approvedAt: "2026-09-26T01:00:00.000Z", version: entry.version, contentSha256: entry.contentSha256, bundleSha256: entry.bundleSha256, attestedBy: "agent-self-attested" };
  writeManifest(copy, afterEdit);
  await assert.rejects(() => releaseGate(copy, home), /attestedBy must be human-verified/u, "機械の申告を承認として通した");
});

// 2026-09-26 に references だけを変えたコミットが2つあり、SKILL.md の SHA しか見ない承認は「今の版」の
// ままに見えていた。束の digest（bundleSha256）で、references だけの変更も関門で止める。
test("references だけを変えても、在庫の検査が食い違いを見つけ、在庫を直したあとも承認が付くまで関門で止める", async (t) => {
  const { copy, home } = await stagedWithHome(t);
  const manifest = approveAll(copy);
  const target = manifest.skills.find((skill) => skill.id === "buzzassist:platform-craft");
  const referencePath = join(copy, dirname(target.canonicalPath), "references", "quality-loops-ja.md");
  const skillMd = readFileSync(join(copy, target.canonicalPath));
  writeFileSync(referencePath, `${readFileSync(referencePath, "utf8")}\n<!-- 合成の追記: references だけの変更 -->\n`);

  // 在庫を更新していない: SKILL.md の SHA は一致したままでも、在庫の検査（skills:check）が落ちる。
  const drifted = await releaseGate(copy, home);
  assert.deepEqual(readFileSync(join(copy, target.canonicalPath)), skillMd, "SKILL.md は変えていない");
  assert.equal(drifted.report.analysis.ok, false);
  assert.match(drifted.report.analysis.manifestIssues.join("\n"), /buzzassist:platform-craft: manifest bundle hash .* != sha256:[a-f0-9]{64}/u);
  assert.equal(drifted.exitCode, 4, "references だけの変更をリリースの関門が通した");
  assert.deepEqual(
    drifted.report.analysis.unapprovedProductionSkills.map((row) => [row.id, row.approvalState, row.reason]),
    [[target.id, "stale", "bundle-changed"]],
  );

  // skill-creator の手順どおり在庫の bundleSha256 を更新した: 整合は戻るが、承認は前の束に付いたまま。
  const updated = readManifest(copy);
  const entry = updated.skills.find((skill) => skill.id === target.id);
  entry.bundleSha256 = await bundleOf(copy, entry);
  writeManifest(copy, updated);
  const gated = await releaseGate(copy, home);
  assert.equal(gated.report.analysis.ok, true);
  assert.deepEqual(
    gated.report.analysis.unapprovedProductionSkills.map((row) => [row.id, row.approvalState, row.reason]),
    [[target.id, "stale", "bundle-changed"]],
  );
  assert.equal(gated.exitCode, 4);
});

test("自己改善が機械で書く learned-auto.md・learned-archive.md と evals/ だけの変更では、承認は外れず関門も止まらない", async (t) => {
  const { copy, home } = await stagedWithHome(t);
  const manifest = approveAll(copy);
  for (const id of ["buzzassist:platform-craft", "buzzassist:manga-video-production"]) {
    const skillDir = join(copy, dirname(manifest.skills.find((skill) => skill.id === id).canonicalPath));
    writeFileSync(join(skillDir, "references", "learned-auto.md"), "# 合成の overlay（sync が書き直した）\n\n- 合成の学習項目\n");
    writeFileSync(join(skillDir, "references", "learned-archive.md"), "# 合成の退避\n");
    writeFileSync(join(skillDir, "evals", "evals.json"), `${JSON.stringify({ skill_name: "synthetic", evals: [] }, null, 2)}\n`);
    writeFileSync(join(skillDir, ".DS_Store"), Buffer.from([0, 1, 2, 3]));
  }
  const gate = await releaseGate(copy, home);
  assert.equal(gate.report.analysis.ok, true, "機械の overlay の書き直しを在庫の食い違いとして数えた");
  assert.deepEqual(gate.report.analysis.unapprovedProductionSkills, []);
  assert.notEqual(gate.exitCode, 4, "機械の overlay の書き直しで承認が外れた");
});

test("bundleSha256 の無い古い承認は references を覆っていないとして関門で止まり、承認し直すと両方が記録されて通る", async (t) => {
  const { copy, home } = await stagedWithHome(t);
  const manifest = approveAll(copy);
  const target = manifest.skills.find((skill) => skill.id === "buzzassist:manga-video-production");
  // 2026-09-26 までの記録の形（contentSha256 だけ）に戻す。
  delete manifest.skills.find((skill) => skill.id === target.id).approval.bundleSha256;
  writeManifest(copy, manifest);
  const legacy = await releaseGate(copy, home);
  assert.equal(legacy.report.analysis.ok, true, "古い承認の記録は在庫として読める");
  assert.deepEqual(
    legacy.report.analysis.unapprovedProductionSkills.map((row) => [row.id, row.approvalState, row.reason]),
    [[target.id, "stale", "bundle-not-covered"]],
  );
  assert.equal(legacy.exitCode, 4, "references を覆っていない承認で関門を通した");

  // 承認者の端末から承認し直す（対話端末は差し替える。機械の手番ではなく、試験の中の合成の承認者）。
  // 対話端末でなければ CLI は受け付けない。
  const approveArgs = ["--project-dir", copy, "--approve", target.id, "--reviewer", "synthetic-approver", "--human-verified"];
  await assert.rejects(() => runSkillInventoryCli(approveArgs, { isInteractive: false, env: {} }), /対話端末/u);
  const recorded = await recordSkillApproval({
    projectDir: copy,
    skillId: target.id,
    reviewer: "synthetic-approver",
    humanVerified: true,
    isInteractive: true,
    now: () => "2026-09-26T02:00:00.000Z",
  });
  const written = readManifest(copy).skills.find((skill) => skill.id === target.id);
  assert.equal(recorded.approval.contentSha256, written.contentSha256);
  assert.equal(recorded.approval.bundleSha256, written.bundleSha256);
  assert.equal(recorded.approval.bundleSha256, await bundleOf(copy, written), "承認は実物の束に付く");
  assert.equal(skillApprovalState(written), "current");
  const passed = await releaseGate(copy, home);
  assert.deepEqual(passed.report.analysis.unapprovedProductionSkills, []);
  assert.notEqual(passed.exitCode, 4);
});
