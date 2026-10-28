// OSS の台帳（lib/ossCatalog.mjs・config/oss-catalog.json）の試験。何も取りに行かない。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OSS_REJECTED_DEPENDENCY_CODE,
  checkOssCatalog,
  findRejectedDependencies,
  loadOssCatalog,
  ossCatalogMarkdown,
  pythonRequirementNames,
  validateOssCatalog,
} from "../lib/ossCatalog.mjs";
import { runOssCatalogCli } from "../scripts/oss-catalog.mjs";

function entry(overrides = {}) {
  return {
    id: "synthetic-tool",
    name: "合成の道具",
    kind: "tool",
    area: "synthetic-area",
    license: "MIT",
    commercialUse: "yes",
    customerKit: "install-on-demand",
    status: "adopt",
    wireWhen: "合成の工程を作るとき",
    reason: "試験のための行",
    source: "https://example.invalid/LICENSE",
    ...overrides,
  };
}

function catalogOf(entries) {
  return { version: "buzzassist-oss-catalog-v1", entries };
}

test("リポジトリの台帳は形が通り、in-use の使い所が実在し、reject の物が依存に入っていない", () => {
  const catalog = loadOssCatalog();
  assert.ok(catalog.entries.length >= 30);
  const result = checkOssCatalog();
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  // 非商用の重み・AGPL・会社の規模で有償の物は、顧客に渡す仕組みに入らない側にある。
  for (const id of ["insightface-weights", "wav2lip", "rmbg", "nisqa", "trufflehog", "remotion"]) {
    const row = catalog.entries.find((item) => item.id === id);
    assert.equal(row?.status, "reject", id);
    assert.equal(row.customerKit, "never", id);
  }
});

test("形の検査: 商用不可は reject・reject と private-only は never・adopt は使い所・in-use は実在する使い所が要る", (t) => {
  assert.throws(() => validateOssCatalog(catalogOf([entry({ commercialUse: "no" })]), { rootDir: "" }), /商用で使えない物は reject/u);
  assert.throws(() => validateOssCatalog(catalogOf([entry({ status: "reject", customerKit: "bundle" })]), { rootDir: "" }), /customerKit は never/u);
  assert.throws(() => validateOssCatalog(catalogOf([entry({ status: "private-only", customerKit: "install-on-demand" })]), { rootDir: "" }), /customerKit は never/u);
  assert.throws(() => validateOssCatalog(catalogOf([entry({ wireWhen: "" })]), { rootDir: "" }), /wireWhen/u);
  assert.throws(() => validateOssCatalog(catalogOf([entry({ license: "" })]), { rootDir: "" }), /license が要る/u);
  assert.throws(() => validateOssCatalog(catalogOf([entry(), entry()]), { rootDir: "" }), /重複/u);
  const dir = mkdtempSync(path.join(tmpdir(), "oss-catalog-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "used.mjs"), "// 使い所\n");
  assert.doesNotThrow(() => validateOssCatalog(catalogOf([entry({ status: "in-use", evidence: ["used.mjs"] })]), { rootDir: dir }));
  assert.throws(() => validateOssCatalog(catalogOf([entry({ status: "in-use", evidence: ["missing.mjs"] })]), { rootDir: dir }), /evidence missing\.mjs が無い/u);
  assert.throws(() => validateOssCatalog(catalogOf([entry({ status: "in-use", evidence: ["../outside.mjs"] })]), { rootDir: dir }), /相対パス/u);
  assert.throws(() => validateOssCatalog(catalogOf([entry({ status: "in-use", evidence: [] })]), { rootDir: dir }), /evidence（使い所のファイル）が要る/u);
});

test("reject の物は package.json と Python の依存の宣言の両方で見つける（PyPI の名前の揺れもそろえる）", (t) => {
  const catalog = catalogOf([
    entry({ id: "synthetic-banned", status: "reject", customerKit: "never", commercialUse: "no", packageNames: ["Banned_Pkg", "@synthetic/banned"] }),
    entry({ id: "synthetic-ok", packageNames: ["fine-pkg"] }),
  ]);
  validateOssCatalog(catalog, { rootDir: "" });
  assert.deepEqual(pythonRequirementNames("# コメント\nbanned.pkg[extra]>=1.0 ; python_version>'3.9'\nfine-pkg==2\n-r other.txt\n"), ["banned.pkg", "fine-pkg"]);
  const hits = findRejectedDependencies(catalog, [
    { label: "package.json dependencies", names: ["@synthetic/banned", "fine-pkg"] },
    { label: "requirements.txt", names: pythonRequirementNames("banned.pkg==1\n") },
  ]);
  assert.deepEqual(hits.map((hit) => [hit.id, hit.packageName, hit.source]), [
    ["synthetic-banned", "@synthetic/banned", "package.json dependencies"],
    ["synthetic-banned", "banned.pkg", "requirements.txt"],
  ]);

  const dir = mkdtempSync(path.join(tmpdir(), "oss-catalog-deps-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const catalogPath = path.join(dir, "catalog.json");
  writeFileSync(catalogPath, JSON.stringify(catalog));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { "fine-pkg": "1" } }));
  mkdirSync(path.join(dir, "tools"));
  writeFileSync(path.join(dir, "tools", "requirements.txt"), "Banned-Pkg==3\n");
  // 依存の宣言を探さない場所（node_modules など）の中身は数えない。
  mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
  writeFileSync(path.join(dir, "node_modules", "x", "requirements.txt"), "banned_pkg\n");
  const result = checkOssCatalog({ catalogPath, rootDir: dir });
  assert.equal(result.ok, false);
  assert.equal(result.rejectedDependencies.length, 1);
  assert.match(result.problems[0], new RegExp(`^${OSS_REJECTED_DEPENDENCY_CODE}: tools/requirements\\.txt の Banned-Pkg`, "u"));

  let out = "";
  const stdout = { write: (text) => { out += text; } };
  assert.equal(runOssCatalogCli(["check"], { stdout, catalogPath, rootDir: dir }), 1);
  assert.match(out, /OSS の台帳に問題/u);
});

test("CLI: 一覧（分野・状態で絞る・Markdown の表）と知らない引数", () => {
  let out = "";
  const stdout = { write: (text) => { out += text; } };
  assert.equal(runOssCatalogCli(["list", "--status", "reject", "--json"], { stdout }), 0);
  const rows = JSON.parse(out);
  assert.ok(rows.length > 0 && rows.every((row) => row.status === "reject"));
  out = "";
  assert.equal(runOssCatalogCli(["list", "--area", "lip-sync", "--markdown"], { stdout }), 0);
  assert.match(out, /^\| 状態 \| 分野 \|/u);
  assert.match(out, /Rhubarb Lip Sync/u);
  assert.equal(ossCatalogMarkdown([entry({ reason: "縦棒|を含む" })]).includes("縦棒／を含む"), true);
  assert.throws(() => runOssCatalogCli(["list", "--bogus"], { stdout }), /知らない引数/u);
  assert.throws(() => runOssCatalogCli(["list", "--status", "maybe"], { stdout }), /--status は/u);
});
