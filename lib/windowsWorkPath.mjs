/**
 * Windows で、子プロセスを起動するときの作業フォルダ（cwd）が長すぎないかを、有料の処理の前に確かめる
 * （共有層。ジャンルに依らない）。
 *
 * Windows の CreateProcess は作業フォルダを MAX_PATH（260 字。終端の NUL を含む）までしか受けず、越えると
 * Node の spawn / execFile が ENOENT で落ちる（2026-09-26 の CI の Windows: 600 字の深いフォルダの下で
 * test/narratedStoryLongScriptCommandLine.test.mjs の ffmpeg が起動できなかった）。長い path を許す設定
 * （LongPathsEnabled）でも作業フォルダの上限は変わらない。作業フォルダからの相対名でファイルを渡す工程
 * （ナレーション物語の字幕の頁・OP の文言と書体）は、そのファイルの path も同じ上限に収める。
 *
 * 各ハーネスは、子を起動する作業フォルダのうち深くなりうるものを見積もって渡す（ナレーション物語は
 * lib/narratedStoryPipeline.mjs の narratedStoryChildWorkDirs、漫画はプロジェクトのフォルダ）。ここは長さを
 * 比べて、止める理由コードと直し方を返すだけ（読むだけ・書かない。path の中身は返さず、長さと種類だけ）。
 * doctor（scripts/harness-doctor.mjs）・ナレーション物語の plan-only の preflight と pipeline が同じものを使う。
 * Windows 以外では何もしない。
 */

import path from "node:path";

/** 作業フォルダが長すぎて、Windows で子プロセスを起動できない。 */
export const WINDOWS_WORK_PATH_TOO_LONG = "windows-work-path-too-long";
/** Windows の MAX_PATH（終端の NUL を含めて 260 字。UTF-16 の単位で数える）。 */
export const WINDOWS_MAX_PATH = 260;
/**
 * 作業フォルダの中で相対名で開くファイルの分。字幕の頁の文言（cue-00001-l1.txt）・書体の写し
 * （subtitle-font.woff2 の 19 字）が収まる 20 字に、区切りの `\` の 1 字を足す。
 */
export const WINDOWS_CWD_RELATIVE_NAME_ALLOWANCE = 21;
/**
 * 作業フォルダの長さの上限: 260 − 終端の NUL（1）− 相対名と区切り（21）= 238 字。作業フォルダの末尾に `\` を
 * 足した長さの上限（258 字）も、この内側に入る。
 */
export const WINDOWS_WORK_PATH_LIMIT = WINDOWS_MAX_PATH - 1 - WINDOWS_CWD_RELATIVE_NAME_ALLOWANCE;

function normalizeWorkDir(entry) {
  const value = typeof entry === "string" ? entry : entry?.path;
  if (typeof value !== "string" || !value.trim()) return null;
  return { path: path.resolve(value), label: typeof entry?.label === "string" && entry.label.trim() ? entry.label.trim() : "作業フォルダ" };
}

/**
 * 作業フォルダの長さを上限と比べる。workDirs は path か { path, label } の一覧。
 * 返す値: { applies, ok, issues, limit, longest: { label, length } | null, tooLong: [{ label, length }] }。
 * Windows 以外（platform !== "win32"）は applies: false・ok: true で何も見ない。
 */
export function checkWindowsWorkPaths({ workDirs = [], platform = process.platform, limit = WINDOWS_WORK_PATH_LIMIT } = {}) {
  if (platform !== "win32") return { applies: false, ok: true, issues: [], limit, longest: null, tooLong: [] };
  const byPath = new Map();
  for (const entry of workDirs) {
    const dir = normalizeWorkDir(entry);
    if (dir && !byPath.has(dir.path)) byPath.set(dir.path, dir);
  }
  const measured = [...byPath.values()]
    .map((dir) => ({ label: dir.label, length: dir.path.length }))
    .sort((left, right) => right.length - left.length);
  const tooLong = measured.filter((dir) => dir.length > limit);
  return {
    applies: true,
    ok: tooLong.length === 0,
    issues: tooLong.length > 0 ? [WINDOWS_WORK_PATH_TOO_LONG] : [],
    limit,
    longest: measured[0] || null,
    tooLong,
  };
}

/** 結果の説明（長さと種類だけ。path は出さない）。 */
export function windowsWorkPathDetail(result) {
  if (!result?.applies) return "Windows ではないので見ていない";
  if (!result.longest) return "測る作業フォルダが無い";
  return result.ok
    ? `いちばん深い作業フォルダは ${result.longest.label}（${result.longest.length} 字。上限 ${result.limit} 字）`
    : `${result.longest.label}が ${result.longest.length} 字で、Windows で子プロセスを起動できる上限 ${result.limit} 字を越える`;
}

/** 直し方（運営者向け）。上限の中なら空。 */
export function windowsWorkPathFix(result) {
  if (!result?.applies || result.ok || !result.longest) return "";
  const over = result.longest.length - result.limit;
  return `Windows では、子プロセスを起動する作業フォルダが ${WINDOWS_MAX_PATH} 字（MAX_PATH）を越えると起動できない`
    + "（長い path を許す設定でも変わらない）。有料の処理はまだ走っていない。プロジェクトのフォルダ（と配置の root）を"
    + ` C:\\ba\\<名前> のような短い場所へ移し、そこから Job を作り直すこと（いちばん深い作業フォルダを ${over} 字以上短くする）`;
}
