// このリポジトリの開発用の禁止リスト（.claude/settings.json の permissions.deny）の試験。
// Claude Code の照合を、公式の説明どおりに写した小さな照合器で確かめる:
//   - `*` は空白を含む任意の文字列に当たる
//   - 末尾の ` *` が規則の中の唯一の `*` なら、引数の無いコマンドそのものにも当たる
//   - 複合コマンド（&& || ; | 改行）は分けて、どれか1つが当たれば止まる
// 照合器は本物ではないので、ここで確かめるのは「止めたい形が並んでいるか」と「普段の開発を止めないか」。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SETTINGS = path.join(ROOT, ".claude", "settings.json");

function ruleMatcher(rule) {
  const body = rule.match(/^Bash\((.*)\)$/su)?.[1];
  assert.ok(body !== undefined, `Bash の規則ではない: ${rule}`);
  const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = body.split("*").map(escape).join("[\\s\\S]*");
  const onlyTrailing = body.endsWith(" *") && body.indexOf("*") === body.length - 1;
  const bare = onlyTrailing ? new RegExp(`^${escape(body.slice(0, -2))}$`, "u") : null;
  const full = new RegExp(`^${pattern}$`, "u");
  return (command) => full.test(command) || Boolean(bare?.test(command));
}

function denied(rules, command) {
  const matchers = rules.map(ruleMatcher);
  return command
    .split(/&&|\|\||;|\||\n/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => matchers.some((matches) => matches(part)));
}

function denyRules() {
  const settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  assert.ok(Array.isArray(settings.permissions?.deny), "permissions.deny が無い");
  return settings.permissions.deny;
}

test("git add -A・git add .・main への force push を止める", () => {
  const rules = denyRules();
  for (const command of [
    "git add -A",
    "git add -A && git commit -m wip",
    "git add --all",
    "git add .",
    "git add . && git status",
    "git add -- .",
    "git -C /work/tree add -A",
    "git -C /work/tree add .",
    "git -C /work/tree add --all",
    "git push --force origin main",
    "git push --force-with-lease origin main",
    "git push origin --force main",
    "git push origin main --force",
    "git push -f origin main",
    "git push origin main -f",
    "git push --force origin HEAD:main",
    "git push -f origin HEAD:main",
    "git push origin +main",
    "git push origin +HEAD:main",
    "git push origin +HEAD:refs/heads/main",
    "git -C /work/tree push --force origin main",
  ]) assert.ok(denied(rules, command), `止めていない: ${command}`);
});

test("ファイルを指定した git add・普通の push・作業ブランチの force push は止めない", () => {
  const rules = denyRules();
  for (const command of [
    "git add scripts/harness-guard-hook.mjs test/harnessGuardHook.test.mjs",
    "git add .gitignore",
    "git add ./scripts/a.mjs",
    "git -C /work/tree add scripts/a.mjs",
    "git -C /work/tree status",
    "git push origin main",
    "git push origin HEAD:main",
    "git push --force origin feature/x",
    "git push -f origin worktree-agent-example",
    "git push --force origin feature/main-fix",
    "git push --force origin domain",
    "git commit -m \"docs: main への force push を止める\"",
    "git status && git diff --stat",
  ]) assert.equal(denied(rules, command), false, `止めすぎた: ${command}`);
});

test(".claude/settings.json は追跡され、個人の設定（settings.local.json）は追跡しない", () => {
  const ignored = (relative) => {
    try {
      execFileSync("git", ["check-ignore", "-q", relative], { cwd: ROOT, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(ignored(".claude/settings.json"), false, ".claude/settings.json が .gitignore で外れている");
  assert.equal(ignored(".claude/settings.local.json"), true, "個人の設定が追跡に入りうる");
});
