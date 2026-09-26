// doctor の skill-approval（正本スキルの人の承認）の試験。運営者の決定（2026-09-26）: 人が確かめるのは
// リリースのときの1回。開発用チェックアウトでは止めずに知らせ、配布された写しでは Job の作成と同じく止める。
// 承認は実際の在庫の上に合成する（リポジトリの実際の承認状態に試験を依存させない）。
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadSkillPolicyManifests } from "../lib/skillInventory.mjs";
import { SKILL_APPROVAL_REQUIREMENT_ENV, probeSkillApproval } from "../lib/videoHarnessProductionProfile.mjs";
import { runHarnessDoctor, skillApprovalCheck } from "../scripts/harness-doctor.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const declaration = { canonicalSkills: [".agents/skills/narrated-story-video/SKILL.md", ".agents/skills/platform-craft/SKILL.md"] };

async function policy(mutate) {
  const loaded = structuredClone(await loadSkillPolicyManifests(root));
  for (const skill of loaded.inventory.skills) {
    skill.approval = { reviewer: "test-reviewer", approvedAt: "2026-09-26T00:00:00.000Z", version: skill.version, contentSha256: skill.contentSha256, bundleSha256: skill.bundleSha256, attestedBy: "human-verified" };
    mutate?.(skill);
  }
  return async () => loaded;
}

const stalePlatformCraft = () => policy((skill) => {
  if (skill.id === "buzzassist:platform-craft") skill.approval.contentSha256 = `sha256:${"0".repeat(64)}`;
});

test("宣言の正本スキルの承認を見て、開発用チェックアウトでは止めない（advisory）", async () => {
  const probe = await probeSkillApproval({ repoRoot: root, env: {}, declaration, checkout: "development", loadPolicy: await stalePlatformCraft() });
  assert.deepEqual(
    { ok: probe.ok, enforced: probe.enforced, checked: probe.checked, ids: probe.unapprovedSkills.map((row) => [row.id, row.approvalState]) },
    { ok: false, enforced: false, checked: 2, ids: [["buzzassist:platform-craft", "stale"]] },
  );
  const check = skillApprovalCheck(probe, { harnessId: "narrated-story-video" });
  assert.equal(check.required, false, "開発用チェックアウトで止めた");
  assert.equal(check.ok, false);
  assert.match(check.detail, /開発用チェックアウトなので止めない/u);
  assert.match(check.detail, /buzzassist:platform-craft \d+\.\d+\.\d+/u);
  assert.match(check.fix, /skill-inventory\.mjs --approve/u);
  assert.equal(JSON.stringify(check).includes("test-reviewer"), false, "承認者名を出した");

  const clean = skillApprovalCheck(await probeSkillApproval({ repoRoot: root, env: {}, declaration, checkout: "development", loadPolicy: await policy() }), { harnessId: "narrated-story-video" });
  assert.deepEqual({ ok: clean.ok, required: clean.required, unapproved: clean.unapprovedSkills }, { ok: true, required: false, unapproved: [] });
});

test("配布された写しでハーネスを指定したら、未承認で止める（Job の作成と同じ判定）", async () => {
  const loadPolicy = await stalePlatformCraft();
  const distributed = await probeSkillApproval({ repoRoot: root, env: {}, declaration, checkout: "distributed", loadPolicy });
  assert.equal(distributed.enforced, true);
  const check = skillApprovalCheck(distributed, { harnessId: "narrated-story-video" });
  assert.deepEqual({ ok: check.ok, required: check.required }, { ok: false, required: true });
  assert.match(check.fix, /承認済みの Release へ更新/u);
  // ハーネス未指定のセットアップ確認では止めない（canvas だけ使う人を止めない）。
  assert.equal(skillApprovalCheck(distributed, { harnessId: "" }).required, false);
  // 明示の 0 は今までどおり外せるが、外したことを本文に出す。
  const relaxed = skillApprovalCheck(await probeSkillApproval({ repoRoot: root, env: { [SKILL_APPROVAL_REQUIREMENT_ENV]: "0" }, declaration, checkout: "distributed", loadPolicy }), { harnessId: "narrated-story-video" });
  assert.equal(relaxed.required, false);
  assert.match(relaxed.detail, new RegExp(`${SKILL_APPROVAL_REQUIREMENT_ENV}=0`, "u"));
  // 在庫を読めなければ ok にしない。
  const unreadable = skillApprovalCheck(await probeSkillApproval({ repoRoot: root, env: {}, declaration, checkout: "distributed", loadPolicy: async () => { throw new Error("broken manifest"); } }), { harnessId: "narrated-story-video" });
  assert.deepEqual({ ok: unreadable.ok, required: unreadable.required }, { ok: false, required: true });
});

test("束（references・付属物）を覆っていない古い承認は、doctor でも承認済みにせず理由を出す", async () => {
  const probe = await probeSkillApproval({
    repoRoot: root,
    env: {},
    declaration,
    checkout: "distributed",
    loadPolicy: await policy((skill) => { if (skill.id === "buzzassist:narrated-story-video") delete skill.approval.bundleSha256; }),
  });
  assert.deepEqual(
    probe.unapprovedSkills.map((row) => [row.id, row.approvalState, row.reason]),
    [["buzzassist:narrated-story-video", "stale", "bundle-not-covered"]],
  );
  const check = skillApprovalCheck(probe, { harnessId: "narrated-story-video" });
  assert.deepEqual({ ok: check.ok, required: check.required }, { ok: false, required: true });
  assert.match(check.detail, /buzzassist:narrated-story-video \d+\.\d+\.\d+（stale: 承認が references・付属物を覆っていない/u);
});

test("ハーネス未指定では、リリースの関門と同じ集合（正本の本番スキル）を見る", async () => {
  const probe = await probeSkillApproval({ repoRoot: root, env: {}, checkout: "development", loadPolicy: await policy((skill) => { skill.approval = undefined; }) });
  const loaded = await loadSkillPolicyManifests(root);
  const expected = loaded.inventory.skills
    .filter((skill) => skill.origin === "project-canonical" && skill.classification?.productionAllowed === true && skill.classification?.developmentOnly !== true)
    .map((skill) => skill.id)
    .sort();
  assert.deepEqual(probe.unapprovedSkills.map((row) => row.id), expected);
  assert.ok(probe.unapprovedSkills.every((row) => row.approvalState === "none"));
});

test("doctor の本体に skill-approval が出る（開発用は advisory、配布された写しでハーネス指定なら blocking）", async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "doctor-skill-approval-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const binary = (command) => ({ ok: true, command, args: [], version: "7.1.1" });
  const runtime = (probe) => ({
    homeDir: home,
    env: { PATH: process.env.PATH || "" },
    ffmpegToolchain: { ok: true, ffmpeg: binary("ffmpeg"), ffprobe: binary("ffprobe") },
    runCommand: async (_command, args = []) => {
      if (args.includes("-encoders")) return { stdout: "libx264 aac pcm_s24le", stderr: "" };
      if (args.includes("-filters")) return { stdout: "scale crop overlay fps loudnorm aresample", stderr: "" };
      if (args.includes("-show_streams")) return { stdout: JSON.stringify({ streams: [{ codec_type: "video" }, { codec_type: "audio" }] }), stderr: "" };
      return { stdout: "", stderr: "" };
    },
    pythonRuntime: { ok: true, command: "python", args: [], version: "3.12.2" },
    voiceQualityProbe: async () => true,
    diskFreeBytes: async () => 64 * 1024 ** 3,
    ttsProbe: async () => ({ ok: true, detail: "設定あり", fix: "" }),
    imageModel: "gpt-image-2-codex",
    imageHostProbe: async (model) => ({ ok: true, host: "codex", model, detail: `Codex / ${model}` }),
    skillApprovalProbe: async () => probe,
  });
  const unapproved = [{ id: "buzzassist:sample-craft", version: "1.0.0", approvalState: "stale" }];
  const development = await runHarnessDoctor({ runtime: runtime({ ok: false, enforced: false, checkout: "development", checked: 1, unapprovedSkills: unapproved }) });
  const devCheck = development.checks.find((entry) => entry.id === "skill-approval");
  assert.ok(devCheck, "skill-approval の検査が無い");
  assert.ok(development.advisory.includes("skill-approval"));
  assert.equal(development.blocking.includes("skill-approval"), false, "開発用チェックアウトで止めた");

  const distributed = await runHarnessDoctor({
    harnessId: "narrated-story-video",
    runtime: runtime({ ok: false, enforced: true, checkout: "distributed", checked: 1, unapprovedSkills: unapproved }),
  });
  assert.ok(distributed.blocking.includes("skill-approval"), "配布された写しで未承認なのに止めなかった");
});
