// 漫画（koya-manga-video）の台本の関門（制作契約 v56 から）。
//   - 使う台本を人がそのまま使うと認めた（accept-human）か、台本の品質ループが合格した版でなければ、有料の処理の前に
//     人待ち（終了コード 3・awaiting-script-quality）で止まり、理由コードと両方の次のコマンドを返す
//   - v55 以前の契約（台本の関門が無かった版）は従来どおり問わずに進み、最終監査でも対象外
//   - 最終監査は、状態ファイルに残した答えが合格で、回の台本（manifest の台本の生テキスト）と同じ台本に対するものか見る
// 台本の文・人名・会話 id はすべて合成。有料 API もネットワークも使わない。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveKoyaMangaProductionContract } from "../lib/koyaMangaProductionContract.mjs";
import {
  assertKoyaScriptQualityBeforeProduction,
  inspectKoyaScriptQuality,
  koyaEpisodePaths,
  runKoyaMangaFullProduction,
} from "../lib/koyaMangaProduction.mjs";
import {
  KOYA_SCRIPT_QUALITY_FINAL_AUDIT_ID,
  KOYA_SCRIPT_QUALITY_IN_FORCE_SINCE,
  KOYA_SCRIPT_QUALITY_PAUSE_STATUS,
  KOYA_SCRIPT_QUALITY_REQUIRED_CODE,
  auditKoyaScriptQualityFinal,
  koyaScriptQualityGateInForce,
  koyaScriptTextSha256,
  validateKoyaScriptQualityGateContract,
} from "../lib/koyaScriptQualityGatePolicy.mjs";
import { planOnlyPreflight } from "../lib/videoHarnessService.mjs";
import { executeVideoHarnessAdapter } from "../lib/videoHarnessAdapters.mjs";
import { SCRIPT_QUALITY_WORK_DIR_UNBOUND_CODE } from "../lib/scriptQualityUseGate.mjs";
import { acceptScriptForTests } from "./helpers/scriptQualityAcceptance.mjs";

const root = process.cwd();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const EPISODE_ID = "manga-synthetic-script-gate";
const SCRIPT = "【カット1：合成の店先】\n合成の主人公：いらっしゃいませ。\n";
const current = await resolveKoyaMangaProductionContract({ projectDir: root });
const v55 = (() => {
  const contract = structuredClone(current.contract);
  contract.version = "koya-manga-production-v55";
  delete contract.scriptQualityGate;
  contract.requiredAudits = contract.requiredAudits.filter((id) => id !== KOYA_SCRIPT_QUALITY_FINAL_AUDIT_ID);
  return { ...current, contract };
})();

async function project(t) {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-script-gate-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const scriptDir = join(projectDir, "client-script");
  await mkdir(scriptDir, { recursive: true });
  const scriptPath = join(scriptDir, "script.txt");
  await writeFile(scriptPath, SCRIPT);
  return { projectDir, scriptDir, scriptPath, paths: koyaEpisodePaths(projectDir, EPISODE_ID) };
}

/** 事前点検（doctor）の合成の結果。full の前検査を通すだけで、この試験の対象ではない。 */
function measuredDoctorReport(projectDir) {
  const ids = ["harness-production-route", "node", "ffmpeg", "ffprobe", "ffmpeg-capability", "voice-quality-python", "tts-key", "image-key", "channel-pack"];
  const files = ["show.json", "locations.json", "thumbnail.json"].map((path, index) => ({
    role: ["show", "locations", "thumbnail"][index], path, sha256: String(index + 1).repeat(64), bytes: 2,
  }));
  const payload = { version: "koya-channel-authority-fingerprint-v1", fileCount: files.length, files };
  return {
    version: "harness-doctor-v1",
    projectDir,
    harnessId: "koya-manga-video",
    ready: true,
    blocking: [],
    checks: ids.map((id) => ({
      id,
      required: true,
      ok: true,
      ...(id === "tts-key" ? { kind: "voice.dialogue", provider: "elevenlabs", model: "eleven_v3", adapterVersion: "elevenlabs-dialogue-server-v1", status: "ready" } : {}),
      ...(id === "image-key" ? { host: "codex", model: "gpt-image-2-codex" } : {}),
      ...(id === "channel-pack" ? { authorityFingerprint: { ...payload, sha256: sha256(JSON.stringify(payload)) } } : {}),
    })),
  };
}

async function readState(paths) {
  try {
    return JSON.parse(await readFile(paths.statePath, "utf8"));
  } catch {
    return null;
  }
}

test("契約: v56 から台本の関門の節と最終監査が要り、節は受け入れ方を減らせない。v55 以前は効力の外", () => {
  assert.equal(current.contract.version, KOYA_SCRIPT_QUALITY_IN_FORCE_SINCE);
  assert.equal(koyaScriptQualityGateInForce(current), true);
  assert.equal(koyaScriptQualityGateInForce(v55), false);
  assert.equal(koyaScriptQualityGateInForce({ version: "" }), false, "版の無い合成の契約は効力の外");
  assert.deepEqual(validateKoyaScriptQualityGateContract(current.contract), []);
  assert.deepEqual(validateKoyaScriptQualityGateContract(v55.contract), []);
  assert.ok(current.contract.requiredAudits.includes(KOYA_SCRIPT_QUALITY_FINAL_AUDIT_ID));

  const dropped = structuredClone(current.contract);
  delete dropped.scriptQualityGate;
  assert.ok(validateKoyaScriptQualityGateContract(dropped).some((failure) => failure.path === "scriptQualityGate"), "節を消してゲートを外せない");
  const noAudit = structuredClone(current.contract);
  noAudit.requiredAudits = noAudit.requiredAudits.filter((id) => id !== KOYA_SCRIPT_QUALITY_FINAL_AUDIT_ID);
  assert.ok(validateKoyaScriptQualityGateContract(noAudit).some((failure) => failure.path === "requiredAudits"));
  const loopOnly = structuredClone(current.contract);
  loopOnly.scriptQualityGate.acceptedBy = ["quality-loop"];
  assert.ok(validateKoyaScriptQualityGateContract(loopOnly).some((failure) => failure.path === "scriptQualityGate.acceptedBy"), "依頼者の台本を人が受け入れる口を外せない");
  const earlySection = structuredClone(v55.contract);
  earlySection.scriptQualityGate = structuredClone(current.contract.scriptQualityGate);
  assert.ok(validateKoyaScriptQualityGateContract(earlySection).some((failure) => failure.path === "scriptQualityGate.inForceSince"));

  assert.equal(current.contract.scriptQualityGate.genre, "manga");
});

test("宣言: 保証 script-quality-accepted は v56 から、最終監査の id を証拠にする", async () => {
  const declaration = JSON.parse(await readFile(join(root, "config", "harnesses", "koya-manga-video.harness.json"), "utf8"));
  const guarantee = declaration.guarantees.find((entry) => entry.id === "script-quality-accepted");
  assert.deepEqual([guarantee?.inForceSince, guarantee?.evidenceAuditIds], [KOYA_SCRIPT_QUALITY_IN_FORCE_SINCE, [KOYA_SCRIPT_QUALITY_FINAL_AUDIT_ID]]);
  assert.ok(String(guarantee.human || "").length > 10, "人が何を決めるかを書く");
  assert.ok(declaration.requiresFromOperator.some((entry) => entry.id === "script-quality-acceptance"));
});

test("台本を受け入れていなければ有料の前に止まり、答えを状態ファイルに残す。依頼者の台本を accept-human すれば通る", async (t) => {
  const fixture = await project(t);
  const options = { projectDir: fixture.projectDir, episodeId: EPISODE_ID, scriptPath: fixture.scriptPath };
  await assert.rejects(
    assertKoyaScriptQualityBeforeProduction(options, { resolvedContract: current }),
    (error) => {
      assert.equal(error.code, KOYA_SCRIPT_QUALITY_REQUIRED_CODE);
      assert.equal(error.reasonCode, "script-quality-loop-not-started");
      assert.deepEqual(error.issues, ["script-quality-required:script-quality-loop-not-started"]);
      const next = error.next.join("\n");
      assert.match(next, /accept-human --work-dir .* --script script\.txt .*--human-verified/u, "依頼者の台本をそのまま使う口");
      assert.match(next, /start --work-dir .* --genre manga/u, "直しを提案する口");
      return true;
    },
  );
  const blocked = await readState(fixture.paths);
  assert.equal(blocked.scriptQuality.pass, false);
  assert.equal(blocked.scriptQuality.reasonCode, "script-quality-loop-not-started");
  assert.equal(blocked.scriptQuality.contractVersion, KOYA_SCRIPT_QUALITY_IN_FORCE_SINCE);

  await acceptScriptForTests(fixture.scriptPath);
  const passed = await assertKoyaScriptQualityBeforeProduction(options, { resolvedContract: current });
  assert.equal(passed.pass, true);
  assert.equal(passed.acceptedBy, "human");
  const state = await readState(fixture.paths);
  assert.equal(state.scriptQuality.pass, true);
  assert.equal(state.scriptQuality.reasonCode, "script-quality-human-accepted");
  assert.equal(state.scriptQuality.scriptSha256, sha256(SCRIPT));
  assert.equal(state.scriptQuality.scriptTextSha256, koyaScriptTextSha256(SCRIPT));
  const recorded = JSON.stringify(state.scriptQuality);
  for (const forbidden of ["synthetic-operator", "合成の試験の台本", fixture.scriptDir]) assert.equal(recorded.includes(forbidden), false, forbidden);

  // 最終監査: 同じ台本なら合格、回の台本が違えば落ちる。
  const final = auditKoyaScriptQualityFinal({ contract: current.contract, state, scriptTextSha256: koyaScriptTextSha256(SCRIPT) });
  assert.equal(final.pass, true, final.detail);
  assert.equal(final.applicable, true);
  const other = auditKoyaScriptQualityFinal({ contract: current.contract, state, scriptTextSha256: koyaScriptTextSha256(`${SCRIPT}追加の行。\n`) });
  assert.deepEqual(other.failures, ["script-quality-script-sha-mismatch"]);
  assert.deepEqual(auditKoyaScriptQualityFinal({ contract: current.contract, state: blocked, scriptTextSha256: koyaScriptTextSha256(SCRIPT) }).failures, ["script-quality-not-accepted:script-quality-loop-not-started"]);
  assert.deepEqual(auditKoyaScriptQualityFinal({ contract: current.contract, state: {}, scriptTextSha256: koyaScriptTextSha256(SCRIPT) }).failures, ["script-quality-record-missing"]);
  const forged = { scriptQuality: { ...state.scriptQuality, acceptedBy: "quality-loop" } };
  assert.ok(auditKoyaScriptQualityFinal({ contract: current.contract, state: forged, scriptTextSha256: koyaScriptTextSha256(SCRIPT) }).failures.includes("script-quality-acceptance-inconsistent"));
});

test("台本が変わった（受け入れた版と違うバイト列）なら、同じ作業フォルダでも止まる", async (t) => {
  const fixture = await project(t);
  await acceptScriptForTests(fixture.scriptPath);
  await writeFile(fixture.scriptPath, `${SCRIPT}合成の主人公：追加の台詞。\n`);
  const inspected = await inspectKoyaScriptQuality({ projectDir: fixture.projectDir, episodeId: EPISODE_ID, scriptPath: fixture.scriptPath }, { resolvedContract: current });
  assert.equal(inspected.pass, false);
  assert.equal(inspected.reasonCode, "script-quality-loop-not-started", "人の受け入れは SHA ごと。変えた台本は受け入れていない");
});

test("古い契約（v55）は台本の答えを問わずに進み、状態ファイルも書かない。最終監査でも対象外", async (t) => {
  const fixture = await project(t);
  const result = await assertKoyaScriptQualityBeforeProduction(
    { projectDir: fixture.projectDir, episodeId: EPISODE_ID, scriptPath: fixture.scriptPath },
    { resolvedContract: v55 },
  );
  assert.equal(result.applicable, false);
  assert.equal(result.pass, true);
  assert.equal(await readState(fixture.paths), null);
  const final = auditKoyaScriptQualityFinal({ contract: v55.contract, state: null, scriptTextSha256: koyaScriptTextSha256(SCRIPT) });
  assert.deepEqual([final.pass, final.applicable], [true, false]);
});

test("上位 Job から呼ばれたときは、渡された作業フォルダが Job の options と同じでなければ止まる", async (t) => {
  const fixture = await project(t);
  await acceptScriptForTests(fixture.scriptPath);
  const jobPath = join(fixture.projectDir, "job.json");
  await writeFile(jobPath, JSON.stringify({ options: { scriptQualityWorkDir: fixture.scriptDir } }));
  const base = { projectDir: fixture.projectDir, episodeId: EPISODE_ID, scriptPath: fixture.scriptPath, upstreamJobPath: jobPath };
  assert.equal((await assertKoyaScriptQualityBeforeProduction({ ...base, scriptQualityWorkDir: fixture.scriptDir }, { resolvedContract: current })).pass, true);
  await assert.rejects(
    assertKoyaScriptQualityBeforeProduction({ ...base, scriptQualityWorkDir: join(fixture.projectDir, "other") }, { resolvedContract: current }),
    (error) => error.code === SCRIPT_QUALITY_WORK_DIR_UNBOUND_CODE,
  );
});

test("full は台本の関門で止まったとき Job を失敗にせず終了コード3で待ち、有料の画に進まない。上位 Job は人待ちで次のコマンドを持つ", async (t) => {
  const fixture = await project(t);
  let imageCalls = 0;
  const runtime = {
    allowDirectMeasuredDoctorForTests: true,
    runDoctor: async () => measuredDoctorReport(fixture.projectDir),
    // 事前点検（doctor）はこの試験の対象外。台本の関門だけを本物で通す。
    checkScriptQuality: (options, context) => assertKoyaScriptQualityBeforeProduction(options, { ...context, resolvedContract: current }),
    checkVoiceSelectionsBeforeImages: async () => ({ pass: true }),
    checkWardrobeReadinessBeforeImages: async () => ({ status: "pass" }),
    generateImages: async () => {
      imageCalls += 1;
      return { episodeId: EPISODE_ID, waiting: true, failed: false, state: { status: "images-paused", knownRemainingIssues: [] } };
    },
  };
  const options = { projectDir: fixture.projectDir, episodeId: EPISODE_ID, scriptPath: fixture.scriptPath };
  const result = await runKoyaMangaFullProduction(options, runtime);
  assert.equal(result.exitCode, 3);
  assert.equal(result.payload.status, KOYA_SCRIPT_QUALITY_PAUSE_STATUS);
  assert.deepEqual(result.payload.knownRemainingIssues, ["script-quality-required:script-quality-loop-not-started"]);
  assert.match(result.payload.next, /accept-human/u);
  assert.equal(imageCalls, 0, "台本を受け入れるまで有料の画に進まない");

  const outcome = await executeVideoHarnessAdapter({
    job: {
      id: "video-koya-manga-video-5c1a7e0000000001",
      harness: { id: "koya-manga-video" },
      projectDir: fixture.projectDir,
      script: { path: fixture.scriptPath },
      options: {
        episodeId: EPISODE_ID,
        protagonistSpeakerId: "synthetic-lead",
        characterBiblePath: join(fixture.projectDir, "character-bible.json"),
        storyReviewPath: join(fixture.projectDir, "story-review.json"),
        scriptQualityWorkDir: fixture.scriptDir,
      },
      stages: [],
    },
    runChild: async (_command, args) => {
      assert.ok(args.includes("--script-quality-work-dir") && args[args.indexOf("--script-quality-work-dir") + 1] === fixture.scriptDir, "Job の作業フォルダを子へ渡す");
      return { code: result.exitCode, signal: null, stdout: `${JSON.stringify(result.payload, null, 2)}\n`, stderr: "" };
    },
  });
  assert.equal(outcome.status, "awaiting-human-review");
  assert.deepEqual(outcome.knownRemainingIssues, ["script-quality-required:script-quality-loop-not-started"]);
  assert.match(outcome.result.next, /accept-human/u);

  await acceptScriptForTests(fixture.scriptPath);
  const resumed = await runKoyaMangaFullProduction(options, runtime);
  assert.equal(imageCalls, 1, "受け入れた後は同じ入力で画の工程へ進む");
  assert.equal(resumed.exitCode, 3);
});

test("plan-only の漫画の Job も、同じ理由コードと次のコマンドを preflight に出す（v55 の Job では問わない）", async (t) => {
  const fixture = await project(t);
  const job = (contractVersion) => ({
    harness: { id: "koya-manga-video" },
    canonicalIdentity: { productionContract: { contractVersion } },
    options: { scriptQualityWorkDir: fixture.scriptDir },
  });
  const blocked = await planOnlyPreflight({ job: job(KOYA_SCRIPT_QUALITY_IN_FORCE_SINCE), scriptPath: fixture.scriptPath });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.blockers, ["script-quality-required:script-quality-loop-not-started"]);
  assert.equal(blocked.paidCallsAttempted, false);
  assert.match(blocked.scriptQuality.next.join("\n"), /accept-human --work-dir .* --script script\.txt/u);
  assert.equal(await planOnlyPreflight({ job: job("koya-manga-production-v55"), scriptPath: fixture.scriptPath }), null);
  await acceptScriptForTests(fixture.scriptPath);
  const accepted = await planOnlyPreflight({ job: job(KOYA_SCRIPT_QUALITY_IN_FORCE_SINCE), scriptPath: fixture.scriptPath });
  assert.deepEqual([accepted.ok, accepted.blockers, accepted.scriptQuality.acceptedBy], [true, [], "human"]);
});
