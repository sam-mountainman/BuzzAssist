// 漫画（koya-manga-video）の Job の「途中の成果物」を、Canvas へ出す snapshot にする読み取り側。
// 描く側は lib/canvasRunProgressProjection.mjs（ジャンル共通）。ここは読むだけで、何も書かない。
//
// 読むもの（すべて Job の隔離 workspace = job.executionProjectDir の中）:
//   canvas/manga-videos/<話数>/koya-production-state.json   Koya の工程の状態
//   canvas/assets/<話数>/script-image-plan.json               本編の画の計画（pages がカット順）
//   canvas/assets/<話数>/image-generation-ledger.json         画の生成と QA の台帳
//   canvas/character-workflows.json                          人物の候補（匿名ラベル A〜E）と承認
//   canvas/characters.json                                   承認済みの人物と設定画（登録簿）
//   canvas/assets/<話数>/wardrobe-readiness.json              衣装の確認
//   canvas/manga-videos/<話数>/episode-manifest.json          カットの並び
//   canvas/manga-videos/<話数>/koya-dialogue-generation.json  カットごとの採用テイク
//   canvas/manga-videos/<話数>/.koya-dialogue-source/<cut>-voice-quality.json  声の検査
//   canvas/manga-videos/<話数>/video-substitution/<cut>/     差し替えのクリップと開始フレーム（manifest の結び付け）
//   canvas/quality/assets/*.json                             途中の成果物の品質ループ（lib/assetQualityLoop.mjs）。
//                                                            置き場はゲートと同じ koyaAssetQualityWorkDir（登録・最終監査が読む記録）
//
// 守ること:
//   - 作業場の外は読まない（symlink で外へ出る道も realpath で塞ぐ）。原本のパスは snapshot の
//     media.path にだけ持ち、Canvas には出さない（描く側が content-addressed の URL に替える）
//   - 承認前の人物は名前・人物 id・説明・候補の作り分けの軸を出さない。出すのは「人物 N」と
//     候補の匿名ラベル（A〜E）だけ。承認（候補の採用）が記録されてから名前を出す
//   - 読めない記録は例外にせず、何が読めなかったか（ファイル名だけ）を見出しに出す

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { assetQualityStatus, listAssetQualityStatus } from "./assetQualityLoop.mjs";
import { CANVAS_RUN_PROGRESS_SNAPSHOT_VERSION } from "./canvasRunProgressProjection.mjs";
import { getImageDimensionsFromBuffer } from "./canvasScene.mjs";
import { normalizeCharacterWorkflowStore } from "./characterPipeline.mjs";
import { normalizeCharacterRegistry } from "./characterRegistry.mjs";
import { koyaVideoClipAssetQualitySubjectId } from "./koyaAssetQualityGatePolicy.mjs";
import { koyaAssetQualityWorkDir } from "./koyaAssetQualityGate.mjs";
import { koyaSceneImageAssetQualitySubjectId, koyaVoiceTakeAssetQualitySubjectId } from "./koyaAssetQualityGatePolicy.mjs";

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
const WAVEFORM_BARS = 64;
const MAX_SHEETS_PER_CHARACTER = 5;
const SAFE_EPISODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * 工程の DAG。needs は依存（矢印の向き）。実行の順番は KOYA_PROGRESS_ORDER。
 * 声の人選は画の前（試聴の前検査）と音声の前の両方を止めるので、2本の矢印を持つ。
 */
export const KOYA_PROGRESS_DAG = Object.freeze([
  Object.freeze({ id: "doctor", title: "事前点検（doctor）", needs: [] }),
  Object.freeze({ id: "characters", title: "人物の承認", needs: ["doctor"] }),
  Object.freeze({ id: "wardrobe", title: "衣装の確認", needs: ["doctor"] }),
  Object.freeze({ id: "voice-selection", title: "声の人選", needs: ["doctor"] }),
  Object.freeze({ id: "images", title: "本編の画", needs: ["characters", "wardrobe", "voice-selection"] }),
  Object.freeze({ id: "layout", title: "構成・顔の配置", needs: ["images"] }),
  Object.freeze({ id: "speech", title: "台詞の音声", needs: ["layout", "voice-selection"] }),
  Object.freeze({ id: "render", title: "レンダー", needs: ["speech"] }),
  Object.freeze({ id: "final-audit", title: "最終監査", needs: ["render"] }),
  Object.freeze({ id: "signoff", title: "独立レビュー", needs: ["final-audit"] }),
  Object.freeze({ id: "receipt", title: "RunReceipt", needs: ["signoff"] }),
  Object.freeze({ id: "canvas-projection", title: "Canvas 投影", needs: ["receipt"] }),
]);

/** Koya の full が実際に進む順番（scripts/koya-manga-video.mjs full → runKoyaMangaFullProduction）。 */
export const KOYA_PROGRESS_ORDER = Object.freeze([
  "doctor", "voice-selection", "wardrobe", "characters", "images", "layout",
  "speech", "render", "final-audit", "signoff", "receipt", "canvas-projection",
]);

// 子（koya-manga-video.mjs full）の終了時の status と、Koya の状態ファイルの status から、
// いまどの工程で止まっているかを引く表。
const STATUS_TO_NODE = Object.freeze([
  [/^awaiting-voice-selection$/u, "voice-selection"],
  [/^awaiting-wardrobe-readiness$/u, "wardrobe"],
  [/^(?:awaiting-character-approval|character-)/u, "characters"],
  [/^(?:planned|images-paused)$/u, "images"],
  [/^(?:images-ready|awaiting-source-face-review)$/u, "layout"],
  [/^(?:waiting-usage-limit|speech-)/u, "speech"],
  [/^(?:waiting-paid-video-confirmation|video-substitution-|bubble-layout-ready)/u, "render"],
  [/-awaiting-render$/u, "render"],
  [/^(?:rendered-awaiting-audit|audit-incomplete)$/u, "final-audit"],
  [/^final-koya-audited$/u, "receipt"],
]);
const CURRENT_STAGE_TO_NODE = Object.freeze([
  [/^images$/u, "images"],
  [/^character-/u, "characters"],
  [/^wardrobe-readiness$/u, "wardrobe"],
  [/^source-face-placement$/u, "layout"],
  [/^speech$/u, "speech"],
  [/^(?:video-substitution|render)$/u, "render"],
  [/^audit$/u, "final-audit"],
]);
const SIGNOFF_AUDIT = /contact-sheet-review|signoff|quality-harness-final/u;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** 作業場の中か（Windows のパスは pathApi に path.win32 を渡して確かめる）。 */
export function isInsideKoyaWorkspace(workspace, candidate, { pathApi = path } = {}) {
  if (!nonEmpty(workspace) || !nonEmpty(candidate)) return false;
  const rel = pathApi.relative(pathApi.resolve(workspace), pathApi.resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel);
}

/**
 * 記録に書かれたパス（絶対、または base からの相対）を、作業場の中のときだけ絶対パスにする。
 * 外を指すパス・空は "" を返す（読まない）。
 */
export function resolveKoyaWorkspacePath(workspace, value, { base = workspace, pathApi = path } = {}) {
  const raw = nonEmpty(value);
  if (!raw || !nonEmpty(workspace)) return "";
  const full = pathApi.isAbsolute(raw) ? pathApi.resolve(raw) : pathApi.resolve(base, raw);
  return isInsideKoyaWorkspace(workspace, full, { pathApi }) ? full : "";
}

function createWorkspaceReader(workspace) {
  const notes = [];
  let realWorkspace = null;
  const note = (label) => {
    if (!notes.includes(label)) notes.push(label);
  };
  const confine = async (full) => {
    if (!full || !isInsideKoyaWorkspace(workspace, full)) return { error: "outside" };
    let info;
    try {
      info = await lstat(full);
    } catch (error) {
      return { error: error?.code === "ENOENT" ? "missing" : "unreadable" };
    }
    if (info.isSymbolicLink() || !info.isFile()) return { error: "not-regular-file" };
    try {
      realWorkspace ??= await realpath(workspace);
      if (!isInsideKoyaWorkspace(realWorkspace, await realpath(full))) return { error: "outside" };
    } catch {
      return { error: "unreadable" };
    }
    return { info };
  };
  return {
    notes,
    async json(full, label) {
      const checked = await confine(full);
      if (checked.error) {
        if (checked.error !== "missing") note(`${label}（${checked.error}）`);
        return null;
      }
      if (checked.info.size > MAX_JSON_BYTES) {
        note(`${label}（大きすぎる）`);
        return null;
      }
      try {
        return JSON.parse(await readFile(full, "utf8"));
      } catch {
        note(`${label}（JSON として読めない）`);
        return null;
      }
    },
    async media(full, kind) {
      const checked = await confine(full);
      if (checked.error) return { error: checked.error };
      if (checked.info.size === 0 || checked.info.size > MAX_MEDIA_BYTES) return { error: "size" };
      let bytes;
      try {
        bytes = await readFile(full);
      } catch {
        return { error: "unreadable" };
      }
      const media = { kind, path: full, sha256: sha256(bytes), bytes: bytes.length };
      if (kind === "image") {
        try {
          const dimensions = getImageDimensionsFromBuffer(bytes, "progress image");
          media.pixelWidth = dimensions.width;
          media.pixelHeight = dimensions.height;
        } catch {
          // 寸法を読めない形式は枠いっぱいに出す。
        }
      } else {
        const summary = wavSummary(bytes);
        if (summary) {
          media.durationSeconds = summary.durationSeconds;
          media.waveform = summary.waveform;
        }
      }
      return media;
    },
  };
}

/**
 * WAV（PCM 8/16/24/32bit、float 32/64bit）の長さと、振幅の包絡（0〜1 を bars 本）を返す。
 * 読めない形式は null（描く側は既存の音声アイコンにする）。最初のチャンネルだけを見る。
 */
export function wavSummary(bytes, bars = WAVEFORM_BARS) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44) return null;
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= bytes.length && !(format && data)) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt " && size >= 16 && start + 16 <= bytes.length) {
      format = {
        code: bytes.readUInt16LE(start),
        channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4),
        blockAlign: bytes.readUInt16LE(start + 12),
        bits: bytes.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      data = { start, size: Math.min(size, bytes.length - start) };
    }
    offset = start + size + (size % 2);
  }
  if (!format || !data || !format.sampleRate || !format.blockAlign || !format.channels) return null;
  const frames = Math.floor(data.size / format.blockAlign);
  const durationSeconds = Math.round((frames / format.sampleRate) * 1000) / 1000;
  const float = format.code === 3;
  const readers = {
    8: (at) => (bytes.readUInt8(at) - 128) / 128,
    16: (at) => bytes.readInt16LE(at) / 32768,
    24: (at) => bytes.readIntLE(at, 3) / 8388608,
    32: float ? (at) => bytes.readFloatLE(at) : (at) => bytes.readInt32LE(at) / 2147483648,
    64: float ? (at) => bytes.readDoubleLE(at) : null,
  };
  const read = readers[format.bits];
  if (!read || frames === 0) return { durationSeconds, waveform: [] };
  const peaks = new Array(bars).fill(0);
  const framesPerBar = Math.max(1, Math.ceil(frames / bars));
  const stride = Math.max(1, Math.floor(framesPerBar / 512));
  for (let bar = 0; bar < bars; bar += 1) {
    const end = Math.min(frames, (bar + 1) * framesPerBar);
    for (let frame = bar * framesPerBar; frame < end; frame += stride) {
      const value = Math.abs(read(data.start + frame * format.blockAlign));
      if (Number.isFinite(value) && value > peaks[bar]) peaks[bar] = value;
    }
  }
  const loudest = Math.max(...peaks);
  return {
    durationSeconds,
    waveform: peaks.map((peak) => (loudest > 0 ? Math.round((Math.min(1, peak / loudest)) * 1000) / 1000 : 0)),
  };
}

function nodeFrom(table, value) {
  const text = nonEmpty(value);
  if (!text) return "";
  return table.find(([pattern]) => pattern.test(text))?.[1] || "";
}

function outerStageStatus(job, id) {
  const status = nonEmpty((job?.stages || []).find((stage) => stage?.id === id)?.status) || "pending";
  if (["pass", "completed", "complete"].includes(status)) return "pass";
  if (["failed", "blocked-preflight"].includes(status)) return "fail";
  if (["running", "preflight-running"].includes(status)) return "running";
  if (status === "awaiting-human-review") return "awaiting-human-review";
  return "pending";
}

function jobPhase(job) {
  const status = nonEmpty(job?.status);
  if (["running", "preflight-running"].includes(status)) return "running";
  if (status === "awaiting-human-review") return "paused";
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  if (["cancelled", "cancel-requested"].includes(status)) return "cancelled";
  return "planned";
}

/**
 * 工程ごとの状態を決める。直接の証拠（台帳・報告・Job の段）があればそれを使い、無い工程は
 * 「いま止まっている工程」より前なら pass、その工程なら Job の状態、後なら pending とする。
 * 返す状態は pending / running / pass / fail / awaiting-human-review のどれか。
 */
export function deriveKoyaProgressDag(job, evidence = {}) {
  const phase = jobPhase(job);
  const running = phase === "running";
  const resultStatus = nonEmpty(job?.adapterResult?.status);
  const stateStatus = nonEmpty(evidence.state?.status);
  const codes = [resultStatus, stateStatus].filter(Boolean);
  const failedAuditIds = Array.isArray(job?.adapterResult?.failedAuditIds) ? job.adapterResult.failedAuditIds.map(String) : [];
  const signoffAuditFailed = failedAuditIds.some((id) => SIGNOFF_AUDIT.test(id));
  const otherAuditFailed = failedAuditIds.some((id) => !SIGNOFF_AUDIT.test(id));
  const imagesStarted = Boolean(evidence.plan || evidence.ledger);
  const explicit = new Map();
  const detail = new Map();

  explicit.set("doctor", outerStageStatus(job, "doctor"));
  explicit.set("receipt", outerStageStatus(job, "audit"));
  explicit.set("canvas-projection", outerStageStatus(job, "canvas-projection"));

  const cast = Array.isArray(evidence.cast) ? evidence.cast : [];
  if (cast.length > 0) {
    const waiting = cast.filter((entry) => !["existing", "ready"].includes(entry.status));
    detail.set("characters", waiting.length ? `承認待ち ${waiting.length} 人` : `${cast.length} 人`);
    if (waiting.length === 0) explicit.set("characters", "pass");
    else if (waiting.some((entry) => entry.status === "failed")) explicit.set("characters", "fail");
    else if (running && waiting.some((entry) => entry.status === "generating-candidates")) explicit.set("characters", "running");
    else explicit.set("characters", "awaiting-human-review");
  } else if (imagesStarted) {
    explicit.set("characters", "pass");
  }

  if (!codes.includes("awaiting-wardrobe-readiness")) {
    if (evidence.wardrobe?.pass === true || imagesStarted) explicit.set("wardrobe", "pass");
  }
  if (!codes.includes("awaiting-voice-selection")) {
    if (evidence.speechReport || imagesStarted) explicit.set("voice-selection", "pass");
  }

  const ledgerStatus = nonEmpty(evidence.ledger?.status);
  const summary = evidence.ledger?.summary;
  if (plainObject(summary) && Number(summary.total) > 0) detail.set("images", `${Number(summary.complete) || 0} / ${Number(summary.total)} 枚`);
  if (ledgerStatus === "complete") explicit.set("images", "pass");
  else if (ledgerStatus === "failed") explicit.set("images", "fail");
  else if (ledgerStatus === "waiting" || ledgerStatus === "awaiting-human-review") explicit.set("images", "awaiting-human-review");
  else if (ledgerStatus === "running") {
    if (running) explicit.set("images", "running");
    else if (phase === "failed") explicit.set("images", "fail");
  }

  if (!codes.includes("awaiting-source-face-review") && evidence.manifest && evidence.speechReport) {
    explicit.set("layout", "pass");
  }

  const speechStatus = nonEmpty(evidence.speechReport?.status);
  if (evidence.speechCounts) detail.set("speech", `${evidence.speechCounts.done} / ${evidence.speechCounts.total} カット`);
  if (speechStatus === "complete") explicit.set("speech", "pass");
  else if (speechStatus === "failed") explicit.set("speech", "fail");
  else if (speechStatus === "waiting-usage-limit") explicit.set("speech", "awaiting-human-review");
  else if (speechStatus && speechStatus !== "planned") {
    explicit.set("speech", running ? "running" : phase === "failed" ? "fail" : "awaiting-human-review");
  }

  if (["audit-incomplete", "final-koya-audited"].includes(resultStatus) || stateStatus === "rendered-awaiting-audit") {
    explicit.set("render", "pass");
  }
  if (resultStatus === "final-koya-audited") {
    explicit.set("final-audit", "pass");
    explicit.set("signoff", "pass");
  } else if (resultStatus === "audit-incomplete") {
    if (failedAuditIds.length) detail.set("final-audit", otherAuditFailed ? `不合格 ${failedAuditIds.filter((id) => !SIGNOFF_AUDIT.test(id)).length} 件` : "機械の監査は合格");
    explicit.set("final-audit", otherAuditFailed || failedAuditIds.length === 0 ? "fail" : "pass");
    if (signoffAuditFailed) explicit.set("signoff", "awaiting-human-review");
  }
  if (phase === "completed") {
    for (const id of KOYA_PROGRESS_ORDER) {
      if (!["receipt", "canvas-projection"].includes(id)) explicit.set(id, "pass");
    }
  }

  // いま止まっている（進んでいる）工程。子の終了時の status を先に見る（Job が待っているのはそれ）。
  let current = nodeFrom(STATUS_TO_NODE, resultStatus)
    || nodeFrom(STATUS_TO_NODE, stateStatus)
    || nodeFrom(CURRENT_STAGE_TO_NODE, evidence.state?.currentStage);
  if (!current && explicit.get("doctor") === "pass" && phase !== "completed") {
    current = KOYA_PROGRESS_ORDER.find((id) => id !== "doctor" && !["pass"].includes(explicit.get(id))) || "";
  }
  const currentIndex = current ? KOYA_PROGRESS_ORDER.indexOf(current) : -1;
  const atCurrent = { running: "running", paused: "awaiting-human-review", failed: "fail", completed: "pass", cancelled: "pending", planned: "pending" }[phase];

  const nodes = KOYA_PROGRESS_DAG.map((node) => {
    let status = explicit.get(node.id);
    if (!status) {
      const index = KOYA_PROGRESS_ORDER.indexOf(node.id);
      if (currentIndex < 0) status = "pending";
      else if (index < currentIndex) status = "pass";
      else if (index === currentIndex) status = atCurrent;
      else status = "pending";
    } else if (node.id === current && status !== "pass") {
      // 記録は前の回のまま残ることがある（再開して走っている間の「利用上限で待機」など）。
      // いま止まっている工程は、記録より Job の状態を優先する。落ちた記録は、走っている間だけ上書きする。
      if (phase === "running") status = "running";
      else if (phase === "paused" && ["running", "pending"].includes(status)) status = "awaiting-human-review";
      else if (phase === "failed" && ["running", "pending"].includes(status)) status = "fail";
    }
    return { id: node.id, title: node.title, needs: [...node.needs], status, detail: detail.get(node.id) || "" };
  });
  return { nodes, current };
}

function qualityLabel(record, { subjectMatched = false } = {}) {
  if (!record) return subjectMatched ? "別の版を採点済み" : "未開始";
  const labels = {
    passed: "合格",
    "awaiting-human-verification": "人の確認待ち",
    "human-rejected": "人の確認で否",
    active: "採点中",
    "not-started": "未開始",
  };
  return labels[record.status] || `止まった（${record.status}）`;
}

function qualityVerdict(record) {
  if (!record) return "none";
  if (record.status === "passed") return "pass";
  if (record.status === "awaiting-human-verification" || record.status === "active") return "waiting";
  return "fail";
}

async function readAssetQualityIndex(workspace, notes) {
  const index = { bySha: new Map(), bySubject: new Map() };
  if (!workspace) return index;
  // ゲート（lib/koyaAssetQualityGate.mjs）と同じ置き場を読む。作業場の直下を読むと、ゲートが見る記録は出ず、
  // ゲートが見ない記録が出る。
  const workDir = koyaAssetQualityWorkDir({ projectDir: workspace });
  let listed;
  try {
    listed = await listAssetQualityStatus({ workDir });
  } catch {
    notes.push("品質ループの記録（読めない）");
    return index;
  }
  for (const entry of listed.entries) {
    let status;
    try {
      status = await assetQualityStatus({ workDir, stage: entry.stage, subjectId: entry.subjectId });
    } catch {
      notes.push("品質ループの記録（読めない）");
      continue;
    }
    for (const entry of listed.entries) {
      let status;
      try {
        status = await assetQualityStatus({ workDir, stage: entry.stage, subjectId: entry.subjectId });
      } catch {
        continue;
      }
      const record = { stage: entry.stage, subjectId: entry.subjectId, status: status.check?.status || entry.status, pass: status.pass === true };
      const digest = nonEmpty(status.check?.assetSha256).toLowerCase();
      if (SHA256.test(digest) && !index.bySha.has(`${entry.stage}:${digest}`)) index.bySha.set(`${entry.stage}:${digest}`, record);
      if (!index.bySubject.has(`${entry.stage}:${entry.subjectId}`)) index.bySubject.set(`${entry.stage}:${entry.subjectId}`, record);
    }
  }
  return index;
}

/**
 * 成果物の品質ループの記録。まず今のファイルの SHA で探し、無ければ対象 id にループがあるか（＝別の版を
 * 採点済み）を見る。対象 id はゲート（lib/koyaAssetQualityGate.mjs）が記録・照合するものと同じにする。
 */
function qualityFor(index, stage, media, subjectIds = []) {
  const bySha = media?.sha256 ? index.bySha.get(`${stage}:${media.sha256}`) : null;
  if (bySha) return { record: bySha, subjectMatched: true };
  const subjectMatched = subjectIds.some((id) => index.bySubject.has(`${stage}:${id}`));
  return { record: null, subjectMatched };
}

const QUALITY_VERDICT_RANK = Object.freeze({ fail: 0, waiting: 1, none: 2, pass: 3 });

/**
 * 本編の画の行の品質ループ。ゲート（createKoyaSceneImageAssetQualityGate）と同じく、1枚の画はその行を、
 * 分割ページは合成の行ではなく各コマの行（対象 id もファイルもコマのもの）を見る。合成の画の SHA は
 * どのコマのループとも一致しないので、合成で探すとコマが今の版で合格していても「別の版」になる。
 * 分割ページはコマのうちいちばん悪いもの（不合格 > 人待ち > 今の版のループが無い > 合格）を出す。
 */
async function sceneImageQuality({ workspace, reader, quality, episodeId, assetJobId, panelJobIds, media, ledger, planJobs }) {
  if (panelJobIds.length === 0) {
    return qualityFor(quality, "scene-image", media, [koyaSceneImageAssetQualitySubjectId(episodeId, assetJobId)]);
  }
  const panels = [];
  for (const panelJobId of panelJobIds) {
    const ledgerJob = plainObject(ledger?.jobs) ? ledger.jobs[panelJobId] : null;
    const output = resolveKoyaWorkspacePath(workspace, ledgerJob?.outputPath || planJobs.get(panelJobId)?.outputPath);
    const panelMedia = output && nonEmpty(ledgerJob?.status) ? mediaOrNull(await reader.media(output, "image")) : null;
    panels.push(qualityFor(quality, "scene-image", panelMedia, [koyaSceneImageAssetQualitySubjectId(episodeId, panelJobId)]));
  }
  const rank = ({ record }) => QUALITY_VERDICT_RANK[qualityVerdict(record)];
  return panels.reduce((worst, panel) => (rank(panel) < rank(worst) ? panel : worst));
}

function mediaOrNull(result) {
  return result && !result.error ? result : null;
}

function firstIssue(qa) {
  const issues = Array.isArray(qa?.issues) ? qa.issues : [];
  const first = issues.find((issue) => nonEmpty(typeof issue === "string" ? issue : issue?.detail || issue?.message));
  if (!first) return "";
  return typeof first === "string" ? first : nonEmpty(first.detail || first.message);
}

async function sceneImageItems({ workspace, reader, plan, ledger, quality, running, episodeId }) {
  const pages = Array.isArray(plan?.pages) ? plan.pages : [];
  const planJobs = new Map((Array.isArray(plan?.jobs) ? plan.jobs : []).map((job) => [String(job?.id || ""), job]));
  const grouped = new Map();
  for (const page of pages) {
    const assetJobId = nonEmpty(page?.assetJobId);
    if (!assetJobId) continue;
    const entry = grouped.get(assetJobId) || { cutIds: [], utteranceIds: [], outputPath: "", panelJobIds: [] };
    const cutId = nonEmpty(page?.cutId);
    const utteranceId = nonEmpty(page?.utteranceId);
    if (cutId && !entry.cutIds.includes(cutId)) entry.cutIds.push(cutId);
    if (utteranceId && !entry.utteranceIds.includes(utteranceId)) entry.utteranceIds.push(utteranceId);
    for (const panelJobId of Array.isArray(page?.panelJobIds) ? page.panelJobIds : []) {
      if (nonEmpty(panelJobId) && !entry.panelJobIds.includes(nonEmpty(panelJobId))) entry.panelJobIds.push(nonEmpty(panelJobId));
    }
    entry.outputPath ||= nonEmpty(page?.outputPath);
    grouped.set(assetJobId, entry);
  }
  const items = [];
  const counts = { total: grouped.size, pass: 0, failed: 0 };
  let order = 0;
  for (const [assetJobId, entry] of grouped) {
    order += 1;
    const ledgerJob = plainObject(ledger?.jobs) ? ledger.jobs[assetJobId] : null;
    const ledgerStatus = nonEmpty(ledgerJob?.status);
    const output = resolveKoyaWorkspacePath(workspace, ledgerJob?.outputPath || entry.outputPath || planJobs.get(assetJobId)?.outputPath);
    const media = output && ledgerStatus ? mediaOrNull(await reader.media(output, "image")) : null;
    const qa = ledgerJob?.qa;
    let qaText;
    if (qa?.pass === true) qaText = qa?.semantic?.pass === null ? "合格（機械検査のみ）" : "合格";
    else if (qa?.pass === false) qaText = `不合格（指摘 ${Array.isArray(qa.issues) ? qa.issues.length : 0} 件）`;
    else if (ledgerStatus === "running") qaText = running ? "生成中" : "中断";
    else if (ledgerStatus === "waiting") qaText = "待機中（利用上限）";
    else if (ledgerStatus === "failed") qaText = "失敗";
    else if (ledgerStatus === "complete") qaText = "合格";
    else qaText = "未生成";
    const { record, subjectMatched } = await sceneImageQuality({
      workspace, reader, quality, episodeId, assetJobId, panelJobIds: entry.panelJobIds, media, ledger, planJobs,
    });
    const verdict = qualityVerdict(record);
    // 機械の QA は通ったが、本編の画の品質ループ（人の確認を含む）の合格まで台帳が止めた行。分割ページは
    // 合成の行ではなくコマの行が止まるので、コマも見る。
    const awaitingReview = [assetJobId, ...entry.panelJobIds]
      .some((id) => plainObject(ledger?.jobs) && nonEmpty(ledger.jobs[id]?.status) === "awaiting-human-review");
    let status;
    if (ledgerStatus === "failed" || qa?.pass === false) status = "failed";
    else if (awaitingReview) status = "awaiting-approval";
    else if (ledgerStatus === "running") status = running ? "running" : "pending";
    else if (ledgerStatus === "waiting") status = "awaiting-approval";
    else if (ledgerStatus === "complete") status = verdict === "fail" ? "failed" : verdict === "waiting" ? "awaiting-approval" : "complete";
    else status = "pending";
    if (status === "complete") counts.pass += 1;
    if (status === "failed") counts.failed += 1;
    // 指摘の全文は台帳にある。カードには幅に収まる頭だけを出す。
    const fullIssue = qa?.pass === false ? firstIssue(qa) : "";
    const issue = fullIssue.length > 14 ? `${fullIssue.slice(0, 13)}…` : fullIssue;
    items.push({
      key: assetJobId,
      title: `#${order} ${entry.cutIds[0] || "カット未定"}`,
      lines: [
        `発話 ${entry.utteranceIds[0] || "—"}${entry.utteranceIds.length > 1 ? ` ほか ${entry.utteranceIds.length - 1}` : ""}`,
        `QA: ${qaText}`,
        `品質ループ: ${qualityLabel(record, { subjectMatched })}`,
        ...(awaitingReview ? ["台帳: 人の確認待ち"] : []),
        ...(issue ? [`指摘: ${issue}`] : []),
      ],
      status,
      media,
    });
  }
  return { items, counts };
}

const SHEET_ROLES = Object.freeze(["identity-face", "turnaround", "expression", "outfit", "eye-open"]);
const SHEET_LABELS = Object.freeze({
  "identity-face": "顔の設定画",
  turnaround: "三面図",
  expression: "表情",
  outfit: "衣装",
  "eye-open": "開眼",
});

async function sheetItem({ workspace, canvasDir, reader, quality, rowKey, role, asset }) {
  const sheetPath = resolveKoyaWorkspacePath(workspace, asset.path || asset.assetFile, { base: canvasDir });
  const declared = nonEmpty(asset.sha256).replace(/^sha256:/iu, "").toLowerCase();
  let media = sheetPath ? mediaOrNull(await reader.media(sheetPath, "image")) : null;
  const lines = [];
  let status = "complete";
  if (media && SHA256.test(declared) && media.sha256 !== declared) {
    media = null;
    lines.push("承認時と SHA が違う");
    status = "failed";
  } else if (!media) {
    lines.push("ファイルを読めない");
    status = "failed";
  }
  const { record } = qualityFor(quality, "character", media);
  lines.push(`品質ループ: ${qualityLabel(record)}`);
  if (status === "complete" && qualityVerdict(record) === "fail") status = "failed";
  return {
    key: `${rowKey}:${role}:${nonEmpty(asset.id) || nonEmpty(asset.storyStage) || declared.slice(0, 12) || "sheet"}`,
    title: `${SHEET_LABELS[role] || role}${nonEmpty(asset.storyStage) ? `（${nonEmpty(asset.storyStage)}）` : ""}`,
    lines,
    status,
    media,
  };
}

function registrySheets(character) {
  const assets = Array.isArray(character?.referenceAssets) ? character.referenceAssets : [];
  return assets
    .filter((asset) => SHEET_ROLES.includes(asset.role))
    .sort((left, right) => SHEET_ROLES.indexOf(left.role) - SHEET_ROLES.indexOf(right.role)
      || String(left.storyStage || "").localeCompare(String(right.storyStage || ""))
      || String(left.id || "").localeCompare(String(right.id || "")))
    .slice(0, MAX_SHEETS_PER_CHARACTER)
    .map((asset) => ({ role: asset.role, asset }));
}

function identityPackSheets(pack) {
  if (!pack) return [];
  const rows = [
    ["identity-face", pack.selectedFace],
    ["turnaround", pack.turnaround],
    ["expression", pack.expression],
    ...(pack.eyeOpenSheets || []).map((sheet) => ["eye-open", sheet]),
    ...(pack.outfitSheets || []).map((sheet) => ["outfit", sheet]),
  ];
  return rows
    .filter(([, asset]) => nonEmpty(asset?.assetFile))
    .slice(0, MAX_SHEETS_PER_CHARACTER)
    .map(([role, asset]) => ({ role, asset }));
}

const CAST_STATUS_LABELS = Object.freeze({
  "needs-candidates": "候補を作る前",
  "generating-candidates": "候補を作成中",
  "awaiting-approval": "候補の選択待ち",
  failed: "候補の作成に失敗",
});

/** その話の人物（同じ人物 id が複数の workflow にあれば、後に作られた workflow の記録を使う）。 */
function episodeCast(workflows, episodeId) {
  const episodeWorkflows = workflows
    .filter((workflow) => workflow.episodeId === episodeId)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)) || left.id.localeCompare(right.id));
  const latestByCast = new Map();
  for (const workflow of episodeWorkflows) {
    for (const cast of workflow.cast) latestByCast.set(cast.id, { workflow, cast });
  }
  return [...latestByCast.values()];
}

async function characterItems({ workspace, reader, workflows, registry, episodeId, quality, running }) {
  const canvasDir = path.join(workspace, "canvas");
  const registryById = new Map((registry?.characters || []).map((character) => [character.id, character]));
  const collected = [];
  // 格子の item key は重複できない（同じ役割の設定画が2枚ある・同じ登録に2人が結び付く記録でも止めない）。
  const usedKeys = new Map();
  const items = {
    push(...entries) {
      for (const entry of entries) {
        const seen = usedKeys.get(entry.key) || 0;
        usedKeys.set(entry.key, seen + 1);
        collected.push(seen === 0 ? entry : { ...entry, key: `${entry.key}#${seen + 1}` });
      }
    },
  };
  const counts = { approved: 0, waiting: 0 };
  let anonymousOrder = 0;
  for (const { workflow, cast } of episodeCast(workflows, episodeId)) {
    const registered = registryById.get(cast.characterId || cast.matchedCharacterId);
    const approvedInRegistry = registered && registered.status === "approved";
    if (["existing", "ready"].includes(cast.status) && approvedInRegistry) {
      counts.approved += 1;
      const rowKey = `character:${registered.id}`;
      const sheets = registrySheets(registered);
      items.push({
        key: rowKey,
        title: registered.name,
        lines: ["承認済み", `設定画 ${sheets.length} 枚`],
        status: "complete",
        rowBreak: true,
      });
      for (const sheet of sheets) items.push(await sheetItem({ workspace, canvasDir, reader, quality, rowKey, ...sheet }));
      continue;
    }
    if (cast.approval && !["existing", "ready"].includes(cast.status)) {
      // 候補の採用が記録された人物。名前は出してよいが、設定画はまだ確認待ち。
      counts.waiting += 1;
      const rowKey = `approved-cast:${sha256(`${workflow.id}\u0000${cast.id}`).slice(0, 24)}`;
      let sheets = identityPackSheets(cast.identityPack);
      if (sheets.length === 0) {
        const selected = cast.candidates.find((candidate) => candidate.id === cast.approval.selectedCandidateId);
        if (selected) {
          sheets = [{
            role: "identity-face",
            asset: { assetFile: selected.blindArtifactFile || selected.assetFile, sha256: selected.blindArtifactFile ? selected.blindArtifactSha256 : "" },
          }];
        }
      }
      items.push({
        key: rowKey,
        title: cast.name,
        lines: [`候補 ${cast.approval.selectedCandidateLabel || "—"} を採用`, "設定画の確認待ち"],
        status: "awaiting-approval",
        rowBreak: true,
      });
      for (const sheet of sheets) {
        const item = await sheetItem({ workspace, canvasDir, reader, quality, rowKey, ...sheet });
        items.push({ ...item, status: item.status === "complete" ? "awaiting-approval" : item.status });
      }
      continue;
    }
    // 承認前（または登録簿に見つからない）人物は匿名のまま。人物 id・名前・説明・作り分けの軸は出さない。
    anonymousOrder += 1;
    counts.waiting += 1;
    const rowKey = `person:${sha256(`${workflow.id}\u0000${cast.id}`).slice(0, 24)}`;
    const labeled = cast.candidates
      .filter((candidate) => /^[A-E]$/u.test(candidate.blindLabel))
      .sort((left, right) => left.blindLabel.localeCompare(right.blindLabel));
    const unlabeled = cast.candidates.length - labeled.length;
    const missingRegistry = ["existing", "ready"].includes(cast.status);
    let rowStatus = "awaiting-approval";
    if (missingRegistry || cast.status === "failed") rowStatus = "failed";
    else if (cast.status === "generating-candidates") rowStatus = running ? "running" : "pending";
    items.push({
      key: rowKey,
      title: `人物 ${anonymousOrder}（${missingRegistry ? "登録簿に無い" : "承認前"}）`,
      lines: [
        missingRegistry ? "承認済みの登録が見つからない" : CAST_STATUS_LABELS[cast.status] || "承認待ち",
        labeled.length ? `候補 ${labeled.map((candidate) => candidate.blindLabel).join("・")}` : "匿名ラベルの候補は無い",
        ...(unlabeled > 0 ? [`ラベル未付与 ${unlabeled} 件`] : []),
      ],
      status: rowStatus,
      rowBreak: true,
    });
    for (const candidate of labeled) {
      const file = resolveKoyaWorkspacePath(workspace, candidate.blindArtifactFile, { base: canvasDir });
      const declared = nonEmpty(candidate.blindArtifactSha256).toLowerCase();
      let media = file ? mediaOrNull(await reader.media(file, "image")) : null;
      const lines = [];
      let status = candidate.status === "failed" ? "failed" : "awaiting-approval";
      if (media && SHA256.test(declared) && media.sha256 !== declared) {
        media = null;
        lines.push("匿名パケットと SHA が違う");
        status = "failed";
      } else if (!media) {
        lines.push("ファイルを読めない");
      }
      const { record } = qualityFor(quality, "character", media);
      lines.push(`品質ループ: ${qualityLabel(record)}`);
      items.push({ key: `${rowKey}:${candidate.blindLabel}`, title: `候補 ${candidate.blindLabel}`, lines, status, media });
    }
  }
  return { items: collected, counts };
}

function naturalCompare(left, right) {
  return String(left).localeCompare(String(right), "en", { numeric: true });
}

async function voiceTakeItems({ workspace, reader, episodeDir, episodeId, manifest, speechReport, quality, running, speechCurrent }) {
  const rows = new Map();
  for (const row of Array.isArray(speechReport?.cuts) ? speechReport.cuts : []) {
    const cutId = nonEmpty(row?.cutId);
    if (cutId) rows.set(cutId, row);
  }
  const manifestCuts = (Array.isArray(manifest?.cuts) ? manifest.cuts : []).map((cut) => nonEmpty(cut?.id)).filter(Boolean);
  const cutIds = manifestCuts.length ? [...new Set(manifestCuts)] : [...rows.keys()].sort(naturalCompare);
  const items = [];
  let done = 0;
  let order = 0;
  for (const cutId of cutIds) {
    order += 1;
    const row = rows.get(cutId);
    if (!row || nonEmpty(row.status) !== "complete") {
      items.push({
        key: cutId,
        title: `#${order} ${cutId}`,
        lines: [row ? `状態: ${nonEmpty(row.status) || "不明"}` : "採用テイクはまだ無い"],
        status: running && speechCurrent ? "running" : "pending",
      });
      continue;
    }
    done += 1;
    const takePath = resolveKoyaWorkspacePath(workspace, row.sourcePath);
    const media = takePath ? mediaOrNull(await reader.media(takePath, "audio")) : null;
    const takeIndex = Number.isInteger(Number(row.selectedTakeIndex)) ? Number(row.selectedTakeIndex) : null;
    const gateFile = resolveKoyaWorkspacePath(workspace, path.join(episodeDir, ".koya-dialogue-source", `${cutId}-voice-quality.json`));
    const gateReport = gateFile ? await reader.json(gateFile, `${cutId} の声の検査`) : null;
    const gate = takeIndex !== null && plainObject(gateReport?.byTake) ? gateReport.byTake[String(takeIndex)] : null;
    let gateText = "未実施";
    if (gate) gateText = gate.hardFail ? "不合格" : Array.isArray(gate.unavailable) && gate.unavailable.length ? "合格（一部測れず）" : "合格";
    else if (nonEmpty(row.voiceQualityGate) === "reused-approved-checkpoint") gateText = "承認済みを再利用";
    const { record, subjectMatched } = qualityFor(quality, "voice-take", media, [koyaVoiceTakeAssetQualitySubjectId(episodeId, cutId)]);
    const verdict = qualityVerdict(record);
    let status = "complete";
    if (!media || gate?.hardFail || verdict === "fail") status = "failed";
    else if (verdict === "waiting") status = "awaiting-approval";
    items.push({
      key: cutId,
      title: `#${order} ${cutId}`,
      lines: [
        `採用テイク ${takeIndex === null ? "—" : takeIndex + 1}`,
        `声の検査: ${gateText}`,
        `品質ループ: ${qualityLabel(record, { subjectMatched })}`,
        ...(media ? [] : ["ファイルを読めない"]),
      ],
      status,
      media,
    });
  }
  return { items, counts: { done, total: cutIds.length } };
}

/**
 * カットを動画に差し替えた回の、差し替えのクリップ（manifest の cuts[].videoSubstitution）。タイルには開始
 * フレーム（画）を出し、ラベルに工程 video-clip の品質ループの合否を出す（Canvas の途中の投影は画と音声だけを描く）。
 * 差し替えの無い回は section ごと出さない。
 */
async function videoClipItems({ workspace, reader, manifest, episodeId, quality }) {
  const items = [];
  const counts = { total: 0, pass: 0 };
  let order = 0;
  for (const cut of Array.isArray(manifest?.cuts) ? manifest.cuts : []) {
    const binding = plainObject(cut?.videoSubstitution) ? cut.videoSubstitution : null;
    const cutId = nonEmpty(cut?.id);
    if (!binding || !cutId) continue;
    order += 1;
    counts.total += 1;
    if (binding.status === "still-fallback") {
      items.push({ key: cutId, title: `#${order} ${cutId}`, lines: ["静止画に戻した（運営者の判断）"], status: "complete" });
      counts.pass += 1;
      continue;
    }
    const clipPath = resolveKoyaWorkspacePath(workspace, binding.clipPath);
    const clip = clipPath ? mediaOrNull(await reader.media(clipPath, "video")) : null;
    const startFrame = resolveKoyaWorkspacePath(workspace, binding.startFramePath);
    const media = startFrame ? mediaOrNull(await reader.media(startFrame, "image")) : null;
    const subjectId = koyaVideoClipAssetQualitySubjectId(episodeId, cutId);
    const record = (clip?.sha256 ? quality.bySha.get(`video-clip:${clip.sha256}`) : null) || null;
    const subjectMatched = quality.bySubject.has(`video-clip:${subjectId}`);
    // 合格（使ってよい）は品質ループの pass だけ。まだ採点していない・人の確認待ちはレンダーの前で止まるので人待ち。
    let status;
    if (!clip) status = "failed";
    else if (record?.pass === true) status = "complete";
    else if (qualityVerdict(record) === "fail") status = "failed";
    else status = "awaiting-approval";
    if (status === "complete") counts.pass += 1;
    items.push({
      key: cutId,
      title: `#${order} ${cutId}`,
      lines: [
        `クリップ: ${nonEmpty(binding.model) || "—"}`,
        `品質ループ: ${qualityLabel(record, { subjectMatched })}`,
        ...(clip ? [] : ["クリップを読めない"]),
      ],
      status,
      ...(media ? { media } : {}),
    });
  }
  return { items, counts };
}

function headerStatus(job) {
  const status = nonEmpty(job?.status);
  if (["planned", "queued"].includes(status)) return "queued";
  if (["running", "preflight-running"].includes(status)) return "running";
  if (status === "awaiting-human-review") return "awaiting-approval";
  if (status === "completed") return "complete";
  if (["cancelled", "cancel-requested"].includes(status)) return "cancelled";
  if (status === "failed") return "failed";
  return "pending";
}

function placeholder(key, title, line) {
  return [{ key, title, lines: [line], status: "pending" }];
}

/**
 * 漫画の Job から、途中の成果物の snapshot を作る。Job が workspace を持つ前（prepare 前）や
 * 話数が無いときは、工程の DAG だけの snapshot になる。
 */
export async function readKoyaMangaProgressSnapshot(job) {
  if (!job?.id) throw new Error("途中の成果物を読む Job が無い。");
  const workspace = nonEmpty(job.executionProjectDir) ? path.resolve(job.executionProjectDir) : "";
  const rawEpisodeId = nonEmpty(job.options?.episodeId);
  const episodeId = SAFE_EPISODE_ID.test(rawEpisodeId) ? rawEpisodeId : "";
  const reader = createWorkspaceReader(workspace);
  const running = jobPhase(job) === "running";
  const evidence = {};
  let quality = { bySha: new Map(), bySubject: new Map() };
  let workflows = [];
  let registry = null;
  let episodeDir = "";
  if (workspace && episodeId) {
    const canvasDir = path.join(workspace, "canvas");
    episodeDir = path.join(canvasDir, "manga-videos", episodeId);
    const assetDir = path.join(canvasDir, "assets", episodeId);
    evidence.state = await reader.json(path.join(episodeDir, "koya-production-state.json"), "koya-production-state.json");
    const planPath = resolveKoyaWorkspacePath(workspace, evidence.state?.imagePlanPath) || path.join(assetDir, "script-image-plan.json");
    evidence.plan = await reader.json(planPath, "script-image-plan.json");
    const ledgerCandidates = [
      resolveKoyaWorkspacePath(workspace, evidence.state?.imageLedgerPath),
      path.join(assetDir, "image-generation-ledger.json"),
      path.join(assetDir, "script-image-ledger.json"),
    ].filter(Boolean);
    for (const candidate of ledgerCandidates) {
      evidence.ledger = await reader.json(candidate, path.basename(candidate));
      if (evidence.ledger) break;
    }
    const workflowStore = await reader.json(path.join(canvasDir, "character-workflows.json"), "character-workflows.json");
    if (workflowStore) {
      try {
        workflows = normalizeCharacterWorkflowStore(workflowStore).workflows;
      } catch {
        reader.notes.push("character-workflows.json（形が読めない）");
      }
    }
    const registryFile = await reader.json(path.join(canvasDir, "characters.json"), "characters.json");
    if (registryFile) {
      try {
        registry = normalizeCharacterRegistry(registryFile);
      } catch {
        reader.notes.push("characters.json（形が読めない）");
      }
    }
    evidence.wardrobe = await reader.json(path.join(assetDir, "wardrobe-readiness.json"), "wardrobe-readiness.json");
    evidence.manifest = await reader.json(path.join(episodeDir, "episode-manifest.json"), "episode-manifest.json");
    evidence.speechReport = await reader.json(path.join(episodeDir, "koya-dialogue-generation.json"), "koya-dialogue-generation.json");
    quality = await readAssetQualityIndex(workspace, reader.notes);
    evidence.cast = episodeCast(workflows, episodeId).map((entry) => entry.cast);
  }

  const images = workspace && episodeId
    ? await sceneImageItems({ workspace, reader, plan: evidence.plan, ledger: evidence.ledger, quality, running, episodeId })
    : { items: [], counts: { total: 0, pass: 0, failed: 0 } };
  const characters = workspace && episodeId
    ? await characterItems({ workspace, reader, workflows, registry, episodeId, quality, running })
    : { items: [], counts: { approved: 0, waiting: 0 } };
  // 音声の工程にいるか（DAG の判定に使う前に、採用テイクの数だけ先に数える）。
  const speechRows = Array.isArray(evidence.speechReport?.cuts) ? evidence.speechReport.cuts : [];
  const manifestCutCount = Array.isArray(evidence.manifest?.cuts) ? evidence.manifest.cuts.length : 0;
  evidence.speechCounts = evidence.speechReport || manifestCutCount
    ? { done: speechRows.filter((row) => nonEmpty(row?.status) === "complete").length, total: manifestCutCount || speechRows.length }
    : null;
  const dag = deriveKoyaProgressDag(job, evidence);
  const voices = workspace && episodeId
    ? await voiceTakeItems({
        workspace,
        reader,
        episodeDir,
        episodeId,
        manifest: evidence.manifest,
        speechReport: evidence.speechReport,
        quality,
        running,
        speechCurrent: dag.current === "speech",
      })
    : { items: [], counts: { done: 0, total: 0 } };
  const clips = workspace && episodeId
    ? await videoClipItems({ workspace, reader, manifest: evidence.manifest, episodeId, quality })
    : { items: [], counts: { total: 0, pass: 0 } };

  const noWorkspaceLine = !workspace ? "Job の作業場ができると表示する" : "話数（episodeId）が無い";
  const ready = Boolean(workspace && episodeId);
  const summaryLines = [
    `Job ${job.id} · rev ${Number.isSafeInteger(job.revision) ? job.revision : 0} · ${nonEmpty(job.status) || "planned"}${episodeId ? ` · 話数 ${episodeId}` : ""}`,
    `本編の画: 合格 ${images.counts.pass} / ${images.counts.total}${images.counts.failed ? `（不合格 ${images.counts.failed}）` : ""}`,
    `人物: 承認済み ${characters.counts.approved} · 承認待ち ${characters.counts.waiting} ／ 採用テイク: ${voices.counts.done} / ${voices.counts.total} カット`,
    ...(clips.counts.total > 0 ? [`動画クリップ: 合格 ${clips.counts.pass} / ${clips.counts.total}`] : []),
    ...(reader.notes.length ? [`読めなかった記録: ${reader.notes.slice(0, 3).join("、")}${reader.notes.length > 3 ? ` ほか ${reader.notes.length - 3}` : ""}`] : []),
  ];
  return {
    version: CANVAS_RUN_PROGRESS_SNAPSHOT_VERSION,
    runId: job.id,
    jobRevision: Number.isSafeInteger(job.revision) && job.revision >= 0 ? job.revision : 0,
    updatedAt: nonEmpty(job.updatedAt) || nonEmpty(job.createdAt) || null,
    harnessId: nonEmpty(job.harness?.id),
    title: `制作の途中（漫画）${episodeId ? `: ${episodeId}` : ""}`,
    status: headerStatus(job),
    summaryLines,
    dag: { nodes: dag.nodes },
    sections: [
      {
        id: "scene-image",
        title: "本編の画（カット順）",
        lines: ["ラベル: 生成と QA の台帳 ／ 途中の成果物の品質ループ（scene-image）"],
        tileMedia: "image",
        items: images.items.length ? images.items : placeholder("empty", "まだ無い", ready ? "画の計画ができると表示する" : noWorkspaceLine),
      },
      {
        id: "character",
        title: "人物の候補と承認済みの設定画",
        lines: ["承認前の人物は匿名（人物 N・候補 A〜E）。採用が記録されてから名前を出す"],
        tileMedia: "image",
        items: characters.items.length ? characters.items : placeholder("empty", "まだ無い", ready ? "画の工程で登場人物を確定すると表示する" : noWorkspaceLine),
      },
      {
        id: "voice-take",
        title: "台詞の採用テイク（カットごと）",
        lines: ["▶ で再生。ラベル: 声の検査 ／ 途中の成果物の品質ループ（voice-take）"],
        tileMedia: "audio",
        items: voices.items.length ? voices.items : placeholder("empty", "まだ無い", ready ? "音声の工程で採用テイクが決まると表示する" : noWorkspaceLine),
      },
      // カットを動画に差し替えた回だけ（タイルは開始フレーム、ラベルは工程 video-clip の品質ループ）。
      ...(clips.items.length ? [{
        id: "video-clip",
        title: "差し替えの動画クリップ（カットごと）",
        lines: ["タイルは開始フレーム。ラベル: 途中の成果物の品質ループ（video-clip）"],
        tileMedia: "image",
        items: clips.items,
      }] : []),
    ],
  };
}

export const _testing = Object.freeze({ createWorkspaceReader, jobPhase, outerStageStatus });
