import { expect, test } from "@playwright/test";

test("real Canvas App mounts projected image/video/audio media and opens the native audio player", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));

  const navigation = await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(navigation?.ok()).toBe(true);
  await expect(page.locator(".lovart-ai-root")).toBeVisible();
  await expect(page.locator(".excalidraw")).toBeVisible();
  await expect(page.locator(".excalidraw canvas").first()).toBeVisible();

  const stateResponse = await page.request.get("/api/canvas");
  expect(stateResponse.ok()).toBe(true);
  const state = await stateResponse.json();
  const projectedMedia = state.scene.elements.filter(
    (element) => element.customData?.["buzzassist.harnessRunMedia.v1"] === true && !element.isDeleted,
  );
  expect(projectedMedia.map((element) => element.customData.codexMediaKind).sort()).toEqual([
    "audio",
    "image",
    "video",
  ]);

  await expect(page.locator(".lovart-image-header-name-text", { hasText: /harness-image-/u })).toBeVisible();
  await expect(page.locator(".lovart-video-playback-overlay")).toHaveCount(1);
  await expect(page.locator(".lovart-video-playback-ui:not(.lovart-audio-playback-ui)")).toHaveCount(1);
  await expect(page.locator('.lovart-audio-playback-ui[data-media-kind="audio"]')).toHaveCount(1);

  const playButton = page.getByRole("button", { name: /^音声を再生:/u });
  await expect(playButton).toBeVisible();
  const audioResponsePromise = page.waitForResponse(
    (response) => /\/excalidraw-assets\/harness-runs\/browser-smoke-run-001\/[a-f0-9]{64}\.wav(?:\?|$)/u.test(response.url()),
  );
  await playButton.click();

  const dialog = page.getByRole("dialog", { name: "音声プレイヤー" });
  await expect(dialog).toBeVisible();
  const player = dialog.locator("audio[data-audio-playback-id]");
  await expect(player).toHaveCount(1);
  await expect(player).toHaveJSProperty("controls", true);
  await expect(player).toHaveAttribute(
    "src",
    /\/excalidraw-assets\/harness-runs\/browser-smoke-run-001\/[a-f0-9]{64}\.wav(?:\?|$)/u,
  );

  const audioResponse = await audioResponsePromise;
  expect(audioResponse.ok()).toBe(true);
  expect(audioResponse.headers()["content-type"]).toContain("audio/wav");
  await expect.poll(() => player.evaluate((element) => element.readyState)).toBeGreaterThanOrEqual(2);
  const playback = await player.evaluate(async (element) => {
    element.currentTime = 0;
    await element.play();
    return { paused: element.paused, readyState: element.readyState };
  });
  expect(playback.readyState).toBeGreaterThanOrEqual(2);
  expect(playback.paused).toBe(false);

  await dialog.getByRole("button", { name: "閉じる" }).click();
  await expect(dialog).toBeHidden();
  expect(pageErrors).toEqual([]);
});
