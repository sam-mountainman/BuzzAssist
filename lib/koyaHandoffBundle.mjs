import { createHash, randomUUID } from "node:crypto";
import { resolveChannelPackPath } from "./channelPackResolver.mjs";
import { access, copyFile, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCanvasDir, writeJsonAtomic } from "./canvasScene.mjs";
import { readCharacterWorkflowStore } from "./characterPipeline.mjs";
import { normalizeChannelVisualProfileStore } from "./channelVisualProfile.mjs";
import { normalizeCharacterRegistry, readCharacterRegistry, writeCharacterRegistry } from "./characterRegistry.mjs";
import { auditKoyaCharacterBootstrap, readKoyaChannelAuthority } from "./koyaChannelGovernance.mjs";

export const KOYA_HANDOFF_BUNDLE_VERSION = "koya-harness-handoff-v1";
export const KOYA_HANDOFF_REVIEW_ATTESTATION_VERSION = "koya-handoff-review-attestation-v1";
const CANVAS_TOKEN = "__BUNDLE_CANVAS__/";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PROJECT_CONFIG_PATHS = Object.freeze([
  "config/koya-show-bible.json",
  "config/koya-location-bible.json",
  "config/koya-thumbnail-contract.json",
]);
const CONTRACT_SNAPSHOT_PATHS = Object.freeze([
  "config/koya-manga-production-contract.json",
  "config/koya-manga-production-contract.schema.json",
  "config/koya-manga-quality-incidents.json",
]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function safeSegment(value, fallback = "item") {
  return nonEmptyString(value).normalize("NFKC").replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || fallback;
}

function portablePath(value) {
  return String(value || "").split(sep).join("/");
}

function safeBundleRelative(value) {
  const normalized = portablePath(value).replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("../") || normalized === "..") {
    throw new Error(`Unsafe handoff bundle path: ${value}`);
  }
  return normalized;
}

function resolveInside(root, relativePath) {
  const output = resolve(root, safeBundleRelative(relativePath));
  if (output !== root && !output.startsWith(`${root}${sep}`)) throw new Error(`Handoff path escapes its root: ${relativePath}`);
  return output;
}

async function pathExists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function readJsonStrict(path) {
  const text = await readFile(path, "utf8");
  if (!text.trim()) throw new Error(`Required handoff JSON is empty: ${path}`);
  return JSON.parse(text);
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function fileEvidence(root, path, kind) {
  const info = await stat(path);
  return {
    path: portablePath(relative(root, path)),
    kind,
    size: info.size,
    sha256: await sha256File(path),
  };
}

async function copyEvidence(source, root, relativePath, kind) {
  const destination = resolveInside(root, relativePath);
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error(`Handoff source must be a regular file: ${source}`);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  return fileEvidence(root, destination, kind);
}

function sourceCanvasPath(canvasDir, value) {
  const path = nonEmptyString(value);
  if (!path) return "";
  return isAbsolute(path) ? resolve(path) : resolve(canvasDir, path);
}

function selectedIds(value) {
  const list = Array.isArray(value) ? value : nonEmptyString(value).split(",");
  return new Set(list.map((entry) => nonEmptyString(entry)).filter(Boolean));
}

function stripPrivateApproval(approval) {
  if (!approval || typeof approval !== "object") return null;
  return {
    route: nonEmptyString(approval.route),
    approvedBy: nonEmptyString(approval.approvedBy),
    approvedAt: nonEmptyString(approval.approvedAt),
    selectedCandidateLabel: nonEmptyString(approval.selectedCandidateLabel),
    reason: nonEmptyString(approval.reason),
    identityReviewPath: nonEmptyString(approval.identityReviewPath),
    identityReviewSha256: nonEmptyString(approval.identityReviewSha256),
  };
}

function characterMatchesKoya(character, showBible, explicitIds) {
  if (explicitIds.size > 0) return explicitIds.has(character.id) || explicitIds.has(character.name);
  const cast = Array.isArray(showBible?.cast) ? showBible.cast : [];
  return cast.some((entry) => entry.id === character.id || entry.name === character.name || character.aliases?.includes(entry.name));
}

async function copyRegistryAsset({ source, bundleRoot, bundleId, characterId, role, copied, files }) {
  const actualSha = await sha256File(source);
  if (copied.has(source)) return copied.get(source);
  const extensionName = safeSegment(basename(source), "asset.bin");
  const relativePath = `project/canvas/assets/characters/${safeSegment(characterId)}/${safeSegment(role)}/${actualSha.slice(0, 12)}-${extensionName}`;
  files.push(await copyEvidence(source, bundleRoot, relativePath, "approved-character-evidence"));
  const tokenPath = `${CANVAS_TOKEN}assets/characters/${safeSegment(characterId)}/${safeSegment(role)}/${actualSha.slice(0, 12)}-${extensionName}`;
  const result = { tokenPath, sha256: actualSha };
  copied.set(source, result);
  return result;
}

function portableReviewSnapshot(value, key = "") {
  if (Array.isArray(value)) return value.map((entry) => portableReviewSnapshot(entry, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, portableReviewSnapshot(childValue, childKey)]));
  }
  if (typeof value === "string" && (isAbsolute(value) || /path$/iu.test(key))) {
    return value ? `source-path-redacted:${safeSegment(basename(value), "evidence")}` : "";
  }
  return value;
}

async function copyReviewAsset({ source, bundleRoot, characterId, copied, files }) {
  const copiedKey = `review:${source}:${characterId}`;
  if (copied.has(copiedKey)) return copied.get(copiedKey);
  const sourceBytes = await readFile(source);
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  let sourceReview = null;
  try { sourceReview = JSON.parse(sourceBytes.toString("utf8")); } catch {}
  const attestation = {
    version: KOYA_HANDOFF_REVIEW_ATTESTATION_VERSION,
    subjectId: characterId,
    sourceReview: {
      version: nonEmptyString(sourceReview?.version),
      phase: nonEmptyString(sourceReview?.phase),
      sha256: sourceSha256,
    },
    snapshot: portableReviewSnapshot(sourceReview || { unparsedSourceReviewSha256: sourceSha256 }),
    note: "Portable approval evidence. Source-machine paths are deliberately redacted; approved asset bytes are independently SHA-bound by the portable registry and bundle manifest.",
  };
  const actualSha = createHash("sha256").update(`${JSON.stringify(attestation, null, 2)}\n`).digest("hex");
  const extensionName = safeSegment(basename(source).replace(/\.json$/iu, ""), "review");
  const relativePath = `project/canvas/assets/reviews/${safeSegment(characterId)}/${actualSha.slice(0, 12)}-${extensionName}-attestation.json`;
  const destination = resolveInside(bundleRoot, relativePath);
  await writeJsonAtomic(destination, attestation);
  files.push(await fileEvidence(bundleRoot, destination, "approved-review-attestation"));
  const result = {
    tokenPath: `${CANVAS_TOKEN}assets/reviews/${safeSegment(characterId)}/${actualSha.slice(0, 12)}-${extensionName}-attestation.json`,
    sha256: actualSha,
  };
  copied.set(copiedKey, result);
  return result;
}

async function buildPortableRegistry({ projectDir, canvasDir, bundleRoot, bundleId, showBible, characterIds, files }) {
  const source = await readCharacterRegistry({ projectDir, canvasDir });
  const explicitIds = selectedIds(characterIds);
  const copied = new Map();
  const characters = [];
  for (const character of source.characters.filter((entry) => entry.status === "approved" && characterMatchesKoya(entry, showBible, explicitIds))) {
    const next = structuredClone(character);
    next.approval = stripPrivateApproval(character.approval);
    const referenceAssets = [];
    for (const asset of character.referenceAssets || []) {
      const sourcePath = sourceCanvasPath(canvasDir, asset.path);
      if (!sourcePath) continue;
      const copiedAsset = await copyRegistryAsset({ source: sourcePath, bundleRoot, bundleId, characterId: character.id, role: asset.role, copied, files });
      let sourceReviewPath = "";
      if (nonEmptyString(asset.sourceReviewPath)) {
        const reviewSource = sourceCanvasPath(canvasDir, asset.sourceReviewPath);
        const copiedReview = await copyReviewAsset({ source: reviewSource, bundleRoot, characterId: character.id, copied, files });
        sourceReviewPath = copiedReview.tokenPath;
      }
      referenceAssets.push({ ...asset, path: copiedAsset.tokenPath, sha256: copiedAsset.sha256, sourceReviewPath });
    }
    next.referenceAssets = referenceAssets;
    next.referenceImagePaths = referenceAssets.map((entry) => entry.path);
    if (nonEmptyString(next.approval?.identityReviewPath)) {
      const reviewSource = sourceCanvasPath(canvasDir, next.approval.identityReviewPath);
      const copiedReview = await copyReviewAsset({ source: reviewSource, bundleRoot, characterId: character.id, copied, files });
      next.approval.identityReviewPath = copiedReview.tokenPath;
      next.approval.identityReviewSha256 = copiedReview.sha256;
    }
    characters.push(next);
  }
  const usedVoiceIds = new Set(characters.map((entry) => entry.voiceId).filter(Boolean));
  return normalizeCharacterRegistry({
    version: 1,
    revision: 0,
    characters,
    voices: source.voices.filter((entry) => usedVoiceIds.has(entry.id)),
  });
}

async function buildPortableVisualProfiles({ projectDir, canvasDir, bundleRoot, visualProfileIds, files }) {
  const sourcePath = join(canvasDir, "channel-visual-profiles.json");
  if (!await pathExists(sourcePath)) return normalizeChannelVisualProfileStore(null);
  const source = normalizeChannelVisualProfileStore(await readJsonStrict(sourcePath));
  const explicitIds = selectedIds(visualProfileIds);
  const keepIds = explicitIds.size > 0 ? explicitIds : new Set([source.defaultProfileId]);
  const copied = new Map();
  const profiles = [];
  for (const profile of source.profiles.filter((entry) => keepIds.has(entry.id))) {
    const next = structuredClone(profile);
    next.referenceImages = [];
    for (const reference of profile.referenceImages || []) {
      const sourceFile = sourceCanvasPath(canvasDir, reference.path);
      const actualSha = await sha256File(sourceFile);
      let tokenPath = copied.get(sourceFile);
      if (!tokenPath) {
        const extensionName = safeSegment(basename(sourceFile), "style.bin");
        const relativePath = `project/canvas/assets/visual-profiles/${safeSegment(profile.id)}/${actualSha.slice(0, 12)}-${extensionName}`;
        files.push(await copyEvidence(sourceFile, bundleRoot, relativePath, "locked-visual-reference"));
        tokenPath = `${CANVAS_TOKEN}assets/visual-profiles/${safeSegment(profile.id)}/${actualSha.slice(0, 12)}-${extensionName}`;
        copied.set(sourceFile, tokenPath);
      }
      next.referenceImages.push({ ...reference, path: tokenPath, sha256: actualSha });
    }
    profiles.push(next);
  }
  return normalizeChannelVisualProfileStore({ version: 1, defaultProfileId: profiles.some((entry) => entry.id === source.defaultProfileId) ? source.defaultProfileId : profiles[0]?.id || "", profiles });
}

async function stylingSpecPaths(projectDir, showBible) {
  const paths = [];
  for (const cast of Array.isArray(showBible?.cast) ? showBible.cast : []) {
    const relativePath = nonEmptyString(cast.stylingSpecPath);
    if (relativePath && !paths.includes(relativePath)) paths.push(relativePath);
  }
  const directory = resolveChannelPackPath(projectDir, "config/koya-character-styling");
  if (await pathExists(directory)) {
    for (const name of await readdir(directory)) {
      if (/\.json$/u.test(name)) {
        const relativePath = `config/koya-character-styling/${name}`;
        if (!paths.includes(relativePath)) paths.push(relativePath);
      }
    }
  }
  return paths.sort();
}

export async function exportKoyaHandoffBundle(args = {}) {
  const projectDir = resolve(nonEmptyString(args.projectDir) || process.cwd());
  const canvasDir = resolveCanvasDir({ ...args, projectDir });
  const id = safeSegment(args.bundleId, `koya-${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`);
  const bundleRoot = resolve(nonEmptyString(args.outputDir) || join(canvasDir, "koya-handoff", id));
  if (await pathExists(bundleRoot)) {
    if (args.force !== true) throw new Error(`Handoff output already exists: ${bundleRoot}`);
    await rm(bundleRoot, { recursive: true, force: true });
  }
  await mkdir(bundleRoot, { recursive: true });
  const files = [];
  const authority = await readKoyaChannelAuthority({ projectDir, runtimeRoot: repositoryRoot });
  if (authority.source !== "project") throw new Error("Restore all Koya project authority files before exporting a handoff bundle.");
  const showBible = authority.showBible;
  for (const relativePath of [...PROJECT_CONFIG_PATHS, ...await stylingSpecPaths(projectDir, showBible)]) {
    files.push(await copyEvidence(resolveInside(projectDir, relativePath), bundleRoot, `project/${relativePath}`, "project-authority"));
  }
  for (const relativePath of CONTRACT_SNAPSHOT_PATHS) {
    files.push(await copyEvidence(resolveInside(projectDir, relativePath), bundleRoot, `contract-snapshot/${relativePath}`, "plugin-contract-snapshot"));
  }
  const registry = await buildPortableRegistry({ projectDir, canvasDir, bundleRoot, bundleId: id, showBible, characterIds: args.characterIds, files });
  const registryPath = resolveInside(bundleRoot, "project/canvas/characters.json");
  await writeJsonAtomic(registryPath, registry);
  files.push(await fileEvidence(bundleRoot, registryPath, "approved-character-registry"));
  const profiles = await buildPortableVisualProfiles({ projectDir, canvasDir, bundleRoot, visualProfileIds: args.visualProfileIds, files });
  const profilesPath = resolveInside(bundleRoot, "project/canvas/channel-visual-profiles.json");
  await writeJsonAtomic(profilesPath, profiles);
  files.push(await fileEvidence(bundleRoot, profilesPath, "locked-visual-profile"));
  const bootstrap = await auditKoyaCharacterBootstrap({
    showBible,
    registry: await readCharacterRegistry({ projectDir, canvasDir }),
    workflowStore: await readCharacterWorkflowStore({ projectDir, canvasDir }),
  });
  const pendingApprovals = {
    version: "koya-handoff-pending-approvals-v1",
    createdAt: new Date().toISOString(),
    complete: bootstrap.pass,
    approvedCount: bootstrap.approvedCount,
    onHoldCount: bootstrap.onHoldCount,
    blockingCount: bootstrap.blockingCount,
    rows: bootstrap.rows.map((row) => ({
      id: row.id,
      name: row.name,
      designStatus: row.designStatus,
      selectedBaseLabel: row.selectedBaseLabel,
      stage: row.stage,
      declaredStylingSpecCount: row.declaredStylingSpecCount,
      selectedStylingRoundCount: row.selectedStylingRoundCount,
      requiredReferenceRoles: row.requiredReferenceRoles,
      availableReferenceRoles: row.availableReferenceRoles,
      nextAction: row.nextAction,
    })),
    note: "Read-only sanitized status. Candidate files, private mappings, workflow IDs, review paths, session IDs, and credentials are intentionally excluded.",
  };
  const pendingApprovalsPath = resolveInside(bundleRoot, "project/koya-pending-approvals.json");
  await writeJsonAtomic(pendingApprovalsPath, pendingApprovals);
  files.push(await fileEvidence(bundleRoot, pendingApprovalsPath, "pending-approval-status"));
  const readmePath = resolveInside(bundleRoot, "README.md");
  await writeFile(readmePath, [
    "# 漫画動画ハーネス 案件データ束",
    "",
    "このフォルダはBuzzAssistプラグイン本体ではありません。先に受領側へ安定版BuzzAssistを導入し、その後、公式CLIまたはMCPでこの束をverify/restoreしてください。",
    "候補の秘密対応表、Claude/Codexセッションログ、APIキー、未承認人物は含みません。",
    "比較シートは人物参照ではなく、登録済み個別assetだけが生成時の人物参照です。",
    "承認reviewは原文SHAと判断snapshotを持つ移送用attestationへ変換し、送信元端末の絶対pathを含めません。",
    "project/koya-pending-approvals.json は送付時点の未完工程を、候補ファイル・private mapping・workflow/session pathなしで示します。",
    "",
  ].join("\n"), "utf8");
  files.push(await fileEvidence(bundleRoot, readmePath, "instructions"));
  files.sort((left, right) => left.path.localeCompare(right.path));
  const manifestBody = {
    version: KOYA_HANDOFF_BUNDLE_VERSION,
    id,
    createdAt: new Date().toISOString(),
    includes: {
      approvedCharacters: registry.characters.length,
      voices: registry.voices.length,
      visualProfiles: profiles.profiles.length,
      pendingApprovalRows: pendingApprovals.rows.length,
      unapprovedCandidates: false,
      privateCandidateMapping: false,
      sessionLogs: false,
      credentials: false,
    },
    files,
  };
  const manifest = { ...manifestBody, digest: createHash("sha256").update(JSON.stringify(manifestBody)).digest("hex") };
  await writeJsonAtomic(join(bundleRoot, "manifest.json"), manifest);
  await verifyKoyaHandoffBundle({ bundleDir: bundleRoot });
  return { ok: true, bundleRoot, manifestPath: join(bundleRoot, "manifest.json"), manifest };
}

async function walkFiles(root, current = root) {
  const output = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Symlinks are forbidden in a handoff bundle: ${path}`);
    if (entry.isDirectory()) output.push(...await walkFiles(root, path));
    else if (entry.isFile()) output.push(portablePath(relative(root, path)));
  }
  return output;
}

export async function verifyKoyaHandoffBundle(args = {}) {
  const bundleRoot = resolve(nonEmptyString(args.bundleDir ?? args.bundlePath));
  if (!nonEmptyString(args.bundleDir ?? args.bundlePath)) throw new Error("bundleDir is required.");
  const manifest = await readJsonStrict(join(bundleRoot, "manifest.json"));
  if (manifest.version !== KOYA_HANDOFF_BUNDLE_VERSION) throw new Error(`Unsupported Koya handoff version: ${manifest.version || "(missing)"}.`);
  const body = { ...manifest };
  delete body.digest;
  const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  if (digest !== manifest.digest) throw new Error("Koya handoff manifest digest mismatch.");
  const failures = [];
  const expected = new Set(["manifest.json"]);
  for (const row of Array.isArray(manifest.files) ? manifest.files : []) {
    const relativePath = safeBundleRelative(row.path);
    expected.add(relativePath);
    const path = resolveInside(bundleRoot, relativePath);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) failures.push(`${relativePath} is not a regular file.`);
      else {
        if (info.size !== row.size) failures.push(`${relativePath} size mismatch.`);
        if (await sha256File(path) !== row.sha256) failures.push(`${relativePath} SHA-256 mismatch.`);
      }
    } catch (error) { failures.push(`${relativePath}: ${error.message}`); }
  }
  for (const actual of await walkFiles(bundleRoot)) if (!expected.has(actual)) failures.push(`Unexpected file in bundle: ${actual}`);
  if (failures.length > 0) throw new Error(`Koya handoff verification failed:\n- ${failures.join("\n- ")}`);
  await readKoyaChannelAuthority({ projectDir: join(bundleRoot, "project"), runtimeRoot: repositoryRoot });
  const pendingApprovals = await readJsonStrict(join(bundleRoot, "project", "koya-pending-approvals.json"));
  if (pendingApprovals.version !== "koya-handoff-pending-approvals-v1"
    || !Array.isArray(pendingApprovals.rows)
    || pendingApprovals.rows.length !== Number(manifest?.includes?.pendingApprovalRows)
    || containsAbsolutePath(pendingApprovals)) {
    throw new Error("Koya handoff pending-approval status is missing, malformed, or leaks an absolute path.");
  }
  await verifyPortableRegistryEvidence(bundleRoot);
  return { ok: true, bundleRoot, manifestPath: join(bundleRoot, "manifest.json"), manifest };
}

function restoreCanvasToken(value, prefix) {
  if (typeof value !== "string" || !value.startsWith(CANVAS_TOKEN)) return value;
  return portablePath(join(prefix, value.slice(CANVAS_TOKEN.length)));
}

function bundleCanvasTokenPath(bundleRoot, value) {
  if (typeof value !== "string" || !value.startsWith(CANVAS_TOKEN)) throw new Error(`Handoff evidence path is not portable: ${value || "(missing)"}`);
  return resolveInside(join(bundleRoot, "project", "canvas"), value.slice(CANVAS_TOKEN.length));
}

function containsAbsolutePath(value) {
  if (Array.isArray(value)) return value.some(containsAbsolutePath);
  if (value && typeof value === "object") return Object.values(value).some(containsAbsolutePath);
  return typeof value === "string" && (isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value));
}

async function verifyPortableRegistryEvidence(bundleRoot) {
  const registryPath = join(bundleRoot, "project", "canvas", "characters.json");
  const registry = normalizeCharacterRegistry(await readJsonStrict(registryPath));
  const failures = [];
  for (const character of registry.characters) {
    for (const asset of character.referenceAssets || []) {
      try {
        const path = bundleCanvasTokenPath(bundleRoot, asset.path);
        if (await sha256File(path) !== nonEmptyString(asset.sha256)) failures.push(`${character.id}/${asset.id || asset.role} asset SHA-256 mismatch.`);
      } catch (error) { failures.push(`${character.id}/${asset.id || asset.role}: ${error.message}`); }
    }
    const reviewToken = nonEmptyString(character?.approval?.identityReviewPath);
    if (!reviewToken) {
      failures.push(`${character.id} is approved without portable review attestation.`);
      continue;
    }
    try {
      const reviewPath = bundleCanvasTokenPath(bundleRoot, reviewToken);
      const actualSha256 = await sha256File(reviewPath);
      if (actualSha256 !== nonEmptyString(character.approval.identityReviewSha256)) failures.push(`${character.id} review attestation SHA-256 mismatch.`);
      const attestation = await readJsonStrict(reviewPath);
      if (attestation.version !== KOYA_HANDOFF_REVIEW_ATTESTATION_VERSION || attestation.subjectId !== character.id) failures.push(`${character.id} review attestation version or subject is invalid.`);
      if (!/^[a-f0-9]{64}$/u.test(nonEmptyString(attestation?.sourceReview?.sha256))) failures.push(`${character.id} review attestation is missing the source review SHA-256.`);
      if (containsAbsolutePath(attestation)) failures.push(`${character.id} review attestation leaks a source-machine absolute path.`);
      for (const asset of character.referenceAssets || []) {
        if (!nonEmptyString(asset.sourceReviewPath)) failures.push(`${character.id}/${asset.id || asset.role} is missing its review attestation link.`);
        else if (asset.sourceReviewPath !== reviewToken) failures.push(`${character.id}/${asset.id || asset.role} points at a different review attestation.`);
      }
    } catch (error) { failures.push(`${character.id} review attestation: ${error.message}`); }
  }
  if (failures.length > 0) throw new Error(`Koya portable registry evidence failed:\n- ${failures.join("\n- ")}`);
  return { pass: true, characterCount: registry.characters.length };
}

async function copyProjectAssetTree(bundleRoot, sourceDir, targetDir) {
  if (!await pathExists(sourceDir)) return [];
  const copied = [];
  for (const relativePath of await walkFiles(sourceDir)) {
    const source = resolveInside(sourceDir, relativePath);
    const destination = resolveInside(targetDir, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    copied.push(destination);
  }
  return copied;
}

export async function restoreKoyaHandoffBundle(args = {}) {
  const verified = await verifyKoyaHandoffBundle(args);
  const bundleRoot = verified.bundleRoot;
  const projectDir = resolve(nonEmptyString(args.projectDir) || process.cwd());
  const canvasDir = resolveCanvasDir({ ...args, projectDir });
  const targetContract = join(repositoryRoot, "config", "koya-manga-production-contract.json");
  const snapshotContract = join(bundleRoot, "contract-snapshot", "config", "koya-manga-production-contract.json");
  if (await sha256File(targetContract) !== await sha256File(snapshotContract)) {
    throw new Error("Installed Koya production contract differs from the handoff snapshot. Install the matching stable BuzzAssist release before restore.");
  }
  for (const relativePath of [...PROJECT_CONFIG_PATHS, ...await stylingSpecPaths(join(bundleRoot, "project"), await readJsonStrict(resolveChannelPackPath(join(bundleRoot, "project"), "config/koya-show-bible.json")))]) {
    const source = resolveInside(join(bundleRoot, "project"), relativePath);
    const destination = resolveInside(projectDir, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  const assetPrefix = portablePath(join("koya-handoff-assets", verified.manifest.id));
  const copiedAssets = await copyProjectAssetTree(
    bundleRoot,
    join(bundleRoot, "project", "canvas", "assets"),
    join(canvasDir, assetPrefix, "assets"),
  );
  const incomingRegistry = normalizeCharacterRegistry(await readJsonStrict(join(bundleRoot, "project", "canvas", "characters.json")));
  for (const character of incomingRegistry.characters) {
    character.referenceImagePaths = character.referenceImagePaths.map((value) => restoreCanvasToken(value, assetPrefix));
    character.referenceAssets = character.referenceAssets.map((asset) => ({
      ...asset,
      path: restoreCanvasToken(asset.path, assetPrefix),
      sourceReviewPath: restoreCanvasToken(asset.sourceReviewPath, assetPrefix),
    }));
    if (character.approval) character.approval.identityReviewPath = restoreCanvasToken(character.approval.identityReviewPath, assetPrefix);
  }
  const currentRegistry = await readCharacterRegistry({ projectDir, canvasDir });
  const incomingIds = new Set(incomingRegistry.characters.map((entry) => entry.id));
  const mergedRegistry = {
    ...currentRegistry,
    characters: [...currentRegistry.characters.filter((entry) => !incomingIds.has(entry.id)), ...incomingRegistry.characters],
    voices: [...currentRegistry.voices.filter((entry) => !incomingRegistry.voices.some((incoming) => incoming.id === entry.id)), ...incomingRegistry.voices],
  };
  const writtenRegistry = await writeCharacterRegistry({ projectDir, canvasDir }, mergedRegistry);
  const incomingProfiles = normalizeChannelVisualProfileStore(await readJsonStrict(join(bundleRoot, "project", "canvas", "channel-visual-profiles.json")));
  for (const profile of incomingProfiles.profiles) {
    profile.referenceImages = profile.referenceImages.map((reference) => ({ ...reference, path: restoreCanvasToken(reference.path, assetPrefix) }));
  }
  const targetProfilePath = join(canvasDir, "channel-visual-profiles.json");
  const currentProfiles = await pathExists(targetProfilePath)
    ? normalizeChannelVisualProfileStore(await readJsonStrict(targetProfilePath))
    : normalizeChannelVisualProfileStore(null);
  const incomingProfileIds = new Set(incomingProfiles.profiles.map((entry) => entry.id));
  const mergedProfiles = normalizeChannelVisualProfileStore({
    version: 1,
    defaultProfileId: incomingProfiles.defaultProfileId || currentProfiles.defaultProfileId,
    profiles: [...currentProfiles.profiles.filter((entry) => !incomingProfileIds.has(entry.id)), ...incomingProfiles.profiles],
  });
  await writeJsonAtomic(targetProfilePath, mergedProfiles);
  return {
    ok: true,
    bundleId: verified.manifest.id,
    projectDir,
    canvasDir,
    copiedAssets: copiedAssets.length,
    restoredCharacters: incomingRegistry.characters.length,
    restoredVisualProfiles: incomingProfiles.profiles.length,
    registryRevision: writtenRegistry.revision,
  };
}
