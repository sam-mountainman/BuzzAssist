import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GENRE_CANONICAL_ENTRYPOINTS, isLegacyCliProductionAction } from "../lib/harnessRouting.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEGACY_CLI = join(root, "scripts", "build-manga-video.mjs");

function runLegacyCli(args, cwd) {
  // node 本体を直接呼ぶ（npm を spawn しない。Windows でも同じ形で動く）。
  return spawnSync(process.execPath, [LEGACY_CLI, ...args], { cwd, encoding: "utf8", timeout: 60_000 });
}

test("historical version scripts remain inventoried and isolated from the official CLI", () => {
  const result = spawnSync(process.execPath, ["scripts/audit-koya-legacy-entrypoints.mjs", root], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.pass, true);
  assert.equal(report.matched.length, 67);
  assert.equal(report.gates.legacyProductionActionsMatchRouting, true, "台帳の本番工程と、実際に止める表が一致すること");
  assert.equal(report.gates.legacyCliGuardsProductionActions, true, "旧 CLI が本番工程の前で止めること");
});

test("旧入口の CLI は、本番の工程を --benchmark-migration が無ければ何も書かずに止め、正規入口を案内する", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "legacy-cli-guard-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const inventory = JSON.parse(await readFile(join(root, "config", "koya-manga-legacy-migrations.json"), "utf8"));
  const actions = inventory.legacyEntrypointPolicy.productionActions;
  assert.deepEqual(
    [...actions].sort(),
    [...GENRE_CANONICAL_ENTRYPOINTS["manga-video"].legacyCliProductionActions["scripts/build-manga-video.mjs"]].sort(),
  );
  const missingScript = join(project, "missing-script.txt");
  for (const action of actions) {
    const result = runLegacyCli([action, "--project-dir", project, "--script-path", missingScript, "--episode-id", "legacy-guard-fixture", "--manifest-path", join(project, "manifest.json")], project);
    assert.equal(result.status, 2, `${action}: 止まること（${result.stderr}）`);
    assert.match(result.stderr, /移行ベンチマーク専用/u, `${action}: 理由を言うこと`);
    assert.match(result.stderr, /run-video-harness\.mjs start --harness koya-manga-video/u, `${action}: 正規入口を案内すること`);
    assert.match(result.stderr, /--benchmark-migration/u, `${action}: 過去作の再現のやり方を言うこと`);
    assert.equal(result.stdout, "", `${action}: 何も出力しない`);
  }
  // 引数なしの既定 action は full。これも止まる。
  const bare = runLegacyCli(["--project-dir", project], project);
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /build-manga-video\.mjs full/u);
  // どの呼び出しも作業場に何も書いていない。
  assert.deepEqual(await readdir(project), []);
  assert.equal(existsSync(join(project, "canvas")), false);
});

test("旧入口の CLI は、明示した --benchmark-migration と成果物を作らない action だけを通す", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "legacy-cli-allowed-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  // 過去作の再現と明言すれば関門を越える（その先で台本が無いので失敗するが、拒否ではない）。
  const acknowledged = runLegacyCli(["plan", "--benchmark-migration", "--project-dir", project, "--script-path", join(project, "missing-script.txt")], project);
  assert.notEqual(acknowledged.status, 0);
  assert.notEqual(acknowledged.status, 2);
  assert.doesNotMatch(acknowledged.stderr, /移行ベンチマーク専用/u);
  assert.match(acknowledged.stderr, /ENOENT/u);
  // status と声の一覧・試聴系は本番工程ではない。
  for (const action of ["status", "voices", "cast-voices", "voice-library-audition", "voice-library-approve"]) {
    assert.equal(isLegacyCliProductionAction({ entrypoint: "scripts/build-manga-video.mjs", action }), false, action);
  }
  const status = runLegacyCli(["status", "--manifest-path", join(project, "missing-manifest.json"), "--project-dir", project], project);
  assert.doesNotMatch(status.stderr, /移行ベンチマーク専用/u, "status は拒否しない");
  // ヘルプは正規入口を先頭で案内する。
  const help = runLegacyCli(["--help"], project);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Benchmark-migration only/u);
  assert.match(help.stdout, /run-video-harness\.mjs start --harness koya-manga-video/u);
});

test("ordinary package commands do not expose legacy production or voice entrypoints", async () => {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["manga-video:legacy"], undefined);
  assert.equal(packageJson.scripts["manga-video:voice-audition"], undefined);
  assert.equal(packageJson.scripts["manga-video:voice-approve"], undefined);
  assert.equal(packageJson.scripts["manga-video"], "node scripts/koya-manga-video.mjs");
});
