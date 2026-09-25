// 有料の新しい呼び出しを止める関所（再利用だけの実行）。
//
// 更新をまたいで Job を確定させる実行（run-video-harness resume --finalize-after-update）は、すでに作った
// 有料の成果物を使い回すだけで、新しい有料の呼び出しを1件もしてはならない。子ハーネスは別プロセスで、
// 画・声・音楽・動画の送り口が複数ある（Media Job の broker、画像・動画の生成）ので、判定を呼び出し側へ
// 散らさず、送り口の直前でこの1か所を呼ぶ。
//
// - 環境変数 BUZZASSIST_PAID_CALL_GUARD に台帳ファイル（JSON Lines）の絶対パスがあるときだけ効く。
//   上位の Job 層が子プロセスの環境にだけ入れる（自分のプロセスの環境は変えない）
// - 止めた呼び出しは台帳へ1行ずつ残してから、課金されていない（charged=false）・再送しない例外を投げる。
//   子が例外を握って先へ進んでも、上位は台帳を読んで「新しい有料の呼び出しが要る」と判定できる
// - 台帳には種類・提供元・モデル・requestKey の digest・時刻だけを書く（入力の本文・鍵は書かない）
// - 送り口は「送る前」に呼ぶ。予約の記録を書く前に止めるので、止めた呼び出しの跡は journal に残らない

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

export const PAID_CALL_GUARD_ENV = "BUZZASSIST_PAID_CALL_GUARD";
export const PAID_CALL_GUARD_VERSION = "buzzassist-paid-call-guard-v1";
/** 再利用だけの実行で、新しい有料の呼び出しを止めたときの error.code。 */
export const PAID_CALL_FORBIDDEN_CODE = "paid-call-forbidden-reuse-only";

function text(value, limit = 200) {
  return String(value ?? "").replace(/[\r\n\t]+/gu, " ").trim().slice(0, limit);
}

/** 関所が効いているときの台帳のパス。効いていなければ ""。相対パスは受け取らない（どこを指すか決まらない）。 */
export function paidCallGuardPath(env = process.env) {
  const value = String(env?.[PAID_CALL_GUARD_ENV] ?? "").trim();
  if (!value) return "";
  if (!isAbsolute(value)) {
    throw new Error(`${PAID_CALL_GUARD_ENV} は台帳ファイルの絶対パスにする: ${value}`);
  }
  return value;
}

/**
 * 有料の送り口の直前で呼ぶ。関所が効いていれば台帳に1行残して止める。効いていなければ何もしない。
 * route は送り口の名前（"paid-media-broker" / "image-generation" / "video-generation"）。
 */
export function assertPaidCallAllowed({ route = "", kind = "", provider = "", model = "", requestKey = "" } = {}, { env = process.env, now = () => new Date().toISOString() } = {}) {
  const ledger = paidCallGuardPath(env);
  if (!ledger) return;
  const row = {
    version: PAID_CALL_GUARD_VERSION,
    at: now(),
    route: text(route, 100),
    kind: text(kind, 100),
    provider: text(provider, 200),
    model: text(model, 200),
    requestKeyDigest: requestKey ? createHash("sha256").update(String(requestKey)).digest("hex") : "",
  };
  mkdirSync(dirname(ledger), { recursive: true });
  appendFileSync(ledger, `${JSON.stringify(row)}\n`, "utf8");
  const error = new Error(
    `${PAID_CALL_FORBIDDEN_CODE}: 更新をまたいで確定させる実行では新しい有料の呼び出しをしない`
    + `（${row.route || "paid"} ${row.kind || ""} ${row.provider || ""} ${row.model || ""}`.replace(/\s+/gu, " ").trim()
    + "）。すでに作った成果物の再利用が当たらなかった。新しい Job を作ること。",
  );
  error.code = PAID_CALL_FORBIDDEN_CODE;
  error.charged = false;
  error.retryable = false;
  error.nonRetryable = true;
  throw error;
}

/** 台帳を読む。無ければ空。壊れた行も「止めた呼び出しがあった」ことは消さずに1件として数える。 */
export function readPaidCallGuardLedger(path) {
  let body = "";
  try {
    body = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return body.split(/\r?\n/u).filter((line) => line.trim()).map((line) => {
    try {
      const row = JSON.parse(line);
      return {
        route: text(row?.route, 100),
        kind: text(row?.kind, 100),
        provider: text(row?.provider, 200),
        model: text(row?.model, 200),
        requestKeyDigest: /^[a-f0-9]{64}$/u.test(String(row?.requestKeyDigest || "")) ? row.requestKeyDigest : "",
        at: text(row?.at, 100),
      };
    } catch {
      return { route: "unreadable", kind: "", provider: "", model: "", requestKeyDigest: "", at: "" };
    }
  });
}
