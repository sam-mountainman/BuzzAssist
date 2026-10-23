import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { explainIdeal } from "../lib/optimalConfig/explainIdeal.mjs";
import { runOptimalConfigCommand } from "../scripts/optimal-config.mjs";
import { completedTrial, exampleTraits } from "./helpers/optimalConfigTrialFixture.mjs";

const traits = exampleTraits("fixed-cast-manga");
const types = (result) => new Set(result.reasons.map((item) => item.type));
const modelsOf = (config) => Object.fromEntries(Object.entries(config.models).map(([slot, row]) => [slot, row && `${row.modelId}@${row.place}`]));

test("理想どおりにできるなら構成を返し、外したモデルも理由つきで残す", () => {
  const result = explainIdeal(traits, {});
  assert.equal(result.status, "match");
  assert.deepEqual(modelsOf(result.config), { imagePrimary: "gpt-image@operator-service", video: "grok-imagine@operator-service" });
  assert.equal(result.config.videoConfigs.base, "R04");
  assert.ok(result.excluded.some((item) => item.modelId === "noobai-xl" && item.code === "OUTPUTS_NON_COMMERCIAL"));
});

test("権利: 重みが非商用のモデルを名指ししたら止め、近い代わりの案を出す（置き換えない）", () => {
  const result = explainIdeal(traits, { models: { imagePrimary: "flux-dev" } });
  assert.equal(result.status, "blocked");
  assert.equal(result.config, null);
  assert.ok(types(result).has("rights"));
  assert.ok(result.reasons.some((item) => item.code === "WEIGHTS_NON_COMMERCIAL" && /非商用/u.test(item.message)));
  assert.equal(modelsOf(result.alternatives[0].config).imagePrimary, "gpt-image@operator-service");
  assert.equal(result.alternatives[0].changes[0].field, "models.imagePrimary");
  assert.match(result.note, /黙って/u);
});

test("権利: 外に出せない素材があるのにサービスへ送る経路を名指ししたら F 層で止める", () => {
  const result = explainIdeal({ ...traits, confidentialAssets: true }, { models: { imagePrimary: "gpt-image" } });
  assert.equal(result.status, "blocked");
  assert.ok(result.reasons.some((item) => item.type === "rights" && item.code === "CONFIDENTIAL_EXTERNAL_SEND"));
  assert.ok(result.reasons.some((item) => item.slot === "video"), "動画も外部へ送る経路しか無いので止まる");
  const local = result.alternatives.find((alt) => modelsOf(alt.config).imagePrimary === "flux2-klein-4b@operator-mac");
  assert.ok(local, "手元の経路が代わりの案");
  assert.deepEqual(local.changes.map((change) => change.field), ["models.imagePrimary", "motion"]);
});

test("機材: Mac 16GiB・借り GPU なしで LTX を名指ししたら、実行場所ごとの機材の理由で止める", () => {
  const noCloud = { ...traits, hardware: { ...traits.hardware, cloudGpu: false } };
  const result = explainIdeal(noCloud, { artStyle: "anime", models: { video: "ltx-2-5" } });
  assert.equal(result.status, "blocked");
  assert.deepEqual([...types(result)], ["hardware"]);
  const mac = result.reasons.find((item) => item.code === "HARDWARE_MAC");
  assert.match(mac.message, /16GiB/u);
  assert.match(mac.message, /32GiB/u);
  assert.ok(result.reasons.some((item) => item.code === "HARDWARE_CLOUD_GPU_OFF"));
  assert.ok(result.alternatives.some((alt) => alt.changes.some((change) => change.field === "motion" && change.to === "stills-camera")));
});

test("機材: 契約の無いサービス（Veo）は CONTRACT_MISSING", () => {
  const result = explainIdeal(traits, { artStyle: "anime", models: { video: "veo" } });
  assert.equal(result.status, "blocked");
  assert.ok(result.reasons.some((item) => item.type === "hardware" && item.code === "CONTRACT_MISSING" && /google-ai/u.test(item.message)));
});

test("予算: 予算 0 円で借り GPU しか無い経路は止める", () => {
  const result = explainIdeal(traits, { budgetMonthlyJpy: 0, models: { video: "wan2-2-ti2v-5b" } });
  assert.equal(result.status, "blocked");
  assert.ok(types(result).has("budget"));
  assert.ok(result.reasons.some((item) => item.code === "BUDGET_ZERO_RENTED_GPU"));
  assert.deepEqual(result.changedFromTraits, ["budgetMonthlyJpy"]);
});

test("予算: 10カット試験の数字から見積もった月の現金が予算を超えたら止める。予算が未設定なら止めない", () => {
  const trial = completedTrial();
  const over = explainIdeal(traits, { budgetMonthlyJpy: 1000, monthlyAdoptedSeconds: 3600, models: { imagePrimary: "gpt-image" } }, { trial });
  assert.equal(over.status, "blocked");
  const reason = over.reasons.find((item) => item.code === "BUDGET_EXCEEDED_BY_TRIAL");
  assert.ok(reason);
  assert.equal(reason.estimateJpy, 6000);
  const unset = explainIdeal(traits, { budgetMonthlyJpy: null, monthlyAdoptedSeconds: 3600, models: { imagePrimary: "gpt-image" } }, { trial });
  assert.equal(unset.status, "match");
  assert.ok(unset.warnings.some((warning) => /予算が未設定/u.test(warning)));
});

test("構成表に無いモデル・理想の形の間違いは理由で止める", () => {
  const unknown = explainIdeal(traits, { models: { imagePrimary: "no-such-model" } });
  assert.equal(unknown.status, "blocked");
  assert.equal(unknown.reasons[0].code, "MODEL_NOT_IN_CATALOG");
  assert.throws(() => explainIdeal(traits, { motion: "lots" }), /motion/u);
  assert.throws(() => explainIdeal(traits, { colour: "red" }), /知らない欄/u);
});

test("explain の入口は JSON を返す", async () => {
  const dir = mkdtempSync(join(tmpdir(), "optimal-explain-"));
  try {
    const idealPath = join(dir, "ideal.json");
    writeFileSync(idealPath, JSON.stringify({ models: { imagePrimary: "flux-dev" } }));
    const output = await runOptimalConfigCommand(["explain", "--traits", "examples/optimal-config/traits/fixed-cast-manga.json", "--ideal", idealPath]);
    assert.equal(output.ok, true);
    assert.equal(output.status, "blocked");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
