// Harness Run の「途中の成果物」を Canvas へ出す投影（ジャンル共通）。
//
// Run の投影（lib/canvasRunProjection.mjs）と media の投影（lib/canvasRunMediaProjection.mjs）は、
// Job が決着した成果物（最終 MP4・監査・contact sheet・signoff・Receipt）だけを出す。
// ここは、制作の途中——本編の画・人物の候補と設定画・台詞の採用テイク・工程の DAG——を、
// ジャンルの読み取り側（漫画は lib/koyaMangaProgressSnapshot.mjs）が作った snapshot から描く。
//
// 守ること:
//   - 要素 ID は runId（= Job ID）・工程・成果物のキー・成果物の SHA-256 だけから決まる。
//     どのホスト（Claude Code / Codex）から、どの端末の作業場から投影しても同じ ID・同じ配置になる。
//     原本のパスは ID にも customData にも入れない（Canvas に出るのは content-addressed の URL だけ）
//   - 配置は snapshot だけで決まる。Run の投影（x=40 から右・下へ伸びる）とは重ならないよう、
//     幅が固定のパネルを左側（x < 0）に置く。Run 側の成果物の数でこちらの配置が動かない
//   - 再投影では要素を増やさない。投影 hash が同じ要素は触らず、変わった要素だけ version を上げ、
//     消えた要素は isDeleted（墓標）にする。新しい要素の index は scene の最大 index の後ろに付ける
//   - 画像は原本を content-addressed に複製したうえで、表示には ?w= のプレビュー（Canvas サーバーが
//     ffmpeg で WebP に縮めて返す。小さいファイルは原本のまま）を使う。原寸は要素の link から開ける
//   - Job の revision が保存済みより古い投影は、書かずに skip する（途中の成果物は作業場から毎回
//     読み直す表示なので、同じ revision で中身が変わるのは正常。Run の投影のような衝突にはしない）

import { generateKeyBetween } from "fractional-indexing";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { withCanvasFileLock } from "./canvasFileLock.mjs";
import {
  canvasRunMediaAssetUrl,
  canvasRunMediaBaseElement,
  canvasRunMediaPreviewDataUrl,
  verifyCanvasRunMediaAsset,
} from "./canvasRunMediaProjection.mjs";
import {
  buildCanvasArrow,
  buildCanvasStatusCard,
  canvasProjectionIndexSequence,
  finalizeCanvasProjectionElement,
  nextCanvasProjectedElement,
  tombstoneCanvasProjectedElement,
} from "./canvasRunProjection.mjs";
import { canonicalJson, CANVAS_JOB_STATUSES, resolveCanvasRunStateFile, sha256Hex } from "./canvasRunState.mjs";
import { normalizeScene, readJsonIfExists, resolveCanvasFile, writeJsonAtomic } from "./canvasScene.mjs";

export const CANVAS_RUN_PROGRESS_SNAPSHOT_VERSION = "buzzassist-canvas-progress-snapshot-v1";
export const CANVAS_RUN_PROGRESS_STATE_VERSION = "buzzassist-canvas-progress-state-v1";
export const CANVAS_RUN_PROGRESS_TAG = "buzzassist.harnessRunProgress.v1";
export const CANVAS_RUN_PROGRESS_PROJECTION_VERSION = 1;
export const CANVAS_RUN_PROGRESS_STATE_FILE_NAME = "canvas-progress.json";
/** 画像の表示に使うプレビューの幅（Canvas サーバーの ?w=。320〜3200 に丸められる）。 */
export const CANVAS_RUN_PROGRESS_PREVIEW_WIDTH = 640;

/** 工程の DAG の状態。表示の色は Canvas の状態へ写す。 */
export const CANVAS_RUN_PROGRESS_DAG_STATUSES = Object.freeze(["pending", "running", "pass", "fail", "awaiting-human-review"]);
const DAG_TO_CANVAS_STATUS = Object.freeze({
  pending: "pending",
  running: "running",
  pass: "complete",
  fail: "failed",
  "awaiting-human-review": "awaiting-approval",
});
const MEDIA_KINDS = new Set(["image", "audio"]);
const SHA256 = /^[a-f0-9]{64}$/u;

// 配置（px）。パネルの幅は固定で、左上の原点も固定。
const PANEL_WIDTH = 2480;
export const CANVAS_RUN_PROGRESS_ORIGIN = Object.freeze({ x: -(PANEL_WIDTH + 120), y: 40 });
const HEADER_HEIGHT = 136;
const DAG_TOP_GAP = 36;
const DAG_NODE_WIDTH = 224;
const DAG_NODE_HEIGHT = 92;
const DAG_COLUMN_STEP = 250;
const DAG_ROW_STEP = 112;
const COLUMNS = 6;
const TILE_WIDTH = 380;
const TILE_GAP = 40;
const IMAGE_BOX_HEIGHT = 214;
const AUDIO_BOX_HEIGHT = 110;
const MEDIA_LABEL_GAP = 8;
const LABEL_HEIGHT = 128;
const ROW_GAP = 36;
const SECTION_HEADER_HEIGHT = 56;
const SECTION_HEADER_GAP = 20;
const SECTION_GAP = 64;

export class CanvasRunProgressError extends Error {
  constructor(message, code = "CANVAS_RUN_PROGRESS_INVALID") {
    super(message);
    this.name = "CanvasRunProgressError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new CanvasRunProgressError(message, code);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value, limit = 200) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function deterministicInteger(seed, offset = 0) {
  return Number.parseInt(sha256Hex(`${seed}:${offset}`).slice(0, 8), 16) & 0x7fffffff;
}

/** 途中の成果物の要素 ID。Job ID・種類・論理キー（と成果物の SHA）だけから決まる。 */
export function stableCanvasProgressId(runId, kind, logicalId) {
  return `bap_${sha256Hex(`buzzassist-canvas-progress:v${CANVAS_RUN_PROGRESS_PROJECTION_VERSION}:${runId}:${kind}:${logicalId}`).slice(0, 24)}`;
}

function progressFileId(kind, digest) {
  const suffix = kind === "image" ? `image:${digest}:w${CANVAS_RUN_PROGRESS_PREVIEW_WIDTH}` : `audio-poster:${digest}`;
  return `file_${sha256Hex(`buzzassist-progress-file:v1:${suffix}`).slice(0, 24)}`;
}

/** 状態ファイル（Run の canvas-run.json の隣）。 */
export function resolveCanvasRunProgressStateFile(args = {}, runId) {
  return join(dirname(resolveCanvasRunStateFile(args, runId)), CANVAS_RUN_PROGRESS_STATE_FILE_NAME);
}

function normalizeMedia(value, field) {
  if (value === null || value === undefined) return null;
  if (!plainObject(value)) fail(`${field} は object であること。`);
  if (!MEDIA_KINDS.has(value.kind)) fail(`${field}.kind は image か audio。`);
  const digest = String(value.sha256 || "").replace(/^sha256:/iu, "").toLowerCase();
  if (!SHA256.test(digest)) fail(`${field}.sha256 が SHA-256 ではない。`);
  if (typeof value.path !== "string" || !value.path.trim()) fail(`${field}.path が無い。`);
  const number = (entry) => (Number.isFinite(Number(entry)) && Number(entry) > 0 ? Number(entry) : 0);
  return {
    kind: value.kind,
    sha256: digest,
    path: value.path,
    bytes: number(value.bytes),
    pixelWidth: Math.round(number(value.pixelWidth)),
    pixelHeight: Math.round(number(value.pixelHeight)),
    durationSeconds: number(value.durationSeconds),
    waveform: Array.isArray(value.waveform)
      ? value.waveform.slice(0, 120).map((peak) => Math.max(0, Math.min(1, Number(peak) || 0)))
      : [],
  };
}

function normalizeItem(value, field) {
  if (!plainObject(value)) fail(`${field} は object であること。`);
  const key = text(value.key, 300);
  if (!key) fail(`${field}.key が無い。`);
  const status = String(value.status || "pending");
  if (!CANVAS_JOB_STATUSES.includes(status)) fail(`${field}.status が未対応: ${status}`);
  return {
    key,
    title: text(value.title, 60) || key,
    lines: (Array.isArray(value.lines) ? value.lines : []).map((line) => text(line, 60)).filter(Boolean).slice(0, 4),
    status,
    rowBreak: value.rowBreak === true,
    media: normalizeMedia(value.media, `${field}.media`),
  };
}

function normalizeDag(value) {
  const nodes = Array.isArray(value?.nodes) ? value.nodes : [];
  const ids = new Set();
  const normalized = nodes.map((node, index) => {
    if (!plainObject(node)) fail(`dag.nodes[${index}] は object であること。`);
    const id = text(node.id, 80);
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) fail(`dag.nodes[${index}].id が不正: ${id}`);
    if (ids.has(id)) fail(`dag.nodes の id が重複: ${id}`);
    ids.add(id);
    const status = String(node.status || "pending");
    if (!CANVAS_RUN_PROGRESS_DAG_STATUSES.includes(status)) fail(`dag.nodes[${index}].status が未対応: ${status}`);
    return {
      id,
      title: text(node.title, 40) || id,
      status,
      needs: [...new Set((Array.isArray(node.needs) ? node.needs : []).map(String))],
      detail: text(node.detail, 60),
    };
  });
  for (const node of normalized) {
    for (const need of node.needs) {
      if (!ids.has(need)) fail(`dag.nodes ${node.id} が無い工程に依存: ${need}`);
      if (need === node.id) fail(`dag.nodes ${node.id} が自分に依存している。`);
    }
  }
  // 循環は depth の計算で検出する。
  dagDepths(normalized);
  return normalized;
}

function dagDepths(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const memo = new Map();
  const visiting = new Set();
  const depth = (id) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) fail(`dag に循環がある: ${id}`);
    visiting.add(id);
    const value = Math.max(0, ...(byId.get(id)?.needs ?? []).map((need) => depth(need) + 1));
    visiting.delete(id);
    memo.set(id, value);
    return value;
  };
  nodes.forEach((node) => depth(node.id));
  return memo;
}

/** snapshot を検証して正規化する。読み取り側の不具合（形の崩れ）はここで例外にする。 */
export function normalizeCanvasRunProgressSnapshot(value) {
  if (!plainObject(value)) fail("progress snapshot は object であること。");
  if (value.version !== CANVAS_RUN_PROGRESS_SNAPSHOT_VERSION) fail(`progress snapshot の版が違う: ${value.version}`);
  const runId = String(value.runId || "");
  resolveCanvasRunStateFile({ projectDir: "." }, runId); // runId の形をここで検査する（不正なら例外）
  const jobRevision = Number(value.jobRevision);
  if (!Number.isSafeInteger(jobRevision) || jobRevision < 0) fail("progress snapshot の jobRevision が不正。");
  const headerStatus = String(value.status || "pending");
  if (!CANVAS_JOB_STATUSES.includes(headerStatus)) fail(`progress snapshot の status が未対応: ${headerStatus}`);
  const sectionIds = new Set();
  const sections = (Array.isArray(value.sections) ? value.sections : []).map((section, index) => {
    if (!plainObject(section)) fail(`sections[${index}] は object であること。`);
    const id = text(section.id, 60);
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) fail(`sections[${index}].id が不正: ${id}`);
    if (sectionIds.has(id)) fail(`sections の id が重複: ${id}`);
    sectionIds.add(id);
    const keys = new Set();
    const items = (Array.isArray(section.items) ? section.items : []).map((item, itemIndex) => {
      const normalized = normalizeItem(item, `sections[${index}].items[${itemIndex}]`);
      if (keys.has(normalized.key)) fail(`sections[${index}] の item key が重複: ${normalized.key}`);
      keys.add(normalized.key);
      return normalized;
    });
    return {
      id,
      title: text(section.title, 60) || id,
      lines: (Array.isArray(section.lines) ? section.lines : []).map((line) => text(line, 120)).filter(Boolean).slice(0, 1),
      tileMedia: section.tileMedia === "audio" ? "audio" : "image",
      items,
    };
  });
  return {
    version: CANVAS_RUN_PROGRESS_SNAPSHOT_VERSION,
    runId,
    jobRevision,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    harnessId: text(value.harnessId, 80),
    title: text(value.title, 80) || "制作の途中",
    status: headerStatus,
    summaryLines: (Array.isArray(value.summaryLines) ? value.summaryLines : []).map((line) => text(line, 120)).filter(Boolean).slice(0, 5),
    dag: { nodes: normalizeDag(value.dag) },
    sections,
  };
}

/** snapshot の指紋。媒体の path は含めない（端末ごとの置き場で指紋が変わらないように）。 */
export function canvasRunProgressFingerprint(snapshot) {
  const normalized = normalizeCanvasRunProgressSnapshot(snapshot);
  const pathless = {
    ...normalized,
    sections: normalized.sections.map((section) => ({
      ...section,
      items: section.items.map((item) => ({
        ...item,
        media: item.media ? { ...item.media, path: undefined } : null,
      })),
    })),
  };
  return `sha256:${sha256Hex(canonicalJson(pathless))}`;
}

function clockFor(snapshot) {
  return { updatedAt: snapshot.updatedAt, revision: snapshot.jobRevision };
}

function progressCustomData(snapshot, stage, key, status) {
  return {
    [CANVAS_RUN_PROGRESS_TAG]: true,
    buzzassistRunId: snapshot.runId,
    buzzassistProgressStage: stage,
    buzzassistProgressKey: sha256Hex(`${stage}:${key}`).slice(0, 24),
    buzzassistStatus: status,
    buzzassistProgressProjectionVersion: CANVAS_RUN_PROGRESS_PROJECTION_VERSION,
  };
}

function xmlEscape(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function durationLabel(seconds) {
  if (!(seconds > 0)) return "";
  const total = Math.round(seconds * 10) / 10;
  const minutes = Math.floor(total / 60);
  const rest = (total - minutes * 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${rest}`;
}

/** 採用テイクの波形（振幅の包絡）を SVG の data URL にする。波形が無ければ既存の音声アイコン。 */
function audioPosterDataUrl(media, title) {
  if (!media.waveform.length) {
    return canvasRunMediaPreviewDataUrl({ kind: "audio", title, digest: media.sha256 });
  }
  const width = TILE_WIDTH;
  const height = AUDIO_BOX_HEIGHT;
  const left = 64;
  const right = width - 14;
  const middle = height / 2;
  const step = (right - left) / media.waveform.length;
  const bars = media.waveform.map((peak, index) => {
    const barHeight = Math.max(2, Math.round(peak * (height - 28)));
    const x = (left + index * step).toFixed(1);
    const y = (middle - barHeight / 2).toFixed(1);
    return `<rect x="${x}" y="${y}" width="${Math.max(1, step - 1).toFixed(1)}" height="${barHeight}" rx="1" fill="#7048b8"/>`;
  }).join("");
  const duration = xmlEscape(durationLabel(media.durationSeconds));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" rx="12" fill="#ffffff" stroke="#d0bfff"/><circle cx="32" cy="${middle}" r="18" fill="#7048b8"/><path d="M27 ${middle - 9}v18l15-9z" fill="#ffffff"/>${bars}<text x="${right}" y="${height - 6}" text-anchor="end" font-family="Arial,sans-serif" font-size="11" fill="#495057">${duration}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function fitIntoBox(media, boxWidth, boxHeight) {
  if (!(media.pixelWidth > 0 && media.pixelHeight > 0)) return { width: boxWidth, height: boxHeight, offsetX: 0, offsetY: 0 };
  const scale = Math.min(boxWidth / media.pixelWidth, boxHeight / media.pixelHeight);
  const width = Math.max(24, Math.round(media.pixelWidth * scale));
  const height = Math.max(24, Math.round(media.pixelHeight * scale));
  return { width, height, offsetX: Math.round((boxWidth - width) / 2), offsetY: Math.round((boxHeight - height) / 2) };
}

// カードの幅に収まる短い理由（原因のコードは戻り値の側で見る）。
function shortAssetError(code) {
  const value = String(code || "");
  if (!value) return "未確認";
  if (value === "作業場の外") return value;
  if (/SHA_MISMATCH|TARGET_CORRUPT/u.test(value)) return "SHA 不一致";
  if (/SYMLINK/u.test(value)) return "symlink";
  if (/SOURCE_MISSING/u.test(value)) return "ファイルが無い";
  if (/SOURCE_CHANGED/u.test(value)) return "読取り中に変更";
  if (/FORMAT/u.test(value)) return "形式が未対応";
  return "読めない";
}

function mediaDisplayName(stage, media, extension) {
  return `progress-${stage}-${media.sha256.slice(0, 12)}${extension}`;
}

/**
 * snapshot と、複製済みの資産（sha256 → { targetPath, format } または { error }）から、
 * Canvas の要素と files を作る。純粋な関数で、同じ入力からは同じ出力になる。
 */
export function buildCanvasRunProgressProjection(snapshotValue, { preparedAssets = new Map() } = {}) {
  const snapshot = normalizeCanvasRunProgressSnapshot(snapshotValue);
  const clock = clockFor(snapshot);
  const sequence = canvasProjectionIndexSequence();
  const elements = [];
  const files = {};
  const origin = CANVAS_RUN_PROGRESS_ORIGIN;
  const addCard = ({ stage, key, title, lines, status, x, y, width, height, link = null }) => {
    const result = buildCanvasStatusCard({
      cardId: stableCanvasProgressId(snapshot.runId, `${stage}-card`, key),
      labelId: stableCanvasProgressId(snapshot.runId, `${stage}-label`, key),
      groupId: stableCanvasProgressId(snapshot.runId, `${stage}-group`, key),
      customData: progressCustomData(snapshot, stage, key, status),
      title,
      lines,
      status,
      x,
      y,
      width,
      height,
      link,
      clock,
    }, sequence);
    elements.push(result.card, result.label);
    return result;
  };

  addCard({
    stage: "header",
    key: "header",
    title: snapshot.title,
    lines: snapshot.summaryLines,
    status: snapshot.status,
    x: origin.x,
    y: origin.y,
    width: PANEL_WIDTH,
    height: HEADER_HEIGHT,
  });

  // 工程の DAG: 深さを列、同じ深さの工程を行に並べる。
  const dagTop = origin.y + HEADER_HEIGHT + DAG_TOP_GAP;
  const depths = dagDepths(snapshot.dag.nodes);
  const rowsByDepth = new Map();
  const bounds = new Map();
  for (const node of snapshot.dag.nodes) {
    const depth = depths.get(node.id) ?? 0;
    const row = rowsByDepth.get(depth) ?? 0;
    rowsByDepth.set(depth, row + 1);
    const status = DAG_TO_CANVAS_STATUS[node.status];
    const result = addCard({
      stage: "dag",
      key: node.id,
      title: node.title,
      lines: [node.status, node.detail].filter(Boolean),
      status,
      x: origin.x + depth * DAG_COLUMN_STEP,
      y: dagTop + row * DAG_ROW_STEP,
      width: DAG_NODE_WIDTH,
      height: DAG_NODE_HEIGHT,
    });
    result.card.customData.buzzassistDagNodeId = node.id;
    result.card.customData.buzzassistDagStatus = node.status;
    result.label.customData.buzzassistDagNodeId = node.id;
    result.label.customData.buzzassistDagStatus = node.status;
    finalizeCanvasProjectionElement(result.card);
    finalizeCanvasProjectionElement(result.label);
    bounds.set(node.id, { id: result.card.id, x: result.card.x, y: result.card.y, width: result.card.width, height: result.card.height });
  }
  for (const node of snapshot.dag.nodes) {
    for (const need of node.needs) {
      const edgeKey = `${need}->${node.id}`;
      elements.push(buildCanvasArrow({
        id: stableCanvasProgressId(snapshot.runId, "dag-edge", edgeKey),
        customData: progressCustomData(snapshot, "dag-edge", edgeKey, "pending"),
        from: bounds.get(need),
        to: bounds.get(node.id),
        clock,
      }, sequence));
    }
  }
  const dagRows = Math.max(1, ...rowsByDepth.values());
  const dagBottom = snapshot.dag.nodes.length ? dagTop + (dagRows - 1) * DAG_ROW_STEP + DAG_NODE_HEIGHT : dagTop;
  let cursorY = dagBottom + SECTION_GAP;

  for (const section of snapshot.sections) {
    addCard({
      stage: "section",
      key: section.id,
      title: section.title,
      lines: section.lines,
      status: "pending",
      x: origin.x,
      y: cursorY,
      width: PANEL_WIDTH,
      height: SECTION_HEADER_HEIGHT,
    });
    cursorY += SECTION_HEADER_HEIGHT + SECTION_HEADER_GAP;
    const boxHeight = section.tileMedia === "audio" ? AUDIO_BOX_HEIGHT : IMAGE_BOX_HEIGHT;
    const tileHeight = boxHeight + MEDIA_LABEL_GAP + LABEL_HEIGHT;
    let column = 0;
    let rowTop = cursorY;
    let rowUsed = false;
    const nextRow = () => {
      column = 0;
      rowTop += tileHeight + ROW_GAP;
      rowUsed = false;
    };
    const stage = section.id;
    for (const item of section.items) {
      if (item.rowBreak && column > 0) nextRow();
      const tileX = origin.x + column * (TILE_WIDTH + TILE_GAP);
      const prepared = item.media ? preparedAssets.get(`${item.media.kind}:${item.media.sha256}`) : null;
      const usable = item.media && prepared && !prepared.error;
      const lines = [...item.lines];
      let status = item.status;
      if (item.media && !usable) {
        lines.push(`原本を読めない（${shortAssetError(prepared?.error)}）`);
        status = "failed";
      }
      if (usable) {
        const media = item.media;
        const digest = media.sha256;
        const groupId = stableCanvasProgressId(snapshot.runId, `${stage}-group`, item.key);
        const assetUrl = canvasRunMediaAssetUrl({ runId: snapshot.runId }, prepared);
        const fileId = progressFileId(media.kind, digest);
        const displayName = mediaDisplayName(stage, media, prepared.format.extension);
        const elementId = stableCanvasProgressId(snapshot.runId, `${stage}-media`, `${item.key}:${digest}`);
        // 状態はラベルのカードだけが持つ（ラベルが変わっても画・音の要素は動かさない）。
        const { buzzassistStatus: _status, ...mediaCustomData } = progressCustomData(snapshot, `${stage}-media`, item.key, status);
        const base = {
          ...mediaCustomData,
          buzzassistArtifactSha256: `sha256:${digest}`,
          codexFileName: displayName,
        };
        let element;
        if (media.kind === "image") {
          const previewUrl = `${assetUrl}?w=${CANVAS_RUN_PROGRESS_PREVIEW_WIDTH}`;
          const fit = fitIntoBox(media, TILE_WIDTH, boxHeight);
          element = canvasRunMediaBaseElement({
            id: elementId,
            fileId,
            index: sequence.next(),
            bounds: { x: tileX + fit.offsetX, y: rowTop + fit.offsetY, width: fit.width, height: fit.height },
            customData: {
              ...base,
              codexInsertedImage: true,
              codexMediaKind: "image",
              codexAssetMimeType: prepared.format.mimeType,
              codexPixelWidth: media.pixelWidth || null,
              codexPixelHeight: media.pixelHeight || null,
              // 表示はプレビュー。原寸は link（content-addressed の原本）から開く。
              codexAssetUrl: previewUrl,
              buzzassistOriginalAssetUrl: assetUrl,
            },
            run: clock,
            link: assetUrl,
            type: "image",
          });
          files[fileId] = {
            id: fileId,
            name: displayName,
            mimeType: prepared.format.mimeType,
            dataURL: previewUrl,
            codexAssetBacked: true,
            codexAssetUrl: previewUrl,
            created: deterministicInteger(fileId, 3),
            lastRetrieved: deterministicInteger(fileId, 3),
          };
        } else {
          element = canvasRunMediaBaseElement({
            id: elementId,
            fileId,
            index: sequence.next(),
            bounds: { x: tileX, y: rowTop, width: TILE_WIDTH, height: boxHeight },
            customData: {
              ...base,
              codexInsertedAttachment: true,
              codexGeneratedSpeech: true,
              codexKeepInlinePreview: true,
              codexMediaKind: "audio",
              codexAssetMimeType: prepared.format.mimeType,
              codexAssetDuration: media.durationSeconds || 0,
              codexAssetUrl: assetUrl,
            },
            run: clock,
            link: assetUrl,
            type: "image",
          });
          files[fileId] = {
            id: fileId,
            name: `${displayName}-waveform.svg`,
            mimeType: "image/svg+xml",
            dataURL: audioPosterDataUrl(media, item.title),
            created: deterministicInteger(fileId, 3),
            lastRetrieved: deterministicInteger(fileId, 3),
          };
        }
        element.groupIds = [groupId];
        elements.push(finalizeCanvasProjectionElement(element));
        addCard({
          stage,
          key: item.key,
          title: item.title,
          lines,
          status,
          x: tileX,
          y: rowTop + boxHeight + MEDIA_LABEL_GAP,
          width: TILE_WIDTH,
          height: LABEL_HEIGHT,
          link: assetUrl,
        });
      } else {
        addCard({
          stage,
          key: item.key,
          title: item.title,
          lines,
          status,
          x: tileX,
          y: rowTop,
          width: TILE_WIDTH,
          height: tileHeight,
        });
      }
      rowUsed = true;
      column += 1;
      if (column === COLUMNS) nextRow();
    }
    cursorY = (rowUsed ? rowTop + tileHeight : rowTop - ROW_GAP) + SECTION_GAP;
  }

  return {
    runId: snapshot.runId,
    jobRevision: snapshot.jobRevision,
    fingerprint: canvasRunProgressFingerprint(snapshot),
    clock,
    elements,
    files,
  };
}

function ownedProgress(element, runId) {
  return element?.customData?.[CANVAS_RUN_PROGRESS_TAG] === true && element?.customData?.buzzassistRunId === runId;
}

function validIndex(value) {
  if (typeof value !== "string" || !value) return false;
  try {
    generateKeyBetween(value, null);
    return true;
  } catch {
    return false;
  }
}

const OWNED_FILE_FIELDS = Object.freeze(["id", "name", "mimeType", "dataURL", "codexAssetBacked", "codexAssetUrl"]);

function sameOwnedFileFields(existing, desired) {
  return OWNED_FILE_FIELDS.every((field) => canonicalJson(existing?.[field]) === canonicalJson(desired?.[field]));
}

/** 既存の scene へ投影を当てる。自分の要素だけを追加・更新・墓標化し、他の要素と files には触らない。 */
export function reconcileCanvasRunProgress(sceneValue, projection) {
  const scene = normalizeScene(sceneValue);
  const runId = projection.runId;
  const desired = new Map(projection.elements.map((element) => [element.id, element]));
  const changed = { added: [], updated: [], removed: [] };
  let unchanged = 0;
  const elements = [];
  for (const element of scene.elements) {
    const wanted = desired.get(element.id);
    if (wanted) {
      if (!ownedProgress(element, runId)) {
        fail(`Canvas の要素 ID が BuzzAssist の途中投影でない要素と衝突した: ${element.id}`, "CANVAS_RUN_PROGRESS_ID_COLLISION");
      }
      const next = nextCanvasProjectedElement(element, wanted, projection.clock);
      elements.push(next);
      desired.delete(element.id);
      if (next === element) unchanged += 1;
      else changed.updated.push(element.id);
      continue;
    }
    if (ownedProgress(element, runId)) {
      const next = tombstoneCanvasProjectedElement(element, projection.clock);
      elements.push(next);
      if (next === element) unchanged += 1;
      else changed.removed.push(element.id);
      continue;
    }
    elements.push(element);
  }
  // 新しい要素は配列の末尾に足すので、index も scene の最大の後ろにする（配列順と index 順を揃える）。
  let previous = null;
  for (const element of elements) {
    if (validIndex(element.index) && (previous === null || element.index > previous)) previous = element.index;
  }
  for (const wanted of desired.values()) {
    previous = generateKeyBetween(previous, null);
    elements.push({ ...wanted, index: previous });
    changed.added.push(wanted.id);
  }

  const files = { ...scene.files };
  let filesAdded = 0;
  let filesUpdated = 0;
  for (const [id, file] of Object.entries(projection.files)) {
    const existing = files[id];
    if (!existing) {
      files[id] = file;
      filesAdded += 1;
      continue;
    }
    if (sameOwnedFileFields(existing, file)) continue;
    const foreign = scene.elements.some((element) => element.fileId === id && !ownedProgress(element, runId));
    if (foreign) fail(`Canvas の file ID が途中投影でない要素と衝突した: ${id}`, "CANVAS_RUN_PROGRESS_ID_COLLISION");
    files[id] = file;
    filesUpdated += 1;
  }
  for (const key of Object.keys(changed)) changed[key].sort();
  return {
    scene: { ...scene, elements, files, appState: { ...scene.appState } },
    statistics: {
      added: changed.added.length,
      updated: changed.updated.length,
      unchanged,
      removed: changed.removed.length,
      filesAdded,
      filesUpdated,
      changedElementIds: changed,
    },
  };
}

function insideRoot(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * 媒体の原本を読み、SHA を確かめて content-addressed に複製する（dry-run では読むだけ）。
 * 1件の失敗で投影全体を止めない。失敗した成果物は、そのカードに「原本を読めない」と出す。
 */
async function prepareProgressAssets(args, snapshot, { dryRun = false, sourceRoot = "" } = {}) {
  const prepared = new Map();
  let copied = 0;
  let reused = 0;
  for (const section of snapshot.sections) {
    for (const item of section.items) {
      const media = item.media;
      if (!media) continue;
      const key = `${media.kind}:${media.sha256}`;
      if (prepared.has(key)) continue;
      if (sourceRoot && !insideRoot(sourceRoot, media.path)) {
        prepared.set(key, { error: "作業場の外" });
        continue;
      }
      try {
        const asset = await verifyCanvasRunMediaAsset(args, { runId: snapshot.runId }, {
          id: `progress-${media.sha256.slice(0, 16)}`,
          kind: media.kind === "image" ? "image-candidate" : "audio",
          sha256: `sha256:${media.sha256}`,
          path: media.path,
        }, { dryRun });
        if (asset.copied) copied += 1;
        if (asset.reused) reused += 1;
        prepared.set(key, { targetPath: asset.targetPath, format: asset.format });
      } catch (error) {
        prepared.set(key, { error: String(error?.code || error?.message || "読み取り失敗") });
      }
    }
  }
  return { prepared, copied, reused };
}

/**
 * 途中の成果物を Canvas へ投影する。options.sourceRoot を渡すと、その外の原本は読まない。
 * 戻り値の changedElementIds は、この投影で追加・更新・墓標化した要素 ID（差分の確認用）。
 */
export async function projectCanvasRunProgress(args = {}, snapshotValue, options = {}) {
  const snapshot = normalizeCanvasRunProgressSnapshot(snapshotValue);
  const canvasFile = resolveCanvasFile(args);
  const stateFile = resolveCanvasRunProgressStateFile(args, snapshot.runId);
  const staleAgainst = (stored) => stored
    && stored.runId === snapshot.runId
    && Number.isSafeInteger(stored.jobRevision)
    && stored.jobRevision > snapshot.jobRevision;
  const skipped = (dryRun) => ({
    ok: true,
    added: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    changedElementIds: { added: [], updated: [], removed: [] },
    assetsCopied: 0,
    assetsReused: 0,
    assetErrors: [],
    skipped: true,
    skippedReason: "stale-job-revision",
    dryRun,
  });
  // 古い revision なら原本も読まない（複製もしない）。lock の中でもう一度確かめる。
  if (staleAgainst(await readJsonIfExists(stateFile, null))) return skipped(options.dryRun === true);

  const assets = await prepareProgressAssets(args, snapshot, { dryRun: options.dryRun === true, sourceRoot: options.sourceRoot || "" });
  const projection = buildCanvasRunProgressProjection(snapshot, { preparedAssets: assets.prepared });
  const summary = (statistics, extra = {}) => ({
    ok: true,
    changedElementIds: { added: [], updated: [], removed: [] },
    ...statistics,
    assetsCopied: assets.copied,
    assetsReused: assets.reused,
    // 原本を読めなかった成果物（種類と SHA-256 と理由のコード。パスは出さない）。
    assetErrors: [...assets.prepared]
      .filter(([, value]) => value.error)
      .map(([key, value]) => ({ key, error: value.error }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    projectedElements: projection.elements.length,
    fingerprint: projection.fingerprint,
    ...extra,
  });

  if (options.dryRun === true) {
    const reconciled = reconcileCanvasRunProgress(await readJsonIfExists(canvasFile, null), projection);
    return summary(reconciled.statistics, { dryRun: true });
  }

  return withCanvasFileLock(stateFile, async () => {
    // lock の前に読んだ revision は、別の process の投影の後では古い。lock の中で読み直す。
    if (staleAgainst(await readJsonIfExists(stateFile, null))) return skipped(false);
    const statistics = await withCanvasFileLock(canvasFile, async () => {
      const reconciled = reconcileCanvasRunProgress(await readJsonIfExists(canvasFile, null), projection);
      if (reconciled.statistics.added || reconciled.statistics.updated || reconciled.statistics.removed
        || reconciled.statistics.filesAdded || reconciled.statistics.filesUpdated) {
        await writeJsonAtomic(canvasFile, reconciled.scene);
      }
      return reconciled.statistics;
    });
    await writeJsonAtomic(stateFile, {
      version: CANVAS_RUN_PROGRESS_STATE_VERSION,
      runId: snapshot.runId,
      jobRevision: snapshot.jobRevision,
      fingerprint: projection.fingerprint,
      projectedElements: projection.elements.length,
    });
    return summary(statistics, { dryRun: false });
  });
}

export const _testing = Object.freeze({ audioPosterDataUrl, fitIntoBox, insideRoot, progressFileId });
