import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

import { writeJsonAtomic } from "./canvasScene.mjs";
import { createBlindCandidateSet, revealBlindSelection } from "./mangaQualityHarness.mjs";
import { sha256File } from "./mangaQualityEvidence.mjs";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

async function localFile(path) {
  try { return (await stat(resolve(path))).isFile(); } catch { return false; }
}

async function copyFileAtomic(sourcePath, destinationPath) {
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  if (source === destination) return;
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await copyFile(source, temporary);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function writeBlindCandidatePackage(candidates, options = {}) {
  const rootDir = resolve(options.rootDir);
  const candidateSet = createBlindCandidateSet(candidates, options);
  const artifactDir = resolve(options.artifactDir || join(rootDir, "artifacts"));
  await mkdir(artifactDir, { recursive: true });
  const publicCandidates = [];
  const privateMapping = [];
  for (const mapping of candidateSet.privateMapping.mapping) {
    const sourceArtifact = mapping.artifact;
    let artifactRef = sourceArtifact;
    let artifactSha256 = mapping.artifactSha256;
    if (await localFile(sourceArtifact)) {
      const extension = extname(sourceArtifact) || ".bin";
      artifactRef = join(artifactDir, `${mapping.label}${extension.toLowerCase()}`);
      await copyFile(resolve(sourceArtifact), artifactRef);
      artifactSha256 = await sha256File(artifactRef);
    }
    publicCandidates.push({ label: mapping.label, artifactRef, artifactSha256 });
    privateMapping.push({ ...mapping, artifact: resolve(sourceArtifact), artifactSha256 });
  }
  const packetBody = {
    version: "koya-blind-judge-packet-v1",
    setId: candidateSet.setId,
    candidates: publicCandidates,
    instructions: candidateSet.judgePacket.instructions,
  };
  const publicPacket = { ...packetBody, digest: digest(packetBody) };
  const privateBody = {
    version: "koya-blind-private-mapping-v1",
    setId: candidateSet.setId,
    salt: candidateSet.privateMapping.salt,
    publicPacketDigest: publicPacket.digest,
    mapping: privateMapping,
  };
  const privatePacket = { ...privateBody, digest: digest(privateBody) };
  const publicPath = join(rootDir, "judge-packet.json");
  const privatePath = join(rootDir, "private-mapping.json");
  await Promise.all([
    writeJsonAtomic(publicPath, publicPacket),
    writeJsonAtomic(privatePath, privatePacket),
  ]);
  return {
    version: "koya-blind-candidate-package-v1",
    setId: candidateSet.setId,
    publicPath,
    privatePath,
    publicPacket,
  };
}

// Legacy review sheets sometimes published stable A-E labels before the
// private packet was rebuilt. Re-shuffling those labels after a human has
// reviewed the sheet would silently change the selected person, so migration
// uses this stricter writer. It is intentionally capped at the same five
// candidates as the quality contract and requires a complete A..N label set.
export async function writePreservedBlindCandidatePackage(candidates, options = {}) {
  const rootDir = resolve(options.rootDir);
  const artifactDir = resolve(options.artifactDir || join(rootDir, "artifacts"));
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > 5) {
    throw new Error("Preserved blind migration requires 2 to 5 candidates.");
  }
  const normalized = candidates.map((entry) => ({
    label: String(entry?.label || "").trim().toUpperCase(),
    id: String(entry?.id || "").trim(),
    provider: String(entry?.provider || "").trim(),
    source: String(entry?.source || "").trim(),
    artifact: resolve(String(entry?.artifact ?? entry?.filePath ?? "")),
    artifactSha256: String(entry?.artifactSha256 || "").trim().toLowerCase(),
    variationAxis: String(entry?.variationAxis || "").trim(),
  })).sort((left, right) => left.label.localeCompare(right.label));
  const expectedLabels = normalized.map((_, index) => String.fromCharCode(65 + index));
  if (normalized.some((entry, index) => entry.label !== expectedLabels[index])) {
    throw new Error(`Preserved blind labels must be a complete ${expectedLabels.join("/")} set.`);
  }
  if (normalized.some((entry) => !entry.id) || new Set(normalized.map((entry) => entry.id)).size !== normalized.length) {
    throw new Error("Preserved blind candidate IDs must be unique and non-empty.");
  }
  if (normalized.some((entry) => !entry.variationAxis) || new Set(normalized.map((entry) => entry.variationAxis)).size !== normalized.length) {
    throw new Error("Preserved blind candidates require unique, non-empty variationAxis values.");
  }
  await mkdir(artifactDir, { recursive: true });
  const publicCandidates = [];
  const privateMapping = [];
  const sourceDigests = new Set();
  for (const entry of normalized) {
    if (!(await localFile(entry.artifact))) throw new Error(`Preserved blind source is missing: ${entry.label}`);
    const sourceSha256 = await sha256File(entry.artifact);
    if (entry.artifactSha256 && entry.artifactSha256 !== sourceSha256) {
      throw new Error(`Preserved blind source digest mismatch: ${entry.label}`);
    }
    if (sourceDigests.has(sourceSha256)) throw new Error(`Preserved blind candidates must contain distinct image bytes: ${entry.label}`);
    sourceDigests.add(sourceSha256);
    const extension = extname(entry.artifact) || ".bin";
    const artifactRef = join(artifactDir, `${entry.label}${extension.toLowerCase()}`);
    await copyFileAtomic(entry.artifact, artifactRef);
    const artifactSha256 = await sha256File(artifactRef);
    if (artifactSha256 !== sourceSha256) throw new Error(`Preserved blind copy digest mismatch: ${entry.label}`);
    publicCandidates.push({ label: entry.label, artifactRef, artifactSha256 });
    privateMapping.push({ ...entry, artifactSha256: sourceSha256 });
  }
  const salt = String(options.salt || "").trim() || randomBytes(16).toString("hex");
  const setId = digest({ salt, labels: privateMapping.map((entry) => entry.label), ids: privateMapping.map((entry) => entry.id) });
  const packetBody = {
    version: "koya-blind-judge-packet-v1",
    setId,
    candidates: publicCandidates,
    instructions: "候補の出所・生成モデル・生成順・変化軸を推測せず、固定rubricのみで比較する。A〜Eは公開済みレビューシートのラベルを維持した移行セットであり、採用ラベルと理由を確定する前にprivate mappingを開かない。",
  };
  const publicPacket = { ...packetBody, digest: digest(packetBody) };
  const privateBody = {
    version: "koya-blind-private-mapping-v1",
    setId,
    salt,
    publicPacketDigest: publicPacket.digest,
    mapping: privateMapping,
  };
  const privatePacket = { ...privateBody, digest: digest(privateBody) };
  const publicPath = join(rootDir, "judge-packet.json");
  const privatePath = join(rootDir, "private-mapping.json");
  await Promise.all([
    writeJsonAtomic(publicPath, publicPacket),
    writeJsonAtomic(privatePath, privatePacket),
  ]);
  return {
    version: "koya-blind-candidate-package-v1",
    setId,
    publicPath,
    privatePath,
    publicPacket,
  };
}

export async function recordBlindCandidateVerdict(options = {}) {
  const publicPath = resolve(options.publicPath);
  const privatePath = resolve(options.privatePath);
  const [publicPacket, privatePacket] = await Promise.all([
    readFile(publicPath, "utf8").then(JSON.parse),
    readFile(privatePath, "utf8").then(JSON.parse),
  ]);
  const { digest: publicDigest, ...publicBody } = publicPacket;
  const { digest: privateDigest, ...privateBody } = privatePacket;
  if (digest(publicBody) !== publicDigest || digest(privateBody) !== privateDigest) {
    throw new Error("Blind candidate packet digest verification failed.");
  }
  if (publicPacket.setId !== privatePacket.setId || publicPacket.digest !== privatePacket.publicPacketDigest) {
    throw new Error("Blind candidate public packet and private mapping do not match.");
  }
  for (const candidate of publicPacket.candidates || []) {
    if (candidate.artifactRef && await localFile(candidate.artifactRef)) {
      const actual = await sha256File(candidate.artifactRef);
      if (actual !== candidate.artifactSha256) throw new Error(`Blind candidate artifact digest mismatch: ${candidate.label}`);
    }
  }
  const candidateSet = {
    setId: publicPacket.setId,
    privateMapping: {
      mapping: privatePacket.mapping,
      digest: privatePacket.digest,
    },
  };
  const verdictInput = {
    setId: publicPacket.setId,
    winnerLabel: options.winnerLabel,
    decidedBy: options.decidedBy,
    reason: options.reason,
    decidedAt: options.decidedAt || new Date().toISOString(),
  };
  const selected = revealBlindSelection(candidateSet, verdictInput);
  const verdictBody = {
    version: "koya-blind-verdict-v1",
    setId: publicPacket.setId,
    publicPacketDigest: publicPacket.digest,
    winnerLabel: selected.verdict.winnerLabel,
    decidedBy: selected.verdict.decidedBy,
    reason: selected.verdict.reason,
    decidedAt: selected.verdict.decidedAt,
  };
  const verdict = { ...verdictBody, digest: digest(verdictBody) };
  const verdictPath = resolve(options.verdictPath || join(dirname(publicPath), "verdict.json"));
  await writeJsonAtomic(verdictPath, verdict);
  return {
    verdictPath,
    verdict,
    selected: {
      id: selected.id,
      artifact: selected.artifact,
      artifactSha256: selected.artifactSha256,
      variationAxis: selected.variationAxis,
      provider: selected.provider,
      source: selected.source,
    },
  };
}

export function publicBlindCandidateSummary(packageResult) {
  return {
    version: packageResult.version,
    setId: packageResult.setId,
    publicPath: packageResult.publicPath,
    candidates: packageResult.publicPacket.candidates.map((candidate) => ({
      label: candidate.label,
      artifactRef: candidate.artifactRef,
      artifactSha256: candidate.artifactSha256,
    })),
  };
}
