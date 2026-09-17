#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadAndValidateReviewIntake } from "../lib/reviewIntake.mjs";

const root = resolve(import.meta.dirname, "..");
const manifestPath = join(root, "docs/review/session-intake.manifest.json");
const findingsPath = join(root, "docs/review/findings.jsonl");
// Claude Codeのproject保存名は絶対pathを区切り文字ごと`-`へ畳んだもの。
// 開発機のusername/pathを配布scriptへ固定しない。必要なら検証時だけ環境変数で上書きする。
const encodedProjectName = root.replace(/[\\/:]+/gu, "-");
const claudeProject = process.env.BUZZASSIST_REVIEW_SOURCE_DIR
  ? resolve(process.env.BUZZASSIST_REVIEW_SOURCE_DIR)
  : join(homedir(), ".claude", "projects", encodedProjectName);
const sourcePaths = {
  "claude-session-c742a064": join(claudeProject, "c742a064-52b0-463d-8ac5-5b200ab858a8.jsonl"),
  "claude-session-f4a4ec5b": join(claudeProject, "f4a4ec5b-ebf0-458f-9adc-91d1affdd657.jsonl"),
  "workflow-c742-analysis": join(claudeProject, "f4a4ec5b-ebf0-458f-9adc-91d1affdd657", "workflows", "wf_a7e0d344-f7f.json"),
  "workflow-f4-analysis": join(claudeProject, "f4a4ec5b-ebf0-458f-9adc-91d1affdd657", "workflows", "wf_37121acb-eed.json"),
};

const verifyLocalSources = process.argv.includes("--verify-local-sources");
const report = await loadAndValidateReviewIntake({
  manifestPath,
  findingsPath,
  sourcePaths: verifyLocalSources ? sourcePaths : {},
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
