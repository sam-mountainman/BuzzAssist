import assert from "node:assert/strict";
import fsSync from "node:fs";
import test from "node:test";

import {
  acquireCrossProcessLock,
  defaultConcurrency,
  executePlan,
  expandPlanJobs,
  normalizeLockKey,
  planDigest,
  releaseCrossProcessLock,
  resolveConcurrency,
  validatePlan,
} from "../scripts/harness-parallel-run.mjs";

const trueJob = (id, extra = {}) => ({ id, command: "true", ...extra });

test("並列数はCPU数から決まり、上限で頭打ちになる", () => {
  assert.equal(defaultConcurrency(8), 6);
  assert.equal(defaultConcurrency(2), 1);
  assert.equal(defaultConcurrency(1), 1);
  // 多コア機でもCLIジョブを無制限には並べない（内側に子プロセスがいるため）
  assert.equal(defaultConcurrency(64), 8);
});

test("--concurrency は明示値を優先し、不正値は拒否する", () => {
  assert.equal(resolveConcurrency("3"), 3);
  assert.equal(resolveConcurrency("auto", 8), 6);
  assert.equal(resolveConcurrency(null, 8), 6);
  assert.throws(() => resolveConcurrency("0"), /1 以上/u);
  assert.throws(() => resolveConcurrency("-2"), /1 以上/u);
  assert.throws(() => resolveConcurrency("abc"), /1 以上/u);
});

test("壊れた計画は実行前に全て指摘する", () => {
  assert.deepEqual(validatePlan({ jobs: [trueJob("a")] }), []);

  const duplicated = validatePlan({ jobs: [trueJob("a"), trueJob("a")] });
  assert.ok(duplicated.some((e) => /重複/u.test(e)));

  const missingDep = validatePlan({ jobs: [trueJob("a", { needs: ["nope"] })] });
  assert.ok(missingDep.some((e) => /存在しないジョブ/u.test(e)));

  const cycle = validatePlan({
    jobs: [trueJob("a", { needs: ["b"] }), trueJob("b", { needs: ["a"] })],
  });
  assert.ok(cycle.some((e) => /循環/u.test(e)));

  const noCommand = validatePlan({ jobs: [{ id: "a" }] });
  assert.ok(noCommand.some((e) => /command/u.test(e)));

  assert.ok(validatePlan({ jobs: [] }).length > 0);
  assert.ok(validatePlan(null).length > 0);
});

test("自己参照でない菱形の依存は循環と誤判定しない", () => {
  const diamond = validatePlan({
    jobs: [
      trueJob("root"),
      trueJob("left", { needs: ["root"] }),
      trueJob("right", { needs: ["root"] }),
      trueJob("join", { needs: ["left", "right"] }),
    ],
  });
  assert.deepEqual(diamond, []);
});

test("計画ダイジェストはキー順に依存しない", () => {
  const a = { planId: "p", jobs: [{ id: "x", command: "true" }] };
  const b = { jobs: [{ command: "true", id: "x" }], planId: "p" };
  assert.equal(planDigest(a), planDigest(b));
  assert.notEqual(planDigest(a), planDigest({ ...a, planId: "q" }));
});

test("独立したジョブは同時に走る", async () => {
  const plan = {
    planId: "parallel",
    jobs: ["a", "b", "c"].map((id) => ({ id, command: "sleep", args: ["1"] })),
  };
  const summary = await executePlan(plan, {
    concurrency: 3,
    logDir: `/tmp/harness-parallel-test-${process.pid}-parallel`,
  });
  assert.equal(summary.counts.passed, 3);
  assert.ok(summary.ok);
  // 逐次なら3秒。同時に走っていれば2秒未満で終わる。
  assert.ok(summary.totalDurationMs < 2000, `並列になっていない: ${summary.totalDurationMs}ms`);
});

test("同じロックを宣言したジョブは重ならない", async () => {
  const plan = {
    planId: "locks",
    jobs: [
      { id: "w1", command: "sleep", args: ["1"], locks: ["state.json"] },
      { id: "w2", command: "sleep", args: ["1"], locks: ["state.json"] },
    ],
  };
  const summary = await executePlan(plan, {
    concurrency: 4,
    logDir: `/tmp/harness-parallel-test-${process.pid}-locks`,
  });
  assert.equal(summary.counts.passed, 2);
  // 排他が効いていれば直列になり、2秒以上かかる。
  assert.ok(summary.totalDurationMs >= 1900, `排他が効いていない: ${summary.totalDurationMs}ms`);
});

test("ロックが違えば同時に走る", async () => {
  const plan = {
    planId: "distinct-locks",
    jobs: [
      { id: "w1", command: "sleep", args: ["1"], locks: ["a.json"] },
      { id: "w2", command: "sleep", args: ["1"], locks: ["b.json"] },
    ],
  };
  const summary = await executePlan(plan, {
    concurrency: 4,
    logDir: `/tmp/harness-parallel-test-${process.pid}-distinct`,
  });
  // 総時間から並列性を推測すると、負荷が乗ったときに崩れる——重なって
  // いても遅ければ直列に見えるので、CPU が埋まっているだけで落ちる。
  // 落ちるテストは失敗を無視する習慣を作るので、**実際に重なったか**を
  // 直接見る。
  const [w1, w2] = ["w1", "w2"].map((id) => summary.jobs.find((job) => job.id === id));
  assert.ok(w1 && w2, "両方のジョブが記録されていること");
  const overlapMs = Math.min(w1.endedAtMs, w2.endedAtMs) - Math.max(w1.startedAtMs, w2.startedAtMs);
  assert.ok(
    overlapMs > 500,
    `ロックが違うのに重なって走っていない（重なり ${overlapMs}ms）: `
    + `w1 ${w1.startedAtMs}-${w1.endedAtMs} / w2 ${w2.startedAtMs}-${w2.endedAtMs}`,
  );
});

test("依存が失敗したジョブは走らせずスキップし、全体を失敗にする", async () => {
  const plan = {
    planId: "fail-closed",
    jobs: [
      { id: "boom", command: "sh", args: ["-c", "exit 3"] },
      { id: "after", command: "true", needs: ["boom"] },
      { id: "far", command: "true", needs: ["after"] },
      { id: "unrelated", command: "true" },
    ],
  };
  const summary = await executePlan(plan, {
    concurrency: 4,
    logDir: `/tmp/harness-parallel-test-${process.pid}-failclosed`,
  });
  const byId = new Map(summary.jobs.map((j) => [j.id, j]));
  assert.equal(byId.get("boom").status, "failed");
  assert.equal(byId.get("boom").exitCode, 3);
  // 失敗の下流は連鎖的にスキップされる。1段目だけでは足りない。
  assert.equal(byId.get("after").status, "skipped");
  assert.equal(byId.get("far").status, "skipped");
  // 依存していないジョブは巻き添えにしない。
  assert.equal(byId.get("unrelated").status, "passed");
  assert.equal(summary.ok, false);
  assert.equal(summary.counts.skipped, 2);
});

test("expectExitCode を指定すれば非0終了も成功として扱える", async () => {
  const plan = {
    planId: "expected-exit",
    jobs: [{ id: "gate", command: "sh", args: ["-c", "exit 3"], expectExitCode: 3 }],
  };
  const summary = await executePlan(plan, {
    concurrency: 1,
    logDir: `/tmp/harness-parallel-test-${process.pid}-expected`,
  });
  assert.equal(summary.jobs[0].status, "passed");
  assert.ok(summary.ok);
});

test("タイムアウトしたジョブは失敗として記録される", async () => {
  const plan = {
    planId: "timeout",
    jobs: [{ id: "slow", command: "sleep", args: ["30"], timeoutMs: 300 }],
  };
  const summary = await executePlan(plan, {
    concurrency: 1,
    logDir: `/tmp/harness-parallel-test-${process.pid}-timeout`,
  });
  assert.equal(summary.jobs[0].status, "failed");
  assert.equal(summary.jobs[0].timedOut, true);
  assert.equal(summary.ok, false);
});

test("dry-run は何も実行せず順序だけ確認する", async () => {
  const plan = {
    planId: "dry",
    jobs: [
      { id: "a", command: "sh", args: ["-c", "echo 実行されてはいけない > /tmp/harness-dryrun-canary"] },
      { id: "b", command: "true", needs: ["a"] },
    ],
  };
  const summary = await executePlan(plan, { concurrency: 2, dryRun: true });
  assert.equal(summary.counts.dryRun, 2);
  assert.ok(summary.ok);
  assert.equal(summary.logDir, null);
});

test("レポートには再現に必要な証跡が入る", async () => {
  const plan = { planId: "evidence", jobs: [trueJob("a")] };
  const summary = await executePlan(plan, {
    concurrency: 1,
    logDir: `/tmp/harness-parallel-test-${process.pid}-evidence`,
  });
  assert.equal(summary.planDigest, planDigest(plan));
  assert.equal(summary.planId, "evidence");
  assert.ok(Number.isInteger(summary.cpuCount) && summary.cpuCount > 0);
  assert.ok(summary.jobs[0].stdoutPath.endsWith("a.stdout.log"));
  assert.ok(summary.jobs[0].command.length > 0);
});

test("expand は対象ごとにジョブを起こす", () => {
  const plan = expandPlanJobs({
    planId: "cast",
    expand: [{
      over: ["horo", "tatsu"],
      id: "gate-{item}",
      title: "{item} 属性ゲート",
      command: "node",
      args: ["scripts/x.mjs", "--inventory-path", "canvas/{item}.json"],
    }],
  });
  assert.equal(plan.jobs.length, 2);
  assert.equal(plan.jobs[0].id, "gate-horo");
  assert.equal(plan.jobs[0].title, "horo 属性ゲート");
  assert.deepEqual(plan.jobs[1].args, ["scripts/x.mjs", "--inventory-path", "canvas/tatsu.json"]);
  // over 自体は展開後の計画に残さない
  assert.equal(plan.jobs[0].over, undefined);
  assert.equal(plan.expand, undefined);
});

test("expand はオブジェクト要素の任意フィールドを差し込める", () => {
  const plan = expandPlanJobs({
    expand: [{
      over: [{ item: "horo", ep: "ep01" }],
      id: "{item}-{ep}",
      command: "true",
      locks: ["canvas/manga-videos/{ep}/episode-manifest.json"],
    }],
  });
  assert.equal(plan.jobs[0].id, "horo-ep01");
  assert.deepEqual(plan.jobs[0].locks, ["canvas/manga-videos/ep01/episode-manifest.json"]);
});

test("expand と手書きジョブは共存でき、依存も張れる", () => {
  const plan = expandPlanJobs({
    jobs: [{ id: "setup", command: "true" }],
    expand: [{ over: ["a", "b"], id: "j-{item}", command: "true", needs: ["setup"] }],
  });
  assert.deepEqual(plan.jobs.map((j) => j.id), ["setup", "j-a", "j-b"]);
  assert.deepEqual(validatePlan(plan), []);
});

test("expand で差し込み先の無い変数はその場で落とす", () => {
  assert.throws(
    () => expandPlanJobs({ expand: [{ over: ["a"], id: "{nope}", command: "true" }] }),
    /\{nope\}/u,
  );
  assert.throws(
    () => expandPlanJobs({ expand: [{ over: "not-an-array", id: "x", command: "true" }] }),
    /配列/u,
  );
});

test("expand で id が衝突すれば検証で落ちる", () => {
  const plan = expandPlanJobs({
    jobs: [{ id: "gate-horo", command: "true" }],
    expand: [{ over: ["horo"], id: "gate-{item}", command: "true" }],
  });
  assert.ok(validatePlan(plan).some((e) => /重複/u.test(e)));
});

// --- Codexレビュー(2026-08-28)で指摘された経路の回帰テスト ---

test("同じファイルを指す別表記のロックは同じ鍵に畳む", () => {
  const base = "/repo";
  assert.equal(normalizeLockKey("state.json", base), normalizeLockKey("./state.json", base));
  assert.equal(normalizeLockKey("a/../state.json", base), normalizeLockKey("state.json", base));
  assert.equal(normalizeLockKey("/repo/state.json", base), normalizeLockKey("./state.json", base));
  // 別のファイルは別の鍵のまま
  assert.notEqual(normalizeLockKey("state.json", base), normalizeLockKey("statejson", base));
  // baseDir が違えば別の鍵（別リポジトリの同名ファイルを混同しない）
  assert.notEqual(normalizeLockKey("state.json", "/repo"), normalizeLockKey("state.json", "/other"));
});

test("別表記で同じファイルを宣言したジョブは重ならない", async () => {
  const plan = {
    planId: "lock-alias",
    defaults: { cwd: "/tmp" },
    jobs: [
      { id: "w1", command: "sleep", args: ["1"], locks: ["state.json"] },
      { id: "w2", command: "sleep", args: ["1"], locks: ["./state.json"] },
    ],
  };
  const summary = await executePlan(plan, {
    concurrency: 4,
    logDir: `/tmp/harness-parallel-test-${process.pid}-alias`,
  });
  assert.equal(summary.counts.passed, 2);
  assert.ok(summary.totalDurationMs >= 1900, `別表記が同じロックに畳まれていない: ${summary.totalDurationMs}ms`);
});

test("ログのファイル名にできない id は実行前に落とす", () => {
  for (const bad of ["../escape", "a/b", ".hidden", "with space", "-leading"]) {
    const errors = validatePlan({ jobs: [{ id: bad, command: "true" }] });
    assert.ok(errors.some((e) => /id に使えるのは/u.test(e)), `${bad} が通ってしまった`);
  }
  assert.deepEqual(validatePlan({ jobs: [{ id: "gate-horo_1.v2", command: "true" }] }), []);
});

test("型の壊れたフィールドは実行前に落とす", () => {
  const bad = validatePlan({
    jobs: [
      { id: "a", command: "true", timeoutMs: "600000" },
      { id: "b", command: "true", timeoutMs: -1 },
      { id: "c", command: "true", expectExitCode: 1.5 },
      { id: "d", command: "true", env: ["X=1"] },
      { id: "e", command: "true", cwd: 123 },
    ],
  });
  for (const pattern of [/timeoutMs は正の有限数/u, /expectExitCode は整数/u, /env はオブジェクト/u, /cwd は文字列/u]) {
    assert.ok(bad.some((e) => pattern.test(e)), `${pattern} が検出されていない`);
  }
});

test("spawnできないジョブも計画を落とさず1件の失敗として記録する", async () => {
  const plan = {
    planId: "spawn-failure",
    jobs: [
      { id: "broken", command: "true", cwd: "/nonexistent-directory-for-test" },
      { id: "after", command: "true", needs: ["broken"] },
      { id: "unrelated", command: "true" },
    ],
  };
  // 例外で計画全体が落ちないこと自体が検証対象。
  const summary = await executePlan(plan, {
    concurrency: 3,
    logDir: `/tmp/harness-parallel-test-${process.pid}-spawnfail`,
  });
  const byId = new Map(summary.jobs.map((j) => [j.id, j]));
  assert.equal(byId.get("broken").status, "failed");
  assert.equal(byId.get("after").status, "skipped");
  assert.equal(byId.get("unrelated").status, "passed");
  assert.equal(summary.ok, false);
});

test("タイムアウトしたジョブは孫プロセスごと止める", async () => {
  // sh が sleep を産む。子だけを殺すと sleep が生き残る。
  const marker = `/tmp/harness-orphan-${process.pid}`;
  const plan = {
    planId: "orphan",
    jobs: [{
      id: "spawner",
      command: "sh",
      args: ["-c", `sleep 20 && touch ${marker}`],
      timeoutMs: 500,
    }],
  };
  const summary = await executePlan(plan, {
    concurrency: 1,
    logDir: `/tmp/harness-parallel-test-${process.pid}-orphan`,
  });
  assert.equal(summary.jobs[0].status, "failed");
  assert.equal(summary.jobs[0].timedOut, true);
  // 孫が生きていれば20秒後にマーカーを作る。ここで待って確認する。
  await new Promise((resolve) => { setTimeout(resolve, 22_000); });
  assert.equal(fsSync.existsSync(marker), false, "孫プロセスが生き残ってファイルを作った");
});

test("expand は継承プロパティやオブジェクト値を差し込ませない", () => {
  assert.throws(
    () => expandPlanJobs({ expand: [{ over: ["a"], id: "{constructor}", command: "true" }] }),
    /\{constructor\}/u,
  );
  assert.throws(
    () => expandPlanJobs({ expand: [{ over: ["a"], id: "{toString}", command: "true" }] }),
    /\{toString\}/u,
  );
  assert.throws(
    () => expandPlanJobs({ expand: [{ over: [{ item: "a", nested: { x: 1 } }], id: "{nested}", command: "true" }] }),
    /文字列・数値・真偽値だけ/u,
  );
  // 数値と真偽値は許す
  const ok = expandPlanJobs({ expand: [{ over: [{ item: "a", n: 3 }], id: "{item}{n}", command: "true" }] });
  assert.equal(ok.jobs[0].id, "a3");
});

test("レポートは引数の境界と依存・ロックを構造のまま残す", async () => {
  const plan = {
    planId: "evidence2",
    jobs: [{
      id: "j", command: "sh", args: ["-c", "echo 'a b'"],
      locks: ["x.json"], timeoutMs: 60_000, env: { FOO: "1" },
    }],
  };
  const summary = await executePlan(plan, {
    concurrency: 1,
    logDir: `/tmp/harness-parallel-test-${process.pid}-evidence2`,
  });
  const job = summary.jobs[0];
  assert.deepEqual(job.argv, ["sh", "-c", "echo 'a b'"]);
  assert.deepEqual(job.locks, ["x.json"]);
  assert.deepEqual(job.envKeys, ["FOO"]);
  assert.equal(job.timeoutMs, 60_000);
  assert.equal(job.expectExitCode, 0);
});

test("品質ゲートの不合格を expectExitCode で成功に付け替えられない", () => {
  const gate = validatePlan({
    jobs: [{
      id: "g", command: "node",
      args: ["scripts/koya-manga-video.mjs", "character-attribute-gate", "--inventory-path", "x.json"],
      expectExitCode: 3,
    }],
  });
  assert.ok(gate.some((e) => /品質ゲートに expectExitCode/u.test(e)));

  // ゲート以外のコマンドでは従来どおり使える（grep の 1 など）
  assert.deepEqual(
    validatePlan({ jobs: [{ id: "g", command: "grep", args: ["-q", "x", "f"], expectExitCode: 1 }] }),
    [],
  );
  // ゲートでも 0 は当然通る
  assert.deepEqual(
    validatePlan({ jobs: [{ id: "g", command: "node", args: ["audit-x.mjs"], expectExitCode: 0 }] }),
    [],
  );
});

test("別プロセスのランナーとも排他される", async () => {
  // プロセス内の Set だけでは、Claude Code と Codex がそれぞれランナーを
  // 起動したときに同じ共有台帳を同時更新できてしまう。
  const key = `test-ledger-${process.pid}.json`;
  const first = acquireCrossProcessLock(key);
  assert.ok(first, "1本目がロックを取れない");
  // 取得直後（pid を書いた後）に2本目が奪えないこと
  assert.equal(acquireCrossProcessLock(key), null, "生きているロックを奪ってしまった");
  releaseCrossProcessLock(first);
  // 解放後は取れる
  const second = acquireCrossProcessLock(key);
  assert.ok(second, "解放後に取れない");
  releaseCrossProcessLock(second);
});

test("別の鍵どうしは互いを妨げない", () => {
  const a = acquireCrossProcessLock(`a-${process.pid}`);
  const b = acquireCrossProcessLock(`b-${process.pid}`);
  assert.ok(a && b, "無関係な鍵が衝突した");
  releaseCrossProcessLock(a);
  releaseCrossProcessLock(b);
});

test("生きている持ち主のロックは、どれだけ古くても奪わない", async () => {
  // 以前は「30分以上古ければ持ち主が生きていても奪う」だった。本編の
  // レンダーや30セグメントの音声生成は平気で30分を超えるので、
  // **走っている最中に別のランナーが同じ台帳へ書ける**。
  // 時間で判断してはいけない——見るべきは持ち主が生きているかどうか。
  const { acquireCrossProcessLock, releaseCrossProcessLock } =
    await import("../scripts/harness-parallel-run.mjs");
  const { utimesSync } = await import("node:fs");
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  const key = `path:/tmp/lock-liveness-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  const handle = acquireCrossProcessLock(key);
  assert.ok(handle && handle.dir, "1本目が取れること");
  assert.ok(handle.token, "所有トークンが付くこと");

  // 2時間前に取ったことにする。持ち主（このプロセス）は生きている。
  const old = new Date(Date.now() - 2 * 60 * 60_000);
  utimesSync(handle.dir, old, old);
  writeFileSync(join(handle.dir, "heartbeat"), `${Date.now()}\n`);   // 心拍は今

  assert.equal(
    acquireCrossProcessLock(key), null,
    "生きている持ち主のロックを、古いという理由だけで奪ってはいけない",
  );

  // 心拍も止まり、PID も死んでいれば奪える（＝落ちたランナーの残骸）。
  writeFileSync(join(handle.dir, "pid"), "999999\n");
  const staleBeat = new Date(Date.now() - 10 * 60_000);
  utimesSync(join(handle.dir, "heartbeat"), staleBeat, staleBeat);
  const taken = acquireCrossProcessLock(key);
  assert.ok(taken, "死んだ持ち主のロックは引き継げること");
  releaseCrossProcessLock(taken);
});

test("自分のものでないロックは解放できない", async () => {
  // 解放が無条件削除だったので、奪われた側が後から解放して、
  // 奪った側のロックを外していた。
  const { acquireCrossProcessLock, releaseCrossProcessLock } =
    await import("../scripts/harness-parallel-run.mjs");
  const key = `path:/tmp/lock-token-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  const mine = acquireCrossProcessLock(key);
  assert.ok(mine);

  const impostor = { dir: mine.dir, token: "someone-else", timer: null };
  assert.equal(releaseCrossProcessLock(impostor), false, "別のトークンでは外せないこと");
  assert.equal(acquireCrossProcessLock(key), null, "まだ持たれていること");

  assert.equal(releaseCrossProcessLock(mine), true, "自分のものは外せること");
  const next = acquireCrossProcessLock(key);
  assert.ok(next, "外れた後は取れること");
  releaseCrossProcessLock(next);
});
