import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 配布されたプラグインは node_modules を持たない（初回起動で入れる）。配布シミュレーションは
// その状態から実行系を直接読み込むので、ここに挙げたモジュールの静的 import の連鎖に
// 外部パッケージが入ると、依存を入れる前の配布物では読み込めない。
// 実際、Channel Pack の署名処理が JSON の書き込みのためだけに Canvas のライブラリ
// （先頭で fractional-indexing を読む）を経由し、動画 Job が契約の検証のために ajv を
// 先頭で読んでいて、配布シミュレーションが列のどの時点でも通らない状態だった。
// 配布シミュレーションは重いので、同じ性質をここで先に安く確かめる。
const DISTRIBUTED_RUNTIME_ENTRIES = [
  "lib/narratedStoryVideo.mjs",
  "lib/harnessDeploymentResolver.mjs",
  "scripts/harness-learn.mjs",
  "scripts/narrated-story-video.mjs",
];

function externalImports(entry) {
  const seen = new Map();
  const external = new Map();
  const visit = (file, from) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.set(file, from);
    const source = readFileSync(file, "utf8");
    const pattern = /^\s*(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gmu;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1] || match[2];
      if (specifier.startsWith(".")) visit(resolve(dirname(file), specifier), file);
      else if (!specifier.startsWith("node:") && !external.has(specifier)) external.set(specifier, file);
    }
  };
  visit(resolve(root, entry), null);
  const chain = (file) => {
    const parts = [];
    for (let current = file; current; current = seen.get(current)) parts.unshift(relative(root, current));
    return parts.join(" → ");
  };
  return [...external].map(([specifier, file]) => `${specifier}（${chain(file)}）`);
}

for (const entry of DISTRIBUTED_RUNTIME_ENTRIES) {
  test(`配布物の実行系は、依存を入れる前でも読み込める: ${entry}`, () => {
    assert.deepEqual(externalImports(entry), [], "静的 import の連鎖に外部パッケージがある（使う瞬間に読むか、依存の無いモジュールへ切り出す）");
  });
}

test("JSON の原子的書き込みは、Canvas のライブラリからも同じ実装が使える", async () => {
  const canvas = await import("../lib/canvasScene.mjs");
  const atomic = await import("../lib/atomicJsonFile.mjs");
  assert.equal(canvas.writeJsonAtomic, atomic.writeJsonAtomic);
  assert.equal(canvas.readJsonIfExists, atomic.readJsonIfExists);
});

test("契約の検証は、ajv を使う瞬間に読んでも、合格と不合格を正しく返す", async () => {
  // ajv を先頭で読むのをやめ、初回の検証で読む形にした。読み込み方を変えても、
  // 正しい契約は通り、壊れた契約はどこが悪いかを返すこと。
  const { validateKoyaMangaProductionSchema, DEFAULT_KOYA_CONTRACT_PATH } = await import("../lib/koyaMangaProductionContract.mjs");
  const contract = JSON.parse(readFileSync(DEFAULT_KOYA_CONTRACT_PATH, "utf8"));
  const good = validateKoyaMangaProductionSchema(contract);
  assert.equal(good.pass ?? good.failures?.length === 0, true, "同梱の契約は schema を通ること");
  const broken = structuredClone(contract);
  broken.unexpectedTopLevelField = true;
  const bad = validateKoyaMangaProductionSchema(broken);
  assert.equal(bad.pass ?? bad.failures?.length === 0, false, "未知の項目を足した契約は落ちること");
  assert.ok(bad.failures.some((failure) => /unexpectedTopLevelField/u.test(failure.path)), "どこが悪いかを返すこと");
  // 2回目以降も同じ結果（コンパイル済みの検証器を使い回しても、前回のエラーを引きずらない）。
  assert.equal(validateKoyaMangaProductionSchema(contract).failures.length, 0);
});

test("原子的な置き換えは、読まれている最中の拒否をやり直す（Windows）", async () => {
  // Windows は、他のプロセスがそのファイルを読んでいる瞬間の置き換えを EPERM で拒む。
  // MCP の背景ジョブは「状態を書く側」と「状態を見る側」が同時に触るので、これで
  // runner が起動直後に死に、記録は queued・ログは空のまま残った。
  const { renameWithRetry, writeJsonAtomic, readJsonIfExists } = await import("../lib/atomicJsonFile.mjs");
  const waits = [];
  const waitImpl = async (ms) => { waits.push(ms); };

  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
  };
  assert.equal(await renameWithRetry("a", "b", { renameImpl: flaky, waitImpl }), 3, "拒まれた分だけやり直すこと");
  assert.deepEqual(waits, [5, 10]);

  // 別の理由（置き換え元が無い）は、やり直さずそのまま伝える。
  let missingCalls = 0;
  await assert.rejects(
    () => renameWithRetry("a", "b", {
      renameImpl: async () => { missingCalls += 1; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
      waitImpl,
    }),
    /ENOENT/u,
  );
  assert.equal(missingCalls, 1, "やり直してよい理由だけをやり直すこと");

  // 何度やっても拒まれるなら、黙って諦めずに投げる。
  await assert.rejects(
    () => renameWithRetry("a", "b", {
      renameImpl: async () => { throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); },
      attempts: 3,
      waitImpl,
    }),
    /EBUSY/u,
  );

  // 実ファイルでも書けること（中身が壊れないこと）。
  const dir = await mkdtemp(join(tmpdir(), "atomic-json-"));
  try {
    const target = join(dir, "nested", "state.json");
    await writeJsonAtomic(target, { status: "queued" });
    assert.deepEqual(await readJsonIfExists(target, null), { status: "queued" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
