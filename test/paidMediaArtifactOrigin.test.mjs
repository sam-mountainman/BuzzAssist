// 成果物の取得元の既定（review q4-paid-media §3-1）。
// 公式の仲介（buzzassist.ai）は成果物を Convex のファイル置き場 `https://<deployment>.convex.cloud`
// の URL で返す。その origin が許可に無いと、課金の後に必ず取得で落ちていた。
// 公式の仲介のときだけ既定で許し、ほかの仲介は BUZZASSIST_MEDIA_ARTIFACT_ORIGINS に従う。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createPaidMediaJobBroker,
  isOfficialPaidMediaJobApiBase,
  readPaidMediaJobArtifact,
} from "../lib/paidMediaJobBroker.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const OFFICIAL_BASE = "https://buzzassist.ai/api/media/jobs";
const CUSTOM_BASE = "https://media.example.test/api/media/jobs";
const CONVEX_URL = "https://happy-otter-123.convex.cloud/api/storage/0f5c2d4e-1a2b-4c3d-8e9f-001122334455";
const ENV_KEYS = [
  "BUZZASSIST_MEDIA_ARTIFACT_ORIGINS",
  "BUZZASSIST_MEDIA_JOB_API_BASE",
  "BUZZASSIST_API_BASE",
  "BUZZASSIST_API_URL",
];

function wav() {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF", 0, "ascii");
  return bytes;
}

function completedJob(url, bytes) {
  return {
    status: "completed",
    result: { artifact: { url, sha256: sha256(bytes), mimeType: "audio/wav", bytes: bytes.length } },
  };
}

function artifactFetch(bytes, calls) {
  return async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      url,
      headers: { "content-length": String(bytes.length), "content-type": "audio/wav" },
      arrayBuffer: async () => bytes,
    };
  };
}

async function withEnv(values, callback) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try {
    return await callback();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("the official buzzassist.ai job API base allows its Convex storage origin by default and still verifies the bytes", async () => {
  await withEnv({}, async () => {
    const bytes = wav();
    const job = completedJob(CONVEX_URL, bytes);
    const calls = [];

    // 明示の公式の住所、broker の住所、何も渡さない既定（＝公式）のどれでも通る。
    assert.deepEqual(await readPaidMediaJobArtifact(job, { apiBase: OFFICIAL_BASE, fetchImpl: artifactFetch(bytes, calls) }), bytes);
    const broker = createPaidMediaJobBroker({ stateDir: "/unused-paid-media-state", apiFetch: async () => { throw new Error("no job call"); } });
    assert.equal(broker.apiBase, OFFICIAL_BASE);
    assert.equal(isOfficialPaidMediaJobApiBase(broker.apiBase), true);
    assert.deepEqual(await readPaidMediaJobArtifact(job, { apiBase: broker.apiBase, fetchImpl: artifactFetch(bytes, calls) }), bytes);
    assert.deepEqual(await readPaidMediaJobArtifact(job, { fetchImpl: artifactFetch(bytes, calls) }), bytes);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.url === CONVEX_URL && call.options.redirect === "error"));

    // 許した取得元でも、中身が完了したジョブの SHA-256 と違えば受け取らない。
    const tampered = Buffer.from(bytes);
    tampered[47] = 1;
    await assert.rejects(
      () => readPaidMediaJobArtifact(job, { apiBase: OFFICIAL_BASE, fetchImpl: artifactFetch(tampered, []) }),
      /SHA-256 does not match/u,
    );
  });
});

test("a custom job API base refuses the Convex storage origin unless BUZZASSIST_MEDIA_ARTIFACT_ORIGINS lists it", async () => {
  const bytes = wav();
  const job = completedJob(CONVEX_URL, bytes);

  await withEnv({}, async () => {
    const calls = [];
    for (const apiBase of [CUSTOM_BASE, "http://buzzassist.ai/api/media/jobs", "https://buzzassist.ai:8443/api/media/jobs", "https://www.buzzassist.ai.example.test/api/media/jobs"]) {
      assert.equal(isOfficialPaidMediaJobApiBase(apiBase), false, apiBase);
      await assert.rejects(
        () => readPaidMediaJobArtifact(job, { apiBase, fetchImpl: artifactFetch(bytes, calls) }),
        /origin is not allowlisted/u,
        apiBase,
      );
    }
    assert.equal(calls.length, 0, "origin validation must happen before network I/O");
  });

  // 住所を渡さなくても、環境が自前の仲介や開発用の BuzzAssist を指していれば既定で許さない。
  await withEnv({ BUZZASSIST_MEDIA_JOB_API_BASE: CUSTOM_BASE }, async () => {
    await assert.rejects(() => readPaidMediaJobArtifact(job, { fetchImpl: artifactFetch(bytes, []) }), /origin is not allowlisted/u);
  });
  await withEnv({ BUZZASSIST_API_BASE: "http://127.0.0.1:3000" }, async () => {
    await assert.rejects(() => readPaidMediaJobArtifact(job, { fetchImpl: artifactFetch(bytes, []) }), /origin is not allowlisted/u);
  });

  // 環境に書いた取得元は、自前の仲介でも通る（従来どおり）。
  await withEnv({ BUZZASSIST_MEDIA_ARTIFACT_ORIGINS: "https://happy-otter-123.convex.cloud" }, async () => {
    assert.deepEqual(await readPaidMediaJobArtifact(job, { apiBase: CUSTOM_BASE, fetchImpl: artifactFetch(bytes, []) }), bytes);
  });
});

test("lookalike hosts, other Convex hosts, ports, credentials and plain HTTP are refused even for the official base", async () => {
  await withEnv({}, async () => {
    const bytes = wav();
    const calls = [];
    for (const [url, expected] of [
      ["http://happy-otter-123.convex.cloud/api/storage/a", /must use HTTPS/u],
      ["https://happy-otter-123.convex.cloud.evil.com/api/storage/a", /not allowlisted/u],
      ["https://convex.cloud.evil.com/api/storage/a", /not allowlisted/u],
      ["https://evilconvex.cloud/api/storage/a", /not allowlisted/u],
      ["https://happy-otter-123-convex.cloud/api/storage/a", /not allowlisted/u],
      ["https://convex.cloud/api/storage/a", /not allowlisted/u],
      ["https://a.b.convex.cloud/api/storage/a", /not allowlisted/u],
      ["https://-bad.convex.cloud/api/storage/a", /not allowlisted/u],
      ["https://happy-otter-123.convex.cloud./api/storage/a", /not allowlisted/u],
      ["https://happy-otter-123.convex.cloud:8443/api/storage/a", /not allowlisted/u],
      ["https://happy-otter-123.convex.site/api/storage/a", /not allowlisted/u],
      ["https://user:pass@happy-otter-123.convex.cloud/api/storage/a", /must use HTTPS/u],
    ]) {
      await assert.rejects(
        () => readPaidMediaJobArtifact(completedJob(url, bytes), { apiBase: OFFICIAL_BASE, fetchImpl: artifactFetch(bytes, calls) }),
        expected,
        url,
      );
    }
    assert.equal(calls.length, 0, "no lookalike URL may reach the network");
  });
});
