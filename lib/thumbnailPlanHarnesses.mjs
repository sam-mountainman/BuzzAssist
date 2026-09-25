// サムネの計画・検査を、ハーネスごとの決まりの置き場へつなぐ口（lib/thumbnailPlan.mjs が本体）。
//
//   koya-manga-video      決まり: プロジェクトへ復元した番組正本の thumbnail contract（今の漫画の入口と同じ読み方）。
//                         検査・下書きは lib/koyaChannelGovernance.mjs の包み（出力は今の
//                         koya-manga-video.mjs thumbnail-* と同じ）
//   narrated-story-video  決まり: Channel Pack の narrated-story.json の thumbnail 節。署名済みの Pack
//                         （受領側が信頼した公開鍵で検証）か、署名の無い設定ファイル（試行用。final は通らない）
//
// どちらも品質ループの照合・承認済みの参照・Job との結び付けは同じ部品を使う。

import path from "node:path";

import { checkAssetQualityBeforeUse } from "./assetQualityUseGate.mjs";
import { trustedChannelPackKeyFromEnvironment, verifyChannelPackEnvelope } from "./channelPackEnvelope.mjs";
import { readNarratedThumbnailSection } from "./harnessChannelPackRuntime.mjs";
import {
  auditKoyaThumbnailPlan,
  createKoyaThumbnailPlanDraft,
  koyaThumbnailRules,
  readKoyaChannelAuthority,
} from "./koyaChannelGovernance.mjs";
import { resolveApprovedReferenceSha256s } from "./operatorImageImport.mjs";
import {
  auditThumbnailIdeaSet,
  auditThumbnailPlan,
  createThumbnailPlanDraft,
  readThumbnailBindingJob,
  thumbnailApprovedReferencesPolicy,
  thumbnailJobBindingFromJob,
  thumbnailRulesFromChannelSection,
} from "./thumbnailPlan.mjs";

export const THUMBNAIL_HARNESS_IDS = Object.freeze(["koya-manga-video", "narrated-story-video"]);
const NARRATED = "narrated-story-video";
const KOYA = "koya-manga-video";

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/** Job を読み、結び付けの値にする（draft --job-id 用）。ハーネスが違う Job は拒否する。 */
async function jobBindingFor({ projectDir, jobId, harnessId, readJob }) {
  const job = await readJob({ projectDir, jobId });
  if (nonEmpty(job?.harness?.id) !== harnessId) {
    throw new Error(`Job ${jobId} は ${nonEmpty(job?.harness?.id) || "(不明)"} の Job で、${harnessId} のサムネには結び付けられない。`);
  }
  return { job, binding: thumbnailJobBindingFromJob(job) };
}

async function narratedRulesSource({ channelPack, channelConfig, job, env, verifyEnvelope, trustedKey }) {
  if (nonEmpty(channelPack) && nonEmpty(channelConfig)) throw new Error("--channel-pack と --channel-config はどちらか1つにする。");
  const packPath = nonEmpty(channelPack) || (!nonEmpty(channelConfig) ? nonEmpty(job?.channelPack?.path) : "");
  if (packPath) {
    const verified = await verifyEnvelope({ bundleDir: path.resolve(packPath), ...(await trustedKey(env)), expectedHarnessId: NARRATED });
    const read = await readNarratedThumbnailSection({ payloadDir: verified.payloadDir });
    return {
      section: read.thumbnail,
      provenance: {
        kind: "signed-channel-pack",
        packId: verified.id,
        packVersion: verified.packVersion,
        payloadSha256: verified.payloadSha256,
        configSha256: read.configSha256,
        ...(nonEmpty(channelPack) ? {} : { via: "job-channel-pack" }),
      },
    };
  }
  if (nonEmpty(channelConfig)) {
    const read = await readNarratedThumbnailSection({ configPath: path.resolve(channelConfig) });
    return { section: read.thumbnail, provenance: { kind: "unsigned-file", configSha256: read.configSha256 } };
  }
  throw new Error("narrated-story-video のサムネの決まりは Channel Pack の thumbnail 節にある。--channel-pack（署名済み）か --channel-config（署名なし・試行用）を渡すか、--job-id で Job の Pack を使う。");
}

/**
 * ハーネスの口を開く。戻り値: { harnessId, rules, rulesProvenance, draft({ layout, jobId }), audit(plan), auditIdeaSet(plans) }
 *   projectDir     画・Job・承認済みの参照を読むプロジェクト
 *   channelPack    （ナレーション物語）署名済み Channel Pack の envelope
 *   channelConfig  （ナレーション物語）署名の無い narrated-story.json（試行用）
 *   jobId          Job（ナレーション物語で Pack を指定しなければ、その Job の Pack を使う）
 *   workDir        （ナレーション物語）品質ループの作業フォルダ。既定は <project>/canvas（漫画は常に <project>/canvas）
 *   contractPath   （漫画）制作契約（品質ループの効力の判定に使う）
 */
export async function openThumbnailHarness({
  harnessId,
  projectDir = process.cwd(),
  channelPack = "",
  channelConfig = "",
  jobId = "",
  workDir = "",
  contractPath = "",
  env = process.env,
  verifyEnvelope = verifyChannelPackEnvelope,
  trustedKey = trustedChannelPackKeyFromEnvironment,
  readJob = readThumbnailBindingJob,
} = {}) {
  if (!THUMBNAIL_HARNESS_IDS.includes(harnessId)) throw new Error(`--harness は ${THUMBNAIL_HARNESS_IDS.join(" / ")} のどれか: ${harnessId || "(なし)"}`);
  const root = path.resolve(projectDir);
  if (harnessId === KOYA) {
    if (nonEmpty(channelPack) || nonEmpty(channelConfig)) {
      throw new Error("koya-manga-video のサムネの決まりは、プロジェクトへ復元した番組正本の thumbnail contract から読む（--channel-pack / --channel-config は使わない）。");
    }
    if (nonEmpty(workDir)) throw new Error("koya-manga-video の品質ループの作業フォルダは <project>/canvas に決まっている（--work-dir は使わない）。");
    const authority = await readKoyaChannelAuthority({ projectDir: root });
    const contract = authority.thumbnailContract;
    const rules = koyaThumbnailRules(contract);
    return {
      harnessId,
      rules,
      rulesProvenance: { kind: "project-authority", source: authority.source },
      async draft({ layout, jobId: draftJobId = "" } = {}) {
        const binding = nonEmpty(draftJobId) ? (await jobBindingFor({ projectDir: root, jobId: draftJobId, harnessId, readJob })).binding : null;
        return createKoyaThumbnailPlanDraft({ thumbnailContract: contract, layout, ...(binding ? { jobBinding: binding } : {}) });
      },
      audit(plan) {
        return auditKoyaThumbnailPlan({ projectDir: root, thumbnailContract: contract, plan, contractPath: nonEmpty(contractPath) ? path.resolve(contractPath) : "", readJob });
      },
      auditIdeaSet(plans) {
        return auditThumbnailIdeaSet({ rules, plans, projectDir: root });
      },
    };
  }
  const job = nonEmpty(jobId) && !nonEmpty(channelPack) && !nonEmpty(channelConfig)
    ? (await jobBindingFor({ projectDir: root, jobId, harnessId, readJob })).job
    : null;
  const source = await narratedRulesSource({ channelPack, channelConfig, job, env, verifyEnvelope, trustedKey });
  const rules = thumbnailRulesFromChannelSection(source.section, { harnessId });
  const referencesPolicy = thumbnailApprovedReferencesPolicy(source.section);
  const loopDir = nonEmpty(workDir) ? path.resolve(workDir) : path.join(root, "canvas");
  const approvedReferences = async () => {
    const resolved = await resolveApprovedReferenceSha256s({ policy: { approvedReferences: referencesPolicy }, projectDir: root });
    if (resolved.problems.length > 0) throw new Error(resolved.problems.join(", "));
    return resolved.approved;
  };
  const assetQualityGate = async () => ({
    check: ({ path: assetPath, subjectId }) => checkAssetQualityBeforeUse({ harnessId, workDir: loopDir, stage: "thumbnail", subjectId, assetPath }),
  });
  return {
    harnessId,
    rules,
    rulesProvenance: source.provenance,
    async draft({ layout, jobId: draftJobId = "" } = {}) {
      const bindingJobId = nonEmpty(draftJobId) || nonEmpty(jobId);
      const binding = bindingJobId ? (await jobBindingFor({ projectDir: root, jobId: bindingJobId, harnessId, readJob })).binding : null;
      return createThumbnailPlanDraft({ rules, layout, ...(binding ? { jobBinding: binding } : {}) });
    },
    audit(plan) {
      return auditThumbnailPlan({ rules, plan, projectDir: root, approvedReferences, assetQualityGate, readJob, rulesProvenance: source.provenance });
    },
    auditIdeaSet(plans) {
      return auditThumbnailIdeaSet({ rules, plans, projectDir: root });
    },
  };
}
