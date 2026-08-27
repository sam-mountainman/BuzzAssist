import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

import { resolveCanvasDir, writeJsonAtomic } from "./canvasScene.mjs";

export const KOYA_CHARACTER_ROSTER_REVIEW_VERSION = "koya-character-roster-review-v1";

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function escapeXml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256Path(path) {
  return sha256(await readFile(resolve(path)));
}

function imageMime(path) {
  const extension = extname(path).toLowerCase();
  if ([".jpg", ".jpeg"].includes(extension)) return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "image/png";
}

function registryCharacterForMember(registry, member) {
  const memberNames = new Set([member.id, member.name, member.hiddenName].map(nonEmpty).filter(Boolean));
  return (registry?.characters || []).find((character) => character?.kind === "character" && character?.status === "approved" && (
    memberNames.has(character.id)
    || memberNames.has(character.name)
    || (character.aliases || []).some((alias) => memberNames.has(alias))
  )) || null;
}

function resolveRegistryAssetPath(canvasDir, path) {
  const value = nonEmpty(path);
  return isAbsolute(value) ? resolve(value) : resolve(canvasDir, value);
}

export function resolveKoyaCharacterRosterReviewPaths(args = {}) {
  const root = join(resolveCanvasDir(args), "character-roster-reviews", "koya-fixed-cast");
  return {
    root,
    sheetPath: join(root, "roster-contact-sheet.svg"),
    reviewPath: join(root, "roster-review.json"),
  };
}

async function collectRoster({ canvasDir, showBible, registry }) {
  const members = Array.isArray(showBible?.cast) ? showBible.cast : [];
  const rows = [];
  const blockers = [];
  for (const member of members) {
    const character = registryCharacterForMember(registry, member);
    if (!character) {
      blockers.push(`${member.name}: approved character registry entry is missing.`);
      continue;
    }
    const faceAssets = (character.referenceAssets || []).filter((asset) => asset.role === "identity-face");
    if (faceAssets.length !== 1) {
      blockers.push(`${member.name}: exactly one approved identity-face asset is required.`);
      continue;
    }
    const face = faceAssets[0];
    const path = resolveRegistryAssetPath(canvasDir, face.path);
    let actualSha256 = "";
    try { actualSha256 = await sha256Path(path); } catch (error) { blockers.push(`${member.name}: identity-face is unreadable (${error.message}).`); continue; }
    if (!/^[a-f0-9]{64}$/u.test(nonEmpty(face.sha256)) || face.sha256 !== actualSha256) {
      blockers.push(`${member.name}: identity-face SHA-256 does not match disk.`);
      continue;
    }
    const identityReviewPath = nonEmpty(character?.approval?.identityReviewPath);
    const identityReviewSha256 = nonEmpty(character?.approval?.identityReviewSha256);
    let actualReviewSha256 = "";
    try { actualReviewSha256 = identityReviewPath ? await sha256Path(identityReviewPath) : ""; } catch (error) { blockers.push(`${member.name}: identity review is unreadable (${error.message}).`); continue; }
    if (!identityReviewPath || !/^[a-f0-9]{64}$/u.test(identityReviewSha256) || identityReviewSha256 !== actualReviewSha256) {
      blockers.push(`${member.name}: identity review path/SHA-256 provenance is incomplete.`);
      continue;
    }
    rows.push({
      showCharacterId: member.id,
      name: member.name,
      role: nonEmpty(member.role),
      registryCharacterId: character.id,
      identityFace: { path, sha256: actualSha256 },
      identityReview: { path: resolve(identityReviewPath), sha256: identityReviewSha256 },
    });
  }
  if (members.length !== 11) blockers.push(`Show bible must contain exactly 11 fixed-cast members; got ${members.length}.`);
  if (rows.length !== members.length && blockers.length === 0) blockers.push("Roster collection did not cover every fixed-cast member.");
  return { rows, blockers };
}

async function composeRosterSheet(rows, sheetPath) {
  const columns = 4;
  const cardWidth = 560;
  const cardHeight = 500;
  const margin = 38;
  const headerHeight = 135;
  const width = margin * 2 + columns * cardWidth;
  const height = headerHeight + margin + Math.ceil(rows.length / columns) * cardHeight + margin;
  const cards = [];
  for (const [index, row] of rows.entries()) {
    const bytes = await readFile(row.identityFace.path);
    const data = `data:${imageMime(row.identityFace.path)};base64,${bytes.toString("base64")}`;
    const x = margin + (index % columns) * cardWidth;
    const y = headerHeight + margin + Math.floor(index / columns) * cardHeight;
    cards.push(`<g transform="translate(${x} ${y})"><rect width="${cardWidth - 18}" height="${cardHeight - 18}" rx="15" fill="#fff" stroke="#222" stroke-width="3"/><text x="22" y="38" font-family="sans-serif" font-size="25" font-weight="700">${escapeXml(`${index + 1}. ${row.name}`)}</text><text x="22" y="65" font-family="sans-serif" font-size="16" fill="#555">${escapeXml(row.role)}</text><image x="18" y="78" width="${cardWidth - 54}" height="${cardHeight - 122}" preserveAspectRatio="xMidYMid meet" href="${data}"/></g>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#f4f1eb"/><text x="${margin}" y="48" font-family="sans-serif" font-size="34" font-weight="700">漫画動画ハーネス固定キャスト11人｜ロスター同時QA</text><text x="${margin}" y="84" font-family="sans-serif" font-size="20" fill="#333">同一カード寸法で、シルエット・年齢読み・役柄読み・髪/衣装色衝突・サムネ縮小時の識別性を確認</text><text x="${margin}" y="116" font-family="sans-serif" font-size="19" font-weight="700" fill="#8a1c13">未承認：全55ペアの独立レビュー完了前は本編使用不可</text>${cards.join("")}</svg>`;
  await mkdir(dirname(sheetPath), { recursive: true });
  await writeFile(sheetPath, svg, "utf8");
}

function reviewTemplate({ rows, sheetPath, sheetSha256, generator }) {
  return {
    version: KOYA_CHARACTER_ROSTER_REVIEW_VERSION,
    phase: "fixed-cast-roster",
    generator,
    reviewer: { host: "", id: "", contextId: "", reviewedAt: "" },
    originalScaleInspected: false,
    thumbnailScaleInspected: false,
    rosterSheet: { path: sheetPath, sha256: sheetSha256 },
    members: rows.map((row) => ({
      ...row,
      checks: { silhouetteReadable: false, ageReadDistinct: false, roleReadDistinct: false, thumbnailScaleReadable: false },
      pass: false,
      note: "",
    })),
    pairChecks: rows.flatMap((left, index) => rows.slice(index + 1).map((right) => ({
      pairId: [left.showCharacterId, right.showCharacterId].sort().join("::"),
      memberIds: [left.showCharacterId, right.showCharacterId].sort(),
      silhouetteDistinct: false,
      faceAgeRoleDistinct: false,
      hairOutfitColorNotConfusing: false,
      thumbnailScaleDistinct: false,
      originalScaleInspected: false,
      thumbnailScaleInspected: false,
      pass: false,
      note: "",
    }))),
    pass: false,
    note: "",
  };
}

export async function createKoyaCharacterRosterReviewDraft(args = {}) {
  const canvasDir = resolveCanvasDir(args);
  const generator = {
    host: nonEmpty(args.generatorHost),
    id: nonEmpty(args.generatorId),
    contextId: nonEmpty(args.generatorContextId),
    composedAt: new Date().toISOString(),
  };
  if (!generator.host || !generator.id || !generator.contextId) throw new Error("Roster review draft requires generatorHost, generatorId, and generatorContextId provenance.");
  const collected = await collectRoster({ canvasDir, showBible: args.showBible, registry: args.registry });
  if (collected.blockers.length > 0) return { ready: false, blockers: collected.blockers, approvedMemberCount: collected.rows.length, requiredMemberCount: 11 };
  const paths = resolveKoyaCharacterRosterReviewPaths({ ...args, canvasDir });
  await composeRosterSheet(collected.rows, paths.sheetPath);
  const draft = reviewTemplate({ rows: collected.rows, sheetPath: paths.sheetPath, sheetSha256: await sha256Path(paths.sheetPath), generator });
  await writeJsonAtomic(paths.reviewPath, draft);
  return { ready: true, blockers: [], approvedMemberCount: collected.rows.length, requiredMemberCount: 11, sheetPath: paths.sheetPath, reviewPath: paths.reviewPath, sheetSha256: draft.rosterSheet.sha256 };
}

export async function auditKoyaCharacterRosterReview(args = {}) {
  const canvasDir = resolveCanvasDir(args);
  const collected = await collectRoster({ canvasDir, showBible: args.showBible, registry: args.registry });
  const failures = [...collected.blockers];
  const reviewPath = resolve(nonEmpty(args.reviewPath) || resolveKoyaCharacterRosterReviewPaths({ ...args, canvasDir }).reviewPath);
  let review = null;
  try { review = JSON.parse(await readFile(reviewPath, "utf8")); } catch (error) { failures.push(`Roster review is missing or unreadable: ${error.message}`); }
  if (!review) return { version: KOYA_CHARACTER_ROSTER_REVIEW_VERSION, pass: false, reviewPath, approvedMemberCount: collected.rows.length, requiredMemberCount: 11, failures };
  if (review.version !== KOYA_CHARACTER_ROSTER_REVIEW_VERSION || review.phase !== "fixed-cast-roster") failures.push(`Roster review must use ${KOYA_CHARACTER_ROSTER_REVIEW_VERSION}.`);
  const generator = review.generator || {};
  const reviewer = review.reviewer || {};
  for (const key of ["host", "id", "contextId", "composedAt"]) if (!nonEmpty(generator[key])) failures.push(`generator.${key} is required.`);
  for (const key of ["host", "id", "contextId", "reviewedAt"]) if (!nonEmpty(reviewer[key])) failures.push(`reviewer.${key} is required.`);
  if (nonEmpty(generator.contextId) && nonEmpty(generator.contextId) === nonEmpty(reviewer.contextId)) failures.push("Roster reviewer context must differ from the sheet composer context.");
  if (review.originalScaleInspected !== true || review.thumbnailScaleInspected !== true) failures.push("Roster review requires both original-scale and thumbnail-scale inspection.");
  let sheetSha256 = "";
  try { sheetSha256 = await sha256Path(review?.rosterSheet?.path); } catch (error) { failures.push(`Roster sheet is unreadable: ${error.message}`); }
  if (resolve(nonEmpty(review?.rosterSheet?.path)) !== resolveKoyaCharacterRosterReviewPaths({ ...args, canvasDir }).sheetPath || nonEmpty(review?.rosterSheet?.sha256) !== sheetSha256) failures.push("Roster sheet path/SHA-256 does not match current bytes.");
  const rows = Array.isArray(review.members) ? review.members : [];
  if (rows.length !== collected.rows.length || rows.length !== 11) failures.push("Roster review must cover all 11 current approved members.");
  for (const current of collected.rows) {
    const row = rows.find((entry) => entry?.showCharacterId === current.showCharacterId);
    if (!row || row.name !== current.name || row.registryCharacterId !== current.registryCharacterId || JSON.stringify(row.identityFace) !== JSON.stringify(current.identityFace) || JSON.stringify(row.identityReview) !== JSON.stringify(current.identityReview)) {
      failures.push(`${current.name}: roster member evidence does not match the current approved registry.`);
      continue;
    }
    for (const key of ["silhouetteReadable", "ageReadDistinct", "roleReadDistinct", "thumbnailScaleReadable"]) if (row?.checks?.[key] !== true) failures.push(`${current.name}.checks.${key} must be true.`);
    if (row.pass !== true || nonEmpty(row.note).length < 4) failures.push(`${current.name}: pass and a concrete note are required.`);
  }
  const pairs = Array.isArray(review.pairChecks) ? review.pairChecks : [];
  const expectedPairs = collected.rows.flatMap((left, index) => collected.rows.slice(index + 1).map((right) => [left.showCharacterId, right.showCharacterId].sort().join("::")));
  if (pairs.length !== 55 || new Set(pairs.map((pair) => pair?.pairId)).size !== 55) failures.push("Roster review must contain exactly 55 unique pair checks.");
  for (const pairId of expectedPairs) {
    const pair = pairs.find((entry) => entry?.pairId === pairId);
    if (!pair) { failures.push(`Roster pair ${pairId} is missing.`); continue; }
    for (const key of ["silhouetteDistinct", "faceAgeRoleDistinct", "hairOutfitColorNotConfusing", "thumbnailScaleDistinct", "originalScaleInspected", "thumbnailScaleInspected"]) if (pair[key] !== true) failures.push(`Roster pair ${pairId}.${key} must be true.`);
    if (pair.pass !== true || nonEmpty(pair.note).length < 4) failures.push(`Roster pair ${pairId} requires pass and a concrete note.`);
  }
  if (review.pass !== true || nonEmpty(review.note).length < 4) failures.push("Roster review final pass and note are required.");
  return { version: KOYA_CHARACTER_ROSTER_REVIEW_VERSION, pass: failures.length === 0, reviewPath, approvedMemberCount: collected.rows.length, requiredMemberCount: 11, sheetPath: nonEmpty(review?.rosterSheet?.path), sheetSha256, failures };
}
