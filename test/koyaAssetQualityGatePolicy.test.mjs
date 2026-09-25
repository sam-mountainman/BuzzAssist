// 漫画の公式経路で途中の成果物を使う前に品質ループの合格を要求するゲート（契約 v54 から）の、
// 契約・対象 id・承認一覧の書き出し。人物・回・会話 id はすべて合成の値。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { APPROVED_REFERENCES_VERSION } from "../lib/assetQualityLoop.mjs";
import { koyaApprovedReferencesPath, writeKoyaApprovedReferences } from "../lib/koyaAssetQualityGate.mjs";
import {
  KOYA_ASSET_QUALITY_GATE_IN_FORCE_SINCE,
  koyaAssetQualityGateInForce,
  koyaAssetQualitySubjectId,
  koyaSceneImageAssetQualitySubjectId,
  koyaVoiceTakeAssetQualitySubjectId,
  validateKoyaAssetQualityGateContract,
} from "../lib/koyaAssetQualityGatePolicy.mjs";
import { validateKoyaMangaProductionContract } from "../lib/koyaMangaProductionContract.mjs";
import { currentKoyaContract, legacyKoyaContract } from "./helpers/koyaAssetQualityFixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const sha = (value) => createHash("sha256").update(value).digest("hex");

async function tempRoot(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("契約: v54 から節が必須、v53 は節なしで通り節ありは落ちる。効力は版で決める", async () => {
  const current = await currentKoyaContract(root);
  assert.equal(current.version, KOYA_ASSET_QUALITY_GATE_IN_FORCE_SINCE);
  assert.equal(validateKoyaMangaProductionContract(current).pass, true);
  assert.equal(koyaAssetQualityGateInForce(current), true);

  const dropped = structuredClone(current);
  delete dropped.assetQualityGate;
  assert.equal(koyaAssetQualityGateInForce(dropped), true, "節を消しても v54 なら効力は消えない");
  assert.deepEqual(validateKoyaAssetQualityGateContract(dropped).map((row) => row.path), ["assetQualityGate"]);

  const narrowed = structuredClone(current);
  narrowed.assetQualityGate.requirePassBeforeUse = ["character"];
  assert.ok(validateKoyaAssetQualityGateContract(narrowed).some((row) => row.path === "assetQualityGate.requirePassBeforeUse"));

  const legacy = await legacyKoyaContract(root);
  assert.equal(koyaAssetQualityGateInForce(legacy), false);
  assert.equal(validateKoyaMangaProductionContract(legacy).pass, true, "v53 の契約は節なしで従来どおり通る");
  const legacyWithSection = { ...structuredClone(legacy), assetQualityGate: structuredClone(current.assetQualityGate) };
  assert.ok(validateKoyaAssetQualityGateContract(legacyWithSection).some((row) => row.path === "assetQualityGate.inForceSince"));
  assert.equal(koyaAssetQualityGateInForce({ audio: {} }), false, "版の無い部分的な契約は効力の外");
});

test("対象 id: 英数字はそのまま、それ以外は指紋つきで潰れず、64文字に収まる", () => {
  assert.equal(koyaAssetQualitySubjectId("cast-a", "turnaround"), "cast-a.turnaround");
  assert.equal(koyaSceneImageAssetQualitySubjectId("synthetic-ep", "image:cut-01-u01"), "synthetic-ep.image.cut-01-u01");
  assert.equal(koyaVoiceTakeAssetQualitySubjectId("synthetic-ep", "cut-01"), "synthetic-ep.cut-01");
  const first = koyaAssetQualitySubjectId("合成の人物");
  const second = koyaAssetQualitySubjectId("別の合成人物");
  assert.match(first, /^a?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
  assert.notEqual(first, second);
  assert.ok(koyaAssetQualitySubjectId("x".repeat(80), "y".repeat(80)).length <= 64);
});

test("承認一覧: 登録簿の approved の参照画と、候補の判定を持つ人が選んだ顔の SHA だけを書き出す", async (t) => {
  const projectDir = await tempRoot(t, "koya-approved-references-");
  const canvasDir = join(projectDir, "canvas");
  await mkdir(canvasDir, { recursive: true });
  const approvedSheet = sha("synthetic-approved-sheet");
  const pendingSheet = sha("synthetic-pending-sheet");
  const selectedFace = sha("synthetic-selected-face");
  const unverdictedFace = sha("synthetic-unverdicted-face");
  const anchor = sha("synthetic-location-anchor");
  await writeFile(join(canvasDir, "characters.json"), JSON.stringify({
    version: 1,
    revision: 1,
    characters: [
      { id: "cast-approved", name: "合成A", kind: "character", status: "approved", referenceAssets: [{ id: "turnaround", role: "turnaround", path: "assets/a.png", sha256: approvedSheet }] },
      { id: "cast-pending", name: "合成B", kind: "character", status: "draft", referenceAssets: [{ id: "turnaround", role: "turnaround", path: "assets/b.png", sha256: pendingSheet }] },
    ],
  }));
  await writeFile(join(canvasDir, "character-workflows.json"), JSON.stringify({
    version: 1,
    revision: 1,
    workflows: [{
      id: "workflow-synthetic",
      episodeId: "synthetic-ep",
      cast: [
        { id: "cast-new", name: "合成C", status: "awaiting-identity-qa", approval: { verdictDigest: "d".repeat(64) }, identityPack: { selectedFace: { assetFile: "x.png", sha256: selectedFace } } },
        { id: "cast-unverdicted", name: "合成D", status: "awaiting-identity-qa", identityPack: { selectedFace: { assetFile: "y.png", sha256: unverdictedFace } } },
      ],
    }],
  }));
  const written = await writeKoyaApprovedReferences({ projectDir, extraReferences: [{ sha256: anchor, kind: "location:approved-anchor", id: "synthetic-place.anchor" }] });
  assert.equal(written.path, koyaApprovedReferencesPath({ projectDir }));
  assert.equal(written.path, join(canvasDir, "quality", "approved-references.json"));
  const body = JSON.parse(await readFile(written.path, "utf8"));
  assert.equal(body.version, APPROVED_REFERENCES_VERSION);
  const listed = new Set(body.references.map((row) => row.sha256));
  assert.deepEqual([...listed].sort(), [approvedSheet, selectedFace, anchor].sort());
  assert.equal(listed.has(pendingSheet), false, "承認前の登録簿の行は載せない");
  assert.equal(listed.has(unverdictedFace), false, "候補の判定が無い顔は載せない");
  assert.equal(written.sha256, sha(await readFile(written.path)));
  assert.equal(written.count, 3);
});
