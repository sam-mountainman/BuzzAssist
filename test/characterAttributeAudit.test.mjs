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
    { id: "back", file: "/back.png", base: "/back-base.png", cleanReference: "/back-clean.png" },
  ],
};

test("inventory expands into per-asset checks plus one set-wide duplicate check", () => {
  const checks = buildAttributeChecksFromInventory(inventory, "/base");
  const ids = checks.map((check) => check.id);
  assert.ok(ids.includes("front:hairColorDelta"));
  assert.ok(ids.includes("front:unintendedChange"));
  // cleanReference の無い asset には neckOrnament を出さない。装飾検出は
  // 「装飾のない同キャラ画像との相対比較」で初めて意味を持つので、
  // 参照が無いまま実行済みに数えると、見逃したまま被覆だけが埋まる。
  assert.ok(!ids.includes("front:neckOrnament"), "参照なしで neckOrnament を実行してしまった");
  assert.ok(ids.includes("back:neckOrnament"), "参照ありの asset で実行されていない");
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

test("a single-asset set still emits the duplicate check so coverage is satisfiable", () => {
  const solo = {
    castId: "tatsu",
    reference: "/ref.png",
    assets: [{ id: "only", file: "/only.png", base: "/only-base.png", cleanReference: "/clean.png" }],
  };
  const checks = buildAttributeChecksFromInventory(solo, "/base");
  const dup = checks.find((check) => check.id === "set:duplicateTakes");
  assert.ok(dup, "1資産のセットで set:duplicateTakes が発行されていない（被覆が充足不可能になる）");
  assert.equal(dup.images.length, 1);
  const report = {
    checks: [
      { id: "only:hairColorDelta", type: "hairColorDelta", status: "pass" },
      { id: "only:unintendedChange", type: "unintendedChange", status: "pass" },
      { id: "only:neckOrnament", type: "neckOrnament", status: "pass" },
      { id: "set:duplicateTakes", type: "duplicateTakes", status: "pass" },
    ],
  };
  assert.equal(assetGateCoverage(solo, report).complete, true);
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
