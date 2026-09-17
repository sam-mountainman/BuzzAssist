#!/usr/bin/env node
// 公開面の検査（Claude Code / Codex 共通）
//
//   node scripts/audit-public-surface.mjs
//   node scripts/audit-public-surface.mjs --json
//   node scripts/audit-public-surface.mjs --staged     # コミット前の差分だけ
//
// なぜ要るか:
// このリポジトリは PUBLIC な配布物で、チャンネル固有のものは
// channel-packs/（追跡外）にある。だが分離は一度やれば終わりではない。
// 新しいファイルが1つ増えるたび、キャストの名前や運営者の名前が
// 紛れ込む余地ができる——実際、実名を消した後もキャスト名・舞台の地名・
// 要求台帳・第三者の逐語台本が公開されたまま残っていた。
//
// この検査が守る規則:
//
//   - **検出した文字列そのものを出さない**。件数とファイルと行番号だけ。
//     検査の出力自体が漏洩経路になっては本末転倒
//   - **探す語は Channel Pack から引く**。公開リポジトリに禁止語の一覧を
//     平文で置くと、それ自体が名簿になる
//   - **pack が無い環境では構造規則だけ見る**。語が引けないことを
//     「問題なし」と報告しない

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { homedir } from "node:os";

import { channelPackRootEntries, channelPackPresent } from "../lib/channelPackResolver.mjs";
import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import { countVocabularyDigestHits } from "../lib/packageTarballAudit.mjs";
// 循環 import（audit-package-tarball もこのファイルを読む）だが、どちらも関数を
// 実行時に呼ぶだけなので評価順に依存しない。
import { loadSensitiveVocabulary, SENSITIVE_VOCABULARY_DIGEST_PATH } from "./audit-package-tarball.mjs";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ROSTER_CONTEXT_KEY = /(?:cast|character|speaker|member|roster)/iu;
const CHANNEL_CONTEXT_KEY = /(?:channel|show|location|town)/iu;
const EXPLICIT_ROSTER_ID_KEY = /^(?:cast|character|member)[_-]?id$/iu;

function jsonFilesBelow(root, { maxFiles = 1_000, maxDepth = 8 } = {}) {
  const files = [];
  const visit = (dir, depth) => {
    if (depth > maxDepth || files.length >= maxFiles || !existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= maxFiles) break;
      const full = path.join(dir, entry.name);
      let info;
      try { info = lstatSync(full); } catch { continue; }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) visit(full, depth + 1);
      else if (info.isFile() && entry.name.toLowerCase().endsWith(".json") && info.size <= 8 * 1024 * 1024) files.push(full);
    }
  };
  visit(root, 0);
  return files;
}

function collectStructuredSignals(value, { terms, castIds }, ancestors = [], key = "") {
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredSignals(item, { terms, castIds }, [...ancestors, key], key);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      collectStructuredSignals(child, { terms, castIds }, [...ancestors, key], childKey);
    }
    return;
  }
  const strings = typeof value === "string" ? [value] : [];
  const context = [...ancestors, key].join(".");
  const immediateParent = [...ancestors].reverse().find((value) => value) || "";
  for (const raw of strings) {
    const text = raw.trim();
    if (!text || text.length > 240 || /^(?:https?:|file:|sha256:)/iu.test(text)) continue;
    const normalizedKey = key.replace(/[_-]/gu, "").toLowerCase();
    const rosterTerm = ROSTER_CONTEXT_KEY.test(context)
      && ["name", "displayname", "hiddenname", "alias", "aliases"].includes(normalizedKey);
    const channelTerm = CHANNEL_CONTEXT_KEY.test(context)
      && ["name", "displayname", "hiddenname", "town"].includes(normalizedKey);
    if (rosterTerm || channelTerm) terms.add(text);
    const normalizedIdKey = key.replace(/[_-]/gu, "");
    const directRosterId = normalizedIdKey.toLowerCase() === "id"
      && /^(?:cast|characters?|members?|roster)$/iu.test(immediateParent);
    if (directRosterId || (EXPLICIT_ROSTER_ID_KEY.test(key) && ROSTER_CONTEXT_KEY.test(context))) {
      castIds.add(text);
    }
  }
}

/**
 * 探す語を Channel Pack から集める。禁止語の一覧を公開リポジトリに
 * 平文で置くと、それ自体が名簿になる。
 */
export function collectSensitiveTerms(projectDir = REPO_ROOT) {
  const { terms } = collectSensitiveSignals(projectDir);
  return terms;
}

/**
 * 表示名・ID・ホームディレクトリを別々に集める。
 * 表示名だけを照合していたので、ID の一覧と開発機の絶対パスが
 * 公開されたまま「検出なし」と報告していた。
 */
export function collectSensitiveSignals(projectDir = REPO_ROOT) {
  const terms = new Set();
  const castIds = new Set();
  for (const entry of channelPackRootEntries(projectDir)) {
    if (entry.kind === "fixture" || !existsSync(entry.root)) continue;
    const files = [
      ...jsonFilesBelow(path.join(entry.root, "config")),
      ...jsonFilesBelow(path.join(entry.root, "registry")),
    ];
    for (const file of [...new Set(files)]) {
      let parsed;
      try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
      collectStructuredSignals(parsed, { terms, castIds });
      for (const member of parsed.cast || []) {
        for (const value of [member.name, member.hiddenName, ...(member.aliases || [])]) {
          if (value) terms.add(String(value));
        }
      }
      // ID も集める。表示名だけを見ていたので、**11人分の castId が
      // 並んだ一覧が公開されたまま検査は clean と報告していた**。
      // ID 単体は一般語と衝突しうるので、名簿としての密度で判定する
      // （下の rosterDensity）。
      for (const member of parsed.cast || []) {
        if (member.id) castIds.add(String(member.id));
      }
      for (const location of parsed.locations || []) {
        if (location.name) terms.add(String(location.name));
      }
      for (const key of ["name", "town", "setting", "displayName"]) {
        if (parsed.channel?.[key]) terms.add(String(parsed.channel[key]));
      }
    }
  }
  // 2文字未満は一般語と衝突する。
  return {
    terms: [...terms].filter((term) => term.length >= 2).sort((a, b) => b.length - a.length),
    castIds: [...castIds].filter((id) => id.length >= 3).sort(),
  };
}

/**
 * 開発機の絶対パスの出現数。
 *
 * 検査本体は追跡下のファイルしか見ないので、現に0件のときは検出を丸ごと
 * 止めても結果が変わらず、変異が捕まらない。判定だけを取り出して
 * 直接テストできるようにする。
 */
export function countHomePathHits(text, homeRoot) {
  if (!homeRoot) return 0;
  // スラッシュ形（/Users/name/proj）だけを見ていたので、**平坦化された形が
  // 素通りしていた**。エージェントのセッションディレクトリ名は
  // /Users/x/Documents/y → -Users-x-Documents-y の形で、ログや監査記録を
  // そのまま貼ると公開面へ入る。実際 docs/ の監査記録に1件残っていて、
  // 検査は「絶対パス 0件」と報告していた。
  const source = String(text);
  let hits = (source.match(new RegExp(escapeRegExp(homeRoot), "gu")) || []).length;

  // 平坦化形は境界を要求する。素の部分文字列照合にしていたので、
  // HOME=/root のとき一般的な `project-root` が漏洩1件として数えられた。
  // 先頭の `-` を含む形（-Users-name-…）でのみ数える。
  const flattened = String(homeRoot).replace(/\//gu, "-");
  if (flattened.length >= 6 && flattened.startsWith("-")) {
    hits += (source.match(new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(flattened)}(?![A-Za-z0-9])`, "gu")) || []).length;
  }
  return hits;
}

const PATH_PLACEHOLDER_USERS = new Set([
  "a+b", "example", "test", "test user", "user", "username", "name", "your name", "x",
]);

/**
 * 実行中のHOMEだけでなく、別端末から貼られたmacOS/Linux/Windowsの
 * ユーザーディレクトリも検出する。範囲をmergeして、同じpathをHOMEの
 * exact照合と一般形の両方で二重計上しない。
 */
export function countMachineLocalPathHits(text, homeRoot = homedir()) {
  const source = String(text || "");
  const ranges = [];
  const add = (index, length) => {
    if (index >= 0 && length > 0) ranges.push([index, index + length]);
  };
  const addMatches = (regex, usernameGroup = 0) => {
    for (const match of source.matchAll(regex)) {
      const user = usernameGroup ? String(match[usernameGroup] || "").trim().toLowerCase() : "";
      if (user && PATH_PLACEHOLDER_USERS.has(user)) continue;
      add(match.index, match[0].length);
    }
  };

  const exact = String(homeRoot || "");
  if (exact) {
    addMatches(new RegExp(escapeRegExp(exact), "gu"));
    const flattened = exact.replace(/[\\/]/gu, "-").replace(/^([A-Za-z]):/u, "$1-");
    if (flattened.length >= 6 && flattened.includes("-")) {
      addMatches(new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(flattened)}(?![A-Za-z0-9])`, "gu"));
    }
  }

  addMatches(/\/(?:Users|home)\/([^/\\\r\n"'`<>]+)\//gu, 1);
  addMatches(/[A-Za-z]:[\\/]Users[\\/]([^\\/\r\n"'`<>]+)[\\/]/gu, 1);
  // Windows共有pathもmachine-local。drive letterだけを見ると、NASや社内shareを
  // review logへ貼った場合に公開面を素通りする。
  // UNC は canonical な `\\\\server\\share\\...` だけを検出する。`//server/share`
  // まで一般化すると、JavaScript の `//module/path/` コメントを共有pathとして
  // 大量に誤検出するため、forward-slash表記はここでは扱わない。
  addMatches(/\\\\([A-Za-z0-9][A-Za-z0-9._-]{0,62})\\([A-Za-z0-9$][A-Za-z0-9._$-]{0,127})\\/gu, 1);
  addMatches(/(?<![A-Za-z0-9])-(?:Users|home)-([A-Za-z0-9._]+)-/gu, 1);

  ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let count = 0;
  let end = -1;
  for (const [start, nextEnd] of ranges) {
    if (start >= end) count += 1;
    end = Math.max(end, nextEnd);
  }
  return count;
}

/** 構造規則。語が引けない環境でも、これだけは常に見る。 */
const FORBIDDEN_PATHS = Object.freeze([
  { pattern: /^channel-packs\//u, why: "Channel Pack は追跡しない" },
  { pattern: /^client-work\//u, why: "運営者の作業ディレクトリは追跡しない" },
  { pattern: /^\.codex-tmp\//u, why: "一時ディレクトリは追跡しない" },
  { pattern: /\.reference\.md$/u, why: "第三者提供の逐語台本は配布しない" },
  { pattern: /\.pdf$/iu, why: "制作資料PDFは配布しない" },
  { pattern: /^config\/harness-deployments\.json$/u, why: "配置先マップは運営者固有" },
  { pattern: /^docs\/koya-channel-(requirements-ledger|governance-ja)\.md$/u, why: "要求台帳と番組ガバナンスは Channel Pack 側" },
]);

function gitList(args, cwd) {
  const out = execFileSync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return out.toString().split("\0").filter(Boolean);
}

/**
 * 検査する範囲。
 *
 * 追跡下だけを見ていたので、**まだ追跡されていないファイルは検査に写らなかった**。
 * これは机上の穴ではない: 実話数の character-bible が未追跡のまま置かれていて、
 * 検査は「語 0件・検出なし」と報告し、その直後の `git add -A` で
 * 実キャストの表示名が公開リポジトリへ入った。**検査が clean と言った後に
 * 漏れた**——「見ていない」を「無い」として報告する型そのもの。
 *
 * なので既定では、`git add -A` が拾うもの（追跡下＋未追跡かつ ignore 外）を
 * 全部見る。ignore されているものは commit されないので対象外でよい。
 */
export function filesInScope({ stagedOnly = false, projectDir = REPO_ROOT, revision = "" } = {}) {
  const cwd = path.resolve(projectDir);
  // push 前の検査は、作業ツリーではなく**そのコミットが持ち込む中身**を見る。
  // --root は親の無いコミットでもファイルを列挙させるため。
  if (revision) {
    return gitList(["diff-tree", "--no-commit-id", "-r", "--root", "--diff-filter=AMR", "--name-only", "-z", revision], cwd);
  }
  if (stagedOnly) return gitList(["diff", "--cached", "--name-only", "-z"], cwd);
  return [
    ...gitList(["ls-files", "-z"], cwd),
    ...gitList(["ls-files", "--others", "--exclude-standard", "-z"], cwd),
  ];
}

/**
 * 検査する中身。
 *
 * `--staged` はファイル名を index から取りながら、**中身は作業ツリーから**
 * 読んでいた。秘密入りの版を stage した後で作業ツリーだけ直すと、検査は
 * 直った方を読み、commit には秘密入りの版が入る。差分の検査を名乗るなら
 * 差分の中身を読むこと。
 */
function readCandidate(relative, { stagedOnly, projectDir, revision = "" }) {
  const cwd = path.resolve(projectDir);
  if (stagedOnly || revision) {
    try {
      const spec = revision ? `${revision}:${relative}` : `:${relative}`;
      const out = execFileSync("git", ["show", spec], { cwd, maxBuffer: 64 * 1024 * 1024 });
      return { text: out.toString("utf8"), bytes: out.length };
    } catch {
      // index から消えた（削除の stage）。中身は無いので検査対象にならない。
      return { text: null, bytes: 0, absent: true };
    }
  }
  const full = path.join(cwd, relative);
  if (!existsSync(full)) return { text: null, bytes: 0, absent: true };
  let bytes = 0;
  try { bytes = statSync(full).size; } catch { return { text: null, bytes: 0, unreadable: true }; }
  if (bytes > MAX_SCAN_BYTES) return { text: null, bytes, tooLarge: true };
  try { return { text: readFileSync(full, "utf8"), bytes }; } catch { return { text: null, bytes, unreadable: true }; }
}

/**
 * 大きすぎるものを黙って飛ばさない。
 *
 * 4MiB 超・読取失敗・巨大な単一行を `continue` で捨てていた。捨てたことは
 * どこにも出ず、`gateOk` にも反映されない——「検出できない＝免除」。
 * dist-widget のバンドルは約 7.7MiB あって、まさにこの条件に当たっていた。
 * バンドルは src/ を丸ごと含むので、漏れがあればここにも写る。
 * 飛ばしたぶんは `scanIncomplete` に残し、ゲートを閉じる。
 */
const MAX_SCAN_BYTES = 32 * 1024 * 1024;

/** 名簿としての密度。ID 単体は一般語と衝突するので、同居数で判定する。 */
const ROSTER_DENSITY = 3;

/**
 * 既知の未解決を、理由つきで明示する場所。
 *
 * なぜ要るか: 検査は常に exit 2 を返す状態で、**CI にも pre-commit にも
 * 載せられなかった**。載らない検査は、誰かが手で叩いたときにしか働かない。
 * さらにテスト側が「未解決が存在すること」を assert していたので、
 * **実際に直すとテストが落ちる**——漏れが仕様として固定されていた。
 *
 * 許容一覧にすると、両方が解ける:
 *   - 一覧に無い検出が1件でも出れば落ちる（＝新しい漏れは止まる）
 *   - 一覧にあるのに検出されなくなったら落ちる（＝直したら一覧から消せと言う）
 * 「まだ直っていない」と「見なかったことにする」の差は、理由が書いてあるか。
 */
const ALLOWLIST_FILE = "config/public-surface-allowlist.json";

export function readAllowlist(projectDir = REPO_ROOT) {
  const file = path.join(projectDir, ALLOWLIST_FILE);
  if (!existsSync(file)) return { roster: [], term: [], path: [], pathLeak: [], privateTerm: [] };
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return {
    roster: parsed.roster || [],
    term: parsed.term || [],
    path: parsed.path || [],
    pathLeak: parsed.pathLeak || [],
    // tarball 監査はこの区分を読むのに、ここで返していなかったので常に空だった。
    privateTerm: parsed.privateTerm || [],
  };
}

/**
 * その検出の「大きさ」。許容一覧をこれに束縛する。
 *
 * ファイル名だけで一致を見ていたので、**同じファイルの中で漏れが増えても
 * 許容されたまま**だった。3個の ID を理由に許した名簿へ残り8個を足しても
 * 新しい漏洩として出てこない。一覧は「このファイルは見なかったことにする」
 * ではなく「このファイルにこれだけ、という状態を承知している」であるべき。
 */
function findingSize(finding) {
  if (typeof finding.idCount === "number") return finding.idCount;
  if (typeof finding.hits === "number") return finding.hits;
  return 1;
}

function splitByAllowlist(findings, allowed) {
  const byFile = new Map(allowed.map((entry) => [entry.file, entry]));
  const unresolved = [];
  const accepted = [];
  for (const finding of findings) {
    const entry = byFile.get(finding.file);
    if (!entry) { unresolved.push(finding); continue; }
    const size = findingSize(finding);
    // 件数を書いていない一覧は、書いた時点の件数を承知したとみなせない。
    if (typeof entry.count !== "number") {
      unresolved.push({ ...finding, whyUnresolved: "許容一覧に count が無い（承知した件数を書くこと）" });
      continue;
    }
    if (size > entry.count) {
      unresolved.push({
        ...finding,
        whyUnresolved: `許容した ${entry.count} 件から ${size} 件へ増えている`,
      });
      continue;
    }
    accepted.push({ ...finding, why: entry.why, count: entry.count, current: size });
  }
  // 一覧にあるのに検出されないものは、直った証拠。一覧から消させる。
  const stale = allowed.filter((entry) => !findings.some((f) => f.file === entry.file));
  return { unresolved, accepted, stale };
}

/**
 * 鍵つき検査語彙（docs/learning/sensitive-vocabulary.digest.json）を読む。
 *
 * 公開面の検査は Channel Pack の語しか見ていなかった。語彙ファイルにだけある語
 * （運営者や依頼者の名前、顧客の識別子、端末の作業ディレクトリ名）は push 前の
 * 検査を素通りし、実際に共有の学習台帳へ依頼者の名前と発言の引用が入ったまま
 * push されるところだった。
 *
 * 鍵が無い環境では「照合していない」を未検査として返す（一致なしとは言わない）。
 */
export function loadPrivateVocabulary(root = REPO_ROOT) {
  const file = path.join(path.resolve(root), SENSITIVE_VOCABULARY_DIGEST_PATH);
  // 語彙ファイルが無いプロジェクトは「見る語が宣言されていない」。未検査とは言わない。
  if (!existsSync(file)) return { vocabulary: null, state: "missing-file" };
  try {
    return loadSensitiveVocabulary(file, { projectDir: path.resolve(root) });
  } catch (error) {
    return { vocabulary: null, state: "unreadable", reason: String(error?.message || error) };
  }
}

export function auditPublicSurface({ projectDir = REPO_ROOT, stagedOnly = false, revision = "", privateVocabulary = null } = {}) {
  const root = path.resolve(projectDir);
  const { terms, castIds } = collectSensitiveSignals(root);
  const packAvailable = channelPackPresent(root);
  let files = [];
  let enumerationError = "";
  try {
    files = filesInScope({ stagedOnly, projectDir: root, revision });
  } catch (error) {
    // git 作業ツリーでない場所を渡された。例外で落とすと呼び出し側は
    // 結果を得られず、「検査した」とも「していない」とも言えなくなる。
    enumerationError = `ファイルを列挙できなかった（git 作業ツリーではない）: ${String(error?.code || error?.message || error)}`;
  }

  const pathFindings = [];
  for (const relative of files) {
    for (const rule of FORBIDDEN_PATHS) {
      if (rule.pattern.test(relative)) pathFindings.push({ file: relative, why: rule.why });
    }
  }

  // 検出した文字列そのものは記録しない。件数とファイルと行番号だけ。
  const termFindings = [];
  const rosterFindings = [];
  const pathLeakFindings = [];
  const privateTermFindings = [];
  const scanIncomplete = [];
  // 語彙は push の瞬間の作業ツリーから読む（コミット時点の語彙ではない）。
  const privateLoaded = privateVocabulary ?? loadPrivateVocabulary(root);
  const privateVocab = privateLoaded.vocabulary || null;
  const homeRoot = homedir();
  for (const relative of files) {
    const candidate = readCandidate(relative, { stagedOnly, projectDir: root, revision });
    if (candidate.absent) continue;
    if (candidate.tooLarge) {
      scanIncomplete.push({ file: relative, why: `${Math.round(candidate.bytes / 1024)}KiB は上限超で未検査`, bytes: candidate.bytes });
      continue;
    }
    if (candidate.unreadable || candidate.text === null) {
      scanIncomplete.push({ file: relative, why: "読み取れないので未検査" });
      continue;
    }
    const text = candidate.text;
    if (!text.includes("\n") && text.length > 1_000_000) {
      scanIncomplete.push({ file: relative, why: "改行の無い巨大な1行で未検査" });
      continue;
    }
    const lines = text.split("\n");
    let hits = 0;
    const lineNumbers = [];
    for (let i = 0; i < lines.length; i += 1) {
      for (const term of terms) {
        if (lines[i].includes(term)) {
          hits += 1;
          if (lineNumbers.length < 10) lineNumbers.push(i + 1);
          break;
        }
      }
    }
    if (hits > 0) termFindings.push({ file: relative, hits, lines: lineNumbers });

    // ID の名簿。表示名だけを見ていたので、castId が並んだ一覧が
    // 公開されたまま「検出なし」と報告していた。ID 単体は一般語と衝突する
    // ので、**同じファイルに何個同居しているか**で見る。
    const presentIds = castIds.filter((id) => new RegExp(`\\b${escapeRegExp(id)}\\b`, "u").test(text));
    if (presentIds.length >= ROSTER_DENSITY) {
      rosterFindings.push({ file: relative, idCount: presentIds.length, of: castIds.length });
    }

    // 開発機の絶対パス。運営者にも配布物にも要らないうえ、
    // ホームディレクトリ名は個人を指す。
    const homeHits = countMachineLocalPathHits(text, homeRoot);
    if (homeHits > 0) pathLeakFindings.push({ file: relative, hits: homeHits });

    // 語彙ファイルにだけある語。語そのものは返さない（件数だけ）。
    if (privateVocab) {
      const privateHits = countVocabularyDigestHits(text, privateVocab);
      if (privateHits > 0) privateTermFindings.push({ file: relative, hits: privateHits });
    }
  }

  const allowlist = readAllowlist(root);
  const roster = splitByAllowlist(rosterFindings, allowlist.roster);
  const term = splitByAllowlist(termFindings, allowlist.term);
  const pathLeak = splitByAllowlist(pathLeakFindings, allowlist.pathLeak);
  const pathRule = splitByAllowlist(pathFindings, allowlist.path);
  const privateTerm = splitByAllowlist(privateTermFindings, allowlist.privateTerm);

  // 検査源が無い区分の stale を「直った」と読まない。
  //
  // これを分けていなかったので、**pack を持たない環境（CI・新しい運営者の
  // クローン）では許容一覧の全件が「もう検出されない＝直った」と判定され、
  // ゲートが必ず落ちた**。同時に検査本体は「構造規則の範囲では検出なし」で
  // exit 0 を返していた——落ちる理由と通す理由が食い違っていた。
  // 見ていない区分は、合格でも不合格でもなく「未検査」。
  const signalDependent = { roster: packAvailable, term: packAvailable, path: true, pathLeak: true };
  // 1コミット分の検査では、許容一覧の大半は「そのコミットが触っていない」
  // だけで、直ったわけではない。stale は全体走査のときだけ数える。
  const stale = revision ? [] : [
    ...(signalDependent.roster ? roster.stale : []),
    ...(signalDependent.term ? term.stale : []),
    ...pathLeak.stale,
    ...pathRule.stale,
    ...(privateVocab ? privateTerm.stale : []),
  ];
  const unchecked = [];
  if (enumerationError) unchecked.push(enumerationError);
  if (!packAvailable) unchecked.push("チャンネル固有語と固定キャストの名簿（Channel Pack が無い）");
  if (!privateVocab && privateLoaded.state !== "missing-file") {
    unchecked.push(`検査語彙の語（${privateLoaded.state === "missing-key" ? "鍵が無い" : "語彙ファイルを読めない"}）`);
  }
  if (scanIncomplete.length > 0) unchecked.push(`${scanIncomplete.length} ファイルの中身（上限超・読み取り不可）`);

  const unresolved = {
    path: pathRule.unresolved, term: term.unresolved,
    roster: roster.unresolved, pathLeak: pathLeak.unresolved,
    privateTerm: privateTerm.unresolved,
  };
  const unresolvedCount = unresolved.path.length + unresolved.term.length
    + unresolved.roster.length + unresolved.pathLeak.length + unresolved.privateTerm.length;

  // 判定は1つにする。clean と gateOk を別条件で同居させていたので、
  // どちらを「公開してよい」と呼ぶかが未定義だった。
  //   clean          … 検出も未検査も無い
  //   accepted-risk  … 検出はあるが全て理由つきで一覧にある
  //   incomplete     … 見ていない区分がある（合格ではない）
  //   failed         … 一覧に無い検出、または直ったのに一覧へ残っている
  let status;
  if (unresolvedCount > 0 || stale.length > 0) status = "failed";
  else if (unchecked.length > 0) status = "incomplete";
  else if (pathFindings.length + termFindings.length + rosterFindings.length + pathLeakFindings.length
    + privateTermFindings.length > 0) status = "accepted-risk";
  else status = "clean";

  return {
    version: "public-surface-audit-v3",
    scope: revision ? `commit:${revision.slice(0, 12)}` : stagedOnly ? "staged" : "tracked+untracked",
    projectDir: root,
    fileCount: files.length,
    // 語が引けなかったことを「問題なし」と報告しない。
    termSourceAvailable: packAvailable,
    termCount: terms.length,
    castIdCount: castIds.length,
    pathFindings,
    termFindings,
    rosterFindings,
    pathLeakFindings,
    privateTermFindings,
    privateVocabularyState: privateVocab ? "available" : privateLoaded.state,
    scanIncomplete,
    unchecked,
    // clean は status から導く。別条件で同居させていたので、
    // **見られなかったファイルがあっても clean が true になった**。
    // どちらを「公開してよい」と呼ぶかが未定義のまま2つある状態を無くす。
    clean: status === "clean",
    unresolved,
    accepted: {
      path: pathRule.accepted, term: term.accepted,
      roster: roster.accepted, pathLeak: pathLeak.accepted,
      privateTerm: privateTerm.accepted,
    },
    staleAllowlist: stale,
    status,
    // ゲートは failed のときだけ閉じる。未検査で止めると、pack を持たない
    // CI が永久に赤になり、検査ごと外される——それが一番まずい。
    // 未検査であることは status と出力に必ず出す。
    gateOk: status !== "failed",
  };
}

const ZERO_SHA = /^0+$/u;

/**
 * push される範囲の、全コミットを検査する。
 *
 * pre-push フックは作業ツリーを検査していた。**push されるのは作業ツリーでは
 * なくコミット**なので、作業ツリーが clean な状態で漏洩入りのブランチを push
 * すると素通りした。実際、作業ツリーを丸ごと保存した snapshot ブランチ3本と
 * 作業ブランチ2本が、番組設定の写し・全キャストの名簿・開発機のパスを
 * コミットとして抱えていた。
 *
 * もう一つの理由は、**語彙は後から増える**こと。コミットした時点では pack に
 * 無かった地名が後から登録され、16日前に clean と確認したコミットが、push
 * する時点では漏洩になっていた。だから検査は push の瞬間に、現在の語彙で行う。
 *
 * 途中のコミットで入れて次のコミットで消した漏洩も、履歴として push される
 * ので、先端だけでなく範囲内の全コミットを見る。
 */
export function auditPushRefs(lines, { projectDir = REPO_ROOT, privateVocabulary = null } = {}) {
  const root = path.resolve(projectDir);
  const privateLoaded = privateVocabulary ?? loadPrivateVocabulary(root);
  const results = [];
  for (const raw of lines) {
    const [localRef, localSha, remoteRef, remoteSha] = String(raw).trim().split(/\s+/u);
    if (!localSha || ZERO_SHA.test(localSha)) continue; // 削除の push
    const rangeArgs = remoteSha && !ZERO_SHA.test(remoteSha)
      ? [localSha, `^${remoteSha}`]
      : [localSha, "--not", "--remotes"]; // 新しいブランチ: どの remote にも無いコミット
    const commits = execFileSync("git", ["rev-list", "--reverse", ...rangeArgs], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
      .toString().split("\n").filter(Boolean);
    for (const sha of commits) {
      const report = auditPublicSurface({ projectDir: root, revision: sha, privateVocabulary: privateLoaded });
      results.push({ localRef, remoteRef, sha, report });
    }
  }
  const failed = results.filter((entry) => entry.report.status === "failed");
  const incomplete = results.filter((entry) => entry.report.status === "incomplete");
  return { commitCount: results.length, results, failed, incomplete };
}

const STATUS_LABEL = {
  clean: "clean — 検出も未検査も無い",
  "accepted-risk": "accepted-risk — 検出はあるが全て理由つきで一覧にある",
  incomplete: "incomplete — 見ていない区分がある（合格ではない）",
  failed: "failed — 一覧に無い検出、または直ったのに一覧へ残っている",
};

function render(report) {
  const lines = [];
  lines.push(`公開面の検査（${report.scope}・${report.fileCount}ファイル）`);
  if (!report.termSourceAvailable) {
    lines.push("");
    lines.push("  ⚠ Channel Pack が無いので、固有名詞と名簿の検査はできていない。");
    lines.push("    構造規則だけを見た結果であり、「問題なし」ではない。");
  } else {
    lines.push(`  Channel Pack から ${report.termCount} 語を引いて照合した`);
  }
  lines.push("");
  if (report.pathFindings.length > 0) {
    lines.push("配布してはいけないパス:");
    for (const finding of report.pathFindings) lines.push(`  ${finding.file}  — ${finding.why}`);
    lines.push("");
  }
  if (report.termFindings.length > 0) {
    // 検出した語そのものは出さない。検査の出力自体が漏洩経路になっては本末転倒。
    lines.push("チャンネル固有語の検出（語そのものは表示しない）:");
    for (const finding of report.termFindings) {
      lines.push(`  ${finding.file}  ${finding.hits}件  行 ${finding.lines.join(", ")}${finding.hits > finding.lines.length ? " …" : ""}`);
    }
    lines.push("");
  }
  if (report.rosterFindings.length > 0) {
    lines.push("固定キャストの名簿（ID の同居数で判定・ID そのものは表示しない）:");
    for (const finding of report.rosterFindings) {
      lines.push(`  ${finding.file}  ${finding.idCount}/${finding.of} 個`);
    }
    lines.push("");
  }
  if (report.pathLeakFindings.length > 0) {
    lines.push("開発機の絶対パス:");
    for (const finding of report.pathLeakFindings) lines.push(`  ${finding.file}  ${finding.hits}件`);
    lines.push("");
  }
  if ((report.privateTermFindings || []).length > 0) {
    lines.push("検査語彙の語（語彙ファイルにだけある語。語そのものは表示しない）:");
    for (const finding of report.privateTermFindings) lines.push(`  ${finding.file}  ${finding.hits}件`);
    lines.push("");
  }
  if (report.scanIncomplete.length > 0) {
    lines.push("中身を見られなかったファイル（未検査として数える。飛ばしたことを黙らない）:");
    for (const entry of report.scanIncomplete.slice(0, 20)) lines.push(`  ${entry.file}  — ${entry.why}`);
    if (report.scanIncomplete.length > 20) lines.push(`  …ほか ${report.scanIncomplete.length - 20} 件`);
    lines.push("");
  }
  if (report.staleAllowlist.length > 0) {
    lines.push("許容一覧に載っているが、もう検出されないもの（直ったので消すこと）:");
    for (const entry of report.staleAllowlist) lines.push(`  ${entry.file}`);
    lines.push("");
  }
  const u = report.unresolved;
  const unresolvedCount = u.path.length + u.term.length + u.roster.length + u.pathLeak.length
    + (u.privateTerm || []).length;
  if (unresolvedCount > 0) {
    lines.push("一覧に無い、または一覧より増えている検出:");
    for (const finding of [...u.path, ...u.term, ...u.roster, ...u.pathLeak, ...(u.privateTerm || [])]) {
      lines.push(`  ${finding.file}${finding.whyUnresolved ? `  — ${finding.whyUnresolved}` : ""}`);
    }
    lines.push("");
  }
  const acceptedAll = [...report.accepted.path, ...report.accepted.term,
    ...report.accepted.roster, ...report.accepted.pathLeak, ...(report.accepted.privateTerm || [])];
  const acceptedCount = acceptedAll.length;
  if (acceptedCount > 0) {
    lines.push(`理由つきで一覧に記録された未解決 ${acceptedCount} 件:`);
    for (const finding of acceptedAll) {
      lines.push(`  ${finding.file}  ${finding.current}/${finding.count} — ${finding.why}`);
    }
    lines.push("");
  }
  if (report.unchecked.length > 0) {
    lines.push("見ていない区分:");
    for (const why of report.unchecked) lines.push(`  ${why}`);
    lines.push("");
  }
  lines.push(STATUS_LABEL[report.status] || report.status);
  if (report.status === "incomplete") {
    lines.push("  ゲートは通すが、これは合格ではない。固有名詞まで見るには");
    lines.push("  Channel Pack のある環境で走らせること（--require-signals で強制できる）。");
  }
  return lines.join("\n");
}

if (isDirectCli(import.meta.url)) {
  const asJson = process.argv.includes("--json");
  const stagedOnly = process.argv.includes("--staged");
  const requireSignals = process.argv.includes("--require-signals");
  if (process.argv.includes("--push-stdin")) {
    // git の pre-push は「<local ref> <local sha> <remote ref> <remote sha>」を
    // 1行ずつ stdin へ渡す。
    const input = readFileSync(0, "utf8").split("\n").filter((line) => line.trim());
    const range = auditPushRefs(input);
    for (const entry of range.failed) {
      process.stdout.write(`\n✗ ${entry.localRef} ${entry.sha.slice(0, 12)}\n${render(entry.report)}\n`);
    }
    process.stdout.write(`\npush 範囲のコミット ${range.commitCount} 件を検査: `
      + `failed ${range.failed.length} / incomplete ${range.incomplete.length}\n`);
    if (range.failed.length > 0) process.exitCode = 2;
    else if (requireSignals && range.incomplete.length > 0) {
      process.stdout.write("--require-signals: 未検査の区分があるコミットを通しません。\n");
      process.exitCode = 3;
    }
  } else {
  const revisionIndex = process.argv.indexOf("--revision");
  const revision = revisionIndex > 0 ? String(process.argv[revisionIndex + 1] || "") : "";
  const report = auditPublicSurface({ stagedOnly, revision });
  process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : `${render(report)}\n`);
  // ゲートは「一覧に無い新しい検出」で判定する。常に 2 を返す検査は
  // CI にも pre-commit にも載せられず、手で叩いたときしか働かない。
  if (!report.gateOk) process.exitCode = 2;
  // 配布直前や pre-push では「未検査」も通さない。CI（pack 無し）と
  // 手元（pack あり）で要求を変えられるようにする。
  if (requireSignals && report.status !== "clean" && report.status !== "accepted-risk") {
    process.stdout.write("\n--require-signals: 未検査の区分があるので通しません。\n");
    process.exitCode = 3;
  }
  }
}
