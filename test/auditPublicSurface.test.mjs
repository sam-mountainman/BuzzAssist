import assert from "node:assert/strict";
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
