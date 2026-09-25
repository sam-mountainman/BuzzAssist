// 学習の可変状態の置き場（lib/harnessLearningState.mjs）の試験。
//
// 運営者の端末では、フックが案内するスクリプトはホストごとの版別キャッシュにあり、以前は
// スクリプトの置き場から台帳を決めていたので、Claude Code と Codex で別の台帳に書き、版が
// 上がると消えていた。ここでは合成の HOME（一時ディレクトリ）に2つの写しを作り、どちらの
// フック・CLI から capture しても同じ台帳に同じ ID で入ること、overlay が両方の写しに届くこと、
// setup 相当を2回流しても残ること、開発用チェックアウトでは従来どおりであることを確かめる。
// 本物の ~/.claude・~/.codex・~/plugins・~/.buzzassist には触らない。人名・台本・端末のパスは合成。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  LOCAL_OVERLAY_BEGIN,
  LOCAL_OVERLAY_END,
  appendReceiptIndexRow,
  channelLedgerDir,
  composeOverlay,
  deliverLearningOverlays,
  learningOverlayCopies,
  migrateLegacyLearningState,
  operatorLearningStateDir,
  resolveLearningState,
  sharedLedgerPath,
  stripLocalOverlayBlock,
} from "../lib/harnessLearningState.mjs";
import { learningState, ledgerPathFor, renderLocalOverlayBlock } from "../scripts/harness-learn.mjs";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = "sample-craft";
const TARGET = `platform:${SKILL}`;
const TARGETS = {
  [TARGET]: {
    mode: "auto-guidance",
    canonical: `.agents/skills/${SKILL}/SKILL.md`,
    overlay: `.agents/skills/${SKILL}/references/learned-auto.md`,
    scope: "platform",
  },
};
const SHIPPED_OVERLAY = [
  "<!-- このファイルは harness-learn が自動で書きます。手で編集しないでください。 -->",
  "",
  "# 自動で積み上がった指摘",
  "",
  "- **同梱された合成の項目**",
  "  - 種別: fact / 初回: 2026-09-01 / id: `aaaaaaaaaaaa`",
  "",
  "_最終更新: 2026-09-01T00:00:00.000Z_",
  "",
].join("\n");
const ENV_KEYS_TO_CLEAR = [
  "BUZZASSIST_LEARNING_DIR", "BUZZASSIST_LEARNING_HOOK_LOG", "BUZZASSIST_LEARNING_WRITE_FORBIDDEN",
  "BUZZASSIST_CHANNEL_PACK", "BUZZASSIST_CHANNEL_PACK_ID", "PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT", "CODEX_HOME",
];

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-learning-state-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** 本物のスクリプトを写しに置き、相対 import は本物のモジュールへ転送する（symlink は使わない）。 */
function stageScript(root, relative) {
  const real = path.join(SOURCE_ROOT, ...relative.split("/"));
  const source = fs.readFileSync(real, "utf8");
  const staged = write(path.join(root, ...relative.split("/")), source);
  for (const [, specifier] of source.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/gu)) {
    const target = path.resolve(path.dirname(staged), specifier);
    if (fs.existsSync(target)) continue;
    write(target, `export * from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(real), specifier)).href)};\n`);
  }
  return staged;
}

/** ホストが読む形の写し（skills/ と .agents/skills/ の両方に SKILL.md と同梱の overlay）。 */
function stagePluginCopy(root, { version = "9.9.1", development = false } = {}) {
  stageScript(root, "scripts/harness-learn.mjs");
  stageScript(root, "scripts/harness-learn-hook.mjs");
  write(path.join(root, "docs", "learning", "targets.json"), `${JSON.stringify({ targets: TARGETS }, null, 2)}\n`);
  write(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "buzzassist", version }));
  for (const base of [path.join(root, "skills", SKILL), path.join(root, ".agents", "skills", SKILL)]) {
    write(path.join(base, "SKILL.md"), "# 合成スキル\n\n> 作業前に `references/learned-auto.md` を読む。\n");
    write(path.join(base, "references", "learned-auto.md"), SHIPPED_OVERLAY);
  }
  if (development) {
    for (const marker of [".git", path.join(".claude", "skills"), path.join(".codex", "skills")]) fs.mkdirSync(path.join(root, marker), { recursive: true });
  }
  return root;
}

/** 合成の HOME に、Claude Code と Codex の版別キャッシュを模した2つの写しと配布元を作る。 */
function stageOperatorHome(root) {
  const home = path.join(root, "home");
  const claude = stagePluginCopy(path.join(home, ".claude", "plugins", "cache", "buzzassist", "buzzassist", "9.9.1"));
  const codex = stagePluginCopy(path.join(home, ".codex", "plugins", "cache", "buzzassist", "buzzassist", "9.9.1"));
  const managed = stagePluginCopy(path.join(home, "plugins", "buzzassist", "plugin"));
  write(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: { "buzzassist@buzzassist": [{ scope: "user", installPath: claude, version: "9.9.1" }] },
  }));
  return { home, claude, codex, managed, state: path.join(home, ".buzzassist", "learning") };
}

function isolatedEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of ENV_KEYS_TO_CLEAR) delete env[key];
  return { ...env, ...extra };
}

function runNode(script, args, env) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: path.dirname(script), env, encoding: "utf8", input: "", timeout: 60_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function hookCommand(host, copyRoot) {
  const hooks = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, "hooks", `${host}-hooks.json`), "utf8"));
  const command = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
  return host === "claude" ? command.replaceAll("${CLAUDE_PLUGIN_ROOT}", copyRoot) : command;
}

function learnScriptFromHook(stdout) {
  const context = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  const match = /node "([^"]+)" capture/u.exec(context);
  assert.ok(match, `フックの案内に capture の起動行が無い:\n${context}`);
  return match[1];
}

test("Windows のパス区切りでも、状態の置き場を homedir から組み立てる", () => {
  const win = path.win32;
  const home = win.join("C:", "Users", "sample-operator");
  const codeRoot = win.join(home, ".codex", "plugins", "cache", "buzzassist", "buzzassist", "9.9.1");
  const installed = resolveLearningState({ codeRoot, homeDir: home, env: {}, pathApi: win, developmentCheckout: false });
  const stateDir = win.join(home, ".buzzassist", "learning");
  assert.equal(installed.mode, "installed");
  assert.equal(installed.stateDir, stateDir);
  assert.equal(installed.sharedLedgerDir, win.join(stateDir, "shared"));
  assert.equal(sharedLedgerPath(installed, "proposals", win), win.join(stateDir, "shared", "proposals.jsonl"));
  assert.equal(channelLedgerDir(installed, "sample-pack", win), win.join(stateDir, "channel-packs", "sample-pack"));
  assert.equal(installed.receiptIndexPath, win.join(stateDir, "receipts", "index.jsonl"));
  assert.equal(installed.overlaysDir, win.join(stateDir, "overlays"));
  assert.equal(installed.hookEventLogPath, win.join(stateDir, "hook-events.jsonl"));
  assert.equal(installed.targetsPath, win.join(codeRoot, "docs", "learning", "targets.json"), "配る設定は写しの側から読む");
  const override = win.join("D:", "operator-data", "learning");
  assert.equal(operatorLearningStateDir({ env: { BUZZASSIST_LEARNING_DIR: override }, homeDir: home, pathApi: win }), win.resolve(override));

  const devRoot = win.join("C:", "work", "buzzassist");
  const development = resolveLearningState({ codeRoot: devRoot, homeDir: home, env: { BUZZASSIST_LEARNING_DIR: override }, pathApi: win, developmentCheckout: true });
  assert.equal(development.stateDir, win.join(devRoot, "docs", "learning"), "開発用チェックアウトは上書きを見ずにリポジトリの docs/learning");
  assert.equal(channelLedgerDir(development, "sample-pack", win), win.join(devRoot, "channel-packs", "sample-pack", "docs", "learning"));
  assert.equal(development.hookEventLogPath, win.join(win.resolve(override), "hook-events.jsonl"), "フックの記録はリポジトリの外");

  const posix = resolveLearningState({ codeRoot: "/opt/copy", homeDir: "/home/sample", env: {}, pathApi: path.posix, developmentCheckout: false });
  assert.equal(posix.stateDir, path.posix.join("/home/sample", ".buzzassist", "learning"));
  assert.throws(() => channelLedgerDir(installed, `..${win.sep}escape`, win), /置き場の名前として使えない/u);
});

test("開発用チェックアウト（このリポジトリ）では従来どおり docs/learning を使う", () => {
  const state = learningState();
  assert.equal(state.mode, "development");
  assert.equal(ledgerPathFor("platform:platform-craft", "proposals"), path.join(SOURCE_ROOT, "docs", "learning", "proposals.jsonl"));
  assert.equal(ledgerPathFor("platform:platform-craft", "applied"), path.join(SOURCE_ROOT, "docs", "learning", "applied.jsonl"));
  assert.equal(
    ledgerPathFor("channel-pack:narrated-story", "proposals"),
    path.join(SOURCE_ROOT, "channel-packs", "narrated-story", "docs", "learning", "proposals.jsonl"),
  );
});

test("Claude と Codex の写しのフック・CLI から capture したものが、同じ台帳に同じ ID で入り、overlay が両方の写しへ届く", (t) => {
  const root = tempRoot(t);
  const { home, claude, codex, managed, state } = stageOperatorHome(root);
  const env = isolatedEnv(home);
  const prompt = "それは違う、前にも伝えた合成の依頼";

  // Claude Code の起動行（${CLAUDE_PLUGIN_ROOT} は読み込み時に置き換わる）。
  const claudeHook = spawnSync(hookCommand("claude", claude), {
    shell: true, cwd: root, encoding: "utf8", timeout: 30_000,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", user_prompt: prompt }),
    env: { ...env, CLAUDE_PLUGIN_ROOT: claude },
  });
  assert.equal(claudeHook.status, 0, claudeHook.stderr);
  // Codex の起動行（PLUGIN_ROOT を環境変数で渡し、互換の CLAUDE_PLUGIN_ROOT も渡る）。
  const codexHook = spawnSync(hookCommand("codex", codex), {
    shell: true, cwd: root, encoding: "utf8", timeout: 30_000,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", turn_id: "turn-synthetic-1", prompt }),
    env: { ...env, PLUGIN_ROOT: codex, CLAUDE_PLUGIN_ROOT: codex },
  });
  assert.equal(codexHook.status, 0, codexHook.stderr);
  const claudeScript = learnScriptFromHook(claudeHook.stdout);
  const codexScript = learnScriptFromHook(codexHook.stdout);
  assert.equal(claudeScript, path.join(claude, "scripts", "harness-learn.mjs"));
  assert.equal(codexScript, path.join(codex, "scripts", "harness-learn.mjs"));

  // フックの記録は状態の置き場の1つのファイルへ、どちらのホストから来たかつきで入る（本文は残さない）。
  const hookEvents = readJsonl(path.join(state, "hook-events.jsonl"));
  assert.deepEqual(hookEvents.map((event) => event.host), ["claude", "codex"]);
  assert.equal(fs.readFileSync(path.join(state, "hook-events.jsonl"), "utf8").includes("合成の依頼"), false);

  const text = "合成の手順では先に置き場を確かめてから書く";
  const ids = [];
  for (const [script, session] of [[claudeScript, "synthetic-claude-session"], [codexScript, "synthetic-codex-session"]]) {
    const result = runNode(script, ["capture", "--kind", "correction", "--target", TARGET, "--text", text, "--evidence", "合成の根拠", "--session", session], env);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    ids.push(/記録しました: ([a-f0-9]{12})/u.exec(result.stdout)?.[1]);
  }
  assert.equal(ids[0], ids[1], "同じ指摘がホストごとに別の ID になった");
  const ledger = path.join(state, "shared", "proposals.jsonl");
  const rows = readJsonl(ledger);
  assert.deepEqual(rows.map((row) => [row.id, row.session]), [[ids[0], "synthetic-claude-session"], [ids[0], "synthetic-codex-session"]]);
  for (const copy of [claude, codex, managed]) {
    assert.equal(fs.existsSync(path.join(copy, "docs", "learning", "proposals.jsonl")), false, `写しの中に台帳を書いた: ${copy}`);
  }
  // 公開 catalog も状態の置き場で作り直され、写しに同梱された catalog は書き換えない。
  assert.equal(readJsonl(path.join(state, "shared", "proposals.public.jsonl")).length, 1);

  // Claude の写しから見ても、Codex の写しで捕捉した回が同じ提案として数えられる。
  const status = runNode(claudeScript, ["status"], env);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`\\[${ids[0]}\\] ×2`, "u"));

  // Codex の写しで sync → 状態の置き場に区画を書き、ホストが読む全部の写しへ届ける。
  const sync = runNode(codexScript, ["sync", "--allow-missing-vocabulary"], env);
  assert.equal(sync.status, 0, `${sync.stdout}\n${sync.stderr}`);
  assert.doesNotMatch(sync.stdout, /配布し直しが要ります/u);
  const stateOverlay = path.join(state, "overlays", SKILL, "learned-auto.md");
  const block = fs.readFileSync(stateOverlay, "utf8");
  assert.ok(block.startsWith(LOCAL_OVERLAY_BEGIN));
  assert.match(block, /（2回指摘）/u);
  assert.match(block, new RegExp(`id: \`${ids[0]}\``, "u"));
  const delivered = [claude, codex, managed].flatMap((copy) => [
    path.join(copy, "skills", SKILL, "references", "learned-auto.md"),
    path.join(copy, ".agents", "skills", SKILL, "references", "learned-auto.md"),
  ]);
  const snapshot = () => delivered.map((file) => fs.readFileSync(file, "utf8"));
  for (const content of snapshot()) {
    assert.ok(content.startsWith(SHIPPED_OVERLAY.trimEnd()), "同梱の項目を書き換えた");
    assert.equal(content.split(LOCAL_OVERLAY_BEGIN).length - 1, 1, "区画が届いていない（または二重）");
    assert.equal(stripLocalOverlayBlock(content), SHIPPED_OVERLAY, "区画を外すと同梱の形に戻らない");
  }
  const syncState = JSON.parse(fs.readFileSync(path.join(state, "sync-state.json"), "utf8"));
  assert.equal(syncState.delivered.filesWritten, delivered.length);

  // もう一度 sync しても写しは変わらない（区画は差し替えで、積み増さない）。
  const before = snapshot();
  const again = runNode(claudeScript, ["sync", "--allow-missing-vocabulary"], env);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(snapshot().map((content) => content.replace(/_この端末での最終更新: [^_]+_/u, "")), before.map((content) => content.replace(/_この端末での最終更新: [^_]+_/u, "")));
  for (const content of snapshot()) assert.equal(content.split(LOCAL_OVERLAY_BEGIN).length - 1, 1);
});

test("setup 相当（取り込み → 写しの置き換え → 区画の配り直し）を2回流しても、提案・applied・索引・区画が残る", (t) => {
  const root = tempRoot(t);
  const { home, claude, codex, managed } = stageOperatorHome(root);
  const legacy = { id: "bbbbbbbbbbbb", kind: "fact", target: TARGET, text: "古い写しに残っていた合成の指摘", session: "old-session", capturedAt: "2026-09-01T00:00:00.000Z" };
  const legacyApplied = { id: "bbbbbbbbbbbb", target: TARGET, reviewer: "承認者テスト", attestedBy: "human-verified", appliedAt: "2026-09-02T00:00:00.000Z" };
  write(path.join(managed, "docs", "learning", "proposals.jsonl"), `${JSON.stringify(legacy)}\n`);
  write(path.join(managed, "docs", "learning", "applied.jsonl"), `${JSON.stringify(legacyApplied)}\n`);
  // ホストの版別キャッシュには配布元と同じ行が重複して残り、別の回（別 session）もある。
  const otherSession = { ...legacy, session: "old-session-2", capturedAt: "2026-09-03T00:00:00.000Z" };
  write(path.join(claude, "docs", "learning", "proposals.jsonl"), `${JSON.stringify(legacy)}\n${JSON.stringify(otherSession)}\n`);
  write(path.join(codex, "channel-packs", "sample-pack", "docs", "learning", "proposals.jsonl"),
    `${JSON.stringify({ id: "cccccccccccc", kind: "fact", target: "channel-pack:sample-pack", text: "合成", session: "s", capturedAt: "2026-09-01T00:00:00.000Z" })}\n`);
  const state = resolveLearningState({ codeRoot: managed, homeDir: home, env: {}, developmentCheckout: false });
  write(path.join(state.overlaysDir, SKILL, "learned-auto.md"), renderLocalOverlayBlock(
    [{ id: "dddddddddddd", kind: "fact", text: "この端末の合成の項目", evidence: [], occurrences: 1, firstSeenAt: "2026-09-04T00:00:00.000Z" }],
    "2026-09-04T00:00:00.000Z",
    { terms: [], castIds: [], homeRoot: home, vocabulary: null },
  ));

  const setupEquivalent = (round) => {
    const migration = migrateLegacyLearningState({ state, homeDir: home, now: () => `2026-09-1${round}T00:00:00.000Z` });
    // setup と自動更新は写しを丸ごと置き換える（同梱の overlay に戻る）。
    for (const copy of [managed, claude, codex]) {
      fs.rmSync(copy, { recursive: true, force: true });
      stagePluginCopy(copy);
    }
    const delivery = deliverLearningOverlays({ overlaysDir: state.overlaysDir, copies: learningOverlayCopies({ homeDir: home }) });
    return { migration, delivery };
  };

  const first = setupEquivalent(1);
  assert.equal(first.migration.imported, 4, "ID と session で重複を除いた件数（提案2・反映1・チャンネル1）");
  assert.deepEqual(first.migration.byKind, { proposals: 3, applied: 1, archived: 0, receipts: 0 });
  assert.equal(first.delivery.copies.length, 3);
  const proposals = readJsonl(sharedLedgerPath(state, "proposals"));
  assert.deepEqual(proposals.map((row) => row.session), ["old-session", "old-session-2"]);
  assert.deepEqual(readJsonl(sharedLedgerPath(state, "applied")), [legacyApplied]);
  assert.equal(readJsonl(path.join(channelLedgerDir(state, "sample-pack"), "proposals.jsonl")).length, 1);
  // 元のファイルは消さない（置き換えたのは合成の写しで、取り込み自体は読むだけ）。
  assert.ok(JSON.parse(fs.readFileSync(state.migrationRecordPath, "utf8")).sources.length >= 2);

  // 決着の索引と新しい提案を足してから、もう一度 setup 相当を流す。
  appendReceiptIndexRow(state.receiptIndexPath, { jobId: "video-synthetic-1", harnessId: "sample-harness", status: "completed", receiptPath: null, receiptSha256: "e".repeat(64), settledAt: "2026-09-05T00:00:00.000Z" });
  const newer = { id: "ffffffffffff", kind: "fact", target: TARGET, text: "置き換えの後に捕捉した合成の指摘", session: "new", capturedAt: "2026-09-06T00:00:00.000Z" };
  fs.appendFileSync(sharedLedgerPath(state, "proposals"), `${JSON.stringify(newer)}\n`);
  const snapshot = () => ({
    proposals: readJsonl(sharedLedgerPath(state, "proposals")),
    applied: readJsonl(sharedLedgerPath(state, "applied")),
    index: readJsonl(state.receiptIndexPath),
  });
  const beforeSecond = snapshot();
  const second = setupEquivalent(2);
  assert.equal(second.migration.skippedReason, "already-migrated");
  assert.deepEqual(snapshot(), beforeSecond, "2回目の setup 相当で提案・applied・索引が変わった");
  assert.equal(beforeSecond.index.length, 1);
  for (const copy of [managed, claude, codex]) {
    for (const base of ["skills", ".agents/skills"]) {
      const content = fs.readFileSync(path.join(copy, ...base.split("/"), SKILL, "references", "learned-auto.md"), "utf8");
      assert.equal(content.split(LOCAL_OVERLAY_BEGIN).length - 1, 1, `置き換えた写しへ区画が届いていない: ${copy} ${base}`);
      assert.match(content, /dddddddddddd/u);
    }
  }
});

test("状態の置き場に既に台帳があれば古い写しを混ぜない。子エージェントの環境では取り込まない", (t) => {
  const root = tempRoot(t);
  const { home, managed } = stageOperatorHome(root);
  write(path.join(managed, "docs", "learning", "proposals.jsonl"), `${JSON.stringify({ id: "111111111111", session: "a" })}\n`);
  const state = resolveLearningState({ codeRoot: managed, homeDir: home, env: {}, developmentCheckout: false });
  write(sharedLedgerPath(state, "proposals"), `${JSON.stringify({ id: "222222222222", session: "b" })}\n`);
  const result = migrateLegacyLearningState({ state, homeDir: home });
  assert.equal(result.skippedReason, "state-not-empty");
  assert.deepEqual(readJsonl(sharedLedgerPath(state, "proposals")).map((row) => row.id), ["222222222222"]);
  assert.equal(migrateLegacyLearningState({ state, homeDir: home }).skippedReason, "already-migrated");

  // 子エージェントの CLI は、読むだけの status でも状態の置き場へ何も書かない。
  const fresh = path.join(root, "fresh-home");
  const copy = stagePluginCopy(path.join(fresh, "plugins", "buzzassist", "plugin"));
  write(path.join(copy, "docs", "learning", "proposals.jsonl"), `${JSON.stringify({ id: "333333333333", kind: "fact", target: TARGET, text: "合成の古い指摘", session: "c" })}\n`);
  const status = runNode(path.join(copy, "scripts", "harness-learn.mjs"), ["status"], isolatedEnv(fresh, { BUZZASSIST_LEARNING_WRITE_FORBIDDEN: "child-agent" }));
  assert.equal(status.status, 0, status.stderr);
  assert.equal(fs.existsSync(path.join(fresh, ".buzzassist", "learning")), false);
});

test("開発用チェックアウトの写しでは、台帳も overlay も従来どおりリポジトリの中（HOME の状態の置き場を作らない）", (t) => {
  const root = tempRoot(t);
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const repo = stagePluginCopy(path.join(root, "repo"), { development: true });
  const env = isolatedEnv(home);
  const script = path.join(repo, "scripts", "harness-learn.mjs");
  const capture = runNode(script, ["capture", "--kind", "fact", "--target", TARGET, "--text", "開発用チェックアウトの合成の指摘", "--evidence", "合成", "--session", "dev"], env);
  assert.equal(capture.status, 0, capture.stderr);
  assert.equal(readJsonl(path.join(repo, "docs", "learning", "proposals.jsonl")).length, 1);
  const sync = runNode(script, ["sync", "--allow-missing-vocabulary"], env);
  assert.equal(sync.status, 0, sync.stderr);
  assert.match(sync.stdout, /配布し直しが要ります/u);
  const overlay = fs.readFileSync(path.join(repo, ".agents", "skills", SKILL, "references", "learned-auto.md"), "utf8");
  assert.match(overlay, /開発用チェックアウトの合成の指摘/u);
  assert.equal(overlay.includes(LOCAL_OVERLAY_BEGIN), false, "開発用チェックアウトの overlay に端末の区画を混ぜた");
  assert.equal(fs.existsSync(path.join(home, ".buzzassist", "learning")), false);
});

test("区画の書き出しと取り外しは可逆で、本文から印を偽装できない", () => {
  const block = renderLocalOverlayBlock(
    [{ id: "abcdefabcdef", kind: "fact", text: `偽の終わり ${LOCAL_OVERLAY_END} と始まり ${LOCAL_OVERLAY_BEGIN} -->`, evidence: [], occurrences: 1, firstSeenAt: "2026-09-01" }],
    "2026-09-01T00:00:00.000Z",
    { terms: [], castIds: [], homeRoot: "", vocabulary: null },
  );
  assert.equal(block.split(LOCAL_OVERLAY_END).length - 1, 1, "本文から終わりの印を作れた");
  assert.equal(block.split(LOCAL_OVERLAY_BEGIN).length - 1, 1, "本文から始まりの印を作れた");
  const composed = composeOverlay(SHIPPED_OVERLAY, block);
  assert.equal(stripLocalOverlayBlock(composed), SHIPPED_OVERLAY);
  assert.equal(composeOverlay(composed, block), composed, "同じ区画を積み増した");
  assert.equal(composeOverlay(composed, ""), SHIPPED_OVERLAY, "区画が空なら同梱の形へ戻す");
  assert.equal(composeOverlay(SHIPPED_OVERLAY, ""), SHIPPED_OVERLAY);
  assert.equal(composeOverlay("", block), block);
});
