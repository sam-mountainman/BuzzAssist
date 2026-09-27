import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  HOST_INSTRUCTION_MAX_LINES,
  HOST_INSTRUCTION_OUTPUTS,
  HOST_INSTRUCTION_PROFILES,
  HOST_INSTRUCTION_TEMPLATE,
  MANAGED_BLOCK_MARKER,
  antigravitySetupBlock,
  applyManagedBlock,
  countInstructionLines,
  generateHostInstructionFiles,
  readHostInstructionTemplate,
  referencedRepoPaths,
  renderHostInstructions,
} from "../lib/hostInstructionFiles.mjs";
import { PACKAGE_RUNTIME_REQUIRED_PATHS } from "../lib/packageTarballAudit.mjs";
import {
  DISTRIBUTABLE_CONFIG_ENTRIES,
  PLUGIN_SOURCE_DIRECTORIES,
  PLUGIN_SOURCE_FILES,
} from "../scripts/setup-agents.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = async (name) => (await readFile(join(root, name), "utf8")).replace(/\r\n/gu, "\n");

test("CLAUDE.md / AGENTS.md / GEMINI.md は、テンプレートから作ったものと一致する（手で直していない）", async () => {
  // 3つを手で保守していた頃、同じ規則の文面がホストごとにずれた。直すのはテンプレートだけにする。
  for (const file of await generateHostInstructionFiles(root)) {
    assert.equal(await read(file.fileName), file.content,
      `${file.fileName} がテンプレートとずれている。config/host-instructions.template.md を直して node scripts/generate-host-instructions.mjs を走らせること`);
  }
});

test("--check はずれを非0で知らせ、一致していれば0で終わる", () => {
  const result = spawnSync(process.execPath, [join(root, "scripts", "generate-host-instructions.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /一致/u);
});

test("CLAUDE.md と AGENTS.md の違いは、ホストの語が入った行だけ", async () => {
  const claude = (await read(HOST_INSTRUCTION_OUTPUTS.claude)).split("\n");
  const codex = (await read(HOST_INSTRUCTION_OUTPUTS.codex)).split("\n");
  assert.equal(claude.length, codex.length, "同じテンプレートから同じ行数で出る");
  const differing = claude
    .map((line, index) => ({ line: index + 1, claude: line, codex: codex[index] }))
    .filter((entry) => entry.claude !== entry.codex);
  assert.ok(differing.length > 0, "ホストの語は実際に差し込まれている");
  // 両ホストの語（HOST_INSTRUCTION_PROFILES の値）を取り除くと、残りは一字一句同じになること。
  const hostWords = [...Object.values(HOST_INSTRUCTION_PROFILES.claude), ...Object.values(HOST_INSTRUCTION_PROFILES.codex)]
    .flatMap((value) => String(value).split("\n"))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const stripHostWords = (line) => hostWords.reduce((text, value) => text.split(value).join(""), line);
  for (const entry of differing) {
    assert.equal(stripHostWords(entry.claude), stripHostWords(entry.codex), `${entry.line} 行目: ホストの語以外が違う`);
  }
  // 見出しと各ホストのセットアップ先。
  assert.equal(claude[0], "# BuzzAssist — Claude Code の地図");
  assert.equal(codex[0], "# BuzzAssist — Codex の地図");
});

test("3つのホストが同じ規則の段落を同じ文面で持つ（GEMINI.md の共通部分も含む）", async () => {
  const files = Object.fromEntries(await Promise.all(Object.values(HOST_INSTRUCTION_OUTPUTS).map(async (name) => [name, await read(name)])));
  const shared = [
    // 直接起動は拒否される内部 runner を「唯一の入口」と書いていた GEMINI.md を、上位の入口に揃えた。
    "運営者の入口は `node scripts/run-video-harness.mjs`",
    "はベンチマークの移行専用で、新作に使わない。",
    "MP4 から作った contact-sheet のサインオフが有効",
    "`--protagonist-speaker-id` を渡す",
    "- 生の日本語台本から完成動画 → `.agents/skills/platform-craft/SKILL.md`",
    "`.agents/skills/harness-parallel-execution/SKILL.md`",
    "推測で並列化しない。",
    "入口は `node scripts/harness-learn.mjs`。",
    "人が確かめるのは配る版（GitHub Release）を出すときの",
    "`awaiting-human-review` は正当な停止。",
  ];
  for (const [name, text] of Object.entries(files)) {
    for (const fragment of shared) assert.ok(text.includes(fragment), `${name} に共通の段落が無い: ${fragment}`);
  }
  // ホスト固有の部分は、そのホストにだけある。
  assert.match(files["GEMINI.md"], /Antigravity にはフックの仕組みが無い/u);
  assert.doesNotMatch(files["CLAUDE.md"], /Antigravity にはフックの仕組みが無い。\*\*/u);
  assert.match(files["CLAUDE.md"], /harness-external-call\.mjs record --host/u);
  // フックのある2つのホストは、止められたときと圧縮のあとの振る舞い、Codex の /hooks の信頼を地図に持つ。
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    assert.match(files[name], /実行前のフック（harness-guard-hook）が止めた[\s\S]{0,160}迂回せず、決めてほしいことと打つコマンドを人に渡す/u, name);
    assert.match(files[name], /圧縮されたと知らされたら（harness-compact-hook）、挙がった正本スキルと docs を最後まで読み直して/u, name);
    assert.match(files[name], /Codex はプラグインのフックを、新しく足されたものも `\/hooks` で信頼するまで動かさない/u, name);
  }
  assert.doesNotMatch(files["GEMINI.md"], /harness-guard-hook/u, "フックの無い Antigravity には書かない");
  assert.match(files["GEMINI.md"], /--caller-host antigravity/u);
  assert.doesNotMatch(files["GEMINI.md"], /setup-agents\.mjs --agent claude/u);
});

test("リポジトリで Antigravity の setup を走らせても GEMINI.md は変わらない（管理ブロックが setup と同じもの）", async () => {
  // 以前は GEMINI.md の全文が管理ブロックの中にあり、setup を --project-dir にこのリポジトリで
  // 走らせると、漫画・並列・自己改善の段落がセットアップ手順だけに置き換わっていた。
  const gemini = await read("GEMINI.md");
  assert.equal(applyManagedBlock(gemini, MANAGED_BLOCK_MARKER, antigravitySetupBlock()), gemini);
  assert.ok(gemini.startsWith("# BuzzAssist — Antigravity の地図"), "共通の規則は管理ブロックの外にある");
  assert.ok(gemini.trimEnd().endsWith(`<!-- ${MANAGED_BLOCK_MARKER}:END -->`));

  // 運営者のプロジェクト（空・既存の本文あり）へは、これまでどおりブロックだけを足す。
  const fresh = applyManagedBlock("", MANAGED_BLOCK_MARKER, antigravitySetupBlock());
  assert.ok(fresh.startsWith(`<!-- ${MANAGED_BLOCK_MARKER}:START -->\n# BuzzAssist Agent Setup`));
  const existing = applyManagedBlock("# 運営者の規則\n", MANAGED_BLOCK_MARKER, antigravitySetupBlock());
  assert.ok(existing.startsWith("# 運営者の規則\n\n<!-- BUZZASSIST:START -->"));
  assert.equal(applyManagedBlock(existing, MANAGED_BLOCK_MARKER, antigravitySetupBlock()), existing, "2回目は何も変えない");
});

test("setup は GEMINI.md の管理ブロックをテンプレートと同じ関数から書く（2つ目の文面を持たない）", async () => {
  const source = await read("scripts/setup-agents.mjs");
  assert.match(source, /antigravitySetupBlock\(\)/u);
  assert.doesNotMatch(source, /function antigravityRuleBlock/u, "setup に Antigravity の手順の写しを置かない");
});

test("テンプレートの書式の誤りは黙って通さない", async () => {
  assert.throws(() => renderHostInstructions("{{unknownWord}}\n", "claude"), /unknownWord/u);
  assert.throws(() => renderHostInstructions("{{#hosts claude}}\nx\n", "claude"), /閉じていない/u);
  assert.throws(() => renderHostInstructions("{{/hosts}}\n", "claude"), /対応する/u);
  assert.throws(() => renderHostInstructions("{{#hosts cursor}}\nx\n{{/hosts}}\n", "claude"), /未知のホスト/u);
  assert.throws(() => renderHostInstructions("x\n", "cursor"), /未知のホスト/u);
  const template = await readHostInstructionTemplate(root);
  assert.equal(renderHostInstructions("{{#hosts codex}}\nonly-codex\n{{/hosts}}\n{{hostName}}\n", "claude"), "Claude Code\n");
  assert.ok(template.includes("{{#hosts antigravity}}"));
});

// ---------------------------------------------------------------------------
// 指示ファイルは「地図」（2026-09-27）。常に読み込まれる文書が長いほど、1つ1つの決まりが
// 「関係があるかもしれない情報」として任意に扱われる。地図は短く保ち、指す先で詳細を読ませる。
// ---------------------------------------------------------------------------

test("3つの地図はどれも上限の行数以下で、超えるテンプレートは生成の時点で止まる", async (t) => {
  for (const file of await generateHostInstructionFiles(root)) {
    const lines = countInstructionLines(file.content);
    assert.ok(lines <= HOST_INSTRUCTION_MAX_LINES, `${file.fileName} が ${lines} 行（上限 ${HOST_INSTRUCTION_MAX_LINES}）`);
  }
  assert.equal(countInstructionLines(""), 0);
  assert.equal(countInstructionLines("a\nb\n"), 2);
  assert.equal(countInstructionLines("a\r\nb"), 2);

  // 上限を1行でも超えるテンプレートは、書き出す前に理由つきで止まる。
  const scratch = await mkdtemp(join(tmpdir(), "host-instructions-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await mkdir(join(scratch, "config"), { recursive: true });
  const lines = Array.from({ length: HOST_INSTRUCTION_MAX_LINES + 1 }, (_, index) => `- 行 ${index + 1}`);
  await writeFile(join(scratch, HOST_INSTRUCTION_TEMPLATE), `${lines.join("\n")}\n`, "utf8");
  await assert.rejects(generateHostInstructionFiles(scratch), new RegExp(`地図の上限 ${HOST_INSTRUCTION_MAX_LINES} 行を超えている`, "u"));
  // ちょうど上限なら通る。
  await writeFile(join(scratch, HOST_INSTRUCTION_TEMPLATE), `${lines.slice(1).join("\n")}\n`, "utf8");
  for (const file of await generateHostInstructionFiles(scratch)) {
    assert.equal(countInstructionLines(file.content), HOST_INSTRUCTION_MAX_LINES);
  }
});

test("地図から参照を取り出す（プレースホルダ・ワイルドカード・ディレクトリは除く）", () => {
  const text = [
    "先に `.agents/skills/a/SKILL.md` を読む。入口は `node scripts/run.mjs`（詳しくは `docs/x-ja.md`）。",
    "`apply/finalize/generate-manga-v*` と `scripts/tmp-*.mjs`、`canvas/harness-runs/<Job ID>/run-receipt.json`、`docs/learning/` は除く。",
    "直すときは config/t.md を直す。",
  ].join("\n");
  assert.deepEqual(referencedRepoPaths(text), [".agents/skills/a/SKILL.md", "config/t.md", "docs/x-ja.md", "scripts/run.mjs"]);
});

// package.json の files の書き方（./ 付き・ディレクトリ・* のグロブ・! の除外）で1つのパスが入るか。
function packageFilesInclude(patterns, relativePath) {
  const toRegExp = (pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, "[^/]*")}$`, "u");
  const matches = (pattern) => {
    const normalized = pattern.replace(/^\.\//u, "");
    if (normalized.endsWith("/")) return relativePath.startsWith(normalized);
    if (normalized.includes("*")) return toRegExp(normalized).test(relativePath);
    return relativePath === normalized || relativePath.startsWith(`${normalized}/`);
  };
  const included = patterns.filter((pattern) => !pattern.startsWith("!")).some(matches);
  const excluded = patterns.filter((pattern) => pattern.startsWith("!")).some((pattern) => matches(pattern.slice(1)));
  return included && !excluded;
}

// setup-agents が ~/plugins/buzzassist/plugin へ写すものに1つのパスが入るか（config は許可した項目だけ）。
function pluginSourceIncludes(relativePath) {
  if (PLUGIN_SOURCE_FILES.includes(relativePath)) return true;
  const [top, second] = relativePath.split("/");
  if (!PLUGIN_SOURCE_DIRECTORIES.includes(top)) return false;
  if (top === "config") return DISTRIBUTABLE_CONFIG_ENTRIES.includes(second);
  return true;
}

// setup が写す config の項目は、Release の tgz にも入っていなければならない。自動更新は tgz から入れるので、
// 一覧にだけあって tgz に無いものは、配布の検証でスキルの参照が解決せず更新が止まる（2026-09-28）。
test("setup が写す config の項目は、すべて package.json の files に入っている", async () => {
  const packageFiles = JSON.parse(await read("package.json")).files;
  // ディレクトリの項目は files に「config/<名前>/」と書くので、中の1ファイルとして確かめる。
  const included = (entry) => packageFilesInclude(packageFiles, `config/${entry}`)
    || packageFilesInclude(packageFiles, `config/${entry}/any.json`);
  const missing = DISTRIBUTABLE_CONFIG_ENTRIES.filter((entry) => !included(entry));
  assert.deepEqual(missing, [], `setup の一覧にあって Release の tgz に無い: ${missing.join(", ")}`);
});

test("地図が指す先は実在し、Release の tgz にも setup の写しにも入っている（行き止まりを配らない）", async () => {
  const packageFiles = JSON.parse(await read("package.json")).files;
  assert.ok(packageFilesInclude(packageFiles, "scripts/setup-agents.mjs"));
  assert.equal(packageFilesInclude(packageFiles, "scripts/koya-x-2026-01.mjs"), false, "! の除外が効く");
  assert.equal(pluginSourceIncludes("config/harness-deployments.json"), false, "端末ごとの設定は写さない");
  const seen = new Set();
  for (const name of Object.values(HOST_INSTRUCTION_OUTPUTS)) {
    const references = referencedRepoPaths(await read(name));
    assert.ok(references.includes("docs/host-instructions-detail-ja.md"), `${name} が決まりの全文を指していない`);
    for (const ref of references) {
      seen.add(ref);
      assert.equal(existsSync(join(root, ref)), true, `${name} が指す ${ref} が無い`);
      assert.ok(packageFilesInclude(packageFiles, ref), `${name} が指す ${ref} が package.json の files に無い（Release の tgz に入らない）`);
      assert.ok(pluginSourceIncludes(ref), `${name} が指す ${ref} が setup-agents の写し（PLUGIN_SOURCE_FILES など）に無い`);
    }
  }
  // セットアップを頼まれたエージェントが、地図から全手順の文書へ辿れること。
  for (const name of [HOST_INSTRUCTION_OUTPUTS.claude, HOST_INSTRUCTION_OUTPUTS.codex, HOST_INSTRUCTION_OUTPUTS.antigravity]) {
    assert.match(await read(name), /docs\/agent-setup\.md/u, `${name} がセットアップの全手順を指していない`);
  }
  // setup が運営者のプロジェクトの GEMINI.md へ書く管理ブロックは、リポジトリの外から導入済みの
  // プラグインの docs を指す。Release の tgz の監査で、それが欠けた tgz を止める（必須一覧に入れる）。
  const blockReferences = referencedRepoPaths(antigravitySetupBlock());
  assert.ok(blockReferences.includes("docs/agent-setup.md"), "管理ブロックがセットアップの全手順を指していない");
  for (const ref of blockReferences.filter((entry) => entry.startsWith("docs/"))) {
    assert.ok(PACKAGE_RUNTIME_REQUIRED_PATHS.includes(ref), `管理ブロックが指す ${ref} が tgz の必須一覧に無い`);
  }
  assert.ok(PACKAGE_RUNTIME_REQUIRED_PATHS.includes("docs/host-instructions-detail-ja.md"));
  // 地図が指す先の文書そのものが、さらに指すリポジトリ内のファイルも実在する。
  for (const doc of ["docs/host-instructions-detail-ja.md", "docs/agent-setup.md"]) {
    for (const ref of referencedRepoPaths(await read(doc))) {
      assert.equal(existsSync(join(root, ref)), true, `${doc} が指す ${ref} が無い`);
    }
  }
  assert.ok(seen.size >= 10, "地図は正本スキル・入口・文書を指している");
});

test("地図から移した決まりは、移した先の文書に全部残っている", async () => {
  // 地図には要点だけを置いた。元の段落の決まりが移した先で落ちていないことを、決まりごとに確かめる。
  // 日本語の本文は行の折り返しを詰め、英語の本文は空白を1つにまとめてから照合する。
  const detail = (await read("docs/host-instructions-detail-ja.md")).replace(/\n\s*/gu, "");
  for (const rule of [
    // 漫画動画
    "`.agents/skills/manga-video-production/SKILL.md` と `.agents/skills/manga-page-camera/SKILL.md` を最後まで読む",
    "`.claude/skills` の項目は、その共有の正本へのホスト用アダプター",
    "再開（resume）と取り消し（cancel）、RunReceipt、Canvas 投影はこの入口が持つ",
    "新しい回を作る唯一の制作 runner は `node scripts/koya-manga-video.mjs`",
    "`apply/finalize/generate-manga-v*` スクリプトはベンチマークの",
    "声の品質、キャラクターの属性ゲート、ブラインド比較",
    "実際の MP4 が最後までデコードできるときだけ",
    "専用のナレーターは作らない",
    // 共通の経路
    "署名済み Channel Pack を必須にする",
    "既定の plan だけの動きのままにする",
    "同じハーネス宣言、Skill SHA、Channel Pack の指紋、品質ゲート、RunReceipt",
    "暗黙の代わり（フォールバック）にならない",
    // 完成と言う前に
    "`scripts/harness-stop-hook.mjs`",
    "`/hooks` で信頼するまで動かさない",
    "`canvas/harness-runs/<Job ID>/run-receipt.json`",
    "誰が何を確認すれば進むかを報告する",
    // 解説動画・並列・自己改善
    "`signoff_video_harness_job`",
    "同時に書き込むと壊れる共有の状態ファイル",
    "Claude Code と Codex のどちらから実行しても同じ結果になる",
    "捕捉（capture）は何も書き換えず、統合は既定で dry-run",
    "overlay（`learned-auto.md`）だけでなく、正本スキル（SKILL.md・references）も直してよい",
    "1件ずつ `rollback` できる形にする",
    "機械はこの承認を記録できない",
    "有料 API を動かす指示になるのを防ぐため",
    "`channel-pack:narrated-story-script`",
    "訂正に当たらなければ何もしなくてよい",
    // 外部モデルの呼び出し
    "--purpose \"<用途>\" --input <渡した本文のファイル> --output <返った本文のファイル>",
    "本文は保存しない",
    "`--status empty|truncated`",
    "`node scripts/script-quality-loop.mjs record --external-call <id>`",
    "Antigravity は記録しない（二重に数えない）",
    "`--caller-host antigravity`",
  ]) assert.ok(detail.includes(rule), `docs/host-instructions-detail-ja.md に決まりが無い: ${rule}`);

  const setup = (await read("docs/agent-setup.md")).replace(/\s+/gu, " ");
  for (const rule of [
    "install.sh | bash",
    "install.ps1",
    "--agents claude,codex",
    "do not use the `.sh` wrappers",
    "Do not configure Claude Desktop, Cursor, or Antigravity unless the user explicitly asks",
    "`BUZZASSIST_AUTO_UPDATE_HOSTS` may list the other host",
    "`--no-install-prerequisites`",
    "`--allow-harness-not-ready`",
    "doctor gate",
    "`BUZZASSIST_AUTO_UPDATE=enabled`",
    "Operators set up before 0.1.27 must rerun setup once",
    "`--no-auto-update`",
    "do not claim setup succeeded",
    "`openExternalBrowser: true`",
    "start a new Claude Code session / Codex task",
    "`BUZZASSIST_CLOUDFLARED_AUTO_DOWNLOAD=0`",
    "`--cf-hostname canvas.buzzassist.ai`",
    "`--provider ngrok --ngrok-authtoken <token>`",
    "Claude Code itself does not render MCP Apps widgets",
    "`render_buzzassist_canvas_widget` entrypoint is experimental fallback only",
    "`prepare_canvas_attachments`, `read_canvas_attachment_bundle`",
    "a new Cowork chat",
    "`canvas/.agent-attachments/`",
    "claude plugin install buzzassist@buzzassist --scope user",
    "codex plugin add buzzassist@buzzassist",
    "node scripts/setup-agents.mjs --agent antigravity --project-dir <active-user-project-dir> --no-launch",
    "Use the live URL from `canvas/.server.json` when a requested port is busy.",
  ]) assert.ok(setup.includes(rule), `docs/agent-setup.md に手順が無い: ${rule}`);
});
