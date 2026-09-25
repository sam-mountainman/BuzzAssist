// 試験で、公式経路が組み立てた ffmpeg のコマンド行の長さを全部記録する（test/fixtures/ffmpegCommandLineRecorder.mjs を
// 本物の ffmpeg の前に置く）。

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const RECORDER_PATH = fileURLToPath(new URL("../fixtures/ffmpegCommandLineRecorder.mjs", import.meta.url));

/** 本物の ffmpeg の前に身代わりを置いた実行系（組み立てたコマンド行の長さを logPath へ記録する）。 */
export function recordingToolchain(toolchain, logPath) {
  return {
    ...toolchain,
    ffmpeg: {
      ...toolchain.ffmpeg,
      command: process.execPath,
      args: [RECORDER_PATH, toolchain.ffmpeg.command, logPath, ...(toolchain.ffmpeg.args || [])],
    },
  };
}

/** 記録した呼び出しの一覧（{ length, inputs }）。 */
export async function recordedCommandLines(logPath) {
  return (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
