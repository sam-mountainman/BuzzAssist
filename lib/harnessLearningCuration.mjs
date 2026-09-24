// overlay（references/learned-auto.md）に長く再発していない項目を、退避の**候補として
// 列挙するだけ**の層。
//
// Hermes の curator は「使われた回数」で古いスキルを退避する。こちらの overlay は
// 毎セッションまるごと読まれるので、「読まれた回数」はどの項目でも同じで何も語らない。
// 代わりに2つを見る:
//
//   1. 最後に再発・再捕捉された日（同じ提案IDが別 session で捕捉された最後の時刻）
//   2. その項目に関係するゲートが、直近の RunReceipt に（不合格・skip として）出たか
//
// **ここは候補を出すだけで、何も消さない。退避も既定では行わない。**
// 再発しない理由は2通りあり、機械には見分けられない:
//
//   - もう起きない状況になった（本当に古い）
//   - **その規則が効いているから再発しない**
//
// 後者を機械が退避すると、効いていた規則が次のセッションから消え、同じ失敗が戻る。
// だから退避は reviewer 名つきの人の判断に限り、人の確認（human-verified）が無い退避記録は
// 効力を持たせない。退避した項目は learned-archive.md へ移すだけで削除せず、同じ提案が
// 退避後に再発したら自動で overlay へ戻す。

export const CURATE_DEFAULT_STALE_DAYS = 90;
export const CURATE_DEFAULT_GATE_WINDOW_DAYS = 90;
export const ARCHIVE_RECORD_VERSION = "buzzassist-learning-archive-v1";

const DAY_MS = 24 * 60 * 60 * 1000;

function timeOf(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** ハーネス宣言から、ゲート（保証）id と監査 id の一覧を作る。 */
export function knownGateVocabulary(declarations = []) {
  const ids = new Set();
  for (const declaration of declarations) {
    for (const guarantee of declaration?.guarantees || []) {
      if (guarantee?.id) ids.add(String(guarantee.id));
      for (const auditId of guarantee?.evidenceAuditIds || []) ids.add(String(auditId));
    }
  }
  return ids;
}

/**
 * 提案が関係するゲート。自動捕捉の提案は付帯情報（gateIds）に持っている。人が書いた
 * 提案は本文・根拠にゲート id が語として出ていればそれを使う（推測で広げない）。
 */
export function relatedGateIds(entry = {}, knownGateIds = new Set()) {
  const out = new Set((Array.isArray(entry.gateIds) ? entry.gateIds : []).map(String));
  const evidence = Array.isArray(entry.evidence) ? entry.evidence : [entry.evidence];
  const body = [entry.text, ...evidence].filter(Boolean).join("\n");
  for (const id of knownGateIds) {
    if (id.length < 4) continue;
    if (new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(id)}(?![A-Za-z0-9_-])`, "u").test(body)) out.add(id);
  }
  return [...out].sort();
}

/**
 * 直近で「問題として出た」ゲートと、その最後の時刻。
 *
 * - finalize 済み RunReceipt の不合格・skip（当時の契約に無かった保証は除く）
 * - Receipt から自動捕捉した提案の gateIds（Receipt 本体を集めていない端末でも見えるように）
 *
 * pass は数えない。「規則が効いて通った」は再発ではない。
 */
export function recentGateSightings({ receipts = [], autoRows = [], now, windowDays = CURATE_DEFAULT_GATE_WINDOW_DAYS } = {}) {
  const nowMs = timeOf(now);
  const since = nowMs === null ? null : nowMs - windowDays * DAY_MS;
  const sightings = new Map();
  const note = (gateId, at) => {
    const ms = timeOf(at);
    if (ms === null || (since !== null && ms < since)) return;
    const previous = sightings.get(gateId);
    if (!previous || timeOf(previous) < ms) sightings.set(gateId, new Date(ms).toISOString());
  };
  for (const entry of receipts) {
    const receipt = entry?.receipt ?? entry;
    if (receipt?.finalized !== true) continue;
    for (const [gateId, gate] of Object.entries(receipt.gates || {})) {
      if (gate?.notInForce) continue;
      if (gate?.verdict === "fail" || gate?.verdict === "skip") note(gateId, receipt.finalizedAt);
    }
  }
  for (const row of autoRows) {
    if (row?.createdBy !== "auto-receipt") continue;
    for (const gateId of Array.isArray(row.gateIds) ? row.gateIds : []) note(String(gateId), row.capturedAt);
  }
  return sightings;
}

/**
 * 退避記録のうち効力のあるもの（id → 記録）。
 *
 * - 人の確認（human-verified）が無い記録は効力を持たない（機械が自分で規則を外せない）
 * - 退避した後に同じ提案が再発していたら効力を失う（overlay へ戻る）
 */
export function effectiveArchiveRecords(summary = [], archivedRecords = [], { humanVerified = "human-verified" } = {}) {
  const lastSeenById = new Map(summary.map((entry) => [entry.id, timeOf(entry.lastSeenAt ?? entry.firstSeenAt)]));
  const effective = new Map();
  for (const record of archivedRecords) {
    if (!record?.id || record.attestedBy !== humanVerified) continue;
    const archivedAt = timeOf(record.archivedAt);
    if (archivedAt === null) continue;
    const lastSeen = lastSeenById.get(record.id);
    if (lastSeen !== null && lastSeen !== undefined && lastSeen > archivedAt) continue;
    const previous = effective.get(record.id);
    if (!previous || timeOf(previous.archivedAt) < archivedAt) effective.set(record.id, record);
  }
  return effective;
}

/**
 * 退避候補を列挙する（dry-run。何も書かない）。
 *
 * 対象は auto-guidance の宛先で overlay に載っている項目だけ。反映済み・blocked・
 * 既に退避済みのものは見ない。
 */
export function curateOverlayCandidates({
  summary = [],
  targets = {},
  receipts = [],
  autoRows = [],
  archivedRecords = [],
  knownGateIds = new Set(),
  now,
  staleDays = CURATE_DEFAULT_STALE_DAYS,
  gateWindowDays = CURATE_DEFAULT_GATE_WINDOW_DAYS,
  isBlocked = () => false,
} = {}) {
  const nowMs = timeOf(now);
  if (nowMs === null) throw new Error("curate には現在時刻が要る。");
  if (!Number.isFinite(staleDays) || staleDays < 1) throw new Error("--stale-days は 1 以上にしてください。");
  if (!Number.isFinite(gateWindowDays) || gateWindowDays < 1) throw new Error("--gate-window-days は 1 以上にしてください。");
  const sightings = recentGateSightings({ receipts, autoRows, now, windowDays: gateWindowDays });
  const archived = effectiveArchiveRecords(summary, archivedRecords);
  const candidates = [];
  const kept = { recent: 0, gateSeen: 0 };
  let considered = 0;
  for (const entry of summary) {
    const def = targets[entry.target];
    if (entry.applied || !def || def.mode === "review-only" || !def.overlay) continue;
    if (archived.has(entry.id) || isBlocked(entry)) continue;
    considered += 1;
    const lastSeen = entry.lastSeenAt ?? entry.firstSeenAt ?? null;
    const lastSeenMs = timeOf(lastSeen);
    const idleDays = lastSeenMs === null ? null : Math.floor((nowMs - lastSeenMs) / DAY_MS);
    if (idleDays !== null && idleDays < staleDays) { kept.recent += 1; continue; }
    const gates = relatedGateIds(entry, knownGateIds);
    const seen = gates.filter((gateId) => sightings.has(gateId));
    if (seen.length > 0) { kept.gateSeen += 1; continue; }
    candidates.push({
      id: entry.id,
      target: entry.target,
      overlay: def.overlay,
      lastSeenAt: lastSeen,
      idleDays,
      occurrences: entry.occurrences ?? 1,
      relatedGates: gates,
      reason: gates.length > 0
        ? `最後の再発から ${idleDays ?? "不明"} 日。関連ゲート（${gates.join(", ")}）は直近 ${gateWindowDays} 日の Receipt で不合格・skip に出ていない`
        : `最後の再発から ${idleDays ?? "不明"} 日。関連ゲートを本文から特定できない（ゲートでは判断できない）`,
    });
  }
  candidates.sort((left, right) => (right.idleDays ?? 0) - (left.idleDays ?? 0) || left.id.localeCompare(right.id));
  return { candidates, considered, kept, archivedCount: archived.size, staleDays, gateWindowDays };
}

/** learned-auto.md と同じディレクトリに置く退避ファイルの相対パス。 */
export function archivePathForOverlay(overlay) {
  return String(overlay).replace(/learned-auto\.md$/u, "learned-archive.md");
}
