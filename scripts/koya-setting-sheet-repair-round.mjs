#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

import { buildCharacterCandidateQualityContract } from "../lib/characterAttributeGate.mjs";
import {
  createCharacterRepairPlan,
  verifyCharacterRepairPlanDigest,
  verifyRepairPlanCoverage,
} from "../lib/characterRepairPlan.mjs";
import { writeJsonAtomic } from "../lib/canvasScene.mjs";
import {
  buildApprovedIdentityPackRepairJobs,
  effectiveCharacterIdentityCandidate,
  findWorkflowCandidate,
  findWorkflowCast,
  getCharacterWorkflow,
  readCharacterWorkflowStore,
} from "../lib/characterPipeline.mjs";
import {
  buildKoyaIdentityPackJobInput,
  KOYA_IDENTITY_GENERATION_IMPORT_VERSION,
} from "../lib/koyaMangaProduction.mjs";

const PROJECT_DIR = resolve(process.argv[2] || process.cwd());
const ACTION = process.argv[3] || "plan";
const FINDINGS_PATH = resolve(PROJECT_DIR, "canvas/character-reviews/setting-sheet-human-qa-findings-2026-08-30.json");
const CHECKPOINT_PATH = resolve(PROJECT_DIR, "canvas/koya-setting-sheet-checkpoint-2026-08-30-r3.json");
const OUTPUT_DIR = resolve(PROJECT_DIR, "canvas/character-repairs/setting-sheet-human-qa-2026-08-30-r4");
const PLAN_PATH = join(OUTPUT_DIR, "repair-plan.json");
const BASELINE_PATH = join(OUTPUT_DIR, "baseline-manifest.json");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const projectPath = (value) => resolve(PROJECT_DIR, value);

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return output;
}

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonalDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= upDistance && leftDistance <= diagonalDistance ? left : upDistance <= diagonalDistance ? up : upperLeft;
}

function decodeRgbPng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Invalid PNG signature.");
  let offset = 8;
  let width = 0;
  let height = 0;
  const compressed = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 2 || data[12] !== 0) throw new Error("ROI compositor requires 8-bit non-interlaced RGB PNG input.");
    } else if (type === "IDAT") compressed.push(data);
    else if (type === "IEND") break;
    offset += length + 12;
  }
  const bytesPerPixel = 3;
  const stride = width * bytesPerPixel;
  const filtered = inflateSync(Buffer.concat(compressed));
  const pixels = Buffer.alloc(stride * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[sourceOffset++];
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[sourceOffset++];
      const index = y * stride + x;
      const left = x >= bytesPerPixel ? pixels[index - bytesPerPixel] : 0;
      const up = y > 0 ? pixels[index - stride] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel ? pixels[index - stride - bytesPerPixel] : 0;
      if (filter === 0) pixels[index] = raw;
      else if (filter === 1) pixels[index] = (raw + left) & 0xff;
      else if (filter === 2) pixels[index] = (raw + up) & 0xff;
      else if (filter === 3) pixels[index] = (raw + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) pixels[index] = (raw + paeth(left, up, upperLeft)) & 0xff;
      else throw new Error(`Unsupported PNG row filter ${filter}.`);
    }
  }
  return { width, height, pixels };
}

function encodeRgbPng({ width, height, pixels }) {
  const stride = width * 3;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) pixels.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(scanlines, { level: 9 })), pngChunk("IEND", Buffer.alloc(0))]);
}

async function compositeRgbRoi(basePath, generatedPath, outputPath, [x, y, width, height]) {
  const [base, generated] = await Promise.all([readFile(basePath).then(decodeRgbPng), readFile(generatedPath).then(decodeRgbPng)]);
  if (base.width !== generated.width || base.height !== generated.height) throw new Error("ROI composite inputs must have identical dimensions.");
  const pixels = Buffer.from(base.pixels);
  const stride = base.width * 3;
  for (let row = y; row < y + height; row += 1) {
    const start = row * stride + x * 3;
    generated.pixels.copy(pixels, start, start, start + width * 3);
  }
  await writeFile(outputPath, encodeRgbPng({ width: base.width, height: base.height, pixels }));
}

function checkpointAssets(checkpoint) {
  return [
    ...(checkpoint.newConfirmedCast || []).flatMap((cast) => (cast.generatedAssets || []).map((asset) => ({
      ...asset,
      workflowId: cast.workflowId,
      castId: cast.castId,
      castName: cast.name,
      identityReviewPath: cast.identityReviewPath,
      selectedIdentity: cast.selectedIdentity,
      secondaryStageAuthority: cast.secondaryStageAuthority || null,
    }))),
    ...(checkpoint.registeredCastRefresh || []).flatMap((cast) => [
      { ...cast.turnaround, role: "turnaround-8-view", workflowId: cast.workflowId, castId: cast.castId, castName: cast.name,
        identityReviewPath: cast.identityReviewPath, selectedIdentity: null, frozenIdentityFaceSha256: cast.frozenIdentityFaceSha256 },
      { ...cast.expression, role: "expression-12-cell", workflowId: cast.workflowId, castId: cast.castId, castName: cast.name,
        identityReviewPath: cast.identityReviewPath, selectedIdentity: null, frozenIdentityFaceSha256: cast.frozenIdentityFaceSha256 },
    ]),
  ];
}

function repairEntries() {
  const half = 0.5;
  const quarter = 0.25;
  const row3Y = 627 / 941;
  return [
    {
      findingId: "ema-turnaround-duplicate-34-direction",
      cellId: "appare-fixed-cast-character-7:turnaround:row2-col3",
      issue: "Replace only Ema turnaround row2 col3 with the missing right three-quarter head view.",
      repairRegion: [half, half, quarter, half],
      protectRegions: [[0, 0, 1, half], [0, half, half, half], [0.75, half, quarter, half]],
      acceptCriteria: [
        "Row2 col3 shows Ema's right-cheek three-quarter view looking canvas right.",
        "The person-left hairpin is barely visible across the crown part or anatomically hidden.",
        "The sheet background remains pure white.",
      ],
      rejectCriteria: ["Any pixel outside row2 col3 changes.", "The view duplicates row2 col2 or looks canvas left."],
    },
    {
      findingId: "ema-outfit-office-wrong-garment-and-background",
      cellId: "appare-fixed-cast-character-7:outfit:office:all",
      issue: "Regenerate Ema's office outfit sheet from the exact approved garment authority on pure white.",
      repairRegion: [0, 0, 1, 1],
      protectRegions: [],
      acceptCriteria: [
        "The exact garment authority is canvas/assets/appare-revisions/ema-B-officelady.png; no generic garment description is used as authority.",
        "All four views preserve Ema's frozen face, hair, and person-left hairpin.",
        "Every cell has a pure white background with no office scenery.",
      ],
      rejectCriteria: ["Tailored blazer or any redesigned garment appears.", "Any non-white scenery remains."],
    },
    {
      findingId: "ema-outfit-private-background-only",
      cellId: "appare-fixed-cast-character-7:outfit:private-dressy:all",
      issue: "Remove the living-room background from Ema's approved private-dressy outfit sheet.",
      repairRegion: [0, 0, 1, 1],
      protectRegions: [],
      acceptCriteria: ["The clothing matches ema-B-kireime.png.", "All four cells use a pure white background."],
      rejectCriteria: ["Living-room or other scenery remains.", "The approved outfit or identity changes."],
    },
    {
      findingId: "taisho-turnaround-towel-side-swap-profiles",
      cellId: "appare-fixed-cast-2-character-1:turnaround:row1-col2-col3",
      issue: "Redraw only Taisho's two full-body profiles with the one-sided towel on the correct anatomical side.",
      repairRegion: [quarter, 0, half, half],
      protectRegions: [[0, 0, quarter, 1], [0.75, 0, quarter, 1], [quarter, half, half, half]],
      acceptCriteria: [
        "The right-side profile looking canvas right has the towel hanging prominently over the near/front shoulder.",
        "The left-side profile looking canvas left shows only a slight wrap behind the neck.",
        "The expression sheet row2 side views are followed as the exact orientation exemplar.",
        "Two generated takes are inspected and one selected.",
      ],
      rejectCriteria: ["Any pixel outside row1 col2-col3 changes.", "The towel sides are swapped, mirrored, or absent from the right-side view."],
    },
    {
      findingId: "ibuki-turnaround-glasses-missing-profiles",
      cellId: "appare-fixed-cast-character-2:turnaround:row1-col2-col3",
      issue: "Redraw only Ibuki's two full-body profiles with complete thin-rim glasses anatomy.",
      repairRegion: [quarter, 0, half, half],
      protectRegions: [[0, 0, quarter, 1], [0.75, 0, quarter, 1], [quarter, half, half, half]],
      acceptCriteria: ["Both strict profiles show a thin lens rim and a temple arm reaching the ear.", "The background remains pure white."],
      rejectCriteria: ["Any pixel outside row1 col2-col3 changes.", "Either profile lacks the rim or temple arm."],
    },
    {
      findingId: "nodoka-expressions-background-contamination",
      cellId: "appare-fixed-cast-character-3:expression:row3-all",
      issue: "Replace only Nodoka expression-sheet row3 so all four coverage cells have pure white backgrounds.",
      repairRegion: [0, row3Y, 1, 1 - row3Y],
      protectRegions: [[0, 0, 1, row3Y]],
      acceptCriteria: ["All four row3 cells have pure white backgrounds.", "Nodoka remains the same person in all four row3 cells."],
      rejectCriteria: ["Any pixel in rows1-2 changes.", "Hotel or other scenery remains in row3."],
    },
  ];
}

async function main() {
  const [findings, checkpoint, findingsBytes] = await Promise.all([
    readJson(FINDINGS_PATH),
    readJson(CHECKPOINT_PATH),
    readFile(FINDINGS_PATH),
  ]);
  if (findings.version !== "koya-setting-sheet-human-qa-findings-v1" || findings.findings?.length !== 6) {
    throw new Error("The repair round requires exactly the six findings from the 2026-08-30 human-QA file.");
  }
  const assets = checkpointAssets(checkpoint);
  if (assets.length !== 19) throw new Error(`Checkpoint must bind 19 generated sheets; found ${assets.length}.`);
  const verifiedAssets = [];
  for (const asset of assets) {
    const absolutePath = projectPath(asset.path);
    const bytes = await readFile(absolutePath);
    const actual = sha256(bytes);
    if (actual !== asset.sha256) throw new Error(`Checkpoint SHA mismatch: ${asset.path}`);
    verifiedAssets.push({ ...asset, absolutePath, actualSha256: actual });
  }
  const findingPaths = new Set(findings.findings.map((entry) => resolve(projectPath(entry.sheet))));
  const targets = verifiedAssets.filter((asset) => findingPaths.has(resolve(asset.absolutePath)));
  const protectedSheets = verifiedAssets.filter((asset) => !findingPaths.has(resolve(asset.absolutePath)));
  if (targets.length !== 6 || protectedSheets.length !== 13) {
    throw new Error(`Expected 6 repair sheets and 13 untouched generated sheets; got ${targets.length}/${protectedSheets.length}.`);
  }
  const baselineReviews = [];
  for (const cast of [...new Map(targets.map((asset) => [asset.castId, asset])).values()]) {
    const reviewPath = projectPath(cast.identityReviewPath);
    const bytes = await readFile(reviewPath);
    baselineReviews.push({ castId: cast.castId, path: cast.identityReviewPath, sha256: sha256(bytes), review: JSON.parse(bytes) });
  }

  const contract = buildCharacterCandidateQualityContract({
    castId: "setting-sheet-human-qa-findings-2026-08-30-r4",
    maximumReviewRounds: 3,
  });
  const state = {
    contractDigest: contract.digest,
    rounds: [{ index: 1, failureFingerprint: sha256(findingsBytes) }],
  };
  const plan = createCharacterRepairPlan({
    contract,
    state,
    entries: repairEntries(),
    createdAt: new Date().toISOString(),
  });
  const coverage = verifyRepairPlanCoverage(plan, findings.findings);
  const digestCheck = verifyCharacterRepairPlanDigest(plan);
  if (!coverage.complete || !digestCheck.valid) throw new Error("Repair-plan coverage or digest verification failed.");

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeJsonAtomic(PLAN_PATH, plan);
  await writeJsonAtomic(BASELINE_PATH, {
    version: "koya-setting-sheet-repair-baseline-v1",
    createdAt: new Date().toISOString(),
    projectDir: PROJECT_DIR,
    findingsPath: FINDINGS_PATH,
    findingsSha256: sha256(findingsBytes),
    checkpointPath: CHECKPOINT_PATH,
    checkpointSha256: sha256(await readFile(CHECKPOINT_PATH)),
    repairPlanPath: PLAN_PATH,
    repairPlanDigest: plan.digest,
    allGeneratedSheetCount: verifiedAssets.length,
    protectedSheetCount: protectedSheets.length,
    targetSheetCount: targets.length,
    protectedSheets: protectedSheets.map(({ absolutePath, actualSha256, ...asset }) => ({ ...asset, sha256: actualSha256 })),
    targetSheets: targets.map(({ absolutePath, actualSha256, ...asset }) => ({ ...asset, sha256: actualSha256 })),
    baselineReviews,
    registrationForbidden: true,
    humanReviewFieldsMustRemainBlank: true,
  });
  process.stdout.write(`${JSON.stringify({ planPath: PLAN_PATH, baselinePath: BASELINE_PATH, planDigest: plan.digest, coverage }, null, 2)}\n`);
}

async function composeRepairs() {
  const raw = join(OUTPUT_DIR, "raw");
  const composed = join(OUTPUT_DIR, "composed");
  await mkdir(composed, { recursive: true });
  await compositeRgbRoi(
    resolve(PROJECT_DIR, "canvas/assets/characters/appare-fixed-cast/approved-identity-packs/appare-fixed-cast-character-7-turnaround.png"),
    join(raw, "ema-turnaround.png"), join(composed, "ema-turnaround.png"), [836, 470, 418, 471],
  );
  await copyFile(join(raw, "ema-outfit-office.png"), join(composed, "ema-outfit-office.png"));
  await copyFile(join(raw, "ema-outfit-private-dressy.png"), join(composed, "ema-outfit-private-dressy.png"));
  await compositeRgbRoi(
    resolve(PROJECT_DIR, "canvas/assets/characters/appare-fixed-cast-2/approved-identity-packs/appare-fixed-cast-2-character-1-turnaround-refresh-new-standard-20260830-r2-tool-import.png"),
    join(raw, "taisho-turnaround-take1.png"), join(composed, "taisho-turnaround.png"), [418, 0, 836, 470],
  );
  await compositeRgbRoi(
    resolve(PROJECT_DIR, "canvas/assets/characters/appare-fixed-cast/approved-identity-packs/appare-fixed-cast-character-2-turnaround-refresh-new-standard-20260830-r2-tool-import.png"),
    join(raw, "ibuki-turnaround.png"), join(composed, "ibuki-turnaround.png"), [418, 0, 836, 470],
  );
  await compositeRgbRoi(
    resolve(PROJECT_DIR, "canvas/assets/characters/appare-fixed-cast/approved-identity-packs/appare-fixed-cast-character-3-expressions-refresh-new-standard-20260830-r2-tool-import.png"),
    join(raw, "nodoka-expressions.png"), join(composed, "nodoka-expressions.png"), [0, 627, 1672, 314],
  );
  const outputs = await Promise.all(["ema-turnaround.png", "ema-outfit-office.png", "ema-outfit-private-dressy.png", "taisho-turnaround.png", "ibuki-turnaround.png", "nodoka-expressions.png"]
    .map(async (name) => ({ name, path: join(composed, name), sha256: sha256(await readFile(join(composed, name))) })));
  process.stdout.write(`${JSON.stringify(outputs, null, 2)}\n`);
}

async function createImportMaps() {
  const [findings, repairPlan, workflowStore] = await Promise.all([
    readJson(FINDINGS_PATH),
    readJson(PLAN_PATH),
    readCharacterWorkflowStore({ projectDir: PROJECT_DIR }),
  ]);
  const generator = {
    host: "codex",
    id: "codex-imagegen-tool",
    contextId: "codex-setting-sheet-repair-20260830-r4",
  };
  const sourceByCastRole = {
    "appare-fixed-cast-character-7": {
      turnaround: join(OUTPUT_DIR, "composed/ema-turnaround.png"),
      "outfit:office": join(OUTPUT_DIR, "composed/ema-outfit-office.png"),
      "outfit:private-dressy": join(OUTPUT_DIR, "composed/ema-outfit-private-dressy.png"),
    },
    "appare-fixed-cast-character-2": { turnaround: join(OUTPUT_DIR, "composed/ibuki-turnaround.png") },
    "appare-fixed-cast-character-3": { expression: join(OUTPUT_DIR, "composed/nodoka-expressions.png") },
    "appare-fixed-cast-2-character-1": { turnaround: join(OUTPUT_DIR, "composed/taisho-turnaround.png") },
  };
  const targets = [
    { episodeId: "appare-fixed-cast", workflowId: "workflow-mt5hucll-8d4ec683", castId: "appare-fixed-cast-character-7", repairId: "human-qa-20260830-r4b-ema" },
    { episodeId: "appare-fixed-cast", workflowId: "workflow-mt5hucll-8d4ec683", castId: "appare-fixed-cast-character-2", repairId: "human-qa-20260830-r4b-ibuki" },
    { episodeId: "appare-fixed-cast", workflowId: "workflow-mt5hucll-8d4ec683", castId: "appare-fixed-cast-character-3", repairId: "human-qa-20260830-r4b-nodoka" },
    { episodeId: "appare-fixed-cast-2", workflowId: "workflow-mt5o5z4j-d592f6d6", castId: "appare-fixed-cast-2-character-1", repairId: "human-qa-20260830-r4b-taisho" },
  ];
  const results = [];
  for (const target of targets) {
    const workflow = getCharacterWorkflow(workflowStore, target.workflowId);
    const cast = findWorkflowCast(workflow, target.castId);
    const baseCandidate = findWorkflowCandidate(cast, cast.selectedCandidateId);
    const identityCandidate = effectiveCharacterIdentityCandidate(cast, baseCandidate);
    const roleAssets = [
      { role: "turnaround", path: cast.identityPack.turnaround.assetFile },
      { role: "expression", path: cast.identityPack.expression.assetFile },
      ...(cast.identityPack.outfitSheets || []).map((asset) => ({ role: `outfit:${asset.storyStage}`, path: asset.assetFile })),
    ];
    const relevantFindings = findings.findings.flatMap((finding) => {
      const findingStem = basename(finding.sheet, ".png");
      const inferredRole = findingStem.includes("-outfit-")
        ? `outfit:${findingStem.split("-outfit-")[1]}`
        : findingStem.includes("-expressions") ? "expression"
          : findingStem.includes("-turnaround") ? "turnaround" : "";
      const roleAsset = roleAssets.find((asset) => resolve(asset.path) === resolve(PROJECT_DIR, finding.sheet)
        || (findingStem.startsWith(`${target.castId}-`) && asset.role === inferredRole));
      return roleAsset ? [{ ...finding, role: roleAsset.role }] : [];
    });
    const failedRoles = [...new Set(relevantFindings.map((entry) => entry.role))];
    const jobs = buildApprovedIdentityPackRepairJobs(workflow, cast, identityCandidate, failedRoles, {
      repairId: target.repairId,
      repairFindings: relevantFindings,
      repairPlan,
      strictOutfitAuthorityStages: relevantFindings
        .filter((entry) => entry.findingId === "ema-outfit-office-wrong-garment-and-background")
        .map(() => "office"),
    });
    const candidateSha256 = sha256(await readFile(identityCandidate.assetFile));
    const generationScopeId = `repair:${target.repairId}:${repairPlan.digest.slice(0, 16)}`;
    const entries = [];
    for (const job of jobs) {
      const key = `${job.pipeline.identityRole}:${job.pipeline.storyStage || ""}`;
      const roleKey = job.pipeline.identityRole === "outfit" ? `outfit:${job.pipeline.storyStage}` : job.pipeline.identityRole;
      const sourceFile = sourceByCastRole[target.castId]?.[roleKey];
      if (!sourceFile) throw new Error(`No composed source mapped for ${target.castId}/${roleKey}.`);
      const sourceSha256 = sha256(await readFile(sourceFile));
      const { inputSha256 } = await buildKoyaIdentityPackJobInput({
        workflowId: target.workflowId,
        castId: target.castId,
        candidateSha256,
        generator,
        job,
        fileName: job.fileName,
      });
      entries.push({ key, sourceFile, sourceSha256, inputSha256 });
    }
    const importMap = {
      version: KOYA_IDENTITY_GENERATION_IMPORT_VERSION,
      workflowId: target.workflowId,
      castId: target.castId,
      candidateSha256,
      generator,
      generationScopeId,
      repairPlanDigest: repairPlan.digest,
      findingIds: relevantFindings.map((entry) => entry.findingId),
      entries,
    };
    const importMapPath = join(OUTPUT_DIR, "imports", target.castId, "import-map.json");
    await mkdir(join(OUTPUT_DIR, "imports", target.castId), { recursive: true });
    await writeJsonAtomic(importMapPath, importMap);
    results.push({ ...target, importMapPath, generationScopeId, failedRoles, entries });
  }
  await writeJsonAtomic(join(OUTPUT_DIR, "generation-selection.json"), {
    version: "koya-setting-sheet-repair-generation-selection-v1",
    repairPlanDigest: repairPlan.digest,
    whiteBackgroundRequiredForAllSubsequentSheets: true,
    taisho: {
      generatedTakeCount: 2,
      selectedTake: "take1",
      selectedPath: join(OUTPUT_DIR, "raw/taisho-turnaround-take1.png"),
      selectedSha256: sha256(await readFile(join(OUTPUT_DIR, "raw/taisho-turnaround-take1.png"))),
      rejectedTake: "take2",
      rejectedPath: join(OUTPUT_DIR, "raw/taisho-turnaround-take2.png"),
      rejectedSha256: sha256(await readFile(join(OUTPUT_DIR, "raw/taisho-turnaround-take2.png"))),
      selectionReason: "Take 1 preserves the slight rear-neck towel wrap in the left-facing profile while showing the front-hanging towel in the right-facing profile; take 2 removes the rear wrap entirely.",
    },
    imports: results.map((entry) => ({ castId: entry.castId, importMapPath: entry.importMapPath })),
  });
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

async function prepareQaInventories() {
  const [findings, repairPlan, workflowStore] = await Promise.all([
    readJson(FINDINGS_PATH),
    readJson(PLAN_PATH),
    readCharacterWorkflowStore({ projectDir: PROJECT_DIR }),
  ]);
  const castById = new Map(workflowStore.workflows.flatMap((workflow) =>
    (workflow.cast || []).map((cast) => [cast.id, cast])));
  const rows = [];
  for (const finding of findings.findings) {
    const planEntry = repairPlan.entries.find((entry) => entry.findingId === finding.findingId);
    const castId = planEntry.cellId.split(":")[0];
    const cast = castById.get(castId);
    const role = planEntry.cellId.includes(":outfit:office") ? "outfit:office"
      : planEntry.cellId.includes(":outfit:private-dressy") ? "outfit:private-dressy"
        : planEntry.cellId.includes(":expression:") ? "expression" : "turnaround";
    const finalFile = role === "turnaround" ? cast.identityPack.turnaround.assetFile
      : role === "expression" ? cast.identityPack.expression.assetFile
        : cast.identityPack.outfitSheets.find((entry) => `outfit:${entry.storyStage}` === role)?.assetFile;
    if (!finalFile) throw new Error(`No staged repaired file for ${finding.findingId}.`);
    const inventoryPath = join(OUTPUT_DIR, "qa", finding.findingId, "attribute-inventory.json");
    const outputPath = join(OUTPUT_DIR, "qa", finding.findingId, "attribute-gate.json");
    await mkdir(join(OUTPUT_DIR, "qa", finding.findingId), { recursive: true });
    await writeJsonAtomic(inventoryPath, {
      castId: `${castId}:${finding.findingId}`,
      reference: resolve(PROJECT_DIR, finding.sheet),
      assets: [{
        id: finding.findingId,
        file: finalFile,
        base: resolve(PROJECT_DIR, finding.sheet),
        allowedRegions: [planEntry.repairRegion],
        cleanReference: resolve(PROJECT_DIR, finding.sheet),
        requireWhiteBackground: true,
        whiteBackgroundRegion: planEntry.repairRegion,
        minimumWhiteRatio: 0.88,
        whiteThreshold: 245,
      }],
      humanGates: [],
      repairPlanDigest: repairPlan.digest,
      findingId: finding.findingId,
    });
    rows.push({ findingId: finding.findingId, castId, role, baseFile: resolve(PROJECT_DIR, finding.sheet), finalFile, inventoryPath, outputPath });
  }
  const qaPlanPath = join(OUTPUT_DIR, "qa", "qa-plan.json");
  await mkdir(join(OUTPUT_DIR, "qa"), { recursive: true });
  await writeJsonAtomic(qaPlanPath, { version: "koya-setting-sheet-repair-qa-plan-v1", repairPlanDigest: repairPlan.digest, rows });
  process.stdout.write(`${JSON.stringify({ qaPlanPath, rows }, null, 2)}\n`);
}

function reviewCellMap(review) {
  return new Map([
    ...(review.turnaround?.viewChecks || []).map((cell) => [`turnaround:${cell.id}`, cell]),
    ...(review.expression?.cells || []).map((cell) => [`expression:${cell.id}`, cell]),
    ...(review.outfitSheets || []).flatMap((sheet) =>
      (sheet.cells || []).map((cell) => [`outfit:${sheet.storyStage}:${cell.id}`, cell])),
    ...(review.extraSheets || []).flatMap((sheet) =>
      (sheet.cells || []).map((cell) => [`${sheet.role}:${cell.id}`, cell])),
  ]);
}

function protectedCellKeys(castId) {
  const turn = ["front-full-body", "left-profile-full-body", "right-profile-full-body", "back-full-body", "front-head", "left-three-quarter-head", "right-three-quarter-head", "top-head"];
  const expression = Array.from({ length: 12 }, (_, index) => `r${Math.floor(index / 4) + 1}c${(index % 4) + 1}`);
  if (castId === "appare-fixed-cast-character-7") {
    return [...turn.filter((id) => id !== "right-three-quarter-head").map((id) => `turnaround:${id}`), ...expression.map((id) => `expression:${id}`)];
  }
  if (["appare-fixed-cast-character-2", "appare-fixed-cast-2-character-1"].includes(castId)) {
    return [
      ...turn.filter((id) => !["left-profile-full-body", "right-profile-full-body"].includes(id)).map((id) => `turnaround:${id}`),
      ...expression.map((id) => `expression:${id}`),
    ];
  }
  if (castId === "appare-fixed-cast-character-3") {
    return [...turn.map((id) => `turnaround:${id}`), ...expression.slice(0, 8).map((id) => `expression:${id}`)];
  }
  return [];
}

async function finalizeQa() {
  const [baseline, qaPlan, repairPlan, workflowStore, checkpoint] = await Promise.all([
    readJson(BASELINE_PATH),
    readJson(join(OUTPUT_DIR, "qa/qa-plan.json")),
    readJson(PLAN_PATH),
    readCharacterWorkflowStore({ projectDir: PROJECT_DIR }),
    readJson(CHECKPOINT_PATH),
  ]);
  const protectedSheetChecks = [];
  for (const sheet of baseline.protectedSheets) {
    const actualSha256 = sha256(await readFile(resolve(PROJECT_DIR, sheet.path)));
    protectedSheetChecks.push({ path: sheet.path, expectedSha256: sheet.sha256, actualSha256, pass: actualSha256 === sheet.sha256 });
  }
  const registryPath = resolve(PROJECT_DIR, checkpoint.registeredFaceFreeze.registryPath);
  const registrySha256 = sha256(await readFile(registryPath));
  const workflowCasts = new Map(workflowStore.workflows.flatMap((workflow) => (workflow.cast || []).map((cast) => [cast.id, cast])));
  const importChecks = [];
  for (const row of qaPlan.rows) {
    const importMap = await readJson(join(OUTPUT_DIR, "imports", row.castId, "import-map.json"));
    const key = row.role.startsWith("outfit:") ? row.role : `${row.role}:`;
    const imported = importMap.entries.find((entry) => entry.key === key);
    const finalSha256 = sha256(await readFile(row.finalFile));
    importChecks.push({
      findingId: row.findingId,
      role: row.role,
      finalFile: row.finalFile,
      finalSha256,
      importedSourceSha256: imported?.sourceSha256 || "",
      inputSha256: imported?.inputSha256 || "",
      pass: Boolean(imported?.inputSha256) && finalSha256 === imported?.sourceSha256,
    });
  }
  const reviewChecks = [];
  const protectedCellChecks = [];
  let extractedCellCount = 0;
  for (const baselineReview of baseline.baselineReviews) {
    const cast = workflowCasts.get(baselineReview.castId);
    const reviewPath = resolve(PROJECT_DIR, baselineReview.path);
    const review = await readJson(reviewPath);
    const reviewerBlank = ["host", "id", "contextId", "reviewedAt"].every((key) => !String(review.reviewer?.[key] || "").trim());
    const parents = [
      review.selectedFace,
      review.turnaround,
      review.expression,
      ...(review.outfitSheets || []),
      ...(review.extraSheets || []),
    ].filter((entry) => entry?.path);
    const parentChecks = [];
    for (const parent of parents) {
      const actualSha256 = sha256(await readFile(parent.path));
      parentChecks.push({ path: parent.path, declaredSha256: parent.sha256, actualSha256, pass: actualSha256 === parent.sha256 });
    }
    const currentCells = reviewCellMap(review);
    const cellChecks = [];
    for (const [key, cell] of currentCells) {
      const actualSha256 = sha256(await readFile(cell.path));
      cellChecks.push({ key, path: cell.path, declaredSha256: cell.sha256, actualSha256, pass: actualSha256 === cell.sha256 });
      extractedCellCount += 1;
    }
    const baselineCells = reviewCellMap(baselineReview.review);
    for (const key of protectedCellKeys(baselineReview.castId)) {
      const before = baselineCells.get(key);
      const after = currentCells.get(key);
      protectedCellChecks.push({
        castId: baselineReview.castId,
        key,
        beforeSha256: before?.sha256 || "",
        afterSha256: after?.sha256 || "",
        pass: Boolean(before?.sha256) && before.sha256 === after?.sha256,
      });
    }
    reviewChecks.push({
      castId: baselineReview.castId,
      reviewPath,
      stagedStatus: cast?.status || "",
      reviewerBlank,
      originalScaleInspected: review.originalScaleInspected,
      reviewPass: review.pass,
      parentChecks,
      cellChecks,
      pass: reviewerBlank && review.originalScaleInspected === false && review.pass === false
        && parentChecks.every((entry) => entry.pass) && cellChecks.every((entry) => entry.pass),
    });
  }
  const attributeChecks = [];
  for (const row of qaPlan.rows) {
    const decision = await readJson(row.outputPath);
    const unintended = decision.report.checks.find((entry) => entry.type === "unintendedChange");
    const white = decision.report.checks.find((entry) => entry.type === "whiteBackground");
    attributeChecks.push({
      findingId: row.findingId,
      path: row.outputPath,
      machinePass: decision.machinePass,
      overallPass: decision.pass,
      missingHumanGates: decision.missingHumanGates,
      unintendedChangedBlocks: unintended?.changedBlocks,
      unintendedChangedRatio: unintended?.changedRatio,
      whiteRatio: white?.whiteRatio,
      pass: decision.machinePass === true && decision.pass === false
        && decision.failedCheckIds.length === 0 && decision.missingCoverage.length === 0
        && decision.missingHumanGates.includes("attribute-eye-side-fullview-human")
        && unintended?.changedBlocks === 0 && white?.status === "pass",
    });
  }
  const pass = protectedSheetChecks.every((entry) => entry.pass)
    && registrySha256 === checkpoint.registeredFaceFreeze.registrySha256
    && importChecks.every((entry) => entry.pass)
    && reviewChecks.every((entry) => entry.pass)
    && protectedCellChecks.every((entry) => entry.pass)
    && attributeChecks.every((entry) => entry.pass)
    && extractedCellCount === 88;
  const report = {
    version: "koya-setting-sheet-repair-machine-qa-v1",
    status: pass ? "machine-pass-awaiting-human-original-scale-attestation" : "machine-fail",
    createdAt: new Date().toISOString(),
    repairPlanPath: PLAN_PATH,
    repairPlanSha256: sha256(await readFile(PLAN_PATH)),
    repairPlanDigest: repairPlan.digest,
    findingCount: qaPlan.rows.length,
    repairedSheetCount: importChecks.length,
    protectedSheetCount: protectedSheetChecks.length,
    protectedSheetChecks,
    registryFreeze: {
      path: registryPath,
      expectedSha256: checkpoint.registeredFaceFreeze.registrySha256,
      actualSha256: registrySha256,
      pass: registrySha256 === checkpoint.registeredFaceFreeze.registrySha256,
    },
    importChecks,
    reviewChecks,
    extractedCellCount,
    protectedCellCount: protectedCellChecks.length,
    protectedCellChecks,
    attributeChecks,
    reviewerFieldsRemainEmpty: reviewChecks.every((entry) => entry.reviewerBlank),
    originalScaleInspectedRemainsFalse: reviewChecks.every((entry) => entry.originalScaleInspected === false),
    humanAttributeGatePending: true,
    characterRegisterPerformed: false,
    pass,
  };
  const reportPath = join(OUTPUT_DIR, "machine-qa.json");
  await writeJsonAtomic(reportPath, report);
  process.stdout.write(`${JSON.stringify({ reportPath, pass, extractedCellCount, protectedCellCount: protectedCellChecks.length }, null, 2)}\n`);
  if (!pass) process.exitCode = 3;
}

async function writeCheckpoint() {
  const [machineQa, qaPlan, generationSelection] = await Promise.all([
    readJson(join(OUTPUT_DIR, "machine-qa.json")),
    readJson(join(OUTPUT_DIR, "qa/qa-plan.json")),
    readJson(join(OUTPUT_DIR, "generation-selection.json")),
  ]);
  if (machineQa.pass !== true) throw new Error("Cannot checkpoint a repair round before machine QA passes.");
  const recheckByFinding = {
    "ema-turnaround-duplicate-34-direction": ["row2 col3: 右3/4（本人右頬側）で、row2 col2の左向き複製でないこと", "本人左側頭部の髪留めが分け目越しに僅かに見えるか、解剖学的に隠れること"],
    "ema-outfit-office-wrong-garment-and-background": ["4セル全て: ema-B-officelady.png と同じ承認衣装で、ブレザー化していないこと", "全セル純白背景、同一人物、髪留めが本人左側頭部であること"],
    "ema-outfit-private-background-only": ["4セル全て: ema-B-kireime.png の衣装内容を維持していること", "リビング等の背景がなく全セル純白であること"],
    "taisho-turnaround-towel-side-swap-profiles": ["row1 col2: 鼻が左、タオルは首後ろへ僅かに回り込むだけであること", "row1 col3: 鼻が右、本人右肩のタオルが近位肩から胸前へ明確に垂れること"],
    "ibuki-turnaround-glasses-missing-profiles": ["row1 col2・col3: 両方の厳密横顔に細いレンズ縁があること", "両セルでつるがこめかみから耳まで連続して見えること"],
    "nodoka-expressions-background-contamination": ["row3 col1〜col4: ホテル内装等がなく全て純白背景であること", "row3の4人が同一のノドカで、髪・アホ毛・たれ目・衣装が連続すること"],
  };
  const repairedSheets = machineQa.importChecks.map((entry) => ({
    findingId: entry.findingId,
    role: entry.role,
    path: entry.finalFile,
    sha256: entry.finalSha256,
    inputSha256: entry.inputSha256,
    machineAttributeGatePath: machineQa.attributeChecks.find((check) => check.findingId === entry.findingId)?.path || "",
    humanRecheck: recheckByFinding[entry.findingId],
  }));
  const checkpoint = {
    version: "koya-setting-sheet-repair-checkpoint-v1",
    createdAt: new Date().toISOString(),
    projectDir: PROJECT_DIR,
    predecessor: CHECKPOINT_PATH,
    status: "stopped-after-six-repairs-and-machine-qa-awaiting-human-original-scale-attestation",
    stopReason: "指定された6 findingの生成・SHA拘束import・機械QAが完了したため。人間の原寸再確認前に停止する。",
    sourceAuthority: {
      findingsPath: FINDINGS_PATH,
      findingsSha256: machineQa.reviewChecks[0]
        ? sha256(await readFile(FINDINGS_PATH)) : "",
      repairPlanPath: PLAN_PATH,
      repairPlanSha256: machineQa.repairPlanSha256,
      repairPlanDigest: machineQa.repairPlanDigest,
      findingCount: 6,
    },
    generation: {
      generator: { host: "codex", id: "codex-imagegen-tool", contextId: "codex-setting-sheet-repair-20260830-r4" },
      generatedFindingCount: 6,
      generatedImageCount: 7,
      taishoTakeCount: generationSelection.taisho.generatedTakeCount,
      taishoSelectedTake: generationSelection.taisho.selectedTake,
      taishoSelectionEvidencePath: join(OUTPUT_DIR, "generation-selection.json"),
      allSubsequentSettingSheetPromptsRequirePureWhiteBackground: true,
    },
    repairedSheets,
    machineQa: {
      reportPath: join(OUTPUT_DIR, "machine-qa.json"),
      reportSha256: sha256(await readFile(join(OUTPUT_DIR, "machine-qa.json"))),
      pass: true,
      shaBoundImportCount: machineQa.importChecks.length,
      extractedCellCount: machineQa.extractedCellCount,
      protectedCellCount: machineQa.protectedCellCount,
      protectedCellMismatchCount: machineQa.protectedCellChecks.filter((entry) => !entry.pass).length,
      protectedSheetCount: machineQa.protectedSheetCount,
      protectedSheetMismatchCount: machineQa.protectedSheetChecks.filter((entry) => !entry.pass).length,
      attributeMachinePassCount: machineQa.attributeChecks.filter((entry) => entry.machinePass).length,
      attributeMachineFailCount: machineQa.attributeChecks.filter((entry) => !entry.machinePass).length,
      registryShaUnchanged: machineQa.registryFreeze.pass,
    },
    humanReview: {
      reviewPaths: machineQa.reviewChecks.map((entry) => entry.reviewPath),
      reviewerFieldsRemainEmpty: machineQa.reviewerFieldsRemainEmpty,
      originalScaleInspectedRemainsFalse: machineQa.originalScaleInspectedRemainsFalse,
      reviewPassRemainsFalse: true,
      pendingCells: repairedSheets.map((entry) => ({ findingId: entry.findingId, path: entry.path, cells: entry.humanRecheck })),
    },
    tests: {
      command: "node --test test/characterPipeline.test.mjs test/koyaMangaProduction.test.mjs test/koyaMcpAdapter.test.mjs test/codexImageBridge.test.mjs test/harnessLearn.test.mjs",
      passed: 63,
      failed: 0,
    },
    selfImprovement: {
      proposalId: "9073182988e0",
      status: "captured-and-review-dry-run-only",
      notSelfApplied: true,
    },
    explicitlyNotPerformed: [
      "人間reviewer名の記入",
      "originalScaleInspected/passの記入",
      "character-register",
      "registry turnaround/expression差し替え",
      "identity-face再生成または再承認",
      "対象外13シートまたは71保護セルの変更",
    ],
    resumeAfterHumanReview: [
      "上記pendingCellsを原寸で再確認する",
      "正式reviewer情報とboolean/noteを各identity-pack-review.jsonへ記録する",
      "fresh machine recheckを通した後だけcharacter-registerを1人ずつ直列実行する",
    ],
  };
  const checkpointPath = resolve(PROJECT_DIR, "canvas/koya-setting-sheet-checkpoint-2026-08-31-r4.json");
  await writeJsonAtomic(checkpointPath, checkpoint);
  process.stdout.write(`${JSON.stringify({ checkpointPath, repairedSheets: repairedSheets.map((entry) => ({ findingId: entry.findingId, path: entry.path })) }, null, 2)}\n`);
}

if (ACTION === "plan") await main();
else if (ACTION === "compose") await composeRepairs();
else if (ACTION === "import-maps") await createImportMaps();
else if (ACTION === "qa-prepare") await prepareQaInventories();
else if (ACTION === "qa-finalize") await finalizeQa();
else if (ACTION === "checkpoint") await writeCheckpoint();
else throw new Error(`Unknown action: ${ACTION}`);
