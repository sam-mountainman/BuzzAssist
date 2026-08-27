import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  CHARACTER_ATTRIBUTE_HARD_GATES,
  attributeHardGateReport,
  auditCandidateAttributes,
  buildCharacterCandidateQualityContract,
} from "../lib/characterAttributeGate.mjs";

const execFile = promisify(execFileCallback);

async function pythonAvailable() {
  try {
    await execFile("python3", ["-c", "import cv2, numpy"]);
    return true;
  } catch {
    return false;
  }
}

async function writeFixtures(dir) {
  const script = `
import cv2, numpy as np
import sys
dir = sys.argv[1]
def solid(name, bgr):
    image = np.full((200, 200, 3), bgr, dtype=np.uint8)
    cv2.imwrite(f"{dir}/{name}", image)
# chromatic mid-saturation "hair" colors on the full frame
solid("base.png", (60, 62, 104))
solid("same.png", (60, 62, 104))
solid("shifted.png", (60, 92, 160))
# unintended-change pair: identical except one corner block
a = np.full((200, 200, 3), (60, 62, 104), dtype=np.uint8)
cv2.imwrite(f"{dir}/uc-base.png", a)
b = a.copy(); b[150:200, 150:200] = (30, 200, 30)
cv2.imwrite(f"{dir}/uc-changed.png", b)
# neck ornament pair: gold streak vs clean
clean = np.full((200, 200, 3), (200, 190, 180), dtype=np.uint8)
cv2.imwrite(f"{dir}/neck-clean.png", clean)
gold = clean.copy(); gold[100:112, 40:160] = (30, 170, 230)
cv2.imwrite(f"{dir}/neck-gold.png", gold)
# distinct textures for duplicate check
rng = np.random.default_rng(7)
cv2.imwrite(f"{dir}/tex-a.png", rng.integers(0, 255, (200, 200, 3), dtype=np.uint8))
cv2.imwrite(f"{dir}/tex-b.png", rng.integers(0, 255, (200, 200, 3), dtype=np.uint8))
print("ok")
`;
  await execFile("python3", ["-c", script, dir]);
}

test("attribute gates catch drift, duplicates, side effects and ornaments", async (t) => {
  if (!(await pythonAvailable())) {
    t.skip("python3 with cv2/numpy is unavailable");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "attr-gate-fixture-"));
  try {
    await writeFixtures(dir);
    const region = [0.1, 0.1, 0.8, 0.8];
    const report = await auditCandidateAttributes({
      checks: [
        { id: "same-color", type: "hairColorDelta", image: join(dir, "same.png"), reference: join(dir, "base.png"), region },
        { id: "drifted-color", type: "hairColorDelta", image: join(dir, "shifted.png"), reference: join(dir, "base.png"), region },
        { id: "dup", type: "duplicateTakes", images: [join(dir, "base.png"), join(dir, "same.png")], region },
        { id: "distinct", type: "duplicateTakes", images: [join(dir, "tex-a.png"), join(dir, "tex-b.png")], region },
        {
          id: "side-effect", type: "unintendedChange",
          image: join(dir, "uc-changed.png"), base: join(dir, "uc-base.png"),
          allowedRegions: [[0, 0, 0.5, 0.5]], blockSize: 25,
        },
        {
          id: "no-side-effect", type: "unintendedChange",
          image: join(dir, "uc-changed.png"), base: join(dir, "uc-base.png"),
          allowedRegions: [[0.5, 0.5, 0.5, 0.5]], blockSize: 25,
        },
        { id: "ornament", type: "neckOrnament", image: join(dir, "neck-gold.png"), reference: join(dir, "neck-clean.png"), region },
        { id: "ornament-clean", type: "neckOrnament", image: join(dir, "neck-clean.png"), reference: join(dir, "neck-clean.png"), region },
      ],
    });
    const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
    assert.equal(byId["same-color"].status, "pass");
    assert.equal(byId["drifted-color"].status, "fail");
    assert.equal(byId.dup.status, "fail");
    assert.equal(byId.distinct.status, "pass");
    assert.equal(byId["side-effect"].status, "fail");
    assert.equal(byId["no-side-effect"].status, "pass");
    assert.equal(byId.ornament.status, "warn");
    assert.equal(byId["ornament-clean"].status, "pass");
    assert.equal(report.overall, "fail");

    const contract = buildCharacterCandidateQualityContract({ castId: "horo" });
    for (const gate of CHARACTER_ATTRIBUTE_HARD_GATES) assert.ok(contract.hardGates.includes(gate));
    assert.equal(contract.limits.maximumReviewRounds, 3);
    const hardGateReport = attributeHardGateReport(report, contract);
    assert.equal(hardGateReport.contractDigest, contract.digest);
    assert.equal(hardGateReport.pass, false);
    assert.equal(hardGateReport.gates.length, report.checks.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("contract requires castId and freezes gate list", () => {
  assert.throws(() => buildCharacterCandidateQualityContract({}), /castId/);
  const contract = buildCharacterCandidateQualityContract({ castId: "reiji", maximumReviewRounds: 2 });
  assert.equal(contract.episodeId, "character-reiji");
  assert.equal(contract.limits.maximumReviewRounds, 2);
  assert.throws(() => {
    contract.hardGates.push("tamper");
  });
});

test("overrides cannot drop the mandatory attribute gates", () => {
  const contract = buildCharacterCandidateQualityContract({
    castId: "horo",
    overrides: { hardGates: ["only-my-gate"] },
  });
  for (const gate of CHARACTER_ATTRIBUTE_HARD_GATES) assert.ok(contract.hardGates.includes(gate));
  assert.ok(contract.hardGates.includes("only-my-gate"));
});

test("hard-gate report recomputes pass and rejects empty or malformed reports", () => {
  const contract = buildCharacterCandidateQualityContract({ castId: "horo" });
  assert.throws(() => attributeHardGateReport({ overall: "pass", checks: [] }, contract), /at least one/);
  assert.throws(
    () => attributeHardGateReport({ overall: "pass", checks: [{ id: "x", type: "hairColorDelta", status: "maybe" }] }, contract),
    /status/,
  );
  const contradicting = {
    overall: "pass",
    checks: [
      { id: "a", type: "hairColorDelta", status: "pass" },
      { id: "b", type: "duplicateTakes", status: "fail" },
    ],
  };
  const bound = attributeHardGateReport(contradicting, contract);
  assert.equal(bound.pass, false);
  assert.deepEqual(bound.failedGateIds, ["b"]);
});

test("unintendedChange audits edge remainder blocks", async (t) => {
  if (!(await pythonAvailable())) {
    t.skip("python3 with cv2/numpy is unavailable");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "attr-gate-edge-"));
  try {
    const script = `
import cv2, numpy as np
import sys
dir = sys.argv[1]
a = np.full((205, 205, 3), (60, 62, 104), dtype=np.uint8)
cv2.imwrite(f"{dir}/edge-base.png", a)
b = a.copy(); b[:, 200:] = (30, 200, 30)  # 5px right-edge stripe only
cv2.imwrite(f"{dir}/edge-changed.png", b)
print("ok")
`;
    await execFile("python3", ["-c", script, dir]);
    const report = await auditCandidateAttributes({
      checks: [{
        id: "edge", type: "unintendedChange",
        image: join(dir, "edge-changed.png"), base: join(dir, "edge-base.png"),
        allowedRegions: [], blockSize: 50, maxChangedRatio: 0,
      }],
    });
    assert.equal(report.checks[0].status, "fail");
    assert.ok(Object.keys(report.checks[0].inputSha256).length === 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("revision runner refuses escaping or duplicate outputs without generating", async () => {
  const dir = await mkdtemp(join(tmpdir(), "revision-runner-"));
  try {
    const jobs = {
      outputDir: join(dir, "out"),
      manifest: join(dir, "out", "manifest.jsonl"),
      jobs: [
        { out: "../escape.png", prompt: "x" },
        { out: "a.png", refs: "not-an-array", prompt: "x" },
      ],
    };
    const jobsPath = join(dir, "jobs.json");
    await execFile("node", ["-e", `require("fs").writeFileSync(${JSON.stringify(jobsPath)}, ${JSON.stringify(JSON.stringify(jobs))})`]);
    await assert.rejects(
      execFile("node", ["scripts/koya-generate-revision.mjs", "--jobs", jobsPath]),
      (error) => {
        assert.equal(error.code, 2);
        assert.match(error.stderr, /escapes the output directory/);
        assert.match(error.stderr, /job.refs must be an array/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
