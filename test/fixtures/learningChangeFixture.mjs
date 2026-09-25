// 差分の承認キューの試験が共有する合成の開発用チェックアウト。
//
// 一時ディレクトリに .git と .claude/skills と .codex/skills の印を置き、学習の置き場は
// BUZZASSIST_LEARNING_DIR で一時ディレクトリへ向ける。本物のリポジトリの台帳・正本と
// ~/.buzzassist には書かない。人名・提案・スキルはすべて合成。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { proposalId } from "../../scripts/harness-learn.mjs";

export const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SKILL = "sample-craft";
export const TARGET = `platform:${SKILL}`;
export const PACK_TARGET = "channel-pack:sample-pack";
export const SKILL_REL = `.agents/skills/${SKILL}/SKILL.md`;
export const REVIEWER = "承認者テスト";
export const NOW = "2026-09-25T00:00:00.000Z";
export const BASE_SKILL = [
  "---",
  `name: ${SKILL}`,
  "description: 合成の試験用スキル",
  "---",
  "",
  "# 合成スキル",
  "",
  "## 置き場",
  "",
  "書く前に置き場を確かめる。",
  "",
  "## やってはいけないこと",
  "",
  "- 確かめずに書く",
  "",
].join("\n");
export const RULE = "置き場を確かめてから、台帳の錠を取って1行だけ追記する。";

export function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function proposal({ target = TARGET, text = "合成の手順では置き場を先に確かめる", session = "synthetic-session" } = {}) {
  const entry = { kind: "preference", target, text, evidence: "合成の根拠", session, capturedAt: "2026-09-24T00:00:00.000Z" };
  return { ...entry, id: proposalId(entry) };
}

/** 合成の開発用チェックアウト。 */
export function fixture(t, { development = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "learning-changes-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  write(path.join(repo, "docs", "learning", "targets.json"), `${JSON.stringify({
    targets: {
      [TARGET]: {
        mode: "auto-guidance",
        canonical: SKILL_REL,
        overlay: `.agents/skills/${SKILL}/references/learned-auto.md`,
        scope: "platform",
      },
      [PACK_TARGET]: {
        mode: "review-only",
        canonical: "docs/sample-ledger.md",
        reason: "合成の台帳",
        scope: "channel-pack",
        packId: "sample-pack",
      },
    },
  }, null, 2)}\n`);
  write(path.join(repo, ...SKILL_REL.split("/")), BASE_SKILL);
  write(path.join(repo, "channel-packs", "sample-pack", "docs", "sample-ledger.md"), "# 合成の台帳\n\n## 規則\n\n- R1 合成\n");
  if (development) {
    for (const marker of [".git", path.join(".claude", "skills"), path.join(".codex", "skills")]) fs.mkdirSync(path.join(repo, marker), { recursive: true });
  }
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const env = { BUZZASSIST_LEARNING_DIR: path.join(root, "learning") };
  const options = { repoRoot: repo, env, homeDir: home, now: () => NOW, signals: { terms: [], castIds: [] }, privateVocabulary: null };
  const ledger = (kind, dir = path.join(repo, "docs", "learning")) => path.join(dir, `${kind}.jsonl`);
  const addProposal = (entry, dir) => {
    fs.mkdirSync(path.dirname(ledger("proposals", dir)), { recursive: true });
    fs.appendFileSync(ledger("proposals", dir), `${JSON.stringify(entry)}\n`);
    return entry;
  };
  const skillPath = path.join(repo, ...SKILL_REL.split("/"));
  return { root, repo, home, env, options, ledger, addProposal, skillPath };
}

export function proposedWith(base, entries, rule = RULE) {
  const section = ["## 追記", "", ...entries.map((entry) => `<!-- buzzassist-learning:${entry.id} -->`), rule, ""].join("\n");
  return base.replace("## やってはいけないこと", `${section}\n## やってはいけないこと`);
}

export const HUMAN = { reviewer: REVIEWER, humanVerified: true, isInteractive: true };
