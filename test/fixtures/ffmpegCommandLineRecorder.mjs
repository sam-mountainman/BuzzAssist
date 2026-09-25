#!/usr/bin/env node
/**
 * 試験用の ffmpeg の身代わり: 渡された引数で本物の ffmpeg を起動し、その呼び出しが Windows で作る
 * コマンド行の長さ（lib/ffmpegFilterArgs.mjs の windowsCommandLineLength。本物の ffmpeg の path と引数で数える）を
 * 記録のファイルへ1行ずつ残す。標準入出力と終了コードはそのまま返す。
 *
 * 使い方: node ffmpegCommandLineRecorder.mjs <本物の ffmpeg> <記録のファイル> [ffmpeg の引数...]
 */

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import { windowsCommandLineLength } from "../../lib/ffmpegFilterArgs.mjs";

const [, , realFfmpeg, logPath, ...args] = process.argv;
const inputs = args.filter((token) => token === "-i").length;
appendFileSync(logPath, `${JSON.stringify({ length: windowsCommandLineLength(realFfmpeg, args), inputs })}\n`);
const result = spawnSync(realFfmpeg, args, { stdio: "inherit", windowsHide: true });
process.exit(result.status ?? 1);
