// Styling-variation pipeline (キャラ確定後の髪色/髪型/衣装すり合わせ用):
// 1) buildStylingVariationCandidateJobs — 各optionを、承認済み候補を身元参照にした
//    「独立した完全なキャラクターシート」ジョブとして組み立てる（横並び一覧は作らない）。
// 2) QA — 生成物は1枚ずつ manifest に source/output SHA-256・プロンプト・モデル・日時を
//    記録し、原寸目視QAの結果を markStylingVariationQa で保存する。
// 3) compose — 合格候補だけを scripts/compose-styling-variation-sheet.py で決定論的に
//    比較資料へ合成する（番号・日本語ラベルは画像モデルに描かせず後付けする）。
// 比較資料そのものは人物台帳へ登録しない。人間が選んだ個別候補だけを次工程
// （ターンアラウンド/表情シートのセル別同一人物QA→正式登録）へ進める。
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const STYLING_VARIATION_KINDS = new Set(["hairColor", "hairstyle", "outfit", "accessory", "mixed"]);

const IDENTITY_KEEP =
  "Reference image 1 is the APPROVED DESIGN for this character. Preserve the exact same face construction, age, " +
  "facial outline, eye shape, eyebrows, expression style, body build and proportions, rendering style, and the " +
  "candidate-card layout (pure white background, one full-body front view plus three head studies). " +
  "Do not draw any text, numbers or labels in the image.";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function buildStylingVariationCandidateJobs(baseCandidate, options = [], settings = {}) {
  const basePrompt = nonEmptyString(baseCandidate?.prompt);
  const baseFile = nonEmptyString(baseCandidate?.assetFile);
  if (!baseFile) throw new Error("baseCandidate.assetFile is required (approved design reference).");
  const kind = STYLING_VARIATION_KINDS.has(settings.kind) ? settings.kind : "mixed";
  const keepDirectives = nonEmptyString(settings.keepDirectives);
  return options.map((option, index) => {
    const id = nonEmptyString(option.id) || `variation-${index + 1}`;
    const change = nonEmptyString(option.change);
    if (!change) throw new Error(`options[${index}].change is required.`);
    const prompt = [
      basePrompt,
      "",
      IDENTITY_KEEP,
      keepDirectives ? `MUST KEEP: ${keepDirectives}` : "",
      `CHANGES (${kind}): ${change} Everything else identical to the reference.`,
    ].filter(Boolean).join("\n");
    return {
      id,
      kind,
      label: nonEmptyString(option.label) || id,
      prompt,
      model: nonEmptyString(settings.model) || "gpt-image-2-codex",
      aspectRatio: nonEmptyString(settings.aspectRatio) || "16:9",
      imageSize: nonEmptyString(settings.imageSize) || "2K",
      quality: nonEmptyString(settings.quality) || "high",
      referenceImagePaths: [baseFile],
      fileName: `${id}.png`,
    };
  });
}

export async function appendStylingVariationManifest(manifestPath, job, outputPath, outputBuffer) {
  const sourceSha256 = createHash("sha256").update(await readFile(job.referenceImagePaths[0])).digest("hex");
  const entry = {
    id: job.id,
    kind: job.kind,
    label: job.label,
    output: outputPath,
    outputSha256: createHash("sha256").update(outputBuffer).digest("hex"),
    sourceSha256,
    model: job.model,
    prompt: job.prompt,
    generatedAt: new Date().toISOString(),
    qa: { status: "pending", reason: "", reviewedAt: "" },
  };
  const manifest = await readStylingVariationManifest(manifestPath);
  manifest.entries = manifest.entries.filter((existing) => existing.id !== entry.id);
  manifest.entries.push(entry);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return entry;
}

export async function readStylingVariationManifest(manifestPath) {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    return { version: "styling-variation-manifest-v1", entries: [], ...parsed };
  } catch {
    return { version: "styling-variation-manifest-v1", entries: [] };
  }
}

// QA verdict per candidate after full-resolution human/agent inspection.
export async function markStylingVariationQa(manifestPath, id, status, reason) {
  if (!["passed", "failed"].includes(status)) throw new Error("status must be passed|failed");
  const manifest = await readStylingVariationManifest(manifestPath);
  const entry = manifest.entries.find((item) => item.id === id);
  if (!entry) throw new Error(`unknown styling variation id: ${id}`);
  entry.qa = { status, reason: nonEmptyString(reason), reviewedAt: new Date().toISOString() };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return entry;
}

export function passedStylingVariations(manifest) {
  return (manifest.entries ?? []).filter((entry) => entry.qa?.status === "passed");
}

export function stylingVariationComposeSpec(manifest, { title = "", noteLines = {} } = {}) {
  return {
    version: "styling-variation-compose-v1",
    title,
    pages: passedStylingVariations(manifest).map((entry) => ({
      id: entry.id,
      label: entry.label,
      note: nonEmptyString(noteLines[entry.id]),
      file: entry.output,
      outputSha256: entry.outputSha256,
    })),
  };
}
