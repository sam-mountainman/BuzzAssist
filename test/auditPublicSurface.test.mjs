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

test("検出器は、実 pack が無い環境でも動くことを合成 pack で確かめる", async (t) => {
  // ここが最大の見落としだった。検査は表示名しか集めておらず、11人分の
  // castId が並んだ一覧と開発機の絶対パスが公開されたまま「検出なし」と
  // 報告していた。私はその出力を根拠に「公開面0件」と報告した。
  //
  // その修正の検証も穴だった。実 pack が無ければ `return` で抜けていたので、
  // **CI と新しい運営者のクローンでは、この検査は何も assert せずに緑**に
  // なる。しかも `t.skip()` ですらないので run-tests.mjs の skip 集計にも
  // 出ない——「走らなかった」ことが誰にも見えない。
  // 前提を待つのではなく、前提を自分で作る。
  const { collectSensitiveSignals } = await import("../scripts/audit-public-surface.mjs");
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const projectDir = await mkdtemp(join(tmpdir(), "public-surface-probe-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const packConfig = join(projectDir, "channel-packs", "probe", "config");
  await mkdir(packConfig, { recursive: true });
  await writeFile(join(packConfig, "koya-show-bible.json"), JSON.stringify({
    channel: { name: "架空チャンネル", town: "架空町" },
    cast: [
      { id: "probe-alpha", name: "架空アルファ", aliases: ["アルファ君"] },
      { id: "probe-bravo", name: "架空ブラボー" },
      { id: "probe-charlie", name: "架空チャーリー" },
    ],
    locations: [{ name: "架空広場" }],
  }));

  const signals = collectSensitiveSignals(projectDir);
  assert.ok(signals.terms.includes("架空アルファ"), "表示名を集めること");
  assert.ok(signals.terms.includes("アルファ君"), "別名も集めること");
  assert.ok(signals.terms.includes("架空広場"), "地名も集めること");
  assert.ok(signals.terms.includes("架空チャンネル"), "チャンネル名も集めること");
  assert.deepEqual(
    [...signals.castIds].sort(), ["probe-alpha", "probe-bravo", "probe-charlie"],
    "ID も別立てで集めること（表示名だけを見ていたのが元の穴）",
  );
});

test("いま公開面に残っている未解決は、理由つきで一覧に載っているものだけ", async () => {
  // 以前ここは「未解決が存在すること」を assert していた。つまり
  // **実際に直すとテストが落ちる**——漏れが仕様として固定されていた。
  // しかも CLI は恒常的に exit 2 で、CI にも pre-commit にも載らなかった。
  //
  // 許容一覧に変えると両方が解ける。一覧に無い検出が出れば落ち（新しい漏れが
  // 止まる）、一覧にあるのに検出されなくなっても落ちる（直したら消せと言う）。
  const report = auditPublicSurface();
  const u = report.unresolved;
  assert.deepEqual(u.term.map((f) => f.file), [], "チャンネル固有語は1件も許容しない");
  assert.deepEqual(u.path.map((f) => f.file), [], "配布してはいけないパスは1件も許容しない");
  assert.deepEqual(u.pathLeak.map((f) => f.file), [], "開発機の絶対パスは1件も許容しない");
  assert.deepEqual(
    u.roster.map((f) => f.file), [],
    "一覧に無い名簿の検出がある。直すか、理由を config/public-surface-allowlist.json へ",
  );
  assert.deepEqual(
    report.staleAllowlist.map((e) => e.file), [],
    "もう検出されないものが一覧に残っている。直ったなら一覧から消すこと",
  );
  assert.equal(report.gateOk, true, "ゲートとして使える状態であること");

  // 許容した未解決には、必ず理由が書かれていること。
  for (const finding of report.accepted.roster) {
    assert.ok(finding.why && finding.why.length > 20, `${finding.file}: 理由が書かれていない`);
  }

  // 報告に ID そのものが出ないこと（検査の出力自体が名簿になっては本末転倒）。
  // 実 pack があるときだけ、ID が伏字になっているかを確かめられる。
  // 無い環境では確かめる対象そのものが存在しない。
  const { collectSensitiveSignals } = await import("../scripts/audit-public-surface.mjs");
  const { castIds } = collectSensitiveSignals(root);
  const serialized = JSON.stringify(report);
  for (const id of castIds) {
    assert.equal(new RegExp(`"${id}"`, "u").test(serialized), false,
      "検査の出力に castId が含まれている");
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

  // 平坦化された形。エージェントのセッションディレクトリ名は
  // /Users/x/Documents/y → -Users-x-Documents-y になり、ログや監査記録を
  // そのまま貼ると公開面へ入る。実際 docs/ の監査記録に1件残っていて、
  // スラッシュ形しか見ていなかった検査は「絶対パス 0件」と報告していた。
  assert.equal(countHomePathHits("~/.claude/projects/-Users-example/x.jsonl", "/Users/example"), 1,
    "平坦化された形も数えること");
  assert.equal(countHomePathHits("-Users-example-Documents-Proj", "/Users/example"), 1);
  // 両方の形が混ざっていれば両方数える。
  assert.equal(countHomePathHits("/Users/example/a と -Users-example-b", "/Users/example"), 2);
  // 短すぎるホームで誤検出しないこと。
  assert.equal(countHomePathHits("無関係な文字列", "/a"), 0, "4文字未満の形は使わない");
});

test("別端末由来のmacOS/Linux/Windows絶対pathも検出する", async () => {
  const { countMachineLocalPathHits } = await import("../scripts/audit-public-surface.mjs");
  const mac = ["", "Users", "private-builder", "work"].join("/");
  const linux = ["", "home", "private-operator", "project"].join("/");
  const windows = ["D:", "Users", "private-editor", "project"].join("\\");
  const windowsForward = ["D:", "Users", "private-editor", "project"].join("/");
  const unc = ["", "", "private-nas", "editor-share", "project"].join("\\");
  assert.equal(countMachineLocalPathHits(mac, "/unrelated/home"), 1);
  assert.equal(countMachineLocalPathHits(linux, "/unrelated/home"), 1);
  assert.equal(countMachineLocalPathHits(windows, "/unrelated/home"), 1);
  assert.equal(countMachineLocalPathHits(windowsForward, "/unrelated/home"), 1);
  assert.equal(countMachineLocalPathHits(unc, "/unrelated/home"), 1);
  assert.equal(
    countMachineLocalPathHits(`${mac} and ${linux} and ${windows} and ${windowsForward} and ${unc}`, "/unrelated/home"),
    5,
  );
  // 公開test fixtureの慣用placeholderは個人情報として扱わない。
  assert.equal(countMachineLocalPathHits(["", "Users", "example", "project"].join("/"), "/unrelated/home"), 0);
});

test("共有層の学習台帳に、チャンネル固有語を書けない", async () => {
  // 自己改善ループが書く docs/learning/proposals.jsonl は公開リポジトリで
  // 追跡されている。**宛先が共有層でも evidence にキャスト名が入りうる**——
  // 実際そうなり、ジャンル層の提案の根拠に固定キャスト3人の名前が入って
  // commit されていた。宛先の層と、書かれる中身の層は別物。
  const { channelTermsInSharedEntry } = await import("../scripts/harness-learn.mjs");
  const { collectSensitiveSignals } = await import("../scripts/audit-public-surface.mjs");
  // 実 pack を待たない。待つと、pack を持たない環境（CI・新しい運営者の
  // クローン）ではこの検査が丸ごと消える。
  const signals = { terms: ["架空アルファ", "架空広場"], castIds: ["probe-alpha"] };
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

test("検査の範囲に、まだ追跡されていないファイルも入る", async (t) => {
  // 追跡下だけを見ていたので、未追跡のファイルは検査に写らなかった。
  // 実話数の character-bible が未追跡のまま置かれていて、検査は
  // 「語 0件・検出なし」と報告し、その直後の `git add -A` で
  // 実キャストの表示名が公開リポジトリへ入った。
  // **検査が clean と言った後に漏れた**——「見ていない」を「無い」として
  // 報告する型そのもの。
  const { filesInScope } = await import("../scripts/audit-public-surface.mjs");
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = new URL("..", import.meta.url).pathname;
  const probeDir = join(root, ".audit-scope-probe");

  mkdirSync(probeDir, { recursive: true });
  try {
    writeFileSync(join(probeDir, "x.txt"), "probe");
    const scope = filesInScope();
    assert.ok(
      scope.some((file) => file.startsWith(".audit-scope-probe/")),
      "git add -A が拾うファイルは、検査にも写ること",
    );
    // staged だけを見る呼び方では写らない（そちらは差分の検査なので正しい）。
    assert.equal(
      filesInScope({ stagedOnly: true }).some((file) => file.startsWith(".audit-scope-probe/")),
      false,
      "--staged は index の差分だけを見ること",
    );
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
});

/** 検査を端から端まで通すための、使い捨ての git リポジトリ。 */
const scratchDirs = new Set();

async function scratchRepo() {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "public-surface-e2e-"));
  scratchDirs.add(dir);
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  const write = async (rel, text) => {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  };
  await mkdir(join(dir, "channel-packs", "probe", "config"), { recursive: true });
  await writeFile(join(dir, "channel-packs", "probe", "config", "koya-show-bible.json"), JSON.stringify({
    channel: { name: "架空チャンネル" },
    cast: [
      { id: "probe-alpha", name: "架空アルファ" },
      { id: "probe-bravo", name: "架空ブラボー" },
      { id: "probe-charlie", name: "架空チャーリー" },
      { id: "probe-delta", name: "架空デルタ" },
    ],
  }));
  await writeFile(join(dir, ".gitignore"), "channel-packs/\n");
  return { dir, git, write };
}

test.after(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all([...scratchDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  scratchDirs.clear();
});

test("検出器を、実物のリポジトリで端から端まで通す", async () => {
  // ここまでのテストは exported helper の戻り値しか見ていなかったので、
  // 件数束縛・未検査の記録・staged の読み口・pack 不在の扱いを外す変異が
  // **4つとも素通りした**。helper が正しいことと、検査が働くことは別物。
  const { dir, git, write } = await scratchRepo();

  await write("roster.md", "probe-alpha probe-bravo probe-charlie を並べた一覧");
  await write("clean.md", "何も入っていない");
  git("add", "-A");

  const report = auditPublicSurface({ projectDir: dir });
  assert.equal(report.termSourceAvailable, true, "合成 pack から語を引けること");
  assert.deepEqual(report.rosterFindings.map((f) => f.file), ["roster.md"], "名簿を検出すること");
  assert.equal(report.rosterFindings[0].idCount, 3);
  assert.equal(report.status, "failed", "一覧に無い検出があるので failed");
  assert.equal(report.gateOk, false);
  // 検出した ID そのものは出さない。
  assert.equal(JSON.stringify(report).includes("probe-alpha"), false);
});

test("許容一覧は件数に束縛され、同じファイルで漏れが増えたら落ちる", async () => {
  // ファイル名だけで一致を見ていたので、3個の ID を理由に許したファイルへ
  // 残りを足しても新しい漏洩として出てこなかった。
  const { dir, git, write } = await scratchRepo();
  await write("roster.md", "probe-alpha probe-bravo probe-charlie");
  await write("config/public-surface-allowlist.json", JSON.stringify({
    roster: [{ file: "roster.md", count: 3, why: "承知している既知の未解決（理由は十分な長さで書く）" }],
  }));
  git("add", "-A");

  const accepted = auditPublicSurface({ projectDir: dir });
  assert.equal(accepted.status, "accepted-risk", "件数どおりなら通ること");
  assert.equal(accepted.accepted.roster[0].current, 3);

  // 同じファイルで1人増やす。
  await write("roster.md", "probe-alpha probe-bravo probe-charlie probe-delta");
  git("add", "-A");
  const grown = auditPublicSurface({ projectDir: dir });
  assert.equal(grown.status, "failed", "許容した件数から増えたら落ちること");
  assert.match(grown.unresolved.roster[0].whyUnresolved, /3 件から 4 件へ増えている/u);

  // count を書いていない一覧は、承知した件数が無いので通さない。
  await write("config/public-surface-allowlist.json", JSON.stringify({
    roster: [{ file: "roster.md", why: "件数を書いていない" }],
  }));
  git("add", "-A");
  assert.equal(auditPublicSurface({ projectDir: dir }).status, "failed", "count 無しを通さないこと");
});

test("中身を見られなかったファイルを、黙って合格にしない", async () => {
  // 4MiB超・読取失敗・巨大な単一行を continue で捨てていた。捨てたことは
  // どこにも出ず gateOk にも反映されなかった——「検出できない＝免除」。
  const { dir, git, write } = await scratchRepo();
  await write("huge.txt", "x".repeat(33 * 1024 * 1024));
  git("add", "-A");

  const report = auditPublicSurface({ projectDir: dir });
  assert.deepEqual(report.scanIncomplete.map((e) => e.file), ["huge.txt"], "飛ばしたことを記録すること");
  assert.equal(report.status, "incomplete", "未検査があるなら合格と呼ばないこと");
  assert.equal(report.clean, false, "見ていないものを clean に数えないこと");
  assert.ok(report.unchecked.some((why) => /未検査|読み取り/u.test(why)), "何を見ていないかを述べること");
});

test("--staged は、作業ツリーではなく index の中身を読む", async () => {
  // 名前だけ index から取って中身を作業ツリーから読んでいたので、秘密入りの
  // 版を stage した後に作業ツリーだけ直すと、検査は直った方を読み、
  // commit には秘密入りの版が入った。
  const { dir, git, write } = await scratchRepo();
  await write("leak.md", "probe-alpha probe-bravo probe-charlie");
  git("add", "-A");
  // 作業ツリーだけ直す。index には漏洩版が残っている。
  await write("leak.md", "何も入っていない");

  const staged = auditPublicSurface({ projectDir: dir, stagedOnly: true });
  assert.deepEqual(
    staged.rosterFindings.map((f) => f.file), ["leak.md"],
    "index に残っている漏洩を検出すること（作業ツリーを読んではいけない）",
  );
});

test("Channel Pack が無い環境で、許容一覧を「直った」と誤読しない", async () => {
  // pack を持たない環境（CI・新しい運営者のクローン）では検出が0件になる
  // ので、許容一覧の全件が stale＝直ったと判定され、ゲートが必ず落ちた。
  // 同時に検査本体は「検出なし」で exit 0 を返していた——落ちる理由と
  // 通す理由が食い違っていた。見ていない区分は、合格でも不合格でもない。
  const { dir, git, write } = await scratchRepo();
  const { rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await write("roster.md", "probe-alpha probe-bravo probe-charlie");
  await write("config/public-surface-allowlist.json", JSON.stringify({
    roster: [{ file: "roster.md", count: 3, why: "承知している既知の未解決（理由は十分な長さで書く）" }],
  }));
  git("add", "-A");
  await rm(join(dir, "channel-packs"), { recursive: true, force: true });

  const report = auditPublicSurface({ projectDir: dir });
  assert.equal(report.termSourceAvailable, false);
  assert.deepEqual(report.staleAllowlist, [], "検査源が無い区分の一覧を stale にしないこと");
  assert.equal(report.status, "incomplete", "見ていないことを合格とも不合格とも呼ばない");
  assert.equal(report.gateOk, true, "pack を持たない CI を永久に赤にしない");
  assert.ok(report.unchecked.some((why) => /Channel Pack/u.test(why)), "何を見ていないかを述べること");
});

test("push 前の検査は作業ツリーではなく、push される全コミットを見る", async () => {
  // pre-push フックは作業ツリーを検査していた。push されるのはコミットなので、
  // 作業ツリーが clean な状態で漏洩入りのブランチを push すると素通りした。
  // 実際、作業ツリーを丸ごと保存したブランチ5本が、番組設定の写し・全キャストの
  // 名簿・開発機のパスをコミットとして抱えていた。
  const { auditPushRefs } = await import("../scripts/audit-public-surface.mjs");
  const { dir, git, write } = await scratchRepo();
  await write("clean.md", "何も入っていない");
  git("add", "-A"); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").toString().trim();

  // 途中のコミットで漏洩を入れ、次のコミットで消す。先端は clean。
  await write("roster.md", "probe-alpha probe-bravo probe-charlie");
  git("add", "-A"); git("commit", "-qm", "leak");
  await write("roster.md", "消した");
  git("add", "-A"); git("commit", "-qm", "remove");
  const tip = git("rev-parse", "HEAD").toString().trim();

  // 作業ツリーは clean。作業ツリーだけを見る検査なら通ってしまう。
  assert.equal(auditPublicSurface({ projectDir: dir }).rosterFindings.length, 0, "前提: 作業ツリーは clean");

  const range = auditPushRefs([`refs/heads/main ${tip} refs/heads/main ${base}`], { projectDir: dir });
  assert.equal(range.commitCount, 2, "base より後の2コミットを両方見ること");
  assert.equal(range.failed.length, 1, "途中で入れて消した漏洩も、履歴として push されるので止めること");
  assert.equal(range.failed[0].report.rosterFindings[0].file, "roster.md");

  // 削除の push は検査対象が無い。
  const zero = "0".repeat(40);
  assert.equal(auditPushRefs([`(delete) ${zero} refs/heads/x ${tip}`], { projectDir: dir }).commitCount, 0);
});

test("語彙が後から増えると、過去に clean だったコミットも止まる", async () => {
  // コミットした時点では pack に無かった地名が後から登録され、16日前に
  // clean と確認したコミットが、push する時点では漏洩になっていた。
  // 検査は push の瞬間に、現在の語彙で行う。
  const { auditPushRefs } = await import("../scripts/audit-public-surface.mjs");
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { dir, git, write } = await scratchRepo();
  await write("clean.md", "何も入っていない");
  git("add", "-A"); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").toString().trim();
  await write("story.md", "架空港町の小さな催事場で");
  git("add", "-A"); git("commit", "-qm", "story");
  const tip = git("rev-parse", "HEAD").toString().trim();
  const line = [`refs/heads/main ${tip} refs/heads/main ${base}`];

  assert.equal(auditPushRefs(line, { projectDir: dir }).failed.length, 0, "登録前は通る");

  // pack に地名を登録する（コミットは変えていない）。
  await writeFile(join(dir, "channel-packs", "probe", "config", "koya-location-bible.json"),
    JSON.stringify({ locations: [{ name: "架空港町" }] }));
  assert.equal(auditPushRefs(line, { projectDir: dir }).failed.length, 1, "登録後は同じコミットを止めること");
});

test("push 範囲の検査は、そのコミットが持ち込んだファイルだけを見る", async () => {
  // 作業ツリーのファイル一覧を使って各コミットを読む形にすると、2つ壊れる。
  // (1) 後のコミットで git rm された漏洩ファイルは一覧に無いので見落とす。
  // (2) 既に公開済みの過去の問題を毎回拾い、無関係な push まで永久に止める。
  const { auditPushRefs } = await import("../scripts/audit-public-surface.mjs");

  // (1) 入れて、次のコミットで git rm する。
  {
    const { dir, git, write } = await scratchRepo();
    await write("clean.md", "何も入っていない");
    git("add", "-A"); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD").toString().trim();
    await write("leak.md", "probe-alpha probe-bravo probe-charlie");
    git("add", "-A"); git("commit", "-qm", "leak");
    git("rm", "-q", "leak.md"); git("commit", "-qm", "rm");
    const tip = git("rev-parse", "HEAD").toString().trim();
    const range = auditPushRefs([`refs/heads/main ${tip} refs/heads/main ${base}`], { projectDir: dir });
    assert.equal(range.failed.length, 1, "削除済みでも、履歴に入った漏洩は止めること");
  }

  // (2) 既に remote にある過去の問題は、今回の push の責任ではない。
  {
    const { dir, git, write } = await scratchRepo();
    await write("old.md", "probe-alpha probe-bravo probe-charlie");
    git("add", "-A"); git("commit", "-qm", "already public");
    const remote = git("rev-parse", "HEAD").toString().trim();
    await write("new.md", "無関係な変更");
    git("add", "-A"); git("commit", "-qm", "unrelated");
    const tip = git("rev-parse", "HEAD").toString().trim();
    const range = auditPushRefs([`refs/heads/main ${tip} refs/heads/main ${remote}`], { projectDir: dir });
    assert.equal(range.commitCount, 1);
    assert.equal(range.failed.length, 0, "今回持ち込んでいない過去の問題で push を止めないこと");
  }
});
