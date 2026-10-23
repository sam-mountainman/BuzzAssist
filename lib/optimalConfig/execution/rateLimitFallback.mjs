// 利用上限（429）に当たったときの下書き経路への切り替え——本番の経路が空くまで、予備の経路で下書きだけを作る。
//
// 守ること:
//   - 本番の経路（採用した本番の画像）が 429・利用上限を返したら、その間は予備（採用した予備・下書き）の経路で
//     「下書き」だけを作る。下書きには draft: true / finalEligible: false を付ける
//   - 本番として頼まれたものは、下書きを先に返しつつ「本番で作り直す待ち」に積む。本番の経路が空いたら
//     resumePending() で本番の経路で作り直す
//   - 下書きを本番へ黙って昇格させない。assertFinalOutputs が下書き・予備の経路の出力を本番から弾く
//   - 429 以外の失敗は、予備へ逃がさずにそのまま返す（失敗を下書きで隠さない）
// 経路（primary / backup）は { id, generate(request) } の形。テストでは差し替えて通信しない。

export const RATE_LIMIT_FALLBACK_VERSION = "optimal-config-rate-limit-fallback-v1";
export const DRAFT_NOT_FINAL_CODE = "draft-not-final";

const RATE_LIMIT_CODES = new Set(["rate_limit", "rate-limit", "rate_limit_exceeded", "usage_limit", "usage-limit", "usage_limit_reached", "USAGE_LIMIT", "RATE_LIMIT", "429"]);

function codedError(code, message, extra = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/** 429・利用上限の失敗か（HTTP の状態、code、文言のどれかで判定）。 */
export function isRateLimitError(error) {
  if (!error) return false;
  if (Number(error.status) === 429 || Number(error.httpStatus) === 429) return true;
  if (RATE_LIMIT_CODES.has(String(error.code || ""))) return true;
  return /\b429\b|rate[ _-]?limit|usage[ _-]?limit|利用上限/iu.test(String(error.message || ""));
}

function retryAfterMs(error, fallbackMs) {
  const seconds = Number(error?.retryAfterSeconds ?? error?.retryAfter);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallbackMs;
}

/**
 * 本番の経路と予備の経路をまとめる。
 *   generate(request, { purpose: "final" | "draft" })
 *     -> { status: "final", output }                       本番の経路で作った（finalEligible: true）
 *     -> { status: "draft", output }                       下書きとして頼まれ、下書きを作った
 *     -> { status: "draft-while-limited", output, pendingFinal: true, resumeAt }
 *                                                          本番として頼まれたが上限中。下書きを先に返し、本番は待ちに積んだ
 *   resumePending() -> { resumed: [...], stillPending: [...], resumeAt }
 */
export function createRateLimitFallbackRouter({
  primary,
  backup,
  now = () => Date.now(),
  defaultCooldownMs = 15 * 60 * 1000,
} = {}) {
  if (!primary || typeof primary.generate !== "function") throw codedError("fallback-primary-missing", "本番の経路（primary.generate）が要る。");
  if (!backup || typeof backup.generate !== "function") throw codedError("fallback-backup-missing", "予備（下書き）の経路（backup.generate）が要る。採用の記録の予備が無ければ、上限中は待つだけにする。");
  let coolingUntil = 0;
  const pending = new Map();
  const events = [];

  const mark = (output, { route, draft }) => ({
    ...output,
    producedBy: route.id,
    draft,
    finalEligible: !draft && route === primary,
  });

  async function draftFromBackup(request, purpose) {
    const output = await backup.generate({ ...request, purpose: "draft" });
    return mark(output, { route: backup, draft: true });
  }

  async function generate(request = {}, { purpose = "final" } = {}) {
    if (!["final", "draft"].includes(purpose)) throw codedError("fallback-purpose-invalid", "purpose は final か draft。");
    const id = String(request.id || "");
    if (purpose === "final" && !id) throw codedError("fallback-request-id-missing", "本番として頼むときは request.id が要る（上限中に作り直す待ちに積むため）。");
    if (now() < coolingUntil) {
      const output = await draftFromBackup(request, purpose);
      if (purpose === "final") {
        pending.set(id, request);
        return { status: "draft-while-limited", output, pendingFinal: true, resumeAt: new Date(coolingUntil).toISOString() };
      }
      return { status: "draft", output };
    }
    try {
      const output = await primary.generate({ ...request, purpose });
      return { status: purpose === "final" ? "final" : "draft", output: mark(output, { route: primary, draft: purpose === "draft" }) };
    } catch (error) {
      if (!isRateLimitError(error)) throw error;
      coolingUntil = now() + retryAfterMs(error, defaultCooldownMs);
      events.push({ at: new Date(now()).toISOString(), kind: "primary-rate-limited", primary: primary.id, resumeAt: new Date(coolingUntil).toISOString() });
      const output = await draftFromBackup(request, purpose);
      if (purpose === "final") {
        pending.set(id, request);
        return { status: "draft-while-limited", output, pendingFinal: true, resumeAt: new Date(coolingUntil).toISOString() };
      }
      return { status: "draft", output };
    }
  }

  /** 本番の経路が空いたら、待ちに積んだ本番を本番の経路で作り直す。また上限に当たったら残りは待ちのまま。 */
  async function resumePending() {
    const resumed = [];
    if (now() < coolingUntil) {
      return { resumed, stillPending: [...pending.keys()], resumeAt: new Date(coolingUntil).toISOString() };
    }
    for (const [id, request] of [...pending.entries()]) {
      try {
        const output = await primary.generate({ ...request, purpose: "final" });
        resumed.push({ id, output: mark(output, { route: primary, draft: false }) });
        pending.delete(id);
      } catch (error) {
        if (!isRateLimitError(error)) throw error;
        coolingUntil = now() + retryAfterMs(error, defaultCooldownMs);
        events.push({ at: new Date(now()).toISOString(), kind: "primary-rate-limited", primary: primary.id, resumeAt: new Date(coolingUntil).toISOString() });
        break;
      }
    }
    return { resumed, stillPending: [...pending.keys()], resumeAt: coolingUntil > now() ? new Date(coolingUntil).toISOString() : null };
  }

  return {
    version: RATE_LIMIT_FALLBACK_VERSION,
    generate,
    resumePending,
    state: () => ({ coolingUntil: coolingUntil ? new Date(coolingUntil).toISOString() : null, pending: [...pending.keys()], events: [...events] }),
  };
}

/** 本番に使う出力の検査。下書き・予備の経路の出力が混ざっていたら止める（黙って昇格させない）。 */
export function assertFinalOutputs(outputs = []) {
  const drafts = outputs.filter((output) => !output || output.draft !== false || output.finalEligible !== true);
  if (drafts.length > 0) {
    throw codedError(DRAFT_NOT_FINAL_CODE, `本番に下書き（予備の経路・上限中の出力）が ${drafts.length} 件混ざっている。下書きは本番に使わない。本番の経路が空いてから resumePending() で作り直す。`, { draftCount: drafts.length });
  }
  return true;
}
