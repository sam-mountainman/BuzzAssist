// 設定画の収め直し（scripts/repack-koya-identity-grid.py と character-identity-repack の入力の決め方）の回帰テスト。
//
// 背景: 2026-10-25、生成した表情の板の多くに灰色の枠線が描き込まれ、行の境界を越える髪もあった。
// 白の閾値だけで切り出すと、枠線ごとセルへ写り（点検で全セル不合格）、まっすぐの行の切れ目が
// 髪の先を隣の行へ切り落とした。収め直した板をもう一度収め直すと、余白と枠線を抱えたまま
// 二度目の縮小がかかった。
//
// ここで固定する契約:
//   1. 細く長い無彩色の線（枠線）は消え、淡い色の服（彩度のある面）は消えない
//   2. 行の境界を越えた髪の先は、その髪の持ち主のセルへ付いていく（上のセルに切れ端を残さない）
//   3. 収め直した板が入力なら、その収め直しの元の板（記録とバイトが合うもの）から切り直す
import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { requirePythonRuntime } from "../lib/harnessRuntimeResolver.mjs";
import { resolveIdentityRepackInput } from "../lib/koyaMangaProduction.mjs";

const execFile = promisify(execFileCallback);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPACK_SCRIPT = path.join(REPO_ROOT, "scripts", "repack-koya-identity-grid.py");

async function pythonOrSkip(t) {
  try {
    return await requirePythonRuntime({ purposeEnv: "KOYA_GATE_PYTHON", projectDir: REPO_ROOT, requiredModules: ["numpy", "PIL"] });
  } catch (error) {
    t.skip(`収め直しの試験には numpy・PIL の Python が要る: ${error.message}`);
    return null;
  }
}

// 4x3 の板を描く。各セルに灰色の枠線（無彩色・2px）と、輪郭つきの楕円の人物を置く。
// 1行目の人物はセルの左寄りで、下端が自分の枠線を越えて y=197 まで出る。
// 2行目の人物はセルの右寄りで、髪にあたる上端が行の境界（y=200）を越えて y=185 まで出る。
// 1行目と2行目の間に白い行が無いので、まっすぐの切れ目ではどちらかが切られる。
// 1列目の人物は淡いラベンダー（彩度のある淡い色）で塗る。
const DRAW_SHEET = `
import sys
from PIL import Image, ImageDraw
out = sys.argv[1]
image = Image.new("RGB", (800, 600), (255, 255, 255))
draw = ImageDraw.Draw(image)
for row in range(3):
    for column in range(4):
        x0, y0 = column * 200, row * 200
        draw.rectangle([x0 + 6, y0 + 6, x0 + 193, y0 + 193], outline=(205, 205, 205), width=2)
        fill = (230, 214, 246) if column == 0 else (200, 120, 80)
        if row == 0:
            box = [x0 + 20, y0 + 30, x0 + 90, y0 + 197]
        elif row == 1:
            box = [x0 + 110, y0 - 15, x0 + 180, y0 + 170]
        else:
            box = [x0 + 50, y0 + 30, x0 + 150, y0 + 170]
        draw.ellipse(box, fill=fill, outline=(40, 40, 40), width=3)
image.save(out)
`;

const ANALYZE = `
import sys, json, importlib.util
import numpy as np
from PIL import Image
spec = importlib.util.spec_from_file_location("rp", sys.argv[1])
rp = importlib.util.module_from_spec(spec); spec.loader.exec_module(rp)
rgb = np.asarray(Image.open(sys.argv[2]).convert("RGB")).astype(int)
low, high = rgb.min(axis=2), rgb.max(axis=2)
grey = (low >= 150) & (low < 248) & ((high - low) <= 14)
def longest(mask):
    best = 0
    for line in mask:
        run = 0
        for value in line:
            run = run + 1 if value else 0
            best = max(best, run)
    return best
lavender = ((rgb[:, :, 2] - rgb[:, :, 1]) >= 20) & (low >= 200)
cells = []
for row in range(3):
    for column in range(4):
        cell = rgb[row * 200:(row + 1) * 200, column * 200:(column + 1) * 200]
        labels = rp.label_components(cell.min(axis=2) < 248)
        sizes = np.bincount(labels.ravel())[1:]
        cells.append(int((sizes >= 6).sum()))
print(json.dumps({
    "longestGreyRow": longest(grey), "longestGreyColumn": longest(grey.T),
    "lavenderPixels": int(lavender.sum()), "componentsPerCell": cells,
}))
`;

async function drawAndRepack(t, python, dir) {
  const sheet = path.join(dir, "sheet.png");
  await execFile(python.command, [...python.args, "-c", DRAW_SHEET, sheet]);
  const output = path.join(dir, "sheet-repack-r1.png");
  const manifest = path.join(dir, "sheet-repack-r1.manifest.json");
  await execFile(python.command, [...python.args, REPACK_SCRIPT, "--input", sheet, "--output", output, "--manifest", manifest, "--columns", "4", "--rows", "3"]);
  return { sheet, output, manifest };
}

test("repack removes drawn grey frames, keeps pale clothing, and keeps hair with its own view", async (t) => {
  const python = await pythonOrSkip(t);
  if (!python) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), "identity-repack-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { output, manifest } = await drawAndRepack(t, python, dir);
  const { stdout } = await execFile(python.command, [...python.args, "-c", ANALYZE, REPACK_SCRIPT, output]);
  const result = JSON.parse(stdout);
  // 枠線（セル幅に近い長さの無彩色の線）が残っていない。輪郭のなめらかさ由来の短い灰色だけは残ってよい
  assert.ok(result.longestGreyRow < 60, `grey frame row left: ${result.longestGreyRow}px`);
  assert.ok(result.longestGreyColumn < 60, `grey frame column left: ${result.longestGreyColumn}px`);
  // 淡いラベンダーの人物（1列目の3人）は消えていない
  assert.ok(result.lavenderPixels > 3 * 2000, `pale clothing was removed: ${result.lavenderPixels}px left`);
  // どのセルにも、人物ひとつだけ（行の境界を越えた髪の切れ端が上のセルに残っていない）
  assert.deepEqual(result.componentsPerCell, Array(12).fill(1));
  const recorded = JSON.parse(await readFile(manifest, "utf8"));
  assert.equal(recorded.version, "koya-identity-grid-repack-v1");
  assert.ok(recorded.ruleRemoval.removedPixels > 0);
  assert.ok(recorded.rowAssignment.every((column) => column.crossingPixelsReassigned > 0), "hair above the row cut must follow its own view in every column");
});

test("a repacked sheet is repacked again from its verified source, not from itself", async (t) => {
  const python = await pythonOrSkip(t);
  if (!python) return;
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "identity-repack-chain-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { sheet, output } = await drawAndRepack(t, python, dir);

  const chained = await resolveIdentityRepackInput(output);
  assert.equal(chained.path, path.resolve(sheet));
  assert.equal(chained.replaced.length, 1);
  assert.equal(chained.replaced[0].assetFile, path.resolve(output));

  const plain = await resolveIdentityRepackInput(sheet);
  assert.equal(plain.path, path.resolve(sheet));
  assert.equal(plain.replaced.length, 0);

  // 収め直した板のバイトが記録と合わなければ、元へは戻らずその板そのものを使う
  await writeFile(output, Buffer.from("tampered"));
  const tampered = await resolveIdentityRepackInput(output);
  assert.equal(tampered.path, path.resolve(output));
  assert.equal(tampered.replaced.length, 0);
});
