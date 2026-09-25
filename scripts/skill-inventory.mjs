#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSkillEvalCoverage, formatSkillEvalCoverage } from "../lib/skillEvals.mjs";
import { CHANNEL_SKILLS_ENV, buildSkillInventory, recordSkillApproval } from "../lib/skillInventory.mjs";

function parseArgs(argv) {
  const args = { declaredSkillIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (["--include-global", "--include-plugin-cache", "--json", "--fail-on-external-divergence", "--require-approval", "--require-evals", "--human-verified"].includes(token)) {
      args[token.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())] = true;
      continue;
    }
    if (["--project-dir", "--profile", "--declared-skill", "--approve", "--reviewer", "--channel-skills"].includes(token)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
      if (token === "--declared-skill") args.declaredSkillIds.push(value);
      else if (token === "--approve") args.approve = value;
      else if (token === "--reviewer") args.reviewer = value;
      else if (token === "--channel-skills") args.channelSkillsDir = value;
      else args[token === "--profile" ? "profileId" : "projectDir"] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  if (args.includePluginCache) args.includeGlobal = true;
  return args;
}

function countClassifications(records) {
  return Object.fromEntries(
    ["installed", "bundled", "productionAllowed", "developmentOnly"].map((key) => [
      key,
      records.filter((record) => record.classification?.[key] === true).length,
    ]),
  );
}

function printHumanReport(report) {
  const skillCounts = countClassifications(report.skills);
  const pluginCounts = countClassifications(report.plugins);
  process.stdout.write("BuzzAssist Skill / Plugin inventory\n\n");
  process.stdout.write(`Skills: ${report.skills.length} (installed ${skillCounts.installed}, bundled ${skillCounts.bundled}, production-allowed ${skillCounts.productionAllowed}, development-only ${skillCounts.developmentOnly})\n`);
  process.stdout.write(`Plugins: ${report.plugins.length} (installed ${pluginCounts.installed}, bundled ${pluginCounts.bundled}, production-allowed ${pluginCounts.productionAllowed}, development-only ${pluginCounts.developmentOnly})\n`);
  process.stdout.write(`Project collisions: ${report.analysis.collisions.length}\n`);
  process.stdout.write(`Manifest/adapter issues: ${report.analysis.manifestIssues.length + report.analysis.adapterIssues.length}\n`);
  process.stdout.write(`Stale installed copies (canonical agrees, host cache/shipped copy differs): ${report.analysis.staleInstalledCopies.length}\n`);
  process.stdout.write(`Missing installed copies (bundled skill absent from a same-version host cache/shipped copy): ${report.analysis.missingInstalledCopies.length}\n`);
  process.stdout.write(`Outdated installed versions (older plugin versions still cached): ${report.analysis.outdatedInstalledVersions.length}\n`);
  process.stdout.write(`External divergent hashes: ${report.analysis.externalDivergentHashes.length}\n`);
  process.stdout.write(`Exact mirrors (incl. shipped depth-rewrite copies): ${report.analysis.exactMirrors.length}\n`);
  process.stdout.write(`Same generic name across explicit scopes: ${report.analysis.crossScopeSameNames.length}\n`);
  process.stdout.write(`Production skills without a human approval bound to the current version/SHA: ${report.analysis.unapprovedProductionSkills.length}\n`);
  if (report.channel) {
    process.stdout.write(`Channel-private skills (namespace ${report.channel.namespace || "unknown"}, manifest ${report.channel.manifestVersion || "unreadable"}): ${report.channel.skills}\n`);
  }
  if (report.profile) {
    const allowedSkills = report.profile.skills.filter((entry) => entry.allowed).length;
    const allowedPlugins = report.profile.plugins.filter((entry) => entry.allowed).length;
    process.stdout.write(`Profile ${report.profile.id}: ${allowedSkills} skills / ${allowedPlugins} plugins allowed\n`);
  }
  const issues = [
    ...report.analysis.manifestIssues,
    ...report.analysis.adapterIssues,
    ...report.analysis.collisions.map((collision) => `${collision.id}: ${collision.hashes.join(", ")}`),
  ];
  if (issues.length > 0) {
    process.stdout.write("\nIssues:\n");
    issues.forEach((issue) => process.stdout.write(`  - ${issue}\n`));
  }
  if (report.analysis.staleInstalledCopies.length > 0) {
    process.stdout.write("\nStale installed copies (re-ship with setup-agents; not a canonical defect):\n");
    report.analysis.staleInstalledCopies.forEach((entry) => {
      process.stdout.write(`  - ${entry.id}:\n`);
      entry.stalePaths.forEach((stalePath) => process.stdout.write(`      ${stalePath}\n`));
    });
  }
  if (report.analysis.missingInstalledCopies.length > 0) {
    process.stdout.write("\nMissing installed copies (host cannot load these bundled skills; re-ship with setup-agents):\n");
    report.analysis.missingInstalledCopies.forEach((entry) => {
      process.stdout.write(`  - ${entry.installRoot} (host ${entry.host || "unknown"}, version ${entry.version || "unknown"}, ${entry.present}/${entry.expected} present):\n`);
      entry.missing.forEach((name) => process.stdout.write(`      ${name}\n`));
    });
  }
  if (report.analysis.outdatedInstalledVersions.length > 0) {
    process.stdout.write("\nOutdated installed versions (not compared for missing skills; remove if the host no longer uses them):\n");
    report.analysis.outdatedInstalledVersions.forEach((entry) => {
      process.stdout.write(`  - ${entry.installRoot} (version ${entry.version}, bundled ${entry.bundledVersion})\n`);
    });
  }
  if (report.analysis.unapprovedProductionSkills.length > 0) {
    process.stdout.write("\nUnapproved production skills (record a human approval with --approve <id> --reviewer <name> --human-verified from that person's terminal):\n");
    report.analysis.unapprovedProductionSkills.forEach((entry) => {
      process.stdout.write(`  - ${entry.id} ${entry.version} (${entry.approvalState}${entry.scope ? `, ${entry.scope}` : ""})\n`);
    });
  }
  if (report.analysis.externalDivergentHashes.length > 0) {
    process.stdout.write("\nExternal differences (read-only observation; not a BuzzAssist project collision):\n");
    report.analysis.externalDivergentHashes.forEach((entry) => {
      process.stdout.write(`  - ${entry.id}: ${entry.hashes.length} hashes\n`);
    });
  }
}

export async function runSkillInventoryCli(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  // チャンネル専用スキルの在庫（私有）。明示の --channel-skills が環境変数に勝つ。
  const env = options.env || process.env;
  const channelDir = args.channelSkillsDir || String(env[CHANNEL_SKILLS_ENV] || "").trim();
  const channelSkillsDir = channelDir ? resolve(channelDir) : "";
  if (args.approve) {
    const result = await recordSkillApproval({
      projectDir: resolve(args.projectDir || process.cwd()),
      channelSkillsDir,
      skillId: args.approve,
      reviewer: args.reviewer,
      humanVerified: Boolean(args.humanVerified),
      isInteractive: options.isInteractive ?? process.stdin.isTTY === true,
    });
    process.stdout.write(`${result.skillId} ${result.approval.version} を人の承認として記録しました（reviewer: ${result.approval.reviewer}、SHA ${result.approval.contentSha256.slice(7, 19)}${result.scope === "channel" ? "、私有の在庫" : ""}）\n`);
    return result;
  }
  const report = await buildSkillInventory({
    projectDir: resolve(args.projectDir || process.cwd()),
    includeGlobal: Boolean(args.includeGlobal),
    includePluginCache: Boolean(args.includePluginCache),
    profileId: args.profileId,
    declaredSkillIds: args.declaredSkillIds,
    channelSkillsDir,
  });
  // リリースの関門: 承認しようとしている版（manifest の版と contentSha256）で、両ホストの
  // eval 結果がそろっているか、片方のホストだけ落ちた eval が無いか。止めるかどうかは運営者が
  // 決めることなので既定は警告だけにし、--require-evals のときだけ exit 5 にする。
  if (args.requireApproval || args.requireEvals) {
    report.evalCoverage = await checkSkillEvalCoverage({
      projectDir: resolve(args.projectDir || process.cwd()),
      env,
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    });
  }
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printHumanReport(report);
  if (report.evalCoverage && (!report.evalCoverage.ok || !args.json)) {
    const text = formatSkillEvalCoverage(report.evalCoverage, { blocking: Boolean(args.requireEvals) });
    // JSON を機械に渡しているときは標準出力を JSON だけに保つ
    if (args.json) process.stderr.write(text);
    else process.stdout.write(`\n${text}`);
  }
  if (!report.analysis.ok) process.exitCode = 2;
  if (args.failOnExternalDivergence && (report.analysis.externalDivergentHashes.length > 0 || !report.analysis.hostSyncOk)) process.exitCode = 3;
  if (args.requireApproval && report.analysis.unapprovedProductionSkills.length > 0) process.exitCode = 4;
  if (args.requireEvals && report.evalCoverage && !report.evalCoverage.ok) process.exitCode = 5;
  return report;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : null;
if (invoked && invoked === resolve(fileURLToPath(import.meta.url))) {
  runSkillInventoryCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}

