import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

// MP4 をメモリへ一括で読まない。読んでいる間の差し替え・追記も証跡として受理しない。
export async function hashHarnessArtifact(path) {
  const target = resolve(path);
  const before = await stat(target);
  if (!before.isFile()) throw new Error("成果物が通常fileではない。");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(target)) { hash.update(chunk); bytes += chunk.length; }
  const after = await stat(target);
  if (!after.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs
    || before.dev !== after.dev || before.ino !== after.ino || bytes !== after.size) {
    throw new Error("SHA計算中に成果物が変更された。");
  }
  return { path: target, sha256: hash.digest("hex"), bytes };
}
