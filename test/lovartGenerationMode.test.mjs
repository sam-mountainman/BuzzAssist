import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  getLovartUnlimitedEligibility,
  normalizeLovartGenerationMode,
} from "../lib/lovartMediaGeneration.mjs";

test("Lovart generation mode normalizes the official mode/query response", () => {
  assert.deepEqual(
    normalizeLovartGenerationMode({
      unlimited: false,
      unlimited_enable: true,
      unlimited_list: [],
    }, "unlimited"),
    {
      mode: "fast",
      preference: "unlimited",
      unlimitedEnabled: true,
      unlimitedModels: [],
    },
  );
});

test("Lovart generation defaults to Unlimited-first when no preference was saved", () => {
  const status = normalizeLovartGenerationMode({
    unlimited: false,
    unlimited_enable: true,
    unlimited_list: [],
  });
  assert.equal(status.mode, "fast");
  assert.equal(status.preference, "unlimited");
});

test("an empty unlimited list stays unknown so generation can probe safely", () => {
  assert.equal(
    getLovartUnlimitedEligibility({ unlimitedEnabled: true, unlimitedModels: [] }, "lovart-nano-banana-2"),
    "unknown",
  );
});

test("a populated unlimited list acts as a per-model allow list", () => {
  const status = normalizeLovartGenerationMode({
    unlimited: true,
    unlimited_enable: true,
    unlimited_list: [
      "generate_image_nano_banana_2",
      { tool: "generate_video_seedance_v2_0" },
    ],
  }, "unlimited");
  assert.equal(getLovartUnlimitedEligibility(status, "lovart-nano-banana-2"), "available");
  assert.equal(getLovartUnlimitedEligibility(status, "lovart-seedance-2"), "available");
  assert.equal(getLovartUnlimitedEligibility(status, "lovart-gpt-image-2"), "unavailable");
});

test("a plan without unlimited access always uses fast generation", () => {
  assert.equal(
    getLovartUnlimitedEligibility({ unlimitedEnabled: false, unlimitedModels: [] }, "lovart-nano-banana-2"),
    "unavailable",
  );
});

test("Lovart mode controls live in the route menu without changing Generating text", async () => {
  const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const serverSource = await readFile(new URL("../vite.config.js", import.meta.url), "utf8");
  const lovartSource = await readFile(new URL("../lib/lovartMediaGeneration.mjs", import.meta.url), "utf8");

  assert.match(appSource, /<div className="lovart-generation-method-head">Lovart生成方法<\/div>/);
  assert.match(appSource, /\['fast', '⚡ 高速'\]/);
  assert.match(appSource, /\['unlimited', '∞ 無制限'\]/);
  assert.match(appSource, /対象外アカウント・モデルは高速へ自動切替/);
  assert.doesNotMatch(appSource, /Lovartアカウント全体に反映/);
  assert.doesNotMatch(appSource, /無制限対象外のため高速生成/);
  assert.match(appSource, />Generating\.\.\.<\/span>/);

  assert.match(serverSource, /\/api\/lovart\/generation-mode/);
  assert.match(lovartSource, /\/mode\/query/);
  assert.match(lovartSource, /\/mode\/set/);
  assert.match(lovartSource, /shouldRetryLovartInFastMode/);
  assert.match(lovartSource, /restoreLovartUnlimitedPreference/);
});
