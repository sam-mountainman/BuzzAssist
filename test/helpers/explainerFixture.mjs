// 解説動画のハーネス（explainer-video）の試験の合成の材料。チャンネル名・人名は合成、動画・字幕・サムネは ffmpeg で
// 作る小さな合成。test/explainerVideo.test.mjs と test/explainerHumanReview.test.mjs が同じものを使う。

import { execFile as execFileCallback } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createChannelPackEnvelope } from "../../lib/channelPackEnvelope.mjs";
import { EXPLAINER_CHANNEL_PACK_FILE, EXPLAINER_PAYLOAD_KIND } from "../../lib/explainerChannelPack.mjs";
import { resolveFfmpegToolchain } from "../../lib/harnessRuntimeResolver.mjs";
import { executeVideoHarnessAdapter, prepareVideoHarnessJob } from "../../lib/videoHarnessAdapters.mjs";
import { createVideoHarnessJob, runVideoHarnessJob } from "../../lib/videoHarnessJob.mjs";

const execFile = promisify(execFileCallback);
export const toolchain = await resolveFfmpegToolchain();
export const needsFfmpeg = { skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable" };
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const CHANNEL = "sample-explainer";
export const SCRIPT_TEXT = "# 合成の解説\n\n合成の台本の一文目。\n\n合成の台本の二文目。\n";

export async function ffmpeg(args) {
  await execFile(toolchain.ffmpeg.command, [...(toolchain.ffmpeg.args || []), "-hide_banner", "-loglevel", "error", "-y", ...args]);
}

/** 声だけ（文の間に無音）の3秒の動画。bgm: true なら低い持続音を敷く。color で画の色を変えられる（別の MP4 を作る）。 */
export async function makeVideo(file, { bgm = false, color = "blue" } = {}) {
  const voice = "if(lt(mod(t\\,1)\\,0.6)\\,0.3*sin(2*PI*440*t)\\,0)";
  const expression = bgm ? `${voice}+0.03*sin(2*PI*220*t)` : voice;
  await ffmpeg([
    "-f", "lavfi", "-i", `color=c=${color}:s=320x180:r=30:d=3`,
    "-f", "lavfi", "-i", `aevalsrc=${expression}:s=48000:d=3`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file,
  ]);
}

export async function probe(file) {
  const { stdout } = await execFile(toolchain.ffprobe.command, [...(toolchain.ffprobe.args || []), "-v", "error",
    "-show_entries", "stream=codec_type,width,height,nb_frames:format=duration", "-of", "json", file]);
  const parsed = JSON.parse(stdout);
  const video = parsed.streams.find((stream) => stream.codec_type === "video");
  return { duration: Number(parsed.format.duration), width: video.width, height: video.height, frames: Number(video.nb_frames) };
}

const DUMMY_PRODUCER = `// 合成のダミーの制作スクリプト（試験用）。受け取った引数を記録し、用意済みの成果物で納品の記録を書き直す。
import { createHash } from "node:crypto";
import { copyFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
writeFileSync(path.join(root, "producer-ran.json"), JSON.stringify({ args }));
const output = value("--output-dir");
for (const name of ["final.mp4", "captions.srt", "thumbnail.jpg", "UPLOAD.md", "DELIVERY.json"]) {
  copyFileSync(path.join(root, "prepared", name), path.join(output, name));
}
`;

/**
 * 合成の制作のフォルダ（videoRoot）: production/SCRIPT.md、out/ の完成版と DELIVERY.json、prepared/ に同じ写し、
 * scripts/produce.mjs（ダミーの制作）。captions / bgm で字幕と音を差し替えられる。
 */
export async function createFixture({ captions = "1\n00:00:00,100 --> 00:00:00,900\n合成の字幕1\n\n2\n00:00:01,100 --> 00:00:02,500\n\n合成の字幕2 20ページ\n", bgm = false } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), "explainer-video-"));
  const videoRoot = path.join(base, "video-root");
  const out = path.join(videoRoot, "out");
  const production = path.join(videoRoot, "production");
  const prepared = path.join(videoRoot, "prepared");
  for (const dir of [out, production, prepared, path.join(videoRoot, "visuals"), path.join(videoRoot, "scripts")]) await mkdir(dir, { recursive: true });
  const scriptPath = path.join(production, "SCRIPT.md");
  await writeFile(scriptPath, SCRIPT_TEXT);
  const video = path.join(out, "final.mp4");
  await makeVideo(video, { bgm });
  const facts = await probe(video);
  await writeFile(path.join(out, "captions.srt"), captions);
  await ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=1280x720", "-frames:v", "1", path.join(out, "thumbnail.jpg")]);
  await writeFile(path.join(out, "UPLOAD.md"), "# 合成の投稿用情報\n");
  const shaOf = async (file) => sha256(await readFile(file));
  const scriptSha256 = await shaOf(scriptPath);
  const videoBytes = (await readFile(video)).length;
  const delivery = {
    script_sha256: scriptSha256,
    video: {
      script_sha256: scriptSha256,
      file: video,
      sha256: await shaOf(video),
      bytes: videoBytes,
      duration_seconds: facts.duration,
      width: facts.width,
      height: facts.height,
      fps: 30,
      frames: String(facts.frames),
      bgm,
    },
    captions: path.join(out, "captions.srt"),
    captions_sha256: await shaOf(path.join(out, "captions.srt")),
    thumbnail: path.join(out, "thumbnail.jpg"),
    thumbnail_sha256: await shaOf(path.join(out, "thumbnail.jpg")),
    upload_metadata: path.join(out, "UPLOAD.md"),
    script: scriptPath,
  };
  await writeFile(path.join(out, "DELIVERY.json"), `${JSON.stringify(delivery, null, 2)}\n`);
  for (const name of ["final.mp4", "captions.srt", "thumbnail.jpg", "UPLOAD.md", "DELIVERY.json"]) {
    await writeFile(path.join(prepared, name), await readFile(path.join(out, name)));
  }
  await writeFile(path.join(videoRoot, "scripts", "produce.mjs"), DUMMY_PRODUCER);
  const pins = {
    deliverySha256: await shaOf(path.join(out, "DELIVERY.json")),
    scriptSha256,
    videoSha256: delivery.video.sha256,
    captionsSha256: delivery.captions_sha256,
    thumbnailSha256: delivery.thumbnail_sha256,
    uploadMetadataSha256: await shaOf(path.join(out, "UPLOAD.md")),
  };
  return { base, videoRoot, scriptPath, delivery, pins };
}

export function packPayload(fixture, overrides = {}) {
  return {
    version: "buzzassist-explainer-channel-pack-v1",
    channelId: CHANNEL,
    harnessId: "explainer-video",
    videoRoot: fixture.videoRoot,
    paths: { productionDir: "production", visualsDir: "visuals", outputDir: "out" },
    delivery: { file: "out/DELIVERY.json" },
    release: fixture.pins,
    scriptQuality: { genre: "explainer", workDir: "production" },
    assetQuality: { workDir: ".", stages: ["thumbnail"] },
    display: { bgm: "none", numerals: "arabic" },
    production: {
      steps: [{ id: "produce", argv: ["node", "scripts/produce.mjs", "--production-dir", "{productionDir}", "--visuals-dir", "{visualsDir}", "--output-dir", "{outputDir}"] }],
    },
    ...overrides,
  };
}

export function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }),
  };
}

export async function signPack(fixture, payload, name = "pack") {
  const source = path.join(fixture.base, `${name}-source`);
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, EXPLAINER_CHANNEL_PACK_FILE), `${JSON.stringify(payload, null, 2)}\n`);
  const key = keyPair();
  const bundleDir = path.join(fixture.base, name);
  await createChannelPackEnvelope({
    sourceDir: source,
    outputDir: bundleDir,
    id: "synthetic-explainer-pack",
    version: "1.0.0",
    harnessId: "explainer-video",
    payloadKind: EXPLAINER_PAYLOAD_KIND,
    privateKeyPem: key.privateKeyPem,
  });
  return { bundleDir, publicKeyPem: key.publicKeyPem };
}

export const passingGates = {
  scriptQualityCheck: async () => ({ pass: true, reasonCode: "script-quality-passed", acceptedBy: "quality-loop", issues: [], next: [], evidence: { genre: "explainer" } }),
  assetQualityCheck: async ({ stage }) => ({ stage, pass: true, code: "", detail: "合成の合格" }),
};

// 運営者の配置表（追跡しない config/harness-deployments.json）は端末ごとに違い、explainer-video の行が無い
// 端末もある。試験は同梱の例の配置表を明示して使い、運営者の設定に頼らない。
export const EXAMPLE_DEPLOYMENTS = fileURLToPath(new URL("../../config/harness-deployments.example.json", import.meta.url));

export async function runJob({ fixture, bundleDir, publicKeyPem, projectDir, options = {} }) {
  const created = await createVideoHarnessJob({
    projectDir,
    scriptPath: fixture.scriptPath,
    harnessId: "explainer-video",
    channelPackPath: bundleDir,
    options,
    deploymentPath: EXAMPLE_DEPLOYMENTS,
  });
  const run = () => runVideoHarnessJob({
    projectDir,
    jobId: created.job.id,
    doctor: async () => ({ ready: true, blocking: [], checks: [] }),
    prepare: ({ job }) => prepareVideoHarnessJob({ job, trustedKey: { trustedPublicKeyPem: publicKeyPem }, env: {} }),
    adapter: executeVideoHarnessAdapter,
    projectCanvas: async () => {},
  });
  return { created, run };
}
