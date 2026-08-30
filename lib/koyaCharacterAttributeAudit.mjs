// Official entry point for the character-sheet attribute gates (ledger R192,
// R196): builds the mandatory check set from an asset inventory, runs the
// deterministic gates, verifies that every mandatory gate ran FOR EVERY ASSET,
// and writes a contract-bound report. The CLI action `character-attribute-gate`
// is the only supported way to satisfy the gate before the setting-sheet stage.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  CHARACTER_ATTRIBUTE_HARD_GATES,
  GATE_ID_TO_CHECK_TYPE,
  auditCandidateAttributes,
  buildCharacterCandidateQualityContract,
} from "./characterAttributeGate.mjs";

function absolutize(baseDir, value) {
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

/**
 * Inventory JSON:
 * {"castId": "horo",
 *  "reference": "canvas/assets/....png",          // approved colour/base reference
 *  "assets": [{"id": "turnaround-front", "file": "...png",
 *              "base": "...png",                   // pre-revision image for unintendedChange
 *              "allowedRegions": [[x,y,w,h]],
 *              "cleanReference": "...png"}],       // ornament-free reference
 *  "humanGates": [{"id": "attribute-eye-side-fullview-human", "status": "pass", "reviewer": "name"}]}
 */
export function buildAttributeChecksFromInventory(inventory, baseDir) {
  const assets = Array.isArray(inventory.assets) ? inventory.assets : [];
  if (assets.length === 0) throw new Error("inventory.assets must not be empty");
  const reference = inventory.reference ? absolutize(baseDir, inventory.reference) : "";
  const checks = [];
  for (const asset of assets) {
    const id = String(asset.id || "").trim();
    if (!id) throw new Error("every inventory asset needs an id");
    const file = absolutize(baseDir, asset.file);
    if (reference) {
      checks.push({ id: `${id}:hairColorDelta`, type: "hairColorDelta", image: file, reference });
    }
    if (asset.base) {
      checks.push({
        id: `${id}:unintendedChange`,
        type: "unintendedChange",
        image: file,
        base: absolutize(baseDir, asset.base),
        allowedRegions: asset.allowedRegions ?? [],
      });
    }
    // 金装飾の検出は「装飾のない同キャラ画像との相対比較」で初めて意味を持つ。
    // cleanReference が無いまま単独閾値で走らせると、明色地では装飾を見逃した
    // まま被覆だけが満たされる。参照が無いなら実行済みにせず、欠落として扱う。
    if (asset.cleanReference) {
      checks.push({
        id: `${id}:neckOrnament`,
        type: "neckOrnament",
        image: file,
        reference: absolutize(baseDir, asset.cleanReference),
      });
    }
  }
  // One duplicate-takes check spans the whole set: near-identical options are
  // a property of the SET, not of a single asset (ledger R190). The check is
  // emitted even for a single-asset set — coverage requires every hard gate to
  // have RUN, and a set of one has zero pairs so the executed check passes
  // vacuously instead of leaving an unsatisfiable coverage hole.
  checks.push({
    id: "set:duplicateTakes",
    type: "duplicateTakes",
    images: assets.map((asset) => absolutize(baseDir, asset.file)),
  });
  return checks;
}

/** Per-asset coverage: every mandatory machine gate must have run for each asset. */
export function assetGateCoverage(inventory, report) {
  const executed = new Map();
  for (const check of report.checks ?? []) {
    const [assetId] = String(check.id || "").split(":");
    if (!executed.has(assetId)) executed.set(assetId, new Set());
    executed.get(assetId).add(check.type);
  }
  const setTypes = executed.get("set") ?? new Set();
  const missing = [];
  for (const asset of inventory.assets ?? []) {
    const types = executed.get(asset.id) ?? new Set();
    for (const gateId of CHARACTER_ATTRIBUTE_HARD_GATES) {
      const requiredType = GATE_ID_TO_CHECK_TYPE[gateId];
      if (requiredType === "human") continue;
      if (requiredType === "duplicateTakes") {
        if (!setTypes.has(requiredType)) missing.push(`set:${gateId}`);
        continue;
      }
      // hairColorDelta only applies when a colour reference exists; the
      // inventory must say so explicitly rather than silently skipping it.
      if (requiredType === "hairColorDelta" && !inventory.reference) {
        missing.push(`${asset.id}:${gateId} (no reference in inventory)`);
        continue;
      }
      if (requiredType === "unintendedChange" && !asset.base) {
        missing.push(`${asset.id}:${gateId} (no base in inventory)`);
        continue;
      }
      if (!types.has(requiredType)) missing.push(`${asset.id}:${gateId}`);
    }
  }
  return { complete: missing.length === 0, missing: [...new Set(missing)] };
}

export async function runKoyaCharacterAttributeGate(options = {}) {
  const inventoryPath = resolve(options.inventoryPath || "");
  if (!options.inventoryPath) throw new Error("--inventory-path is required");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const baseDir = options.projectDir ? resolve(options.projectDir) : dirname(inventoryPath);
  const castId = String(inventory.castId || options.castId || "").trim();
  if (!castId) throw new Error("inventory.castId is required");

  const contract = buildCharacterCandidateQualityContract({ castId });
  const checks = buildAttributeChecksFromInventory(inventory, baseDir);
  const report = await auditCandidateAttributes({ checks, cwd: baseDir });
  const coverage = assetGateCoverage(inventory, report);
  const humanGates = inventory.humanGates ?? [];
  // R196: 人手ゲートは「誰が見たか」まで含めて初めてアテステーションになる。
  // status だけを見ると、reviewer 欄が空のまま目の左右ゲートを通せてしまう。
  const invalidHumanGates = humanGates
    .filter((gate) => gate.status === "pass")
    .filter((gate) => typeof gate.reviewer !== "string" || gate.reviewer.trim() === "")
    .map((gate) => gate.id);
  const attestedHuman = new Set(
    humanGates
      .filter((gate) => gate.status === "pass")
      .filter((gate) => typeof gate.reviewer === "string" && gate.reviewer.trim() !== "")
      .map((gate) => gate.id),
  );
  const missingHuman = CHARACTER_ATTRIBUTE_HARD_GATES
    .filter((gateId) => GATE_ID_TO_CHECK_TYPE[gateId] === "human")
    .filter((gateId) => !attestedHuman.has(gateId));
  const failed = (report.checks ?? []).filter((check) => check.status === "fail").map((check) => check.id);
  if (invalidHumanGates.length > 0) {
    throw new Error(
      `humanGates に reviewer がありません: ${invalidHumanGates.join(", ")}。`
      + "誰が目視したかを記録しないアテステーションは証跡になりません（R196）。",
    );
  }

  const decision = {
    version: "koya-character-attribute-gate-v1",
    castId,
    contractDigest: contract.digest,
    inventoryPath,
    inventorySha256: createHash("sha256").update(await readFile(inventoryPath)).digest("hex"),
    pass: failed.length === 0 && coverage.complete && missingHuman.length === 0,
    failedCheckIds: failed,
    missingCoverage: coverage.missing,
    missingHumanGates: missingHuman,
    humanGates,
    report,
    decidedAt: new Date().toISOString(),
  };
  const outputPath = options.outputPath
    ? resolve(options.outputPath)
    : resolve(dirname(inventoryPath), `${castId}-attribute-gate.json`);
  await writeFile(outputPath, `${JSON.stringify(decision, null, 1)}\n`);
  return { decision, outputPath };
}
