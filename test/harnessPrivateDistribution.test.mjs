import assert from "node:assert/strict";
import { execFile as callback } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { npmInvocation } from "../scripts/audit-package-tarball.mjs";

const execFile = promisify(callback);
const repo = fileURLToPath(new URL("../", import.meta.url));
const privateMarker = /buzzassist-private|"layer"\s*:\s*"private"/iu;

test("公開宣言・files allowlist・npm pack の実際の配布一覧に非公開層を入れない", { timeout: 120000 }, async () => {
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
  const cache = await mkdtemp(join(tmpdir(), "harness-pack-audit-"));
  // prepack の build / lock 書き換えを起動しない。配布されるファイルの選択は npm 本体で照合する。
  const command = npmInvocation(["pack", "--dry-run", "--json", "--ignore-scripts", "--cache", cache]);
  const { stdout } = await execFile(command.command, command.args, { cwd: repo, shell: command.shell, timeout: 90000, maxBuffer: 16 * 1024 * 1024 });
  const [pack] = JSON.parse(stdout);
  assert.ok(pack.files.length > 0);
  const paths = pack.files.map((entry) => entry.path);
  assert.doesNotMatch(JSON.stringify(paths), privateMarker);
  for (const required of ["lib/harnessDeclarationDirs.mjs", "lib/harnessChildProtocol.mjs", "docs/harness-child-protocol-ja.md"]) assert.ok(paths.includes(required), required);
  for (const path of paths.filter((entry) => entry.endsWith(".harness.json"))) {
    assert.ok(path.startsWith("config/harnesses/"), path);
    assert.doesNotMatch(await readFile(join(repo, path), "utf8"), privateMarker, path);
  }
});
