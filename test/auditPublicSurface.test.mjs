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

test("表示名だけでなく、ID の名簿と開発機の絶対パスも検出する", async () => {
  // ここが最大の見落としだった。検査は表示名しか集めておらず、
  // **11人分の castId が並んだ一覧と開発機の絶対パスが公開されたまま
  // 「検出なし」と報告していた**。私はその出力を根拠に「公開面0件」と
  // 報告した——検査が嘘をつくと、それを信じた報告も嘘になる。
  const { collectSensitiveSignals } = await import("../scripts/audit-public-surface.mjs");
  const { castIds } = collectSensitiveSignals(root);
  if (castIds.length === 0) return;   // pack が無い環境

  const report = auditPublicSurface();
  assert.ok(Array.isArray(report.rosterFindings), "名簿の検査があること");
  assert.ok(Array.isArray(report.pathLeakFindings), "絶対パスの検査があること");
  assert.equal(report.castIdCount, castIds.length);

  // 開発機の絶対パスは1件も残っていないこと。
  assert.deepEqual(
    report.pathLeakFindings.map((f) => f.file), [],
    "追跡下に開発機の絶対パスが残っている",
  );

  // 検出できることを実際に確かめる。内部の整合だけを見ると、検出を
  // 丸ごと止めても「整合している」で通る——最初に書いた版がそれで、
  // 名簿検査を無効化する変異を捕まえられなかった。
  //
  // 名簿は現時点で既知の未解決（castId が識別子として共有層に残っている。
  // 全面改名は破壊的変更なので判断待ち）。ここでは**検出できている**ことを
  // 固定する。改名が済んだら 0 になるので、そのときはこの期待値を更新する。
  assert.ok(
    report.rosterFindings.length > 0,
    "castId の名簿を検出できていない（検出器が壊れている）",
  );
  assert.ok(
    report.rosterFindings.some((finding) => finding.idCount === castIds.length),
    "全 ID が並んだファイルを検出できていない",
  );
  // clean は4種すべてを見ていること（片方だけ見て clean と言わない）。
  assert.equal(report.clean, false, "未解決の名簿があるのに clean と言わないこと");

  // 名簿の報告に ID そのものが出ないこと。
  const serialized = JSON.stringify(report);
  for (const id of castIds) {
    const bare = new RegExp(`"${id}"`, "u");
    assert.equal(bare.test(serialized), false, "検査の出力に castId が含まれている");
  }
});

test("開発機の絶対パスを、数として正しく数える", async () => {
  // 検査本体は追跡下のファイルしか見ないので、現に0件のときは検出を
  // 丸ごと止めても結果が変わらない。判定そのものを直接見る。
  const { countHomePathHits } = await import("../scripts/audit-public-surface.mjs");
  const home = "/Users/example";
  assert.equal(countHomePathHits(`cwd: ${home}/proj`, home), 1);
  assert.equal(countHomePathHits(`${home}/a と ${home}/b`, home), 2);
  assert.equal(countHomePathHits("相対パスだけ", home), 0);
  assert.equal(countHomePathHits("~/proj と書けば消える", home), 0);
  // 正規表現のメタ文字を含むホームでも壊れない。
  assert.equal(countHomePathHits("/Users/a+b/x", "/Users/a+b"), 1);
  assert.equal(countHomePathHits("何か", ""), 0, "homeRoot が空なら0");
});

test("共有層の学習台帳に、チャンネル固有語を書けない", async () => {
  // 自己改善ループが書く docs/learning/proposals.jsonl は公開リポジトリで
  // 追跡されている。**宛先が共有層でも evidence にキャスト名が入りうる**——
  // 実際そうなり、ジャンル層の提案の根拠に固定キャスト3人の名前が入って
  // commit されていた。宛先の層と、書かれる中身の層は別物。
  const { channelTermsInSharedEntry } = await import("../scripts/harness-learn.mjs");
  const { collectSensitiveSignals } = await import("../scripts/audit-public-surface.mjs");
  const signals = collectSensitiveSignals(root);
  if (signals.terms.length === 0) return;   // pack が無い環境

  const term = signals.terms[0];

  // 共有層宛に固有語 → 拒否
  const rejected = channelTermsInSharedEntry(
    { target: "genre:manga-video-production", text: "一般的な話", evidence: `実測: ${term} の参照が0枚` },
    signals,
  );
  assert.equal(rejected.ok, false, "共有層の根拠に固有語が入るのを通してはいけない");
  assert.equal(rejected.message.includes(term), false, "拒否メッセージに固有語を出さない");
  assert.match(rejected.message, /channel-pack:/u, "どう直すかを示すこと");

  // チャンネル宛なら通る（pack 側へ書かれる想定）
  assert.equal(
    channelTermsInSharedEntry({ target: "channel-pack:koya", evidence: term }, signals).ok, true,
  );
  // 共有層でも固有語が無ければ通る
  assert.equal(
    channelTermsInSharedEntry({ target: "platform:platform-craft", text: "課金の再送規則", evidence: "4実装で規則が違った" }, signals).ok,
    true,
  );
});

test("追跡下の学習台帳に、チャンネル宛の提案が溜まっていない", async () => {
  // 3層分離は台帳にも効く。channel-pack: / ledger: / doc: 宛の提案は
  // 運営者のフィードバックを逐語で持つので、公開側に置かない。
  const { readFileSync, existsSync } = await import("node:fs");
  for (const rel of ["docs/learning/proposals.jsonl", "docs/learning/applied.jsonl"]) {
    const file = join(root, rel);
    if (!existsSync(file)) continue;
    const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const scoped = rows.filter((r) => /^(channel-pack:|ledger:|doc:)/u.test(String(r.target || "")));
    assert.deepEqual(
      scoped.map((r) => r.target), [],
      `${rel} にチャンネル宛の提案が残っている（Channel Pack 側へ置くこと）`,
    );
  }
});
