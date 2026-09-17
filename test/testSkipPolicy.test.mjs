import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { evaluateTestSkips, parseTapSkips, validateTestSkipPolicy } from "../lib/testSkipPolicy.mjs";

const policy = JSON.parse(await readFile(new URL("../config/ci-test-skip-allowlist.json", import.meta.url), "utf8"));

function reasonFor(entry) {
  if (entry.reason) return entry.reason;
  return `${entry.reasonPrefix}/opt/buzzassist-voice-qa/python${entry.reasonSuffix}`;
}

function skipsFor(platform) {
  return policy.entries
    .filter((entry) => entry.platforms.includes(platform))
    .map((entry) => ({ name: entry.name, reason: reasonFor(entry) }));
}

test("release skip allowlist accepts only the exact clean-clone skips for each platform", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const result = evaluateTestSkips(skipsFor(platform), policy, { platform });
    assert.equal(result.pass, true, platform);
    assert.deepEqual(result.unexpected, []);
    assert.deepEqual(result.stale, []);
  }
});

test("unexpected and reason-changed skips fail the release policy", () => {
  const expected = skipsFor("linux");
  const unexpected = evaluateTestSkips([
    ...expected,
    { name: "content-addressed projected MP4, WAV, and MP3 assets probe and fully decode", reason: "ffmpeg/ffprobe is unavailable" },
  ], policy, { platform: "linux" });
  assert.equal(unexpected.pass, false);
  assert.equal(unexpected.unexpected.length, 1);

  const changed = structuredClone(expected);
  changed[0].reason = `${changed[0].reason}（別理由）`;
  const reasonChanged = evaluateTestSkips(changed, policy, { platform: "linux" });
  assert.equal(reasonChanged.pass, false);
  assert.equal(reasonChanged.unexpected.length, 1);
  assert.equal(reasonChanged.stale.length, 1);
});

test("a stale expected skip fails so obsolete exceptions cannot accumulate", () => {
  const expected = skipsFor("linux");
  const result = evaluateTestSkips(expected.slice(1), policy, { platform: "linux" });
  assert.equal(result.pass, false);
  assert.equal(result.unexpected.length, 0);
  assert.equal(result.stale.length, 1);
});

test("required toolchain skips cannot be added to the allowlist", () => {
  const poisoned = structuredClone(policy);
  poisoned.entries.push({
    name: "full-decode は壊れた動画を落とす",
    reason: "ffmpeg が無い",
    category: "optional-heavy-qa",
    platforms: ["linux"],
    justification: "This must be rejected even if someone writes a justification.",
  });
  assert.throws(() => validateTestSkipPolicy(poisoned), /required toolchain skip/u);
});

test("TAP parser counts top-level and nested skips and preserves explicit reasons", () => {
  const parsed = parseTapSkips([
    "ok 1 - top-level # SKIP private fixture is absent",
    "    ok 1 - nested toolchain check # SKIP ffmpeg/ffprobe is unavailable",
    "ok 2 - ordinary pass",
    "ok 3 - unexplained # SKIP",
  ].join("\n"));
  assert.deepEqual(parsed, [
    { name: "top-level", reason: "private fixture is absent" },
    { name: "nested toolchain check", reason: "ffmpeg/ffprobe is unavailable" },
    { name: "unexplained", reason: "(理由なし)" },
  ]);
});
