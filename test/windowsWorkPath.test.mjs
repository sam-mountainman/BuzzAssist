// Windows で、子プロセスを起動する作業フォルダ（cwd）が長すぎると起動できない（spawn が ENOENT）のを、有料の処理の
// 前に止める試験（lib/windowsWorkPath.mjs と、ナレーション物語の plan-only の preflight・pipeline）。
//
// OS は platform を差し込んで確かめる（実際の Windows は CI が見る）。フォルダは一時ディレクトリの下の合成の名前だけで、
// 長さを測るだけなので作らない（pipeline の試験だけ Job の run のフォルダを作る）。path は node:path で組み立てる。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import { inspectNarratedStoryPlan, narratedStoryChildWorkDirs, narratedStoryRunPaths, runNarratedStoryPipeline } from "../lib/narratedStoryPipeline.mjs";
import {
  WINDOWS_MAX_PATH,
  WINDOWS_WORK_PATH_LIMIT,
  WINDOWS_WORK_PATH_TOO_LONG,
  checkWindowsWorkPaths,
  windowsWorkPathDetail,
  windowsWorkPathFix,
} from "../lib/windowsWorkPath.mjs";
import { writeBookendPack } from "./fixtures/narratedBookendFixture.mjs";

const JOB_ID = "video-narrated-story-video-0123456789abcdef";

/** 一時ディレクトリの下で、全体がちょうど length 字になるフォルダ（作らない）。 */
function folderOfLength(length, name = "p") {
  const base = path.resolve(os.tmpdir());
  const rest = length - base.length - 1;
  assert.ok(rest > 0, `一時ディレクトリが長すぎる（${base.length} 字）`);
  return path.join(base, name.repeat(rest));
}

test("作業フォルダの長さ: Windows だけ見て、上限（260 − NUL − 相対名 21 字 = 238 字）を越えたら理由コードを返す。path は出さない", () => {
  assert.equal(WINDOWS_MAX_PATH, 260);
  assert.equal(WINDOWS_WORK_PATH_LIMIT, 238);
  const long = folderOfLength(WINDOWS_WORK_PATH_LIMIT + 1);
  const edge = folderOfLength(WINDOWS_WORK_PATH_LIMIT, "q");

  // Windows 以外は何もしない。
  const posix = checkWindowsWorkPaths({ workDirs: [long], platform: "linux" });
  assert.deepEqual({ applies: posix.applies, ok: posix.ok, issues: posix.issues }, { applies: false, ok: true, issues: [] });
  assert.equal(windowsWorkPathFix(posix), "");

  const within = checkWindowsWorkPaths({ workDirs: [{ path: edge, label: "合成の作業フォルダ" }], platform: "win32" });
  assert.equal(within.ok, true, "上限ちょうどは通す");
  assert.deepEqual(within.longest, { label: "合成の作業フォルダ", length: WINDOWS_WORK_PATH_LIMIT });

  const over = checkWindowsWorkPaths({ workDirs: [edge, { path: long, label: "合成の深い作業フォルダ" }, long], platform: "win32" });
  assert.equal(over.ok, false);
  assert.deepEqual(over.issues, [WINDOWS_WORK_PATH_TOO_LONG]);
  assert.deepEqual(over.tooLong, [{ label: "合成の深い作業フォルダ", length: WINDOWS_WORK_PATH_LIMIT + 1 }], "同じフォルダは1回だけ数える");
  const detail = windowsWorkPathDetail(over);
  const fix = windowsWorkPathFix(over);
  assert.match(detail, /合成の深い作業フォルダが 239 字/u);
  assert.match(fix, /1 字以上短くする/u);
  for (const text of [detail, fix]) assert.ok(!text.includes(long), "path の中身は出さない");
});

test("ナレーション物語の作業フォルダの見積もり: 字幕の頁（いちばん深い）と OP の作業フォルダは Job の run のフォルダの中", () => {
  const root = folderOfLength(80);
  const dirs = narratedStoryChildWorkDirs({ deploymentRoot: root, jobId: JOB_ID });
  const runDir = narratedStoryRunPaths({ deploymentRoot: root, jobId: JOB_ID }).runDir;
  assert.deepEqual(dirs.map((dir) => path.relative(runDir, dir.path)), [path.join("render", "subtitles"), path.join("render", "bookends")]);
  // 配置の root から 89 字深い（.media/narrated-story-video/<Job の id 43 字>/render/subtitles）。
  assert.equal(dirs[0].path.length - root.length, 89);
});

test("ナレーション物語の plan-only の preflight: Windows で Job の run のフォルダの中が上限を越えれば、有料の処理の前に windows-work-path-too-long を返す", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "windows-work-path-plan-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const scriptPath = path.join(temp, "script.txt");
  await writeFile(scriptPath, "合成の台本の一文目です。\n", "utf8");
  // Pack は無い（channel-pack-config-required）。作業フォルダの長さは Pack に依らずに見る。
  const plan = (projectDir, platform) => inspectNarratedStoryPlan({ scriptPath, channelPackDir: path.join(temp, "no-pack"), projectDir, jobId: JOB_ID, platform });
  // 配置の root は 200 字（それ自体は上限の中）でも、字幕の頁の作業フォルダは 289 字になる。
  const deep = folderOfLength(200);
  const windows = await plan(deep, "win32");
  assert.ok(windows.blockers.includes(WINDOWS_WORK_PATH_TOO_LONG), JSON.stringify(windows.blockers));
  assert.deepEqual(windows.windowsWorkPath, { limit: WINDOWS_WORK_PATH_LIMIT, longest: { label: "字幕の頁の作業フォルダ", length: 289 } });
  assert.equal(windows.paidCallsAttempted, false);
  assert.ok(!(await plan(deep, "darwin")).blockers.includes(WINDOWS_WORK_PATH_TOO_LONG), "Windows 以外では止めない");
  assert.ok(!(await plan(folderOfLength(140), "win32")).blockers.includes(WINDOWS_WORK_PATH_TOO_LONG), "収まる深さなら止めない");
  // Job の id が無ければ測れない（止めない）。
  const withoutJob = await inspectNarratedStoryPlan({ scriptPath, channelPackDir: path.join(temp, "no-pack"), projectDir: deep, platform: "win32" });
  assert.ok(!withoutJob.blockers.includes(WINDOWS_WORK_PATH_TOO_LONG));
});

test("ナレーション物語の pipeline: Windows で作業フォルダが上限を越えれば、有料の Media Job を1つも呼ばずに人待ちで止まる", async (t) => {
  const toolchain = await resolveFfmpegToolchain();
  if (!toolchain.ok) { t.skip("ffmpeg/ffprobe is unavailable"); return; }
  const temp = await mkdtemp(path.join(os.tmpdir(), "windows-work-path-run-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const pack = path.join(temp, "pack");
  await writeBookendPack(pack, toolchain);
  const scriptPath = path.join(temp, "script.txt");
  await writeFile(scriptPath, "合成の物語の一文目です。\n---感想---\n合成の感想の一文目です。\n", "utf8");
  // 配置の root は一時ディレクトリの下の 200 字（run のフォルダは作るので、ここだけ実在させる）。
  const deploymentRoot = folderOfLength(200);
  await mkdir(deploymentRoot, { recursive: true });
  t.after(() => rm(deploymentRoot, { recursive: true, force: true }));
  const calls = [];
  const outcome = await runNarratedStoryPipeline({
    scriptPath,
    channelPackDir: pack,
    jobId: JOB_ID,
    deploymentRoot,
    mediaJobRunner: async (spec) => { calls.push(spec); throw new Error("有料の Media Job を呼んではいけない"); },
    mediaJobProbe: async (adapter) => { calls.push(adapter); throw new Error("provider の確認も呼ばない"); },
    ffmpegToolchain: toolchain,
    jobIdentityDigest: "e".repeat(64),
    platform: "win32",
    env: {},
  });
  assert.equal(outcome.status, "awaiting-operator-input");
  assert.deepEqual(outcome.knownRemainingIssues, [WINDOWS_WORK_PATH_TOO_LONG]);
  assert.equal(outcome.execution.paidGenerationAttempted, false);
  assert.equal(calls.length, 0);
});
