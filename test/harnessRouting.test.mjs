import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GENRE_CANONICAL_ENTRYPOINTS, assertCanonicalRouting, checkCanonicalRouting } from "../lib/harnessRouting.mjs";

const root = new URL("..", import.meta.url).pathname;

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

test("Channel Pack が無い環境ではジャンル共通ハーネスとして素通りする", async () => {
  // pack を持たない人にまで番組固有の入口を強制すると、
  // ジャンル共通ハーネスとして配っている意味がなくなる。
  const bare = await mkdtemp(join(tmpdir(), "harness-bare-"));
  const verdict = checkCanonicalRouting({ toolName: "build_excalidraw_manga_video", projectDir: bare });
  assert.equal(verdict.allowed, true);
  assert.match(verdict.reason, /Channel Pack 未設置/u);
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
