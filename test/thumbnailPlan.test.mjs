// サムネの計画・検査の共通層（lib/thumbnailPlan.mjs）の各検査。
// 決まりはナレーション物語と同じ Channel Pack の thumbnail 節の形で合成する。人の名前・文言・画・Job はすべて合成の値。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkAssetQualityBeforeUse, insideWorkDir } from "../lib/assetQualityUseGate.mjs";
import {
  auditKoyaThumbnailPlan,
  createKoyaThumbnailPlanDraft,
  koyaThumbnailCopySha256,
  koyaThumbnailRules,
  readKoyaChannelAuthority,
} from "../lib/koyaChannelGovernance.mjs";
import { renderEditorialPlatePng } from "../lib/mangaScriptImagePipeline.mjs";
import {
  THUMBNAIL_DEFAULT_FINAL_CHECKS,
  THUMBNAIL_PLAN_VERSION,
  auditThumbnailIdeaSet,
  auditThumbnailPlan,
  createThumbnailPlanDraft,
  insideProject,
  normalizeThumbnailRules,
  thumbnailApprovedReferencesPolicy,
  thumbnailArtworkQualitySubjectId,
  thumbnailCompositeQualitySubjectId,
  thumbnailCopySha256,
  thumbnailRulesFromChannelSection,
  verifyThumbnailJobBinding,
} from "../lib/thumbnailPlan.mjs";
import { passKoyaAssetQualityLoop } from "./helpers/koyaAssetQualityFixture.mjs";

const HARNESS = "narrated-story-video";
const root = fileURLToPath(new URL("..", import.meta.url));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const LETTERING = Object.freeze({ typeface: "合成の筆書体", strokeContrast: "太細の差を強く", tracking: "詰め気味", color: "墨色に朱の差し色", carrier: "木の看板" });

function section(overrides = {}) {
  return {
    status: "synthetic-approved",
    rules: { brandTokens: { bandColor: "synthetic-band-v1" } },
    layouts: { single: { panels: 1, default: true }, pair: { panels: 2, reasonRequired: true } },
    text: {
      band: { lines: 2, maxCharactersPerLine: 12 },
      speechBubble: { lines: 2, maxCharactersPerLine: 8, maximumPerPanel: 1 },
      telop: { minCharacters: 2, maxCharacters: 4, concreteNounReview: true },
      forbiddenTerms: [{ text: "合成禁止語", kind: "brand" }],
      approval: "when-text",
    },
    ...overrides,
  };
}

async function tempProject(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "thumbnail-plan-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "canvas", "thumbs"), { recursive: true });
  return dir;
}

function approveCopy(plan) {
  return { ...plan, exactTextApproved: true, textApproval: { approvedBy: "synthetic-approver", approvedAt: "2026-09-25T00:00:00.000Z", copySha256: thumbnailCopySha256(plan) } };
}

function preflightPlan(overrides = {}) {
  return approveCopy({
    version: THUMBNAIL_PLAN_VERSION,
    harnessId: HARNESS,
    stage: "preflight",
    layout: "single",
    bandLines: ["合成の見出し", "二行目"],
    speechBubbles: [],
    telops: [],
    lettering: { band: { ...LETTERING } },
    charactersVisible: false,
    characterReferences: [],
    ...overrides,
  });
}

async function writeJob(projectDir, { id, harnessId = HARNESS, episodeId = "", status = "completed", videoSha256 = "" }) {
  const file = path.join(projectDir, "canvas", "harness-runs", id, "job.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    id,
    status,
    harness: { id: harnessId },
    options: episodeId ? { episodeId } : {},
    artifacts: videoSha256 ? [{ kind: "final-video", path: "final.mp4", sha256: videoSha256 }] : [],
  }));
  return file;
}

test("決まり: Pack の thumbnail 節を検査し、共通の検査は Pack から弱められない", () => {
  const rules = thumbnailRulesFromChannelSection(section(), { harnessId: HARNESS });
  assert.deepEqual(rules.canvas, { width: 1280, height: 720 });
  assert.deepEqual(rules.decidedSize, { width: 320, height: 180 });
  assert.equal(rules.defaultLayout, "single");
  assert.equal(rules.lettering.required, true);
  assert.equal(rules.composite.required, true);
  assert.equal(rules.jobBinding.required, true);
  assert.equal(rules.characterReferences.required, true);
  assert.equal(rules.source.dedicatedArtworkRequired, true);
  assert.equal(rules.source.distinctPanelArtwork, true);
  assert.equal(rules.finalChecksBinding, "composite");
  assert.deepEqual(rules.finalChecks, [...THUMBNAIL_DEFAULT_FINAL_CHECKS]);
  assert.deepEqual(rules.copy.speechBubble.perPanel, { maximum: 1 });
  assert.ok(Object.isFrozen(rules));
  // 人の確認の欄は足せるが、既定の欄は消えない。
  assert.deepEqual(thumbnailRulesFromChannelSection(section({ rules: { finalChecks: ["seriesMarkVisible"] } }), { harnessId: HARNESS }).finalChecks,
    [...THUMBNAIL_DEFAULT_FINAL_CHECKS, "seriesMarkVisible"]);

  assert.throws(() => thumbnailRulesFromChannelSection(undefined, { harnessId: HARNESS }), /no thumbnail section/u);
  assert.throws(() => thumbnailRulesFromChannelSection(section({ layouts: {} }), { harnessId: HARNESS }), /layouts is required/u);
  assert.throws(() => thumbnailRulesFromChannelSection(section({ text: undefined }), { harnessId: HARNESS }), /text is required/u);
  assert.throws(() => thumbnailRulesFromChannelSection(section({ rules: { canvas: { width: 1080, height: 1080 } } }), { harnessId: HARNESS }), /16:9/u);
  assert.throws(() => thumbnailRulesFromChannelSection(section({ rules: { reuseDistance: 0.001 } }), { harnessId: HARNESS }), /may only be raised/u);
  assert.throws(() => thumbnailRulesFromChannelSection(section({ layouts: { single: { panels: 0 } } }), { harnessId: HARNESS }), /panels/u);
  assert.throws(() => normalizeThumbnailRules({ harnessId: HARNESS, layouts: { single: { panels: 1 } }, decidedSize: { width: 320, height: 320 } }), /aspect ratio/u);
  assert.throws(() => normalizeThumbnailRules({ harnessId: HARNESS, layouts: { single: { panels: 1 } }, copy: { forbiddenTerms: [{ text: "" }] } }), /forbiddenTerms/u);

  assert.deepEqual(thumbnailApprovedReferencesPolicy({ approvedReferences: { sha256: ["A".repeat(64)], characterRegistry: true } }), { sha256: ["a".repeat(64)], characterRegistry: true });
  assert.throws(() => thumbnailApprovedReferencesPolicy({ approvedReferences: { sha256: ["not-a-sha"] } }), /64-digit/u);
});

test("下書き: 新しい計画は全部の欄を fail-closed で持ち、配置の理由の欄は理由が要る配置だけに付く", () => {
  const rules = thumbnailRulesFromChannelSection(section(), { harnessId: HARNESS });
  const draft = createThumbnailPlanDraft({ rules });
  assert.equal(draft.version, THUMBNAIL_PLAN_VERSION);
  assert.equal(draft.harnessId, HARNESS);
  assert.equal(draft.layout, "single");
  assert.equal("layoutReason" in draft, false);
  assert.deepEqual(Object.keys(draft.lettering), ["band", "speechBubble", "telop"]);
  assert.equal(draft.checks.compositeSha256, "");
  assert.ok(THUMBNAIL_DEFAULT_FINAL_CHECKS.every((key) => draft.checks[key] === false));
  assert.deepEqual(draft.jobBinding, { jobId: "", episodeId: "", videoSha256: "" });
  assert.deepEqual(draft.brandTokens, { bandColor: "synthetic-band-v1" });
  const pair = createThumbnailPlanDraft({ rules, layout: "pair", jobBinding: { jobId: "video-narrated-story-video-0123456789abcdef", episodeId: "ep-7" } });
  assert.equal(pair.layoutReason, "");
  assert.equal(pair.jobBinding.jobId, "video-narrated-story-video-0123456789abcdef");
  assert.equal(pair.jobBinding.episodeId, "ep-7");
});

test("決定サイズで読める文言: 行と字数の上限・1コマの吹き出しの数・全部の枠の禁止語・枠の無い文字", async (t) => {
  const projectDir = await tempProject(t);
  const rules = thumbnailRulesFromChannelSection(section({ text: { ...section().text, telop: undefined } }), { harnessId: HARNESS });
  const plan = preflightPlan({
    bandLines: ["一二三四五六七八九十一二三", "合成禁止語を含む"],
    speechBubbles: [{ panelId: "main", lines: ["一"] }, { panelId: "main", lines: ["二"] }],
    telops: [{ text: "合成語", concreteNounReviewPassed: true }],
    lettering: { band: { ...LETTERING }, speechBubble: { ...LETTERING }, telop: { ...LETTERING } },
  });
  const result = await auditThumbnailPlan({ rules, plan, projectDir });
  assert.equal(result.pass, false);
  assert.ok(result.failures.includes("Band copy line 1 exceeds 12 characters."));
  assert.ok(result.failures.includes("Forbidden brand '合成禁止語' appears in thumbnail copy."));
  assert.ok(result.failures.some((line) => line.startsWith("thumbnail-speech-bubbles-per-panel:main:")));
  assert.ok(result.failures.some((line) => line.startsWith("thumbnail-text-slot-not-allowed:telop:")));
  assert.deepEqual(result.decidedSize, { width: 320, height: 180 });
});

test("文字の設計: 文字があれば書体・抑揚・字間・色・担体が要り、既定や空欄は数えない。文字の無い案は要らない", async (t) => {
  const projectDir = await tempProject(t);
  const rules = thumbnailRulesFromChannelSection(section(), { harnessId: HARNESS });
  const missing = await auditThumbnailPlan({ rules, plan: preflightPlan({ lettering: undefined }), projectDir });
  assert.ok(missing.failures.some((line) => line.startsWith("thumbnail-lettering-required:band:")));
  const placeholder = await auditThumbnailPlan({ rules, plan: preflightPlan({ lettering: { band: { ...LETTERING, typeface: "default", carrier: "" } } }), projectDir });
  assert.ok(placeholder.failures.some((line) => line.startsWith("thumbnail-lettering-unspecified:band:typeface,carrier:")));
  const unknown = await auditThumbnailPlan({ rules, plan: preflightPlan({ lettering: { band: { ...LETTERING }, headline: { ...LETTERING } } }), projectDir });
  assert.ok(unknown.failures.some((line) => line.startsWith("thumbnail-lettering-unknown-slot:headline:")));
  const complete = await auditThumbnailPlan({ rules, plan: preflightPlan(), projectDir });
  assert.equal(complete.pass, true, complete.failures.join("\n"));
  assert.equal(complete.readyForGeneration, true);
  assert.equal(complete.lettering.slots.band.specified, true);
  // 文字の無い案: 設計も文言の承認も要らない（承認の方針が when-text）。
  const textless = await auditThumbnailPlan({
    rules,
    plan: { version: THUMBNAIL_PLAN_VERSION, harnessId: HARNESS, stage: "preflight", layout: "single", bandLines: [], speechBubbles: [], telops: [], charactersVisible: false },
    projectDir,
  });
  assert.ok(textless.failures.every((line) => !/lettering|approval|Exact thumbnail text/u.test(line)), textless.failures.join("\n"));
});

test("登場人物の参照: 人が写るなら承認済みの設定画の SHA が要り、ファイル名では信用しない", async (t) => {
  const projectDir = await tempProject(t);
  const rules = thumbnailRulesFromChannelSection(section(), { harnessId: HARNESS });
  const approvedFile = path.join(projectDir, "canvas", "refs", "sheet-a.png");
  const unapprovedFile = path.join(projectDir, "canvas", "refs", "sheet-a-copy.png");
  await mkdir(path.dirname(approvedFile), { recursive: true });
  await writeFile(approvedFile, renderEditorialPlatePng("white-solid", 64, 64));
  await writeFile(unapprovedFile, renderEditorialPlatePng("black-solid", 64, 64));
  const approvedSha = sha(await readFile(approvedFile));
  const approvedReferences = async () => new Map([[approvedSha, "channel-pack"]]);

  const undeclared = await auditThumbnailPlan({ rules, plan: preflightPlan({ charactersVisible: undefined }), projectDir, approvedReferences });
  assert.ok(undeclared.failures.some((line) => line.startsWith("thumbnail-characters-visible-undeclared")));
  const noRefs = await auditThumbnailPlan({ rules, plan: preflightPlan({ charactersVisible: true }), projectDir, approvedReferences });
  assert.ok(noRefs.failures.some((line) => line.startsWith("thumbnail-character-references-required")));
  const wrong = await auditThumbnailPlan({
    rules, plan: preflightPlan({ charactersVisible: true, characterReferences: [{ characterId: "synthetic-a", path: path.relative(projectDir, unapprovedFile) }] }), projectDir, approvedReferences,
  });
  assert.ok(wrong.failures.some((line) => line.startsWith("thumbnail-character-reference-unapproved:synthetic-a:")));
  const outside = await auditThumbnailPlan({
    rules, plan: preflightPlan({ charactersVisible: true, characterReferences: [{ characterId: "synthetic-a", path: path.join("..", "elsewhere.png") }] }), projectDir, approvedReferences,
  });
  assert.ok(outside.failures.some((line) => line.startsWith("thumbnail-character-reference-outside-project:0")));
  const unavailable = await auditThumbnailPlan({ rules, plan: preflightPlan({ charactersVisible: true, characterReferences: [approvedSha] }), projectDir });
  assert.ok(unavailable.failures.some((line) => line.startsWith("thumbnail-approved-references-unavailable")));
  const ok = await auditThumbnailPlan({
    rules, plan: preflightPlan({ charactersVisible: true, characterReferences: [{ characterId: "synthetic-a", path: path.relative(projectDir, approvedFile) }] }), projectDir, approvedReferences,
  });
  assert.equal(ok.pass, true, ok.failures.join("\n"));
  assert.deepEqual(ok.characterReferences.rows, [{ characterId: "synthetic-a", sha256: approvedSha, approved: true, source: "channel-pack" }]);
});

test("final: 使い回し・完成画・人の確認の結び付け・品質ループの合格・Job の結び付けを全部見る", async (t) => {
  const projectDir = await tempProject(t);
  const workDir = path.join(projectDir, "canvas");
  const rules = thumbnailRulesFromChannelSection(section(), { harnessId: HARNESS });
  const thumbs = path.join(workDir, "thumbs");
  const artA = path.join(thumbs, "idea-a-v1.png");
  const artB = path.join(thumbs, "idea-b-v1.png");
  const composite = path.join(thumbs, "composite-a-v1.png");
  const smallComposite = path.join(thumbs, "composite-small.png");
  const frame = path.join(thumbs, "frame.png");
  const previous = path.join(thumbs, "previous.png");
  await writeFile(artA, renderEditorialPlatePng("black-solid", 1280, 720));
  await writeFile(artB, renderEditorialPlatePng("black-solid", 1280, 720));
  await writeFile(composite, renderEditorialPlatePng("white-solid", 1280, 720));
  await writeFile(smallComposite, renderEditorialPlatePng("white-solid", 640, 360));
  await writeFile(frame, renderEditorialPlatePng("pastel-sky", 1280, 720));
  await writeFile(previous, renderEditorialPlatePng("black-solid", 640, 360));
  const jobId = "video-narrated-story-video-0123456789abcdef";
  const videoSha256 = "c".repeat(64);
  await writeJob(projectDir, { id: jobId, episodeId: "ep-7", videoSha256 });
  const gate = async () => ({
    check: ({ path: assetPath, subjectId }) => checkAssetQualityBeforeUse({ harnessId: HARNESS, workDir, stage: "thumbnail", subjectId, assetPath }),
  });
  const compositeSha = sha(await readFile(composite));
  const finalPlan = (overrides = {}) => preflightPlan({
    stage: "final",
    artworkPaths: [artA],
    mainVideoFramePaths: [frame],
    compositePath: path.relative(projectDir, composite),
    checks: { ...Object.fromEntries(THUMBNAIL_DEFAULT_FINAL_CHECKS.map((key) => [key, true])), compositeSha256: compositeSha },
    jobBinding: { jobId, episodeId: "ep-7", videoSha256 },
    ...overrides,
  });

  // 品質ループが未合格の final は落ちる（専用画と完成画のそれぞれ）。
  const unpassed = await auditThumbnailPlan({ rules, plan: finalPlan(), projectDir, assetQualityGate: gate });
  assert.equal(unpassed.pass, false);
  const subjectA = thumbnailArtworkQualitySubjectId(finalPlan(), 0, artA);
  const subjectComposite = thumbnailCompositeQualitySubjectId(finalPlan(), composite);
  assert.equal(subjectA, "thumbnail.idea-a-v1");
  assert.equal(subjectComposite, "thumbnail.composite.composite-a-v1");
  assert.ok(unpassed.failures.some((line) => line.startsWith(`asset-quality-required:thumbnail:${subjectA}:loop-not-started`)));
  assert.ok(unpassed.failures.some((line) => line.startsWith(`asset-quality-required:thumbnail:${subjectComposite}:loop-not-started`)));
  assert.match(unpassed.failures.join("\n"), /--harness narrated-story-video/u);
  // 照合の口が無ければ final は通らない（黙って飛ばさない）。
  const noGate = await auditThumbnailPlan({ rules, plan: finalPlan(), projectDir });
  assert.ok(noGate.failures.some((line) => line.startsWith("thumbnail-asset-quality-unavailable")));

  await passKoyaAssetQualityLoop({ harnessId: HARNESS, workDir, stage: "thumbnail", subjectId: subjectA, assetPath: artA });
  await passKoyaAssetQualityLoop({ harnessId: HARNESS, workDir, stage: "thumbnail", subjectId: subjectComposite, assetPath: composite, stopBefore: "human" });
  const awaitingHuman = await auditThumbnailPlan({ rules, plan: finalPlan(), projectDir, assetQualityGate: gate });
  assert.deepEqual(awaitingHuman.assetQuality.filter((row) => !row.pass).map((row) => [row.subjectId, row.reason]), [[subjectComposite, "not-passed"]]);
  const { recordAssetHumanVerification } = await import("../lib/assetQualityLoop.mjs");
  await recordAssetHumanVerification({
    workDir, stage: "thumbnail", subjectId: subjectComposite, assetPath: composite, checks: ["hand-safety"],
    verdict: "pass", reviewer: "synthetic-reviewer", note: "手元を拡大して見た（合成）", humanVerified: true, isInteractive: true,
  });
  const passed = await auditThumbnailPlan({ rules, plan: finalPlan(), projectDir, assetQualityGate: gate });
  assert.equal(passed.pass, true, passed.failures.join("\n"));
  assert.equal(passed.readyForPublish, true);
  assert.equal(passed.jobBinding.verified, true);
  assert.equal(passed.composite.sha256, compositeSha);

  // 本編の画・過去のサムネ・別のコマとの使い回し。
  const reused = await auditThumbnailPlan({
    rules,
    plan: finalPlan({ layout: "pair", layoutReason: "合成の二つ目の場面", artworkPaths: [artA, artB], mainVideoFramePaths: [artA], previousThumbnailPaths: [previous] }),
    projectDir,
    assetQualityGate: gate,
  });
  assert.ok(reused.failures.some((line) => line.startsWith("Dedicated thumbnail artwork reuses a main-video frame:")));
  assert.ok(reused.failures.some((line) => line.startsWith("thumbnail-artwork-perceptually-reuses-previous-thumbnail:")));
  assert.ok(reused.failures.some((line) => line.startsWith("thumbnail-panel-artwork-duplicated:1:2:")));

  // 完成画: 無い・寸法違い・人の確認が別の版。
  const noComposite = await auditThumbnailPlan({ rules, plan: finalPlan({ compositePath: "" }), projectDir, assetQualityGate: gate });
  assert.ok(noComposite.failures.some((line) => line.startsWith("thumbnail-composite-required")));
  assert.ok(noComposite.failures.some((line) => line.startsWith("thumbnail-checks-stale")));
  const small = await auditThumbnailPlan({ rules, plan: finalPlan({ compositePath: path.relative(projectDir, smallComposite) }), projectDir, assetQualityGate: gate });
  assert.ok(small.failures.some((line) => line.startsWith("thumbnail-composite-size:640x360:")));
  assert.ok(small.failures.some((line) => line.startsWith("thumbnail-checks-stale")));

  // Job の結び付け: 無い・動画違い・未完了。
  const unbound = await auditThumbnailPlan({ rules, plan: finalPlan({ jobBinding: undefined }), projectDir, assetQualityGate: gate });
  assert.ok(unbound.failures.some((line) => line.startsWith("thumbnail-job-binding-required")));
  // 下書きの空の結び付けは「まだ結び付けていない」と同じ（final では要る、preflight では警告だけ）。
  const blank = { jobId: "", episodeId: "", videoSha256: "" };
  const blankFinal = await auditThumbnailPlan({ rules, plan: finalPlan({ jobBinding: blank }), projectDir, assetQualityGate: gate });
  assert.ok(blankFinal.failures.some((line) => line.startsWith("thumbnail-job-binding-required")));
  assert.ok(!blankFinal.failures.some((line) => line.startsWith("thumbnail-job-binding-job-id-invalid")));
  const blankPreflight = await auditThumbnailPlan({ rules, plan: preflightPlan({ jobBinding: blank }), projectDir });
  assert.equal(blankPreflight.pass, true, blankPreflight.failures.join("\n"));
  assert.ok(blankPreflight.warnings.some((line) => line.startsWith("thumbnail-job-binding-required-at-final")));
  const wrongVideo = await auditThumbnailPlan({ rules, plan: finalPlan({ jobBinding: { jobId, episodeId: "ep-7", videoSha256: "d".repeat(64) } }), projectDir, assetQualityGate: gate });
  assert.ok(wrongVideo.failures.some((line) => line.startsWith("thumbnail-job-binding-video-mismatch")));

  // 署名の無い決まりでは公開できない（preflight は警告だけ）。
  const unsigned = await auditThumbnailPlan({ rules, plan: finalPlan(), projectDir, assetQualityGate: gate, rulesProvenance: { kind: "unsigned-file" } });
  assert.ok(unsigned.failures.some((line) => line.startsWith("thumbnail-rules-unsigned")));
  const unsignedPreflight = await auditThumbnailPlan({ rules, plan: preflightPlan(), projectDir, rulesProvenance: { kind: "unsigned-file" } });
  assert.ok(unsignedPreflight.warnings.some((line) => line.startsWith("thumbnail-rules-unsigned")));
});

test("Job との結び付け: 実在・ハーネス・話数・完成動画・完了を照合する", async (t) => {
  const projectDir = await tempProject(t);
  const jobId = "video-narrated-story-video-00000000000000aa";
  const videoSha256 = "e".repeat(64);
  await writeJob(projectDir, { id: jobId, episodeId: "ep-3", status: "awaiting-human-review", videoSha256 });
  const otherJob = "video-koya-manga-video-00000000000000bb";
  await writeJob(projectDir, { id: otherJob, harnessId: "koya-manga-video", episodeId: "ep-3" });
  const noEpisodeJob = "video-narrated-story-video-00000000000000cc";
  await writeJob(projectDir, { id: noEpisodeJob, videoSha256 });
  const verify = (binding, stage = "final") => verifyThumbnailJobBinding({ binding, harnessId: HARNESS, projectDir, stage });

  assert.ok((await verify({ jobId: "video-narrated-story-video-ffffffffffffffff", videoSha256 })).failures.some((line) => line.startsWith("thumbnail-job-binding-job-missing")));
  assert.ok((await verify({ jobId: "not-a-job" })).failures.some((line) => line.startsWith("thumbnail-job-binding-job-id-invalid")));
  assert.ok((await verify({ jobId: otherJob, episodeId: "ep-3" }, "preflight")).failures.some((line) => line.startsWith("thumbnail-job-binding-harness-mismatch:koya-manga-video")));
  assert.ok((await verify({ jobId, episodeId: "ep-4", videoSha256 })).failures.some((line) => line.startsWith("thumbnail-job-binding-episode-mismatch:ep-4")));
  const notCompleted = await verify({ jobId, episodeId: "ep-3", videoSha256 });
  assert.deepEqual(notCompleted.failures.map((line) => line.split(":")[0]), ["thumbnail-job-binding-job-not-completed"]);
  const unverifiedEpisode = await verify({ jobId: noEpisodeJob, episodeId: "第3話", videoSha256 });
  assert.deepEqual(unverifiedEpisode.failures, []);
  assert.ok(unverifiedEpisode.warnings.some((line) => line.startsWith("thumbnail-job-binding-episode-unverified")));
  // preflight: 動画がまだ無くてもよい。結び付け自体（実在・ハーネス・話数）は確かめる。
  const early = await verify({ jobId, episodeId: "ep-3" }, "preflight");
  assert.deepEqual(early.failures, []);
  assert.equal(early.report.verified, true);
  assert.equal(early.report.jobEpisodeId, "ep-3");
  // 期待するパスは path.join で組む（Windows の区切りでも同じ置き場）。
  assert.equal(
    path.join(projectDir, "canvas", "harness-runs", jobId, "job.json"),
    (await import("../lib/videoHarnessJob.mjs")).videoHarnessJobPath(projectDir, jobId),
  );
});

test("案どうし: 読める軸で違うこと、軸の文章だけの差は認めないこと", async (t) => {
  const projectDir = await tempProject(t);
  const rules = thumbnailRulesFromChannelSection(section(), { harnessId: HARNESS });
  const thumbs = path.join(projectDir, "canvas", "thumbs");
  const art = path.join(thumbs, "shared.png");
  const artOther = path.join(thumbs, "other.png");
  await writeFile(art, renderEditorialPlatePng("black-solid", 1280, 720));
  await writeFile(artOther, renderEditorialPlatePng("white-solid", 1280, 720));
  const idea = (id, overrides = {}) => ({ setId: "synthetic-set", id, scene: "合成の店先", composition: "寄りの二人", beat: "発覚の瞬間", payload: ["人物A", "封筒"], ...overrides });
  const candidate = (id, ideaOverrides = {}, planOverrides = {}) => ({ plan: preflightPlan({ idea: idea(id, ideaOverrides), ...planOverrides }) });

  const same = await auditThumbnailIdeaSet({ rules, plans: [candidate("a"), candidate("b")], projectDir });
  assert.equal(same.pass, false);
  assert.ok(same.failures.some((line) => line.startsWith("thumbnail-ideas-not-distinct:a:b:")));
  // 書体の差は軸に数えない。宣言に書けば落とす。
  const typeface = await auditThumbnailIdeaSet({ rules, plans: [candidate("a"), candidate("b", { typeface: "別の書体" })], projectDir });
  assert.ok(typeface.failures.some((line) => line.startsWith("b: thumbnail-idea-non-reading-axis:typeface")));
  assert.ok(typeface.failures.some((line) => line.startsWith("thumbnail-ideas-not-distinct:a:b:")));
  // 場面が違えば別の案。
  const distinct = await auditThumbnailIdeaSet({ rules, plans: [candidate("a"), candidate("b", { scene: "合成の駅前" })], projectDir });
  assert.equal(distinct.pass, true, distinct.failures.join("\n"));
  assert.deepEqual(distinct.pairs[0].distinctAxes, ["scene"]);
  // final で同じ画・同じ吹き出しの数なら、宣言した場面が違っても同じ案。
  const finalOf = (id, ideaOverrides, artwork, bubbles = []) => candidate(id, ideaOverrides, { stage: "final", artworkPaths: [artwork], speechBubbles: bubbles });
  const sameArt = await auditThumbnailIdeaSet({ rules, plans: [finalOf("a", {}, art), finalOf("b", { scene: "合成の駅前" }, art)], projectDir });
  assert.ok(sameArt.failures.some((line) => line.startsWith("thumbnail-ideas-same-artwork:a:b:")));
  // 同じ画でも吹き出しの数が違えば別の案として読める。
  const moreBubbles = await auditThumbnailIdeaSet({
    rules, plans: [finalOf("a", {}, art), finalOf("b", {}, art, [{ panelId: "main", lines: ["合成"] }])], projectDir,
  });
  assert.equal(moreBubbles.pass, true, moreBubbles.failures.join("\n"));
  const differentArt = await auditThumbnailIdeaSet({ rules, plans: [finalOf("a", {}, art), finalOf("b", { beat: "和解の後" }, artOther)], projectDir });
  assert.equal(differentArt.pass, true, differentArt.failures.join("\n"));
  const single = await auditThumbnailIdeaSet({ rules, plans: [candidate("a")], projectDir });
  assert.ok(single.failures.some((line) => line.startsWith("thumbnail-ideas-too-few")));
  const mixedSets = await auditThumbnailIdeaSet({ rules, plans: [candidate("a"), candidate("b", { setId: "other-set", scene: "合成の駅前" })], projectDir });
  assert.ok(mixedSets.failures.some((line) => line.startsWith("thumbnail-ideas-mixed-sets")));
});

test("Windows のパス: プロジェクトと作業フォルダの包含を区切りに依らず判定する", () => {
  const win = path.win32;
  const project = "C:\\Users\\example\\project";
  assert.equal(insideProject(project, win.join(project, "canvas", "thumbs", "a.png"), { pathApi: win }), true);
  assert.equal(insideProject(project, project, { pathApi: win }), true);
  assert.equal(insideProject(project, "C:\\Users\\example\\projectX\\a.png", { pathApi: win }), false);
  assert.equal(insideProject(project, "D:\\project\\a.png", { pathApi: win }), false);
  assert.equal(insideProject(project, win.join(project, "..", "a.png"), { pathApi: win }), false);
  const canvas = win.join(project, "canvas");
  assert.equal(insideWorkDir(canvas, win.join(canvas, "thumbs", "a.png"), { pathApi: win }), true);
  assert.equal(insideWorkDir(canvas, canvas, { pathApi: win }), false);
  assert.equal(insideWorkDir(canvas, "D:\\canvas\\a.png", { pathApi: win }), false);
  // POSIX も同じ判定。
  assert.equal(insideProject("/srv/project", path.posix.join("/srv/project", "canvas", "a.png"), { pathApi: path.posix }), true);
  assert.equal(insideProject("/srv/project", "/srv/project-other/a.png", { pathApi: path.posix }), false);
});

test("漫画: 計画に Job の結び付けや文字の設計を足せば同じ検査が効き、契約の commonChecks で必須にできる", async (t) => {
  const projectDir = await tempProject(t);
  const authority = await readKoyaChannelAuthority({ allowFixture: true, projectDir, runtimeRoot: root });
  const contract = structuredClone(authority.thumbnailContract);
  contract.visual.bandColorToken = "band-synthetic-v1";
  contract.visual.bandFontToken = "font-synthetic-v1";
  const rules = koyaThumbnailRules(contract);
  assert.equal(rules.harnessId, "koya-manga-video");
  assert.deepEqual(Object.fromEntries(Object.entries(rules.layouts).map(([id, spec]) => [id, spec.panels])), { twoPanel: 2, threePanel: 3 });
  assert.equal(rules.layouts.threePanel.reasonRequired, true);
  assert.equal(rules.lettering.required, false, "契約に節が無ければ今の検査のまま");
  const plan = {
    version: "koya-thumbnail-plan-v1",
    stage: "preflight",
    layout: "twoPanel",
    bandLines: ["合成の見出し", "二行目の合成"],
    speechBubbles: [],
    telops: [],
    exactTextApproved: true,
  };
  plan.textApproval = { approvedBy: "synthetic-approver", approvedAt: "2026-09-25T00:00:00.000Z", copySha256: koyaThumbnailCopySha256(plan) };
  const base = await auditKoyaThumbnailPlan({ projectDir, thumbnailContract: contract, plan });
  assert.equal(base.pass, true, base.failures.join("\n"));
  assert.deepEqual(Object.keys(base), ["version", "pass", "readyForGeneration", "readyForPublish", "contractStatus", "copySha256", "pendingTokens", "artwork", "videoFrames", "assetQuality", "failures", "warnings"]);

  const jobId = "video-koya-manga-video-0123456789abcdef";
  await writeJob(projectDir, { id: jobId, harnessId: "koya-manga-video", episodeId: "manga-synthetic-001", status: "running" });
  const bound = await auditKoyaThumbnailPlan({ projectDir, thumbnailContract: contract, plan: { ...plan, jobBinding: { jobId, episodeId: "manga-synthetic-001" } } });
  assert.equal(bound.pass, true, bound.failures.join("\n"));
  assert.equal(bound.jobBinding.verified, true);
  const wrongEpisode = await auditKoyaThumbnailPlan({ projectDir, thumbnailContract: contract, plan: { ...plan, jobBinding: { jobId, episodeId: "manga-synthetic-002" } } });
  assert.ok(wrongEpisode.failures.some((line) => line.startsWith("thumbnail-job-binding-episode-mismatch:manga-synthetic-002")));
  const narratedJob = "video-narrated-story-video-0123456789abcdef";
  await writeJob(projectDir, { id: narratedJob });
  const otherHarness = await auditKoyaThumbnailPlan({ projectDir, thumbnailContract: contract, plan: { ...plan, jobBinding: { jobId: narratedJob } } });
  assert.ok(otherHarness.failures.some((line) => line.startsWith("thumbnail-job-binding-harness-mismatch:narrated-story-video")));

  const strict = structuredClone(contract);
  strict.commonChecks = { lettering: true, jobBinding: true };
  const strictResult = await auditKoyaThumbnailPlan({ projectDir, thumbnailContract: strict, plan });
  assert.ok(strictResult.failures.some((line) => line.startsWith("thumbnail-lettering-required:band:")));
  assert.ok(strictResult.warnings.some((line) => line.startsWith("thumbnail-job-binding-required-at-final")));
  const unknownKey = structuredClone(contract);
  unknownKey.commonChecks = { skipEverything: true };
  assert.throws(() => koyaThumbnailRules(unknownKey), /unsupported keys: skipEverything/u);

  const legacyDraft = createKoyaThumbnailPlanDraft({ thumbnailContract: contract });
  assert.equal("jobBinding" in legacyDraft, false);
  const boundDraft = createKoyaThumbnailPlanDraft({ thumbnailContract: contract, jobBinding: { jobId, episodeId: "manga-synthetic-001" } });
  assert.deepEqual(boundDraft.jobBinding, { jobId, episodeId: "manga-synthetic-001", videoSha256: "" });
  assert.deepEqual(Object.keys(boundDraft).filter((key) => key !== "jobBinding"), Object.keys(legacyDraft));
});
