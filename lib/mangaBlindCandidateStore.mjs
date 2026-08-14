import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
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
