import { lstat, readFile, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { tmpdir } from "node:os";

export default async function cleanupCanvasFixture(config) {
  const marker = String(config?.metadata?.canvasFixtureMarker || "");
  if (!marker || dirname(marker) !== tmpdir() || !/^buzzassist-playwright-fixture-\d+\.json$/u.test(basename(marker))) {
    throw new Error("Refusing to clean an unbound Playwright fixture marker.");
  }

  try {
    const markerStat = await lstat(marker);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      throw new Error("Playwright fixture marker is not a regular file.");
    }
    const payload = JSON.parse(await readFile(marker, "utf8"));
    const fixtureProjectDir = String(payload?.fixtureProjectDir || "");
    if (dirname(fixtureProjectDir) !== tmpdir() || !/^buzzassist-browser-canvas-[A-Za-z0-9]+$/u.test(basename(fixtureProjectDir))) {
      throw new Error("Refusing to clean an unbound Playwright fixture directory.");
    }
    const fixtureStat = await lstat(fixtureProjectDir).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (fixtureStat?.isSymbolicLink()) throw new Error("Playwright fixture directory became a symlink.");
    if (fixtureStat && !fixtureStat.isDirectory()) throw new Error("Playwright fixture path is not a directory.");
    if (fixtureStat) await rm(fixtureProjectDir, { recursive: true, force: false });
  } finally {
    await rm(marker, { force: true });
  }
}
