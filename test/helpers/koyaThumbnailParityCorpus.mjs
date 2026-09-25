// 漫画（Koya）のサムネの計画・検査の出力が、共通層（lib/thumbnailPlan.mjs）へ寄せる前後で変わらないことを
// 確かめるための入力の束。検査・下書き・文言の SHA・品質ループの対象 id を、同じ入力で走らせて出力を集める。
//
// 出力に入る一時フォルダの絶対パスは <project> / <outside> に置き換える（端末ごとに違うため）。
// 人名・文言・画はすべて合成の値（台本・チャンネルの文は使わない）。
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderEditorialPlatePng } from "../../lib/mangaScriptImagePipeline.mjs";
import { legacyKoyaContract, passKoyaAssetQualityLoop } from "./koyaAssetQualityFixture.mjs";

const FINAL_CHECKS = Object.freeze({
  original1280x720: true,
  mobile320x180: true,
  textCropZero: true,
  faceCropZero: true,
  primaryEmotionReadable: true,
  approvedCharacterReferencesOnly: true,
  realLogoZero: true,
});

function replaceAllText(value, from, to) {
  return from ? value.split(from).join(to) : value;
}

function normalize(value, replacements) {
  let text = JSON.stringify(value);
  for (const [from, to] of replacements) {
    // JSON 文字列の中では "\" が "\\" になる（Windows の区切り）。両方を置き換える。
    text = replaceAllText(text, JSON.stringify(from).slice(1, -1), to);
    text = replaceAllText(text, from, to);
  }
  return JSON.parse(text);
}

async function capture(action) {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

/**
 * impl: { audit, draft, copySha256, subjectId, readAuthority }
 *   audit      = auditKoyaThumbnailPlan
 *   draft      = createKoyaThumbnailPlanDraft
 *   copySha256 = koyaThumbnailCopySha256
 *   subjectId  = koyaThumbnailAssetQualitySubjectId
 *   readAuthority = readKoyaChannelAuthority
 */
export async function runKoyaThumbnailParityCorpus(impl, { root } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "koya-thumb-parity-")));
  const projectDir = join(base, "project");
  const outsideDir = join(base, "outside");
  const results = {};
  try {
    await mkdir(join(projectDir, "canvas", "thumbs"), { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    const authority = await impl.readAuthority({ allowFixture: true, projectDir, runtimeRoot: root });
    const pending = authority.thumbnailContract;
    const approved = structuredClone(pending);
    approved.visual.bandColorToken = "band-synthetic-v1";
    approved.visual.bandFontToken = "font-synthetic-v1";
    const halfPending = structuredClone(pending);
    halfPending.visual.bandColorToken = "band-synthetic-v1";
    const wideReuse = structuredClone(approved);
    wideReuse.sourcePolicy.normalizedGray32MaximumReuseDistance = 0.9;
    const legacy = await legacyKoyaContract(root);

    const thumbs = join(projectDir, "canvas", "thumbs");
    const artA = join(thumbs, "idea-a-v1.png");
    const artB = join(thumbs, "idea-b-v1.png");
    const artC = join(thumbs, "合成の案-v1.png");
    const frameSame = join(thumbs, "frame-same.png");
    const frameNear = join(thumbs, "frame-near.png");
    const frameOther = join(thumbs, "frame-other.png");
    const missing = join(thumbs, "missing.png");
    const outsideArt = join(outsideDir, "outside.png");
    await writeFile(artA, renderEditorialPlatePng("black-solid", 1280, 720));
    await writeFile(artB, renderEditorialPlatePng("white-solid", 1280, 720));
    await writeFile(artC, renderEditorialPlatePng("pastel-sky", 1280, 720));
    await writeFile(frameSame, renderEditorialPlatePng("black-solid", 1280, 720));
    await writeFile(frameNear, renderEditorialPlatePng("black-solid", 640, 360));
    await writeFile(frameOther, renderEditorialPlatePng("pastel-sky", 1280, 720));
    await writeFile(outsideArt, renderEditorialPlatePng("white-solid", 1280, 720));

    const basePlan = () => ({
      version: "koya-thumbnail-plan-v1",
      stage: "preflight",
      layout: "twoPanel",
      bandLines: ["合成の見出し", "二行目の合成"],
      speechBubbles: [{ panelId: "left", lines: ["合成台詞"] }],
      telops: [{ text: "合成語", concreteNounReviewPassed: true }],
      exactTextApproved: true,
    });
    // 形の崩れた入力では文言の SHA が例外になる（旧実装の振る舞い）。そのときは空の SHA で承認を置く。
    const safeCopySha256 = (plan) => {
      try { return impl.copySha256(plan); } catch { return ""; }
    };
    const approve = (plan) => ({
      ...plan,
      textApproval: { approvedBy: "synthetic-approver", approvedAt: "2026-09-25T00:00:00.000Z", copySha256: safeCopySha256(plan) },
    });
    const finalPlan = (overrides = {}) => approve({
      ...basePlan(),
      stage: "final",
      artworkPaths: [artA, artB],
      mainVideoFramePaths: [frameOther],
      checks: { ...FINAL_CHECKS },
      ...overrides,
    });

    const audits = [
      ["preflight-pending", pending, approve(basePlan())],
      ["preflight-half-pending", halfPending, approve(basePlan())],
      ["preflight-approved", approved, approve(basePlan())],
      ["preflight-no-plan", approved, undefined],
      ["preflight-string-plan", approved, "not-an-object"],
      ["wrong-version", approved, approve({ ...basePlan(), version: "koya-thumbnail-plan-v0" })],
      ["wrong-stage", approved, approve({ ...basePlan(), stage: "draft" })],
      ["wrong-layout", approved, approve({ ...basePlan(), layout: "fourPanel" })],
      ["three-panel-no-reason", approved, approve({ ...basePlan(), layout: "threePanel" })],
      ["three-panel-reason", approved, approve({ ...basePlan(), layout: "threePanel", thirdBeatReason: "合成の三つ目の場面" })],
      ["band-one-line", approved, approve({ ...basePlan(), bandLines: ["一行だけ"] })],
      ["band-three-lines", approved, approve({ ...basePlan(), bandLines: ["一", "二", "三"] })],
      ["band-empty-line", approved, approve({ ...basePlan(), bandLines: ["", "二行目"] })],
      ["band-too-long", approved, approve({ ...basePlan(), bandLines: ["一二三四五六七八九十一二三四五六", "二行目"] })],
      ["band-spaces-not-counted", approved, approve({ ...basePlan(), bandLines: ["一二三四五　六七八九十 一二三四五", "二行目"] })],
      ["band-missing", approved, approve({ ...basePlan(), bandLines: undefined })],
      // 形の崩れた入力（行が文字列）。旧実装は文言の SHA で例外になる。同じ振る舞いを保つ。
      ["band-string", approved, { ...basePlan(), bandLines: "見本", textApproval: { approvedBy: "synthetic-approver", approvedAt: "2026-09-25T00:00:00.000Z", copySha256: "" } }],
      ["forbidden-hooks", approved, approve({
        ...basePlan(),
        bandLines: ["見本の見出し", "試験と仮設"],
        speechBubbles: [{ panelId: "left", lines: ["架空1の台詞"] }],
        telops: [{ text: "見本", concreteNounReviewPassed: true }],
      })],
      ["bubbles-mixed", approved, approve({
        ...basePlan(),
        speechBubbles: [
          { lines: ["名無し"] },
          { panelId: "left", lines: ["一"] },
          { panelId: "left", lines: ["二"] },
          { panelId: "right", lines: [] },
          { panelId: "mid", lines: ["一", "二", "三"] },
          { panelId: "long", lines: ["一二三四五六七八九"] },
          { panelId: "", lines: ["空"] },
          { panelId: "none" },
        ],
      })],
      // 形の崩れた入力（台詞の行が文字列）。旧実装は文言の SHA で例外になる。
      ["bubbles-string-lines", approved, approve({ ...basePlan(), speechBubbles: [{ panelId: "bad", lines: "一" }] })],
      ["telops-mixed", approved, approve({
        ...basePlan(),
        telops: [
          { text: "一", concreteNounReviewPassed: true },
          { text: "一二三四五", concreteNounReviewPassed: true },
          { text: "合成語" },
          { concreteNounReviewPassed: true },
        ],
      })],
      ["not-approved", approved, { ...basePlan(), exactTextApproved: false }],
      ["approval-invalid-date", approved, { ...basePlan(), textApproval: { approvedBy: "synthetic-approver", approvedAt: "yesterday", copySha256: impl.copySha256(basePlan()) } }],
      ["approval-stale", approved, { ...basePlan(), textApproval: { approvedBy: "synthetic-approver", approvedAt: "2026-09-25T00:00:00.000Z", copySha256: "0".repeat(64) } }],
      ["preflight-with-artwork", approved, approve({ ...basePlan(), artworkPaths: [artA] })],
      ["final-legacy-pass", approved, finalPlan(), legacy],
      ["final-no-frames", approved, finalPlan({ mainVideoFramePaths: [] }), legacy],
      ["final-sha-reuse", approved, finalPlan({ mainVideoFramePaths: [frameSame] }), legacy],
      ["final-perceptual-reuse", approved, finalPlan({ mainVideoFramePaths: [frameNear] }), legacy],
      ["final-wide-reuse-distance", wideReuse, finalPlan({ mainVideoFramePaths: [frameOther] }), legacy],
      ["final-missing-artwork", approved, finalPlan({ artworkPaths: [artA, missing] }), legacy],
      ["final-outside-artwork", approved, finalPlan({ artworkPaths: [artA, outsideArt] }), legacy],
      ["final-three-panel-two-art", approved, finalPlan({ layout: "threePanel", thirdBeatReason: "合成の三つ目" }), legacy],
      ["final-three-panel-three-art", approved, finalPlan({ layout: "threePanel", thirdBeatReason: "合成の三つ目", artworkPaths: [artA, artB, artC] }), legacy],
      ["final-unknown-layout", approved, finalPlan({ layout: "x" }), legacy],
      ["final-checks-partial", approved, finalPlan({ checks: { ...FINAL_CHECKS, realLogoZero: false } }), legacy],
      ["final-checks-missing", approved, finalPlan({ checks: undefined }), legacy],
      ["final-artwork-not-array", approved, finalPlan({ artworkPaths: artA }), legacy],
      ["final-pending-tokens", pending, finalPlan(), legacy],
      ["final-v54-loop-not-started", approved, finalPlan({ artworkQualitySubjectIds: ["synthetic-parity-a", ""] })],
      ["final-v54-outside-artwork", approved, finalPlan({ artworkPaths: [artA, outsideArt] })],
      ["final-v54-missing-artwork", approved, finalPlan({ artworkPaths: [artA, missing] })],
    ];
    for (const [id, contract, plan, productionContract] of audits) {
      results[`audit:${id}`] = await capture(() => impl.audit({
        projectDir,
        thumbnailContract: contract,
        plan,
        ...(productionContract ? { productionContract } : {}),
      }));
    }

    // 品質ループ: 片方だけ合格、片方は人の確認待ち。
    const loopPlan = finalPlan({ artworkQualitySubjectIds: ["synthetic-parity-loop-a", "synthetic-parity-loop-b"] });
    const workDir = join(projectDir, "canvas");
    await passKoyaAssetQualityLoop({ workDir, stage: "thumbnail", subjectId: "synthetic-parity-loop-a", assetPath: artA });
    await passKoyaAssetQualityLoop({ workDir, stage: "thumbnail", subjectId: "synthetic-parity-loop-b", assetPath: artB, stopBefore: "human" });
    results["audit:final-v54-one-passed"] = await capture(() => impl.audit({ projectDir, thumbnailContract: approved, plan: loopPlan }));

    // 契約が壊れていれば例外（同じ文言）。
    const brokenCanvas = structuredClone(approved);
    brokenCanvas.canvas.width = 1920;
    const brokenBand = structuredClone(approved);
    brokenBand.copy.band.maxCharactersPerLine = 20;
    const brokenVersion = structuredClone(approved);
    brokenVersion.version = "koya-thumbnail-contract-v0";
    for (const [id, contract] of [["canvas", brokenCanvas], ["band", brokenBand], ["version", brokenVersion]]) {
      results[`audit:broken-contract-${id}`] = await capture(() => impl.audit({ projectDir, thumbnailContract: contract, plan: approve(basePlan()) }));
      results[`draft:broken-contract-${id}`] = await capture(() => impl.draft({ thumbnailContract: contract }));
    }

    for (const [id, contract, layout] of [
      ["pending-default", pending, undefined],
      ["approved-two", approved, "twoPanel"],
      ["approved-three", approved, "threePanel"],
      ["approved-unknown", approved, "fourPanel"],
    ]) {
      results[`draft:${id}`] = await capture(() => impl.draft({ thumbnailContract: contract, layout }));
    }

    for (const [id, plan] of [
      ["base", basePlan()],
      ["three", { ...basePlan(), layout: "threePanel", thirdBeatReason: " 合成 " }],
      ["empty", {}],
      ["telop-flags", { ...basePlan(), telops: [{ text: " 合成語 ", concreteNounReviewPassed: "yes" }] }],
    ]) {
      results[`copySha256:${id}`] = await capture(() => impl.copySha256(plan));
    }

    for (const [id, plan, index, path] of [
      ["explicit", { artworkQualitySubjectIds: ["synthetic-thumb-a"] }, 0, artA],
      ["explicit-blank", { artworkQualitySubjectIds: [" "] }, 0, artA],
      ["basename", {}, 1, artB],
      ["non-ascii", {}, 0, artC],
      ["empty", {}, 0, ""],
    ]) {
      results[`subjectId:${id}`] = await capture(() => impl.subjectId(plan, index, path));
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
  return normalize(results, [[projectDir, "<project>"], [outsideDir, "<outside>"], [base, "<base>"]]);
}
