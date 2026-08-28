// 課金APIの再送規則（platform craft）
//
// このリポジトリには再送の実装が4つ独立にあり、規則が食い違っていた:
//
//   lovartMediaGeneration  GET は3回、POST は1回
//   mediaGeneration        一律3回
//   buzzassistApi          429 のときだけ段階バックオフ
//   （ジャンル側の TTS）   429/5xx のみ、200後は再送しない
//
// 食い違い自体より、食い違いが見えないことが問題だった。課金APIでは
// 「再送してよいか」の判断を1つ間違えるたびに金が消える。同じ規則が
// 4箇所にあると、直すときに3箇所だけ直る。
//
// ここに集約する規則:
//
//   1. 再送してよいのは 429・5xx・ネットワーク断だけ
//   2. 2xx を受けた後の失敗は再送しない——サーバは仕事を終えている＝課金済み
//   3. 認証エラーや不正リクエストは再送しない。何度投げても結果は同じで課金だけ増える
//   4. 秘密は例外の本文から必ず消す。ログとレポートに残るのは例外の文字列
//   5. バックオフは上限つき指数。上限が無いと、止めたいときに止まらない

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

/**
 * HTTP ステータスだけで再送可否を決める。
 * 本文を読んでから決める形にすると、本文の読み取りが失敗したときに
 * 判定が付かないまま catch へ落ちて、印の無い再送が起きる。
 */
/**
 * 提供側が要求を受理する前に失敗したと言い切れるステータス。
 *
 * 5xx を一律で再送してよいわけではない。504（ゲートウェイタイムアウト）は
 * 上流が**受理して課金した後**にも返る。冪等性キーを提供側まで通せない今の
 * 構成で 504 を再送すると、同じ有償生成が2回走る。
 * 「たぶん大丈夫」で金を賭けない。
 */
export const AMBIGUOUS_STATUSES = Object.freeze([504, 408]);

export function isRetryableStatus(status) {
  const code = Number(status);
  if (!Number.isFinite(code)) return false;
  if (AMBIGUOUS_STATUSES.includes(code)) return false;
  return code === 429 || (code >= 500 && code < 600);
}

/** 課金の有無が分からない失敗。再送せず、人が確かめる。 */
export function ambiguousChargeError(message, { status = null, cause = null } = {}) {
  return new NonRetryablePaidApiError(
    `${message}（提供側が受理して課金した可能性がある。再送すると二重に払うので止める）`,
    { status, cause, charged: null },
  );
}

/**
 * 秘密を文字列から消す。空文字や短すぎる値は無視する——
 * 空文字で replaceAll すると文字列が壊れる。
 */
export function redactSecrets(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    const value = String(secret ?? "");
    if (value.length < 8) continue;
    out = out.split(value).join("[redacted]");
  }
  return out;
}

/** 再送してはいけない失敗であることを明示する例外。 */
export class NonRetryablePaidApiError extends Error {
  constructor(message, { cause = null, status = null, charged = false } = {}) {
    super(message);
    this.name = "NonRetryablePaidApiError";
    this.retryable = false;
    this.status = status;
    // 課金が発生した可能性があるか。呼び出し側が「作り直す」判断をするときに要る。
    this.charged = charged;
    if (cause) this.cause = cause;
  }
}

/** 再送してよい失敗。 */
export class RetryablePaidApiError extends Error {
  constructor(message, { cause = null, status = null } = {}) {
    super(message);
    this.name = "RetryablePaidApiError";
    this.retryable = true;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

/**
 * fetch の Response を、再送可否の付いた例外へ変換する。
 * 本文は上限つきで読み、秘密を消してから載せる。
 */
export async function paidApiResponseError(response, { label = "request", secrets = [], bodyLimit = 240 } = {}) {
  const retryable = isRetryableStatus(response.status);
  const ambiguous = AMBIGUOUS_STATUSES.includes(Number(response.status));
  let body = "(本文を読めませんでした)";
  try {
    body = redactSecrets((await response.text()).slice(0, bodyLimit), secrets);
  } catch {
    // 判定は変えない。ステータスで既に決まっている。
  }
  const message = `${label} が HTTP ${response.status} で失敗: ${body}`;
  if (ambiguous) return ambiguousChargeError(message, { status: response.status });
  return retryable
    ? new RetryablePaidApiError(message, { status: response.status })
    : new NonRetryablePaidApiError(message, { status: response.status });
}

/**
 * 課金APIの1呼び出しを、再送規則つきで実行する。
 *
 * @param attemptFn  1回分の処理。成功なら値を返し、失敗なら投げる。
 *                   投げた例外に retryable が付いていなければ「ネットワーク断」
 *                   とみなして再送する——fetch 自体の例外に印は付かないため。
 */
export async function withPaidApiRetry(attemptFn, {
  label = "paid API",
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  secrets = [],
  onRetry = null,
  sleepFn = sleep,
} = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts は1以上の整数。");
  }
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await attemptFn({ attempt, maxAttempts });
    } catch (error) {
      if (error?.retryable === false) {
        // 秘密が例外に混ざったまま上へ渡さない。
        error.message = redactSecrets(error.message, secrets);
        throw error;
      }
      lastError = error;
    }
    if (attempt < maxAttempts) {
      const backoffMs = Math.min(maxBackoffMs, baseBackoffMs * (2 ** (attempt - 1)));
      if (typeof onRetry === "function") {
        onRetry({ label, attempt, maxAttempts, backoffMs, error: redactSecrets(lastError?.message, secrets) });
      }
      await sleepFn(backoffMs);
    }
  }
  const message = redactSecrets(lastError?.message || `${label} が ${maxAttempts} 回とも失敗`, secrets);
  const failure = new NonRetryablePaidApiError(`${label}: ${maxAttempts}回試行して失敗: ${message}`, {
    cause: lastError,
    status: lastError?.status ?? null,
  });
  throw failure;
}

/**
 * 2xx を受けた後に起きた失敗を包む。
 *
 * ここが再送されると、サーバは既に仕事を終えている（＝課金済み）のに
 * もう一度課金される。転送が切れただけで倍の金が出ていくのを防ぐため、
 * この経路だけは必ず非再送にする。
 */
export function afterSuccessFailure(message, { cause = null, status = 200 } = {}) {
  return new NonRetryablePaidApiError(
    `${message}（再送しません。課金済みの可能性があります）`,
    { cause, status, charged: true },
  );
}
