import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MEDIA_BATCH_COLUMNS,
  DEFAULT_MEDIA_BATCH_CONCURRENCY,
  DEFAULT_MEDIA_BATCH_CHUNK_SIZE,
  MAX_CODEX_IMAGE_COUNT,
  MAX_GROK_GENERATION_COUNT,
  chunkMediaBatchJobs,
  generateImageMedia,
  generateVideoMedia,
  getHermesStatus,
  isCodexImageModel,
  isGrokAuthenticationError,
  isGrokImageModel,
  isGrokVideoModel,
  isRetryableGrokRateLimit,
  normalizeCodexImageCount,
  normalizeGrokGenerationCount,
  normalizeMediaBatchColumns,
  normalizeMediaBatchConcurrency,
  sanitizeGrokVideoDuration,
} from "../lib/mediaGeneration.mjs";

test("media batch defaults to 10 concurrent jobs laid out as 2 rows x 5 columns", () => {
  assert.equal(DEFAULT_MEDIA_BATCH_CONCURRENCY, 10);
  assert.equal(DEFAULT_MEDIA_BATCH_COLUMNS, 5);
  assert.equal(DEFAULT_MEDIA_BATCH_CHUNK_SIZE, 10);
  assert.equal(normalizeMediaBatchConcurrency(undefined), 10);
  assert.equal(normalizeMediaBatchColumns(undefined), 5);
});

test("ChatGPT GPT Image 2 returns every requested independent image", async () => {
  const previousCommand = process.env.EXCALIDRAW_GPT_IMAGE_2_CODEX_COMMAND;
  const fixturePath = fileURLToPath(new URL("./fixtures/fakeImageBridge.mjs", import.meta.url));
  process.env.EXCALIDRAW_GPT_IMAGE_2_CODEX_COMMAND = `"${process.execPath}" "${fixturePath}"`;
  try {
    const media = await generateImageMedia({
      model: "gpt-image-2-codex",
      prompt: "parallel image test",
      imageCount: 3,
      fileName: "parallel.png",
    });
    assert.equal(media.fileName, "parallel.png");
    assert.equal(media.extraMedia.length, 2);
    assert.deepEqual(media.extraMedia.map((item) => item.fileName), ["parallel-2.png", "parallel-3.png"]);
    assert.equal(media.buffer.length > 0, true);
    assert.equal(media.extraMedia.every((item) => item.buffer.length > 0), true);
  } finally {
    if (previousCommand === undefined) delete process.env.EXCALIDRAW_GPT_IMAGE_2_CODEX_COMMAND;
    else process.env.EXCALIDRAW_GPT_IMAGE_2_CODEX_COMMAND = previousCommand;
  }
});

test("ChatGPT GPT Image 2 accepts 1-10 independent image runs", () => {
  assert.equal(MAX_CODEX_IMAGE_COUNT, 10);
  assert.equal(isCodexImageModel(undefined), true);
  assert.equal(isCodexImageModel("GPT Image 2 (Codex)"), true);
  assert.equal(isCodexImageModel("gpt-image-2"), false);
  assert.equal(normalizeCodexImageCount(undefined), 1);
  assert.equal(normalizeCodexImageCount("4"), 4);
  assert.equal(normalizeCodexImageCount(0), 1);
  assert.equal(normalizeCodexImageCount(99), 10);
});

test("local Grok accepts 1-10 independent image and video runs", () => {
  assert.equal(MAX_GROK_GENERATION_COUNT, 10);
  assert.equal(isGrokImageModel("Grok Imagine (Grok CLI)"), true);
  assert.equal(isGrokVideoModel("Grok Imagine Video (Grok CLI)"), true);
  assert.equal(normalizeGrokGenerationCount(undefined), 1);
  assert.equal(normalizeGrokGenerationCount("6"), 6);
  assert.equal(normalizeGrokGenerationCount(0), 1);
  assert.equal(normalizeGrokGenerationCount(99), 10);
});

test("Grok image count runs independent bridge requests", async () => {
  const previousCommand = process.env.EXCALIDRAW_GROK_IMAGE_HERMES_COMMAND;
  const fixturePath = fileURLToPath(new URL("./fixtures/fakeImageBridge.mjs", import.meta.url));
  process.env.EXCALIDRAW_GROK_IMAGE_HERMES_COMMAND = `"${process.execPath}" "${fixturePath}"`;
  try {
    const media = await generateImageMedia({
      model: "grok-imagine-image-hermes",
      prompt: "parallel Grok image test",
      imageCount: 4,
      fileName: "grok.png",
    });
    assert.equal(media.fileName, "grok.png");
    assert.equal(media.extraMedia.length, 3);
    assert.deepEqual(media.extraMedia.map((item) => item.fileName), ["grok-2.png", "grok-3.png", "grok-4.png"]);
    assert.equal(media.requestedCount, 4);
  } finally {
    if (previousCommand === undefined) delete process.env.EXCALIDRAW_GROK_IMAGE_HERMES_COMMAND;
    else process.env.EXCALIDRAW_GROK_IMAGE_HERMES_COMMAND = previousCommand;
  }
});

test("Grok video count runs independent bridge requests with shared settings", async () => {
  const previousCommand = process.env.EXCALIDRAW_GROK_VIDEO_HERMES_COMMAND;
  const fixturePath = fileURLToPath(new URL("./fixtures/fakeVideoBridge.mjs", import.meta.url));
  process.env.EXCALIDRAW_GROK_VIDEO_HERMES_COMMAND = `"${process.execPath}" "${fixturePath}"`;
  try {
    const media = await generateVideoMedia({
      model: "grok-imagine-video-hermes",
      prompt: "parallel Grok video test",
      duration: "10",
      resolution: "720p",
      videoCount: 3,
      fileName: "grok.mp4",
    });
    assert.equal(media.fileName, "grok.mp4");
    assert.equal(media.extraMedia.length, 2);
    assert.deepEqual(media.extraMedia.map((item) => item.fileName), ["grok-2.mp4", "grok-3.mp4"]);
    assert.equal(media.requestedCount, 3);
  } finally {
    if (previousCommand === undefined) delete process.env.EXCALIDRAW_GROK_VIDEO_HERMES_COMMAND;
    else process.env.EXCALIDRAW_GROK_VIDEO_HERMES_COMMAND = previousCommand;
  }
});

test("Grok retries temporary 429 responses but not exhausted quota", () => {
  assert.equal(isRetryableGrokRateLimit(429, "rate limit exceeded, retry later"), true);
  assert.equal(isRetryableGrokRateLimit(429, "monthly quota exhausted"), false);
  assert.equal(isRetryableGrokRateLimit(500, "rate limit"), false);
});

test("Grok recognizes rejected OAuth credentials without treating every 403 as an auth failure", () => {
  assert.equal(isGrokAuthenticationError(401, "anything"), true);
  assert.equal(isGrokAuthenticationError(403, "The OAuth2 access token could not be validated."), true);
  assert.equal(isGrokAuthenticationError(403, "content policy violation"), false);
  assert.equal(isGrokAuthenticationError(429, "access token"), false);
});

test("Grok OAuth refreshes before expiry, retries one rejected token, and requests re-login cleanly", async () => {
  const previous = {
    GROK_HOME: process.env.GROK_HOME,
    GROK_CLI_PATH: process.env.GROK_CLI_PATH,
    XAI_API_KEY: process.env.XAI_API_KEY,
    GROK_DEPLOYMENT_KEY: process.env.GROK_DEPLOYMENT_KEY,
    FAKE_GROK_REFRESH_TOKEN: process.env.FAKE_GROK_REFRESH_TOKEN,
    FAKE_GROK_REFRESH_FAIL: process.env.FAKE_GROK_REFRESH_FAIL,
  };
  const previousFetch = globalThis.fetch;
  const home = await mkdtemp(join(os.tmpdir(), "buzzassist-grok-auth-"));
  const cli = fileURLToPath(new URL(
    process.platform === "win32" ? "./fixtures/fakeGrokCli.cmd" : "./fixtures/fakeGrokCli.mjs",
    import.meta.url,
  ));
  const authPath = join(home, "auth.json");
  const writeAuth = async (token, expiresAt) => {
    await writeFile(
      authPath,
      `${JSON.stringify({
        "https://auth.x.ai::test": {
          key: token,
          refresh_token: "test-refresh-token",
          expires_at: expiresAt,
          auth_mode: "oauth",
        },
      })}\n`,
    );
  };
  const imageResponse = () => new Response(
    JSON.stringify({ data: [{ b64_json: Buffer.from("fake-png").toString("base64") }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

  try {
    await mkdir(home, { recursive: true });
    process.env.GROK_HOME = home;
    process.env.GROK_CLI_PATH = cli;
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_DEPLOYMENT_KEY;
    delete process.env.FAKE_GROK_REFRESH_FAIL;

    // Expired credentials are silently refreshed before the paid generation.
    await writeAuth("expired-oauth-token", new Date(Date.now() - 60_000).toISOString());
    process.env.FAKE_GROK_REFRESH_TOKEN = "proactively-refreshed-token";
    globalThis.fetch = async (_url, options = {}) => {
      assert.equal(options.headers.Authorization, "Bearer proactively-refreshed-token");
      return imageResponse();
    };
    const proactive = await generateImageMedia({
      model: "grok-imagine-image-hermes",
      prompt: "refresh before generation",
    });
    assert.equal(proactive.buffer.toString(), "fake-png");

    // A token rejected during generation is refreshed once and retried.
    await writeAuth("server-rejected-token", new Date(Date.now() + 60 * 60_000).toISOString());
    process.env.FAKE_GROK_REFRESH_TOKEN = "retry-refreshed-token";
    let requestCount = 0;
    globalThis.fetch = async (_url, options = {}) => {
      requestCount += 1;
      if (requestCount === 1) {
        assert.equal(options.headers.Authorization, "Bearer server-rejected-token");
        return new Response(
          JSON.stringify({ error: { message: "The OAuth2 access token could not be validated." } }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
      assert.equal(options.headers.Authorization, "Bearer retry-refreshed-token");
      return imageResponse();
    };
    const retried = await generateImageMedia({
      model: "grok-imagine-image-hermes",
      prompt: "retry after 403",
    });
    assert.equal(retried.buffer.toString(), "fake-png");
    assert.equal(requestCount, 2);

    // If silent refresh genuinely fails, expose a stable Japanese re-login
    // action instead of leaking the provider's raw OAuth 403 into the panel.
    await writeAuth("unrefreshable-token", new Date(Date.now() + 60 * 60_000).toISOString());
    process.env.FAKE_GROK_REFRESH_FAIL = "1";
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: { message: "The OAuth2 access token could not be validated." } }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
    await assert.rejects(
      generateImageMedia({ model: "grok-imagine-image-hermes", prompt: "reauth required" }),
      (error) => {
        assert.match(error.message, /Grokの再ログインが必要です/);
        assert.doesNotMatch(error.message, /OAuth2 access token could not be validated/);
        return true;
      },
    );
    const status = await getHermesStatus();
    assert.equal(status.installed, true);
    assert.equal(status.session, "logged-out");
    assert.equal(status.reauthenticationRequired, true);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("media batch concurrency is capped at 10", () => {
  assert.equal(normalizeMediaBatchConcurrency(99), 10);
  assert.equal(normalizeMediaBatchConcurrency(0), 1);
  assert.equal(normalizeMediaBatchConcurrency(4.6), 5);
});

test("media batch jobs split 18 requests into 10 then 8", () => {
  const jobs = Array.from({ length: 18 }, (_, index) => ({ prompt: `job ${index + 1}` }));
  const chunks = chunkMediaBatchJobs(jobs);
  assert.equal(chunks.length, 2);
  assert.deepEqual(
    chunks.map((chunk) => ({ start: chunk.start, count: chunk.jobs.length })),
    [
      { start: 0, count: 10 },
      { start: 10, count: 8 },
    ],
  );
});

test("Grok CLI video duration accepts only the native 6s or 10s tool choices", () => {
  assert.equal(sanitizeGrokVideoDuration(undefined), 6);
  assert.equal(sanitizeGrokVideoDuration("6"), 6);
  assert.equal(sanitizeGrokVideoDuration("10"), 10);
  assert.throws(() => sanitizeGrokVideoDuration("5"), /must be 6 or 10/);
  assert.throws(() => sanitizeGrokVideoDuration("7"), /must be 6 or 10/);
  assert.throws(() => sanitizeGrokVideoDuration("15"), /must be 6 or 10/);
  assert.throws(() => sanitizeGrokVideoDuration("6s"), /must be 6 or 10/);
});
