// 背景ボード取り込みのテスト用。場所・会話・審査者はすべて架空の汎用名で、
// 番組正本は合成 fixture（test/fixtures/channel-pack）の show bible を使う。
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditKoyaLocationAnchorReview,
  auditKoyaLocationReview,
  buildKoyaLocationBoardPlan,
  createKoyaLocationAnchorReviewDraft,
  createKoyaLocationReviewDraft,
  importKoyaLocationBoards,
  koyaLocationAssetQualitySubjectId,
  readKoyaChannelAuthority,
  registerApprovedKoyaLocation,
} from "../../lib/koyaChannelGovernance.mjs";
import { renderEditorialPlatePng } from "../../lib/mangaScriptImagePipeline.mjs";
import { passKoyaAssetQualityLoop } from "./koyaAssetQualityFixture.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureConfigDir = join(repositoryRoot, "test", "fixtures", "channel-pack", "config");

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const REVIEW_CONTRACT = Object.freeze({
  version: "koya-location-review-v3",
  anchorReviewVersion: "koya-location-anchor-review-v1",
  generationManifestVersion: "koya-location-generation-v2",
  requireGenerationManifestSha256: true,
  requireAnchorReviewBeforeContinuity: true,
  requireIndependentReviewerContext: true,
  requireOriginalScaleReview: true,
  minimumWidth: 1280,
  minimumHeight: 720,
  requireDistinctSha256PerBoard: true,
  requiredChecks: [
    "containsPeopleFalse",
    "readableTextAbsent",
    "realBrandsAbsent",
    "architectureLockPass",
    "originalScalePass",
    "crossViewArchitectureContinuity",
  ],
});

export function syntheticLocationBible() {
  return {
    version: "koya-location-bible-v1",
    reviewContract: structuredClone(REVIEW_CONTRACT),
    locations: [
      {
        id: "sample-cafe",
        name: "喫茶店・見本",
        status: "spec-approved-image-pending",
        aliases: ["喫茶店"],
        architectureLock: ["角地に建つ平屋の店舗", "通りに面した一枚の大窓", "右奥に配膳台と厨房への出入口"],
        materialPalette: ["漆喰で塗った白い壁面", "使い込んだ真鍮の金具", "深緑の布張り椅子"],
        requiredBoards: ["扉を押して入った直後の目線", "配膳台の側から客席を見渡す", "大窓の内側から通りを見る", "机と椅子の位置を示す俯瞰図"],
        generationRules: ["人やその影を描き込まない", "読み取れる文字を置かない", "現実の企業名や商標を出さない"],
      },
      {
        id: "sample-street",
        name: "商店街・見本",
        status: "spec-approved-image-pending",
        textPolicy: "fictional-signage-allowed",
        aliases: ["商店街", "駅前の商店街"],
        architectureLock: ["天蓋で覆われた一本道", "左右に間口の狭い店舗が連なる", "突き当たりで緩やかに右へ折れる"],
        materialPalette: ["色あせた日よけの布", "継ぎ接ぎに補修した舗装", "吊り下げ式の白熱灯"],
        requiredBoards: ["通りの中央に立った広い画", "入口側から突き当たりを望む", "突き当たりから入口側を振り返る", "昼と夜で変わる光の対比図"],
        generationRules: ["人やその影を描き込まない", "現実に存在する地名や商標を出さない", "架空の店名は小さく控えめに"],
      },
    ],
  };
}

/** 合成 show bible と合成 location bible だけを持つ、独立したプロジェクトを作る。 */
export async function installSyntheticKoyaAuthority(projectDir, { locationBible = syntheticLocationBible() } = {}) {
  await mkdir(join(projectDir, "config"), { recursive: true });
  await cp(fixtureConfigDir, join(projectDir, "config"), { recursive: true });
  await writeFile(join(projectDir, "config", "koya-location-bible.json"), `${JSON.stringify(locationBible, null, 2)}\n`);
  await mkdir(join(projectDir, "canvas"), { recursive: true });
  return readSyntheticKoyaAuthority(projectDir);
}

/**
 * 開発機では BUZZASSIST_CHANNEL_PACK が本物の pack を指していることがある。
 * そちらに引っ張られないよう、プロジェクト直下の正本だけを読む。
 */
export function readSyntheticKoyaAuthority(projectDir) {
  return readKoyaChannelAuthority({ projectDir, directProjectAuthority: true });
}

export function boardPng(label, width = 1280, height = 720) {
  // 同じ絵でも末尾の目印で SHA を変える（PNG としては IEND 以降を読まない）。
  return Buffer.concat([renderEditorialPlatePng("white-solid", width, height), Buffer.from(`synthetic-board:${label}`)]);
}

export const IMPORTER = Object.freeze({ host: "claude", id: "import-operator", contextId: "session-import-operator" });
export const CHAT_CONTEXT = "https://chat.example.invalid/c/synthetic-conversation";

/**
 * チャット型画像ツールで作った想定の4枚・プロンプト・参照画像を sourceDir に置き、
 * koya-location-import-map-v1 のマップを書く。mutate で1か所だけ壊して拒否を試せる。
 */
export async function writeSyntheticImport({ authority, locationId, sourceDir, outputDir = "", mutate = null, labelSuffix = "" }) {
  const plan = buildKoyaLocationBoardPlan({
    projectDir: authority.projectDir,
    locationBible: authority.locationBible,
    showBible: authority.showBible,
    locationId,
    outputDir,
  });
  await mkdir(sourceDir, { recursive: true });
  const styleBytes = boardPng(`style-${locationId}`, 64, 64);
  const stylePath = join(sourceDir, "style-reference.png");
  await writeFile(stylePath, styleBytes);
  const promptPath = join(sourceDir, "continuity-prompt.txt");
  const promptFileText = `同じ場所を別の角度から描く（${locationId}）。人物は描かない。\n`;
  await writeFile(promptPath, promptFileText);
  const sources = [];
  for (const [index, job] of plan.jobs.entries()) {
    const bytes = boardPng(`${locationId}-${index + 1}${labelSuffix}`);
    const path = join(sourceDir, `download-${index + 1}.png`);
    await writeFile(path, bytes);
    sources.push({ path, sha256: sha256(bytes), job });
  }
  const anchor = sources[0];
  const boards = sources.map((source, index) => {
    const board = {
      ...(index % 2 === 0 ? { boardIndex: index + 1 } : { boardLabel: source.job.boardLabel }),
      sourcePath: index === 0 ? source.path : `./download-${index + 1}.png`,
      sourceSha256: source.sha256,
      generator: {
        host: "chat-web-image-tool",
        id: "synthetic-image-model",
        contextId: index === 0 ? CHAT_CONTEXT : `${CHAT_CONTEXT}-view-${index + 1}`,
        generatedAt: `2026-09-1${index}T09:00:00.000Z`,
      },
      referenceImages: index === 0
        ? [{ path: stylePath, sha256: sha256(styleBytes), role: "style" }]
        : [{ path: anchor.path, sha256: anchor.sha256, role: "anchor" }],
    };
    if (index === 3) {
      board.promptPath = "continuity-prompt.txt";
      board.promptSha256 = sha256(promptFileText);
    } else {
      board.promptText = `Draw the ${source.job.boardLabel} view of a fictional place. No people.`;
    }
    if (index === 2) board.note = "operator chose this take from four variations";
    return board;
  });
  const map = {
    version: "koya-location-import-map-v1",
    locationId,
    importedBy: { ...IMPORTER },
    boards,
  };
  if (typeof mutate === "function") await mutate({ map, sources, sourceDir, plan });
  const mapPath = join(sourceDir, "import-map.json");
  await writeFile(mapPath, `${JSON.stringify(map, null, 2)}\n`);
  return { mapPath, map, plan, sources, stylePath, promptPath };
}

// 「その絵が満たすべき文書」の見本。合成 location bible の1件目と同じ言い方に揃える。
export const SPECIFICATION_TEXT = [
  "# 配置表（見本）",
  "",
  "- 入口は画面の左手前、配膳台は右奥。",
  "- 通りに面した大窓は一枚だけ。",
  "- 人物は描かない。",
  "",
].join("\n");

/**
 * 記録が残っていないボードを1枚作る mutate。既定はプロンプトと会話 id を落とし、
 * 代わりに「その絵が満たすべき文書」と provenanceGap を書く。
 * flags で、どの記録が残っていないかを選べる（旗はボードごとに独立）。
 * override で、混在・記録ありの主張・未知キー・SHA 不一致を1か所だけ壊せる。
 */
export const PROVENANCE_GAP_FLAG_ORDER = Object.freeze([
  "promptRecorded",
  "generatorContextRecorded",
  "referenceImagesRecorded",
]);

export function declareProvenanceGap({
  boardNumber = 2,
  flags = ["promptRecorded", "generatorContextRecorded"],
  reason = "このボードはプロンプトと会話 id を残す決まりより前に作られ、どちらも残っていない",
  specificationName = "set-plan.md",
  specificationText = SPECIFICATION_TEXT,
  writeSpecification = true,
  override = null,
} = {}) {
  const declared = new Set(flags);
  return async ({ map, sourceDir }) => {
    const specificationPath = join(sourceDir, specificationName);
    if (writeSpecification) await writeFile(specificationPath, specificationText);
    const board = map.boards[boardNumber - 1];
    if (declared.has("promptRecorded")) {
      delete board.promptText;
      delete board.promptPath;
      delete board.promptSha256;
    }
    if (declared.has("generatorContextRecorded")) delete board.generator.contextId;
    // 参照の記録が無いボードは、アンカー参照も含めて1枚も並べない。
    if (declared.has("referenceImagesRecorded")) board.referenceImages = [];
    board.provenanceGap = {
      ...Object.fromEntries(PROVENANCE_GAP_FLAG_ORDER.filter((flag) => declared.has(flag)).map((flag) => [flag, false])),
      reason,
      specificationPath: `./${specificationName}`,
      specificationSha256: sha256(specificationText),
    };
    if (typeof override === "function") override({ board, map, specificationPath });
  };
}

export function passAnchorChecks(review) {
  review.anchor.checks = Object.fromEntries(Object.keys(review.anchor.checks).map((key) => [key, true]));
  return review;
}

export function passBoardChecks(review) {
  review.checks = { crossViewArchitectureContinuity: true, originalScaleReview: true };
  for (const board of review.boards) board.checks = Object.fromEntries(Object.keys(board.checks).map((key) => [key, true]));
  return review;
}

/**
 * 契約 v54 から、登録する4枚のボードはそれぞれ場所（location）工程の品質ループの合格が要る。
 * 審査済みのボードごとに、合成の評価者でループを合格させる。
 */
export async function passSyntheticLocationLoops({ projectDir, authority, locationId, review, outputDir = "" }) {
  const audit = await auditKoyaLocationReview({ projectDir, locationBible: authority.locationBible, showBible: authority.showBible, locationId, outputDir, review });
  if (!audit.pass) throw new Error(`synthetic final review failed:\n- ${audit.failures.join("\n- ")}`);
  for (const row of audit.rows) {
    await passKoyaAssetQualityLoop({
      workDir: join(projectDir, "canvas"),
      stage: "location",
      subjectId: koyaLocationAssetQualitySubjectId(locationId, row.boardId),
      assetPath: row.path,
    });
  }
  return audit;
}

/**
 * 取り込み → アンカー下書き → 独立したアンカー審査 → 本審査の下書き → 独立した本審査 → 登録。
 * 公式 CLI と同じ関数だけを使う。
 */
export async function importAndRegisterSyntheticLocation({ projectDir, authority, locationId, sourceDir, outputDir = "", mutate = null, passAssetQuality = true, register = true }) {
  const common = { projectDir, locationBible: authority.locationBible, showBible: authority.showBible, locationId, outputDir };
  const prepared = await writeSyntheticImport({ authority, locationId, sourceDir, outputDir, mutate });
  const imported = await importKoyaLocationBoards({ authority, locationId, importMapPath: prepared.mapPath, outputDir });
  const reviewsDir = join(projectDir, "canvas", "reviews");
  await mkdir(reviewsDir, { recursive: true });
  const anchorReview = passAnchorChecks(await createKoyaLocationAnchorReviewDraft(common));
  anchorReview.reviewer = { host: "codex", id: "anchor-reviewer", contextId: "session-anchor-reviewer" };
  anchorReview.reviewedAt = "2026-09-18T01:00:00.000Z";
  const anchorReviewPath = join(reviewsDir, `${locationId}-anchor.json`);
  await writeFile(anchorReviewPath, `${JSON.stringify(anchorReview, null, 2)}\n`);
  const anchorAudit = await auditKoyaLocationAnchorReview({ ...common, review: anchorReview });
  if (!anchorAudit.pass) throw new Error(`synthetic anchor review failed:\n- ${anchorAudit.failures.join("\n- ")}`);
  const review = passBoardChecks(await createKoyaLocationReviewDraft({ ...common, anchorReviewPath }));
  review.reviewer = { host: "codex", id: "final-reviewer", contextId: "session-final-reviewer" };
  review.reviewedAt = "2026-09-18T02:00:00.000Z";
  const reviewPath = join(reviewsDir, `${locationId}-final.json`);
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
  const audit = await auditKoyaLocationReview({ ...common, review });
  if (!audit.pass) throw new Error(`synthetic final review failed:\n- ${audit.failures.join("\n- ")}`);
  if (passAssetQuality) await passSyntheticLocationLoops({ projectDir, authority, locationId, review, outputDir });
  if (!register) return { prepared, imported, anchorReview, anchorReviewPath, review, reviewPath, audit };
  const registered = await registerApprovedKoyaLocation({ authority, projectDir, locationId, reviewPath });
  return { prepared, imported, anchorReview, anchorReviewPath, review, reviewPath, audit, registered };
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
