import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GENRE_CANONICAL_ENTRYPOINTS, assertCanonicalRouting, checkCanonicalRouting } from "../lib/harnessRouting.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("Channel Pack 設置済みの環境では、ガバナンスを迂回する旧入口が塞がれる", async () => {
  // 旧入口は同じ MP4 を出せてしまう。出せるからこそ、エージェントが
  // そちらを選んだ瞬間に番組ルール・配役ゲート・サインオフが全部消え、
  // 監査記録のない成果物が「完成」として出てくる。
  const packed = await mkdtemp(join(tmpdir(), "harness-packed-"));
  await mkdir(join(packed, "channel-packs", "koya"), { recursive: true });

  for (const legacy of GENRE_CANONICAL_ENTRYPOINTS["manga-video"].legacyEntrypoints) {
    const verdict = checkCanonicalRouting({ toolName: legacy, projectDir: packed });
    assert.equal(verdict.allowed, false, `${legacy} は塞がれること`);
    assert.match(verdict.message, /run_koya_manga_pipeline/u, "正規入口の名前をエラーに含めること");
    assert.match(verdict.message, /番組ルール/u, "何を迂回することになるのかを述べること");
    assert.throws(() => assertCanonicalRouting({ toolName: legacy, projectDir: packed }), /移行ベンチマーク専用/u);
  }

  // 正規入口は当然通る。
  assert.equal(checkCanonicalRouting({ toolName: "run_koya_manga_pipeline", projectDir: packed }).allowed, true);

  // ベンチマーク移行だけは、そう明言したときに通す。
  const acknowledged = checkCanonicalRouting({
    toolName: "build_excalidraw_manga_video",
    projectDir: packed,
    acknowledgedBenchmarkMigration: true,
  });
  assert.equal(acknowledged.allowed, true);
  assert.equal(acknowledged.benchmarkMigration, true, "迂回したことが戻り値に残ること");

  await rm(packed, { recursive: true, force: true });
});

test("Channel Pack が無い環境でも旧入口は塞がる", async () => {
  // 当初は pack が無ければ素通りさせていたが、それは間違いだった。
  // 旧入口が迂回するのは番組ルール（channel 層）だけでなく、最終監査・
  // カメラ文法・サインオフというジャンル層のゲート全部。しかも新しい
  // 運営者の初期状態は「pack 無し」で、最も危険な時間帯だけ迂回路が
  // 開いていた。CLAUDE.md も旧入口を条件なしでベンチマーク専用と定めている。
  const bare = await mkdtemp(join(tmpdir(), "harness-bare-"));
  const verdict = checkCanonicalRouting({ toolName: "build_excalidraw_manga_video", projectDir: bare });
  assert.equal(verdict.allowed, false, "pack が無くても塞がること");
  assert.match(verdict.message, /run_koya_manga_pipeline/u);

  // 正規入口は当然通る。
  assert.equal(checkCanonicalRouting({ toolName: "run_koya_manga_pipeline", projectDir: bare }).allowed, true);
  await rm(bare, { recursive: true, force: true });
});

test("このリポジトリ自身では旧入口が塞がれている", async (t) => {
  // 実 pack が置かれた環境で、旧入口が本当に止まることの確認。
  // pack を持たない clone では前提が無いので飛ばす——合成の sandbox で
  // 同じことは上の2件が見ている。
  const { channelPackPresent } = await import("../lib/channelPackResolver.mjs");
  if (!channelPackPresent(root)) {
    t.skip("channel pack が無い環境");
    return;
  }
  const verdict = checkCanonicalRouting({ toolName: "build_excalidraw_manga_video", projectDir: root });
  assert.equal(verdict.allowed, false);
});

test("ハーネス宣言の produces.kind は全部、正規入口の表に載っている", async () => {
  // 2026-09-24 の監査で、narrated-story-video だけ表に無く、未知ジャンル扱いで
  // 旧入口のガードが素通りになっていた。宣言を足したのに表を忘れる、を
  // 宣言側から数えて落とす。
  const { readdir, readFile } = await import("node:fs/promises");
  const dir = join(root, "config", "harnesses");
  const files = (await readdir(dir)).filter((name) => name.endsWith(".harness.json"));
  assert.ok(files.length >= 2, "宣言が読めていること");
  for (const file of files) {
    const declaration = JSON.parse(await readFile(join(dir, file), "utf8"));
    const kind = declaration?.produces?.kind;
    const canonical = GENRE_CANONICAL_ENTRYPOINTS[kind];
    assert.ok(canonical, `${file} の produces.kind=${kind} が表に無い`);
    assert.equal(
      String(declaration.entrypoint || "").trim(),
      canonical.cli.trim(),
      `${file} の entrypoint が表の正規 CLI と違う`,
    );
    assert.ok(Array.isArray(canonical.legacyEntrypoints), `${kind} の legacyEntrypoints が配列であること`);
  }
});

test("表に無いジャンルは通さない", () => {
  const verdict = checkCanonicalRouting({ genre: "unregistered-genre", toolName: "anything" });
  assert.equal(verdict.allowed, false, "未登録のジャンルは規則なしで素通りさせない");
  assert.match(verdict.message, /GENRE_CANONICAL_ENTRYPOINTS/u, "どこへ登録すればよいかを言うこと");
  assert.throws(() => assertCanonicalRouting({ genre: "unregistered-genre", toolName: "anything" }), /登録されていない/u);
});

test("ナレーション物語の正規入口は通る", () => {
  const verdict = checkCanonicalRouting({ genre: "narrated-story-video", toolName: "run_video_harness" });
  assert.equal(verdict.allowed, true);
});

test("Koya の公式経路の対象のプロジェクトでは、ゲートを迂回する汎用の人物登録・画像の道具を公式の action へ案内して止める", async () => {
  // 汎用の approve_character_candidate / register_character_identity は finalizeApprovedCharacter を直接呼び、
  // 汎用の画像スクリプトは本編の画の台帳を公式経路と同じ置き場へ書く。どちらも契約 v54 の
  // 途中の成果物の品質ループを通らないので、Koya の Channel Pack の下では使わせない。
  const governed = await mkdtemp(join(tmpdir(), "harness-governed-"));
  await mkdir(join(governed, "channel-packs", "synthetic-pack", "config"), { recursive: true });
  await writeFile(join(governed, "channel-packs", "synthetic-pack", "config", "koya-show-bible.json"), "{}\n");
  const { governedProjectPresent } = await import("../lib/harnessRouting.mjs");
  assert.equal(governedProjectPresent({ projectDir: governed }), true);

  for (const [toolName, action] of [
    ["approve_character_candidate", "character-approve"],
    ["register_character_identity", "character-register"],
    ["scripts/generate-manga-script-images.mjs", "images"],
  ]) {
    const verdict = checkCanonicalRouting({ toolName, projectDir: governed });
    assert.equal(verdict.allowed, false, `${toolName} は止まること`);
    assert.equal(verdict.canonicalAction, action);
    assert.match(verdict.message, /run_koya_manga_pipeline/u);
    assert.match(verdict.message, new RegExp(`"${action}"`, "u"));
    assert.match(verdict.message, /品質ループ/u, "何を迂回することになるのかを述べること");
    assert.throws(() => assertCanonicalRouting({ toolName, projectDir: governed }), /公式経路の対象/u);
  }
  // 人物の登録はベンチマーク移行でも通さない。画像スクリプトだけ、旧入口と同じく明言したときに通す。
  assert.equal(checkCanonicalRouting({ toolName: "register_character_identity", projectDir: governed, acknowledgedBenchmarkMigration: true }).allowed, false);
  const migrated = checkCanonicalRouting({ toolName: "scripts/generate-manga-script-images.mjs", projectDir: governed, acknowledgedBenchmarkMigration: true });
  assert.deepEqual([migrated.allowed, migrated.benchmarkMigration], [true, true]);

  // 従来レイアウト（handoff-restore が書く <project>/config/）も対象。
  const restored = await mkdtemp(join(tmpdir(), "harness-restored-"));
  await mkdir(join(restored, "config"), { recursive: true });
  await writeFile(join(restored, "config", "koya-show-bible.json"), "{}\n");
  assert.equal(checkCanonicalRouting({ toolName: "register_character_identity", projectDir: restored }).allowed, false);

  await rm(governed, { recursive: true, force: true });
  await rm(restored, { recursive: true, force: true });
});

test("Koya の公式経路の対象でないプロジェクトでは、汎用の人物登録・画像の道具は従来どおり通る", async () => {
  const bare = await mkdtemp(join(tmpdir(), "harness-generic-"));
  // 別ジャンルの pack（Koya の正本を持たない）と、合成の fixture は対象に数えない。
  await mkdir(join(bare, "channel-packs", "other-pack", "config"), { recursive: true });
  await writeFile(join(bare, "channel-packs", "other-pack", "config", "other.json"), "{}\n");
  await mkdir(join(bare, "test", "fixtures", "channel-pack", "config"), { recursive: true });
  await writeFile(join(bare, "test", "fixtures", "channel-pack", "config", "koya-show-bible.json"), "{}\n");
  for (const toolName of ["approve_character_candidate", "register_character_identity", "scripts/generate-manga-script-images.mjs"]) {
    const verdict = checkCanonicalRouting({ toolName, projectDir: bare });
    assert.equal(verdict.allowed, true, `${toolName} は汎用の使い方では通ること`);
    assert.equal(verdict.governedProject, false);
  }
  await rm(bare, { recursive: true, force: true });
});
