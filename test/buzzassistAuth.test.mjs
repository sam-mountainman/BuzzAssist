import test from "node:test";
import assert from "node:assert/strict";

import { buzzAssistFetch, getBuzzAssistAuthStatus, resolveBillingAccountUrl, resolveSubtitleCreditsUrl } from "../lib/buzzassistApi.mjs";

function makeToken(claims = {}) {
  const payload = Buffer.from(JSON.stringify({
    sub: "user_test",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  })).toString("base64url");
  return `v1.${payload}.signature`;
}

async function withEnvToken(token, callback) {
  const previousMediaToken = process.env.BUZZASSIST_MEDIA_TOKEN;
  const previousToken = process.env.BUZZASSIST_TOKEN;
  process.env.BUZZASSIST_MEDIA_TOKEN = token;
  delete process.env.BUZZASSIST_TOKEN;
  try {
    return await callback();
  } finally {
    if (previousMediaToken === undefined) delete process.env.BUZZASSIST_MEDIA_TOKEN;
    else process.env.BUZZASSIST_MEDIA_TOKEN = previousMediaToken;
    if (previousToken === undefined) delete process.env.BUZZASSIST_TOKEN;
    else process.env.BUZZASSIST_TOKEN = previousToken;
  }
}

test("BuzzAssist auth status treats server-rejected tokens as requiring login", async () => {
  await withEnvToken(makeToken(), async () => {
    const status = await getBuzzAssistAuthStatus({
      verifyServer: true,
      fetchImpl: async (url, init) => {
        assert.equal(url, resolveBillingAccountUrl());
        assert.equal(init.method, "GET");
        return new Response(JSON.stringify({ error: "invalid token" }), { status: 401 });
      },
    });

    assert.equal(status.loggedIn, false);
    assert.equal(status.expired, false);
    assert.equal(status.serverRejected, true);
    assert.equal(status.requiresLogin, true);
    assert.equal(status.serverStatus, 401);
  });
});

test("BuzzAssist auth status keeps local token state when server validation cannot be reached", async () => {
  await withEnvToken(makeToken(), async () => {
    const status = await getBuzzAssistAuthStatus({
      verifyServer: true,
      fetchImpl: async () => {
        throw new Error("network unavailable");
      },
    });

    assert.equal(status.loggedIn, true);
    assert.equal(status.serverVerified, false);
    assert.match(status.serverVerificationError, /network unavailable/);
  });
});

test("BuzzAssist media-token 401 errors are not wrapped as network failures", async () => {
  const previousFetch = globalThis.fetch;
  await withEnvToken(makeToken(), async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "invalid token" }), { status: 401 });
    try {
      await assert.rejects(
        buzzAssistFetch(resolveSubtitleCreditsUrl(), {
          body: JSON.stringify({ action: "reserve", model: "elevenlabs-scribe-v2", durationSeconds: 1 }),
        }),
        (error) => {
          assert.match(error.message, /メディアトークンを拒否しました/);
          assert.doesNotMatch(error.message, /Check network access/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("login URL forces the account chooser like the desktop app", async () => {
  const { buildLoginUrl } = await import("../lib/buzzassistApi.mjs");
  const url = new URL(buildLoginUrl({ callbackPort: 12345, state: "abc" }));
  assert.equal(url.pathname, "/api/desktop/auth");
  assert.equal(url.searchParams.get("select_account"), "1");
  assert.match(url.searchParams.get("callback_uri"), /^http:\/\/127\.0\.0\.1:12345\/buzzassist-auth\?state=abc$/);
});
