// 記号だけのセリフ（「！」「…」「？」「…ッ！」など）を、言葉にならない短い声として扱うための部品。
//
// 台本のこうした行は無音ではなく、息を呑む・言葉に詰まるといった声で読む。文字が無いので、
// 音声の品質ゲートの読み比べ（CER）や最終の聞き取り照合では中身を確かめられない。
// 読み比べの代わりに「声が出ているか」を測り、提供元へは読める形（「っ！」など）で送る。

// 句読点・記号・空白に加え、促音（ッっ）と長音（ー〜）だけで出来た行を「言葉なし」とみなす。
// 「…ッ！」は促音しか残らないので言葉なし、「う…」「くっ…！」は言葉ありのまま。
const NONVERBAL_FILLER = /[\p{P}\p{S}\p{Z}\sっッｯーｰ〜～]/gu;

export function isNonverbalUtteranceText(text) {
  const source = String(text ?? "").normalize("NFKC");
  if (!source.trim()) return false;
  return source.replace(NONVERBAL_FILLER, "") === "";
}

// 人が読み方（speechDirections の speechText）を書いていない行の既定の読み。提供元は記号だけの
// 文を黙って飛ばすことがあるので、記号の並びを保ったまま促音を足して声にさせる。
export function defaultNonverbalSpeechText(text) {
  const source = String(text ?? "").normalize("NFKC").replace(/\s+/gu, "");
  if (!isNonverbalUtteranceText(source)) return source;
  const hasSmallTsu = /[っッｯ]/u.test(source);
  const body = source.replace(/[っッｯ]/gu, "");
  const leadingEllipsis = /^(?:\.{3}|…)+/u.test(body) ? "…" : "";
  const tail = body.replace(/^(?:\.{3}|…)+/u, "");
  const marks = tail.replace(/[^!?！？]/gu, "").replace(/!/gu, "！").replace(/\?/gu, "？");
  if (!marks) return `${leadingEllipsis || "…"}っ`;
  if (/^？+$/u.test(marks) && !hasSmallTsu) return `${leadingEllipsis}ん${marks}`;
  return `${leadingEllipsis}っ${marks}`;
}

// 言葉なしの行に自動で付ける演技タグ。怒り（[angry]）を付けると息を呑む驚きが怒鳴り声になる。
export function nonverbalPerformanceTag(text) {
  const source = String(text ?? "").normalize("NFKC");
  if (/[!！]/u.test(source)) return "[gasps]";
  if (/[?？]/u.test(source)) return "[curious]";
  return "[sighs]";
}
