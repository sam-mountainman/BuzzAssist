#!/usr/bin/env node
// ハーネス自己改善ループ（Claude Code / Codex 共通）
//
// ユーザーの指摘を、その場の修正で終わらせずに、次のセッションが読む正本へ
// 積み上げるための仕組み。Nous Research の hermes-agent が採っている
// 3層（ターン内の捕捉 → 定期的な統合 → 人間起動の取り込み）を、この
// リポジトリの方針に合わせて移植した。
//
//   node scripts/harness-learn.mjs capture --text "..." --evidence "..."
//   node scripts/harness-learn.mjs status
//   node scripts/harness-learn.mjs review              # dry-run（既定）
//   node scripts/harness-learn.mjs apply --id <id> --reviewer <名前>
//
// 本家より厳しくしている点と、その理由:
//
// - **捕捉は何も書き換えない**。提案を追記するだけ。自己改善が
//   「スクリプトが自分で正本を書き換える」形になると、今日このリポジトリで
//   何度も潰した「自分で自分に合格を出す」構造と同じものになる。
// - **review は既定で dry-run**。統合案を出すだけで、スキルには触らない。
// - **apply には reviewer 名が要る**。人手ゲートに reviewer を必須にした
//   のと同じ理由（台帳R196）。誰も見ていない自動反映は証跡にならない。
// - **削除しない**。置き換えたものは superseded として残す。
// - **一件一スキルにしない**。hermes の curator が明言しているとおり、
//   1セッションの個別事象を1スキルにする蓄積は失敗であって機能ではない。
//   狙うのはクラスレベルの規則。

import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  channelPackRootEntries,
  resolveChannelPackPath,
  resolveChannelPackSource,
} from "../lib/channelPackResolver.mjs";
import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import { loadHarnessDeployments } from "../lib/harnessDeploymentResolver.mjs";
import { redactSharedLearningText } from "../lib/harnessFeedbackBundle.mjs";
import {
  digestVocabularyTerm,
  extractVocabularyTokens,
  normalizeVocabularyTerm,
} from "../lib/packageTarballAudit.mjs";
import { buildPublicProposalCatalog, renderPublicProposalCatalog } from "../lib/harnessLearningCurator.mjs";
import { loadSensitiveVocabulary, SENSITIVE_VOCABULARY_DIGEST_PATH } from "./audit-package-tarball.mjs";
import { collectSensitiveSignals } from "./audit-public-surface.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEARN_DIR = path.join(REPO_ROOT, "docs", "learning");
const SHARED_PROPOSALS_PATH = path.join(LEARN_DIR, "proposals.jsonl");
const PUBLIC_CATALOG_PATH = path.join(LEARN_DIR, "proposals.public.jsonl");

/**
 * 共有台帳から、配布物に入れる公開 catalog（id / kind / target だけ）を作り直す。
 *
 * catalog は派生物なのに、捕捉は台帳だけに書いていた。そのため**別セッションが
 * 捕捉するたびに catalog が台帳とずれ、テストが落ち、誰かが手で再生成する**
 * 状態だった（2026-09-17 には台帳 74 件・catalog 63 件）。手で直す運用は、
 * 直す人がいない回にずれたまま配布される。捕捉と同じロックの中で作り直す。
 */
export function refreshPublicProposalCatalog({
  ledgerPath = SHARED_PROPOSALS_PATH, catalogPath = PUBLIC_CATALOG_PATH, read = readJsonl,
} = {}) {
  const rendered = renderPublicProposalCatalog(buildPublicProposalCatalog(read(ledgerPath)).entries);
  const current = fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, "utf8") : null;
  if (current === rendered) return { written: false, catalogPath };
  const temporary = `${catalogPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, rendered, "utf8");
  fs.renameSync(temporary, catalogPath);
  return { written: true, catalogPath };
}

function refreshCatalogForSharedLedger(ledgerPath) {
  // pack 側の台帳は公開 catalog の材料ではない。
  if (path.resolve(ledgerPath) !== path.resolve(SHARED_PROPOSALS_PATH)) return { written: false, skipped: true };
  return refreshPublicProposalCatalog({ ledgerPath });
}

/**
 * その提案をどの台帳へ書くか。
 *
 * capture は宛先に関わらず共有台帳（公開リポジトリで追跡）へ書いていた。
 * `channelTermsInSharedEntry` は「共有層宛の提案に固有語が入っていないか」
 * しか見ないので、**宛先が channel-pack: なら固有語ごと通り、そのまま
 * 公開側の台帳に溜まった**。層を分けたつもりが、分けていたのは宛先の
 * ラベルだけで、書き先は1つだった。
 *
 * 実害として、別セッションが捕捉するたびに公開面の検査が赤くなり、
 * こちらが手で pack 側へ移す、を繰り返していた。手で移す運用は、
 * 移す人がいない回に漏れる。
 */
export function ledgerPathFor(target, kind = "proposals") {
  const name = `${kind}.jsonl`;
  const resolvedTarget = resolveTarget(String(target || ""));
  if (resolvedTarget.startsWith("channel-pack:")) {
    const definition = loadTargets()[resolvedTarget] ?? {};
    if (definition.relativeToDeployment) {
      const deployment = resolveDeploymentRoot(definition.relativeToDeployment);
      if (deployment) return path.resolve(REPO_ROOT, deployment, "docs", "learning", name);
    }
    // ambient BUZZASSIST_CHANNEL_PACK_ID を使うと、narrated-story宛の提案が
    // たまたまactiveなKoya packへ入る。target自身をpack IDとして固定する。
    const packId = packIdForTarget(resolvedTarget, definition);
    return path.join(REPO_ROOT, "channel-packs", packId, "docs", "learning", name);
  }
  return path.join(LEARN_DIR, name);
}

/** 共有台帳と、設定済みの各Channel Pack台帳を重複なく列挙する。 */
export function learningLedgerPaths(kind = "proposals") {
  const paths = new Set([path.join(LEARN_DIR, `${kind}.jsonl`)]);
  for (const [target, definition] of Object.entries(loadTargets())) {
    if (definition.scope !== "channel-pack") continue;
    paths.add(ledgerPathFor(target, kind));
  }
  return [...paths];
}

// 提案が向かう先。ここに無いものは apply できない。
// 正本スキルと台帳だけを対象にするのは、次のセッションが必ず読む場所が
// この2つだからで、それ以外へ書いても学習として効かない。
// 宛先の定義は docs/learning/targets.json に持つ。コード内に二重に
// 持たせると、片方だけ古くなる——今日このリポジトリで何度も見た形。
export const LEARNING_TARGETS = new Proxy({}, {
  get(_t, key) {
    if (typeof key !== "string") return undefined;
    return loadTargets()[resolveTarget(key)]?.canonical;
  },
  has(_t, key) { return typeof key === "string" && resolveTarget(key) in loadTargets(); },
  ownKeys() { return Object.keys(loadTargets()); },
  getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
});

// 機械が書き換えてよい範囲の境界。hermes の curator が
// 「agent作成スキルだけ触り、bundled / hub-installed には手を出さない」
// としているのと同じ役割を、ここでは**ファイル単位の所有**が担う。
//
// 当初は正本の中にマーカーを埋めて内側だけ書き換える方式にしたが、
// Codexレビューの指摘で改めた。機械が人の文書の一部を編集する構造だと、
// マーカーが壊れたときに人の記述を巻き込むうえ、差分と巻き戻しを
// 独立して扱えない。機械には**専用のファイルを丸ごと持たせる**方が明快。
//
// もう一点、overlay は「運用上の補助指示」であって
// **監査・承認・合否の証跡には使えない**。だから台帳やゲート基準のように
// 承認の記録そのものである文書は review-only にして自動反映しない。
const TARGETS_PATH = path.join(LEARN_DIR, "targets.json");

export function loadTargets(targetsPath = TARGETS_PATH) {
  const raw = JSON.parse(fs.readFileSync(targetsPath, "utf8"));
  return raw.targets ?? {};
}

/** repoRoot 基準の targets.json。既定のリポジトリなら TARGETS_PATH と同じ。 */
function loadTargetsFor(repoRoot = REPO_ROOT) {
  return loadTargets(path.resolve(repoRoot) === REPO_ROOT ? TARGETS_PATH : path.join(repoRoot, "docs", "learning", "targets.json"));
}

// 宛先の名前空間を platform: / genre: / channel-pack: の3層へ変えたとき、
// 既に記録した提案は旧IDのまま残る。捨てるとその指摘が無かったことに
// なるので、読むときに翻訳する。提案IDは kind+target+text から作るため、
// **翻訳は解決時だけに留め、記録した target 文字列は書き換えない**
// （書き換えるとIDが変わり、過去の apply 記録と結び付かなくなる）。
export const TARGET_ALIASES = {
  "skill:manga-video-production": "genre:manga-video-production",
  "skill:manga-page-camera": "genre:manga-page-camera",
  "skill:harness-parallel-execution": "platform:harness-parallel-execution",
  "skill:harness-self-improvement": "platform:harness-self-improvement",
  "ledger:koya": "channel-pack:koya",
  "doc:mike-audio-gates": "channel-pack:narrated-story",
};

export function resolveTarget(target) {
  return TARGET_ALIASES[target] ?? target;
}

function isChannelPackTarget(target) {
  return String(target || "").startsWith("channel-pack:");
}

/** target 自身が pack ID を決める（ambient な BUZZASSIST_CHANNEL_PACK_ID には頼らない）。 */
function packIdForTarget(target, definition = {}) {
  return definition?.packId || String(target).slice("channel-pack:".length);
}

export const OVERLAY_HEADER = [
  "<!-- このファイルは harness-learn が自動で書きます。手で編集しないでください。 -->",
  "",
  "# 自動で積み上がった指摘",
  "",
  "隣の `SKILL.md` が正本で、**矛盾したときは SKILL.md が優先**します。",
  "ここは運用上の補助指示であって、**監査・承認・合否の証跡には使えません**。",
  "根拠は逐語ではなく sha256 先頭12桁の digest だけを載せます（このファイルは配布物に",
  "同梱されるため）。逐語は `node scripts/harness-learn.mjs status` で id から引けます。",
  "",
].join("\n");

// overlay は次のセッションが**指示として読む**。捕捉した文字列をそのまま
// Markdown へ埋めると、改行や見出しで箇条書きの外へ出て、あたかも
// 正規の指示のように見える行を作れてしまう。1行へ畳んで記法を無効化する。
export function sanitizeForOverlay(value) {
  return String(value ?? "")
    .replace(/\r?\n/gu, " ")        // 改行で項目の外へ出さない
    .replace(/^[\s>#*-]+/u, "")      // 行頭の見出し・引用・箇条書き記号
    .replace(/`/gu, "'")             // コードブロックを開かせない
    .replace(/<!--|-->/gu, "")       // HTMLコメントでマーカーを偽装させない
    .replace(/\s{2,}/gu, " ")
    .trim();
}

// overlay は `.agents/skills/<name>/references/learned-auto.md` に置かれ、
// setup-agents と npm tarball の両方へ**そのまま同梱される**。以前は evidence を
// 逐語で書いていたので、capture 時の検査（channelTermsInSharedEntry）を
// すり抜けたキャスト名・顧客識別子・端末 path が配布物へ出ていた
// （2026-09-05 独立レビュー D-1）。
//
// 語彙に頼る除去は、語彙に無い固有名詞を保証できない。だから根拠は
// **digest だけ**を主とし、text 側は語彙ベースの redaction を補助として通す。
// 逐語が要るときは台帳（proposals.jsonl）を id で引けばよく、overlay に
// 逐語を置く必要は元から無かった。
export const EVIDENCE_DIGEST_CHARS = 12;

export function evidenceDigest(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex").slice(0, EVIDENCE_DIGEST_CHARS);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * 鍵つき digest 語彙（docs/learning/sensitive-vocabulary.digest.json）に一致した
 * token を置換する。tarball 監査（countVocabularyDigestHits）と同じ tokenizer と
 * 正規化を使うので、ここで消したものは監査でも当たらない。語そのものは
 * この関数の外へ出さない。
 */
export function redactVocabularyDigestTokens(value, vocabulary) {
  let text = String(value ?? "");
  if (!vocabulary || vocabulary.count === 0) return { text, hits: 0 };
  const matched = [...extractVocabularyTokens(text)].filter((token) => {
    const normalized = normalizeVocabularyTerm(token);
    if (!vocabulary.lengths.has([...normalized].length)) return false;
    return vocabulary.digests.has(digestVocabularyTerm(normalized, vocabulary.key));
  }).sort((left, right) => right.length - left.length);
  let hits = 0;
  for (const token of matched) {
    text = text.replace(new RegExp(escapeRegExp(token), "giu"), () => { hits += 1; return "<private-term>"; });
  }
  return { text, hits };
}

/** 語彙照合なしで書かれた overlay のヘッダに刻む印。読む側と監査側が見分けられるようにする。 */
export const OVERLAY_VOCABULARY_MISSING_NOTE =
  "<!-- 語彙照合なし: sensitive-vocabulary.digest.json を照合できない状態（一覧か鍵が無い）で --allow-missing-vocabulary により生成。私的語の残存を検出していない。 -->";

/**
 * overlay の text 側に掛ける redaction の材料。Channel Pack 由来の語（運営者端末
 * にしか無い）と、コミット済みの digest 語彙（CI でも効く）の両方を使う。
 *
 * digest ファイルが壊れていれば throw する——壊れた語彙で「除去済み」の
 * overlay を書くより、sync が止まる方がよい。**無い場合も同じ扱いで throw する。**
 * 以前は「壊れていれば止まる、無ければ通る」だった（2026-09-05 再レビュー R2-L1）。
 * 語彙が無い overlay 生成は私的語の残存を検出できないのに、出力は「除去済み」と
 * 区別が付かない。欠落を許可として扱う型（platform-craft「欠落を許可として扱う」）。
 * 明示の `allowMissingVocabulary` でだけ通し、その場合は返り値に印を付けて
 * overlay ヘッダへ刻む。
 */
export function overlayRedactionContext({
  projectDir = REPO_ROOT,
  homeRoot = homedir(),
  allowMissingVocabulary = false,
} = {}) {
  const signals = collectSensitiveSignals(projectDir);
  const vocabularyPath = path.join(projectDir, SENSITIVE_VOCABULARY_DIGEST_PATH);
  const loaded = loadSensitiveVocabulary(vocabularyPath, { projectDir });
  const vocabulary = loaded.vocabulary;
  if (vocabulary === null) {
    if (allowMissingVocabulary !== true) {
      throw new Error(
        `digest 語彙を照合できないので overlay を生成しない: ${SENSITIVE_VOCABULARY_DIGEST_PATH}（${loaded.reason}）\n`
        + "語彙無しの overlay は私的語の残存を検出できない（tarball 監査と同じ理由）。\n"
        + "  node scripts/audit-package-tarball.mjs build-vocabulary で語彙を作るか、\n"
        + "  開発用途に限り --allow-missing-vocabulary を付ける（overlay ヘッダに「語彙照合なし」が刻まれる）。",
      );
    }
    return { terms: signals.terms, castIds: signals.castIds, homeRoot, vocabulary: null, vocabularyMissing: true };
  }
  return { terms: signals.terms, castIds: signals.castIds, homeRoot, vocabulary, vocabularyMissing: false };
}

export function redactForOverlay(value, context = {}) {
  const shared = redactSharedLearningText(value, {
    terms: context.terms || [],
    castIds: context.castIds || [],
    homeRoot: context.homeRoot || "",
  });
  const vocabulary = redactVocabularyDigestTokens(shared.text, context.vocabulary || null);
  return sanitizeForOverlay(vocabulary.text);
}

export function renderOverlay(entries, now, context = null) {
  const lines = [OVERLAY_HEADER];
  // 語彙照合なしで生成した overlay は、空でもヘッダで見分けられるようにする。
  // 明示フラグ（vocabularyMissing === true）だけを見る。vocabulary: null は
  // テスト用の素通しコンテキストでも使うので、null だけでは印を付けない。
  if (context?.vocabularyMissing === true) lines.push(OVERLAY_VOCABULARY_MISSING_NOTE, "");
  if (entries.length === 0) {
    lines.push("_まだ自動反映された項目はありません。_", "");
  } else {
    const redaction = context ?? overlayRedactionContext();
    for (const entry of entries) {
      const repeat = entry.occurrences > 1 ? `（${entry.occurrences}回指摘）` : "";
      lines.push(`- **${redactForOverlay(entry.text, redaction)}**${repeat}`);
      const digests = [...new Set((entry.evidence || []).map((ev) => evidenceDigest(ev)))];
      if (digests.length > 0) {
        lines.push(`  - 根拠digest: ${digests.map((digest) => `\`${digest}\``).join(", ")}`);
      }
      lines.push(`  - 種別: ${entry.kind} / 初回: ${String(entry.firstSeenAt).slice(0, 10)} / id: \`${entry.id}\``);
    }
    lines.push("");
  }
  lines.push(`_最終更新: ${now}_`, "");
  return lines.join("\n");
}

export const PROPOSAL_KINDS = new Set([
  "correction",   // ユーザーがこちらの誤りを正した
  "preference",   // 作り方・進め方の好み
  "constraint",   // やってはいけないこと
  "fact",         // 実測で分かったこと
]);

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        // 壊れた行を黙って読み飛ばすと、記録が欠けたことに誰も気づかない。
        throw new Error(`${filePath}:${index + 1} が壊れています: ${error.message}`);
      }
    });
}

function appendJsonl(filePath, entry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // 1行を1回の write で出す。JSON.stringify は改行を含まないので、
  // 追記モードの単一 write なら別プロセスと行が混ざらない。
  const line = `${JSON.stringify(entry)}\n`;
  const fd = fs.openSync(filePath, "a");
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function withProposalCaptureLock(filePath, action, { timeoutMs = 10_000, staleMs = 120_000 } = {}) {
  const lockPath = `${filePath}.capture.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const startedAt = Date.now();
  let handle = null;
  while (handle === null) {
    try {
      handle = fs.openSync(lockPath, "wx");
      fs.writeSync(handle, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch { /* stale判定へ */ }
      const age = Date.now() - (fs.statSync(lockPath, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if ((owner && !processIsAlive(Number(owner.pid))) || (!owner && age > staleMs)) {
        try { fs.rmSync(lockPath, { force: true }); } catch { /* 次のloopで再確認 */ }
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) throw new Error("proposal台帳のcapture lockを取得できない。");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return action();
  } finally {
    try { fs.closeSync(handle); } catch { /* cleanupを続ける */ }
    try { fs.rmSync(lockPath, { force: true }); } catch { /* stale recoveryが扱う */ }
  }
}

function canonicalPotentialPathSync(filePath) {
  let current = path.resolve(filePath);
  const missing = [];
  while (true) {
    try {
      return path.join(fs.realpathSync(current), ...missing.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function assertCaptureLedgerIsolation(target, ledgerPath, ledgerPathResolver) {
  if (!String(target).startsWith("channel-pack:")) return;
  const channel = canonicalPotentialPathSync(ledgerPath);
  const shared = canonicalPotentialPathSync(ledgerPathResolver("platform:platform-craft", "proposals"));
  const rel = path.relative(path.dirname(shared), channel);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    throw new Error("Channel Pack proposal台帳が共有learning台帳から分離されていない。captureを停止する。");
  }
}

export function proposalId(entry) {
  return createHash("sha256")
    .update([entry.kind, entry.target, entry.text].join("\u001f"))
    .digest("hex")
    .slice(0, 12);
}

// 正本側へこの一意マーカーを置くことで、よくある短い語句が偶然どこかに
// 存在しただけで別の提案を「反映済み」にできないようにする。
export const PROMOTION_NOTE_MIN_CHARS = 12;

export function promotionMarker(id) {
  return `buzzassist-learning:${String(id || "").trim()}`;
}

export function canonicalHasPromotionEvidence(record, canonicalText) {
  if (!record?.id || typeof canonicalText !== "string") return false;
  const note = typeof record.note === "string" ? record.note.trim() : "";
  if (Array.from(note).length < PROMOTION_NOTE_MIN_CHARS) return false;
  return canonicalText.includes(promotionMarker(record.id)) && canonicalText.includes(note);
}

// 同じ指摘が何度も来るのは「まだ直っていない」という強い信号なので、
// 重複を捨てずに回数として数える。1回の思いつきと、3回言われたことを
// 同じ重みで扱わないための材料。
// 反映済みの判定。id が1行あるだけでは足りない——正本にその規則が
// 実在することまで見る。以前は id だけで判定していたので、正本を
// 1文字も変えずに apply を通せてしまい、status からも消えていた。
export function isActuallyApplied(record, readCanonical, hashCanonical = null) {
  if (!record?.id) return false;
  // 昇格記録には、何をどこへ書いたかが要る。
  if (!record.reviewer || !String(record.reviewer).trim()) return false;
  // **人の確認が無いものを「反映済み」として数えない。**
  //
  // ここが実効の中心だった。reviewer が空でないことしか見ていなかったので、
  // agent-self-attested も unverified-agent-typed も attestedBy 欠落も、
  // 人の確認とまったく同じ効力で applied になっていた。しかも
  // summarizeProposals が applied を未反映一覧から消すので、**後から人が
  // 昇格しようとすると「既に反映済み」で拒まれる**——機械の自己申告が、
  // 人の確認を締め出していた。
  if (record.attestedBy !== HUMAN_VERIFIED) return false;
  if (!record.targetPath) return false;
  // 記録そのものも渡す。channel-pack 宛は同じ相対パスでも pack 側が正本で、
  // 相対パスだけでは「どちらの写しを読むか」を決められない（ops-7）。
  const text = readCanonical(record.targetPath, record);
  if (text === null) return false;
  // 一意な proposal marker と、十分な長さの exact note の両方を要求する。
  // 「正本のどこかに5文字だけ一致」で別の変更を証拠にできた旧判定は使わない。
  if (!canonicalHasPromotionEvidence(record, text)) return false;
  // 記録した digest は保存するだけでなく突き合わせる。保存して照合しない
  // ハッシュは、証跡があるように見えて何も担保していない。
  // 正本が変わっていれば「別の版に対する記録」なので、文言が残っていても
  // その記録は現在の版を保証しない。
  if (record.targetSha256 && typeof hashCanonical === "function") {
    const current = hashCanonical(record.targetPath, record);
    if (current && current !== record.targetSha256) return false;
  }
  return true;
}

export function summarizeProposals(proposals, applied, readCanonical = null, hashCanonical = null) {
  const appliedIds = new Set(
    readCanonical
      ? applied
        .filter((entry) => isActuallyApplied(entry, readCanonical, hashCanonical))
        .map((entry) => entry.id)
      : applied.map((entry) => entry.id),
  );
  const byId = new Map();
  const seenSessionOccurrences = new Set();
  for (const entry of proposals) {
    const id = entry.id ?? proposalId(entry);
    const session = typeof entry.session === "string" ? entry.session.trim() : "";
    const sessionOccurrence = session ? `${id}\u001f${session}` : "";
    const existing = byId.get(id);
    if (existing) {
      // 同じturn/sessionでcaptureが再実行されても、独立した指摘回数にしない。
      // session不明の旧記録は別事象か判定できないため従来どおり数える。
      if (!sessionOccurrence || !seenSessionOccurrences.has(sessionOccurrence)) {
        existing.occurrences += 1;
      }
      existing.lastSeenAt = entry.capturedAt ?? existing.lastSeenAt;
      if (entry.evidence && !existing.evidence.includes(entry.evidence)) {
        existing.evidence.push(entry.evidence);
      }
    } else {
      byId.set(id, {
        ...entry,
        id,
        occurrences: 1,
        firstSeenAt: entry.capturedAt ?? null,
        lastSeenAt: entry.capturedAt ?? null,
        evidence: entry.evidence ? [entry.evidence] : [],
        applied: appliedIds.has(id),
      });
    }
    if (sessionOccurrence) seenSessionOccurrences.add(sessionOccurrence);
  }
  return [...byId.values()].sort((a, b) => {
    if (a.applied !== b.applied) return a.applied ? 1 : -1;
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
    return String(a.firstSeenAt).localeCompare(String(b.firstSeenAt));
  });
}

// hermes の curator が言う「クラスレベルへ寄せる」を、機械的にできる範囲で
// 用意する。同じ target に複数の未反映提案が溜まっていたら、それは
// 個別に足すのではなくまとめて1つの節にすべきという合図。
export function clusterForConsolidation(summary) {
  const pending = summary.filter((entry) => !entry.applied);
  const byTarget = new Map();
  for (const entry of pending) {
    if (!byTarget.has(entry.target)) byTarget.set(entry.target, []);
    byTarget.get(entry.target).push(entry);
  }
  return [...byTarget.entries()]
    .map(([target, entries]) => ({
      target,
      entries,
      // 2件以上溜まっていたら、個別追記ではなくまとめて書き直す方が良い。
      recommendation: entries.length >= 2
        ? "この target の未反映をまとめて1つの節に書く（個別に追記しない）"
        : "1件のみ。既存の節へ吸収できないか先に確認する",
    }))
    .sort((a, b) => b.entries.length - a.entries.length);
}

// 宛先が deployment 相対なら、配置先を運営者の配置表（config/harness-deployments.json）から引く。
// 解析は共通の解決器（lib/harnessDeploymentResolver.mjs）に任せる（同じ規則を2か所に持たない）。
//
// ただし、共通の解決器が持つ「配置表が無ければ同梱の example へ戻る」はここでは使わない。
// example の root は "." で、実行する場所としては正しいが、**台帳の置き場としては共有台帳と
// 同じ場所になる**。新規インストール（配置表なし）では pack 側の台帳へ書く（ledgerPathFor の
// 既定）のが正しく、配布シミュレーションもそれを確かめている。
//
// リポジトリ内の配置は相対で返す（記録に端末の絶対パスを残さない）。
function resolveDeploymentRoot(harnessId, repoRoot = REPO_ROOT) {
  const operatorMap = path.join(repoRoot, "config", "harness-deployments.json");
  if (!fs.existsSync(operatorMap)) return null;
  let deployment;
  try {
    deployment = loadHarnessDeployments({ repoRoot, deploymentPath: operatorMap }).get(harnessId);
  } catch {
    return null;
  }
  if (!deployment) return null;
  const rel = path.relative(repoRoot, deployment.root);
  if (rel === "") return ".";
  return rel.startsWith("..") || path.isAbsolute(rel) ? deployment.root : rel;
}

/** 正本をどこから読んだかの表示名。出力と applied 記録（targetSource）で使う。 */
export const CANONICAL_SOURCE_LABELS = Object.freeze({
  "channel-pack": "Channel Pack",
  "channel-pack-env": "Channel Pack（BUZZASSIST_CHANNEL_PACK）",
  deployment: "配置先（config/harness-deployments.json）",
  repository: "リポジトリ",
});

function sameFile(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

/**
 * channel-pack 宛の正本を「Channel Pack を先に見る」順で解決する（ops-7）。
 *
 * 以前はリポジトリの docs/ を先に見て、そこに無いときだけ pack を見ていた。
 * docs/ には pack へ移す前の写しが git 管理外のまま残りうる（.gitignore 済みで
 * 誰も気づかない）。**古い写しがあると、それが本物の pack より優先され、
 * promote / apply は古い写しで印を探し、古い写しの sha256 を記録した**。
 * status の読み取り側（readCanonical / hashCanonical）は pack をまったく見て
 * いなかったので、書く側と読む側で別のファイルを比べることもあった。
 *
 * 探す順は共通の解決器（lib/channelPackResolver.mjs）に任せる:
 * BUZZASSIST_CHANNEL_PACK → <repo>/channel-packs/<packId>/ → リポジトリ直下。
 * 合成 fixture は承認記録の材料にならないので候補から外す。リポジトリ直下は
 * pack 側に正本が無いときだけ使い、どちらを使ったかを呼び出し側へ返す。
 */
export function resolvePackFirstCanonical(relativePath, { repoRoot = REPO_ROOT, packId } = {}) {
  const found = resolveChannelPackSource(repoRoot, relativePath, packId, { includeFixture: false });
  const repoPath = path.resolve(repoRoot, relativePath);
  if (found.kind !== "legacy") {
    const shadowed = fs.existsSync(repoPath) && !sameFile(repoPath, found.path);
    return {
      full: found.path,
      source: found.kind === "env" ? "channel-pack-env" : "channel-pack",
      missing: false,
      packRoot: found.root,
      // pack が勝ったので読まなかったリポジトリ側の写し。出力で知らせる。
      ignoredRepoCopy: shadowed ? repoPath : null,
      packRootWithoutCanonical: null,
    };
  }
  // pack 側のどこにも正本が無い。ここで初めてリポジトリ直下（従来の配置）を使う。
  const presentRoot = channelPackRootEntries(repoRoot, packId)
    .find((entry) => entry.kind !== "fixture" && fs.existsSync(entry.root));
  return {
    full: repoPath,
    source: "repository",
    missing: !fs.existsSync(repoPath),
    packRoot: null,
    ignoredRepoCopy: null,
    packRootWithoutCanonical: presentRoot ? presentRoot.root : null,
  };
}

/**
 * target の正本の置き場を解決する。requireTarget / promote / apply / status の
 * 表示が同じ規則を使う。
 *
 * - channel-pack 宛（配置先相対でないもの）: pack を先に見る。
 * - channel-pack 宛で配置先相対: 運営者が宣言した配置先がそのチャンネルの置き場。
 * - それ以外（platform / genre）: 従来どおり。リポジトリを先に見る。
 */
export function resolveCanonicalTarget(rawTarget, {
  repoRoot = REPO_ROOT,
  targets = undefined,
  deploymentRootFor = undefined,
} = {}) {
  const target = resolveTarget(rawTarget);
  const targetMap = targets ?? loadTargetsFor(repoRoot);
  const def = targetMap[target];
  if (!def?.canonical) {
    throw new Error(
      `未知の target: ${target}\n使えるのは:\n`
        + Object.keys(targetMap).map((key) => `  ${key}`).join("\n"),
    );
  }
  let rel = def.canonical;
  if (def.relativeToDeployment) {
    const root = (deploymentRootFor ?? ((id) => resolveDeploymentRoot(id, repoRoot)))(def.relativeToDeployment);
    if (!root) {
      // 捕捉は「あとで判断するための記録」なので、配置先が未設定でも受け取る
      // （下の「正本が手元に無い」と同じ扱い）。ここで投げていたので、配置表を持たない
      // 環境（CI・clone 直後）では pack 宛の捕捉が、台帳の隔離の検査より前に落ちていた。
      // 書き込む工程（requireWritableTarget）だけが配置先を要求する。
      return { target, rel, full: null, missing: true, missingDeployment: def.relativeToDeployment, source: "deployment" };
    }
    rel = path.join(root, rel);
    const full = path.resolve(repoRoot, rel);
    return { target, rel, full, missing: !fs.existsSync(full), source: "deployment" };
  }
  if (isChannelPackTarget(target)) {
    // 捕捉は正本が手元に無くても受け取る（missing を返すだけ）。書き込む工程
    // （promote / apply）だけが requireWritableTarget で実在を要求する。
    return { target, rel, ...resolvePackFirstCanonical(rel, { repoRoot, packId: packIdForTarget(target, def) }) };
  }
  // platform / genre は従来どおり: リポジトリに無いときだけ pack 側を試す。
  let full = path.resolve(repoRoot, rel);
  if (!fs.existsSync(full)) {
    const viaPack = resolveChannelPackPath(repoRoot, rel);
    if (fs.existsSync(viaPack)) full = viaPack;
  }
  // 捕捉は「あとで判断するための記録」なので、正本が手元に無くても
  // 受け取る。書き込む工程（sync / promote）だけが正本の実在を要求する
  // ——ここで拒否すると、pack を持たない人は指摘を残すことすらできない。
  return { target, rel, full, missing: !fs.existsSync(full), source: "repository" };
}

function requireTarget(rawTarget) {
  return resolveCanonicalTarget(rawTarget);
}

/** 書き込む工程だけが要求する。読むだけの工程は missing を許す。 */
export function requireWritableTarget(rawTarget, options = {}) {
  const resolved = resolveCanonicalTarget(rawTarget, options);
  if (resolved.missingDeployment) {
    throw new Error(
      `${resolveTarget(rawTarget)} は ${resolved.missingDeployment} の配置先が要ります。`
      + "config/harness-deployments.json に root を書いてください"
      + "（このファイルは運営者固有なので追跡しません。捕捉はできますが、書き込みは配置先が要ります）",
    );
  }
  if (resolved.missing) {
    throw new Error(
      `target の正本がこの環境にありません: ${resolved.rel}\n`
      + (resolved.packRootWithoutCanonical
        ? `  Channel Pack（${resolved.packRootWithoutCanonical}）にもリポジトリ側にも見つかりません。\n`
        : "")
      + "Channel Pack を配置するか BUZZASSIST_CHANNEL_PACK を指定してください"
      + "（捕捉はできますが、書き込みは正本が要ります）",
    );
  }
  return resolved;
}

/**
 * applied 記録の targetPath を、記録した target の規則で読む場所へ解決する。
 * status / curator が「反映済みか」を判定するときの読み先。promote / apply が
 * 印を探して sha256 を取ったのと同じファイルを指さなければ、照合が意味を持たない。
 *
 * record が無い（相対パスだけで呼ばれた）ときと共有層宛は、従来どおりリポジトリ基準。
 */
export function resolveRecordedCanonical(record, {
  repoRoot = REPO_ROOT,
  targets = undefined,
} = {}) {
  const rel = record?.targetPath;
  if (typeof rel !== "string" || rel === "") return null;
  const target = resolveTarget(String(record?.target || ""));
  if (!isChannelPackTarget(target)) {
    const full = path.resolve(repoRoot, rel);
    return { full, source: "repository", missing: !fs.existsSync(full) };
  }
  const def = (targets ?? loadTargetsFor(repoRoot))[target] ?? {};
  if (def.relativeToDeployment) {
    // 記録の targetPath は配置先を含む形で残っている。配置先がそのチャンネルの置き場。
    const full = path.resolve(repoRoot, rel);
    return { full, source: "deployment", missing: !fs.existsSync(full) };
  }
  return resolvePackFirstCanonical(rel, { repoRoot, packId: packIdForTarget(target, def) });
}

/**
 * summarizeProposals / isActuallyApplied へ渡す読み手。readCanonical(rel, record) の
 * 第2引数で記録の target を受け取り、channel-pack 宛なら pack を先に読む。
 */
export function createCanonicalReaders({ repoRoot = REPO_ROOT, targets = undefined } = {}) {
  // targets.json は記録ごとに読み直さない。共有層宛しか無ければ読みもしない。
  let targetMap = targets;
  const locate = (rel, record = null) => {
    const target = String(record?.target || "");
    const packTarget = isChannelPackTarget(resolveTarget(target));
    if (packTarget) targetMap ??= loadTargetsFor(repoRoot);
    return resolveRecordedCanonical({ target, targetPath: rel }, { repoRoot, targets: packTarget ? targetMap : {} });
  };
  return {
    locate,
    readCanonical: (rel, record = null) => {
      const location = locate(rel, record);
      return location && !location.missing ? fs.readFileSync(location.full, "utf8") : null;
    },
    hashCanonical: (rel, record = null) => {
      const location = locate(rel, record);
      return location && !location.missing
        ? createHash("sha256").update(fs.readFileSync(location.full)).digest("hex")
        : null;
    },
  };
}

function displayCanonicalPath(full, repoRoot = REPO_ROOT) {
  if (!full) return "(未解決)";
  const rel = path.relative(repoRoot, full);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : full;
}

/**
 * channel-pack 宛の正本をどこから読んだかを、人が読める行にする。
 * 共有層宛は従来の出力を変えないので空配列を返す。
 */
export function describeCanonicalResolution(resolved, { repoRoot = REPO_ROOT, indent = "  " } = {}) {
  if (!resolved || !isChannelPackTarget(resolved.target)) return [];
  if (resolved.missingDeployment) {
    return [`${indent}正本: 配置先が未設定（${resolved.missingDeployment}。config/harness-deployments.json）`];
  }
  const label = CANONICAL_SOURCE_LABELS[resolved.source] ?? resolved.source;
  const lines = [
    resolved.missing
      ? `${indent}正本: 見つかりません（${label} を探した: ${displayCanonicalPath(resolved.full, repoRoot)}）`
      : `${indent}正本: ${displayCanonicalPath(resolved.full, repoRoot)}（${label}）`,
  ];
  if (resolved.ignoredRepoCopy) {
    lines.push(`${indent}  リポジトリ側の同名ファイルは読みません（pack 側が優先）: ${displayCanonicalPath(resolved.ignoredRepoCopy, repoRoot)}`);
  }
  if (resolved.packRootWithoutCanonical) {
    lines.push(`${indent}  Channel Pack（${displayCanonicalPath(resolved.packRootWithoutCanonical, repoRoot)}）に正本が無いので、リポジトリ側を使います`);
  }
  return lines;
}

/** promote / apply の失敗文に添える「実際に読んだファイル」。共有層宛は従来の文面のまま。 */
function checkedCanonicalNote(resolved) {
  const lines = describeCanonicalResolution(resolved, { indent: "  " });
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * applied 記録に残す「どの写しの sha256 か」。channel-pack 宛だけに付ける
 * （共有層宛の記録の形は変えない）。絶対パスは残さない。
 */
function recordedCanonicalSource(resolved) {
  return isChannelPackTarget(resolved?.target) ? resolved.source : undefined;
}

/**
 * 共有層へ書く提案に、チャンネル固有語が混ざっていないか。
 *
 * 宛先が共有層（platform / genre / skill）でも、evidence にキャスト名や
 * 番組名が入りうる。実際そうなった——ジャンル層の提案の根拠に
 * 固定キャスト3人の名前が書かれ、**公開リポジトリへ commit された**。
 * 宛先の層と、書かれる中身の層は別物。
 *
 * 検出した語そのものは返さない。呼び出し側のエラー文もログに残る。
 */
/**
 * 人が確認したことを、機械が名乗れないようにする。
 *
 * このスキルの大原則は「promote には reviewer 名が要る。『機械が書いた』と
 * 『人が確認した』の差がこの一手で、この差が無くなると自己改善が自己認証に変わる」。
 *
 * だが reviewer をコマンドライン引数で受けていたので、**エージェントが
 * ユーザーの名前を打ち込めば通った**。実際そうなった——台帳に残る17件の
 * `reviewer` は、人が確認したのではなくエージェントが打ったものだった。
 * ガードを書いた本人が、そのガードを迂回していた。
 *
 * 最初の修正は TTY の有無で区別した。**これは証明にならない。** Codex の
 * レビューで実測された: `script -q /dev/null node ...` を通せば
 * `process.stdin.isTTY` は true になり、エージェントは人を名乗れる。
 * しかも当時は TTY を先に見ていたので、**PTY 経由で --agent-attested を
 * 付けても「人の確認」として記録された**。
 *
 * シェルを持つエージェントが同じ機械にいる以上、人の確認を機械的に
 * 強制することはできない。できるのは3つだけで、ここはそれをやる:
 *
 *   1. 既定を拒否にする（黙って人を名乗れる状態を無くす）
 *   2. 詐称に明示的な一手を要求し、何を名乗ったかを記録に残す
 *   3. **人の確認が無いものを「反映済み」として数えない**
 *
 * 3が実効の中心。ここを見ていなかったので、`agent-self-attested` も
 * `unverified-agent-typed` も、人の確認と同じ効力で applied になっていた。
 *
 * 本当の関門は、この台帳が git で追跡されていること——commit を人が読む
 * ところにある。ここで作るのは関門ではなく、**読める証跡**。
 */

/** 人の確認として数える印。これ以外は記録に残るが「反映済み」にはならない。 */
export const HUMAN_VERIFIED = "human-verified";

export function attestationFor({ reviewer, isInteractive, agentAttested, humanVerified }) {
  const name = String(reviewer || "").trim();
  if (!name) {
    return { ok: false, message: "reviewer 名が要ります（--reviewer <名前>）。" };
  }
  // 明示が推測に勝つ。TTY より --agent-attested を先に見る。
  // 逆順だったので、PTY 経由の機械が人として記録されていた。
  if (agentAttested) {
    return {
      ok: true,
      attestation: { reviewer: "agent", attestedBy: "agent-self-attested", claimedReviewer: name },
    };
  }
  if (humanVerified) {
    if (!isInteractive) {
      return {
        ok: false,
        message:
          "--human-verified は対話端末からのみ受け付けます。"
          + "機械の判断として残すなら --agent-attested を付けてください。",
      };
    }
    // 二手を要求する。TTY だけでは足りない（PTY で作れる）。
    // これは詐称を止める仕掛けではなく、詐称を「既定の経路」から外して
    // 記録に残す仕掛け。止めるのは commit を読む人。
    return { ok: true, attestation: { reviewer: name, attestedBy: HUMAN_VERIFIED } };
  }
  if (isInteractive) {
    // 対話端末だったという事実だけ。人が読んだ証拠ではない。
    return {
      ok: true,
      attestation: { reviewer: name, attestedBy: "cli-interactive-claimed" },
    };
  }
  return {
    ok: false,
    message:
      "人の確認として記録しようとしていますが、その裏づけがありません。"
      + "人が確認したのなら、その人自身の端末から --human-verified を付けて実行してください。"
      + "機械の判断として残すなら --agent-attested を付けてください"
      + "（reviewer は 'agent' として記録され、人の確認とは区別されます）。",
  };
}

export function channelTermsInSharedEntry(entry, signals) {
  const target = String(entry?.target || "");
  const isShared = !(target.startsWith("channel-pack:") || target.startsWith("ledger:") || target.startsWith("doc:"));
  if (!isShared) return { ok: true, hits: 0 };
  const body = `${entry?.text || ""}\u001f${entry?.evidence || ""}`;
  const terms = (signals?.terms || []).filter((term) => body.includes(term));
  const ids = (signals?.castIds || []).filter((id) => new RegExp(`\\b${id}\\b`, "u").test(body));
  const hits = terms.length + ids.length;
  return {
    ok: hits === 0,
    hits,
    message: hits === 0 ? "" :
      `共有層（${target}）の提案に、チャンネル固有の語が ${hits} 箇所ある。`
      + "宛先が共有層でも、根拠にキャスト名や番組名を書くと公開リポジトリへ入る。"
      + "根拠を一般的な言い方へ書き換えるか、宛先を channel-pack: へ変えること。",
  };
}

/**
 * 共有層の提案に、検査語彙（語彙ファイルにだけある語）が入っていないか。
 *
 * channelTermsInSharedEntry は Channel Pack の語しか見ない。語彙ファイルにだけある
 * 語——依頼者や運営者の名前、顧客の識別子、端末の作業ディレクトリ名——は素通りし、
 * 実際に共有台帳へ「依頼者の名前＋発言の引用」が入ったまま push されるところだった。
 * 共有台帳は公開リポジトリで追跡されるので、書く前に止める。
 * 語彙を照合できない環境（鍵が無い端末）では通す——push 前の検査が同じ語彙で止める。
 */
export function privateTermsInSharedEntry(entry, vocabulary) {
  const target = String(entry?.target || "");
  const isShared = !(target.startsWith("channel-pack:") || target.startsWith("ledger:") || target.startsWith("doc:"));
  if (!isShared || !vocabulary) return { ok: true, hits: 0, checked: Boolean(vocabulary) };
  const { hits } = redactVocabularyDigestTokens(`${entry?.text || ""} ${entry?.evidence || ""}`, vocabulary);
  return {
    ok: hits === 0,
    hits,
    checked: true,
    message: hits === 0 ? "" :
      `共有層（${target}）の提案に、公開してはいけない語が ${hits} 箇所ある（検査語彙に一致）。`
      + "人の名前・顧客の識別子・端末のパスを一般的な言い方へ書き換えること。"
      + "発言をそのまま引用せず、何を直すべきかの形にすること。",
  };
}

function defaultPrivateVocabulary() {
  try {
    return loadSensitiveVocabulary(path.join(REPO_ROOT, SENSITIVE_VOCABULARY_DIGEST_PATH), { projectDir: REPO_ROOT }).vocabulary;
  } catch {
    return null;
  }
}

export function buildProposal({ kind, target, text, evidence, session, now }) {
  if (!PROPOSAL_KINDS.has(kind)) {
    throw new Error(`kind は ${[...PROPOSAL_KINDS].join(" / ")} のいずれかにしてください: ${kind}`);
  }
  // 文字数は具体性の雑な代理でしかない。日本語では「目の左右が逆」のような
  // 6文字が十分に具体的な指摘になる一方、長くても中身の無い文はある。
  // ここで弾きたいのは「だめ」「違う」のような、次に読む人が何も判断できない
  // 反応だけ。本当の具体性は evidence と、status を読む人が見る。
  if (typeof text !== "string" || text.trim().length < 5) {
    throw new Error("text が短すぎます。何をどうすべきかが分かる形で書いてください");
  }
  const normalizedSession = typeof session === "string" ? session.trim() : "";
  if (!normalizedSession) {
    throw new Error("session が必要です。同じセッション内の重複捕捉を水増ししないため --session を指定してください");
  }
  requireTarget(target);
  const entry = {
    kind,
    target,
    text: text.trim(),
    evidence: evidence?.trim() || null,
    session: normalizedSession,
    capturedAt: now,
  };
  return { ...entry, id: proposalId(entry) };
}

/**
 * capture CLI と外部collectorが共有する、proposal台帳への唯一の追記経路。
 * 正本・overlay・applied台帳には触れない。
 */
export function captureLearningProposal(input, {
  append = appendJsonl,
  read = readJsonl,
  ledgerPathResolver = ledgerPathFor,
  lock = withProposalCaptureLock,
  signals = collectSensitiveSignals(REPO_ROOT),
  refreshCatalog = refreshCatalogForSharedLedger,
  privateVocabulary = undefined,
} = {}) {
  const entry = buildProposal(input);
  const verdict = channelTermsInSharedEntry(entry, signals);
  if (!verdict.ok) throw new Error(verdict.message);
  const vocabulary = privateVocabulary === undefined ? defaultPrivateVocabulary() : privateVocabulary;
  const privateVerdict = privateTermsInSharedEntry(entry, vocabulary);
  if (!privateVerdict.ok) throw new Error(privateVerdict.message);
  const ledgerPath = ledgerPathResolver(entry.target, "proposals");
  assertCaptureLedgerIsolation(entry.target, ledgerPath, ledgerPathResolver);
  return lock(ledgerPath, () => {
    const duplicate = read(ledgerPath).some((row) => {
      const id = row?.id ?? proposalId(row);
      return id === entry.id && row?.session === entry.session;
    });
    if (!duplicate) append(ledgerPath, entry);
    const catalog = duplicate ? { written: false } : refreshCatalog(ledgerPath);
    return { entry, ledgerPath, appended: !duplicate, catalog };
  });
}

function parseArgs(argv) {
  const out = { action: argv[0] };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-([a-z])/gu, (_m, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`ハーネス自己改善ループ

  capture   ユーザーの指摘を提案として記録する（何も書き換えない）
    --kind <correction|preference|constraint|fact>
    --target <${Object.keys(LEARNING_TARGETS).join("|")}>
    --text "指摘の内容を、次に読む人が判断できる粒度で"
    --evidence "根拠（ファイル:行、実測値、ユーザーの発言など）"
    --session "セッションIDなど（必須。同一セッションの重複をまとめる）"

  status    未反映の提案を、繰り返された回数順に出す

  sync      **自動反映**。各スキルの references/learned-auto.md（機械が
            丸ごと所有するファイル）を書き直す。人が書く SKILL.md には
            触らないので reviewer は要らない。review-only の宛先
            （台帳・ゲート基準）は自動反映せず保留として報告する。
            docs/learning/sensitive-vocabulary.digest.json か、その鍵
            （BUZZASSIST_SENSITIVE_VOCABULARY_KEY / ~/.buzzassist/sensitive-vocabulary.key）が無ければ止まる
            （語彙無しでは私的語の残存を検出できない）
    --allow-missing-vocabulary  開発用途のみ。語彙無しで生成し、overlay ヘッダに
                                「語彙照合なし」を刻む

  promote   overlay の項目を人の規則へ格上げする（reviewer 必須）。
            正本にその文言が実在しないと通らない
    --id <提案ID>  --reviewer <名前>  --note "どこにどう書いたか"

  review    統合案を出す（既定は dry-run。スキルには触らない）
    --apply-hint   まとめ方の助言を詳しく出す

  apply     提案を反映済みとして記録する
    --id <提案ID>  --reviewer <名前>  --note "何をどう書いたか"

  channel-pack 宛の正本は Channel Pack（BUZZASSIST_CHANNEL_PACK →
  channel-packs/<id>/）を先に読み、pack 側に無いときだけリポジトリ直下を読む。
  どれを読んだかは status / review / promote / apply の出力に出る。

  なぜこの形か: 捕捉は書き換えない、review は既定 dry-run、apply には
  reviewer 名が要る。自動で正本を書き換える作りにすると、「スクリプトが
  自分で自分に合格を出す」のと同じ構造になるため。
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date().toISOString();

  if (!args.action || args.action === "--help" || args.action === "-h") {
    printHelp();
    process.exit(args.action ? 0 : 2);
  }

  const proposals = learningLedgerPaths("proposals").flatMap(readJsonl);
  const applied = learningLedgerPaths("applied").flatMap(readJsonl);
  // 正本を実際に読んで反映を確かめる。記録を信じない。
  // channel-pack 宛は promote / apply と同じく pack を先に読む（ops-7）。
  const { readCanonical, hashCanonical } = createCanonicalReaders();
  const summary = summarizeProposals(proposals, applied, readCanonical, hashCanonical);
  // channel-pack 宛の正本をどこから読んだかを出す。共有層宛の出力は変えない。
  // 記録に残った古い target（定義から消えたもの）で表示が落ちないようにする。
  const resolutionLinesFor = (id, indent = "  ") => {
    if (!isChannelPackTarget(resolveTarget(id))) return [];
    try {
      return describeCanonicalResolution(resolveCanonicalTarget(id), { indent });
    } catch {
      return [`${indent}正本: 未知の target（${resolveTarget(id)}）`];
    }
  };
  const canonicalResolutionLines = (targetIds) => [...new Set(targetIds.map((id) => resolveTarget(id)))]
    .filter((id) => isChannelPackTarget(id))
    .sort()
    .flatMap((id) => [`  ${id}`, ...resolutionLinesFor(id, "    ")]);

  switch (args.action) {
    case "capture": {
      const { entry } = captureLearningProposal({
        kind: args.kind,
        target: args.target,
        text: args.text,
        evidence: args.evidence,
        session: args.session,
        now,
      });
      const repeats = proposals.filter((p) => (p.id ?? proposalId(p)) === entry.id).length;
      process.stdout.write(`記録しました: ${entry.id}\n`);
      if (repeats > 0) {
        process.stdout.write(
          `  ⚠️ 同じ指摘は これで ${repeats + 1} 回目です。まだ正本へ反映できていません\n`,
        );
      }
      process.stdout.write(`  反映先候補: ${LEARNING_TARGETS[entry.target]}\n`);
      for (const line of resolutionLinesFor(entry.target)) process.stdout.write(`${line}\n`);
      break;
    }

    case "status": {
      const pending = summary.filter((entry) => !entry.applied);
      // 反映済みの判定に使った正本の読み先（channel-pack 宛だけ）。
      const resolution = canonicalResolutionLines(summary.map((entry) => entry.target));
      const writeResolution = () => {
        if (resolution.length === 0) return;
        process.stdout.write(`\n正本の読み先（channel-pack 宛は Channel Pack を先に見る）\n${resolution.join("\n")}\n`);
      };
      if (pending.length === 0) {
        process.stdout.write("未反映の提案はありません\n");
        writeResolution();
        break;
      }
      process.stdout.write(`未反映 ${pending.length} 件（繰り返し回数順）\n\n`);
      for (const entry of pending) {
        const repeat = entry.occurrences > 1 ? ` ×${entry.occurrences}` : "";
        process.stdout.write(`  [${entry.id}]${repeat} ${entry.kind} → ${entry.target}\n`);
        process.stdout.write(`      ${entry.text}\n`);
        for (const ev of entry.evidence) process.stdout.write(`      根拠: ${ev}\n`);
      }
      writeResolution();
      break;
    }

    case "review": {
      const clusters = clusterForConsolidation(summary);
      if (clusters.length === 0) {
        process.stdout.write("統合するものはありません\n");
        break;
      }
      process.stdout.write("統合案（dry-run。ここでは何も書き換えていません）\n\n");
      for (const cluster of clusters) {
        process.stdout.write(`▼ ${cluster.target} → ${LEARNING_TARGETS[cluster.target]}\n`);
        // 書き足す先を取り違えないよう、実際に読む（promote / apply が照合する）ファイルを出す。
        for (const line of resolutionLinesFor(cluster.target)) process.stdout.write(`${line}\n`);
        process.stdout.write(`  ${cluster.recommendation}\n`);
        for (const entry of cluster.entries) {
          const repeat = entry.occurrences > 1 ? ` ×${entry.occurrences}` : "";
          process.stdout.write(`  - [${entry.id}]${repeat} ${entry.text}\n`);
        }
        process.stdout.write("\n");
      }
      process.stdout.write(
        "反映するときは、ここに出た提案を **1件ずつ追記するのではなく**、\n"
        + "その target の既存の節へ吸収するか、クラスレベルの1節にまとめて書く。\n"
        + "個別事象を並べた文書は読まれなくなり、学習として機能しない。\n"
        + "書いたあと apply --id <id> --reviewer <名前> --note \"どう書いたか\" を実行する。\n",
      );
      break;
    }

    case "sync": {
      // 自動反映。機械が丸ごと所有する overlay ファイルだけを書き直す。
      // 人が書く正本（canonical）には一切触らない。
      // review-only の宛先は、そこが承認と監査の記録そのものなので
      // 自動反映しない——機械がゲート基準を緩められる余地を作らない。
      const targets = loadTargets();
      const pending = summary.filter((entry) => !entry.applied);
      const byTarget = new Map();
      for (const entry of pending) {
        if (!byTarget.has(entry.target)) byTarget.set(entry.target, []);
        byTarget.get(entry.target).push(entry);
      }
      let wrote = 0;
      const held = [];
      // redaction の材料は1回だけ集める（Channel Pack の走査と digest 語彙の読み込み）。
      // digest 語彙が無ければここで止まる（fail-closed）。--allow-missing-vocabulary
      // でだけ通し、その overlay にはヘッダで印が付く。
      const allowMissingVocabulary = args.allowMissingVocabulary === true;
      const redaction = overlayRedactionContext({ allowMissingVocabulary });
      if (redaction.vocabularyMissing) {
        process.stdout.write(
          `⚠️  ${SENSITIVE_VOCABULARY_DIGEST_PATH} が無いまま生成します（--allow-missing-vocabulary）。\n`
          + "    overlay ヘッダに「語彙照合なし」を刻みます。配布前に語彙を作って再 sync してください。\n",
        );
      }
      for (const [target, def] of Object.entries(targets)) {
        // 旧IDで記録された提案も拾う
      const entries = [
        ...(byTarget.get(target) ?? []),
        ...Object.entries(TARGET_ALIASES)
          .filter(([, to]) => to === target)
          .flatMap(([from]) => byTarget.get(from) ?? []),
      ];
        if (def.mode === "review-only") {
          if (entries.length > 0) held.push({ target, count: entries.length, reason: def.reason });
          continue;
        }
        if (!def.overlay) continue;
        const full = path.join(REPO_ROOT, def.overlay);
        const next = renderOverlay(entries, now, redaction);
        const before = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
        if (before === next) continue;
        fs.mkdirSync(path.dirname(full), { recursive: true });
        // 一時ファイル＋rename。書き込み途中で落ちた overlay を
        // 次のセッションが指示として読むことがないように。
        const temp = `${full}.${process.pid}.partial`;
        fs.writeFileSync(temp, next);
        fs.renameSync(temp, full);
        process.stdout.write(`✅ ${def.overlay}（${entries.length}件）\n`);
        wrote += 1;
      }
      if (wrote === 0 && held.length === 0) process.stdout.write("更新するものはありませんでした\n");
      for (const h of held) {
        process.stdout.write(
          `⏸  ${h.target} は review-only なので自動反映しません（${h.count}件保留）\n`
          + `    ${h.reason ?? "人が書く記録です"}\n`,
        );
      }
      // 正本を書き換えても、ホストが読むのは配布コピー。setup を再実行
      // しないと、エージェントは古い指示を読み続ける。
      process.stdout.write(
        "\n配布し直しが要ります: 正本を書き換えたので、ホストが読む配布コピーは古いままです。\n"
        + "  node scripts/setup-agents.mjs --agent <host> --project-dir <dir> --no-launch\n"
        + "  確認: node scripts/harness-doctor.mjs（shipped-skill-drift）\n",
      );

      break;
    }

    case "promote": {
      // 機械区画の項目を、人が書いた規則へ格上げする。ここは reviewer 必須。
      // 「機械が書いた」と「人が確認した」の差がこの一手で、
      // この差が無くなると自己改善が自己認証に変わる。
      if (!args.id) throw new Error("--id が必要です");
      const attested = attestationFor({
        reviewer: args.reviewer,
        isInteractive: Boolean(process.stdin.isTTY),
        agentAttested: args["agent-attested"] === true || args.agentAttested === true,
        humanVerified: args["human-verified"] === true || args.humanVerified === true,
      });
      if (!attested.ok) throw new Error(attested.message);
      if (typeof args.reviewer !== "string" || args.reviewer.trim() === "") {
        throw new Error(
          "--reviewer <名前> が必要です。機械区画から人の規則へ上げるのは人の判断です",
        );
      }
      const entry = summary.find((item) => item.id === args.id);
      if (!entry) throw new Error(`提案が見つかりません: ${args.id}`);
      if (entry.applied) throw new Error(`${args.id} は既に昇格済みです`);
      const resolvedTarget = requireWritableTarget(entry.target);
      const { rel, full } = resolvedTarget;
      // overlay に載っているのは sync の当然の結果なので、それを拒否の
      // 条件にすると promote が永久に通らなくなる（実際そうなっていた）。
      // 見るべきは overlay ではなく **正本に書かれたか**。
      // 印を探したバイト列と sha256 を取るバイト列を同じにする。
      const canonicalBytes = fs.readFileSync(full);
      const canonicalText = canonicalBytes.toString("utf8");
      const note = typeof args.note === "string" ? args.note.trim() : "";
      if (!canonicalHasPromotionEvidence({ id: entry.id, note }, canonicalText)) {
        throw new Error(
          `${rel} に該当の記述が見つかりません。\n`
          + checkedCanonicalNote(resolvedTarget)
          + "promote は「正本へ書いたことの記録」です。先に正本へ、\n"
          + `  ${promotionMarker(entry.id)}\n`
          + `という一意マーカーと、${PROMOTION_NOTE_MIN_CHARS}文字以上の規則本文を書き、`
          + "--note にその本文を完全一致で渡してください。",
        );
      }
      appendJsonl(ledgerPathFor(entry.target, "applied"), {
        id: entry.id,
        target: entry.target,
        targetPath: rel,
        targetSha256: createHash("sha256").update(canonicalBytes).digest("hex"),
        targetSource: recordedCanonicalSource(resolvedTarget),
        text: entry.text,
        reviewer: attested.attestation.reviewer,
        attestedBy: attested.attestation.attestedBy,
        claimedReviewer: attested.attestation.claimedReviewer ?? undefined,
        note: typeof args.note === "string" ? args.note.trim() : "",
        evidenceVersion: 2,
        promotionMarker: promotionMarker(entry.id),
        promotedAt: now,
      });
      for (const line of describeCanonicalResolution(resolvedTarget)) process.stdout.write(`${line}\n`);
      if (attested.attestation.attestedBy === HUMAN_VERIFIED) {
        process.stdout.write(`${entry.id} に人の確認記録を追加しました（reviewer: ${attested.attestation.reviewer}）\n`);
      } else {
        process.stdout.write(
          `${entry.id} を機械の自己申告として記録しました。人の確認済みにはなりません`
          + `（attestedBy: ${attested.attestation.attestedBy}）\n`,
        );
      }
      break;
    }

    case "apply": {
      if (!args.id) throw new Error("--id が必要です（status か review で確認）");
      const attested = attestationFor({
        reviewer: args.reviewer,
        isInteractive: Boolean(process.stdin.isTTY),
        agentAttested: args["agent-attested"] === true || args.agentAttested === true,
        humanVerified: args["human-verified"] === true || args.humanVerified === true,
      });
      if (!attested.ok) throw new Error(attested.message);
      if (typeof args.reviewer !== "string" || args.reviewer.trim() === "") {
        throw new Error(
          "--reviewer <名前> が必要です。誰が反映を確認したか記録しない自動反映は証跡になりません",
        );
      }
      const entry = summary.find((item) => item.id === args.id);
      if (!entry) throw new Error(`提案が見つかりません: ${args.id}`);
      if (entry.applied) throw new Error(`${args.id} は既に反映済みです`);
      const resolvedTarget = requireWritableTarget(entry.target);
      const { rel, full } = resolvedTarget;
      // apply も promote と同じ検証を通す。緩い経路を1つでも残すと、
      // そちらから素通りできてしまう。
      const applyNote = typeof args.note === "string" ? args.note.trim() : "";
      const applyBytes = fs.readFileSync(full);
      const applyText = applyBytes.toString("utf8");
      if (!canonicalHasPromotionEvidence({ id: entry.id, note: applyNote }, applyText)) {
        throw new Error(
          `${rel} に該当の記述が見つかりません。\n`
          + checkedCanonicalNote(resolvedTarget)
          + "apply は「正本へ書いたことの記録」です。先に正本へ、\n"
          + `  ${promotionMarker(entry.id)}\n`
          + `という一意マーカーと、${PROMOTION_NOTE_MIN_CHARS}文字以上の規則本文を書き、`
          + "--note にその本文を完全一致で渡してください。",
        );
      }
      appendJsonl(ledgerPathFor(entry.target, "applied"), {
        id: entry.id,
        target: entry.target,
        targetPath: rel,
        targetSha256: createHash("sha256").update(applyBytes).digest("hex"),
        targetSource: recordedCanonicalSource(resolvedTarget),
        text: entry.text,
        reviewer: attested.attestation.reviewer,
        attestedBy: attested.attestation.attestedBy,
        claimedReviewer: attested.attestation.claimedReviewer ?? undefined,
        note: applyNote,
        evidenceVersion: 2,
        promotionMarker: promotionMarker(entry.id),
        appliedAt: now,
      });
      for (const line of describeCanonicalResolution(resolvedTarget)) process.stdout.write(`${line}\n`);
      if (attested.attestation.attestedBy === HUMAN_VERIFIED) {
        process.stdout.write(`${entry.id} に人の確認記録を追加しました（reviewer: ${attested.attestation.reviewer}）\n`);
      } else {
        process.stdout.write(
          `${entry.id} を機械の自己申告として記録しました。人の確認済みにはなりません`
          + `（attestedBy: ${attested.attestation.attestedBy}）\n`,
        );
      }
      break;
    }

    default:
      throw new Error(`不明なアクション: ${args.action}`);
  }
}

if (isDirectCli(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
}
