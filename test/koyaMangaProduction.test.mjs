import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  koyaCameraModeForShot,
  koyaSpeechPronunciationsFromCharacterBible,
  planKoyaMangaProduction,
} from "../lib/koyaMangaProduction.mjs";

const script = `# 契約テスト\n\n## CUT 1: 教室\nナレーション: 放課後の教室だった。\n悠斗: 絶対に諦めない！\n\n## CUT 2: 廊下\n美咲: 本当に大丈夫？\n悠斗: ありがとう。\n`;

test("character-bible readings become deterministic STT pronunciation aliases", () => {
  assert.deepEqual(koyaSpeechPronunciationsFromCharacterBible({
    cast: [
      { name: "荒野", pronunciation: "あらの", pronunciationMap: { 荒野: "あらの" } },
      {
        name: "上沢天音",
        pronunciation: "かんざわあまね",
        pronunciationMap: { 上沢: "かんざわ", 天音: "あまね" },
      },
    ],
  }), [
    { from: "上沢天音", to: "かんざわあまね" },
    { from: "荒野", to: "あらの" },
    { from: "上沢", to: "かんざわ" },
    { from: "天音", to: "あまね" },
  ]);
});

test("wide Koya source views use a semantic pull-out instead of a fake direction", () => {
  for (let index = 0; index < 6; index += 1) {
    assert.equal(koyaCameraModeForShot("wide", index), "pullout-only");
  }
  assert.equal(koyaCameraModeForShot("left", 0), "left-only");
  assert.equal(koyaCameraModeForShot("right", 1), "right-then-pullout");
  assert.equal(koyaCameraModeForShot("top", 2), "pullout-only");
});

test("Koya production planning writes a contract snapshot and resumable state without paid calls", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-plan-"));
  await writeFile(join(projectDir, "script.txt"), script);
  await writeFile(join(projectDir, "character-bible.json"), JSON.stringify({
    version: "koya-character-bible-v1",
    episodeId: "koya-plan-test",
    cast: [{ name: "悠斗", description: "高校生から社会人まで同じ顔を保つ主人公。" }],
  }));
  const result = await planKoyaMangaProduction({
    projectDir,
    scriptPath: join(projectDir, "script.txt"),
    episodeId: "koya-plan-test",
    protagonistSpeakerId: "悠斗",
    characterBiblePath: join(projectDir, "character-bible.json"),
    contractPath: join(process.cwd(), "config/koya-manga-production-contract.json"),
  });
  assert.equal(result.episodeId, "koya-plan-test");
  assert.equal(result.state.status, "planned");
  assert.ok(result.plan.jobs.length > 0);
  const snapshot = JSON.parse(await readFile(result.paths.contractSnapshotPath, "utf8"));
  assert.equal(snapshot.contract.version, "koya-manga-production-v48");
  const state = JSON.parse(await readFile(result.paths.statePath, "utf8"));
  assert.equal(state.currentStage, "images");
  assert.equal(state.protagonistSpeakerId, result.plan.production.protagonistSpeakerId);
  assert.equal(result.plan.production.protagonistSpeakerName, "悠斗");
  assert.equal(result.plan.production.characterBibleVersion, "koya-character-bible-v1");
  assert.equal(state.characterBiblePath, join(projectDir, "character-bible.json"));
  assert.deepEqual(state.knownRemainingIssues, []);
});

test("Koya planning refuses to overwrite an episode id owned by another script", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-plan-collision-"));
  const scriptPath = join(projectDir, "script.txt");
  const options = {
    projectDir,
    scriptPath,
    episodeId: "koya-collision-test",
    protagonistSpeakerId: "悠斗",
    contractPath: join(process.cwd(), "config/koya-manga-production-contract.json"),
  };
  await writeFile(scriptPath, script);
  await planKoyaMangaProduction(options);
  await writeFile(scriptPath, `${script}\n悠斗: 別の台本です。\n`);
  await assert.rejects(() => planKoyaMangaProduction(options), /different script/u);
});

test("Koya planning stops before paid generation when a narrated multi-character story has no protagonist", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-plan-protagonist-"));
  const scriptPath = join(projectDir, "script.txt");
  await writeFile(scriptPath, script);
  await assert.rejects(() => planKoyaMangaProduction({
    projectDir,
    scriptPath,
    episodeId: "koya-protagonist-required",
    contractPath: join(process.cwd(), "config/koya-manga-production-contract.json"),
  }), /protagonist is ambiguous/u);
});
