import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { channelPackPresent } from "../lib/channelPackResolver.mjs";
import { exportKoyaHandoffBundle, restoreKoyaHandoffBundle, verifyKoyaHandoffBundle } from "../lib/koyaHandoffBundle.mjs";
import { runHarnessDoctor } from "../scripts/harness-doctor.mjs";

const root = new URL("..", import.meta.url).pathname;

test("運営者へ渡す経路が、契約を持たないプロジェクトで端から端まで通る", async (t) => {
  // これが配布の本体。ここが通らなければ、他が全部揃っていても
  // 運営者はハーネスを受け取れない。
  //
  // 通っていなかった理由が3つ重なっていた:
  //   1. export が契約を projectDir 固定で読む（契約はランタイム側にある）
  //   2. export が番組正本を従来パス固定で読む（正本は Channel Pack 側にある）
  //   3. restore は従来レイアウトへ書くのに、pack の有無は
  //      channel-packs/ しか見ない → **復元成功の直後に「pack 未設置」**
  if (!channelPackPresent(root)) {
    t.skip("channel pack が無い環境（配る中身が無い）");
    return;
  }

  // 送り手: Channel Pack だけを持ち、契約のコピーは持たないプロジェクト。
  const sender = await mkdtemp(join(tmpdir(), "koya-sender-"));
  await cp(join(root, "channel-packs"), join(sender, "channel-packs"), { recursive: true });
  assert.equal(
    existsSync(join(sender, "config/koya-manga-production-contract.json")), false,
    "契約のコピーを持たない前提であること",
  );

  const bundleDir = join(sender, "bundle");
  const exported = await exportKoyaHandoffBundle({ projectDir: sender, outputDir: bundleDir });
  assert.equal(exported.ok, true, "契約を持たないプロジェクトから export できること");
  assert.equal(existsSync(join(bundleDir, "contract-snapshot")), true, "契約の snapshot が束に入ること");

  const verified = await verifyKoyaHandoffBundle({ bundleDir });
  assert.equal(verified.ok, true, "自分で作った束が verify を通ること");

  // 受け手: 空のプロジェクト。
  const recipient = await mkdtemp(join(tmpdir(), "koya-recipient-"));
  const restored = await restoreKoyaHandoffBundle({ projectDir: recipient, bundleDir });
  assert.equal(restored.ok, true, "空のプロジェクトへ復元できること");

  // 復元した直後に、検査が「揃っている」と言うこと。
  assert.equal(channelPackPresent(recipient), true, "復元の直後に pack 未設置と言わないこと");
  const doctor = await runHarnessDoctor({ projectDir: recipient });
  const pack = doctor.checks.find((check) => check.id === "channel-pack");
  assert.equal(pack.ok, true, `復元後の doctor: ${pack.detail}`);
  assert.match(pack.detail, /正本を検証/u, "存在確認だけでなく読めることを見ていること");

  for (const dir of [sender, recipient]) await rm(dir, { recursive: true, force: true });
});
