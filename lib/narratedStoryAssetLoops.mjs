/**
 * ナレーション物語の公式経路で、成果物を使う前に「途中の成果物の品質ループ」（lib/assetQualityLoop.mjs）の
 * 合格を必須にする関門（ジャンル層。監査契約 buzzassist-narrated-story-audit-v5 から）。
 *
 *   - 本編の画（scene-image）: 描く場面ごとに、ループが合格している（別文脈の評価者で合格し、要る人の確認が
 *     揃っている）こと、描く画のファイルの sha256 が合格した版と同じであること。broker（有料の Media Job）の画は
 *     Job の作業フォルダ（runDir）で、運営者の画（image.source: operator-file）は取り込みの記録の
 *     assetLoop.statePath が指す作業フォルダでループを回す
 *   - 人物の設定画（character）: 本編の画の合格した版が並べて見た参照と、運営者の画の取り込みの記録が宣言した
 *     参照（どちらも承認済みの設定画の sha256）の全部が、同じ作業フォルダの人物の設定画のループで合格した版
 *     そのものであること（Pack や人物の登録簿で「承認済み」と書いてあるだけの参照を、そのまま信じない）
 *   - 声のテイク（voice-take）: 採用するテイクが、声の品質ゲートに通り、Job の作業フォルダの声のテイクのループで
 *     合格した版であること。ループが合格した版が、品質ゲートに通った別のテイクなら、そのテイクを採用する
 *     （評価者が耳で選んだテイクを使う。機械の順位で上書きしない）。CER・UTMOS などの測定は声のテイクの工程の
 *     measurement（文ごとに quality/voice-take-measurements/<文の id>.json）として置き、聞いた印象（直前の地の文との声の連続、
 *     台詞だけ浮いていないか）は評価者が採点する
 *
 * ここはループを回さない（採点・人の確認をしない）。足りないものを工程・対象 id・理由コードで返し、Job は
 * awaiting-human-review で止まる。有料の再生成も回さない。判定は lib/assetQualityLoop.mjs の assetQualityStatus
 * の1か所に聞き、状態ファイルの置き場の規則は lib/operatorImageImport.mjs の assetLoopStateLocation を使う。
 *
 * 理由コード:
 *   loop-not-started / review-required / revision-required / human-verification-required:<欄>
 *   human-rejected:<欄> / loop-stopped:<状態> / sha256-mismatch（合格した版と使う画・テイクが違う）
 *   asset-missing / loop-unreadable / record-required（運営者の画の記録に assetLoop が無い）
 *   asset-loop-state-not-this-stage / asset-loop-state-path-layout（assetLoop.statePath が本体の置き場の規則と違う）
 *   voice-quality-gate-failed（声の品質ゲートに通ったテイクが無い）
 *   no-scene-images / no-voice-takes（見る対象が無い。対象 id は none。見る物が無いことを合格にしない）
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  ASSET_QUALITY_DIR,
  assetQualityPaths,
  assetQualityStatus,
  listAssetQualityStatus,
} from "./assetQualityLoop.mjs";
import { assetLoopStateLocation } from "./operatorImageImport.mjs";

export const NARRATED_ASSET_LOOP_GATE_VERSION = "buzzassist-narrated-asset-loop-gate-v1";
/** この関門が効力を持つ監査契約の版（ハーネス宣言の保証 asset-quality-loop の inForceSince と同じ）。 */
export const NARRATED_ASSET_LOOP_SINCE = "buzzassist-narrated-story-audit-v5";
export const NARRATED_ASSET_LOOP_HARNESS_ID = "narrated-story-video";
export const NARRATED_SCENE_IMAGE_LOOP_AUDIT_ID = "sceneImageAssetLoopPassed";
export const NARRATED_VOICE_TAKE_LOOP_AUDIT_ID = "voiceTakeAssetLoopPassed";
export const NARRATED_CHARACTER_LOOP_AUDIT_ID = "characterAssetLoopPassed";
export const NARRATED_ASSET_LOOP_AUDIT_IDS = Object.freeze([
  NARRATED_SCENE_IMAGE_LOOP_AUDIT_ID,
  NARRATED_VOICE_TAKE_LOOP_AUDIT_ID,
  NARRATED_CHARACTER_LOOP_AUDIT_ID,
]);
/**
 * 声のテイクの measurement の置き場（Job の作業フォルダからの相対。"/" 区切り）。文（対象 id）ごとに1ファイルで、
 * その文のテイクだけを載せる。ループの機械ゲート voice-metrics-pass は measurement の行をテイクの sha256 だけで
 * 引くので、全部の文を1ファイルに入れると、同じバイト列のテイクが別の文にあったとき別の文の判定を拾い得る。
 */
export const NARRATED_VOICE_TAKE_MEASUREMENT_DIR = "quality/voice-take-measurements";

/** 文（声のテイクの工程の対象 id）の measurement の置き場（Job の作業フォルダからの相対）。 */
export function narratedVoiceTakeMeasurementPath(segmentId) {
  return `${NARRATED_VOICE_TAKE_MEASUREMENT_DIR}/${segmentId}.json`;
}
export const NARRATED_ASSET_LOOP_CLI = "node scripts/asset-quality-loop.mjs";

const ASSET_LOOP_LAYOUT = Object.freeze({ ASSET_QUALITY_DIR, assetQualityPaths });
const SHA256 = /^[a-f0-9]{64}$/u;
const CONTRACT = /^(?<series>.+)-v(?<number>\d+)$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function lowerSha(value) {
  const text = String(value || "").trim().toLowerCase();
  return SHA256.test(text) ? text : "";
}

function lastOf(list) {
  return Array.isArray(list) && list.length > 0 ? list[list.length - 1] : null;
}

function check(pass, detail, evidence = {}) {
  return { pass: pass === true, detail: String(detail), ...evidence };
}

async function fileSha256OrEmpty(file) {
  if (!file) return "";
  try {
    return sha256(await readFile(file));
  } catch {
    return "";
  }
}

/** 作業フォルダの中なら "/" 区切りの相対パス、外なら絶対パス（評価者が --asset に渡す値）。 */
function displayPath(workDir, file) {
  if (!file) return "";
  if (!workDir) return path.resolve(file);
  const rel = path.relative(workDir, path.resolve(file));
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return path.resolve(file);
  return rel.split(path.sep).join("/");
}

/**
 * 監査契約の版がこの関門を要るか。版が読めない・系列が違うときは「要る」に倒す（読めないことを免除の
 * 理由にしない）。当時この関門が無かった版（v4 以前）の Job は、従来どおり確定できる。
 */
export function narratedAssetLoopsRequired(contractVersion) {
  const since = CONTRACT.exec(NARRATED_ASSET_LOOP_SINCE).groups;
  const match = CONTRACT.exec(String(contractVersion || "").trim());
  if (!match || match.groups.series !== since.series) return true;
  return Number(match.groups.number) >= Number(since.number);
}

/** assetQualityStatus の結果を、Job に返す理由コードにする（合格していないときだけ呼ぶ）。 */
export function assetLoopReasonCode(status) {
  if (status?.unreadable) return "loop-unreadable";
  if (!status?.started) return "loop-not-started";
  const loop = status.check || {};
  const issues = status.issues || [];
  if (loop.status === "passed") {
    if (issues.includes("asset-quality-asset-missing") || issues.includes("asset-quality-candidate-missing")) return "asset-missing";
    return "sha256-mismatch";
  }
  if (loop.status === "awaiting-human-verification") {
    return `human-verification-required:${(loop.humanVerification?.missing || []).join("+") || "unknown"}`;
  }
  if (loop.status === "human-rejected") {
    return `human-rejected:${(loop.humanVerification?.rejected || []).join("+") || "unknown"}`;
  }
  if (loop.status === "active") return Number(loop.rounds) > 0 ? "revision-required" : "review-required";
  return `loop-stopped:${loop.status || "unknown"}`;
}

async function loopStatus(args) {
  try {
    return await assetQualityStatus(args);
  } catch {
    return { started: false, pass: false, unreadable: true, issues: ["asset-quality-loop-unreadable"], check: {} };
  }
}

/**
 * 運営者の画の取り込みの記録の1行（checkOperatorImageImport の scenes[].row）から、本編の画の工程の対象を作る。
 * 記録に assetLoop が無ければ record-required、置き場が本体の規則と違えばその理由で止める。
 */
export function operatorSceneLoopSubject(sceneId, row) {
  const base = {
    sceneId,
    source: "operator-file",
    assetPath: row?.image?.full || "",
    assetSha256: lowerSha(row?.image?.sha256),
    extraReferenceSha256s: [...(row?.referenceSha256s || [])],
  };
  if (!row?.assetLoop?.full) return { ...base, recordProblem: "record-required" };
  const location = assetLoopStateLocation(row.assetLoop.full, "scene-image", ASSET_LOOP_LAYOUT);
  if (!location.ok) return { ...base, recordProblem: location.detail };
  return { ...base, workDir: location.workDir, subjectId: location.subjectId };
}

/** broker の画（Job の作業フォルダの media/images/<場面>.png）の、本編の画の工程の対象。 */
export function brokerSceneLoopSubject(sceneId, { runDir, imagePath }) {
  return { sceneId, source: "broker", workDir: runDir, subjectId: sceneId, assetPath: imagePath, assetSha256: "", extraReferenceSha256s: [] };
}

async function sceneVerdict(scene) {
  const base = {
    sceneId: scene.sceneId,
    source: scene.source,
    workDir: scene.workDir || "",
    subjectId: scene.subjectId || "",
    assetPath: scene.assetPath || "",
    assetSha256: lowerSha(scene.assetSha256),
    extraReferenceSha256s: [...(scene.extraReferenceSha256s || [])],
    referenceSha256s: [],
    pass: false,
    reason: "",
  };
  if (scene.recordProblem) return { ...base, reason: scene.recordProblem };
  if (!base.workDir || !base.subjectId) return { ...base, reason: "record-required" };
  const currentSha = await fileSha256OrEmpty(base.assetPath);
  if (!currentSha) return { ...base, reason: "asset-missing" };
  // 記録した sha256（取り込みの記録・前に描いた版）と今のファイルが違えば、合格の照合より先に止める。
  if (base.assetSha256 && base.assetSha256 !== currentSha) return { ...base, reason: "sha256-mismatch" };
  const status = await loopStatus({ workDir: base.workDir, stage: "scene-image", subjectId: base.subjectId, assetPath: base.assetPath });
  const passedSha = lowerSha(status.check?.assetSha256);
  if (status.pass === true && passedSha === currentSha) {
    const version = lastOf(status.state?.asset?.versions);
    return {
      ...base,
      assetSha256: currentSha,
      referenceSha256s: (version?.referenceSha256s || []).map(lowerSha).filter(Boolean),
      pass: true,
      rounds: Number(status.check?.rounds) || 0,
    };
  }
  return { ...base, assetSha256: currentSha, reason: status.pass === true ? "sha256-mismatch" : assetLoopReasonCode(status) };
}

/** 作業フォルダの人物の設定画のループを、最後の版の sha256 で引けるようにする（合格を優先）。 */
async function characterIndex(workDir) {
  const bySha = new Map();
  let listed = { entries: [] };
  try {
    listed = await listAssetQualityStatus({ workDir, stage: "character" });
  } catch {
    return bySha;
  }
  for (const entry of listed.entries || []) {
    const status = await loopStatus({ workDir, stage: "character", subjectId: entry.subjectId });
    const sha = lowerSha(status.check?.assetSha256);
    if (!sha) continue;
    const row = { subjectId: entry.subjectId, pass: status.pass === true, reason: status.pass === true ? "" : assetLoopReasonCode(status) };
    const previous = bySha.get(sha);
    if (!previous || (!previous.pass && row.pass)) bySha.set(sha, row);
  }
  return bySha;
}

async function characterVerdicts(sceneRows) {
  const needed = new Map();
  for (const scene of sceneRows) {
    if (!scene.workDir) continue;
    for (const ref of new Set([...scene.extraReferenceSha256s, ...scene.referenceSha256s].map(lowerSha).filter(Boolean))) {
      const key = `${scene.workDir}\u0000${ref}`;
      if (!needed.has(key)) needed.set(key, { workDir: scene.workDir, referenceSha256: ref, usedBy: [] });
      needed.get(key).usedBy.push(scene.sceneId);
    }
  }
  const indexes = new Map();
  const rows = [];
  for (const item of needed.values()) {
    if (!indexes.has(item.workDir)) indexes.set(item.workDir, await characterIndex(item.workDir));
    const found = indexes.get(item.workDir).get(item.referenceSha256);
    rows.push({
      ...item,
      subjectId: found?.subjectId || "",
      pass: found?.pass === true,
      reason: found ? (found.pass ? "" : found.reason) : "loop-not-started",
    });
  }
  return rows;
}

async function voiceVerdict(voice, { workDir }) {
  const candidates = [];
  for (const candidate of voice.candidates || []) {
    candidates.push({ ...candidate, sha256: await fileSha256OrEmpty(candidate.path) });
  }
  const machinePassing = candidates.filter((candidate) => candidate.machinePass === true && candidate.sha256);
  const target = candidates.find((candidate) => candidate.take === voice.machineTake) || machinePassing[0] || candidates[0] || null;
  const base = { segmentId: voice.segmentId, workDir, target, pass: false, reason: "", adopted: null };
  if (machinePassing.length === 0) return { ...base, reason: candidates.length === 0 ? "asset-missing" : "voice-quality-gate-failed" };
  const status = await loopStatus({ workDir, stage: "voice-take", subjectId: voice.segmentId });
  if (status.pass === true) {
    const passedSha = lowerSha(status.check?.assetSha256);
    const adopted = machinePassing.find((candidate) => candidate.sha256 === passedSha);
    if (adopted) return { ...base, pass: true, adopted, rounds: Number(status.check?.rounds) || 0 };
    return {
      ...base,
      reason: candidates.some((candidate) => candidate.sha256 === passedSha) ? "voice-quality-gate-failed" : "sha256-mismatch",
    };
  }
  return { ...base, reason: assetLoopReasonCode(status) };
}

/**
 * 関門の本体。scenes・voices のどちらかを null にすると、その工程は見ない（運営者の画は有料の処理の前に
 * 本編の画と人物だけを見る）。戻り値の pass が false なら、呼び出し側は描かずに awaiting-human-review で止まる。
 *
 *   scenes: [{ sceneId, source, workDir, subjectId, assetPath, assetSha256?, extraReferenceSha256s, recordProblem? }]
 *   voices: [{ segmentId, machineTake, candidates: [{ take, path, receipt, machinePass }] }]
 */
export async function gateNarratedAssetLoops({
  runDir,
  contractVersion = NARRATED_ASSET_LOOP_SINCE,
  generatorContextId = "",
  scenes = null,
  voices = null,
} = {}) {
  const issues = [];
  const pending = [];
  const checks = {};
  const plan = { version: NARRATED_ASSET_LOOP_GATE_VERSION, contractVersion, scenes: [], voices: [] };
  const adoptedTakes = new Map();
  const counts = {};

  if (Array.isArray(scenes)) {
    const sceneRows = [];
    for (const scene of scenes) sceneRows.push(await sceneVerdict(scene));
    const characterRows = await characterVerdicts(sceneRows);
    for (const row of sceneRows) {
      plan.scenes.push({
        sceneId: row.sceneId,
        source: row.source,
        workDir: row.workDir,
        subjectId: row.subjectId,
        assetPath: row.assetPath,
        assetSha256: row.assetSha256,
        extraReferenceSha256s: row.extraReferenceSha256s,
      });
      if (row.pass) continue;
      issues.push(`scene-image-asset-loop-not-passed:${row.sceneId}:${row.reason}`);
      pending.push({
        stage: "scene-image",
        subjectId: row.subjectId || row.sceneId,
        sceneId: row.sceneId,
        source: row.source,
        workDir: row.workDir,
        assetPath: displayPath(row.workDir, row.assetPath),
        assetSha256: row.assetSha256,
        reason: row.reason,
        ...(row.source === "broker" && generatorContextId ? { generatorContextId } : {}),
      });
    }
    for (const row of characterRows) {
      if (row.pass) continue;
      issues.push(`character-asset-loop-not-passed:${row.referenceSha256.slice(0, 12)}:${row.reason}`);
      pending.push({
        stage: "character",
        subjectId: row.subjectId,
        referenceSha256: row.referenceSha256,
        usedBy: [...row.usedBy],
        workDir: row.workDir,
        reason: row.reason,
      });
    }
    // 見る物が無いのは合格ではない（理由の無い停止にもしない）。
    if (sceneRows.length === 0) issues.push("scene-image-asset-loop-not-passed:none:no-scene-images");
    const failedScenes = sceneRows.filter((row) => !row.pass);
    const failedRefs = characterRows.filter((row) => !row.pass);
    counts.sceneImages = { passed: sceneRows.length - failedScenes.length, total: sceneRows.length };
    counts.characterReferences = { passed: characterRows.length - failedRefs.length, total: characterRows.length };
    checks[NARRATED_SCENE_IMAGE_LOOP_AUDIT_ID] = check(
      sceneRows.length > 0 && failedScenes.length === 0,
      sceneRows.length === 0
        ? "no scene images to check"
        : (failedScenes.length === 0
          ? `${sceneRows.length} scene images passed the scene-image asset quality loop (independent evaluator, required human checks, rendered source SHA-256 = passed version)`
          : `scene-image asset quality loop not passed for ${failedScenes.length}/${sceneRows.length}: ${failedScenes.slice(0, 20).map((row) => `${row.sceneId}(${row.reason})`).join(", ")}`),
      {
        contractVersion,
        scenes: sceneRows.map((row) => ({
          sceneId: row.sceneId,
          source: row.source,
          pass: row.pass,
          reason: row.reason,
          assetSha256: row.assetSha256 || null,
          referenceSha256s: row.referenceSha256s,
        })),
      },
    );
    checks[NARRATED_CHARACTER_LOOP_AUDIT_ID] = check(
      sceneRows.length > 0 && failedScenes.length === 0 && failedRefs.length === 0,
      failedScenes.length > 0
        ? `character references cannot be confirmed until every scene-image loop passes (${failedScenes.length} pending)`
        : (failedRefs.length === 0
          ? `${characterRows.length} character reference(s) used by the scene images are the passed versions of character asset quality loops`
          : `character asset quality loop not passed for ${failedRefs.length}/${characterRows.length} reference(s): ${failedRefs.slice(0, 20).map((row) => `${row.referenceSha256.slice(0, 12)}(${row.reason})`).join(", ")}`),
      {
        contractVersion,
        references: characterRows.map((row) => ({
          referenceSha256: row.referenceSha256,
          usedBy: [...row.usedBy],
          subjectId: row.subjectId || null,
          pass: row.pass,
          reason: row.reason,
        })),
      },
    );
  }

  if (Array.isArray(voices)) {
    const voiceRows = [];
    for (const voice of voices) voiceRows.push(await voiceVerdict(voice, { workDir: runDir }));
    let previous = null;
    for (const row of voiceRows) {
      const used = row.adopted || row.target;
      if (row.pass) {
        adoptedTakes.set(row.segmentId, { take: row.adopted.take, path: row.adopted.path, receipt: row.adopted.receipt });
        plan.voices.push({
          segmentId: row.segmentId,
          machineTake: row.adopted.take,
          candidates: [{ take: row.adopted.take, path: row.adopted.path, machinePass: true }],
        });
      } else {
        issues.push(`voice-take-asset-loop-not-passed:${row.segmentId}:${row.reason}`);
        pending.push({
          stage: "voice-take",
          subjectId: row.segmentId,
          workDir: runDir,
          assetPath: displayPath(runDir, used?.path || ""),
          assetSha256: used?.sha256 || "",
          reason: row.reason,
          measurementPath: narratedVoiceTakeMeasurementPath(row.segmentId),
          ...(previous?.path ? { contextAssetPath: displayPath(runDir, previous.path) } : {}),
          ...(generatorContextId ? { generatorContextId } : {}),
        });
      }
      previous = used;
    }
    if (voiceRows.length === 0) issues.push("voice-take-asset-loop-not-passed:none:no-voice-takes");
    const failed = voiceRows.filter((row) => !row.pass);
    counts.voiceTakes = { passed: voiceRows.length - failed.length, total: voiceRows.length };
    checks[NARRATED_VOICE_TAKE_LOOP_AUDIT_ID] = check(
      voiceRows.length > 0 && failed.length === 0,
      voiceRows.length === 0
        ? "no voice takes to check"
        : (failed.length === 0
          ? `${voiceRows.length} adopted voice takes passed the voice-take asset quality loop (CER/UTMOS measurement as the machine gate, independent evaluator for continuity and fit)`
          : `voice-take asset quality loop not passed for ${failed.length}/${voiceRows.length}: ${failed.slice(0, 20).map((row) => `${row.segmentId}(${row.reason})`).join(", ")}`),
      {
        contractVersion,
        measurementDir: NARRATED_VOICE_TAKE_MEASUREMENT_DIR,
        takes: voiceRows.map((row) => ({
          segmentId: row.segmentId,
          pass: row.pass,
          reason: row.reason,
          adoptedTake: row.adopted?.take ?? null,
          assetSha256: (row.adopted || row.target)?.sha256 || null,
        })),
      },
    );
  }

  const pass = issues.length === 0 && Object.values(checks).every((entry) => entry.pass === true);
  return {
    pass,
    issues: [...new Set(issues)],
    checks,
    adoptedTakes,
    plan,
    summary: {
      version: NARRATED_ASSET_LOOP_GATE_VERSION,
      contractVersion,
      pass,
      harnessId: NARRATED_ASSET_LOOP_HARNESS_ID,
      ...(generatorContextId ? { generatorContextId } : {}),
      counts,
      pending,
      detail: pass
        ? "every scene image, character reference and adopted voice take passed its asset quality loop"
        : `途中の成果物の品質ループの合格が要る（${pending.length} 件）。${NARRATED_ASSET_LOOP_CLI} start / sheet / record / verify で`
          + " 各対象のループを、作った文脈とは別の評価文脈で回し、要る人の確認を揃えてから同じ Job を resume する。"
          + " 有料の再生成はしない（画やテイクを作り直すかは人が決める）",
    },
  };
}

/** 確定のときの再照合。production で記録した対象（描いた画・採用したテイク）が今も合格しているか。 */
export async function reverifyNarratedAssetLoops({ runDir, plan, generatorContextId = "" } = {}) {
  if (!plan || plan.version !== NARRATED_ASSET_LOOP_GATE_VERSION || !Array.isArray(plan.scenes) || !Array.isArray(plan.voices)
    || plan.scenes.length === 0 || plan.voices.length === 0) {
    const detail = "asset quality loop plan is missing from the production state; the rendered assets cannot be tied to passed loops";
    return {
      pass: false,
      issues: ["asset-quality-loop-plan-missing"],
      checks: Object.fromEntries(NARRATED_ASSET_LOOP_AUDIT_IDS.map((id) => [id, check(false, detail)])),
      adoptedTakes: new Map(),
      plan: plan || null,
      summary: { version: NARRATED_ASSET_LOOP_GATE_VERSION, pass: false, pending: [], detail },
    };
  }
  return gateNarratedAssetLoops({
    runDir,
    contractVersion: plan.contractVersion,
    generatorContextId,
    scenes: plan.scenes,
    voices: plan.voices,
  });
}
