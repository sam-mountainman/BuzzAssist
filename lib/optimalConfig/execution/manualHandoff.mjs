// 画面だけで API の無いサービス（Google Flow / Veo の Web 画面）への手渡し——手順書と取り込み口を作る。
//
// 守ること:
//   - 画面は自動で操作しない（ログインもクリックもしない）。運営者が自分のブラウザ・自分のアカウントで作る
//   - ハーネスが作るのは、カットごとの手順書（開始フレーム・プロンプト・尺・縦横比）と、できた動画を置く場所
//     （取り込み口）だけ。置かれた動画は SHA-256 と大きさを記録して取り込む
//   - 手順書のコマンドとパスは実際の値で埋める（<...> の穴を残さない）
//   - 素材はサービスへ送られる（運営者の契約の範囲）。外に出せない素材のチャンネルでは使わない（呼ぶ側の権利の関門で止まる）

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { writeJsonAtomic } from "../../atomicJsonFile.mjs";

export const MANUAL_HANDOFF_VERSION = "optimal-config-manual-handoff-v1";
export const MANUAL_HANDOFF_IMPORT_VERSION = "optimal-config-manual-handoff-import-v1";

export const MANUAL_HANDOFF_SERVICES = Object.freeze({
  "google-flow": Object.freeze({ label: "Google Flow", url: "https://labs.google/fx/tools/flow", catalogModelId: "veo", contract: "google-ai", output: "video" }),
  "gemini-veo": Object.freeze({ label: "Gemini アプリの Veo", url: "https://gemini.google.com/", catalogModelId: "veo", contract: "google-ai", output: "video" }),
});

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm"];
const CUT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;

function codedError(code, message, extra = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function quote(value) {
  return `'${String(value).replace(/'/gu, "'\\''")}'`;
}

function validateCuts(cuts) {
  if (!Array.isArray(cuts) || cuts.length === 0) throw codedError("handoff-cuts-missing", "手渡すカット（cuts）が1つ以上要る。");
  const seen = new Set();
  return cuts.map((cut, index) => {
    const cutId = nonEmpty(cut?.cutId);
    if (!CUT_ID.test(cutId)) throw codedError("handoff-cut-invalid", `cuts[${index}].cutId は英小文字・数字・-・_ の id にする。`);
    if (seen.has(cutId)) throw codedError("handoff-cut-invalid", `cutId ${cutId} が2回ある。`);
    seen.add(cutId);
    const prompt = nonEmpty(cut.prompt);
    if (!prompt) throw codedError("handoff-cut-invalid", `カット ${cutId} のプロンプトが無い。`);
    const durationSeconds = Number(cut.durationSeconds);
    return {
      cutId,
      prompt,
      startFramePath: nonEmpty(cut.startFramePath) ? path.resolve(cut.startFramePath) : null,
      durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
      aspect: nonEmpty(cut.aspect) || "16:9",
      notes: nonEmpty(cut.notes),
    };
  });
}

function instructionSheet({ service, spec, cuts, importDir, slotPath }) {
  const lines = [
    `# ${spec.label} への手渡し（手で作る）`,
    "",
    `このサービスは画面だけで API が無いので、ハーネスは画面を操作しない。運営者が自分のブラウザ・自分のアカウント（契約: ${spec.contract}）で作り、できた動画をこのフォルダに置く。`,
    "素材とプロンプトはサービスへ送られる。外に出せない素材は使わない。",
    "",
    "## 手順",
    "",
    `1. 自分のブラウザで ${spec.url} を開き、自分のアカウントでログインする（ハーネスはログインしない）。`,
    "2. 新しいプロジェクトを作る（このチャンネル・この回の名前にしておくと後で探しやすい）。",
    "3. 下のカットを1つずつ作る。開始フレームがあるカットは「画像から動画」で開始フレームの画像を入れ、プロンプトを貼り、尺と縦横比を合わせて生成する。",
    "4. 気に入った1本をダウンロードし、ファイル名をカット ID にして取り込み口に置く（例: 1つ目のカットなら下の「置く場所」）。",
    `   取り込み口: ${importDir}`,
    "5. 全部置いたら、端末で次を打って取り込む（置いた動画の SHA-256 と大きさが記録される）:",
    "",
    "```",
    `node scripts/optimal-config.mjs handoff-import --slot ${quote(slotPath)}`,
    "```",
    "",
    "## カット",
    "",
  ];
  for (const cut of cuts) {
    lines.push(`### ${cut.cutId}`);
    lines.push("");
    lines.push(`- 置く場所: ${path.join(importDir, `${cut.cutId}.mp4`)}（.mov / .webm でもよい）`);
    lines.push(`- 開始フレーム: ${cut.startFramePath || "なし（文章から作る）"}`);
    lines.push(`- 尺: ${cut.durationSeconds ? `${cut.durationSeconds} 秒` : "サービスの既定"}`);
    lines.push(`- 縦横比: ${cut.aspect}`);
    if (cut.notes) lines.push(`- メモ: ${cut.notes}`);
    lines.push("- プロンプト:");
    lines.push("");
    lines.push("```");
    lines.push(cut.prompt);
    lines.push("```");
    lines.push("");
  }
  lines.push(`（${service} / ${MANUAL_HANDOFF_VERSION}）`);
  return `${lines.join("\n")}\n`;
}

/**
 * 手順書と取り込み口を作る。workDir/handoff/<service>/<handoffId>/ に
 *   instructions.md（手順書）、slot.json（取り込み口の定義）、import/（運営者が動画を置くフォルダ）
 * を書く。既にある手渡しは上書きしない。
 */
export async function createManualHandoff({ service = "google-flow", cuts, workDir, handoffId = "", channelId = "", now = () => new Date().toISOString() } = {}) {
  const spec = MANUAL_HANDOFF_SERVICES[service];
  if (!spec) throw codedError("handoff-service-unknown", `手渡しのサービス ${service} は知らない（${Object.keys(MANUAL_HANDOFF_SERVICES).join(" / ")}）。`);
  if (!nonEmpty(workDir)) throw codedError("handoff-work-dir-missing", "作業フォルダ（workDir）が要る。");
  const validCuts = validateCuts(cuts);
  const createdAt = new Date(now()).toISOString();
  const id = nonEmpty(handoffId) || `${createdAt.replace(/[^0-9]/gu, "").slice(0, 14)}`;
  if (!CUT_ID.test(id)) throw codedError("handoff-id-invalid", "handoffId は英小文字・数字・-・_ の id にする。");
  const dir = path.join(path.resolve(workDir), "handoff", service, id);
  try {
    await lstat(dir);
    throw codedError("handoff-exists", `手渡し ${dir} は既にある。上書きしない（別の handoffId で作る）。`);
  } catch (error) {
    if (error.code === "handoff-exists") throw error;
  }
  const importDir = path.join(dir, "import");
  await mkdir(importDir, { recursive: true });
  const slotPath = path.join(dir, "slot.json");
  const instructionsPath = path.join(dir, "instructions.md");
  const slot = {
    version: MANUAL_HANDOFF_VERSION,
    service,
    serviceLabel: spec.label,
    catalogModelId: spec.catalogModelId,
    route: "manual-handoff",
    channelId: nonEmpty(channelId) || null,
    createdAt,
    importDir,
    cuts: validCuts.map((cut) => ({ ...cut, expectedBaseName: cut.cutId, allowedExtensions: VIDEO_EXTENSIONS })),
    automation: "none",
  };
  await writeJsonAtomic(slotPath, slot);
  await writeFile(instructionsPath, instructionSheet({ service, spec, cuts: validCuts, importDir, slotPath }));
  return { slotPath, instructionsPath, importDir, slot, next: `node scripts/optimal-config.mjs handoff-import --slot ${quote(slotPath)}` };
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

/**
 * 取り込み口に置かれた動画を記録する（imported.json）。足りないカットは missing に返す（埋めない・作らない）。
 * 同じ名前で拡張子が違うものが2つあれば、どちらか決めないで止める。
 */
export async function importManualHandoff({ slotPath, now = () => new Date().toISOString() } = {}) {
  const resolved = path.resolve(nonEmpty(slotPath));
  const slot = JSON.parse(await readFile(resolved, "utf8"));
  if (slot?.version !== MANUAL_HANDOFF_VERSION) throw codedError("handoff-slot-invalid", "取り込み口の定義（slot.json）の版が違う。");
  const importDir = path.join(path.dirname(resolved), "import");
  const names = new Set(await readdir(importDir));
  const imported = [];
  const missing = [];
  const problems = [];
  for (const cut of slot.cuts) {
    const hits = VIDEO_EXTENSIONS.map((extension) => `${cut.cutId}${extension}`).filter((name) => names.has(name));
    if (hits.length === 0) { missing.push(cut.cutId); continue; }
    if (hits.length > 1) { problems.push({ cutId: cut.cutId, code: "handoff-ambiguous", message: `${cut.cutId} の動画が ${hits.join(" と ")} の2つある。使う1つだけを残す。` }); continue; }
    const filePath = path.join(importDir, hits[0]);
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) { problems.push({ cutId: cut.cutId, code: "handoff-not-regular-file", message: `${hits[0]} が通常のファイルではない。` }); continue; }
    if (info.size === 0 || info.size > MAX_IMPORT_BYTES) { problems.push({ cutId: cut.cutId, code: "handoff-size-invalid", message: `${hits[0]} の大きさ（${info.size} バイト）が取り込めない。` }); continue; }
    imported.push({ cutId: cut.cutId, path: filePath, sha256: await sha256File(filePath), bytes: info.size, route: "manual-handoff", service: slot.service, dataDestination: slot.serviceLabel });
  }
  const record = {
    version: MANUAL_HANDOFF_IMPORT_VERSION,
    slotSha256: createHash("sha256").update(await readFile(resolved)).digest("hex"),
    service: slot.service,
    importedAt: new Date(now()).toISOString(),
    complete: missing.length === 0 && problems.length === 0,
    imported,
    missing,
    problems,
  };
  await writeJsonAtomic(path.join(path.dirname(resolved), "imported.json"), record);
  return record;
}
