import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeAgentSessionText } from "../scripts/sanitize-agent-session-secrets.mjs";

test("session sanitizer redacts high-confidence provider tokens without echoing them", () => {
  const openAiToken = `sk-proj-${"A".repeat(32)}`;
  const elevenLabsToken = "B".repeat(32);
  const input = JSON.stringify({ message: `OPENAI_API_KEY=${openAiToken} ELEVENLABS_API_KEY=${elevenLabsToken}` });
  const result = sanitizeAgentSessionText(input);
  assert.ok(result.matchCount >= 2);
  assert.doesNotMatch(result.text, new RegExp(openAiToken, "u"));
  assert.doesNotMatch(result.text, new RegExp(elevenLabsToken, "u"));
  assert.match(result.text, /REDACTED/u);
  assert.doesNotThrow(() => JSON.parse(result.text));
});

test("session sanitizer leaves ordinary IDs and environment variable names intact", () => {
  const input = JSON.stringify({ sessionId: "019fcb83-12a8-7811-8599-13c82a0c031d", note: "Use ELEVENLABS_API_KEY from the environment" });
  const result = sanitizeAgentSessionText(input);
  assert.equal(result.matchCount, 0);
  assert.equal(result.text, input);
});
