import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { auditPublicSurface, collectSensitiveTerms } from "../scripts/audit-public-surface.mjs";
import { channelPackPresent } from "../lib/channelPackResolver.mjs";

const root = new URL("..", import.meta.url).pathname;

test("公開面に、チャンネル固有語も禁止パスも無い", () => {
  const report = auditPublicSurface();
  assert.deepEqual(report.pathFindings, [], "配布してはいけないパスが追跡下にある");
  assert.deepEqual(
    report.termFindings.map((f) => f.file), [],
    "チャンネル固有語が追跡下のファイルにある（語そのものはここに出さない）",
  );
});

test("検査の出力に、検出した語そのものが出ない", () => {
  // 検査の出力自体が漏洩経路になっては本末転倒。件数とファイルと行番号だけ。
  const report = auditPublicSurface();
  const serialized = JSON.stringify(report);
  for (const term of collectSensitiveTerms(root)) {
    assert.equal(serialized.includes(term), false, "検査の出力に固有語が含まれている");
  }
  for (const finding of report.termFindings) {
    assert.deepEqual(Object.keys(finding).sort(), ["file", "hits", "lines"], "検出内容を持ち出していない");
  }
});

test("語が引けないことを「問題なし」と報告しない", (t) => {
  if (!channelPackPresent(root)) {
    t.skip("channel pack が無い環境");
    return;
  }
  const report = auditPublicSurface();
  assert.equal(report.termSourceAvailable, true);
  assert.ok(report.termCount > 0, "pack から語を引けていること");

  // pack を持たない環境では、照合できなかったことが結果に出ること。
  const bare = auditPublicSurface({ projectDir: "/nonexistent-project-for-audit-test" });
  assert.equal(bare.termSourceAvailable, false, "語が引けないことが結果に出ること");
});

test("禁止語の一覧を公開リポジトリに平文で持たない", () => {
  // 禁止語をソースへ直書きすると、それ自体が名簿になる。
  const source = readFileSync(join(root, "scripts/audit-public-surface.mjs"), "utf8");
  for (const term of collectSensitiveTerms(root)) {
    assert.equal(source.includes(term), false, "検査スクリプト自身に固有語が書かれている");
  }
});

test("npm pack に、追跡外・チャンネル固有のものが入らない", () => {
  // package.json の files は .gitignore を見ない。gitignore しただけでは
  // 守れず、実際に運営者の配置マップと122.6kBの要求台帳が tarball に
  // 入っていた。リリースワークフローもこの pack を使う。
  // npm notice は stderr に出る。stdout だけを見ると以降の assert が
  // 何も検証しない——それは前回直した。だが status も見ていなかったので、
  // **npm pack 自体が失敗しても通る**状態が残っていた。
  // 「出力が取れた」を「中身を確かめた」と取り違えないよう、JSON で受けて
  // 件数まで突き合わせる。
  const { execFileSync, spawnSync } = require("node:child_process");
  const run = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
  assert.equal(run.error, undefined, `npm pack を起動できていない: ${run.error?.message || ""}`);
  assert.equal(run.status, 0, `npm pack が失敗した（exit ${run.status}）: ${String(run.stderr || "").slice(0, 300)}`);

  let manifest;
  try {
    manifest = JSON.parse(run.stdout)[0];
  } catch (error) {
    assert.fail(`npm pack --json の出力を解析できない: ${String(error?.message || error)}`);
  }
  const packed = (manifest.files || []).map((entry) => entry.path);
  assert.ok(packed.length > 0, "tarball のファイル一覧が空（空配列への反復は何も検査しない）");
  assert.equal(packed.length, manifest.entryCount, "解析件数が npm の報告と一致しないこと");
  assert.ok(packed.includes("package.json"), "必須ファイルが一覧に無い（一覧の取り違え）");
  const listed = packed.join("\n");

  for (const forbidden of [
    "config/harness-deployments.json",
    "koya-channel-requirements-ledger",
    "koya-channel-governance-ja",
    "koya-show-bible.json",
    "koya-location-bible.json",
    "koya-thumbnail-contract.json",
    "channel-packs/",
    "client-work/",
    ".reference.md",
    ".codex-tmp/",
  ]) {
    assert.equal(listed.includes(forbidden), false, `npm pack に含まれています: ${forbidden}`);
  }

  // git が追跡していないファイルが（ビルド成果物を除いて）入っていないこと。
  const tracked = new Set(
    execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean),
  );
  const untracked = packed.filter((file) =>
    !tracked.has(file) && !file.startsWith("dist/") && !file.startsWith("dist-widget/") && file !== "package.json");
  assert.deepEqual(untracked, [], `追跡外のファイルが npm pack に入っています: ${untracked.join(", ")}`);
});
