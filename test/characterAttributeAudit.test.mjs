import assert from "node:assert/strict";
import test from "node:test";

import {
  assetGateCoverage,
  buildAttributeChecksFromInventory,
} from "../lib/koyaCharacterAttributeAudit.mjs";

const inventory = {
  castId: "horo",
  reference: "/ref.png",
  assets: [
    { id: "front", file: "/front.png", base: "/front-base.png", allowedRegions: [[0, 0, 0.5, 0.5]] },
    { id: "back", file: "/back.png", base: "/back-base.png" },
  ],
};

test("inventory expands into per-asset checks plus one set-wide duplicate check", () => {
  const checks = buildAttributeChecksFromInventory(inventory, "/base");
  const ids = checks.map((check) => check.id);
  assert.ok(ids.includes("front:hairColorDelta"));
  assert.ok(ids.includes("front:unintendedChange"));
  assert.ok(ids.includes("front:neckOrnament"));
  assert.ok(ids.includes("back:hairColorDelta"));
  assert.equal(ids.filter((id) => id === "set:duplicateTakes").length, 1);
  const unintended = checks.find((check) => check.id === "front:unintendedChange");
  assert.deepEqual(unintended.allowedRegions, [[0, 0, 0.5, 0.5]]);
});

test("coverage is per asset: another asset's check cannot satisfy a missing one", () => {
  const partial = {
    checks: [
      { id: "front:hairColorDelta", type: "hairColorDelta", status: "pass" },
      { id: "front:unintendedChange", type: "unintendedChange", status: "pass" },
      { id: "front:neckOrnament", type: "neckOrnament", status: "pass" },
      { id: "set:duplicateTakes", type: "duplicateTakes", status: "pass" },
    ],
  };
  const coverage = assetGateCoverage(inventory, partial);
  assert.equal(coverage.complete, false);
  assert.ok(coverage.missing.some((entry) => entry.startsWith("back:")));

  const full = {
    checks: [
      ...partial.checks,
      { id: "back:hairColorDelta", type: "hairColorDelta", status: "pass" },
      { id: "back:unintendedChange", type: "unintendedChange", status: "pass" },
      { id: "back:neckOrnament", type: "neckOrnament", status: "pass" },
    ],
  };
  assert.equal(assetGateCoverage(inventory, full).complete, true);
});

test("an inventory without a colour reference or base is reported, not skipped", () => {
  const thin = { castId: "reiji", assets: [{ id: "solo", file: "/solo.png" }] };
  const report = {
    checks: [
      { id: "solo:neckOrnament", type: "neckOrnament", status: "pass" },
      { id: "set:duplicateTakes", type: "duplicateTakes", status: "pass" },
    ],
  };
  const coverage = assetGateCoverage(thin, report);
  assert.equal(coverage.complete, false);
  assert.ok(coverage.missing.some((entry) => entry.includes("no reference in inventory")));
  assert.ok(coverage.missing.some((entry) => entry.includes("no base in inventory")));
});
