// 外側のループ（lib/harnessInbox.mjs）の試験。台帳とJobはすべて合成（端末の本物の台帳は読まない）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { harnessInbox, harnessInboxText, readProjectJobs, waitingOnForJob } from "../lib/harnessInbox.mjs";
import { runHarnessInboxCli } from "../scripts/harness-inbox.mjs";

const NOW = "2026-10-29T00:00:00.000Z";

function writeJob(projectDir, job) {
  const dir = path.join(projectDir, "canvas", "harness-runs", job.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "job.json"), JSON.stringify(job));
}

test("人の確認待ち・失敗・計画だけの Job と、作業場所の消えたチャンネル・止めたチャンネルを、重い順に次の仕事として返す", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "harness-inbox-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const alpha = path.join(root, "alpha");
  writeJob(alpha, { id: "video-narrated-story-video-0000000000000001", harness: { id: "narrated-story-video" }, status: "awaiting-human-review", blockers: ["human-review-signed"], updatedAt: "2026-10-20T00:00:00.000Z" });
  writeJob(alpha, { id: "video-narrated-story-video-0000000000000002", harness: { id: "narrated-story-video" }, status: "failed", blockers: [], updatedAt: "2026-10-28T00:00:00.000Z" });
  writeJob(alpha, { id: "video-narrated-story-video-0000000000000003", harness: { id: "narrated-story-video" }, status: "planned", blockers: [], updatedAt: "2026-10-28T12:00:00.000Z" });
  writeJob(alpha, { id: "video-narrated-story-video-0000000000000004", harness: { id: "narrated-story-video" }, status: "completed", blockers: [], updatedAt: "2026-10-28T12:00:00.000Z" });
  const registry = {
    channels: [
      { id: "alpha", projectDir: alpha, production: { kind: "harness", harnessId: "narrated-story-video" } },
      { id: "beta", projectDir: path.join(root, "gone"), production: { kind: "harness", harnessId: "narrated-story-video" } },
      { id: "gamma", projectDir: path.join(root, "external"), production: { kind: "external", note: "合成" } },
    ],
    quarantined: [{ id: "retired", issues: [{ code: "channel-harness-unknown:retired", detail: "合成" }] }],
  };
  const report = await harnessInbox({ registry, now: () => NOW });
  assert.deepEqual(report.items.map((item) => item.kind), [
    "job-awaiting-human-review",
    "job-failed",
    "job-planned",
    "channel-quarantined",
    "project-missing",
  ]);
  const first = report.next[0];
  assert.equal(first.kind, "job-awaiting-human-review");
  assert.equal(first.stale, true);
  assert.equal(first.waitingOn.actor, "reviewer");
  assert.equal(first.waitingOn.kind, "signoff");
  assert.ok(report.items.some((item) => item.kind === "project-missing" && item.channel === "beta"));
  assert.equal(report.items.some((item) => item.jobId === "video-narrated-story-video-0000000000000004"), false, "完了した Job は出さない");
  // 有料の処理は示すだけ（resume --confirmed の行に確かめる旨を書く）。
  const failed = report.items.find((item) => item.kind === "job-failed");
  assert.ok(failed.commands.some((command) => /resume .*--confirmed$/u.test(command)), failed.commands.join(" | "));
  assert.match(failed.note, /有料の処理に進む/u);
  assert.ok(failed.commands.every((command) => command.includes(`--project-dir '${alpha}'`)), "作業場所は単一引用符で包む");
  assert.match(harnessInboxText(report), /次の仕事/u);
  assert.equal(readProjectJobs(path.join(root, "nothing")).length, 0);
});

test("誰の何待ちか: 署名待ちは reviewer、計画だけは運営者の有料の確認、実行中は system", () => {
  assert.equal(waitingOnForJob({ status: "awaiting-human-review", blockers: ["quality-loop-below-target"] }).actor, "operator");
  assert.equal(waitingOnForJob({ status: "planned" }).kind, "paid-confirmation");
  assert.equal(waitingOnForJob({ status: "running" }).actor, "system");
  assert.equal(waitingOnForJob({ status: "completed" }), null);
});

test("CLI: 台帳が読めなくても止まらずに、読めないことを次の仕事として返す", async () => {
  let out = "";
  const code = await runHarnessInboxCli(["--json"], {
    stdout: { write: (text) => { out += text; } },
    inbox: () => harnessInbox({ registry: { channels: [], quarantined: [] }, now: () => NOW }),
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(out).items.length, 0);
  await assert.rejects(runHarnessInboxCli(["--bogus"], { stdout: { write() {} } }), /知らない引数/u);
  const broken = await harnessInbox({ deploymentPath: path.join(tmpdir(), "synthetic-missing-registry.json"), now: () => NOW });
  assert.equal(broken.items[0].kind, "registry-invalid");
});

test("Job の置き場が読めない（権限・I/O）ときは「仕事が無い」でなく確認の項目として返す", async () => {
  const registry = { channels: [{ id: "alpha", projectDir: tmpdir(), production: { kind: "harness", harnessId: "narrated-story-video" } }], quarantined: [] };
  const report = await harnessInbox({
    registry,
    now: () => NOW,
    readJobs: () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); },
  });
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0].kind, "jobs-unreadable");
  assert.match(report.items[0].detail, /EACCES/u);
});
