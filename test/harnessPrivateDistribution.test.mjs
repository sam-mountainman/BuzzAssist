import assert from "node:assert/strict";
import { execFile as callback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { npmInvocation } from "../scripts/audit-package-tarball.mjs";
import { loadHarnesses } from "../scripts/harness-registry.mjs";
import * as setup from "../scripts/setup-agents.mjs";

const execFile = promisify(callback);
const repo = fileURLToPath(new URL("../", import.meta.url));
const privateMarker = /buzzassist-private|"layer"\s*:\s*"private"/iu;

test("#13 外の宣言を環境変数で有効にしても npm pack と setup の写しへ名前・id・内容を入れない", { timeout: 180000 }, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "harness-private-distribution-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const external = join(scratch, "private"); await mkdir(external);
  const id = `synthetic-${randomUUID()}`;
  const implementation = `${id}.mjs`;
  await writeFile(join(external, `${id}.harness.json`), JSON.stringify({ id, version: "1.0.0", displayName: "合成の非公開ジャンル", status: "in-production",
    layer: "private", childProtocol: "buzzassist-child-v1", entrypoint: `node ${implementation}`, produces: { kind: "video" },
    reviewAttestation: { subject: id }, canonicalSkills: [".agents/skills/platform-craft/SKILL.md"], learningTargets: ["platform:platform-craft"],
    requiresFromOperator: [{ id: "signed-channel-pack" }], guarantees: [{ id: "synthetic-quality", evidenceAuditIds: ["syntheticQuality"] }] }));
  await writeFile(join(external, implementation), `// ${id} private implementation\n`);
  const old = process.env.BUZZASSIST_PRIVATE_HARNESS_DIRS;
  process.env.BUZZASSIST_PRIVATE_HARNESS_DIRS = external;
  t.after(() => { if (old === undefined) delete process.env.BUZZASSIST_PRIVATE_HARNESS_DIRS; else process.env.BUZZASSIST_PRIVATE_HARNESS_DIRS = old; });
  assert.ok(loadHarnesses().some((harness) => harness.id === id), "有効な非公開ハーネスを実際に登録してから配布を検査する");
  const dir = join(repo, "config", "harnesses");
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".harness.json")) continue;
    const bytes = await readFile(join(dir, name), "utf8");
    assert.notEqual(JSON.parse(bytes).layer, "private", name);
    assert.doesNotMatch(bytes, privateMarker, name);
  }
  const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
  assert.doesNotMatch(JSON.stringify(pkg.files), privateMarker);
  for (const path of pkg.files) assert.ok(!path.split(/[\\/]/u).includes(".."), `files がリポジトリの外を指している: ${path}`);
  const cache = join(scratch, "npm-cache");
  // prepack の build / lock 書き換えを起動しない。配布されるファイルの選択は npm 本体で照合する。
  const command = npmInvocation(["pack", "--dry-run", "--json", "--ignore-scripts", "--cache", cache]);
  const { stdout } = await execFile(command.command, command.args, { cwd: repo, env: process.env, shell: command.shell, timeout: 90000, maxBuffer: 16 * 1024 * 1024 });
  const [pack] = JSON.parse(stdout);
  assert.ok(pack.files.length > 0);
  const paths = pack.files.map((entry) => entry.path);
  assert.equal(paths.some((path) => path.includes(id)), false);
  assert.doesNotMatch(JSON.stringify(paths), privateMarker);
  for (const required of ["lib/harnessDeclarationDirs.mjs", "lib/harnessChildProtocol.mjs", "docs/harness-child-protocol-ja.md"]) assert.ok(paths.includes(required), required);
  for (const path of paths.filter((entry) => entry.endsWith(".harness.json"))) {
    assert.ok(path.startsWith("config/harnesses/"), path);
    assert.doesNotMatch(await readFile(join(repo, path), "utf8"), privateMarker, path);
  }
  const staged = join(scratch, "setup-plugin");
  await setup.stageManagedPluginSource(staged);
  const stagedFiles = await readdir(staged, { recursive: true, withFileTypes: true });
  for (const entry of stagedFiles) {
    assert.equal(entry.name.includes(id), false, entry.name);
    if (entry.isFile() && /\.(?:mjs|js|json|jsonl|md|txt|html)$/u.test(entry.name)) {
      const bytes = await readFile(join(entry.parentPath ?? entry.path, entry.name));
      assert.equal(bytes.includes(Buffer.from(id)), false, entry.name);
    }
  }
  for (const path of paths.filter((entry) => /\.(?:mjs|js|json|jsonl|md|txt|html)$/u.test(entry))) {
    assert.equal((await readFile(join(repo, path))).includes(Buffer.from(id)), false, path);
  }
  await access(join(staged, "docs/harness-child-protocol-ja.md"));
});
