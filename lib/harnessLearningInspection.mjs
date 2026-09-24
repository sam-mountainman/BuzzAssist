// 学習台帳へ書く前・overlay へ載せる前に、文字列そのものの危なさを見る層。
//
// 既存の検査（検査語彙の HMAC digest 照合、Channel Pack 語の照合）は「公開して
// はいけない**語**」を見る。ここが見るのは語彙に依らない**形**——
//
//   - プロンプト注入らしい言い回し（「以前の指示を無視」系、役割タグ）
//   - 隠し HTML コメント（Markdown 表示で見えなくなる）
//   - 不可視の Unicode（ゼロ幅文字・双方向制御文字・タグ文字）
//   - 資格情報らしい文字列（sk-、Bearer、JWT、PEM 秘密鍵）
//   - 端末の絶対パス
//
// overlay は次のセッションが**指示として読む**。捕捉した文字列に注入文や見えない
// 文字が混ざったまま載ると、人が読んだ文面と機械が読む文面が一致しなくなる。
// 語彙照合とは材料も失敗の仕方も違うので、同じ関数に混ぜず別の層として置く。
//
// 検出しても**消さない**。台帳には blocked として残し、理由を status に出す。
// 黙って捨てると、指摘が有ったこと自体が失われ、何を書き直すべきかも分からない。

import { createHash } from "node:crypto";
import { homedir } from "node:os";

export const LEARNING_INSPECTION_VERSION = "buzzassist-learning-inspection-v1";

/** 検出理由のコードと、status に出す説明。 */
export const LEARNING_BLOCK_REASONS = Object.freeze({
  "prompt-injection": "プロンプト注入らしい言い回し（以前の指示を無視せよ、役割タグなど）",
  "hidden-html-comment": "隠し HTML コメント（<!-- -->。表示では見えない）",
  "invisible-unicode": "不可視の Unicode（ゼロ幅文字・双方向制御文字・タグ文字）",
  "credential-like": "資格情報らしい文字列（sk-、Bearer、JWT、PEM 秘密鍵など）",
  "absolute-path": "端末の絶対パス",
});

// 注入の言い回しは、誤検知で正当な提案を止める代償（人が status で確認して書き直す）が、
// 見逃して overlay に載る代償（次のセッションが指示として読む）より小さいので、やや広めに取る。
const INJECTION_PATTERNS = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+)*(?:previous|prior|above|earlier|preceding|system|original)\s+(?:instructions?|prompts?|rules|directions|messages|context)\b/iu,
  /\b(?:new|updated)\s+system\s+(?:prompt|instructions?)\s*:/iu,
  /(?:以前|前|これまで|今まで|上記|上の|先ほど|さっき|直前|元|最初)の(?:全ての|すべての)?(?:指示|命令|ルール|規則|プロンプト|設定|制約)(?:は|を|も)?(?:全て|すべて)?(?:無視|忘れ|破棄|上書き|取り消)/u,
  /(?:システム|system)\s*(?:プロンプト|prompt)\s*(?:を|は)?\s*(?:無視|上書き|書き換え|忘れ)/iu,
  /<\/?\s*(?:system|assistant|instructions?|developer)\s*>/iu,
];

const HIDDEN_HTML_COMMENT = /<!--/u;

// ゼロ幅・結合制御・双方向制御・不可視演算子・BOM・タグ文字・ハングルの空白字。
// 絵文字の異体字セレクタ（U+FE0F 等）は日常の文面に出るので入れない。
const INVISIBLE_CHARACTER = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFEFF\uFFA0]|[\u{E0000}-\u{E007F}]/u;
const INVISIBLE_CHARACTER_GLOBAL = new RegExp(INVISIBLE_CHARACTER.source, "gu");

const CREDENTIAL_PATTERNS = [
  /\bsk-(?:[A-Za-z]+-)?[A-Za-z0-9_-]{16,}/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/iu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/u,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/u,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/u,
  /\bAKIA[A-Z0-9]{16}\b/u,
];

// 端末を特定できる絶対パスだけを見る。`~/.buzzassist/...` のような
// ホーム相対や、`/v1/feedback` のような URL の path は規則の本文に正当に出るので
// 止めない（redaction 用の MACHINE_PATH_PATTERNS より狭いのはそのため）。
const ABSOLUTE_PATH_PATTERNS = [
  /(?:^|[^A-Za-z0-9._~/-])\/(?:Users|home|root)\/[^\s"'`)\]}>]+/u,
  /(?:^|[^A-Za-z0-9._~/-])\/(?:private\/(?:tmp|var)|var\/folders|Volumes)\/[^\s"'`)\]}>]+/u,
  /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/][^\s"'`)\]}>]{2,}/u,
  /(?:^|[\s("'`])\\\\[^\\\s]+\\[^\s"'`)\]}>]+/u,
  /\bfile:\/\/\/?[^\s"'`)\]}>]+/iu,
  // Claude Code のプロジェクト識別子（端末の path を - で繋いだ形）
  /(?<![A-Za-z0-9])-Users-[A-Za-z0-9._-]+/u,
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function homePattern(homeRoot) {
  const home = String(homeRoot || "").trim();
  // "/" や "C:\" のような短すぎる値で全文に当たらないよう、長さで足切りする。
  if (home.length < 5) return null;
  return new RegExp(escapeRegExp(home), "u");
}

/**
 * 1つの文字列を検査し、検出したコードを返す（順序は LEARNING_BLOCK_REASONS 順）。
 * 検出した文字列そのものは返さない——エラーやログに秘密を写さないため。
 */
export function inspectLearningText(value, { homeRoot = homedir() } = {}) {
  const text = String(value ?? "");
  if (!text) return [];
  const found = new Set();
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(text))) found.add("prompt-injection");
  if (HIDDEN_HTML_COMMENT.test(text)) found.add("hidden-html-comment");
  if (INVISIBLE_CHARACTER.test(text)) found.add("invisible-unicode");
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) found.add("credential-like");
  const home = homePattern(homeRoot);
  if (ABSOLUTE_PATH_PATTERNS.some((pattern) => pattern.test(text)) || (home && home.test(text))) {
    found.add("absolute-path");
  }
  return Object.keys(LEARNING_BLOCK_REASONS).filter((code) => found.has(code));
}

/**
 * 提案（text と evidence）を検査する。evidence は配列でも文字列でもよい
 * （summarizeProposals は evidence を配列へ束ねる）。
 */
export function inspectLearningProposal(entry = {}, options = {}) {
  const evidence = Array.isArray(entry?.evidence) ? entry.evidence : [entry?.evidence];
  const reasons = new Set([
    ...inspectLearningText(entry?.text, options),
    ...evidence.flatMap((value) => inspectLearningText(value, options)),
  ]);
  return Object.keys(LEARNING_BLOCK_REASONS).filter((code) => reasons.has(code));
}

/**
 * blocked として台帳へ残す前に、**台帳に置いてはいけない部分だけ**を無害化する。
 *
 * 共有台帳は公開リポジトリで追跡されるので、資格情報と端末パスを逐語で残せない。
 * 不可視文字は `<U+200B>` の形で見えるようにする（人が status で気づけるように）。
 * 注入の言い回しと HTML コメントはそのまま残す——台帳（JSONL）では無害で、
 * blocked なので overlay へは載らず、何が書かれていたかを人が判断できる。
 */
export function neutralizeLearningText(value, { homeRoot = homedir() } = {}) {
  let text = String(value ?? "");
  for (const pattern of CREDENTIAL_PATTERNS) {
    text = text.replace(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`), "<credential>");
  }
  const home = homePattern(homeRoot);
  if (home) text = text.replace(new RegExp(home.source, "gu"), "<machine-path>");
  for (const pattern of ABSOLUTE_PATH_PATTERNS) {
    // 先頭の区切り文字（空白や括弧）は残し、パスの部分だけを置き換える。
    text = text.replace(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`), (match) => {
      const lead = match.match(/^[^A-Za-z0-9\\/~-]?/u)?.[0] ?? "";
      const body = match.slice(lead.length);
      return /^(?:[\\/]|[A-Za-z]:|file:|-Users-)/iu.test(body) ? `${lead}<machine-path>` : "<machine-path>";
    });
  }
  text = text.replace(INVISIBLE_CHARACTER_GLOBAL, (character) => {
    const hex = character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
    return `<U+${hex}>`;
  });
  return text;
}

/** blocked 記録に残す元文字列の指紋（逐語は残さない）。 */
export function blockedOriginalDigest(entry = {}) {
  return createHash("sha256")
    .update([String(entry?.text ?? ""), String(entry?.evidence ?? "")].join("\u001f"), "utf8")
    .digest("hex");
}

/** 台帳の行に付いた blocked 印と、読むときの再検査を合わせた理由の一覧。 */
export function learningBlockReasons(entry = {}, options = {}) {
  const recorded = Array.isArray(entry?.blocked?.reasons) ? entry.blocked.reasons.map(String) : [];
  const fresh = inspectLearningProposal(entry, options);
  const all = new Set([...recorded, ...fresh]);
  const known = Object.keys(LEARNING_BLOCK_REASONS).filter((code) => all.has(code));
  const unknown = [...all].filter((code) => !Object.hasOwn(LEARNING_BLOCK_REASONS, code)).sort();
  return [...known, ...unknown];
}

export function describeLearningBlockReasons(reasons = []) {
  return reasons.map((code) => LEARNING_BLOCK_REASONS[code] ?? code).join(" / ");
}
