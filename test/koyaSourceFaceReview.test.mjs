import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { requireArtifacts, requireChannelPack } from "./helpers/requirePrerequisites.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("a hash-bound speaker review overrides an existing wrong-person cascade primary", () => {
  const program = String.raw`
import importlib.util
import json
from pathlib import Path
path = Path("scripts/detect-koya-manga-source-faces.py").resolve()
spec = importlib.util.spec_from_file_location("koya_source_faces", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
automatic = [{"x": 0.1, "y": 0.1, "width": 0.3, "height": 0.4, "area": 1200, "centerDistance": 0.1}]
reviewed = [{"id": "real-speaker", "speakerId": "speaker-1", "bounds": {"x": 0.7, "y": 0.15, "width": 0.2, "height": 0.3}}]
faces, primary, applied = module.merge_manual_faces(automatic, reviewed, "speaker-1", True)
print(json.dumps({"faces": faces, "primary": primary, "applied": sorted(applied)}))
`;
  const result = spawnSync("python3", ["-c", program], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.primary.x, 0.7);
  assert.equal(output.primary.manualReviewId, "real-speaker");
  assert.equal(output.faces[0].manualReviewId, "real-speaker");
  assert.equal(output.faces[1].x, 0.1, "the automatic bystander remains a hard-obstacle candidate");
  assert.deepEqual(output.applied, ["real-speaker"]);
});

test("Arano's long-form source review inventories the missed cut-07-u04 protagonist head", async (t) => {
  if (!requireArtifacts(t, ["config/koya-manga-source-face-reviews"], "原画レビューの棚卸し")) return;
  const review = JSON.parse(await readFile(resolve(
    root,
    "config/koya-manga-source-face-reviews/manga-arano-amane-effort-001.json",
  ), "utf8"));
  const annotation = review.annotations.find((entry) => entry.id === "cut-07-u04-arano-full-head");
  assert.equal(annotation?.utteranceId, "cut-07-u04");
  assert.equal(annotation?.kind, "face");
  assert.equal(annotation?.speakerId, "manga-arano-amane-effort-001-character-2");
  assert.equal(annotation?.imageSha256, "52993cc51af219543452f7aa0c3cce522d6d6000fb0e7262f53a64e54b938c30");
  assert.ok(annotation.bounds.x < 0.5 && annotation.bounds.x + annotation.bounds.width > 0.58);
  assert.match(annotation.note, /305\.25〜307\.25秒/u);
});

test("Arano's reflected and foreground heads are separate hard source-image inventory", async (t) => {
  if (!requireArtifacts(t, ["config/koya-manga-source-face-reviews"], "原画レビューの棚卸し")) return;
  const review = JSON.parse(await readFile(resolve(
    root,
    "config/koya-manga-source-face-reviews/manga-arano-amane-effort-001.json",
  ), "utf8"));
  const faces = review.annotations.filter((entry) => [
    "cut-07-u05-arano-foreground-full-head",
    "cut-07-u05-arano-reflection-full-head",
  ].includes(entry.id));
  assert.equal(faces.length, 2);
  assert.ok(faces.every((entry) => entry.utteranceId === "cut-07-u05"));
  assert.ok(faces.every((entry) => entry.kind === "face"));
  assert.ok(faces.every((entry) => entry.imageSha256 === "e97fcc838987faf267e2a78c9657df1ea4d715544a0010bd950cf917bb04668e"));
  assert.notDeepEqual(faces[0].bounds, faces[1].bounds);
  assert.match(faces[1].note, /324〜328秒/u);
});

test("manual source-face review is image-hash-bound and produces an auditable placement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "koya-source-face-review-"));
  const imagePath = join(directory, "source.ppm");
  const planPath = join(directory, "plan.json");
  const reviewPath = join(directory, "review.json");
  const outputPath = join(directory, "placement.json");
  const header = Buffer.from("P6\n100 100\n255\n");
  const pixels = Buffer.alloc(100 * 100 * 3, 255);
  const image = Buffer.concat([header, pixels]);
  await writeFile(imagePath, image);
  await writeFile(planPath, JSON.stringify({
    manifest: { id: "episode", utterances: [{ id: "u1", speakerId: "speaker-1" }] },
    pages: [{ utteranceId: "u1", cutId: "cut-1", outputPath: imagePath }],
  }));
  await writeFile(reviewPath, JSON.stringify({
    version: "koya-source-face-review-v1",
    episodeId: "episode",
    reviewedBy: "codex:test-reviewer",
    reviewedAt: "2026-08-13T00:00:00.000Z",
    annotations: [{
      utteranceId: "u1",
      speakerId: "speaker-1",
      imageSha256: sha256(image),
      bounds: { x: 0.2, y: 0.1, width: 0.3, height: 0.4 },
      note: "原寸画像で目、鼻、口、顎を含む発話顔を確認した",
    }],
  }));
  const command = [
    "scripts/detect-koya-manga-source-faces.py",
    "--plan", planPath,
    "--output", outputPath,
    "--cascade", "scripts/data/lbpcascade_animeface.xml",
    "--review", reviewPath,
  ];
  const passed = spawnSync("python3", command, { cwd: root, encoding: "utf8" });
  assert.equal(passed.status, 0, passed.stderr);
  const report = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(report.version, "koya-source-region-placement-v3");
  assert.equal(report.pass, true);
  assert.equal(report.rows[0].manualReviewApplied, true);
  assert.equal(report.rows[0].sourceFaceBoundsBySpeakerId["speaker-1"].width, 0.3);
  await writeFile(imagePath, Buffer.concat([image, Buffer.from("changed")]));
  const stale = spawnSync("python3", command, { cwd: root, encoding: "utf8" });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr + stale.stdout, /manual face image digest mismatch/u);
});

test("hash-bound story evidence becomes a hard camera-placement obstacle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "koya-source-evidence-review-"));
  const imagePath = join(directory, "source.ppm");
  const planPath = join(directory, "plan.json");
  const reviewPath = join(directory, "review.json");
  const outputPath = join(directory, "placement.json");
  const image = Buffer.concat([Buffer.from("P6\n100 100\n255\n"), Buffer.alloc(100 * 100 * 3, 255)]);
  await writeFile(imagePath, image);
  await writeFile(planPath, JSON.stringify({
    manifest: { id: "episode", utterances: [{ id: "u1", speakerId: "narration" }] },
    pages: [{ utteranceId: "u1", cutId: "cut-1", outputPath: imagePath }],
  }));
  await writeFile(reviewPath, JSON.stringify({
    version: "koya-source-region-review-v2",
    episodeId: "episode",
    reviewedBy: "codex:test-reviewer",
    reviewedAt: "2026-08-13T00:00:00.000Z",
    annotations: [{
      id: "phone-proof",
      utteranceId: "u1",
      kind: "evidence",
      imageSha256: sha256(image),
      bounds: { x: 0.2, y: 0.25, width: 0.3, height: 0.35 },
      note: "内定を示すスマートフォン画面全体を原寸で確認した",
    }],
  }));
  const passed = spawnSync("python3", [
    "scripts/detect-koya-manga-source-faces.py",
    "--plan", planPath,
    "--output", outputPath,
    "--cascade", "scripts/data/lbpcascade_animeface.xml",
    "--review", reviewPath,
  ], { cwd: root, encoding: "utf8" });
  assert.equal(passed.status, 0, passed.stderr);
  const report = JSON.parse(await readFile(outputPath, "utf8"));
  const evidence = report.rows[0].sourceAvoidRegions.find((region) => region.id === "phone-proof");
  assert.equal(evidence.kind, "evidence");
  assert.equal(evidence.hardProtection, true);
  assert.deepEqual(report.rows[0].manualReviewIds, ["phone-proof"]);
});

test("a flattened split page requires and accepts multiple hash-bound face annotations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "koya-split-face-review-"));
  const imagePath = join(directory, "split-page.ppm");
  const planPath = join(directory, "plan.json");
  const reviewPath = join(directory, "review.json");
  const outputPath = join(directory, "placement.json");
  const image = Buffer.concat([
    Buffer.from("P6\n120 80\n255\n"),
    Buffer.alloc(120 * 80 * 3, 255),
  ]);
  await writeFile(imagePath, image);
  await writeFile(planPath, JSON.stringify({
    manifest: { id: "split-episode", utterances: [{ id: "u1", speakerId: "narration" }] },
    pages: [{
      utteranceId: "u1",
      cutId: "cut-1",
      outputPath: imagePath,
      panelJobIds: ["panel:u1:1", "panel:u1:2"],
    }],
  }));
  const command = [
    "scripts/detect-koya-manga-source-faces.py",
    "--plan", planPath,
    "--output", outputPath,
    "--cascade", "scripts/data/lbpcascade_animeface.xml",
  ];
  const missing = spawnSync("python3", command, { cwd: root, encoding: "utf8" });
  assert.equal(missing.status, 2);
  const missingReport = JSON.parse(await readFile(outputPath, "utf8"));
  assert.ok(missingReport.failures.some((failure) => failure.reason === "split-page-face-inventory-required"));

  await writeFile(reviewPath, JSON.stringify({
    version: "koya-source-face-review-v1",
    episodeId: "split-episode",
    reviewedBy: "codex:test-reviewer",
    reviewedAt: "2026-08-13T00:00:00.000Z",
    annotations: [
      {
        id: "left-face",
        utteranceId: "u1",
        speakerId: "speaker-1",
        imageSha256: sha256(image),
        bounds: { x: 0.08, y: 0.1, width: 0.2, height: 0.3 },
        note: "flatten済み左パネルの人物について髪から顎までを囲った",
      },
      {
        id: "right-face",
        utteranceId: "u1",
        speakerId: "speaker-1",
        imageSha256: sha256(image),
        bounds: { x: 0.7, y: 0.2, width: 0.15, height: 0.25 },
        note: "flatten済み右パネルの人物について髪から顎までを囲った",
      },
    ],
  }));
  const passed = spawnSync("python3", [...command, "--review", reviewPath], { cwd: root, encoding: "utf8" });
  assert.equal(passed.status, 0, passed.stderr);
  const report = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(report.pass, true);
  assert.deepEqual(report.rows[0].manualReviewIds, ["left-face", "right-face"]);
  assert.equal(report.rows[0].sourceAvoidRegions.filter((region) => region.kind === "face").length, 2);
  assert.ok(report.rows[0].sourceAvoidRegions.filter((region) => region.kind === "face").every((region) => region.hardProtection === true));
  assert.equal(report.rows[0].sourceFaceBoundsBySpeakerId["speaker-1"].width, 0.2);
});
