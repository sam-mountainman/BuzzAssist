#!/usr/bin/env node
// ハーネス台帳（Claude Code / Codex 共通）
//
// 個々の運営者へ渡したハーネスを、こちら側から一望するための入口。
//
//   node scripts/harness-registry.mjs list          # 何が作れるか
//   node scripts/harness-registry.mjs match --want "漫画で解説する動画"
//   node scripts/harness-registry.mjs gaps          # 横断で見た抜け
//
// なぜ台帳が要るか:
// 2つ目のハーネスを作った時点で、外部サインオフ・有償APIのリトライ・
// 指紋キャッシュ・並列制御・原子的書き込み・音声品質ゲート・コンタクトシート監査の
// **7概念すべてが両方で独立に実装され、再利用は1箇所だけ**という状態になった。
// その結果、同じ規則が2箇所で食い違い、片方だけが古いまま動くバグを
// 実際に何度も出した。3つ目を足す前に、何が既にあるのかが見える必要がある。
//
// このファイルが読むのは config/harnesses/*.harness.json だけで、
// クライアント名やチャンネル名は入れない。ここは「何が作れるか」の
// 宣言であって、誰のためのものかの記録ではない。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectCli } from "../lib/cliEntrypoint.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS_DIR = path.join(REPO_ROOT, "config", "harnesses");

// 宣言に入っていてはいけない語。この台帳は共有される前提なので、
// 特定の運営者を指す語が1つでもあれば読み込みを拒否する。
// ここは運営者が増えたら足す——一括置換で壊れないよう定数にしている
// （実際、リポジトリ全体の顧客名スクラブでこのリストが書き換わって
// 自分自身を弾く状態になった）。
export const CLIENT_IDENTIFIERS = Object.freeze([
  "\u5e78\u8c37",        // 運営者の姓
  "\u30de\u30a4\u30af\u3055\u3093", // 運営者の通称（敬称つきでのみ判定。
                                          // 「マイク」単体は音響機材の一般語で誤検出する）
  "manga-channel",
  "narrated-story-deployment",
]);

export function loadHarnesses(dir = HARNESS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".harness.json"))
    .map((name) => {
      const full = path.join(dir, name);
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch (error) {
        throw new Error(`${name} が壊れています: ${error.message}`);
      }
      const errors = validateHarness(parsed);
      if (errors.length > 0) {
        throw new Error(`${name} の宣言に問題があります:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
      }
      return { ...parsed, file: path.relative(REPO_ROOT, full) };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

// 宣言が緩いと台帳の意味が無くなる。特に guarantees が空のハーネスを
// 受け入れると、「何を保証するのか分からないもの」が選択肢に並ぶ。
export function validateHarness(h) {
  const errors = [];
  if (!h || typeof h !== "object") return ["オブジェクトではありません"];
  for (const key of ["id", "displayName", "status"]) {
    if (typeof h[key] !== "string" || !h[key].trim()) errors.push(`${key} が必要です`);
  }
  if (!h.produces?.kind) errors.push("produces.kind が必要です（何を作るのか）");
  if (!Array.isArray(h.requiresFromOperator) || h.requiresFromOperator.length === 0) {
    errors.push("requiresFromOperator が必要です（運営者に何を出してもらうのか）");
  }
  if (!Array.isArray(h.guarantees) || h.guarantees.length === 0) {
    errors.push("guarantees が必要です（何を保証するのか。空なら選択肢に並べる意味がない）");
  }
  // クライアントを特定できる情報を宣言へ入れない。ここは共有される。
  const text = JSON.stringify(h);
  for (const banned of CLIENT_IDENTIFIERS) {
    if (text.includes(banned)) {
      errors.push(`クライアントを特定できる語が入っています: ${banned}`);
    }
  }
  return errors;
}

// 依頼文とハーネスの突き合わせ。語の重なりだけの素朴な方式で、
// ここで賢さを出そうとしない——ハーネスが2つしかない段階で凝った
// ルーターを書いても、正しいかどうかを確かめる手段がない。
// 効くのは「候補と、その根拠と、足りない入力」を並べて人に見せることの方。
export function matchHarnesses(harnesses, want) {
  return analyzeHarnessRequest(harnesses, want)
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
}

// 否定の節を見分ける手掛かり。日本語は「〜は使わず」「〜ではなく」のように**前の語を**
// 否定する後置型、英語は "not / without" のように**後ろの語を**否定する前置型。
// 「漫画、吹き出しは使わず、朗読にしたい」で吹き出しまで加点して漫画を選んでいた。
const JAPANESE_SUFFIX_NEGATIONS = [
  "ではなくて", "ではなく", "でなくて", "でなく", "じゃなくて", "じゃなく", "ではない", "じゃない",
  "使わずに", "使わず", "使わない", "入れずに", "入れず", "入れない", "付けずに", "付けず", "付けない",
  "つけずに", "つけず", "つけない", "出さずに", "出さず", "出さない", "せずに", "せず", "しない",
  "いらない", "要らない", "不要", "なしで", "無しで", "なし", "無し", "ナシ", "抜きで", "抜き", "以外",
  "はやめて", "をやめて", "は避けて", "を避けて", "禁止",
].sort((left, right) => right.length - left.length);
// 「昔ばなし」「おはなし」の「なし」は否定ではない。
const NOT_NEGATION_BEFORE_NASHI = /(?:ば|おは|お話|話)$/u;
const ENGLISH_PREFIX_NEGATIONS = /\b(?:not|no|without|never|don't use|do not use|instead of)\b/giu;
const CLAUSE_BOUNDARY = /[、。，．,.;；:：!！?？\n()（）「」『』]|\b(?:but|rather|instead)\b/giu;

function normalizeRequest(want) {
  return String(want ?? "").normalize("NFKC").toLowerCase();
}

/**
 * 依頼文を節に分け、それぞれが否定されているかを返す。
 * - 日本語の後置否定: 直前の区切りから否定語までが否定の節
 * - 英語の前置否定: 否定語から次の区切りまでが否定の節
 */
export function splitRequestClauses(want) {
  const text = normalizeRequest(want);
  const clauses = [];
  // 英語の前置否定を先に見つけ、その範囲（次の区切りまで）を否定にする。
  const negatedRanges = [];
  for (const match of text.matchAll(ENGLISH_PREFIX_NEGATIONS)) {
    const start = match.index + match[0].length;
    CLAUSE_BOUNDARY.lastIndex = start;
    const boundary = CLAUSE_BOUNDARY.exec(text);
    negatedRanges.push([start, boundary ? boundary.index : text.length]);
  }
  let start = 0;
  let index = 0;
  const push = (end, suffixNegated) => {
    const body = text.slice(start, end);
    if (!body.trim()) return;
    // 英語の前置否定の範囲と重なる節も否定。
    const prefixNegated = negatedRanges.some(([rangeStart, rangeEnd]) => rangeStart < end && rangeEnd > start);
    clauses.push({ text: body, negated: suffixNegated || prefixNegated });
  };
  while (index < text.length) {
    CLAUSE_BOUNDARY.lastIndex = index;
    const boundary = CLAUSE_BOUNDARY.exec(text);
    if (boundary && boundary.index === index) {
      push(index, false);
      index += Math.max(1, boundary[0].length);
      start = index;
      continue;
    }
    const marker = JAPANESE_SUFFIX_NEGATIONS.find((candidate) => text.startsWith(candidate, index));
    if (marker && !(/^(?:なし|無し)/u.test(marker) && NOT_NEGATION_BEFORE_NASHI.test(text.slice(start, index)))) {
      push(index, true);
      index += marker.length;
      start = index;
      continue;
    }
    index += 1;
  }
  push(text.length, false);
  return clauses;
}

/**
 * ハーネスごとに、依頼文の肯定の節に現れた語（加点）と否定の節に現れた語（減点）を返す。
 * score = 肯定の語の数 − 否定の語の数。
 */
export function analyzeHarnessRequest(harnesses, want) {
  const query = normalizeRequest(want);
  if (!query.trim()) return [];
  const clauses = splitRequestClauses(query);
  const positiveText = clauses.filter((clause) => !clause.negated).map((clause) => clause.text);
  const negatedText = clauses.filter((clause) => clause.negated).map((clause) => clause.text);
  return harnesses.map((h) => {
    // 日本語の依頼文は空白で区切れないので、依頼文を刻むのではなく
    // **ハーネス側の語が依頼文に現れるか**を見る。最初この向きを逆に
    // 書いて、「漫画で解説する動画を作りたい」が1語として扱われ、
    // 何にも一致しなかった。
    const keywords = harnessKeywords(h).map((k) => k.normalize("NFKC"));
    const positiveHits = keywords.filter((k) => positiveText.some((body) => body.includes(k)));
    const negatedHits = keywords.filter((k) => negatedText.some((body) => body.includes(k)));
    return {
      harness: h,
      score: positiveHits.length - negatedHits.length,
      // hits は従来どおり「加点した語」。
      hits: positiveHits,
      positiveHits,
      negatedHits,
    };
  });
}

// ハーネスを言い当てる語。宣言の文章をそのまま使うと長すぎて一致しないので、
// 短い手掛かりを明示的に持たせる。宣言に `keywords` があればそれを優先する。
export function harnessKeywords(h) {
  if (Array.isArray(h.keywords) && h.keywords.length > 0) {
    return h.keywords.map((k) => String(k).toLowerCase());
  }
  // 宣言に keywords が無い場合の保険。id と kind を分解して使う。
  return [h.id, h.produces?.kind]
    .filter(Boolean)
    .flatMap((v) => String(v).toLowerCase().split("-"))
    .filter((t) => t.length >= 3);
}

// 横断で見たときの抜け。ある保証を1つのハーネスだけが持っているなら、
// それは「他にも要るはずなのに無い」か「本当にそこ固有」かのどちらか。
// 機械には判別できないので、並べて人に見せる。
export function findGaps(harnesses) {
  const byGuarantee = new Map();
  for (const h of harnesses) {
    for (const g of h.guarantees ?? []) {
      if (!byGuarantee.has(g.id)) byGuarantee.set(g.id, []);
      byGuarantee.get(g.id).push(h.id);
    }
  }
  return [...byGuarantee.entries()]
    .map(([id, owners]) => ({ id, owners, sharedBy: owners.length }))
    .sort((a, b) => a.sharedBy - b.sharedBy || a.id.localeCompare(b.id));
}

function main() {
  const [action, ...rest] = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i].startsWith("--")) { args[rest[i].slice(2)] = rest[i + 1]; i += 1; }
  }
  const harnesses = loadHarnesses();

  switch (action) {
    case "list": {
      if (harnesses.length === 0) { process.stdout.write("登録されたハーネスがありません\n"); break; }
      for (const h of harnesses) {
        process.stdout.write(`\n■ ${h.displayName}  [${h.id}]\n`);
        process.stdout.write(`   作れるもの: ${h.produces.description}\n`);
        process.stdout.write(`   状態: ${h.status}${h.statusNote ? ` — ${h.statusNote}` : ""}\n`);
        const blocking = (h.requiresFromOperator ?? []).filter((r) => r.blocking);
        process.stdout.write(`   運営者に要るもの: ${blocking.map((r) => r.what).join(" / ")}\n`);
        process.stdout.write(`   保証: ${(h.guarantees ?? []).map((g) => g.id).join(", ")}\n`);
        // 能力カード（lib/harnessCapabilities.mjs）は宣言の隣の別ファイル。無いと plan-request が選ぶ材料を欠く。
        const card = path.join(HARNESS_DIR, `${h.id}.capabilities.json`);
        process.stdout.write(`   能力カード: ${fs.existsSync(card) ? path.relative(REPO_ROOT, card) : "無い（plan-request が受け取れる入力・前提を示せない）"}\n`);
      }
      break;
    }

    case "match": {
      if (!args.want) throw new Error('--want "やりたいこと" が必要です');
      const matched = matchHarnesses(harnesses, args.want);
      if (matched.length === 0) {
        process.stdout.write(
          `「${args.want}」に当たるハーネスはありません。\n`
          + "新しく作る前に list で既存の保証を見て、流用できる部分を確かめてください。\n",
        );
        break;
      }
      for (const { harness: h, hits, negatedHits = [] } of matched) {
        const negated = negatedHits.length > 0 ? ` / 否定の節で減点: ${negatedHits.join(", ")}` : "";
        process.stdout.write(`\n■ ${h.displayName}  [${h.id}]（一致: ${hits.join(", ")}${negated}）\n`);
        process.stdout.write(`   ${h.produces.description}\n`);
        process.stdout.write(`   入口: ${h.entrypoint}\n`);
        const blocking = (h.requiresFromOperator ?? []).filter((r) => r.blocking);
        process.stdout.write(`   先に揃えるもの: ${blocking.map((r) => r.what).join(" / ")}\n`);
        if (h.status !== "in-production") {
          process.stdout.write(`   ⚠️ 状態: ${h.status} — ${h.statusNote ?? ""}\n`);
        }
      }
      process.stdout.write(
        "\n候補を出しただけで、選んだわけではありません。"
        + "入口を叩く前に、そのハーネスの正本スキルを読むこと。\n",
      );
      break;
    }

    case "gaps": {
      const gaps = findGaps(harnesses);
      const solo = gaps.filter((g) => g.sharedBy === 1);
      const shared = gaps.filter((g) => g.sharedBy > 1);
      process.stdout.write("■ 1つのハーネスにしか無い保証\n");
      process.stdout.write("  （他にも要るのに無いのか、そこ固有なのかは人が決める）\n\n");
      for (const g of solo) process.stdout.write(`  ${g.id}  ← ${g.owners[0]}\n`);
      if (shared.length > 0) {
        process.stdout.write("\n■ 複数が持つ保証（共有層へ上げる候補）\n\n");
        for (const g of shared) process.stdout.write(`  ${g.id}  ← ${g.owners.join(", ")}\n`);
      }
      break;
    }

    default:
      process.stdout.write(`ハーネス台帳

  list                    登録されたハーネスと、その保証・必要入力を並べる
  match --want "..."      やりたいことに当たりそうなハーネスを挙げる
  gaps                    横断で見た保証の偏りを出す

  宣言は config/harnesses/*.harness.json。クライアント名は書かない。
`);
      process.exit(action ? 2 : 0);
  }
}

if (isDirectCli(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exit(2); }
}
