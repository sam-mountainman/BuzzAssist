import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import {
  CHANNEL_TRAITS_SCHEMA,
  assertChannelTraits,
  inferArtStyleFromVisualProfile,
  readChannelTraits,
  traitsFromChannelPack,
  validateChannelTraits,
} from "../lib/optimalConfig/channelTraits.mjs";

const examplesDir = fileURLToPath(new URL("../examples/optimal-config/traits/", import.meta.url));
const example = (name) => JSON.parse(readFileSync(join(examplesDir, `${name}.json`), "utf8"));

test("例の traits（4チャンネル）は検査と JSON Schema の両方を通る", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(CHANNEL_TRAITS_SCHEMA);
  const names = readdirSync(examplesDir).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(names, ["iq-comparison.json", "koya.json", "mike.json", "unashi.json"]);
  for (const name of names) {
    const traits = JSON.parse(readFileSync(join(examplesDir, name), "utf8"));
    assert.deepEqual(validateChannelTraits(traits), { ok: true, errors: [] }, name);
    assert.equal(validate(traits), true, `${name}: ${JSON.stringify(validate.errors)}`);
  }
});

test("足りない・おかしい欄は、黙って埋めずに欄ごとの日本語の理由で返す", () => {
  const traits = example("koya");
  delete traits.motion;
  traits.artStyle = "watercolor";
  traits.hardware = { ...traits.hardware, mac: { memoryGiB: 0 }, extra: 1 };
  traits.typo = true;
  const { ok, errors } = validateChannelTraits(traits);
  assert.equal(ok, false);
  const fields = errors.map((item) => item.field);
  for (const field of ["motion", "artStyle", "hardware.mac", "hardware.extra", "typo"]) assert.ok(fields.includes(field), field);
  assert.match(errors.find((item) => item.field === "motion").message, /動きの量/u);
  assert.throws(() => assertChannelTraits(traits), (error) => error.code === "CHANNEL_TRAITS_INVALID" && /動きの量/u.test(error.message));
});

test("省略できる欄だけ既定値を入れる（公開範囲は全世界、優先は balanced）", () => {
  const traits = example("mike");
  delete traits.publishScope;
  const normalized = assertChannelTraits(traits);
  assert.equal(normalized.publishScope, "worldwide");
  assert.equal(normalized.priority, "balanced");
  assert.equal(normalized.budgetMonthlyJpy, null, "予算の未設定は null のまま（推定しない）");
});

test("Channel Pack の形（channelTraits / optimalConfig.traits）からも取り出せる", () => {
  const traits = example("unashi");
  assert.equal(traitsFromChannelPack(traits), traits);
  assert.equal(traitsFromChannelPack({ channelTraits: traits }), traits);
  assert.equal(traitsFromChannelPack({ optimalConfig: { traits } }), traits);
  assert.equal(traitsFromChannelPack({ other: 1 }), null);
});

test("Channel Pack の config/channel-traits.json を読み、合成 fixture は使わない", () => {
  const dir = mkdtempSync(join(tmpdir(), "bz-traits-"));
  const previous = process.env.BUZZASSIST_CHANNEL_PACK;
  try {
    // pack が無ければ「無い」と返す（fixture や既定値で埋めない）
    delete process.env.BUZZASSIST_CHANNEL_PACK;
    const none = readChannelTraits({ projectDir: dir });
    assert.equal(none.source.kind, "none");
    assert.equal(none.validation.ok, false);

    const pack = join(dir, "pack");
    mkdirSync(join(pack, "config"), { recursive: true });
    writeFileSync(join(pack, "config", "channel-traits.json"), JSON.stringify(example("koya")));
    process.env.BUZZASSIST_CHANNEL_PACK = pack;
    const read = readChannelTraits({ projectDir: dir });
    assert.equal(read.source.kind, "channel-pack:env");
    assert.equal(read.validation.ok, true);
    assert.equal(read.traits.artStyle, "flat-2d-manga");
  } finally {
    if (previous === undefined) delete process.env.BUZZASSIST_CHANNEL_PACK;
    else process.env.BUZZASSIST_CHANNEL_PACK = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("絵の種類が無ければ画風プロファイルから推定し、推定したことを残す", () => {
  const dir = mkdtempSync(join(tmpdir(), "bz-traits-"));
  try {
    const traits = example("mike");
    delete traits.artStyle;
    const file = join(dir, "traits.json");
    writeFileSync(file, JSON.stringify(traits));
    const store = { profiles: [{ id: "story", stylePrompt: "photorealistic Japanese family drama, natural light" }] };
    const read = readChannelTraits({ traitsPath: file, visualProfileStore: store });
    assert.equal(read.traits.artStyle, "photoreal");
    assert.deepEqual(read.inferred.map((item) => item.field), ["artStyle"]);
    assert.equal(read.validation.ok, true);
    assert.equal(inferArtStyleFromVisualProfile({ stylePrompt: "flat 2D manga panels" }), "flat-2d-manga");
    assert.equal(inferArtStyleFromVisualProfile({ stylePrompt: "" }), "", "手がかりが無ければ推定しない");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
