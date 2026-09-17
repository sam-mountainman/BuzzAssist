import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

const port = 43_991;
const baseURL = `http://127.0.0.1:${port}`;
const fixtureMarker = join(tmpdir(), `buzzassist-playwright-fixture-${process.pid}.json`);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "canvas-media.smoke.spec.mjs",
  globalTeardown: "./e2e/cleanup-canvas-fixture.mjs",
  metadata: { canvasFixtureMarker: fixtureMarker },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 20_000 },
  reporter: [["line"]],
  outputDir: join(tmpdir(), `buzzassist-playwright-${process.pid}`),
  use: {
    baseURL,
    viewport: { width: 1_440, height: 1_000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
      },
    },
  ],
  webServer: {
    command: "node e2e/start-canvas-fixture.mjs",
    url: `${baseURL}/api/canvas`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      EXCALIDRAW_AUTO_BUILD: "0",
      EXCALIDRAW_HOST: "127.0.0.1",
      EXCALIDRAW_PORT: String(port),
      EXCALIDRAW_STRICT_PORT: "1",
      BUZZASSIST_E2E_FIXTURE_MARKER: fixtureMarker,
    },
  },
});
