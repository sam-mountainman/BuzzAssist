import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import crypto from "node:crypto";
import {
  buzzAssistFetch,
  resolveSubtitleCreditsUrl,
  resolveSubtitleGenerateUrl,
  uploadBufferToFalStorage,
} from "./buzzassistApi.mjs";

// Standalone Node ESM port of BuzzAssist's cloud subtitle generation client.
// Rule-based Japanese-aware segmentation and SRT rendering ported from
// custom/excalidraw-extension/src/extension.ts (Codex/LLM semantic path skipped).

export const SUBTITLE_MODELS = ["elevenlabs-scribe-v2", "elevenlabs-forced-alignment"];

// Vercel rejects multipart bodies well under 15MB (a ~9MB direct upload of an
// 18-minute podcast came back 413), so direct uploads stay under ~3.5MB.
const SUBTITLE_CLOUD_DIRECT_AUDIO_MAX_BYTES = 3.5 * 1024 * 1024;
const SUBTITLE_GENERATE_TIMEOUT_MS = 30 * 60 * 1000;
const SUBTITLE_DIRECT_CHUNK_KEEP_SECONDS = 5 * 60;
const SUBTITLE_DIRECT_CHUNK_OVERLAP_SECONDS = 2;

// BuzzAssist UI defaults (preview-src/App.tsx).
export const DEFAULT_SUBTITLE_LINE_COUNT = 2;
export const DEFAULT_SUBTITLE_MAX_CHARS_ONE_LINE = 20;
export const DEFAULT_SUBTITLE_MAX_CHARS_TWO_LINES = 30;
export const DEFAULT_SUBTITLE_HOLD_SECONDS = 0;

// Broadcast-style cue timing: show each cue slightly BEFORE the speech starts
// (humans perceive an early subtitle as "in sync"), never flash a cue shorter
// than the readable floor, and keep a 2-frame-ish gap between adjacent cues.
const SUBTITLE_PRE_ROLL_SECONDS = 0.1;
const SUBTITLE_MIN_CUE_SECONDS = 0.7;
const SUBTITLE_MIN_CUE_GAP_SECONDS = 0.08;

// Reading-speed ceiling used by validateSubtitleLines (chars per second).
// Japanese broadcast subtitles target ~4 chars/s; fast YouTube telop tolerates
// ~8-10, so only flag cues clearly beyond that.
const SUBTITLE_MAX_CHARS_PER_SECOND = 10.5;

// Optional morphological tokenizer (kuromoji). When available, caption units
// become bunsetsu (自立語 + trailing 付属語) so line breaks can only land on
// natural Japanese phrase boundaries; without it we fall back to
// Intl.Segmenter words plus the heuristic rules below.
const requireModule = createRequire(import.meta.url);
let kuromojiTokenizer = null;
let kuromojiInitPromise = null;

export function ensureJapaneseTokenizer() {
  if (kuromojiTokenizer) return Promise.resolve(kuromojiTokenizer);
  if (!kuromojiInitPromise) {
    kuromojiInitPromise = new Promise((resolve) => {
      try {
        const kuromoji = requireModule("kuromoji");
        const dicPath = join(dirname(requireModule.resolve("kuromoji/package.json")), "dict");
        kuromoji.builder({ dicPath }).build((error, tokenizer) => {
          if (!error && tokenizer) kuromojiTokenizer = tokenizer;
          resolve(kuromojiTokenizer);
        });
      } catch {
        resolve(null);
      }
    });
  }
  return kuromojiInitPromise;
}

function isBunsetsuAttachToken(token) {
  const pos = String(token.pos || "");
  const detail = String(token.pos_detail_1 || "");
  if (pos === "助詞" || pos === "助動詞") return true;
  if (detail === "接尾" || detail === "非自立") return true;
  if (pos === "記号" && detail !== "括弧開" && detail !== "空白") return true;
  return false;
}

function segmentJapaneseTextIntoUnits(safe) {
  if (kuromojiTokenizer) {
    try {
      const chunks = [];
      for (const token of kuromojiTokenizer.tokenize(safe)) {
        const surface = String(token.surface_form || "");
        if (!surface.trim()) continue;
        if (chunks.length > 0 && isBunsetsuAttachToken(token)) {
          chunks[chunks.length - 1] += surface;
        } else {
          chunks.push(surface);
        }
      }
      if (chunks.length > 0) return chunks;
    } catch {
      // fall through to Intl.Segmenter
    }
  }
  return segmentTextWithIntl(safe);
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function nonEmptyString(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || "";
}

// ---------------------------------------------------------------------------
// Option normalizers (extension.ts ~7178-7204)
// ---------------------------------------------------------------------------

export function normalizeSubtitleLineCount(value) {
  return Number(value) === 1 ? 1 : 2;
}

export function normalizeSubtitleMaxChars(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(3, Math.min(40, Math.round(n))) : DEFAULT_SUBTITLE_MAX_CHARS_TWO_LINES;
}

export function defaultSubtitleMaxCharsForLineCount(lineCount) {
  return lineCount === 1 ? DEFAULT_SUBTITLE_MAX_CHARS_ONE_LINE : DEFAULT_SUBTITLE_MAX_CHARS_TWO_LINES;
}

export function normalizeSubtitleHoldSeconds(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(3, Math.round(n * 100) / 100)) : 0;
}

export function normalizeSubtitlePunctuationMode(value) {
  return value === "none" ? "none" : "auto";
}

// 'contextual' relied on the Codex LLM segmenter; here it falls back to 'safe'.
export function normalizeSubtitleFillerMode(value) {
  if (value === "keep") return "keep";
  return "safe";
}

function normalizeSubtitleModel(value, mode) {
  const raw = nonEmptyString(value).toLowerCase();
  if (SUBTITLE_MODELS.includes(raw)) return raw;
  return mode === "scripted" ? "elevenlabs-forced-alignment" : "elevenlabs-scribe-v2";
}

function normalizeDurationSeconds(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

// ---------------------------------------------------------------------------
// Text normalization (extension.ts ~7374-7999)
// ---------------------------------------------------------------------------

function toHalfWidthDigits(text) {
  return text.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

function normalizeCaptionText(value) {
  return value
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

const JAPANESE_NUMERAL_DIGITS = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  壱: 1,
  弐: 2,
  参: 3,
};

function parseJapaneseIntegerNumeral(value) {
  if (!value || !/^[零〇一二三四五六七八九十百千万壱弐参]+$/.test(value)) {
    return undefined;
  }
  if (/^[零〇一二三四五六七八九壱弐参]+$/.test(value)) {
    const digits = Array.from(value).map((char) => JAPANESE_NUMERAL_DIGITS[char]);
    return digits.every((digit) => typeof digit === "number") ? Number(digits.join("")) : undefined;
  }
  let total = 0;
  let section = 0;
  let current;
  for (const char of Array.from(value)) {
    const digit = JAPANESE_NUMERAL_DIGITS[char];
    if (typeof digit === "number") {
      current = digit;
      continue;
    }
    if (char === "十" || char === "百" || char === "千") {
      const unit = char === "十" ? 10 : char === "百" ? 100 : 1000;
      section += (current ?? 1) * unit;
      current = undefined;
      continue;
    }
    if (char === "万") {
      total += ((section || 0) + (current ?? 0) || 1) * 10000;
      section = 0;
      current = undefined;
      continue;
    }
    return undefined;
  }
  return total + section + (current ?? 0);
}

function formatJapaneseIntegerNumeral(value) {
  const parsed = parseJapaneseIntegerNumeral(value);
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    return value;
  }
  if (value.includes("万") && parsed >= 10000 && parsed % 10000 === 0) {
    return `${parsed / 10000}万`;
  }
  return String(parsed);
}

function normalizeJapaneseNumericDisplay(value) {
  return value
    .replace(/([一二三四五六七八九])10(?=分)/g, (_match, tenText) => {
      const tens = parseJapaneseIntegerNumeral(tenText);
      return typeof tens === "number" ? String(tens * 10) : _match;
    })
    .replace(/([一二三四五六七八九])([一二三四五六七八九])(?=社ぐらい|社くらい)/g, (_match, first, second) => {
      return `${formatJapaneseIntegerNumeral(first)}、${formatJapaneseIntegerNumeral(second)}`;
    })
    .replace(/([零〇一二三四五六七八九十百千壱弐参]+)万(?=(?:再生|円|人|名|回|本|個)?)/g, (_match, numberText) => {
      return `${formatJapaneseIntegerNumeral(numberText)}万`;
    })
    .replace(/第([零〇一二三四五六七八九十百千壱弐参][零〇一二三四五六七八九十百千万壱弐参]*)(?=(?:弾|話|回|章|部|項|節|投稿|人者))/g, (_match, numberText) => {
      return `第${formatJapaneseIntegerNumeral(numberText)}`;
    })
    .replace(/([零〇一二三四五六七八九十百千壱弐参][零〇一二三四五六七八九十百千万壱弐参]*)(?=の(?:裏技|理由|方法|ポイント|コツ|話|時代|時点|場合|ところ|テーマ|戦略|きっかけ|投稿|動画|音声|字幕))/g, (_match, numberText) => {
      return formatJapaneseIntegerNumeral(numberText);
    })
    .replace(/([零〇一二三四五六七八九十百千壱弐参][零〇一二三四五六七八九十百千万壱弐参]*)(?=(?:年|年前|ヶ月|か月|カ月|月|日|時間|分|秒|人|名|社|本|個|回|投稿|投稿目|再生|パーセント|パー|%|弾|話|章|部|項|節|つ|円|万円|万再生|歳|才))/g, (_match, numberText) => {
      return formatJapaneseIntegerNumeral(numberText);
    })
    .replace(/([0-9]+)年([0-9]+)年前/g, "$1、$2年前")
    .replace(/([0-9]+)年([0-9]+)年/g, "$1、$2年");
}

const SUBTITLE_TRANSCRIPT_CORRECTION_RULES = [
  [/ポッドキャスた/g, "ポッドキャスト"],
  [/ポッドキャストゃ/g, "ポッドキャストじゃ"],
  [/YOUTUBEッドキャスト/g, "YouTubeポッドキャスト"],
  [/Youtubeッドキャスト/g, "YouTubeポッドキャスト"],
  [/ポッドキャストApple/g, "ポッドキャスト、Apple"],
  [/ポッドキャストーストーSPOTIFY/g, "Podcast、Spotify"],
  [/SPOTIFY/g, "Spotify"],
  [/APPLE/g, "Apple"],
  [/ブルーオーャン/g, "ブルーオーシャン"],
  [/セッィング/g, "セッティング"],
  [/相性がい(?=の|と|か|う|で|、|。|？|$)/g, "相性がいい"],
  [/相性い(?=と思|と|の|か|で|、|。|？|$)/g, "相性がいい"],
  [/さんとう(?=方)/g, "さんという"],
  [/とうこと/g, "ということ"],
  [/(?<!こ)こ数年/g, "この数年"],
  [/まあこがね/g, "まあここがね"],
  [/まあこまで/g, "まあここまで"],
  [/のおー本/g, "の本"],
  [/聞いいた/g, "聞いた"],
  [/プレイー(?=として)/g, "プレイヤー"],
  [/いいってますね/g, "いってますね"],
  [/はいえなんで/g, "はい、なんで"],
  [/はいえー/g, "はい、えー"],
  [/今開けたっかり/g, "今開けたばっかり"],
  [/ことがった/g, "ことがあった"],
  [/声とかけら/g, "声かけら"],
  [/二間とか/g, "2時間とか"],
  [/方がい(?=と思|と|です|、|。|？|$)/g, "方がいい"],
  [/どうしたらいのか/g, "どうしたらいいのか"],
  [/アクセスしにくから/g, "アクセスしに行くから"],
  [/とむうーフォローフォロワーゼロ/g, "と、もうフォロワーゼロ"],
  [/とむうー(?=フォロワーゼロ)/g, "と、もう"],
  [/フォローフォロワー/g, "フォロワー"],
  [/せてえー(?=ショート動画)/g, "せて、"],
  [/方とー話/g, "方と話"],
  [/とかこー/g, "とか、こう"],
  [/なーご要望/g, "なご要望"],
  [/ハックティップス/g, "ハック・Tips"],
  [/野村(?:孝史|貴史|高史)さん/g, "野村高文さん"],
  [/していますしこに/g, "していますし、ここに"],
  [/完全に劣等者なわけ/g, "完全にレッドオーシャンなわけ"],
  [/ってう(?=の|感じ)/g, "っていう"],
  [/といううに/g, "というふうに"],
  [/といううー(?=Brain|スクール)/g, "という"],
  [/すごくい(?=という|と|です|、|。|？|$)/g, "すごくいい"],
  [/話すとこ数(?=(?:ヶ|か|カ)?月|年|日|週間)/g, "話すと、ここ数"],
  [/ここ数((?:ヶ|か|カ)?月|年|日|週間)えー/g, "ここ数$1、"],
  [/ポッドキャストポッドキャストの/g, "ポッドキャストの"],
  [/つけいる/g, "付け入る"],
  [/大きいのであこれは/g, "大きいので、これは"],
  [/取材されていてでそこで/g, "取材されていて、そこで"],
  [/流行ってで/g, "流行って、"],
  [/やってきてで/g, "やってきて、"],
  [/きてで(?=えー|最近|もう|、|。)/g, "きて、"],
  [/ここのおー/g, "この"],
  [/ここにディレクター/g, "ここにはディレクター"],
  [/せんしえー/g, "せんし、えー"],
  [/ねま$/g, "ね、まあ"],
  [/試し撮りしよ試し/g, "試し撮りしよう、試し"],
  [/試し撮りしよ試撮り/g, "試し撮りしよう、試し撮り"],
  [/試撮り/g, "試し撮り"],
  [/得意んで/g, "得意なんで"],
  [/言えるんでは/g, "言えるのでは"],
  [/というこ形/g, "という形"],
];

function normalizeJapaneseTranscriptCorrections(value) {
  return SUBTITLE_TRANSCRIPT_CORRECTION_RULES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function normalizeSubtitleDisplayText(value) {
  return normalizeJapaneseTranscriptCorrections(normalizeJapaneseNumericDisplay(toHalfWidthDigits(normalizeCaptionText(value))))
    .replace(/YouTubeポッドキャスト/g, "YouTube Podcast")
    .replace(/ポッドキャスト/g, "Podcast")
    .replace(/(?:YOUTUBE|Youtube|YouTube)\s*Podcast\s*Apple/g, "YouTube Podcast、Apple")
    .replace(/(?:YOUTUBE|Youtube|YouTube)\s*Podcast/g, "YouTube Podcast")
    .replace(/Apple\s*Podcast/g, "Apple Podcast")
    .replace(/Podcast(?:えー)?ストーSpotify/g, "Podcast、Spotify")
    .replace(/Podcast\s*Apple/g, "Podcast、Apple")
    .replace(/ポッ+Podcast/g, "Podcast")
    .replace(/^ー+(?=[ぁ-んァ-ヴー一-龯A-Za-z0-9])/g, "")
    .replace(/((?:だったりとか|とか|なのでね|なので|ですので|ですけども|けども|けど|から|ので|では|には|とは|のは|と|で|は|が|を|に|の|も|ね|よ|な|か))ー(?=[ァ-ヴA-Za-z0-9])/g, "$1");
}

function normalizeSubtitleScriptSourceText(value) {
  const withoutFrontmatter = value
    .replace(/^\uFEFF/, "")
    .replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "")
    .replace(/```[\s\S]*?```/g, "\n");
  return withoutFrontmatter
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s+/.test(line))
    .filter((line) => !/^(?:-{3,}|\*{3,}|_{3,})$/.test(line))
    .map((line) => line
      .replace(/^>\s*/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/^\[[ xX]\]\s+/, "")
      .replace(/^(?:ナレーション|ナレーター|語り|朗読|Narration|Narrator|Speaker\s*\d+|話者\s*\d+|SE|SFX|BGM)\s*[:：]\s*/i, "")
      .trim())
    .filter(Boolean)
    .join("\n");
}

function normalizeCaptionComparableText(text) {
  return normalizeCaptionText(text).replace(/[ \t\n、。，．。！？!?「」『』（）()[\]【】・･…‥ー―—]/g, "");
}

// ---------------------------------------------------------------------------
// Filler-word handling (extension.ts ~7426-7485)
// ---------------------------------------------------------------------------

const SUBTITLE_PROTECTED_FILLER_TERMS = ["こう", "ちょっと", "ね", "はい", "うん"];
const SUBTITLE_SAFE_FILLER_EXACT_TERMS = new Set([
  "えーっと",
  "えっと",
  "ええと",
  "えーと",
  "えー",
  "えぇ",
  "えっ",
  "あのー",
  "あのーー",
  "そのー",
  "そのーー",
  "まー",
  "まあー",
]);

function normalizeSubtitleFillerComparableText(text) {
  return normalizeSubtitleDisplayText(text)
    .replace(/[ \t\n、。，．。！？!?「」『』（）()[\]【】・･…‥]/g, "")
    .trim();
}

export function shouldRemoveSafeSubtitleFillerText(text, mode) {
  const normalized = normalizeSubtitleFillerComparableText(text);
  if (!normalized || SUBTITLE_PROTECTED_FILLER_TERMS.includes(normalized)) {
    return false;
  }
  if (SUBTITLE_SAFE_FILLER_EXACT_TERMS.has(normalized)) {
    return true;
  }
  if (/^(?:えー+|えぇ+|えっ+|えー?と+|えー?っと+)$/.test(normalized)) {
    return true;
  }
  if (/^(?:あの|その|ま)[ーｰ]+$/.test(normalized)) {
    return true;
  }
  if (mode === "contextual" && /^(?:あの|その|まあ)$/.test(normalized)) {
    return true;
  }
  return false;
}

export function removeSafeSubtitleFillersFromText(text, mode) {
  let next = text;
  next = next.replace(/(?:えーっと|えっと|ええと|えーと|えー+|えぇ+|えっ+)(?:[、。，．,.!?！？\s]*)/g, "");
  next = next.replace(/(?:あの|その|ま)[ーｰ]+(?:[、。，．,.!?！？\s]*)/g, "");
  if (mode === "contextual") {
    next = next.replace(/(^|[、。，．,.!?！？\s])(?:あの|その|まあ)(?=([、。，．,.!?！？\s]|$))/g, "$1");
  }
  return normalizeCaptionText(next);
}

export function filterSubtitleTimedWordsByFillerMode(words, fillerMode) {
  if (!fillerMode || fillerMode === "keep") {
    return words;
  }
  return words.filter((word) => !shouldRemoveSafeSubtitleFillerText(getCaptionWordText(word), fillerMode));
}

// ---------------------------------------------------------------------------
// Japanese caption unit segmentation / line-break scoring (extension.ts ~8005-8504)
// ---------------------------------------------------------------------------

const JAPANESE_ATTACH_TO_PREVIOUS = new Set([
  "の", "が", "を", "に", "へ", "で", "と", "も", "は", "や", "か", "ね", "よ", "な", "ぞ", "ぜ",
  "から", "まで", "より", "だけ", "しか", "ほど", "こそ", "でも", "って", "とは", "には", "では",
  "たち", "ら", "的", "性", "化", "分", "中", "中に", "ごと",
  "だ", "です", "ます", "た", "っ", "て", "で", "し", "いる", "ある", "ない", "れる", "られる",
  "せる", "させる", "う", "よう", "たい", "べき", "そう", "らしい", "だった", "でした", "ました",
  "なら", "ので", "けど", "けれど", "ながら", "たり", "たら",
]);

function isJapaneseClosingPunctuation(text) {
  return /^[、。，．。！？!?）」』】］〕〉》〙〗）\]]+$/.test(text);
}

function isJapaneseCaptionPunctuationOnly(text) {
  return /^[、。，．。！？!?]+$/.test(text.trim());
}

function isJapaneseOpeningPunctuation(text) {
  return /^[（(「『【［〔〈《〘〖]+$/.test(text);
}

function isJapaneseDashText(text) {
  return /^[―—]+$/.test(text);
}

function isSmallKanaOrLongMark(text) {
  return /^[ぁぃぅぇぉゃゅょゎァィゥェォャュョヮっッー]+$/.test(text);
}

function isKanjiText(text) {
  return /^[々〇〆一-龯]+$/.test(text);
}

function isKatakanaText(text) {
  return /^[ァ-ヴー]+$/.test(text);
}

function shouldKeepKatakanaCaptionBoundaryTogether(previous, current) {
  if (!previous || !current) {
    return false;
  }
  if (/[、。，．。！？!?]$/.test(previous)) {
    return false;
  }
  const previousTail = previous.match(/[ァ-ヴー]+$/)?.[0] || "";
  const currentHead = current.match(/^[ァ-ヴー]+/)?.[0] || "";
  if (!previousTail || !currentHead) {
    return false;
  }
  return previousTail.length + currentHead.length <= 14;
}

function shouldAttachKatakanaCaptionUnit(previous, current) {
  return isKatakanaText(current) && shouldKeepKatakanaCaptionBoundaryTogether(previous, current);
}

function startsWithJapaneseHonorific(text) {
  return /^(?:さん|氏|様|ちゃん|くん)(?:[、。，．。！？!?]|$|[ぁ-んァ-ヴー一-龯A-Za-z0-9])/.test(text);
}

function startsWithJapaneseInflectionFragment(text) {
  return /^(?:いた|いて|いてる|いている|いており|いたり|いく|いき|いこう|いかない|います|いました|う|え|える|えた|か|き|きた|きており|きました|きます|く|け|げ|けられ|した|して|してる|している|しく|すぎ|すぎて|せて|せた|せん|せんし|た|たい|たり|っ|った|って|つ|て|で|ない|なって|まった|ます|ました|みる|おく|しまう|ほしい|くれる|あげる|もらう|やる|られる|れる|る|れば)(?:[ぁ-んァ-ヴー一-龯A-Za-z0-9、。，．。！？!?]|$)/.test(text);
}

function shouldKeepJapaneseWordBoundaryTogether(previous, current) {
  if (!previous || !current || /[、。，．。！？!?]$/.test(previous)) {
    return false;
  }
  if (/[一-龯々ァ-ヴA-Za-z]$/.test(previous) && startsWithJapaneseHonorific(current)) {
    return true;
  }
  if (/[一-龯々]$/.test(previous) && startsWithJapaneseInflectionFragment(current)) {
    return true;
  }
  if (/(?:し|しま|なっ|やっ|思っ|言っ|取っ|作っ|入っ|流行っ|上がっ|盛り|増え|減り|伸び|いま|話さ|いただ)$/.test(previous) && startsWithJapaneseInflectionFragment(current)) {
    return true;
  }
  return false;
}

function shouldKeepJapaneseCompoundBoundaryTogether(previous, current) {
  const prev = previous.replace(/[、。，．。！？!?]+$/g, "");
  const next = current.replace(/^[、。，．。！？!?]+/g, "");
  return (/(?:ショート)$/.test(prev) && /^動画/.test(next))
    || (/(?:長尺|ライト|文字)$/.test(prev) && /^コンテンツ/.test(next))
    || (/(?:ファン)$/.test(prev) && /^化/.test(next))
    || (/(?:勝ち)$/.test(prev) && /^筋/.test(next))
    || (/(?:盛り)$/.test(prev) && /^上が/.test(next))
    || (/(?:ブルー)$/.test(prev) && /^オー(?:シャン|ャン)/.test(next))
    || (/(?:ビデオ)$/.test(prev) && /^ポッドキャスト/.test(next))
    || (/(?:YouTube|YOUTUBE|Youtube)$/.test(prev) && /^(?:番組|ポッドキャスト)/.test(next))
    || (/(?:リアル)$/.test(prev) && /^バリュー/.test(next));
}

function getJapaneseBoundaryCarryText(previous, current) {
  const prev = normalizeSubtitleDisplayText(previous).replace(/\n/g, "");
  const next = normalizeSubtitleDisplayText(current).replace(/\n/g, "");
  if (!prev || !next || /[、。，．。！？!?]$/.test(prev)) {
    return "";
  }
  const numericTail = prev.match(/(?:数|[0-9０-９]+)$/)?.[0] || "";
  if (numericTail && startsWithJapaneseNumericUnit(next)) {
    return numericTail;
  }
  if (startsWithJapaneseHonorific(next)) {
    return prev.match(/[一-龯々ァ-ヴA-Za-z]+$/)?.[0] || "";
  }
  if (startsWithJapaneseInflectionFragment(next)) {
    if (/いま$/.test(prev) && /^せん/.test(next)) {
      return "いま";
    }
    if (/いただ$/.test(prev) && /^いて/.test(next)) {
      return "いただ";
    }
    if (/話さ$/.test(prev) && /^せて/.test(next)) {
      return "話さ";
    }
    if (/さ$/.test(prev) && /^せて/.test(next)) {
      return "さ";
    }
    if (/とか$/.test(prev) && /^けられ/.test(next)) {
      return "とか";
    }
    return prev.match(/[一-龯々]$/)?.[0] || "";
  }
  for (const compoundTail of ["ショート", "長尺", "ライト", "文字", "ファン", "勝ち", "ブルー", "ビデオ", "YouTube", "YOUTUBE", "Youtube", "リアル"]) {
    if (prev.endsWith(compoundTail) && shouldKeepJapaneseCompoundBoundaryTogether(prev, next)) {
      return compoundTail;
    }
  }
  return "";
}

function isJapaneseNumericText(text) {
  return /^[0-9０-９]+(?:[.,．，][0-9０-９]+)?$/.test(text);
}

function startsWithJapaneseNumericUnit(text) {
  return /^(?:パーセント|パー|%|ヶ月|か月|カ月|時間|分|秒|年|月|日|人|名|社|本|個|回|投稿|再生|弾|話|章|部|項|節|つ|円|万円|歳|才)/.test(text);
}

function isJapaneseCounterOrUnitText(text) {
  return /^(?:パーセント|パー|%|ヶ月|か月|カ月|時間|分|秒|年|月|日|人|名|社|本|個|回|投稿|再生|弾|話|章|部|項|節|つ|円|万円|歳|才)$/.test(text)
    || /^[々〇〆一-龯ぁ-ゖァ-ヴー]{1,4}$/.test(text);
}

function adjustJapaneseNumericUnitSplitIndex(text, index) {
  const safeIndex = Math.max(1, Math.min(text.length - 1, index));
  const left = text.slice(0, safeIndex);
  const right = text.slice(safeIndex);
  const numericTail = left.match(/(?:数|[0-9０-９]+)$/)?.[0] || "";
  if (numericTail && startsWithJapaneseNumericUnit(right) && safeIndex - numericTail.length > 0) {
    return safeIndex - numericTail.length;
  }
  return safeIndex;
}

function shouldAttachJapaneseUnitToPrevious(previous, current) {
  if (!previous) {
    return false;
  }
  if (isJapaneseClosingPunctuation(current) || isSmallKanaOrLongMark(current)) {
    return true;
  }
  if (isJapaneseDashText(current) || isJapaneseDashText(previous.slice(-1))) {
    return true;
  }
  if (/^(?:ます|まし|ません|でした|きます|きる|きれ|きない|ない|なく|なっ|という|として|について|によって|ため|とき|はず|こと|もの)/.test(current)) {
    return true;
  }
  if (JAPANESE_ATTACH_TO_PREVIOUS.has(current)) {
    return true;
  }
  if (/^(?:あの|この|その|どの)$/.test(current)) {
    return false;
  }
  if (/^[ぁ-ゖ]{1,4}$/.test(current) && !/[、。，．。！？!?]$/.test(previous)) {
    return true;
  }
  if (isKanjiText(previous) && isKanjiText(current) && current.length <= 2) {
    return true;
  }
  if (shouldAttachKatakanaCaptionUnit(previous, current)) {
    return true;
  }
  if (/[0-9０-９]+(?:[.,．，][0-9０-９]+)?$/.test(previous) && isJapaneseCounterOrUnitText(current)) {
    return true;
  }
  if (/[約第全各毎]/.test(previous.slice(-1)) && isJapaneseNumericText(current)) {
    return true;
  }
  if (/^[A-Za-z0-9]+$/.test(previous) && /^[A-Za-z0-9]+$/.test(current)) {
    return true;
  }
  return false;
}

function startsWithJapaneseCaptionForbiddenFragment(text) {
  return /^(?:か|も|を|に|が|は|の|と|や|ね|よ|ぞ|で(?!も|す|は)|ます|まし|ません|でした|きます|きました|きる|きれ|きない|きており|ない|なく|なっ|いており|いこう|いかない|みる|おく|しまう|ほしい|くれる|あげる|もらう|やる|という|として|について|によって|にとって|ため|とき|はず|こと|もの|ベル|ース|トル|ション|ング|タイ|ティ|ント)(?:[ぁ-んァ-ヴー一-龯A-Za-z0-9、。，．。！？!?]|$)/.test(text);
}

function segmentTextWithIntl(safe) {
  const rawSegments = [];
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("ja", { granularity: "word" });
    for (const segment of segmenter.segment(safe)) {
      const part = String(segment.segment || "").trim();
      if (part) {
        rawSegments.push(part);
      }
    }
  } else {
    rawSegments.push(...Array.from(safe));
  }
  return rawSegments;
}

function getJapaneseCaptionUnits(text) {
  const safe = normalizeCaptionText(text);
  if (!safe) {
    return [];
  }
  const rawSegments = segmentJapaneseTextIntoUnits(safe);
  const units = [];
  for (const raw of rawSegments) {
    const part = raw.trim();
    if (!part) {
      continue;
    }
    if (isJapaneseOpeningPunctuation(part)) {
      units.push({ text: part });
      continue;
    }
    const previous = units[units.length - 1]?.text || "";
    if (previous && shouldAttachJapaneseUnitToPrevious(previous, part)) {
      units[units.length - 1] = { text: previous + part };
    } else {
      units.push({ text: part });
    }
  }
  return units.length > 0 ? units : [{ text: safe }];
}

function scoreJapaneseCaptionBoundary(previousText, nextText, firstLength, secondLength, maxChars) {
  // Meaning first, balance second: a mild equality pull with a slight
  // preference for a longer top line (Japanese telop convention).
  let score = Math.abs(firstLength - secondLength) * 1.1;
  if (secondLength > firstLength) {
    score += 4;
  }
  const prev = previousText.slice(-1);
  const next = nextText.slice(0, 1);
  if (/[、。，．。！？!?]$/.test(previousText)) {
    score -= 28;
  }
  // Breaking right after a particle or the te-form (食べて|しまった) reads
  // broken in Japanese; treat it as a near-forbidden boundary.
  if (/[はがをにでとへもて]$/.test(previousText)) {
    score += 48;
  }
  if (/[の]$/.test(previousText)) {
    score += 5;
  }
  if (/(?:あの|この|その|どの)$/.test(previousText)) {
    score += 1000;
  }
  if (/^(?:あの|この|その|どの)/.test(nextText)) {
    score -= 40;
  }
  if (/^[、。，．。！？!?）」』】］〕〉》〙〗）\]]/.test(nextText)) {
    score += 80;
  }
  if (/^[ぁぃぅぇぉゃゅょゎァィゥェォャュョヮっッー]/.test(nextText)) {
    score += 80;
  }
  if (/^[てでだですますたっ]/.test(nextText)) {
    score += 45;
  }
  if (startsWithJapaneseCaptionForbiddenFragment(nextText)) {
    score += 80;
  }
  if (/[「『（(［【〔〈《〘〚]$/.test(previousText)) {
    score += 120;
  }
  if (firstLength < Math.max(2, Math.floor(maxChars * 0.35))) {
    score += 18;
  }
  if (secondLength < Math.max(2, Math.floor(maxChars * 0.25))) {
    score += 12;
  }
  if (prev && next && isKanjiText(prev) && isKanjiText(next)) {
    score += 30;
  }
  return score;
}

function isAwkwardJapaneseCaptionBoundary(previousText, nextText) {
  const prev = normalizeCaptionText(previousText).replace(/\n/g, "");
  const next = normalizeCaptionText(nextText).replace(/\n/g, "");
  if (!prev || !next) {
    return true;
  }
  if (/[「『（(［【〔〈《〘〚]$/.test(prev)) {
    return true;
  }
  if (/^[、。，．。！？!?）」』】］〕〉》〙〗）\]]/.test(next)) {
    return true;
  }
  if (/^[ぁぃぅぇぉゃゅょゎァィゥェォャュョヮっッー]/.test(next)) {
    return true;
  }
  if (/[ぁぃぅぇぉゃゅょゎァィゥェォャュョヮっッー]$/.test(prev)) {
    return true;
  }
  if (/(?:あの|この|その|どの)$/.test(prev)) {
    return true;
  }
  if (startsWithJapaneseCaptionForbiddenFragment(next)) {
    return true;
  }
  if (/[0-9０-９]+、$/.test(prev) && /^[0-9０-９]+年/.test(next)) {
    return true;
  }
  if (/(?:数|[0-9０-９]+)$/.test(prev) && startsWithJapaneseNumericUnit(next)) {
    return true;
  }
  if (/(?:という|っていう)$/.test(prev) && /^(?:方|人|もの|こと|形|感じ)/.test(next)) {
    return true;
  }
  if (/(?:いく)$/.test(prev) && /^と[、。，,]?もう/.test(next)) {
    return true;
  }
  if (/(?:こと)$/.test(prev) && /^に(?:関して|対して|対する|ついて)/.test(next)) {
    return true;
  }
  if (/^に(?:関して|対して|対する|ついて)/.test(next) && /[ぁ-んァ-ヴー一-龯A-Za-z0-9]$/.test(prev)) {
    return true;
  }
  if (/(?:というこ)$/.test(prev) && /^形/.test(next)) {
    return true;
  }
  if (/(?:[零〇一二三四五六七八九壱弐参])$/.test(prev) && /^[0-9０-９]+(?:分|時間|秒)/.test(next)) {
    return true;
  }
  if (/(?:さ)$/.test(prev) && /^せて/.test(next)) {
    return true;
  }
  if (shouldKeepJapaneseWordBoundaryTogether(prev, next) || shouldKeepJapaneseCompoundBoundaryTogether(prev, next)) {
    return true;
  }
  if (shouldKeepKatakanaCaptionBoundaryTogether(prev, next)) {
    return true;
  }
  if (/[一-龯々〆ヵヶぁ-んァ-ン]$/.test(prev) && /^[ぁ-んァ-ンー]/.test(next) && prev.length <= 3) {
    return true;
  }
  return false;
}

function findSubtitleSplitIndex(text, maxChars) {
  const safe = text.trim();
  if (safe.length <= maxChars) {
    return safe.length;
  }
  const semanticUnits = getJapaneseCaptionUnits(safe);
  if (semanticUnits.length > 1) {
    const semanticMin = Math.max(1, Math.min(safe.length - 1, Math.floor(maxChars * 0.35)));
    const semanticMax = Math.min(safe.length - 1, maxChars);
    const semanticTarget = Math.min(semanticMax, Math.max(semanticMin, Math.floor(maxChars * 0.82)));
    let cursor = 0;
    let bestSemantic = -1;
    let bestSemanticScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < semanticUnits.length - 1; i += 1) {
      cursor += semanticUnits[i].text.length;
      if (cursor < semanticMin || cursor > semanticMax) {
        continue;
      }
      const firstLength = cursor;
      const remainingLength = safe.length - cursor;
      const first = safe.slice(0, cursor).trim();
      const second = safe.slice(cursor).trim();
      if (isAwkwardJapaneseCaptionBoundary(first, second)) {
        continue;
      }
      let score = Math.abs(cursor - semanticTarget) * 1.15;
      score += scoreJapaneseCaptionBoundary(semanticUnits[i].text, semanticUnits[i + 1].text, firstLength, Math.min(remainingLength, maxChars), maxChars) * 0.22;
      if (remainingLength > 0 && remainingLength < Math.max(3, Math.floor(maxChars * 0.22))) {
        score += 18;
      }
      if (/[、。，．。！？!?]$/.test(semanticUnits[i].text)) {
        score -= 18;
      }
      if (score < bestSemanticScore) {
        bestSemanticScore = score;
        bestSemantic = cursor;
      }
    }
    if (bestSemantic > 0) {
      return adjustJapaneseNumericUnitSplitIndex(safe, bestSemantic);
    }
  }
  const lowerBound = Math.max(1, safe.length - maxChars);
  const upperBound = Math.min(safe.length - 1, maxChars);
  if (lowerBound > upperBound) {
    return Math.min(maxChars, safe.length - 1);
  }
  const min = Math.max(lowerBound, Math.min(upperBound, Math.floor(safe.length * 0.35)));
  const max = upperBound;
  const preferredChars = new Set(["、", "，", "・", " ", "　", "。", "！", "？", "!", "?"]);
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = min; i <= max; i += 1) {
    const prev = safe[i - 1];
    const next = safe[i];
    let score = Math.abs(i - safe.length / 2);
    if (isAwkwardJapaneseCaptionBoundary(safe.slice(0, i).trim(), safe.slice(i).trim())) {
      score += 160;
    }
    if (isJapaneseDashText(prev) && isJapaneseDashText(next)) {
      score += 1000;
    } else if (isJapaneseDashText(prev)) {
      score -= 6;
    } else if (isJapaneseDashText(next)) {
      score += 20;
    }
    if (preferredChars.has(prev) || preferredChars.has(next)) {
      score -= 8;
    }
    if (/^[、。，．。！？!?）」』】］〕〉》〙〗）\]]/.test(next)) {
      score += 120;
    }
    if (/^[ぁぃぅぇぉゃゅょゎァィゥェォャュョヮっッー]/.test(next)) {
      score += 120;
    }
    if (/^[てでだですますたっ]/.test(next)) {
      score += 45;
    }
    if ("はがをにへでとからまでよりも".includes(prev)) {
      score += 5;
    }
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return adjustJapaneseNumericUnitSplitIndex(safe, best > 0 ? best : Math.min(maxChars, safe.length - 1));
}

function findSubtitleSplitIndexNearTarget(text, targetIndex, maxChars) {
  const safe = text.trim();
  if (safe.length <= 1) {
    return safe.length;
  }
  const units = getJapaneseCaptionUnits(safe);
  let cursor = 0;
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 0; i < units.length - 1; i += 1) {
    cursor += units[i].text.length;
    const firstLength = cursor;
    const secondLength = safe.length - cursor;
    if (firstLength <= 0 || secondLength <= 0 || firstLength > maxChars || secondLength > maxChars) {
      continue;
    }
    if (isAwkwardJapaneseCaptionBoundary(safe.slice(0, cursor).trim(), safe.slice(cursor).trim())) {
      continue;
    }
    const score = Math.abs(cursor - targetIndex)
      + scoreJapaneseCaptionBoundary(units[i].text, units[i + 1].text, firstLength, secondLength, Math.max(1, Math.ceil(maxChars / 2))) * 0.18;
    if (score < bestScore) {
      bestScore = score;
      best = cursor;
    }
  }
  if (best > 0) {
    return adjustJapaneseNumericUnitSplitIndex(safe, best);
  }
  const readable = findReadableSubtitleSplitIndexNearTarget(safe, targetIndex, maxChars);
  return readable > 0
    ? adjustJapaneseNumericUnitSplitIndex(safe, readable)
    : findSubtitleSplitIndex(safe, Math.max(1, Math.min(maxChars, targetIndex)));
}

function findReadableSubtitleSplitIndexNearTarget(text, targetIndex, maxChars) {
  const safe = text.trim();
  const lowerBound = Math.max(1, safe.length - maxChars);
  const upperBound = Math.min(safe.length - 1, maxChars);
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = lowerBound; i <= upperBound; i += 1) {
    const first = safe.slice(0, i).trim();
    const second = safe.slice(i).trim();
    if (!first || !second || isAwkwardJapaneseCaptionBoundary(first, second)) {
      continue;
    }
    let score = Math.abs(i - targetIndex);
    score += scoreJapaneseCaptionBoundary(first.slice(-4), second.slice(0, 4), first.length, second.length, Math.max(1, Math.ceil(maxChars / 2))) * 0.12;
    if (/[、。，．。！？!?]$/.test(first)) {
      score -= 10;
    }
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

function getSubtitleLineMaxChars(lineCount, maxChars) {
  const total = Math.max(1, maxChars);
  return lineCount === 2 ? Math.max(1, Math.ceil(total / 2)) : total;
}

function getSubtitleLineHardMaxChars(lineCount, maxChars) {
  const total = Math.max(1, maxChars);
  if (lineCount === 1) {
    return total;
  }
  return Math.max(getSubtitleLineMaxChars(lineCount, total), Math.min(total - 1, Math.ceil(total * 0.72)));
}

function splitCaptionUnitBySemanticLimit(text, maxChars) {
  const limit = Math.max(1, maxChars);
  let rest = normalizeSubtitleDisplayText(text).replace(/\n/g, "");
  const chunks = [];
  while (rest.length > limit) {
    const idx = findSubtitleSplitIndex(rest, limit);
    const head = rest.slice(0, idx).trim();
    if (!head) {
      break;
    }
    chunks.push(head);
    rest = rest.slice(idx).trim();
  }
  if (rest) {
    chunks.push(rest);
  }
  return chunks.filter((chunk) => chunk && !isJapaneseCaptionPunctuationOnly(chunk));
}

function splitCaptionTextIntoChunks(text, lineCount, maxChars) {
  const limit = Math.max(1, maxChars);
  void lineCount;
  const normalized = normalizeSubtitleDisplayText(normalizeSubtitleScriptSourceText(text))
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[*_`|]/g, "")
    .replace(/\n+/g, "。");
  const roughUnits = normalized
    .split(/(?<=[。！？!?])|(?<=、)/)
    .map((part) => part.trim())
    .filter((part) => Boolean(part) && !isJapaneseCaptionPunctuationOnly(part));
  const semanticUnits = (roughUnits.length > 0 ? roughUnits : [normalized])
    .flatMap((unit) => splitCaptionUnitBySemanticLimit(unit, limit));
  const chunks = [];
  for (const unit of semanticUnits) {
    const previous = chunks[chunks.length - 1] || "";
    if (
      previous
      && previous.length + unit.length <= limit
      && !/[。！？!?]$/.test(previous)
      && !/^[、。，．。！？!?）」』】］〕〉》〙〗）\]]/.test(unit)
    ) {
      chunks[chunks.length - 1] = previous + unit;
    } else {
      chunks.push(unit);
    }
  }
  return chunks;
}

export function splitSubtitleLines(text, lineCount, maxChars) {
  const safe = normalizeSubtitleDisplayText(text).replace(/\n/g, "");
  if (!safe) {
    return "";
  }
  const lineMaxChars = getSubtitleLineMaxChars(lineCount, maxChars);
  if (lineCount === 1 || safe.length <= Math.max(lineMaxChars, 10)) {
    return safe;
  }
  const lineHardMaxChars = getSubtitleLineHardMaxChars(lineCount, maxChars);
  const units = getJapaneseCaptionUnits(safe);
  const candidates = [];
  let cursor = 0;
  for (let i = 0; i < units.length - 1; i += 1) {
    cursor += units[i].text.length;
    const firstLength = cursor;
    const secondLength = safe.length - cursor;
    if (firstLength <= lineHardMaxChars && secondLength <= lineHardMaxChars) {
      const first = safe.slice(0, cursor).trim();
      const second = safe.slice(cursor).trim();
      if (
        first.length < 4
        || second.length < 4
        || isAwkwardJapaneseCaptionBoundary(first, second)
      ) {
        continue;
      }
      candidates.push({
        index: cursor,
        score: scoreJapaneseCaptionBoundary(units[i].text, units[i + 1].text, firstLength, secondLength, lineMaxChars),
      });
    }
  }
  if (candidates.length === 0) {
    if (safe.length <= lineHardMaxChars) {
      return safe;
    }
    const forcedIndex = findSubtitleSplitIndexNearTarget(
      safe,
      Math.min(lineHardMaxChars, Math.max(1, Math.ceil(safe.length / 2))),
      lineHardMaxChars,
    );
    if (forcedIndex > 0 && forcedIndex < safe.length) {
      const first = safe.slice(0, forcedIndex).trim();
      const second = safe.slice(forcedIndex).trim();
      if (first && second && first.length <= lineHardMaxChars && second.length <= lineHardMaxChars) {
        return `${first}\n${second}`;
      }
    }
    return safe;
  }
  const idx = candidates.sort((a, b) => a.score - b.score)[0].index;
  const first = safe.slice(0, idx).trim();
  const second = safe.slice(idx).trim();
  return second ? `${first}\n${second}` : first;
}

// ---------------------------------------------------------------------------
// Segment merge / repair / punctuation (extension.ts ~8625-8948, 9339-9377)
// ---------------------------------------------------------------------------

function canMergeSubtitleSegments(left, right, maxChars) {
  if (!left || !right) {
    return false;
  }
  const mergedText = normalizeCaptionText(`${left.text}${right.text}`).replace(/\n/g, "");
  return Boolean(mergedText) && mergedText.length <= Math.max(1, maxChars);
}

function canMergeSubtitleSegmentsForReflow(left, right, maxChars) {
  if (!left || !right) {
    return false;
  }
  const mergedText = normalizeCaptionText(`${left.text}${right.text}`).replace(/\n/g, "");
  const duration = Math.max(left.end, right.end) - Math.min(left.start, right.start);
  return Boolean(mergedText)
    && mergedText.length <= Math.max(1, maxChars) * 2
    && duration <= 8.5;
}

function mergeSubtitleSegments(left, right) {
  return {
    text: normalizeSubtitleDisplayText(`${left.text}${right.text}`).replace(/\n/g, ""),
    start: Math.min(left.start, right.start),
    end: Math.max(left.end, right.end),
    startWordIndex: left.startWordIndex ?? right.startWordIndex,
    endWordIndex: right.endWordIndex ?? left.endWordIndex,
    reason: left.reason === right.reason ? left.reason : "reflow",
  };
}

function shouldKeepJapaneseLooseCueBoundaryTogether(previous, current) {
  const prev = normalizeSubtitleDisplayText(previous).replace(/\n/g, "");
  const next = normalizeSubtitleDisplayText(current).replace(/\n/g, "");
  if (!prev || !next || /[、。，．。！？!?]$/.test(prev)) {
    return false;
  }
  if (/(?:ということで|ところです|わけです|からです|ためです)$/.test(prev)) {
    return false;
  }
  if (startsWithJapaneseCaptionDiscourseUnit(next) || startsNewJapaneseClauseAfterSentence(next)) {
    return false;
  }
  if (/(?:あの|この|その|どの)$/.test(prev)) {
    return true;
  }
  if (/(?:みたい)$/.test(prev) && /^な(?:ご|御)?要望/.test(next)) {
    return true;
  }
  if (/(?:とか)$/.test(prev) && /^けられ/.test(next)) {
    return true;
  }
  if (/(?:いく)$/.test(prev) && /^と[、。，,]?もう/.test(next)) {
    return true;
  }
  if (/(?:こと)$/.test(prev) && /^に(?:関して|対して|対する|ついて)/.test(next)) {
    return true;
  }
  if (/^に(?:関して|対して|対する|ついて)/.test(next) && /[ぁ-んァ-ヴー一-龯A-Za-z0-9]$/.test(prev)) {
    return true;
  }
  if (/(?:というこ)$/.test(prev) && /^形/.test(next)) {
    return true;
  }
  if (shouldKeepJapaneseWordBoundaryTogether(prev, next) || shouldKeepJapaneseCompoundBoundaryTogether(prev, next)) {
    return true;
  }
  if (/(?:[0-9]+年|[零〇一二三四五六七八九十百千万壱弐参]+年)$/.test(prev) && /^前/.test(next)) {
    return true;
  }
  if (/(?:[零〇一二三四五六七八九壱弐参])$/.test(prev) && /^[0-9０-９]+(?:分|時間|秒)/.test(next)) {
    return true;
  }
  if (/(?:数|[0-9]+|[零〇一二三四五六七八九十百千万壱弐参]+)$/.test(prev) && /^(?:ヶ?月|か月|カ月|日|時間|分|秒|人|名|社|本|個|回|投稿|再生|パーセント|パー|%|弾|話|章|部|項|節|つ|円|万円|歳|才)/.test(next)) {
    return true;
  }
  if (/(?:が|を|に|へ|で|と|は|も|の)$/.test(prev) && !/^(?:で|そして|それで|ただ|まず|次に|今回|具体的には)/.test(next)) {
    return true;
  }
  if (/(?:たいと|ようと|しようと|についての|に関して|という|みたいなところを)$/.test(prev)) {
    return true;
  }
  return false;
}

function isAwkwardSubtitleSegmentBoundary(left, right) {
  if (!left || !right) {
    return false;
  }
  const leftText = normalizeCaptionText(left.text).replace(/\n/g, "");
  const rightText = normalizeCaptionText(right.text).replace(/\n/g, "");
  if (!leftText || !rightText) {
    return false;
  }
  return shouldKeepKatakanaCaptionBoundaryTogether(leftText, rightText)
    || shouldKeepJapaneseTimingBoundaryTogether(leftText, rightText)
    || shouldKeepJapaneseLooseCueBoundaryTogether(leftText, rightText)
    || startsWithJapaneseCaptionForbiddenFragment(rightText)
    || /[「『（(［【〔〈《〘〚]$/.test(leftText)
    || /^[、。，．。！？!?）」』】］〕〉》〙〗）\]]/.test(rightText)
    || /^[ぁぃぅぇぉゃゅょゎァィゥェォャュョヮっッー]/.test(rightText);
}

function isSubtitleSegmentTooFragmented(segment) {
  const text = normalizeCaptionText(segment.text).replace(/\n/g, "");
  const duration = Math.max(0, segment.end - segment.start);
  if (!text) {
    return false;
  }
  if (duration < 0.45) {
    return true;
  }
  if (duration < 0.6 && text.length <= 3) {
    return true;
  }
  if (/[「『（(［【〔〈《〘〚]$/.test(text)) {
    return true;
  }
  return false;
}

function compactSubtitleSegments(segments, maxChars) {
  const result = segments
    .map((segment) => ({
      ...segment,
      text: normalizeSubtitleDisplayText(segment.text).replace(/\n/g, ""),
      start: Math.max(0, segment.start),
      end: Math.max(Math.max(0, segment.start), segment.end),
    }))
    .filter((segment) => segment.text)
    .sort((a, b) => a.start - b.start);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < result.length; i += 1) {
      const current = result[i];
      const previous = result[i - 1];
      const next = result[i + 1];
      if (isAwkwardSubtitleSegmentBoundary(current, next) && canMergeSubtitleSegmentsForReflow(current, next, maxChars)) {
        result.splice(i, 2, mergeSubtitleSegments(current, next));
        changed = true;
        break;
      }
      if (isAwkwardSubtitleSegmentBoundary(previous, current) && canMergeSubtitleSegmentsForReflow(previous, current, maxChars)) {
        result.splice(i - 1, 2, mergeSubtitleSegments(previous, current));
        changed = true;
        break;
      }
      if (!isSubtitleSegmentTooFragmented(current)) {
        continue;
      }
      const mergeNext = canMergeSubtitleSegments(current, next, maxChars);
      const mergePrev = canMergeSubtitleSegments(previous, current, maxChars);
      if (mergeNext && (!mergePrev || /[「『（(［【〔〈《〘〚]$/.test(current.text) || !/[。！？!?]$/.test(current.text))) {
        result.splice(i, 2, mergeSubtitleSegments(current, next));
        changed = true;
        break;
      }
      if (mergePrev) {
        result.splice(i - 1, 2, mergeSubtitleSegments(previous, current));
        changed = true;
        break;
      }
    }
  }
  return result;
}

function splitTimedSegmentForSubtitleLimits(segment, lineCount, maxChars) {
  const chunks = splitCaptionTextIntoChunks(segment.text, lineCount, maxChars);
  if (chunks.length <= 1) {
    return chunks.length === 1 ? [{ ...segment, text: chunks[0] }] : [];
  }
  const start = Math.max(0, segment.start);
  const end = Math.max(start, segment.end);
  const duration = Math.max(0.001, end - start);
  const totalWeight = chunks.reduce((sum, chunk) => sum + Math.max(1, chunk.length), 0);
  let cursor = start;
  return chunks.map((chunk, index) => {
    const isLast = index === chunks.length - 1;
    const span = isLast ? end - cursor : duration * (Math.max(1, chunk.length) / totalWeight);
    const nextEnd = isLast ? end : Math.min(end, cursor + Math.max(0.001, span));
    const item = { text: chunk, start: cursor, end: nextEnd, reason: "reflow" };
    cursor = nextEnd;
    return item;
  });
}

function repairExpandedSubtitleSegmentBoundaries(segments) {
  const result = segments.map((segment) => ({
    ...segment,
    text: normalizeSubtitleDisplayText(segment.text).replace(/\n/g, ""),
  }));
  for (let i = 0; i < result.length - 1; i += 1) {
    const current = result[i];
    const next = result[i + 1];
    const carryText = getJapaneseBoundaryCarryText(current.text, next.text);
    if (!carryText) {
      continue;
    }
    if (!current.text.endsWith(carryText)) {
      continue;
    }
    const currentText = current.text.slice(0, -carryText.length);
    current.text = currentText;
    next.text = normalizeSubtitleDisplayText(`${carryText}${next.text}`).replace(/\n/g, "");
  }
  return result.filter((segment) => segment.text);
}

function getAutoSubtitleTerminalPunctuation(text, currentSegment, nextSegment) {
  const safe = normalizeCaptionText(text).replace(/\n/g, "");
  if (/[、。，．。！？!?]$/.test(safe)) {
    return "";
  }
  if (/[―—…‥]$/.test(safe)) {
    return "";
  }
  if (/(?:とか|だったりとか)$/.test(safe)) {
    return "";
  }
  if (/(?:ですか|ますか|だろうか|でしょうか|なのか|か)$/.test(safe)) {
    return "？";
  }
  const nextGap = nextSegment ? Math.max(0, nextSegment.start - currentSegment.end) : 1;
  if (/(?:が|けど|けれど|から|ので|ため|として|には|では|と|に|を|は|の)$/.test(safe) || nextGap < 0.28) {
    return "";
  }
  if (/(?:です|ます|でした|ました|だ|だった|である|ない|ある|いる|する|した|なる|なった|できる|終わる|変わる|思う|思います|思いません)$/.test(safe)) {
    return "。";
  }
  return "";
}

function applySubtitlePunctuation(text, currentSegment, nextSegment, maxChars, punctuationMode) {
  const safe = normalizeSubtitleDisplayText(text).replace(/\n/g, "");
  if (!safe || punctuationMode === "none") {
    return safe;
  }
  const punctuation = getAutoSubtitleTerminalPunctuation(safe, currentSegment, nextSegment);
  if (!punctuation) {
    return safe;
  }
  return safe.length + punctuation.length <= Math.max(1, maxChars) ? `${safe}${punctuation}` : safe;
}

function buildSubtitleLinesForSrt(segments, lineCount, maxChars) {
  return repairExpandedSubtitleSegmentBoundaries(compactSubtitleSegments(segments, maxChars)
    .filter((segment) => normalizeCaptionText(segment.text))
    .flatMap((segment) => splitTimedSegmentForSubtitleLimits(segment, lineCount, maxChars)))
    .map((segment) => ({
      text: segment.text,
      start: segment.start,
      end: segment.end,
      startWordIndex: segment.startWordIndex,
      endWordIndex: segment.endWordIndex,
      reason: segment.reason || "reflow",
    }));
}

function applySubtitleLineTiming(lines, options = {}) {
  const preRollSeconds = Math.max(0, options.preRollSeconds ?? 0);
  const postRollSeconds = Math.max(0, options.postRollSeconds ?? 0);
  const minDurationSeconds = Math.max(0, options.minDurationSeconds ?? 0);
  const minGapSeconds = Math.max(0, options.minGapSeconds ?? 0);
  const durationSeconds = normalizeDurationSeconds(options.durationSeconds);
  const raw = lines
    .map((line) => {
      const start = Math.max(0, line.start - preRollSeconds);
      const speechEnd = Math.max(start, line.end);
      const end = Math.max(start, speechEnd + postRollSeconds);
      return { ...line, start, end };
    })
    .sort((a, b) => (a.start - b.start) || (a.end - b.end));
  return raw.map((line, index) => {
    const next = raw[index + 1];
    const start = durationSeconds > 0
      ? Math.min(line.start, Math.max(0, durationSeconds - minGapSeconds))
      : line.start;
    const nextStart = next ? next.start : Number.POSITIVE_INFINITY;
    const nextMaxEnd = Number.isFinite(nextStart) ? Math.max(start + minGapSeconds, nextStart - minGapSeconds) : Number.POSITIVE_INFINITY;
    const durationMaxEnd = durationSeconds > 0 ? durationSeconds : Number.POSITIVE_INFINITY;
    const maxEnd = Math.min(nextMaxEnd, durationMaxEnd);
    const desiredEnd = Math.max(line.end, start + minDurationSeconds);
    const end = Number.isFinite(maxEnd)
      ? Math.max(start + minGapSeconds, Math.min(desiredEnd, maxEnd))
      : desiredEnd;
    return { ...line, start, end };
  });
}

function normalizeSubtitleSegmentsForVerification(segments) {
  return segments
    .map((segment) => {
      const start = Math.max(0, Number.isFinite(segment.start) ? segment.start : 0);
      const end = Math.max(start + 0.05, Number.isFinite(segment.end) ? segment.end : start + 0.05);
      return {
        ...segment,
        text: normalizeSubtitleDisplayText(segment.text).replace(/\n/g, ""),
        start,
        end,
      };
    })
    .filter((segment) => segment.text)
    .sort((a, b) => a.start - b.start);
}

// One cue should never contain two sentences: split at mid-segment 。！？
// boundaries, allocating the time span by character weight.
function splitSubtitleSegmentAtSentenceEnds(segment) {
  const text = String(segment.text || "");
  const parts = [];
  let buffer = "";
  for (const ch of text) {
    buffer += ch;
    if (/[。！？!?]/.test(ch)) {
      parts.push(buffer);
      buffer = "";
    }
  }
  if (buffer.trim()) parts.push(buffer);
  const trimmed = parts.map((part) => part.trim()).filter(Boolean);
  if (trimmed.length < 2) return [segment];
  if (trimmed.some((part) => part.replace(/[。！？!?、，,.\s]/g, "").length < 4)) return [segment];
  const totalChars = trimmed.reduce((sum, part) => sum + part.length, 0);
  const span = Math.max(0.2, segment.end - segment.start);
  const out = [];
  let cursor = segment.start;
  trimmed.forEach((part, index) => {
    const isLast = index === trimmed.length - 1;
    const end = isLast ? segment.end : Math.min(segment.end, cursor + (span * part.length) / totalChars);
    out.push({ ...segment, text: part, start: cursor, end: Math.max(cursor + 0.2, end) });
    cursor = out[out.length - 1].end;
  });
  return out;
}

function repairSubtitleSegments(segments, options) {
  const result = repairExpandedSubtitleSegmentBoundaries(compactSubtitleSegments(
    normalizeSubtitleSegmentsForVerification(segments),
    options.maxChars,
  )
    .flatMap((segment) => splitTimedSegmentForSubtitleLimits(segment, options.lineCount, options.maxChars))
    .flatMap((segment) => splitSubtitleSegmentAtSentenceEnds(segment)));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < result.length; i += 1) {
      const previous = result[i - 1];
      const current = result[i];
      if (
        isAwkwardSubtitleSegmentBoundary(previous, current)
        && canMergeSubtitleSegmentsForReflow(previous, current, options.maxChars)
      ) {
        result.splice(i - 1, 2, mergeSubtitleSegments(previous, current));
        changed = true;
        break;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// SRT rendering (extension.ts ~7786-7796, 8934-8958)
// ---------------------------------------------------------------------------

export function formatSrtTimestamp(seconds) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const msTotal = Math.round(safe * 1000);
  const ms = msTotal % 1000;
  const totalSeconds = Math.floor(msTotal / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function renderSrt(subtitleLines) {
  return (subtitleLines || [])
    .map((line, index) => {
      const start = Math.max(0, Number(line.start) || 0);
      const end = Math.max(start, Number(line.end) || 0);
      return `${index + 1}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${line.text}\n`;
    })
    .join("\n");
}

export function encodeSubtitleSrtFileText(value) {
  const normalized = value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n");
  const withFinalNewline = normalized.endsWith("\r\n") ? normalized : `${normalized}\r\n`;
  return Buffer.from(`\uFEFF${withFinalNewline}`, "utf8");
}

// Full emit pipeline (extension.ts emitSrt, ~8934): repair -> compact/split ->
// timing (holdSeconds post-roll) -> punctuation -> 1/2-line breaking.
export function buildSubtitleLinesFromSegments(segments, options = {}) {
  const lineCount = normalizeSubtitleLineCount(options.lineCount ?? DEFAULT_SUBTITLE_LINE_COUNT);
  const maxChars = normalizeSubtitleMaxChars(options.maxChars ?? options.maxCharsPerLine ?? defaultSubtitleMaxCharsForLineCount(lineCount));
  const holdSeconds = normalizeSubtitleHoldSeconds(options.holdSeconds);
  const punctuationMode = normalizeSubtitlePunctuationMode(options.punctuationMode);
  const durationSeconds = normalizeDurationSeconds(options.durationSeconds);
  const repaired = repairSubtitleSegments(segments, { lineCount, maxChars });
  const timed = applySubtitleLineTiming(buildSubtitleLinesForSrt(repaired, lineCount, maxChars), {
    preRollSeconds: SUBTITLE_PRE_ROLL_SECONDS,
    postRollSeconds: holdSeconds,
    minDurationSeconds: SUBTITLE_MIN_CUE_SECONDS,
    minGapSeconds: SUBTITLE_MIN_CUE_GAP_SECONDS,
    durationSeconds,
  });
  return timed
    .map((line, index) => {
      const next = timed[index + 1];
      const start = Math.max(0, line.start);
      const end = Math.max(start, line.end);
      const text = splitSubtitleLines(
        applySubtitlePunctuation(line.text, line, next, maxChars, punctuationMode),
        lineCount,
        maxChars,
      );
      return { text, start, end };
    })
    .filter((line) => line.text);
}

// ---------------------------------------------------------------------------
// Timed-word (scriptless) segmentation (extension.ts ~10370-10790, 11173)
// ---------------------------------------------------------------------------

function getCaptionWordText(word) {
  return normalizeCaptionText(word.text || "").replace(/\n/g, "");
}

function shouldIncludeTimedWordInCaption(word) {
  const text = getCaptionWordText(word);
  if (!text || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end <= word.start) {
    return false;
  }
  const eventType = String(word.eventType || word.type || "").toLowerCase();
  return eventType !== "spacing";
}

const JAPANESE_TIMING_ATTACH_TO_PREVIOUS = new Set([
  "の", "が", "を", "に", "へ", "で", "と", "も", "は", "や", "か", "ね", "よ", "な",
  "だ", "です", "ます", "た", "て", "って", "だった", "でした", "ました",
  "ん", "る", "ろう", "ない", "いる", "ある", "いく", "いき", "いきたい", "きたい",
  "れる", "られる", "れて", "れている", "せる", "させる", "よう", "たい", "ください", "しまう", "ちゃう",
  "たり", "とか",
]);

function isJapaneseCaptionDiscourseUnit(text) {
  return /^(?:はい|えー|あー|まあ|まー|うん|そう|よー|よ)$/.test(text);
}

function startsWithJapaneseCaptionDiscourseUnit(text) {
  return /^(?:はい|えー|あー|まあ|まー|うん)(?:[、。，．。！？!?]|$|[ぁ-んァ-ヴー一-龯A-Za-z0-9])/.test(text)
    || /^(?:そう|よー|よ)(?:[、。，．。！？!?]|$)/.test(text);
}

function startsWithJapaneseTimingContinuation(text) {
  if (/^(?:の|が|を|に|へ|で|と|も|は|や|か|ね|よ|な)$/.test(text)) {
    return true;
  }
  return /^(?:て|だ|です|ます|た|った|って|たり|とか|から|ので|けど|けれど|ん|る|ろう|れる|られる|れて|れている|ない|よう|たい|う|いる|ある|いく|いき|いきたい|きたい|ください|しまう|ちゃう)/.test(text);
}

function endsWithJapaneseSentenceEndingForTiming(text) {
  return /(?:です|ます|ました|でした|だ|だった|である)$/.test(text);
}

function shouldKeepJapaneseTimingBoundaryTogether(previous, current) {
  const prev = normalizeCaptionText(previous).replace(/\n/g, "");
  const next = normalizeCaptionText(current).replace(/\n/g, "");
  if (!prev || !next) {
    return false;
  }
  if (/(?:いく)$/.test(prev) && /^と[、。，,]?もう/.test(next)) {
    return true;
  }
  if (/(?:こと)$/.test(prev) && /^に(?:関して|対して|対する|ついて)/.test(next)) {
    return true;
  }
  if (/^に(?:関して|対して|対する|ついて)/.test(next) && /[ぁ-んァ-ヴー一-龯A-Za-z0-9]$/.test(prev)) {
    return true;
  }
  if (/(?:というこ)$/.test(prev) && /^形/.test(next)) {
    return true;
  }
  if (/(?:[零〇一二三四五六七八九壱弐参])$/.test(prev) && /^[0-9０-９]+(?:分|時間|秒)/.test(next)) {
    return true;
  }
  if (startsWithJapaneseTimingContinuation(next)) {
    return true;
  }
  if (/(?:てい|してい)$/.test(prev) && /^[きくけこ]/.test(next)) {
    return true;
  }
  if (/きた$/.test(prev) && /^い/.test(next)) {
    return true;
  }
  if (/(?:し|思い|言い|話し|始め|見|食べ)$/.test(prev) && /^(?:て|たい|ます|ました|た)/.test(next)) {
    return true;
  }
  return false;
}

function startsNewJapaneseClauseAfterSentence(text) {
  return /^(?:で|そして|それで|ただ|まず|次に|今回は|具体的には)/.test(text);
}

function shouldAttachJapaneseTimingUnitToPrevious(previous, current) {
  if (!previous || !current) {
    return false;
  }
  if (isJapaneseClosingPunctuation(current) || isSmallKanaOrLongMark(current)) {
    return true;
  }
  if (current === "で" && endsWithJapaneseSentenceEndingForTiming(previous)) {
    return false;
  }
  if (JAPANESE_TIMING_ATTACH_TO_PREVIOUS.has(current) && previous.length + current.length <= 14) {
    return true;
  }
  if (shouldAttachKatakanaCaptionUnit(previous, current)) {
    return true;
  }
  if (/[0-9０-９]+(?:[.,．，][0-9０-９]+)?$/.test(previous) && isJapaneseCounterOrUnitText(current)) {
    return true;
  }
  if (/^[A-Za-z0-9]+$/.test(previous) && /^[A-Za-z0-9]+$/.test(current)) {
    return true;
  }
  return false;
}

function getJapaneseCaptionTimingUnits(text) {
  const safe = normalizeCaptionText(text).replace(/\n/g, "");
  if (!safe) {
    return [];
  }
  const rawSegments = segmentJapaneseTextIntoUnits(safe);
  const normalizedSegments = [];
  for (let index = 0; index < rawSegments.length; index += 1) {
    const part = rawSegments[index];
    const next = rawSegments[index + 1] || "";
    if (part === "は" && next.startsWith("い") && next.length >= 2) {
      normalizedSegments.push("はい");
      const rest = next.slice(1);
      if (rest) {
        normalizedSegments.push(rest);
      }
      index += 1;
      continue;
    }
    if (part === "です" && next === "ねえ") {
      normalizedSegments.push("です", "ね", "え");
      index += 1;
      continue;
    }
    normalizedSegments.push(part);
  }
  const units = [];
  for (const raw of normalizedSegments) {
    const part = raw.trim();
    if (!part) {
      continue;
    }
    const previous = units[units.length - 1] || "";
    if (previous === "で" && part.length <= 8 && !isJapaneseClosingPunctuation(part)) {
      units[units.length - 1] = previous + part;
    } else if (previous && shouldAttachJapaneseTimingUnitToPrevious(previous, part)) {
      units[units.length - 1] = previous + part;
    } else {
      units.push(part);
    }
  }
  return units;
}

function selectTimedCaptionSemanticText(wordText, transcriptText) {
  const safeWordText = normalizeCaptionText(wordText).replace(/\n/g, "");
  const safeTranscriptText = normalizeCaptionText(transcriptText || "").replace(/\n/g, "");
  if (!safeTranscriptText) {
    return safeWordText;
  }
  const wordComparable = normalizeCaptionComparableText(safeWordText);
  const transcriptComparable = normalizeCaptionComparableText(safeTranscriptText);
  if (!wordComparable || !transcriptComparable) {
    return safeWordText;
  }
  if (wordComparable === transcriptComparable) {
    return safeTranscriptText;
  }
  return safeWordText;
}

function buildTimedCaptionUnitsFromWords(words, transcriptText) {
  const sortedWords = words
    .filter(shouldIncludeTimedWordInCaption)
    .sort((a, b) => (a.start - b.start) || (a.end - b.end));
  const characters = [];
  for (let wordIndex = 0; wordIndex < sortedWords.length; wordIndex += 1) {
    const word = sortedWords[wordIndex];
    const text = getCaptionWordText(word);
    const chars = Array.from(text);
    if (chars.length === 0) {
      continue;
    }
    const duration = Math.max(0.001, word.end - word.start);
    for (let index = 0; index < chars.length; index += 1) {
      const start = word.start + duration * (index / chars.length);
      const end = word.start + duration * ((index + 1) / chars.length);
      characters.push({ text: chars[index], start, end, wordIndex });
    }
  }
  if (characters.length === 0) {
    return [];
  }
  const fullText = characters.map((item) => item.text).join("");
  const semanticText = selectTimedCaptionSemanticText(fullText, transcriptText);
  const semanticUnits = getJapaneseCaptionTimingUnits(semanticText);
  const units = [];
  let cursor = 0;
  for (const unitText of semanticUnits) {
    const unitLength = Array.from(unitText).length;
    if (unitLength <= 0) {
      continue;
    }
    const startIndex = cursor;
    const endIndex = Math.min(characters.length - 1, cursor + unitLength - 1);
    if (startIndex >= characters.length) {
      break;
    }
    const unitChars = Array.from(unitText);
    let rangeStart = startIndex;
    for (let charIndex = startIndex; charIndex < endIndex; charIndex += 1) {
      const gap = Math.max(0, characters[charIndex + 1].start - characters[charIndex].end);
      const leftLength = charIndex - rangeStart + 1;
      const rightLength = endIndex - charIndex;
      if (gap >= 0.35 && leftLength >= 2 && rightLength >= 1) {
        const text = unitChars.slice(rangeStart - startIndex, charIndex - startIndex + 1).join("");
        const start = characters[rangeStart].start;
        const end = Math.max(start + 0.001, characters[charIndex].end);
        units.push({
          text,
          start,
          end,
          startWordIndex: characters[rangeStart].wordIndex,
          endWordIndex: characters[charIndex].wordIndex,
        });
        rangeStart = charIndex + 1;
      }
    }
    const text = unitChars.slice(rangeStart - startIndex).join("");
    const start = characters[rangeStart].start;
    const end = Math.max(start + 0.001, characters[endIndex].end);
    if (text) {
      units.push({
        text,
        start,
        end,
        startWordIndex: characters[rangeStart].wordIndex,
        endWordIndex: characters[endIndex].wordIndex,
      });
    }
    cursor += unitLength;
  }
  return units.length > 0
    ? units
    : sortedWords.map((word, index) => ({
      text: getCaptionWordText(word),
      start: word.start,
      end: word.end,
      startWordIndex: index,
      endWordIndex: index,
    })).filter((unit) => unit.text);
}

function buildSubtitleLinesFromTimedWords(words, lineCount, maxChars, transcriptText) {
  const units = buildTimedCaptionUnitsFromWords(words, transcriptText);
  if (units.length === 0) {
    return [];
  }
  const softMaxDuration = lineCount === 1 ? 1.8 : 2.2;
  const hardMaxDuration = lineCount === 1 ? 2.4 : 2.8;
  const minGapSplitChars = Math.max(4, Math.min(10, Math.floor(maxChars * 0.28)));
  const lines = [];
  let currentText = "";
  let currentStart = 0;
  let currentEnd = 0;
  let currentStartWordIndex;
  let currentEndWordIndex;
  let currentReason = "scriptless_words";
  const flush = (reason = currentReason) => {
    const text = normalizeCaptionText(currentText).replace(/\n/g, "");
    if (text) {
      lines.push({
        text,
        start: currentStart,
        end: Math.max(currentStart + 0.05, currentEnd),
        startWordIndex: currentStartWordIndex,
        endWordIndex: currentEndWordIndex,
        reason,
      });
    }
    currentText = "";
    currentStart = 0;
    currentEnd = 0;
    currentStartWordIndex = undefined;
    currentEndWordIndex = undefined;
    currentReason = "scriptless_words";
  };
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    const text = normalizeCaptionText(unit.text).replace(/\n/g, "");
    if (!text) {
      continue;
    }
    if (!currentText) {
      currentText = text;
      currentStart = Math.max(0, unit.start);
      currentEnd = Math.max(currentStart, unit.end);
      currentStartWordIndex = unit.startWordIndex;
      currentEndWordIndex = unit.endWordIndex;
      currentReason = "scriptless_words";
    } else {
      const nextText = currentText + text;
      const candidateDuration = Math.max(0, unit.end - currentStart);
      const canSplitBeforeWord = !isJapaneseClosingPunctuation(text)
        && !isSmallKanaOrLongMark(text)
        && !shouldKeepJapaneseTimingBoundaryTogether(currentText, text);
      const shouldStartNewClause = endsWithJapaneseSentenceEndingForTiming(currentText)
        && startsNewJapaneseClauseAfterSentence(text);
      const splitReason = shouldStartNewClause
        ? "semantic_boundary"
        : nextText.length > maxChars
          ? "length_limit"
          : candidateDuration > softMaxDuration && currentText.length >= minGapSplitChars
            ? "duration_limit"
            : candidateDuration > hardMaxDuration && currentText.length >= 4
              ? "duration_limit"
              : undefined;
      const splitBefore = (
        canSplitBeforeWord
        && (
          shouldStartNewClause
          || (startsWithJapaneseCaptionDiscourseUnit(text) && currentText.length >= 4)
          || nextText.length > maxChars
          || (candidateDuration > softMaxDuration && currentText.length >= minGapSplitChars)
          || (candidateDuration > hardMaxDuration && currentText.length >= 4)
        )
      );
      if (splitBefore) {
        flush(splitReason || "semantic_boundary");
        currentText = text;
        currentStart = Math.max(0, unit.start);
        currentEnd = Math.max(currentStart, unit.end);
        currentStartWordIndex = unit.startWordIndex;
        currentEndWordIndex = unit.endWordIndex;
        currentReason = "scriptless_words";
      } else {
        currentText = nextText;
        currentEnd = Math.max(currentEnd, unit.end);
        currentEndWordIndex = unit.endWordIndex ?? currentEndWordIndex;
      }
    }
    const next = units[i + 1];
    const gapAfter = next ? Math.max(0, next.start - unit.end) : Number.POSITIVE_INFINITY;
    const nextText = next ? normalizeCaptionText(next.text).replace(/\n/g, "") : "";
    const nextShouldAttach = Boolean(nextText) && (
      isJapaneseClosingPunctuation(nextText)
      || isSmallKanaOrLongMark(nextText)
      || shouldKeepJapaneseTimingBoundaryTogether(currentText, nextText)
    );
    const duration = Math.max(0, currentEnd - currentStart);
    const flushReason = currentText.length >= maxChars
      ? "length_limit"
      : duration >= hardMaxDuration || (duration >= softMaxDuration && currentText.length >= minGapSplitChars)
        ? "duration_limit"
        : gapAfter >= 0.42
          ? "speech_gap"
          : currentReason;
    const shouldFlushAfter = (
      !next
      || (!nextShouldAttach && (
        (gapAfter >= 0.35 && isJapaneseCaptionDiscourseUnit(currentText) && currentText.length > 1)
        || (gapAfter >= 0.42 && endsWithJapaneseSentenceEndingForTiming(currentText) && currentText.length >= 3)
        || (gapAfter >= 0.42 && currentText.length >= minGapSplitChars)
        || currentText.length >= maxChars
        || duration >= hardMaxDuration
        || (duration >= softMaxDuration && currentText.length >= minGapSplitChars)
      ))
    );
    if (shouldFlushAfter) {
      flush(flushReason);
    }
  }
  return lines;
}

export function buildScriptlessSegmentsFromTimedWords(words, lineCount, maxChars, transcriptText) {
  return buildSubtitleLinesFromTimedWords(words, lineCount, maxChars, transcriptText)
    .map((line) => ({
      text: line.text,
      start: line.start,
      end: line.end,
      startWordIndex: line.startWordIndex,
      endWordIndex: line.endWordIndex,
      reason: line.reason,
    }));
}

// ---------------------------------------------------------------------------
// Scripted (forced-alignment) segmentation (extension.ts ~10230-10368, 11178)
// ---------------------------------------------------------------------------

function buildScriptedSegmentsFromSpeech(scriptText, duration, ranges, lineCount, maxChars) {
  const chunks = splitCaptionTextIntoChunks(scriptText, lineCount, maxChars);
  if (chunks.length === 0) {
    return [];
  }
  const speechRanges = ranges.length > 0 ? ranges : [{ start: 0, end: Math.max(duration, chunks.length * 1.8) }];
  const totalSpeech = speechRanges.reduce((sum, range) => sum + Math.max(0, range.end - range.start), 0) || Math.max(duration, chunks.length * 1.8);
  const totalWeight = chunks.reduce((sum, chunk) => sum + Math.max(1, chunk.length), 0);
  let rangeIndex = 0;
  let offsetInRange = 0;
  const segments = [];
  for (const chunk of chunks) {
    const target = Math.max(0.45, totalSpeech * (Math.max(1, chunk.length) / totalWeight));
    while (rangeIndex < speechRanges.length - 1 && offsetInRange >= (speechRanges[rangeIndex].end - speechRanges[rangeIndex].start)) {
      rangeIndex += 1;
      offsetInRange = 0;
    }
    const startRange = speechRanges[rangeIndex] || speechRanges[speechRanges.length - 1];
    const start = Math.min(startRange.end, startRange.start + offsetInRange);
    let remaining = target;
    let end = start;
    while (remaining > 0 && rangeIndex < speechRanges.length) {
      const range = speechRanges[rangeIndex];
      const available = Math.max(0, range.end - (range.start + offsetInRange));
      const consume = Math.min(available, remaining);
      end = range.start + offsetInRange + consume;
      remaining -= consume;
      offsetInRange += consume;
      if (remaining > 0 && rangeIndex < speechRanges.length - 1) {
        rangeIndex += 1;
        offsetInRange = 0;
      } else {
        break;
      }
    }
    if (end <= start) {
      end = start + target;
    }
    segments.push({ text: chunk, start, end });
  }
  return segments;
}

function chooseAlignedWordBoundaryIndex(words, prefixWeights, startIndex, targetConsumedWeight) {
  let bestIndex = Math.min(Math.max(startIndex, 0), words.length - 1);
  let bestScore = Number.POSITIVE_INFINITY;
  const averageWeight = Math.max(1, prefixWeights[prefixWeights.length - 1] / Math.max(1, words.length));
  for (let i = bestIndex; i < words.length; i += 1) {
    const boundaryWeight = prefixWeights[i + 1];
    const distance = Math.abs(boundaryWeight - targetConsumedWeight);
    if (boundaryWeight < targetConsumedWeight - averageWeight * 10) {
      continue;
    }
    if (boundaryWeight > targetConsumedWeight + averageWeight * 10 && distance > bestScore + averageWeight * 4) {
      break;
    }
    const wordText = words[i]?.text || "";
    const nextText = words[i + 1]?.text || "";
    const gapAfter = words[i + 1] ? Math.max(0, words[i + 1].start - words[i].end) : 1;
    let score = distance;
    if (gapAfter >= 0.18) {
      score -= Math.min(averageWeight * 10, gapAfter * averageWeight * 18);
    }
    if (/[、。，．。！？!?]$/.test(wordText)) {
      score -= averageWeight * 5;
    }
    if (/^[、。，．。！？!?）」』】］〕〉》〙〗）\]]/.test(nextText) || /^[ぁぃぅぇぉゃゅょゎァィゥェォャュョヮっッー]/.test(nextText)) {
      score += averageWeight * 12;
    }
    if (score < bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function splitTimedSegmentAtSpeechGaps(segment, words, maxChars) {
  const safeText = normalizeCaptionText(segment.text).replace(/\n/g, "");
  if (safeText.length < Math.max(18, Math.floor(maxChars * 0.75))) {
    return [{ ...segment, text: safeText }];
  }
  const wordsInSegment = words.filter((word) => (
    word.end > segment.start + 0.01
    && word.start < segment.end - 0.01
  ));
  if (wordsInSegment.length < 2) {
    return [{ ...segment, text: safeText }];
  }
  const weights = wordsInSegment.map((word) => Math.max(1, normalizeCaptionComparableText(word.text).length || word.text.length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  // Speech-rate-adaptive pause threshold: a fast talker's 0.35s pause is a
  // real break while a slow talker needs a longer one (fixed 0.42s before).
  const spanSeconds = Math.max(0.4, segment.end - segment.start);
  const charsPerSecond = totalWeight / spanSeconds;
  const gapThreshold = Math.min(0.58, Math.max(0.32, charsPerSecond > 0.5 ? 3.2 / charsPerSecond : 0.42));
  let best = null;
  let beforeWeight = 0;
  for (let i = 0; i < wordsInSegment.length - 1; i += 1) {
    beforeWeight += weights[i];
    const afterWeight = totalWeight - beforeWeight;
    const gap = Math.max(0, wordsInSegment[i + 1].start - wordsInSegment[i].end);
    if (gap < gapThreshold || beforeWeight < 6 || afterWeight < 6) {
      continue;
    }
    const balancePenalty = Math.abs(beforeWeight - afterWeight) / Math.max(1, totalWeight);
    const score = balancePenalty - Math.min(1.2, gap) * 1.4;
    if (!best || score < best.score) {
      best = { index: i, gap, beforeWeight, score };
    }
  }
  if (!best) {
    return [{ ...segment, text: safeText }];
  }
  const targetIndex = Math.max(1, Math.min(safeText.length - 1, Math.round(safeText.length * (best.beforeWeight / totalWeight))));
  const splitIndex = findSubtitleSplitIndexNearTarget(safeText, targetIndex, maxChars);
  const firstText = safeText.slice(0, splitIndex).trim();
  const secondText = safeText.slice(splitIndex).trim();
  if (
    !firstText
    || !secondText
    || firstText.length > maxChars
    || secondText.length > maxChars
    || firstText.length < 6
    || secondText.length < 6
    || isAwkwardJapaneseCaptionBoundary(firstText, secondText)
  ) {
    return [{ ...segment, text: safeText }];
  }
  const firstEnd = Math.max(segment.start + 0.15, Math.min(segment.end, wordsInSegment[best.index].end));
  const secondStart = Math.min(segment.end - 0.15, Math.max(segment.start, wordsInSegment[best.index + 1].start));
  if (secondStart <= firstEnd) {
    return [{ ...segment, text: safeText }];
  }
  return [
    { text: firstText, start: segment.start, end: firstEnd },
    { text: secondText, start: secondStart, end: segment.end },
  ];
}

export function buildScriptedSegmentsFromAlignedWords(scriptText, words, duration, lineCount, maxChars) {
  const chunks = splitCaptionTextIntoChunks(scriptText, lineCount, maxChars);
  const sortedWords = words
    .filter((item) => item.text && Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
    .sort((a, b) => a.start - b.start);
  if (chunks.length === 0 || sortedWords.length === 0) {
    return buildScriptedSegmentsFromSpeech(scriptText, duration, [{ start: 0, end: Math.max(duration, 1) }], lineCount, maxChars);
  }
  const chunkWeights = chunks.map((chunk) => Math.max(1, normalizeCaptionComparableText(chunk).length || chunk.length));
  const totalChunkWeight = chunkWeights.reduce((sum, weight) => sum + weight, 0);
  const wordWeights = sortedWords.map((word) => Math.max(1, normalizeCaptionComparableText(word.text).length || word.text.length));
  const totalWordWeight = wordWeights.reduce((sum, weight) => sum + weight, 0);
  const prefixWeights = wordWeights.reduce((prefix, weight) => {
    prefix.push(prefix[prefix.length - 1] + weight);
    return prefix;
  }, [0]);
  const segments = [];
  let wordIndex = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const targetConsumed = i === chunks.length - 1
      ? totalWordWeight
      : Math.max(prefixWeights[wordIndex] + 1, Math.round(totalWordWeight * (chunkWeights.slice(0, i + 1).reduce((sum, weight) => sum + weight, 0) / totalChunkWeight)));
    const startWord = sortedWords[Math.min(wordIndex, sortedWords.length - 1)];
    const endWordIndex = i === chunks.length - 1
      ? sortedWords.length - 1
      : chooseAlignedWordBoundaryIndex(sortedWords, prefixWeights, wordIndex, targetConsumed);
    const endWord = sortedWords[Math.min(Math.max(endWordIndex, wordIndex), sortedWords.length - 1)];
    const start = startWord?.start ?? (segments[segments.length - 1]?.end ?? 0);
    let end = endWord?.end ?? start + Math.max(0.45, duration * (chunkWeights[i] / totalChunkWeight));
    if (end <= start) {
      end = start + Math.max(0.45, duration * (chunkWeights[i] / totalChunkWeight));
    }
    segments.push({ text: chunk, start, end });
    wordIndex = Math.min(sortedWords.length - 1, endWordIndex + 1);
  }
  const gapAwareSegments = [];
  for (const segment of segments) {
    gapAwareSegments.push(...splitTimedSegmentAtSpeechGaps(segment, sortedWords, maxChars));
  }
  return gapAwareSegments;
}

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

export function audioMimeTypeForFile(filePath) {
  switch (extname(String(filePath || "")).toLowerCase()) {
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".m4a": return "audio/mp4";
    case ".aac": return "audio/aac";
    case ".ogg": return "audio/ogg";
    case ".opus": return "audio/opus";
    case ".webm": return "audio/webm";
    case ".flac": return "audio/flac";
    case ".mp4": return "audio/mp4";
    default: return "audio/mpeg";
  }
}

async function probeAudioDurationSeconds(audioPath) {
  const ffprobe = nonEmptyString(process.env.FFPROBE_PATH) || "ffprobe";
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let child;
    try {
      child = spawn(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "json", audioPath], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish(0);
      return;
    }
    child.on("error", () => finish(0));
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish(0);
        return;
      }
      try {
        finish(normalizeDurationSeconds(Number(JSON.parse(stdout)?.format?.duration)));
      } catch {
        finish(0);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Cloud API client (extension.ts ~5505-5606, 11429-11508)
// ---------------------------------------------------------------------------

async function reserveSubtitleCredits({ model, durationSeconds, requestId }) {
  const response = await buzzAssistFetch(resolveSubtitleCreditsUrl(), {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "reserve", model, durationSeconds, requestId }),
    timeoutMs: 60_000,
  });
  const payload = await response.json().catch(() => undefined);
  if (response.status === 404 || response.status === 405 || response.status === 501 || response.status >= 500) {
    // Credits endpoint unavailable; proceed without a reservation (bypass).
    return undefined;
  }
  if (!response.ok) {
    throw new Error(typeof payload?.error === "string" ? payload.error : `Subtitle credit reservation failed: ${response.status}`);
  }
  const credits = Number(payload?.credits ?? 0);
  return {
    credits: Number.isFinite(credits) ? Math.max(0, Math.round(credits)) : 0,
    estimatedCostYen: typeof payload?.estimatedCostYen === "number" ? payload.estimatedCostYen : undefined,
    requestId: typeof payload?.requestId === "string" ? payload.requestId : (requestId || ""),
    reservationToken: typeof payload?.reservationToken === "string" ? payload.reservationToken : undefined,
  };
}

async function refundReservedSubtitleCredits(reservation) {
  if (!reservation?.reservationToken || reservation.credits <= 0) {
    return;
  }
  try {
    await buzzAssistFetch(resolveSubtitleCreditsUrl(), {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "refund", reservationToken: reservation.reservationToken }),
      timeoutMs: 60_000,
    });
  } catch {
    // Best-effort: the server-side ledger uses idempotent entry keys, and the
    // original generation error should stay the surfaced failure.
  }
}

function subtitleChunkFileName(fileName, index) {
  const ext = ".mp3";
  const base = basename(fileName || "audio", extname(fileName || "audio")).replace(/[^\w.-]+/g, "-") || "audio";
  return `${base}.part-${String(index + 1).padStart(3, "0")}${ext}`;
}

async function splitAudioForDirectSubtitleUpload(audioPath, durationSeconds) {
  const duration = normalizeDurationSeconds(durationSeconds);
  if (duration <= 0) return { chunks: [], cleanup: () => Promise.resolve() };

  const dir = join(tmpdir(), `codex-excalidraw-subtitle-chunks-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  await mkdir(dir, { recursive: true });
  const chunks = [];
  let keepStart = 0;
  let index = 0;
  while (keepStart < duration - 0.001) {
    const keepEnd = Math.min(duration, keepStart + SUBTITLE_DIRECT_CHUNK_KEEP_SECONDS);
    const start = Math.max(0, keepStart - (index > 0 ? SUBTITLE_DIRECT_CHUNK_OVERLAP_SECONDS : 0));
    const end = Math.min(duration, keepEnd + (keepEnd < duration ? SUBTITLE_DIRECT_CHUNK_OVERLAP_SECONDS : 0));
    const chunkPath = join(dir, `chunk-${String(index + 1).padStart(3, "0")}.mp3`);
    await runFfmpegQuiet(
      [
        "-y",
        "-v", "error",
        "-ss", String(start),
        "-i", audioPath,
        "-t", String(Math.max(0.001, end - start)),
        "-map", "0:a:0",
        "-vn",
        "-ac", "1",
        "-af", "highpass=f=80",
        "-ar", "22050",
        "-b:a", "64k",
        "-f", "mp3",
        chunkPath,
      ],
      Math.max(120_000, Math.ceil((end - start) * 1500)),
    );
    const chunkStat = await stat(chunkPath);
    if (chunkStat.size <= 0) {
      throw new Error("Subtitle audio chunking produced an empty file.");
    }
    if (chunkStat.size > SUBTITLE_CLOUD_DIRECT_AUDIO_MAX_BYTES) {
      throw new Error(`Subtitle audio chunk is too large for direct upload (${Math.round(chunkStat.size / 1024 / 1024)}MB).`);
    }
    chunks.push({ path: chunkPath, start, end, keepStart, keepEnd, index });
    keepStart = keepEnd;
    index += 1;
  }
  return {
    chunks,
    cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}),
  };
}

function mergeChunkedSubtitlePayloads(parts) {
  const words = [];
  let provider = "";
  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const { chunk, payload } = parts[partIndex];
    provider = nonEmptyString(payload.provider) || provider;
    const isLast = partIndex === parts.length - 1;
    for (const word of normalizeTimedWords(payload.words)) {
      const start = Math.max(0, chunk.start + Math.max(0, word.start));
      const end = Math.max(start, chunk.start + Math.max(0, word.end));
      const midpoint = (start + end) / 2;
      if (midpoint < chunk.keepStart - 0.05) continue;
      if (!isLast && midpoint >= chunk.keepEnd + 0.05) continue;
      words.push({ ...word, start, end });
    }
  }
  words.sort((a, b) => a.start - b.start || a.end - b.end);
  const deduped = [];
  for (const word of words) {
    const previous = deduped[deduped.length - 1];
    if (
      previous
      && previous.text === word.text
      && Math.abs(previous.start - word.start) < 0.08
      && Math.abs(previous.end - word.end) < 0.08
    ) {
      continue;
    }
    deduped.push(word);
  }
  return {
    provider: `${provider || "elevenlabs-scribe-v2-cloud"}-chunked`,
    text: deduped.map((word) => word.text).join(""),
    words: deduped,
  };
}

async function requestChunkedScribeGeneration({ audioPath, fileName, requestId, reservationToken, durationSeconds }) {
  const chunked = await splitAudioForDirectSubtitleUpload(audioPath, durationSeconds);
  if (chunked.chunks.length <= 1) {
    await chunked.cleanup();
    return requestSubtitleGeneration({
      audioPath,
      mimeType: audioMimeTypeForFile(audioPath),
      fileName,
      model: "elevenlabs-scribe-v2",
      requestId,
      reservationToken,
      forceDirectUpload: false,
    });
  }

  const parts = [];
  try {
    for (const chunk of chunked.chunks) {
      const payload = await requestSubtitleGeneration({
        audioPath: chunk.path,
        mimeType: "audio/mpeg",
        fileName: subtitleChunkFileName(fileName, chunk.index),
        model: "elevenlabs-scribe-v2",
        requestId,
        reservationToken,
        forceDirectUpload: true,
      });
      parts.push({ chunk, payload });
    }
    return mergeChunkedSubtitlePayloads(parts);
  } finally {
    await chunked.cleanup();
  }
}

async function requestSubtitleGeneration({ audioPath, mimeType, fileName, model, requestId, reservationToken, scriptText, forceDirectUpload = false }) {
  const buffer = await readFile(audioPath);
  const form = new FormData();
  form.append("model", model);
  form.append("requestId", requestId || "");
  form.append("reservationToken", reservationToken || "");
  if (!forceDirectUpload && buffer.byteLength > SUBTITLE_CLOUD_DIRECT_AUDIO_MAX_BYTES) {
    const audioUrl = await uploadBufferToFalStorage(buffer, { mimeType, fileName });
    form.append("audioUrl", audioUrl);
    form.append("audioFileName", fileName);
  } else if (buffer.byteLength > SUBTITLE_CLOUD_DIRECT_AUDIO_MAX_BYTES) {
    throw new Error(`Subtitle audio is too large for direct upload (${Math.round(buffer.byteLength / 1024 / 1024)}MB).`);
  } else {
    form.append("audio", new Blob([buffer], { type: mimeType }), fileName);
  }
  if (model === "elevenlabs-forced-alignment") {
    const safeScriptText = nonEmptyString(scriptText);
    if (!safeScriptText) {
      throw new Error("scriptText is required for elevenlabs-forced-alignment.");
    }
    form.append("scriptText", safeScriptText);
  }
  const response = await buzzAssistFetch(resolveSubtitleGenerateUrl(), {
    body: form,
    timeoutMs: SUBTITLE_GENERATE_TIMEOUT_MS,
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(typeof payload?.error === "string" ? payload.error : `Subtitle cloud generation failed: ${response.status}`);
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Subtitle cloud generation returned no JSON payload.");
  }
  return payload;
}

// Port of parseGenericTimedWords word mapping (extension.ts ~11233-1270).
function normalizeTimedWords(rawWords) {
  if (!Array.isArray(rawWords)) {
    return [];
  }
  return rawWords.flatMap((item) => {
    const wordText = typeof item?.text === "string" ? item.text : (typeof item?.word === "string" ? item.word : "");
    const start = Number(item?.start ?? item?.start_time ?? item?.startTime);
    const end = Number(item?.end ?? item?.end_time ?? item?.endTime);
    const type = typeof item?.type === "string" ? item.type : undefined;
    const speakerId = typeof item?.speaker_id === "string"
      ? item.speaker_id
      : typeof item?.speakerId === "string"
        ? item.speakerId
        : undefined;
    const confidence = Number(item?.confidence);
    const eventType = typeof item?.event_type === "string"
      ? item.event_type
      : typeof item?.eventType === "string"
        ? item.eventType
        : type;
    if (!wordText.trim() || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return [];
    }
    if ((type || "").toLowerCase() === "spacing") {
      return [];
    }
    return [{
      text: wordText.trim(),
      start,
      end,
      type,
      speakerId,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : undefined,
      eventType,
    }];
  });
}

function runFfmpegQuiet(args, timeoutMs = 120_000) {
  const ffmpeg = nonEmptyString(process.env.FFMPEG_PATH) || "ffmpeg";
  return new Promise((resolve, reject) => {
    let stderr = "";
    let child;
    try {
      child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("ffmpeg timed out."));
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stderr);
      else reject(new Error(stderr.trim().slice(-300) || `ffmpeg exited with code ${code}`));
    });
  });
}

// Video containers are accepted as subtitle sources: ffmpeg's audio re-encode
// in prepareAudioForTranscription doubles as the extraction step.
const SUBTITLE_VIDEO_SOURCE_EXTS = new Set([".mp4", ".mov", ".webm", ".m4v", ".avi", ".mkv", ".mpg", ".mpeg", ".ogv", ".3gp", ".3g2"]);

export function isVideoSourceFile(filePath) {
  return SUBTITLE_VIDEO_SOURCE_EXTS.has(extname(String(filePath || "")).toLowerCase());
}

// Long videos should not pay for full loudness normalization before upload.
// First try a stream copy into M4A for AAC sources; that is much faster for
// podcast-length MP4s. Fall back to a small mono speech MP3 when the source
// codec/container cannot be copied into M4A.
export async function prepareAudioForTranscription(audioPath) {
  const tempDir = join(tmpdir(), "codex-excalidraw-subtitles");
  await mkdir(tempDir, { recursive: true });
  const copiedPath = join(tempDir, `audio-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.m4a`);
  try {
    await runFfmpegQuiet(
      [
        "-y",
        "-v", "error",
        "-i", audioPath,
        "-map", "0:a:0",
        "-vn",
        "-c:a", "copy",
        copiedPath,
      ],
      5 * 60 * 1000,
    );
    return {
      path: copiedPath,
      normalized: false,
      meanVolume: null,
      cleanup: () => rm(copiedPath, { force: true }).catch(() => {}),
    };
  } catch {
    await rm(copiedPath, { force: true }).catch(() => {});
  }

  try {
    // Keep this filter intentionally light. EBU loudnorm is higher quality but
    // expensive on long podcasts; highpass removes low-frequency rumble while
    // preserving near-realtime extraction speed.
    const normalizedPath = join(tempDir, `normalized-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp3`);
    await runFfmpegQuiet(
      [
        "-y",
        "-i", audioPath,
        "-vn",
        "-ac", "1",
        "-af", "highpass=f=80",
        "-ar", "22050",
        "-b:a", "64k",
        normalizedPath,
      ],
      30 * 60 * 1000,
    );
    return {
      path: normalizedPath,
      normalized: true,
      meanVolume: null,
      cleanup: () => rm(normalizedPath, { force: true }).catch(() => {}),
    };
  } catch {
    return { path: audioPath, normalized: false, meanVolume: null };
  }
}

// Post-generation QA: compare cue windows against actual speech energy so we
// can flag "subtitle over silence" and "speech with no subtitle" cases.
export async function detectSpeechRanges(audioPath, durationSeconds) {
  const stderr = await runFfmpegQuiet(
    ["-hide_banner", "-i", audioPath, "-af", "silencedetect=noise=-32dB:d=0.6", "-f", "null", "-"],
    300_000,
  );
  const silences = [];
  let openStart = null;
  for (const line of stderr.split("\n")) {
    const startMatch = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/);
    if (startMatch) {
      openStart = Math.max(0, Number(startMatch[1]));
      continue;
    }
    const endMatch = line.match(/silence_end:\s*(-?\d+(?:\.\d+)?)/);
    if (endMatch) {
      silences.push({ start: openStart ?? 0, end: Math.max(0, Number(endMatch[1])) });
      openStart = null;
    }
  }
  if (openStart !== null && durationSeconds > openStart) {
    silences.push({ start: openStart, end: durationSeconds });
  }
  silences.sort((a, b) => a.start - b.start);
  const speech = [];
  let cursor = 0;
  for (const silence of silences) {
    if (silence.start > cursor + 0.05) speech.push({ start: cursor, end: silence.start });
    cursor = Math.max(cursor, silence.end);
  }
  if (durationSeconds > cursor + 0.05) speech.push({ start: cursor, end: durationSeconds });
  return speech;
}

function collectSpeechAlignmentIssues(subtitleLines, speechRanges) {
  if (!Array.isArray(speechRanges) || speechRanges.length === 0) return [];
  const issues = [];
  const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  subtitleLines.forEach((cue, index) => {
    if (cue.end - cue.start < 0.4) return;
    const covered = speechRanges.reduce((sum, range) => sum + overlap(cue, range), 0);
    if (covered < 0.05) {
      issues.push({ index, type: "cue_in_silence", detail: `${cue.start.toFixed(2)}s-${cue.end.toFixed(2)}s` });
    }
  });
  for (const range of speechRanges) {
    if (range.end - range.start < 1.2) continue;
    const covered = subtitleLines.reduce((sum, cue) => sum + overlap(range, cue), 0);
    if (covered < (range.end - range.start) * 0.25) {
      issues.push({ index: -1, type: "uncaptioned_speech", detail: `${range.start.toFixed(1)}s-${range.end.toFixed(1)}s` });
    }
  }
  return issues;
}

function kataToHira(value) {
  return value.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

function hiraToKata(value) {
  return value.replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}

function normalizeGlossary(glossary) {
  const base = (Array.isArray(glossary) ? glossary : [])
    .map((term) => ({ from: String(term?.from ?? "").trim(), to: String(term?.to ?? "").trim() }))
    .filter((term) => term.from && term.from !== term.to);
  // ASR output flips between kana scripts (バズアシ/ばずあし), so match the
  // katakana and hiragana readings of each entry too.
  const expanded = [];
  const seen = new Set();
  for (const term of base) {
    for (const from of [term.from, kataToHira(term.from), hiraToKata(term.from)]) {
      if (!from || from === term.to || seen.has(from)) continue;
      seen.add(from);
      expanded.push({ from, to: term.to });
    }
  }
  return expanded.sort((a, b) => b.from.length - a.from.length);
}

// Post-ASR terminology correction (Youtube-AGI's 用語辞書): applied to the
// transcript and to each timed word so downstream segmentation sees the
// corrected spelling.
export function applySubtitleGlossary(text, words, glossary) {
  const terms = normalizeGlossary(glossary);
  if (terms.length === 0) return { text, words, replacements: 0 };
  let replacements = 0;
  const replaceAll = (value) => {
    let next = String(value ?? "");
    for (const term of terms) {
      if (next.includes(term.from)) {
        replacements += next.split(term.from).length - 1;
        next = next.split(term.from).join(term.to);
      }
    }
    return next;
  };
  const nextText = replaceAll(text);
  const nextWords = words.map((word) => {
    const nextWordText = replaceAll(word.text);
    return nextWordText === word.text ? word : { ...word, text: nextWordText };
  });
  return { text: nextText, words: nextWords, replacements };
}

// Words-only transcription (Scribe v2) for callers that segment themselves,
// e.g. the tempo-cut scribe mode. Reserves and refunds credits like the SRT
// path does.
export async function transcribeAudioWords(options = {}) {
  const audioPath = nonEmptyString(options.audioPath);
  if (!audioPath) throw new Error("audioPath is required.");

  let durationSeconds = normalizeDurationSeconds(options.durationSeconds);
  if (durationSeconds <= 0) durationSeconds = await probeAudioDurationSeconds(audioPath);
  if (durationSeconds <= 0) {
    throw new Error("Could not determine audio duration for transcription (install ffprobe or pass durationSeconds).");
  }

  const model = "elevenlabs-scribe-v2";
  const requestId = nonEmptyString(options.requestId) || crypto.randomUUID();
  const prepared = options.normalizeAudio === false
    ? { path: audioPath, normalized: false }
    : await prepareAudioForTranscription(audioPath);

  const reservation = await reserveSubtitleCredits({ model, durationSeconds, requestId });
  let payload;
  try {
    payload = await requestChunkedScribeGeneration({
      audioPath: prepared.path,
      fileName: basename(prepared.path) || "audio.mp3",
      requestId: reservation?.requestId || requestId,
      reservationToken: reservation?.reservationToken,
      durationSeconds,
    });
  } catch (error) {
    await refundReservedSubtitleCredits(reservation);
    throw error;
  } finally {
    prepared.cleanup?.();
  }

  const rawText = typeof payload.text === "string" ? payload.text : "";
  const rawWords = normalizeTimedWords(payload.words);
  if (rawWords.length === 0 && !rawText.trim()) {
    await refundReservedSubtitleCredits(reservation);
    throw new Error("Transcription returned no words and no text.");
  }
  const { text, words, replacements } = applySubtitleGlossary(rawText, rawWords, options.glossary);
  return {
    text,
    words,
    provider: nonEmptyString(payload.provider) || `${model}-cloud`,
    model,
    requestId: reservation?.requestId || requestId,
    durationSeconds,
    credits: reservation?.credits ?? 0,
    estimatedCostYen: reservation?.estimatedCostYen,
    audioNormalized: prepared.normalized,
    glossaryReplacements: replacements,
  };
}

// Lightweight quality gate over the emitted cues: flags overlaps, hard
// line-length violations, and blink-short cues (what Youtube-AGI's
// validate/repair loop guards against).
export function validateSubtitleLines(subtitleLines, { maxChars, lineCount }) {
  const issues = [];
  for (let index = 0; index < subtitleLines.length; index += 1) {
    const cue = subtitleLines[index];
    const lines = String(cue.text ?? "").split("\n");
    if (lines.length > lineCount) {
      issues.push({ index, type: "too_many_lines", detail: `${lines.length} lines` });
    }
    for (const line of lines) {
      if (line.length > maxChars + 4) {
        issues.push({ index, type: "line_too_long", detail: `${line.length} chars` });
        break;
      }
    }
    if (cue.end - cue.start < 0.25) {
      issues.push({ index, type: "cue_too_short", detail: `${Math.round((cue.end - cue.start) * 1000)}ms` });
    }
    const cueChars = lines.join("").length;
    const cueSeconds = cue.end - cue.start;
    if (cueSeconds > 0 && cueChars >= 8 && cueChars / cueSeconds > SUBTITLE_MAX_CHARS_PER_SECOND) {
      issues.push({ index, type: "reading_speed", detail: `${(cueChars / cueSeconds).toFixed(1)} chars/s` });
    }
    const next = subtitleLines[index + 1];
    if (next && next.start < cue.end - 0.001) {
      issues.push({ index, type: "overlap", detail: `${Math.round((cue.end - next.start) * 1000)}ms` });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function generateSubtitleSrt(options = {}) {
  const audioPath = nonEmptyString(options.audioPath);
  if (!audioPath) {
    throw new Error("audioPath is required.");
  }

  let scriptText = nonEmptyString(options.scriptText);
  const scriptPath = nonEmptyString(options.scriptPath);
  if (!scriptText && scriptPath) {
    scriptText = (await readFile(scriptPath, "utf8")).trim();
  }

  const mode = options.mode === "scripted" || options.mode === "scriptless"
    ? options.mode
    : (scriptText ? "scripted" : "scriptless");
  if (mode === "scripted" && !scriptText) {
    throw new Error("scriptText or scriptPath is required for scripted mode.");
  }

  const model = normalizeSubtitleModel(options.model, mode);
  if (model === "elevenlabs-forced-alignment" && !scriptText) {
    throw new Error("scriptText is required for the elevenlabs-forced-alignment model.");
  }

  const lineCount = normalizeSubtitleLineCount(options.lineCount ?? DEFAULT_SUBTITLE_LINE_COUNT);
  const maxChars = options.maxCharsPerLine == null
    ? defaultSubtitleMaxCharsForLineCount(lineCount)
    : normalizeSubtitleMaxChars(options.maxCharsPerLine);
  const holdSeconds = normalizeSubtitleHoldSeconds(options.holdSeconds ?? DEFAULT_SUBTITLE_HOLD_SECONDS);
  const punctuationMode = normalizeSubtitlePunctuationMode(options.punctuationMode ?? "auto");
  const fillerMode = normalizeSubtitleFillerMode(options.fillerMode ?? "safe");

  let durationSeconds = normalizeDurationSeconds(options.durationSeconds);
  if (durationSeconds <= 0) {
    durationSeconds = await probeAudioDurationSeconds(audioPath);
  }
  if (durationSeconds <= 0) {
    throw new Error(
      "Could not determine audio duration: ffprobe is not available (set FFPROBE_PATH or install ffmpeg) and options.durationSeconds was not provided.",
    );
  }

  const requestId = nonEmptyString(options.requestId) || crypto.randomUUID();
  // Load the morphological tokenizer (best-effort) so segmentation can use
  // bunsetsu units; falls back to Intl.Segmenter when unavailable.
  await ensureJapaneseTokenizer().catch(() => null);
  // Video sources always go through ffmpeg so the audio track gets extracted.
  const prepared = options.normalizeAudio === false && !isVideoSourceFile(audioPath)
    ? { path: audioPath, normalized: false }
    : await prepareAudioForTranscription(audioPath);

  const reservation = await reserveSubtitleCredits({ model, durationSeconds, requestId });

  let payload;
  try {
    payload = model === "elevenlabs-scribe-v2"
      ? await requestChunkedScribeGeneration({
          audioPath: prepared.path,
          fileName: basename(prepared.path) || "audio.mp3",
          requestId: reservation?.requestId || requestId,
          reservationToken: reservation?.reservationToken,
          durationSeconds,
        })
      : await requestSubtitleGeneration({
          audioPath: prepared.path,
          mimeType: audioMimeTypeForFile(prepared.path),
          fileName: basename(prepared.path) || "audio.mp3",
          model,
          requestId: reservation?.requestId || requestId,
          reservationToken: reservation?.reservationToken,
          scriptText: model === "elevenlabs-forced-alignment" ? scriptText : undefined,
        });
  } catch (error) {
    await refundReservedSubtitleCredits(reservation);
    throw error;
  } finally {
    prepared.cleanup?.();
  }

  const rawText = typeof payload.text === "string" ? payload.text : "";
  const rawWords = normalizeTimedWords(payload.words);
  const provider = nonEmptyString(payload.provider) || `${model}-cloud`;
  if (rawWords.length === 0 && !rawText.trim()) {
    await refundReservedSubtitleCredits(reservation);
    throw new Error(`Subtitle cloud generation (${model}) returned no words and no transcript text.`);
  }
  const glossaryResult = applySubtitleGlossary(rawText, rawWords, options.glossary);
  const text = glossaryResult.text;
  const words = glossaryResult.words;

  const buildLines = (effectiveMaxChars) => {
    let segments = [];
    if (mode === "scriptless") {
      const captionWords = filterSubtitleTimedWordsByFillerMode(words, fillerMode);
      if (captionWords.length > 0) {
        const captionText = captionWords.length === words.length
          ? text
          : captionWords.map(getCaptionWordText).join("");
        segments = buildScriptlessSegmentsFromTimedWords(captionWords, lineCount, effectiveMaxChars, captionText);
      } else if (text.trim()) {
        segments = buildScriptedSegmentsFromSpeech(text, durationSeconds, [{ start: 0, end: durationSeconds }], lineCount, effectiveMaxChars);
      }
    } else if (words.length > 0) {
      segments = buildScriptedSegmentsFromAlignedWords(scriptText, words, durationSeconds, lineCount, effectiveMaxChars);
    } else {
      // No aligned words came back: deterministic even-spread fallback over the
      // full duration (original used local silence detection here).
      segments = buildScriptedSegmentsFromSpeech(scriptText, durationSeconds, [{ start: 0, end: durationSeconds }], lineCount, effectiveMaxChars);
    }
    if (segments.length === 0) return null;
    return buildSubtitleLinesFromSegments(segments, {
      lineCount,
      maxChars: effectiveMaxChars,
      holdSeconds,
      punctuationMode,
      durationSeconds,
    });
  };

  // Validate-and-retry: when the first pass produces quality violations,
  // rebuild once with a tighter character budget and keep the cleaner result
  // (the single-pass version of Youtube-AGI's validate/repair loop).
  let subtitleLines = buildLines(maxChars);
  if (!subtitleLines) {
    await refundReservedSubtitleCredits(reservation);
    throw new Error("No subtitle segments could be built from the audio or script.");
  }
  let qualityIssues = validateSubtitleLines(subtitleLines, { maxChars, lineCount });
  let qualityRetried = false;
  if (qualityIssues.length > 0) {
    const retryMaxChars = Math.max(8, maxChars - 2);
    const retryLines = retryMaxChars < maxChars ? buildLines(retryMaxChars) : null;
    if (retryLines) {
      const retryIssues = validateSubtitleLines(retryLines, { maxChars, lineCount });
      if (retryIssues.length < qualityIssues.length) {
        subtitleLines = retryLines;
        qualityIssues = retryIssues;
        qualityRetried = true;
      }
    }
  }
  // Speech-energy QA (best effort): flag cues sitting on silence and speech
  // stretches with no caption. Warnings only — they never fail generation.
  let speechAlignmentIssues = [];
  try {
    const speechRanges = await detectSpeechRanges(audioPath, durationSeconds);
    speechAlignmentIssues = collectSpeechAlignmentIssues(subtitleLines, speechRanges);
  } catch {
    // ffmpeg unavailable or probe failed — skip QA
  }

  const srtText = renderSrt(subtitleLines);

  return {
    srtText,
    subtitleLines,
    text,
    words,
    provider,
    model,
    mode,
    credits: reservation?.credits ?? 0,
    estimatedCostYen: reservation?.estimatedCostYen,
    requestId: reservation?.requestId || requestId,
    durationSeconds,
    glossaryReplacements: glossaryResult.replacements,
    quality: {
      issues: [...qualityIssues, ...speechAlignmentIssues],
      retried: qualityRetried,
    },
  };
}
