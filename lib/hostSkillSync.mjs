import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { shippedSkillContent } from "./skillInventory.mjs";

/**
 * 各ホストが「実際に読んでいる」BuzzAssist のスキルが、正本と同じかを見る。
 *
 * 2026-09-24 の監査で、正本は 0.1.26 なのに Claude Code と Codex の plugin cache が
 * 両方 0.1.25 のまま動いていた。doctor はそれまで配布元（~/plugins/buzzassist/plugin）
 * だけを見ていて、ホストが読む cache は死角だった。Job は正本の Skill SHA を焼き込むので、
 * cache が古いと「記録は新しい指示、エージェントが読んだのは古い指示」になる。
 *
 * どの版を読んでいるかはホストごとに記録の場所が違う:
 * - Claude Code: ~/.claude/plugins/installed_plugins.json の installPath
 * - Codex: ~/.codex/plugins/cache/buzzassist/buzzassist/<版>（一番新しい版を使う）
 */

export const BUZZASSIST_PLUGIN_SELECTOR = "buzzassist@buzzassist";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u;

function compareSemver(left, right) {
  const a = String(left).match(SEMVER);
  const b = String(right).match(SEMVER);
  if (!a || !b) return String(left).localeCompare(String(right));
  for (let index = 1; index <= 3; index += 1) {
    const diff = Number(a[index]) - Number(b[index]);
    if (diff !== 0) return diff;
  }
  return 0;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readText(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function pluginVersionAt(root) {
  for (const manifest of [
    path.join(root, ".claude-plugin", "plugin.json"),
    path.join(root, ".codex-plugin", "plugin.json"),
    path.join(root, "package.json"),
  ]) {
    const version = readJsonFile(manifest)?.version;
    if (typeof version === "string" && SEMVER.test(version)) return version;
  }
  return null;
}

/** ホストごとに、今有効な BuzzAssist plugin の置き場所と版を返す。未導入のホストは入れない。 */
export function resolveHostPluginInstalls({ homeDir = homedir() } = {}) {
  const installs = [];

  const claudeRecord = readJsonFile(path.join(homeDir, ".claude", "plugins", "installed_plugins.json"));
  const claudeEntries = claudeRecord?.plugins?.[BUZZASSIST_PLUGIN_SELECTOR];
  const claudeEntry = Array.isArray(claudeEntries)
    ? claudeEntries.find((entry) => entry?.scope === "user") || claudeEntries[0]
    : null;
  if (claudeEntry?.installPath && existsSync(claudeEntry.installPath)) {
    installs.push({
      host: "claude",
      root: path.resolve(claudeEntry.installPath),
      version: String(claudeEntry.version || pluginVersionAt(claudeEntry.installPath) || ""),
    });
  }

  const codexCache = path.join(homeDir, ".codex", "plugins", "cache", "buzzassist", "buzzassist");
  if (existsSync(codexCache)) {
    const versions = readdirSync(codexCache, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SEMVER.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareSemver);
    const newest = versions.at(-1);
    if (newest) installs.push({ host: "codex", root: path.join(codexCache, newest), version: newest });
  }

  return installs;
}

function canonicalSkillNames(repoRoot) {
  const root = path.join(repoRoot, ".agents", "skills");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(root, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

/** 配布物の中で、そのスキルの SKILL.md と overlay がどこにあるか（配布形と素の形の両方を見る）。 */
function installedSkillFiles(installRoot, skillName) {
  const candidates = [];
  const shipped = path.join(installRoot, "skills", skillName);
  const raw = path.join(installRoot, ".agents", "skills", skillName);
  if (existsSync(path.join(shipped, "SKILL.md"))) candidates.push({ dir: shipped, shippedForm: true });
  if (existsSync(path.join(raw, "SKILL.md"))) candidates.push({ dir: raw, shippedForm: false });
  return candidates;
}

/**
 * 正本と各ホストの導入物を比べる。
 * @returns {{ installs, drift: Array<{host, version, skill, file, reason}>, repoVersion }}
 */
export function compareHostSkillSync({ repoRoot, homeDir = homedir(), skillNames } = {}) {
  const names = skillNames?.length ? skillNames : canonicalSkillNames(repoRoot);
  const repoVersion = pluginVersionAt(repoRoot);
  const installs = resolveHostPluginInstalls({ homeDir });
  const drift = [];
  for (const install of installs) {
    for (const skill of names) {
      const canonicalDir = path.join(repoRoot, ".agents", "skills", skill);
      const canonicalSkill = readText(path.join(canonicalDir, "SKILL.md"));
      if (canonicalSkill === null) continue;
      const copies = installedSkillFiles(install.root, skill);
      if (copies.length === 0) {
        drift.push({ host: install.host, version: install.version, skill, file: "SKILL.md", reason: "missing" });
        continue;
      }
      for (const copy of copies) {
        const expectedSkill = copy.shippedForm ? shippedSkillContent(canonicalSkill) : canonicalSkill;
        if (readText(path.join(copy.dir, "SKILL.md")) !== expectedSkill) {
          drift.push({ host: install.host, version: install.version, skill, file: "SKILL.md", reason: "stale" });
        }
        // overlay は自己改善（harness-learn sync）が書き換える層。版が同じでも中身だけずれる。
        const overlayRel = path.join("references", "learned-auto.md");
        const canonicalOverlay = readText(path.join(canonicalDir, overlayRel));
        const installedOverlay = readText(path.join(copy.dir, overlayRel));
        if (canonicalOverlay !== installedOverlay) {
          drift.push({
            host: install.host,
            version: install.version,
            skill,
            file: "learned-auto",
            reason: installedOverlay === null ? "missing" : canonicalOverlay === null ? "extra" : "stale",
          });
        }
      }
    }
  }
  // 同じホスト・スキル・ファイルの重複（配布形と素の形の両方で古い）を1件にまとめる。
  const seen = new Set();
  const unique = drift.filter((entry) => {
    const key = `${entry.host}\u0000${entry.skill}\u0000${entry.file}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { installs, drift: unique, repoVersion };
}

function skillNameFromCanonicalPath(entry) {
  const match = String(entry || "").replaceAll("\\", "/").match(/\.agents\/skills\/([^/]+)\/SKILL\.md$/u);
  return match ? match[1] : null;
}

/**
 * doctor 用の判定。ハーネス指定ありなら、そのハーネスが束縛するスキルのずれは止める。
 * 束縛外のずれと、ハーネス未指定のセットアップ確認では止めずに知らせる。
 */
export function probeHostSkillSync({ repoRoot, homeDir = homedir(), declaration = null } = {}) {
  const { installs, drift, repoVersion } = compareHostSkillSync({ repoRoot, homeDir });
  const bound = new Set((declaration?.canonicalSkills || []).map(skillNameFromCanonicalPath).filter(Boolean));
  const blockingDrift = bound.size ? drift.filter((entry) => bound.has(entry.skill)) : [];
  const hostsLabel = installs.length
    ? installs.map((install) => `${install.host} ${install.version || "版不明"}`).join(" / ")
    : "BuzzAssist plugin を入れたホストなし";
  if (installs.length === 0) {
    return {
      ok: true,
      required: false,
      installs,
      drift,
      detail: `${hostsLabel}（比べる相手が無い）`,
      fix: "",
    };
  }
  const summary = drift.slice(0, 12).map((entry) => `${entry.host}:${entry.skill}/${entry.file}(${entry.reason === "stale" ? "古い" : entry.reason === "missing" ? "無い" : "余分"})`);
  return {
    ok: drift.length === 0,
    required: blockingDrift.length > 0,
    installs,
    drift,
    blockingSkills: [...new Set(blockingDrift.map((entry) => entry.skill))].sort(),
    detail: drift.length === 0
      ? `ホストが読むスキルが正本と一致（正本 ${repoVersion || "版不明"}、${hostsLabel}）`
      : `ホストが読むスキルが正本とずれている（正本 ${repoVersion || "版不明"}、${hostsLabel}）: ${summary.join(", ")}${drift.length > summary.length ? ` ほか ${drift.length - summary.length} 件` : ""}`,
    fix: drift.length === 0 ? ""
      : "エージェントは古い指示を読み、Job と RunReceipt には正本の新しい指紋が残る。"
        + "運営者の端末なら自動更新を今すぐ走らせる（`node ~/plugins/buzzassist/plugin/scripts/update-current.mjs --config ~/.buzzassist/updater/config.json`）。"
        + "開発中の端末なら、このリポジトリから `node scripts/setup-agents.mjs --agents claude,codex --project-dir <dir> --no-launch` で両ホストへ配り直す。"
        + "そのあとホストのセッションを開き直す",
  };
}
