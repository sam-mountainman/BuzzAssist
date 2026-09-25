// 途中の成果物の品質ループの試験で共有する合成の入力（test/assetQualityLoop*.test.mjs）。
// 人物・会話 id・対象 id・所見はすべて合成の値。
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

import {
  APPROVED_REFERENCES_VERSION,
  assetQualityStage,
  recordAssetHumanVerification,
} from "../../lib/assetQualityLoop.mjs";

export const sha = (value) => createHash("sha256").update(value).digest("hex");
export const MAKER = "ctx-maker-1";
export const IDENTITY_NOTES = { face: "輪郭と目の形を参照と並べて見た", hair: "分け目と前髪の形を並べて見た", body: "頭身と肩幅を並べて見た" };

let clock = Date.parse("2026-09-25T00:00:00.000Z");
export const now = () => {
  clock += 60_000;
  return new Date(clock).toISOString();
};

/** IHDR に寸法を持つ最小の PNG（中身は salt で変える）。 */
export function png(width, height, salt) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from("IHDR", "ascii"),
    ihdr,
    Buffer.from(`synthetic-${salt}`, "utf8"),
  ]);
}

export function wav(salt) {
  return Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WAVEfmt ", "ascii"), Buffer.from(`synthetic-${salt}`, "utf8")]);
}

export async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "asset-quality-loop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["assets", "reviews", "refs", "measure"]) await mkdir(join(root, dir), { recursive: true });
  return root;
}

export function scores(contract, overrides = {}) {
  // 二値の安全項目（下限 100）は満点、ほかは 95。
  return Object.fromEntries(contract.rubric.map((row) => [row.id, overrides[row.id] ?? (row.minimumScore >= 100 ? 100 : 95)]));
}

export function reviewFor({ stage, context, assetSha, refs = [], contract, overrides = {}, extra = {} }) {
  const spec = assetQualityStage(stage);
  return {
    evaluatorId: "evaluator",
    evaluatorContextId: context,
    evaluatorHost: "codex",
    assetSha256: assetSha,
    ...(spec.reviewRequirements.includes("charactersVisible") ? { charactersVisible: refs.length > 0 } : {}),
    ...(spec.reviewRequirements.includes("viewedAtDecidedSize") ? { viewedAtDecidedSize: true } : {}),
    ...(refs.length > 0 ? { comparedReferenceSha256s: refs, identityComparison: IDENTITY_NOTES } : {}),
    rubricScores: scores(contract, overrides),
    // 所見は評価ごとに違う（前の回の所見の写しは品質ループが採点に使わない）。
    notes: `原寸で全体を見て、手元と顔を拡大して見た（合成の所見・${context}）`,
    findings: [],
    ...extra,
  };
}

export async function writeReview(root, name, body) {
  const rel = `reviews/${name}.json`;
  await writeFile(join(root, rel), `${JSON.stringify(body, null, 2)}\n`);
  return rel;
}

/** 工程ごとの入力（参照・承認一覧・成果物・声の測定）。 */
export async function stageInputs(root, stage) {
  const spec = assetQualityStage(stage);
  const referenceFile = join(root, "refs", "approved-sheet.png");
  await writeFile(referenceFile, png(1024, 1024, "approved-reference"));
  const refSha = sha(await readFile(referenceFile));
  const approvedPath = join(root, "refs", "approved.json");
  await writeFile(approvedPath, JSON.stringify({ version: APPROVED_REFERENCES_VERSION, references: [{ sha256: refSha, kind: "character-identity" }] }));
  const usesRefs = spec.media === "image";
  return {
    refs: usesRefs ? [refSha] : [],
    async asset(n) {
      const rel = spec.media === "audio" ? `assets/${stage}-v${n}.wav` : `assets/${stage}-v${n}.png`;
      const bytes = spec.media === "audio" ? wav(`${stage}-${n}`) : stage === "thumbnail" ? png(1280, 720, `${stage}-${n}`) : png(1024, 1024, `${stage}-${n}`);
      await writeFile(join(root, rel), bytes);
      return { rel, sha: sha(bytes) };
    },
    async recordExtra(version, route = "codex") {
      const extra = {
        producerContexts: [MAKER],
        producerHost: "claude-code",
        generationRoute: spec.media === "audio" ? "broker" : route,
      };
      if (usesRefs) Object.assign(extra, { references: [referenceFile], approvedReferencesPath: approvedPath });
      if (spec.media === "audio") {
        const rel = `measure/${path.basename(version.rel)}.json`;
        await writeFile(join(root, rel), JSON.stringify({
          overall: "pass",
          checks: [{ id: "take", type: "voiceQuality", inputSha256: { [version.rel]: version.sha }, checkDigest: "synthetic", status: "pass", metrics: { utmos: 3.4, cer: 0.04 }, problems: [], warnings: [] }],
        }));
        extra.measurementPath = rel;
      }
      return extra;
    },
  };
}

export function verify(root, stage, subjectId, assetPath, checks, verdict = "pass", extra = {}) {
  return recordAssetHumanVerification({
    workDir: root, stage, subjectId, assetPath, checks, verdict, reviewer: "synthetic-reviewer",
    note: "原寸で参照と並べ、手元を拡大して見た", humanVerified: true, isInteractive: true, now, ...extra,
  });
}
