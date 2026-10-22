import assert from "node:assert/strict";
import test from "node:test";

import { findModel, loadOptimalConfigCatalog } from "../lib/optimalConfig/catalog.mjs";
import { RIGHTS_BLOCK_CODES, evaluateModelRights, gateModelById } from "../lib/optimalConfig/rightsGate.mjs";

const catalog = loadOptimalConfigCatalog();
const gate = (modelId, context = {}) => evaluateModelRights(findModel(catalog, modelId), { route: "operator-rented-gpu", ...context }, { catalog });
const codes = (verdict) => verdict.blocks.map((item) => item.code);

test("重みが非商用のモデルは、運営者の本番では止める（出力が商用可でも）", () => {
  for (const id of ["flux-dev", "flux2-klein-9b"]) {
    const verdict = gate(id);
    assert.equal(verdict.allowed, false, id);
    assert.ok(codes(verdict).includes(RIGHTS_BLOCK_CODES.WEIGHTS_NON_COMMERCIAL), id);
    assert.equal(verdict.blocks[0].layer, "B");
    assert.match(verdict.blocks[0].message, /非商用/u);
  }
  // 非公開の比較だけなら止めずに注意として残す
  const evaluation = gate("flux-dev", { use: "evaluation" });
  assert.equal(evaluation.allowed, true);
  assert.ok(evaluation.warnings.some((item) => item.code === "WEIGHTS_NON_COMMERCIAL_EVALUATION_ONLY"));
});

test("klein 4B は Apache なので通り、同じ klein の 9B とは分けて判定する", () => {
  const verdict = gate("flux2-klein-4b", { route: "operator-mac" });
  assert.equal(verdict.allowed, true);
  assert.deepEqual(verdict.blocks, []);
});

test("Qwen-Image-2.1 は研究用ライセンスとして止める", () => {
  const verdict = gate("qwen-image-2-1");
  assert.deepEqual(codes(verdict), [RIGHTS_BLOCK_CODES.RESEARCH_LICENSE]);
  assert.match(verdict.blocks[0].message, /研究/u);
});

test("NoobAI は生成物も非商用なので、出力の層でも止める", () => {
  const verdict = gate("noobai-xl");
  assert.ok(codes(verdict).includes(RIGHTS_BLOCK_CODES.OUTPUTS_NON_COMMERCIAL));
  assert.equal(verdict.blocks.find((item) => item.code === RIGHTS_BLOCK_CODES.OUTPUTS_NON_COMMERCIAL).layer, "C");
});

test("地域の制限が出力に及ぶモデルは、全世界の YouTube では止め、公開範囲を絞れば注意に下げる", () => {
  for (const id of ["hunyuan-image-3", "minimax-h3"]) {
    const verdict = gate(id);
    assert.ok(codes(verdict).includes(RIGHTS_BLOCK_CODES.REGION_RESTRICTS_OUTPUTS), id);
    assert.match(verdict.blocks.find((item) => item.code === RIGHTS_BLOCK_CODES.REGION_RESTRICTS_OUTPUTS).message, /全世界/u);
    const limited = gate(id, { publishScope: "japan-only" });
    assert.equal(codes(limited).includes(RIGHTS_BLOCK_CODES.REGION_RESTRICTS_OUTPUTS), false);
    assert.ok(limited.warnings.some((item) => item.code === "REGION_LIMITED_SCOPE"));
  }
  assert.match(gate("minimax-h3").blocks[0].message, /US/u, "MiniMax H3 は米国も外れている");
});

test("InstantID と PuLID は、コードが Apache でも顔の重みが非商用なので止める", () => {
  for (const id of ["instantid", "pulid"]) {
    const verdict = gate(id);
    assert.deepEqual(codes(verdict), [RIGHTS_BLOCK_CODES.FACE_ID_WEIGHTS_NON_COMMERCIAL], id);
    assert.match(verdict.blocks[0].message, /InsightFace/u);
  }
});

test("Pony V7 はプロのアニメ制作が別許諾、Illustrious v0 は派生の条件が重いので止める", () => {
  assert.ok(codes(gate("pony-v7")).includes(RIGHTS_BLOCK_CODES.PROFESSIONAL_ANIMATION_LICENSE));
  assert.ok(codes(gate("illustrious-xl-v0")).includes(RIGHTS_BLOCK_CODES.DERIVATIVE_TERMS_RESTRICTIVE));
});

test("サービス提供が禁止のモデル（Anima）は、運営者の手元なら通し、オトシゴのサーバーなら止める", () => {
  const local = gate("anima", { route: "operator-rented-gpu" });
  assert.equal(local.allowed, true);
  assert.ok(local.warnings.some((item) => item.code === "WEIGHTS_CONDITIONAL"), "モデル自体は非商用であることは注意として残す");
  const hosted = gate("anima", { route: "otoshigo-hosted" });
  assert.equal(hosted.allowed, false);
  assert.ok(codes(hosted).includes(RIGHTS_BLOCK_CODES.HOSTING_AS_SERVICE_FORBIDDEN));
  assert.ok(codes(hosted).includes(RIGHTS_BLOCK_CODES.OTOSHIGO_NO_MEDIA_RELAY));
  // Apache のモデルでも、オトシゴのサーバーでの生成・中継は方針として止める
  const apacheHosted = gate("flux2-klein-4b", { route: "otoshigo-hosted" });
  assert.deepEqual(codes(apacheHosted), [RIGHTS_BLOCK_CODES.OTOSHIGO_NO_MEDIA_RELAY]);
});

test("外に出せない素材があるときは、外部へ送る経路を止める", () => {
  const service = gate("gpt-image", { route: "operator-service", confidentialAssets: true });
  assert.ok(codes(service).includes(RIGHTS_BLOCK_CODES.CONFIDENTIAL_EXTERNAL_SEND));
  assert.equal(service.blocks.find((item) => item.code === RIGHTS_BLOCK_CODES.CONFIDENTIAL_EXTERNAL_SEND).layer, "F");
  const rented = gate("flux2-klein-4b", { route: "operator-rented-gpu", confidentialAssets: true });
  assert.ok(codes(rented).includes(RIGHTS_BLOCK_CODES.CONFIDENTIAL_EXTERNAL_SEND));
  const local = gate("flux2-klein-4b", { route: "operator-mac", confidentialAssets: true });
  assert.equal(local.allowed, true);
  const optional = gate("wan2-2-ti2v-5b", { route: "operator-cuda", confidentialAssets: true });
  assert.equal(optional.allowed, true);
  assert.ok(optional.warnings.some((item) => item.code === "DATA_OPTIONAL_EXTERNAL"), "外へ送る選択肢がある経路は注意を出す");
});

test("売上の閾値は、申告があれば機械的に判定し、無ければ注意を出す", () => {
  assert.ok(gate("ltx-2-5").warnings.some((item) => item.code === "REVENUE_THRESHOLD_UNKNOWN"));
  assert.ok(codes(gate("ltx-2-5", { annualRevenueUsd: 20_000_000 })).includes(RIGHTS_BLOCK_CODES.REVENUE_THRESHOLD_EXCEEDED));
  assert.equal(gate("ltx-2-5", { annualRevenueUsd: 50_000 }).allowed, true);
});

test("gateModelById は場所を省くと全部の実行場所とオトシゴのサーバーを並べ、知らないモデルは止める", () => {
  const rows = gateModelById(catalog, "anima");
  assert.deepEqual(rows.map((row) => row.route), ["operator-cuda", "operator-rented-gpu", "otoshigo-hosted"]);
  assert.deepEqual(rows.map((row) => row.allowed), [true, true, false]);
  assert.throws(() => gateModelById(catalog, "no-such-model"), (error) => error.code === "OPTIMAL_CONFIG_UNKNOWN_MODEL");
  const unknownRoute = gateModelById(catalog, "flux2-klein-4b", { route: "somewhere" })[0];
  assert.ok(codes(unknownRoute).includes(RIGHTS_BLOCK_CODES.UNKNOWN_ROUTE));
});
