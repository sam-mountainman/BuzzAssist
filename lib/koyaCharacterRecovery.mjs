import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

import { resolveCanvasDir, writeJsonAtomic } from "./canvasScene.mjs";
import {
  CHARACTER_IDENTITY_RECOVERY_VERSION,
  readCharacterRegistry,
} from "./characterRegistry.mjs";
import {
  REQUIRED_EXPRESSION_CELLS,
  REQUIRED_EYE_OPEN_CELLS,
  REQUIRED_OUTFIT_CELLS,
  REQUIRED_TURNAROUND_VIEWS,
  prepareIdentityPackReviewDraft,
} from "./characterIdentityReview.mjs";
import {
  castEyeOpenVariants,
  castNeedsEyeOpenVariant,
  findWorkflowCast,
  getCharacterWorkflow,
  readCharacterWorkflowStore,
  updateCharacterWorkflow,
  workflowStatusForCast,
} from "./characterPipeline.mjs";
import { UnsupportedPngError, decodePngPixels } from "./pngPixelDigest.mjs";

/**
 * 承認済みの人物の絵が消えた登録を、残っていた材料から取り戻して identity QA まで組む。
 *
 * 2026-10-18 に自動整理が canvas/assets を消し、登録簿は「承認済み」のまま参照先が
 * 無くなった。候補の取り込み（character-candidate-import）は承認済みの身元を置き換えられず、
 * refresh は消えた顔の SHA を照合できないので、どちらも使えない。ここでは、
 *
 * - 登録簿の参照先が「全部」実際に無いときだけ動く（1つでも残っていれば上書きしない）
 * - 顔は必ず取り戻した絵（生成した顔で身元を置き換えない）
 * - 三面図・表情・開眼は、取り戻したセルと、記録つきで新しく作ったセルを
 *   scripts/compose-koya-identity-grid.py で格子に並べた板だけを受け付ける（描き直さない）
 * - 取り戻したセルは「生成の記録が無い」ことを、元の PDF・ページ・番号・取り出しの道具と
 *   一緒に申告する（場所の location-import の provenanceGap と同じ考え方）
 * - 人物は承認済みのまま。登録し直しは今の character-register が、別の文脈の点検
 *   （取り戻しの確認つき）を通ったあとに新しいファイル名・新しい SHA で行う
 * - 衣装の板（story stage ごと）は、登録簿の SHA とバイトまで同じもの（restored）か、
 *   登録簿の板から描き直さずに収め直したもの（repacked）だけを受け付ける
 * - 組み直す板のセルには、登録簿の板（同じ役割・同じ SHA）から切り出しただけのセル
 *   （restored-cell）も使える。切り出しの位置を証跡に残し、読める PNG なら画素で照合する
 */
export const KOYA_CHARACTER_RECOVERY_MAP_VERSION = "koya-character-identity-recovery-map-v1";
export const KOYA_CHARACTER_RECOVERY_EVIDENCE_VERSION = "koya-character-identity-recovery-evidence-v1";
export const KOYA_IDENTITY_GRID_COMPOSE_VERSION = "koya-identity-grid-compose-v1";
export const KOYA_IDENTITY_GRID_REPACK_VERSION = "koya-identity-grid-repack-v1";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RECOVERY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const REFERENCE_ROLES = new Set(["identity-face", "recovered-cell", "restored-cell", "style", "other"]);

function nonEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function resolveFrom(baseDir, value) {
  const raw = nonEmpty(value);
  if (!raw) return "";
  return isAbsolute(raw) ? resolve(raw) : resolve(baseDir, raw);
}

async function verifiedFile(baseDir, path, expectedSha256, label, failures) {
  const absolute = resolveFrom(baseDir, path);
  if (!absolute) {
    failures.push(`${label}.path is required.`);
    return null;
  }
  if (!SHA256_PATTERN.test(nonEmpty(expectedSha256))) {
    failures.push(`${label}.sha256 must be a 64-hex SHA-256.`);
    return null;
  }
  let actual = "";
  try { actual = await sha256File(absolute); } catch (error) {
    failures.push(`${label} cannot be read: ${absolute} (${error.code || error.message}).`);
    return null;
  }
  if (actual !== expectedSha256) {
    failures.push(`${label} bytes do not match its declared SHA-256: ${absolute}.`);
    return null;
  }
  return { path: absolute, sha256: actual };
}

function positiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

async function validateRecoveredSource(source, baseDir, label, failures) {
  const record = plainObject(source);
  if (!record) {
    failures.push(`${label}.source is required for a recovered cell.`);
    return null;
  }
  const file = await verifiedFile(baseDir, record.path, record.sha256, `${label}.source`, failures);
  // 出どころは2通り。先方へ送った PDF（ページ・何枚目）か、送付用の素材一式の zip（中のファイル名）。
  // zip の中身は描き直しを経ない元のバイトなので、PDF から取り出した絵より優先して使う。
  if (nonEmpty(record.archivePath)) {
    const archive = await verifiedFile(baseDir, record.archivePath, record.archiveSha256, `${label}.source.archive`, failures);
    if (nonEmpty(record.member).length < 1) failures.push(`${label}.source.member must name the file inside the archive.`);
    if (!file || !archive) return null;
    return {
      path: file.path,
      sha256: file.sha256,
      archivePath: archive.path,
      archiveSha256: archive.sha256,
      member: nonEmpty(record.member),
    };
  }
  const pdf = await verifiedFile(baseDir, record.pdfPath, record.pdfSha256, `${label}.source.pdf`, failures);
  if (!positiveInteger(record.page)) failures.push(`${label}.source.page must be a positive integer.`);
  if (!positiveInteger(record.index)) failures.push(`${label}.source.index must be a positive integer.`);
  if (nonEmpty(record.extractor).length < 4) failures.push(`${label}.source.extractor must name the tool that extracted the image.`);
  if (!file || !pdf) return null;
  return {
    path: file.path,
    sha256: file.sha256,
    pdfPath: pdf.path,
    pdfSha256: pdf.sha256,
    page: record.page,
    index: record.index,
    extractor: nonEmpty(record.extractor),
    ...(plainObject(record.crop) ? { crop: record.crop } : {}),
  };
}

async function validateGeneratedCell(generated, baseDir, label, faceSha256, failures) {
  const record = plainObject(generated);
  if (!record) {
    failures.push(`${label}.generated is required for a generated cell.`);
    return null;
  }
  const file = await verifiedFile(baseDir, record.path, record.sha256, `${label}.generated`, failures);
  const prompt = await verifiedFile(baseDir, record.promptPath, record.promptSha256, `${label}.generated.prompt`, failures);
  const generator = plainObject(record.generator) || {};
  for (const key of ["host", "id", "contextId", "generatedAt"]) {
    if (!nonEmpty(generator[key])) failures.push(`${label}.generated.generator.${key} is required.`);
  }
  const references = [];
  for (const [index, reference] of (Array.isArray(record.referenceImages) ? record.referenceImages : []).entries()) {
    const role = nonEmpty(reference?.role);
    if (!REFERENCE_ROLES.has(role)) failures.push(`${label}.generated.referenceImages[${index}].role must be one of ${[...REFERENCE_ROLES].join(", ")}.`);
    const verified = await verifiedFile(baseDir, reference?.path, reference?.sha256, `${label}.generated.referenceImages[${index}]`, failures);
    if (verified) references.push({ ...verified, role });
  }
  // 新しく作ったセルは、取り戻した顔そのものを身元の参照に持っていなければならない。
  // 顔を参照しない生成は、別人を描いても記録の上で区別できない。
  if (!references.some((reference) => reference.role === "identity-face" && reference.sha256 === faceSha256)) {
    failures.push(`${label}.generated.referenceImages must include the recovered identity face (role identity-face, same SHA-256).`);
  }
  if (!file || !prompt) return null;
  return {
    path: file.path,
    sha256: file.sha256,
    promptPath: prompt.path,
    promptSha256: prompt.sha256,
    generator: {
      host: nonEmpty(generator.host),
      id: nonEmpty(generator.id),
      contextId: nonEmpty(generator.contextId),
      generatedAt: nonEmpty(generator.generatedAt),
    },
    referenceImages: references,
  };
}

// 同じ板を何セルぶんも切り出して照らすので、1回の検めの中では画素を1度だけ戻す。
async function decodedPngOrReason(path, cache) {
  if (cache.has(path)) return cache.get(path);
  let result;
  try {
    result = { image: decodePngPixels(await readFile(path)) };
  } catch (error) {
    if (!(error instanceof UnsupportedPngError)) throw error;
    result = { reason: error.message };
  }
  cache.set(path, result);
  return result;
}

function rgbaPixels(image) {
  if (image.channels === "RGBA") return image.data;
  const rgba = Buffer.alloc(image.width * image.height * 4);
  for (let source = 0, target = 0; source < image.data.length; source += 3, target += 4) {
    rgba[target] = image.data[source];
    rgba[target + 1] = image.data[source + 1];
    rgba[target + 2] = image.data[source + 2];
    rgba[target + 3] = 255;
  }
  return rgba;
}

function cropPixelsMatch(sourceImage, cropImage, [x, y, width, height]) {
  const source = rgbaPixels(sourceImage);
  const crop = rgbaPixels(cropImage);
  const rowBytes = width * 4;
  for (let row = 0; row < height; row += 1) {
    const start = ((y + row) * sourceImage.width + x) * 4;
    if (!source.subarray(start, start + rowBytes).equals(crop.subarray(row * rowBytes, (row + 1) * rowBytes))) return false;
  }
  return true;
}

/**
 * 登録簿の板（同じ役割）から1セルを切り出しただけのセル。描き直しも生成も経ていないので、
 * 元の板が登録簿の SHA のまま手元にあり、切り出しの位置 [x, y, 幅, 高さ] が分かっていれば、
 * 切り出しを作り直して画素で照らせる。照らせない形式（PNG 以外など）のときは位置を証跡に残し、
 * 点検する人が restoredCellsMatchSources で照合を引き受ける。
 */
async function validateRestoredCell(restored, { baseDir, label, registeredSha256, pixelCache, failures }) {
  const record = plainObject(restored);
  if (!record) {
    failures.push(`${label}.restored is required for a restored-cell (sourcePath, sourceSha256, bounds, path, sha256).`);
    return null;
  }
  if (!SHA256_PATTERN.test(nonEmpty(registeredSha256))) {
    failures.push(`${label} is a restored-cell, but the registry has no SHA-256 for this role to cut it from.`);
    return null;
  }
  const declaredSourceSha256 = nonEmpty(record.sourceSha256);
  if (declaredSourceSha256 !== registeredSha256) {
    failures.push(`${label}.restored.sourceSha256 must be the registry SHA-256 of this role: a restored cell is cut only from the registered sheet of the same role.`);
  }
  const source = await verifiedFile(baseDir, record.sourcePath, declaredSourceSha256, `${label}.restored.source`, failures);
  const crop = await verifiedFile(baseDir, record.path, record.sha256, `${label}.restored`, failures);
  const bounds = record.bounds;
  const boundsValid = Array.isArray(bounds) && bounds.length === 4 && bounds.every((value) => Number.isInteger(value))
    && bounds[0] >= 0 && bounds[1] >= 0 && bounds[2] >= 1 && bounds[3] >= 1;
  if (!boundsValid) failures.push(`${label}.restored.bounds must be [x, y, width, height] in whole pixels of the registered sheet.`);
  if (!source || !crop || !boundsValid || declaredSourceSha256 !== registeredSha256) return null;
  const sourceDecoded = await decodedPngOrReason(source.path, pixelCache);
  const cropDecoded = await decodedPngOrReason(crop.path, pixelCache);
  let cropCheck;
  if (sourceDecoded.image && cropDecoded.image) {
    const [x, y, width, height] = bounds;
    if (x + width > sourceDecoded.image.width || y + height > sourceDecoded.image.height) {
      failures.push(`${label}.restored.bounds fall outside the registered sheet (${sourceDecoded.image.width}x${sourceDecoded.image.height}).`);
      return null;
    }
    if (cropDecoded.image.width !== width || cropDecoded.image.height !== height) {
      failures.push(`${label}.restored crop is ${cropDecoded.image.width}x${cropDecoded.image.height}, not the declared bounds ${width}x${height}.`);
      return null;
    }
    if (!cropPixelsMatch(sourceDecoded.image, cropDecoded.image, bounds)) {
      failures.push(`${label}.restored crop pixels differ from the registered sheet at bounds [${bounds.join(", ")}].`);
      return null;
    }
    cropCheck = { method: "decoded-pixels", matched: true };
  } else {
    cropCheck = {
      method: "bounds-recorded",
      matched: null,
      reason: sourceDecoded.reason || cropDecoded.reason,
      note: "The crop could not be re-derived here; the reviewer compares it with the registered sheet at these bounds.",
    };
  }
  return {
    path: crop.path,
    sha256: crop.sha256,
    sourcePath: source.path,
    sourceSha256: source.sha256,
    bounds: [...bounds],
    cropCheck,
  };
}

async function validateCell(cell, expectedId, baseDir, label, faceSha256, failures, context = {}) {
  if (nonEmpty(cell?.id) !== expectedId) {
    failures.push(`${label}.id must be ${expectedId} (cells are listed in grid order).`);
    return null;
  }
  const origin = nonEmpty(cell?.origin);
  if (origin === "recovered") {
    const source = await validateRecoveredSource(cell.source, baseDir, label, failures);
    return source ? { id: expectedId, origin, sourceSha256: source.sha256, source } : null;
  }
  if (origin === "generated") {
    const generated = await validateGeneratedCell(cell.generated, baseDir, label, faceSha256, failures);
    return generated ? { id: expectedId, origin, sourceSha256: generated.sha256, generated } : null;
  }
  if (origin === "restored-cell") {
    const restored = await validateRestoredCell(cell.restored, {
      baseDir,
      label,
      registeredSha256: context.registeredSha256,
      pixelCache: context.pixelCache || new Map(),
      failures,
    });
    return restored ? { id: expectedId, origin, sourceSha256: restored.sha256, restored } : null;
  }
  failures.push(`${label}.origin must be recovered, restored-cell or generated.`);
  return null;
}

async function validateRestoredFile(record, { label, baseDir, registeredSha256, failures }) {
  const file = await verifiedFile(baseDir, record.sheetPath ?? record.path, record.sha256, label, failures);
  if (!SHA256_PATTERN.test(nonEmpty(registeredSha256))) {
    failures.push(`${label} is marked restored, but the registry has no SHA-256 for this role to restore against.`);
    return null;
  }
  if (file && file.sha256 !== registeredSha256) {
    failures.push(`${label} is marked restored, but its bytes differ from the registered SHA-256.`);
    return null;
  }
  return file;
}

async function validateSheet(sheet, { label, ids, columns, rows, baseDir, faceSha256, registeredSha256, pixelCache, failures }) {
  const record = plainObject(sheet);
  if (!record) {
    failures.push(`${label} is required.`);
    return null;
  }
  // 登録簿の SHA とバイトまで同じ板（送付用の素材一式などから戻したもの）は、格子を組み直さずにそのまま使う。
  if (nonEmpty(record.origin) === "restored") {
    const file = await validateRestoredFile(record, { label: `${label}.sheet`, baseDir, registeredSha256, failures });
    return file ? { sheetPath: file.path, sha256: file.sha256, restored: true, cells: [] } : null;
  }
  // 戻した板を、描き直さずに等分の格子へ収め直したもの（scripts/repack-koya-identity-grid.py）。
  // 収め直しの記録が、登録簿のこの役割の SHA を元にしてこの板を出したと言っていることを照合する。
  if (nonEmpty(record.origin) === "repacked") {
    const file = await verifiedFile(baseDir, record.sheetPath, record.sha256, `${label}.sheet`, failures);
    const manifestFile = await verifiedFile(baseDir, record.repackManifestPath, record.repackManifestSha256, `${label}.repackManifest`, failures);
    if (!SHA256_PATTERN.test(nonEmpty(registeredSha256))) {
      failures.push(`${label} is marked repacked, but the registry has no SHA-256 for this role to repack from.`);
      return null;
    }
    if (!file || !manifestFile) return null;
    let manifest = null;
    try { manifest = JSON.parse(await readFile(manifestFile.path, "utf8")); } catch (error) {
      failures.push(`${label}.repackManifest is not JSON: ${error.message}`);
      return null;
    }
    if (manifest?.version !== KOYA_IDENTITY_GRID_REPACK_VERSION) failures.push(`${label}.repackManifest.version must be ${KOYA_IDENTITY_GRID_REPACK_VERSION}.`);
    if (manifest?.outputSha256 !== file.sha256) failures.push(`${label}.repackManifest does not describe this sheet (outputSha256 differs).`);
    if (manifest?.sourceSha256 !== registeredSha256) failures.push(`${label}.repackManifest was not repacked from the registered sheet (sourceSha256 differs from the registry).`);
    if (manifest?.columns !== columns || manifest?.rows !== rows) failures.push(`${label}.repackManifest must be a ${columns}x${rows} grid.`);
    if (failures.some((entry) => entry.startsWith(`${label}.repackManifest`))) return null;
    return {
      sheetPath: file.path,
      sha256: file.sha256,
      repacked: true,
      repackManifestPath: manifestFile.path,
      repackManifestSha256: manifestFile.sha256,
      repackedFromSha256: registeredSha256,
      cells: [],
    };
  }
  const file = await verifiedFile(baseDir, record.sheetPath, record.sha256, `${label}.sheet`, failures);
  const manifestFile = await verifiedFile(baseDir, record.composeManifestPath, record.composeManifestSha256, `${label}.composeManifest`, failures);
  const cells = Array.isArray(record.cells) ? record.cells : [];
  if (cells.length !== ids.length) failures.push(`${label}.cells must list exactly ${ids.length} cells in grid order.`);
  const validated = [];
  for (const [index, id] of ids.entries()) {
    const cell = await validateCell(cells[index], id, baseDir, `${label}.cells.${id}`, faceSha256, failures, { registeredSha256, pixelCache });
    if (cell) validated.push(cell);
  }
  if (!file || !manifestFile) return null;
  let manifest = null;
  try { manifest = JSON.parse(await readFile(manifestFile.path, "utf8")); } catch (error) {
    failures.push(`${label}.composeManifest is not JSON: ${error.message}`);
    return null;
  }
  if (manifest?.version !== KOYA_IDENTITY_GRID_COMPOSE_VERSION) failures.push(`${label}.composeManifest.version must be ${KOYA_IDENTITY_GRID_COMPOSE_VERSION}.`);
  if (manifest?.outputSha256 !== file.sha256) failures.push(`${label}.composeManifest does not describe this sheet (outputSha256 differs).`);
  if (manifest?.columns !== columns || manifest?.rows !== rows) failures.push(`${label}.composeManifest must be a ${columns}x${rows} grid.`);
  const manifestCells = Array.isArray(manifest?.cells) ? manifest.cells : [];
  if (manifestCells.length !== ids.length
    || ids.some((id, index) => nonEmpty(manifestCells[index]?.id) !== id)) {
    failures.push(`${label}.composeManifest cells are not the required ids in grid order.`);
  } else if (validated.length === ids.length) {
    ids.forEach((id, index) => {
      if (manifestCells[index].sourceSha256 !== validated[index].sourceSha256) {
        failures.push(`${label}.cells.${id} is not the image that was composed into the sheet.`);
      }
      // 切り出したセルは、組んだ道具の記録にも「登録簿の板のこの位置から切った」と残っていなければならない。
      if (validated[index].origin === "restored-cell") {
        const cropOf = plainObject(manifestCells[index].cropOf);
        if (!cropOf
          || cropOf.sourceSha256 !== validated[index].restored.sourceSha256
          || JSON.stringify(cropOf.bounds) !== JSON.stringify(validated[index].restored.bounds)) {
          failures.push(`${label}.cells.${id} is a restored-cell, but the compose manifest does not record cutting it from the registered sheet at the same bounds (give the cell a "crop" entry when composing).`);
        }
      }
    });
  }
  if (validated.length !== ids.length) return null;
  return {
    sheetPath: file.path,
    sha256: file.sha256,
    composeManifestPath: manifestFile.path,
    composeManifestSha256: manifestFile.sha256,
    cells: validated,
  };
}

function registryReferencedPaths(canvasDir, entry) {
  const paths = [
    ...(entry.referenceAssets || []).map((asset) => asset.path),
    ...(entry.referenceImagePaths || []),
  ].map((path) => resolveFrom(canvasDir, path)).filter(Boolean);
  return [...new Set(paths)];
}

export async function validateKoyaCharacterRecoveryMap({ map, mapDir, workflow, cast, registryEntry } = {}) {
  const failures = [];
  if (map?.version !== KOYA_CHARACTER_RECOVERY_MAP_VERSION) failures.push(`version must be ${KOYA_CHARACTER_RECOVERY_MAP_VERSION}.`);
  if (nonEmpty(map?.workflowId) !== workflow?.id) failures.push("workflowId does not match the workflow.");
  if (nonEmpty(map?.castId) !== cast?.id) failures.push("castId does not match the workflow character.");
  const recoveryId = nonEmpty(map?.recoveryId);
  if (!RECOVERY_ID_PATTERN.test(recoveryId)) failures.push("recoveryId must be 1-64 characters of letters, digits, dot, underscore or hyphen.");
  if (nonEmpty(map?.reason).length < 20) failures.push("reason must explain why the approved files are being recovered (at least 20 characters).");
  const importedBy = plainObject(map?.importedBy) || {};
  for (const key of ["host", "id", "contextId"]) {
    if (!nonEmpty(importedBy[key])) failures.push(`importedBy.${key} is required.`);
  }
  const specification = await verifiedFile(mapDir, map?.specification?.path, map?.specification?.sha256, "specification", failures);

  const registeredSha256 = (role, storyStage = "") => nonEmpty((registryEntry?.referenceAssets || [])
    .find((asset) => asset.role === role && nonEmpty(asset.storyStage) === storyStage)?.sha256);
  const face = plainObject(map?.selectedFace);
  const faceOrigin = nonEmpty(face?.origin);
  if (faceOrigin !== "recovered" && faceOrigin !== "restored") {
    failures.push("selectedFace.origin must be recovered or restored: the identity face is never replaced by a generated image.");
  }
  const faceSource = !face ? null : faceOrigin === "restored"
    ? await validateRestoredFile(face, { label: "selectedFace", baseDir: mapDir, registeredSha256: registeredSha256("identity-face"), failures })
    : await validateRecoveredSource(face.source, mapDir, "selectedFace", failures);
  const faceSha256 = faceSource?.sha256 || "";

  const sheetArgs = { baseDir: mapDir, faceSha256, pixelCache: new Map(), failures };
  const turnaround =await validateSheet(map?.turnaround, { ...sheetArgs, label: "turnaround", ids: REQUIRED_TURNAROUND_VIEWS, columns: 4, rows: 2, registeredSha256: registeredSha256("turnaround") });
  const expression = await validateSheet(map?.expression, { ...sheetArgs, label: "expression", ids: REQUIRED_EXPRESSION_CELLS, columns: 4, rows: 3, registeredSha256: registeredSha256("expression") });

  const declaredVariants = castEyeOpenVariants(cast).map((variant) => variant.id);
  const previouslyHadEyeOpen = (registryEntry?.referenceAssets || []).some((asset) => asset.role === "eye-open");
  const requestedEyeOpen = Array.isArray(map?.eyeOpenSheets) ? map.eyeOpenSheets : [];
  const expectedStages = declaredVariants.length > 0
    ? declaredVariants
    : (castNeedsEyeOpenVariant(cast) || previouslyHadEyeOpen ? [""] : []);
  const requestedStages = requestedEyeOpen.map((sheet) => nonEmpty(sheet?.storyStage));
  if (requestedStages.length !== expectedStages.length
    || expectedStages.some((stage) => !requestedStages.includes(stage))) {
    failures.push(`eyeOpenSheets must cover exactly the character's eyes-open sheets: ${expectedStages.length > 0 ? expectedStages.map((stage) => stage || "(unkeyed)").join(", ") : "none"}.`);
  }
  const eyeOpenSheets = [];
  for (const sheet of requestedEyeOpen) {
    const storyStage = nonEmpty(sheet?.storyStage);
    const validated = await validateSheet(sheet, { ...sheetArgs, label: `eyeOpenSheets.${storyStage || "unkeyed"}`, ids: REQUIRED_EYE_OPEN_CELLS, columns: 2, rows: 2, registeredSha256: registeredSha256("eye-open", storyStage) });
    if (validated) eyeOpenSheets.push({ ...validated, storyStage });
  }
  // 衣装の板は、登録簿にある story stage ごとの板（role outfit）をちょうど全部戻す。
  // 受け付けるのは、登録簿の板とバイトまで同じもの（restored）、登録簿の板から描き直さずに
  // 収め直したもの（repacked）、そして組み直したもの（origin を書かない）の3つ。組み直しは、
  // 同じ story stage の登録簿の板から切り出したセル（restored-cell）と、顔を参照して直したセル
  // （generated。承認時の描き間違いを直すとき）だけで組む。直したセルは点検の generatedCellsConsistent に回る。
  const registeredOutfitStages = [...new Set((registryEntry?.referenceAssets || [])
    .filter((asset) => asset.role === "outfit")
    .map((asset) => nonEmpty(asset.storyStage)))];
  const declaredOutfitStages = (cast?.outfitStages || []).length > 1 ? cast.outfitStages.map((stage) => nonEmpty(stage.id)) : [];
  const unregisteredOutfitStages = declaredOutfitStages.filter((stage) => !registeredOutfitStages.includes(stage));
  if (unregisteredOutfitStages.length > 0) {
    failures.push(`This character declares story-stage outfits the registry holds no sheet for (${unregisteredOutfitStages.join(", ")}); recovery only restores registered outfit sheets. Recover or redraw those outfits through their own route first.`);
  }
  const requestedOutfits = Array.isArray(map?.outfitSheets) ? map.outfitSheets : [];
  const requestedOutfitStages = requestedOutfits.map((sheet) => nonEmpty(sheet?.storyStage));
  if (requestedOutfitStages.length !== registeredOutfitStages.length
    || registeredOutfitStages.some((stage) => !requestedOutfitStages.includes(stage))) {
    failures.push(`outfitSheets must cover exactly the character's registered outfit sheets: ${registeredOutfitStages.length > 0 ? registeredOutfitStages.map((stage) => stage || "(unkeyed)").join(", ") : "none"}.`);
  }
  const outfitSheets = [];
  for (const sheet of requestedOutfits) {
    const storyStage = nonEmpty(sheet?.storyStage);
    const label = `outfitSheets.${storyStage || "unkeyed"}`;
    const origin = nonEmpty(sheet?.origin);
    if (origin && origin !== "restored" && origin !== "repacked") {
      failures.push(`${label}.origin must be restored or repacked, or omitted for a sheet composed from cells of its registered sheet.`);
      continue;
    }
    const validated = await validateSheet(sheet, { ...sheetArgs, label, ids: REQUIRED_OUTFIT_CELLS, columns: 4, rows: 1, registeredSha256: registeredSha256("outfit", storyStage) });
    if (validated) outfitSheets.push({ ...validated, storyStage });
  }
  outfitSheets.sort((left, right) => registeredOutfitStages.indexOf(left.storyStage) - registeredOutfitStages.indexOf(right.storyStage));
  const sheets = [turnaround, expression, ...eyeOpenSheets, ...outfitSheets].filter(Boolean);
  const allCells = sheets.flatMap((sheet) => sheet.cells);
  return {
    failures,
    recoveryId,
    reason: nonEmpty(map?.reason),
    importedBy: { host: nonEmpty(importedBy.host), id: nonEmpty(importedBy.id), contextId: nonEmpty(importedBy.contextId) },
    specification,
    selectedFace: faceSource,
    turnaround,
    expression,
    eyeOpenSheets,
    outfitSheets,
    recoveredCellCount: allCells.filter((cell) => cell.origin === "recovered").length,
    generatedCellCount: allCells.filter((cell) => cell.origin === "generated").length,
    restoredCellCount: allCells.filter((cell) => cell.origin === "restored-cell").length,
    restoredSheetCount: sheets.filter((sheet) => sheet.restored).length + (faceOrigin === "restored" && faceSource ? 1 : 0),
    repackedSheetCount: sheets.filter((sheet) => sheet.repacked).length,
  };
}

// 証跡・記録で、新しく足した数は 0 のとき書かない（従来の取り戻しの記録の形を変えない）。
function optionalCounts(validated) {
  return validated.restoredCellCount > 0 ? { restoredCellCount: validated.restoredCellCount } : {};
}

function fileStem(value, fallback) {
  return nonEmpty(value).replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^[-.]+|-+$/gu, "") || fallback;
}

/**
 * 取り戻しの対応表を検め、取り戻した顔と板を canvas/assets/character-recoveries/ へ写し、
 * 証跡を書き、作業台帳の人物を awaiting-identity-qa に戻して点検の下書きを作る。
 * 登録簿はここでは書き換えない（登録し直しは character-register）。
 */
export async function recoverKoyaRegisteredCharacterIdentity(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  const canvasDir = resolveCanvasDir({ projectDir, canvasDir: options.canvasDir });
  const storeArgs = { projectDir, canvasDir };
  if (!nonEmpty(options.workflowId)) throw new Error("workflowId is required.");
  if (!nonEmpty(options.castId)) throw new Error("castId is required.");
  const mapPath = resolve(nonEmpty(options.recoveryMapPath) || "");
  if (!nonEmpty(options.recoveryMapPath)) throw new Error("recoveryMapPath is required.");

  const store = await readCharacterWorkflowStore(storeArgs);
  const workflow = getCharacterWorkflow(store, options.workflowId);
  if (!workflow) throw new Error(`Unknown character workflow: ${options.workflowId}.`);
  const cast = findWorkflowCast(workflow, options.castId);
  if (!cast) throw new Error(`Unknown workflow character: ${options.castId}.`);
  // 取り戻しの途中（点検待ち）の人物は、新しい取り戻しで置き換えられる（前の取り戻しは証跡に残す）。
  const supersededRecovery = cast.status === "awaiting-identity-qa" && cast.identityPack?.recovery
    ? { recoveryId: nonEmpty(cast.identityPack.recovery.recoveryId), evidencePath: nonEmpty(cast.identityPack.recovery.evidencePath), evidenceSha256: nonEmpty(cast.identityPack.recovery.evidenceSha256) }
    : null;
  if (cast.status !== "ready" && !supersededRecovery) {
    throw new Error(`Recovery is only for a previously registered character (workflow status ready, or awaiting-identity-qa from an earlier recovery); ${cast.name} is ${cast.status}.`);
  }

  const registry = await readCharacterRegistry(storeArgs);
  const registryEntry = registry.characters.find((entry) => entry.id === cast.id && entry.status === "approved");
  if (!registryEntry) throw new Error(`${cast.name} (${cast.id}) is not an approved registry entry; use the normal approval route.`);
  const previousPaths = registryReferencedPaths(canvasDir, registryEntry);
  if (previousPaths.length === 0) throw new Error(`${cast.name} has no registered reference files to recover.`);
  // 残っているファイルは、登録簿の SHA とバイトまで同じもの（戻したもの）だけ許す。
  // 違うバイトが登録簿の場所にあれば、何かが上書きされているので止める。
  const registeredShaByPath = new Map((registryEntry.referenceAssets || [])
    .filter((asset) => SHA256_PATTERN.test(nonEmpty(asset.sha256)))
    .map((asset) => [resolveFrom(canvasDir, asset.path), asset.sha256]));
  const missingPaths = [];
  const changed = [];
  for (const path of previousPaths) {
    if (!(await exists(path))) { missingPaths.push(path); continue; }
    const expected = registeredShaByPath.get(path);
    if (!expected || await sha256File(path) !== expected) changed.push(path);
  }
  if (changed.length > 0) {
    throw new Error(`These registered files exist but are not byte-identical to the registry: ${changed.join(", ")}. Recovery never replaces approved bytes; use character-identity-refresh or repair instead. Nothing was written.`);
  }
  const reviewPath = nonEmpty(registryEntry.approval?.identityReviewPath);
  const reviewSha256 = nonEmpty(registryEntry.approval?.identityReviewSha256);
  let reviewIntact = false;
  if (reviewPath && SHA256_PATTERN.test(reviewSha256)) {
    const resolvedReview = resolveFrom(canvasDir, reviewPath);
    reviewIntact = await exists(resolvedReview) && await sha256File(resolvedReview) === reviewSha256;
  }
  if (missingPaths.length === 0 && reviewIntact) {
    throw new Error(`${cast.name} has every approved file and its identity review intact; there is nothing to recover. Use character-identity-refresh to regenerate sheets. Nothing was written.`);
  }

  let map;
  try { map = JSON.parse(await readFile(mapPath, "utf8")); } catch (error) {
    throw new Error(`Recovery map cannot be read: ${mapPath}: ${error.message}`);
  }
  const validated = await validateKoyaCharacterRecoveryMap({ map, mapDir: dirname(mapPath), workflow, cast, registryEntry });
  if (validated.failures.length > 0) {
    throw new Error(`Recovery map is invalid; nothing was written:\n- ${validated.failures.join("\n- ")}`);
  }

  const outputDir = join(canvasDir, "assets", "character-recoveries", cast.id, validated.recoveryId);
  if (await exists(outputDir)) {
    throw new Error(`recoveryId ${validated.recoveryId} was already used for ${cast.name} (${outputDir}). Choose a new recoveryId. Nothing was written.`);
  }
  await mkdir(outputDir, { recursive: true });
  const copyInto = async (source, name) => {
    const destination = join(outputDir, `${name}${extname(source.path) || ".png"}`);
    await copyFile(source.path, destination);
    const copied = await sha256File(destination);
    if (copied !== source.sha256) throw new Error(`Copy of ${source.path} changed bytes; recovery stopped.`);
    return { assetFile: destination, sha256: copied };
  };
  const selectedFace = await copyInto(validated.selectedFace, "selected-face");
  const turnaround = await copyInto({ path: validated.turnaround.sheetPath, sha256: validated.turnaround.sha256 }, "turnaround");
  const expression = await copyInto({ path: validated.expression.sheetPath, sha256: validated.expression.sha256 }, "expression");
  const eyeOpenSheets = [];
  for (const sheet of validated.eyeOpenSheets) {
    const copied = await copyInto({ path: sheet.sheetPath, sha256: sheet.sha256 }, sheet.storyStage ? `eyes-open-${sheet.storyStage}` : "eyes-open");
    eyeOpenSheets.push({ ...copied, storyStage: sheet.storyStage });
  }
  // 衣装の板は、通常の経路が組む identityPack.outfitSheets と同じ形（assetFile・sha256・storyStage）で置く。
  // こうしておけば点検の下書き・点検の検め・character-register が、衣装つきの人物と同じ扱いをする。
  const outfitSheets = [];
  const outfitNames = new Set();
  for (const [index, sheet] of validated.outfitSheets.entries()) {
    let name = `outfit-${fileStem(sheet.storyStage, "stage")}`;
    if (outfitNames.has(name)) name = `${name}-${index + 1}`;
    outfitNames.add(name);
    const copied = await copyInto({ path: sheet.sheetPath, sha256: sheet.sha256 }, name);
    outfitSheets.push({ ...copied, storyStage: sheet.storyStage });
  }
  if (selectedFace.sha256 === turnaround.sha256) throw new Error("The turnaround is byte-identical to the identity face; recovery stopped.");
  const mapCopy = join(outputDir, "recovery-map.json");
  await copyFile(mapPath, mapCopy);

  const recoveredAt = new Date().toISOString();
  const previousAssets = (registryEntry.referenceAssets || []).map((asset) => ({
    role: asset.role,
    storyStage: asset.storyStage || "",
    path: asset.path,
    sha256: asset.sha256 || "",
  }));
  const evidence = {
    version: KOYA_CHARACTER_RECOVERY_EVIDENCE_VERSION,
    recoveryId: validated.recoveryId,
    workflowId: workflow.id,
    castId: cast.id,
    castName: cast.name,
    reason: validated.reason,
    recoveredAt,
    importedBy: validated.importedBy,
    specification: validated.specification,
    map: { path: mapCopy, sha256: await sha256File(mapCopy) },
    previousRegistration: {
      approvedAt: registryEntry.approval?.approvedAt || "",
      approvedBy: registryEntry.approval?.approvedBy || "",
      identityReviewPath: registryEntry.approval?.identityReviewPath || "",
      identityReviewSha256: registryEntry.approval?.identityReviewSha256 || "",
      assets: previousAssets,
      missingPaths,
      identityReviewIntact: reviewIntact,
    },
    staged: { selectedFace, turnaround, expression, eyeOpenSheets, ...(outfitSheets.length > 0 ? { outfitSheets } : {}) },
    selectedFaceSource: validated.selectedFace,
    sheets: {
      turnaround: validated.turnaround,
      expression: validated.expression,
      eyeOpenSheets: validated.eyeOpenSheets,
      ...(validated.outfitSheets.length > 0 ? { outfitSheets: validated.outfitSheets } : {}),
    },
    recoveredCellCount: validated.recoveredCellCount,
    generatedCellCount: validated.generatedCellCount,
    restoredSheetCount: validated.restoredSheetCount,
    repackedSheetCount: validated.repackedSheetCount,
    ...optionalCounts(validated),
    ...(supersededRecovery ? { supersedesRecovery: supersededRecovery } : {}),
  };
  const evidencePath = join(outputDir, "recovery-evidence.json");
  await writeJsonAtomic(evidencePath, evidence);
  const recovery = {
    version: CHARACTER_IDENTITY_RECOVERY_VERSION,
    recoveryId: validated.recoveryId,
    reason: validated.reason,
    evidencePath,
    evidenceSha256: await sha256File(evidencePath),
    recoveredAt,
    previousIdentityReviewSha256: registryEntry.approval?.identityReviewSha256 || "",
    previousAssets,
    recoveredCellCount: validated.recoveredCellCount,
    generatedCellCount: validated.generatedCellCount,
    restoredSheetCount: validated.restoredSheetCount,
    repackedSheetCount: validated.repackedSheetCount,
    ...optionalCounts(validated),
  };

  let updated = await updateCharacterWorkflow(storeArgs, workflow.id, (current) => {
    current.cast = current.cast.map((entry) => entry.id === cast.id ? {
      ...entry,
      status: "awaiting-identity-qa",
      approval: { ...(entry.approval || registryEntry.approval || {}), recovery },
      identityPack: {
        ...(entry.identityPack || {}),
        selectedFace,
        turnaround,
        expression,
        eyeOpen: eyeOpenSheets[0] || null,
        eyeOpenSheets,
        outfitSheets,
        generatedAt: recoveredAt,
        generatorContextId: validated.importedBy.contextId,
        recovery,
      },
    } : entry);
    current.status = workflowStatusForCast(current.cast);
    return current;
  });
  const updatedCast = findWorkflowCast(updated, cast.id);
  if (!updatedCast?.identityPack?.recovery || !updatedCast?.approval?.recovery) {
    throw new Error("The workflow store dropped the recovery record; the staged pack would lose its evidence.");
  }
  const draft = await prepareIdentityPackReviewDraft({
    ...storeArgs,
    workflow: updated,
    cast: updatedCast,
    identityPack: updatedCast.identityPack,
    generatorContextId: validated.importedBy.contextId,
  });
  updated = await updateCharacterWorkflow(storeArgs, workflow.id, (current) => {
    current.cast = current.cast.map((entry) => entry.id === cast.id ? { ...entry, identityReviewDraftPath: draft.path } : entry);
    return current;
  });
  return {
    workflowId: workflow.id,
    castId: cast.id,
    castName: cast.name,
    recoveryId: validated.recoveryId,
    outputDir,
    evidencePath,
    evidenceSha256: recovery.evidenceSha256,
    recoveredCellCount: validated.recoveredCellCount,
    generatedCellCount: validated.generatedCellCount,
    restoredSheetCount: validated.restoredSheetCount,
    repackedSheetCount: validated.repackedSheetCount,
    ...optionalCounts(validated),
    ...(outfitSheets.length > 0 ? { outfitSheetCount: outfitSheets.length } : {}),
    identityReviewDraftPath: draft.path,
    next: [
      `Independent original-scale review of every cell in ${draft.path}${outfitSheets.length > 0 ? ` (including ${outfitSheets.length} outfit sheets)` : ""}, in a context different from ${validated.importedBy.contextId}; read ${evidencePath} and set recovery.provenanceGapAcknowledged${validated.recoveredCellCount > 0 ? " / recoveredCellsMatchSources" : ""}${validated.generatedCellCount > 0 ? " / generatedCellsConsistent" : ""}${validated.repackedSheetCount > 0 ? " / repackedSheetsMatchSources" : ""}${validated.restoredCellCount > 0 ? " / restoredCellsMatchSources" : ""} only after comparing with the sources.`,
      `character-register --workflow-id ${workflow.id} --cast-id ${cast.id} --identity-review-path <completed review>`,
      "asset-quality-references (rebuild the approved-reference list with the new SHA-256 values)",
    ],
  };
}
