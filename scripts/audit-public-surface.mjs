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

import { channelPackRootEntries, channelPackPresent } from "../lib/channelPackResolver.mjs";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/**
 * 探す語を Channel Pack から集める。禁止語の一覧を公開リポジトリに
 * 平文で置くと、それ自体が名簿になる。
 */
export function collectSensitiveTerms(projectDir = REPO_ROOT) {
  const terms = new Set();
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
      for (const location of parsed.locations || []) {
        if (location.name) terms.add(String(location.name));
      }
      for (const key of ["name", "town", "setting", "displayName"]) {
        if (parsed.channel?.[key]) terms.add(String(parsed.channel[key]));
      }
    }
  }
  // 2文字未満は一般語と衝突する。
  return [...terms].filter((term) => term.length >= 2).sort((a, b) => b.length - a.length);
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

export function auditPublicSurface({ projectDir = REPO_ROOT, stagedOnly = false } = {}) {
  const terms = collectSensitiveTerms(projectDir);
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
  }

  return {
    version: "public-surface-audit-v1",
    scope: stagedOnly ? "staged" : "tracked",
    fileCount: files.length,
    // 語が引けなかったことを「問題なし」と報告しない。
    termSourceAvailable: packAvailable,
    termCount: terms.length,
    pathFindings,
    termFindings,
    clean: pathFindings.length === 0 && termFindings.length === 0,
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
  lines.push(report.clean
    ? (report.termSourceAvailable ? "検出なし" : "構造規則の範囲では検出なし（固有名詞は未検査）")
    : `要対応: パス ${report.pathFindings.length}件 / 語 ${report.termFindings.length}ファイル`);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const asJson = process.argv.includes("--json");
  const stagedOnly = process.argv.includes("--staged");
  const report = auditPublicSurface({ stagedOnly });
  process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : `${render(report)}\n`);
  if (!report.clean) process.exitCode = 2;
}
