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
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { homedir } from "node:os";

import { channelPackRootEntries, channelPackPresent } from "../lib/channelPackResolver.mjs";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

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
    for (const relative of ["config/koya-show-bible.json", "config/koya-location-bible.json"]) {
      const file = path.join(entry.root, relative);
      if (!existsSync(file)) continue;
      let parsed;
      try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
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
  return (String(text).match(new RegExp(escapeRegExp(homeRoot), "gu")) || []).length;
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

function trackedFiles({ stagedOnly = false } = {}) {
  const args = stagedOnly ? ["diff", "--cached", "--name-only", "-z"] : ["ls-files", "-z"];
  const out = execFileSync("git", args, { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
  return out.toString().split("\0").filter(Boolean);
}

/** 名簿としての密度。ID 単体は一般語と衝突するので、同居数で判定する。 */
const ROSTER_DENSITY = 3;

export function auditPublicSurface({ projectDir = REPO_ROOT, stagedOnly = false } = {}) {
  const { terms, castIds } = collectSensitiveSignals(projectDir);
  const packAvailable = channelPackPresent(projectDir);
  const files = trackedFiles({ stagedOnly });

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
  const homeRoot = homedir();
  for (const relative of files) {
    const full = path.join(REPO_ROOT, relative);
    if (!existsSync(full)) continue;
    try {
      if (statSync(full).size > 4 * 1024 * 1024) continue;
    } catch { continue; }
    let text;
    try { text = readFileSync(full, "utf8"); } catch { continue; }
    if (!text.includes("\n") && text.length > 1_000_000) continue;
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

    // ID の名簿。表示名だけを見ていたので、11人分の castId が並んだ一覧が
    // 公開されたまま「検出なし」と報告していた。ID 単体は一般語と衝突する
    // ので（fuku, ema など）、**同じファイルに何個同居しているか**で見る。
    const presentIds = castIds.filter((id) => new RegExp(`\\b${id}\\b`, "u").test(text));
    if (presentIds.length >= ROSTER_DENSITY) {
      rosterFindings.push({ file: relative, idCount: presentIds.length, of: castIds.length });
    }

    // 開発機の絶対パス。運営者にも配布物にも要らないうえ、
    // ホームディレクトリ名は個人を指す。
    const homeHits = countHomePathHits(text, homeRoot);
    if (homeHits > 0) pathLeakFindings.push({ file: relative, hits: homeHits });
  }

  return {
    version: "public-surface-audit-v1",
    scope: stagedOnly ? "staged" : "tracked",
    fileCount: files.length,
    // 語が引けなかったことを「問題なし」と報告しない。
    termSourceAvailable: packAvailable,
    termCount: terms.length,
    castIdCount: castIds.length,
    pathFindings,
    termFindings,
    rosterFindings,
    pathLeakFindings,
    clean: pathFindings.length === 0 && termFindings.length === 0
      && rosterFindings.length === 0 && pathLeakFindings.length === 0,
  };
}

function render(report) {
  const lines = [];
  lines.push(`公開面の検査（${report.scope}・${report.fileCount}ファイル）`);
  if (!report.termSourceAvailable) {
    lines.push("");
    lines.push("  ⚠ Channel Pack が無いので、固有名詞の検査はできていない。");
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
  lines.push(report.clean
    ? (report.termSourceAvailable ? "検出なし" : "構造規則の範囲では検出なし（固有名詞は未検査）")
    : `要対応: パス ${report.pathFindings.length} / 語 ${report.termFindings.length} / 名簿 ${report.rosterFindings.length} / 絶対パス ${report.pathLeakFindings.length}`);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const asJson = process.argv.includes("--json");
  const stagedOnly = process.argv.includes("--staged");
  const report = auditPublicSurface({ stagedOnly });
  process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : `${render(report)}\n`);
  if (!report.clean) process.exitCode = 2;
}
