// スキルの束（SKILL.md と references・付属物）の digest（bundleSha256）の試験。
// 人の承認はこの digest にも束縛されるので、OS の改行・パスの区切り・ファイル名の正規化で値が
// 変わると、Windows の運営者の写しだけ承認が外れて制作が止まる。逆に references だけの変更で値が
// 動かないと、人が見ないまま運営者の端末へ届く。スキル名と中身はすべて合成の値。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  SKILL_BUNDLE_DIGEST_VERSION,
  SKILL_BUNDLE_EXCLUDED_DIRECTORIES,
  SKILL_MACHINE_OWNED_FILES,
  computeSkillBundle,
  skillBundleDigestOf,
} from "../lib/skillInventory.mjs";
import { SKILL_TREE_MACHINE_OWNED_FILES } from "../lib/harnessRunReceipt.mjs";

const hex = (value) => createHash("sha256").update(value).digest("hex");

// 並べ順はコード単位の順（"SKILL.md" の S は小文字より前）。
const FILES = Object.freeze({
  "SKILL.md": "---\nname: synthetic-bundle\ndescription: 合成のスキル\n---\n\n# 合成\n\n- references/a.md を読む\n",
  "agents/openai.yaml": "interface:\n  display_name: 合成\n",
  "references/a.md": "# 参照 A\n\n決まりの本文\n",
  "references/sub/b.md": "# 参照 B\n",
  "scripts/run.mjs": "export const value = 1;\n",
});

function makeSkill(t, files = FILES, { newline = "\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "skill-bundle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skillDir = join(root, "synthetic-bundle");
  for (const [relativePath, content] of Object.entries(files)) {
    const full = join(skillDir, ...relativePath.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof content === "string" ? content.replaceAll("\n", newline) : content);
  }
  return skillDir;
}

function write(skillDir, relativePath, content) {
  const full = join(skillDir, ...relativePath.split("/"));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

test("束の digest は、相対パス（/ 区切り）と中身の sha256 を並べた正規の一覧から作り、値は固定されている", async (t) => {
  const skillDir = makeSkill(t);
  const bundle = await computeSkillBundle(skillDir);
  assert.deepEqual(bundle.files.map((entry) => entry.path), Object.keys(FILES));
  // 実装を通さずに仕様どおり組み立てた値と一致する。
  const lines = Object.entries(FILES).map(([path, content]) => `${hex(content)} ${JSON.stringify(path)}\n`).join("");
  assert.equal(bundle.bundleSha256, `sha256:${hex(`${SKILL_BUNDLE_DIGEST_VERSION}\n${lines}`)}`);
  assert.equal(skillBundleDigestOf(bundle.files), bundle.bundleSha256);
  // 値そのものも固定する（Windows / Linux の CI でも同じ値にならなければ落ちる）。
  assert.equal(bundle.bundleSha256, "sha256:da565f21d6dbf746dde71826db471f339271908a56ab677dbb84b643d7e76721");
  assert.equal(bundle.fileCount, 5);
});

test("Windows の改行（CRLF）で取り出した写しでも同じ digest になり、バイナリは改行をそろえない", async (t) => {
  const lf = await computeSkillBundle(makeSkill(t));
  const crlf = await computeSkillBundle(makeSkill(t, FILES, { newline: "\r\n" }));
  assert.equal(crlf.bundleSha256, lf.bundleSha256);

  // NUL を含むファイルはテキストとして扱わない（CRLF をそろえると別の中身を同じと数えてしまう）。
  const binaryLf = await computeSkillBundle(makeSkill(t, { ...FILES, "assets/icon.bin": Buffer.from([0, 10, 1]) }));
  const binaryCrlf = await computeSkillBundle(makeSkill(t, { ...FILES, "assets/icon.bin": Buffer.from([0, 13, 10, 1]) }));
  assert.notEqual(binaryCrlf.bundleSha256, binaryLf.bundleSha256);
});

test("ファイル名の Unicode 正規化（macOS の NFD）で値が変わらない", async (t) => {
  const nfc = "references/がいど.md".normalize("NFC");
  const nfd = "references/がいど.md".normalize("NFD");
  assert.notEqual(nfc, nfd);
  const composed = await computeSkillBundle(makeSkill(t, { ...FILES, [nfc]: "本文\n" }));
  const decomposed = await computeSkillBundle(makeSkill(t, { ...FILES, [nfd]: "本文\n" }));
  assert.equal(decomposed.bundleSha256, composed.bundleSha256);
  assert.ok(decomposed.files.some((entry) => entry.path === nfc), "一覧のパスは NFC にそろえる");
});

test("references・scripts・直下の付属物を変えると値が動く", async (t) => {
  const base = (await computeSkillBundle(makeSkill(t))).bundleSha256;
  for (const [relativePath, content] of [
    ["references/a.md", "# 参照 A\n\n決まりを変えた\n"],
    ["references/sub/b.md", "# 参照 B（変えた）\n"],
    ["scripts/run.mjs", "export const value = 2;\n"],
    ["agents/openai.yaml", "interface:\n  display_name: 別名\n"],
    ["reference-sheet-prompts.md", "直下に足した付属物\n"],
    ["references/evals/notes.md", "直下でない evals は束に入る\n"],
    ["references/learned-auto-notes.md", "overlay と別名のファイルは束に入る\n"],
  ]) {
    const skillDir = makeSkill(t);
    write(skillDir, relativePath, content);
    assert.notEqual((await computeSkillBundle(skillDir)).bundleSha256, base, `${relativePath} の変更で値が動かない`);
  }
});

test("機械が書く overlay（learned-auto.md・learned-archive.md）、evals/、OS が置くファイルは束から外す", async (t) => {
  assert.deepEqual([...SKILL_BUNDLE_EXCLUDED_DIRECTORIES], ["evals"]);
  // RunReceipt の tree 指紋が外すものと同じ（片方だけ直すと、承認と記録で「スキル本体」の範囲が食い違う）。
  assert.deepEqual([...SKILL_MACHINE_OWNED_FILES], [...SKILL_TREE_MACHINE_OWNED_FILES]);
  const base = (await computeSkillBundle(makeSkill(t))).bundleSha256;
  const skillDir = makeSkill(t);
  write(skillDir, "references/learned-auto.md", "# 合成の overlay\n\n- sync が書いた項目\n");
  write(skillDir, "references/learned-archive.md", "# 合成の退避\n");
  write(skillDir, "evals/evals.json", "{\"skill_name\":\"synthetic-bundle\",\"evals\":[]}\n");
  write(skillDir, ".DS_Store", Buffer.from([0, 0, 0, 1]));
  write(skillDir, "references/.DS_Store", Buffer.from([0, 0, 0, 2]));
  write(skillDir, "._SKILL.md", Buffer.from([0, 5]));
  write(skillDir, "Thumbs.db", Buffer.from([0, 7]));
  const bundle = await computeSkillBundle(skillDir);
  assert.equal(bundle.bundleSha256, base);
  assert.deepEqual(bundle.files.map((entry) => entry.path), Object.keys(FILES));
});

test("symlink は束に数えずに止める（配布物にも入れない）", async (t) => {
  const skillDir = makeSkill(t);
  try {
    symlinkSync(join(skillDir, "references", "a.md"), join(skillDir, "references", "link.md"));
  } catch {
    t.skip("この環境では symlink を作れない");
    return;
  }
  await assert.rejects(() => computeSkillBundle(skillDir), /普通のファイルでないもの/u);
});
