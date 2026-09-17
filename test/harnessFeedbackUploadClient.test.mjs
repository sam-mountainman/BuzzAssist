import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createHarnessFeedbackUploadHandler,
  enrollHarnessFeedbackOperator,
} from "../lib/harnessFeedbackIngest.mjs";
import {
  buildHarnessFeedbackPayload,
  signHarnessFeedbackBundle,
} from "../lib/harnessFeedbackBundle.mjs";
import {
  uploadHarnessFeedbackBundle,
} from "../lib/harnessFeedbackUploadClient.mjs";
import { canonicalJson } from "../lib/channelPackEnvelope.mjs";
import { HARNESS_FEEDBACK_INGEST_RECEIPT_VERSION } from "../lib/harnessFeedbackIngest.mjs";

function digestFor(bundle) {
  return createHash("sha256").update(canonicalJson(bundle)).digest("hex");
}

function validReceipt(bundleDigest, extra = {}) {
  return {
    version: HARNESS_FEEDBACK_INGEST_RECEIPT_VERSION,
    ok: true,
    duplicate: false,
    status: "verified-quarantine",
    bundleDigest,
    ownerApprovalRequired: true,
    ...extra,
  };
}

async function onlyJournal(journalDir) {
  const names = (await readdir(journalDir)).filter((name) => name.endsWith(".json"));
  assert.equal(names.length, 1);
  return JSON.parse(await readFile(join(journalDir, names[0]), "utf8"));
}

async function signedFixture(root) {
  const pair = generateKeyPairSync("ed25519");
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" });
  const payload = buildHarnessFeedbackPayload({
    curatorReport: {
      readOnly: true,
      pending: [{
        id: "6edb2451ffe2",
        kind: "constraint",
        target: "genre:narrated-story-video",
        text: "台本から完成動画までの制作hot pathへYouTube Analyticsやyt-quality-loopを混ぜない",
        occurrences: 1,
        localOccurrenceDigests: ["1".repeat(64)],
        evidenceDigests: ["a".repeat(64)],
      }],
      observedGates: [],
    },
    coreVersion: "0.1.25",
    harnessId: "narrated-story-video",
    harnessVersion: "1.2.0",
    skillDigests: ["b".repeat(64)],
    channelPack: { id: "operator-pack", version: "1.0.0", payloadSha256: "c".repeat(64) },
    sourceHost: "claude-code",
    generatedAt: "2026-09-01T00:00:00.000Z",
  });
  const bundle = await signHarnessFeedbackBundle({ payload, privateKeyPem });
  const bundlePath = join(root, "feedback.json");
  await writeFile(bundlePath, JSON.stringify(bundle));
  return { bundle, bundlePath, publicKeyPem };
}

test("operator uploaderは実HTTP intakeへ届け、journalから二重送信せず再接続する", async () => {
  const root = await mkdtemp(join(tmpdir(), "feedback-uploader-e2e-"));
  const ingestRoot = join(root, "ingest");
  const journalDir = join(root, "journal");
  let server;
  try {
    const fixture = await signedFixture(root);
    await enrollHarnessFeedbackOperator({
      rootDir: ingestRoot,
      operatorId: "operator-upload",
      publicKeyPem: fixture.publicKeyPem,
      allowedHarnessIds: ["narrated-story-video"],
      allowedBuilds: [fixture.bundle.build],
      approvedBy: "buzzassist-owner",
    });
    let requests = 0;
    const handler = createHarnessFeedbackUploadHandler({
      rootDir: ingestRoot,
      uploadToken: "upload-token-not-persisted",
    });
    server = createServer((request, response) => {
      requests += 1;
      return handler(request, response);
    });
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const endpoint = `http://127.0.0.1:${server.address().port}/v1/feedback/bundles`;
    const args = {
      bundlePath: fixture.bundlePath,
      endpoint,
      uploadToken: "upload-token-not-persisted",
      journalDir,
      sleep: async () => {},
    };
    const first = await uploadHarnessFeedbackBundle(args);
    assert.equal(first.status, "delivered");
    assert.equal(first.serverReceipt.bundleDigest, first.bundleDigest);
    const attached = await uploadHarnessFeedbackBundle(args);
    assert.equal(attached.attached, true);
    assert.equal(requests, 1, "delivered journalは同じbundleを再送しない");
    const journal = await readFile(first.journalPath, "utf8");
    assert.equal(journal.includes("upload-token-not-persisted"), false);
  } finally {
    if (server) await new Promise((resolveClose) => server.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  }
});

test("network/5xxだけをretryし、4xxとdigest不一致receiptは恒久失敗で止める", async (t) => {
  await t.test("network then success", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-uploader-retry-"));
    try {
      const fixture = await signedFixture(root);
      let calls = 0;
      const fetchImpl = async () => {
        calls += 1;
        if (calls === 1) throw new Error("temporary network loss");
        if (calls === 2) return new Response(JSON.stringify({ ok: false, error: "busy" }), { status: 503 });
        const bundle = JSON.parse(await readFile(fixture.bundlePath, "utf8"));
        return new Response(JSON.stringify(validReceipt(digestFor(bundle))), { status: 202 });
      };
      const result = await uploadHarnessFeedbackBundle({
        bundlePath: fixture.bundlePath,
        endpoint: "https://feedback.example.test/v1/feedback/bundles",
        uploadToken: "fixture-token",
        journalDir: join(root, "journal"),
        fetchImpl,
        sleep: async () => {},
      });
      assert.equal(result.status, "delivered");
      assert.equal(result.attemptCount, 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const [name, response] of [
    ["HTTP 403", () => new Response(JSON.stringify({ ok: false, code: "forbidden" }), { status: 403 })],
    ["receipt digest mismatch", () => new Response(JSON.stringify(validReceipt("f".repeat(64))), { status: 202 })],
  ]) {
    await t.test(name, async () => {
      const root = await mkdtemp(join(tmpdir(), "feedback-uploader-permanent-"));
      try {
        const fixture = await signedFixture(root);
        let calls = 0;
        const args = {
          bundlePath: fixture.bundlePath,
          endpoint: "https://feedback.example.test/v1/feedback/bundles",
          uploadToken: "fixture-token",
          journalDir: join(root, "journal"),
          fetchImpl: async () => { calls += 1; return response(); },
          sleep: async () => {},
        };
        await assert.rejects(uploadHarnessFeedbackBundle(args), /恒久|結合されていない|正式形式|拒否/u);
        await assert.rejects(uploadHarnessFeedbackBundle(args), /恒久失敗済み/u);
        assert.equal(calls, 1, "permanent failure journalは再送しない");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("responseはstreamで64KiB/Content-Length/timeoutを強制し、恒久失敗で止める", async (t) => {
  for (const [name, response, timeout] of [
    ["chunked oversized", () => new Response("x".repeat((64 * 1024) + 1), { status: 202 }), 1000],
    ["declared oversized", () => new Response("{}", { status: 202, headers: { "content-length": String((64 * 1024) + 1) } }), 1000],
    ["lying short content-length", () => new Response("x".repeat((64 * 1024) + 1), { status: 202, headers: { "content-length": "1" } }), 1000],
    ["body timeout", () => ({
      status: 202,
      headers: new Headers(),
      body: new ReadableStream({ pull() { return new Promise(() => {}); } }),
    }), 5],
  ]) {
    await t.test(name, async () => {
      const root = await mkdtemp(join(tmpdir(), "feedback-uploader-bounded-response-"));
      try {
        const fixture = await signedFixture(root);
        let calls = 0;
        const args = {
          bundlePath: fixture.bundlePath,
          endpoint: "https://feedback.example.test/v1/feedback/bundles",
          uploadToken: "bounded-token",
          journalDir: join(root, "journal"),
          fetchImpl: async () => { calls += 1; return response(); },
          maxAttempts: 4,
          responseTimeoutMs: timeout,
          sleep: async () => {},
        };
        await assert.rejects(uploadHarnessFeedbackBundle(args), /response|receipt|大きすぎる|timeout/u);
        await assert.rejects(uploadHarnessFeedbackBundle(args), /恒久失敗済み/u);
        assert.equal(calls, 1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("serverのtoken echoを成功receipt/失敗journalへ保存しない", async (t) => {
  await t.test("success allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-uploader-redact-success-"));
    try {
      const fixture = await signedFixture(root);
      const token = "success-token-must-never-persist";
      const result = await uploadHarnessFeedbackBundle({
        bundlePath: fixture.bundlePath,
        endpoint: "https://feedback.example.test/v1/feedback/bundles",
        uploadToken: token,
        journalDir: join(root, "journal"),
        fetchImpl: async () => new Response(JSON.stringify(validReceipt(digestFor(fixture.bundle), {
          authorization: `Bearer ${token}`,
          operatorId: token,
          nested: { token },
        })), { status: 202 }),
      });
      assert.deepEqual(Object.keys(result.serverReceipt).sort(), [
        "bundleDigest", "duplicate", "ok", "ownerApprovalRequired", "status", "version",
      ]);
      assert.equal((await readFile(result.journalPath, "utf8")).includes(token), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("error redaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-uploader-redact-error-"));
    try {
      const fixture = await signedFixture(root);
      const token = "failure-token-must-never-persist";
      const journalDir = join(root, "journal");
      await assert.rejects(uploadHarnessFeedbackBundle({
        bundlePath: fixture.bundlePath,
        endpoint: "https://feedback.example.test/v1/feedback/bundles",
        uploadToken: token,
        journalDir,
        fetchImpl: async () => new Response(JSON.stringify({
          ok: false,
          error: `Authorization: Bearer ${token}; ${token}`,
          token,
        }), { status: 403 }),
      }), /拒否/u);
      const bytes = JSON.stringify(await onlyJournal(journalDir));
      assert.equal(bytes.includes(token), false);
      assert.match(bytes, /REDACTED/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("delivered journalのreceipt/成功attempt改変を再接続として受理しない", async () => {
  const root = await mkdtemp(join(tmpdir(), "feedback-uploader-tampered-journal-"));
  try {
    const fixture = await signedFixture(root);
    const journalDir = join(root, "journal");
    let calls = 0;
    const args = {
      bundlePath: fixture.bundlePath,
      endpoint: "https://feedback.example.test/v1/feedback/bundles",
      uploadToken: "fixture-token",
      journalDir,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify(validReceipt(digestFor(fixture.bundle))), { status: 202 });
      },
    };
    const delivered = await uploadHarnessFeedbackBundle(args);
    const journal = JSON.parse(await readFile(delivered.journalPath, "utf8"));
    journal.serverReceipt.echo = "tampered";
    await writeFile(delivered.journalPath, JSON.stringify(journal));
    await assert.rejects(uploadHarnessFeedbackBundle(args), /改変|不正/u);
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized/未知secret fieldのbundleはnetwork前に拒否する", async (t) => {
  await t.test("oversized", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-uploader-oversized-bundle-"));
    try {
      const bundlePath = join(root, "too-large.json");
      await writeFile(bundlePath, Buffer.alloc((1024 * 1024) + 1, 0x20));
      let calls = 0;
      await assert.rejects(uploadHarnessFeedbackBundle({
        bundlePath,
        endpoint: "https://feedback.example.test/v1/feedback/bundles",
        uploadToken: "fixture-token",
        fetchImpl: async () => { calls += 1; throw new Error("not reached"); },
      }), /1\.\.1048576 bytes/u);
      assert.equal(calls, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("unknown secret field", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-uploader-secret-bundle-"));
    try {
      const fixture = await signedFixture(root);
      const polluted = { ...fixture.bundle, apiKey: "must-not-leave-host" };
      await writeFile(fixture.bundlePath, JSON.stringify(polluted));
      let calls = 0;
      await assert.rejects(uploadHarnessFeedbackBundle({
        bundlePath: fixture.bundlePath,
        endpoint: "https://feedback.example.test/v1/feedback/bundles",
        uploadToken: "fixture-token",
        fetchImpl: async () => { calls += 1; throw new Error("not reached"); },
      }), /未許可field|含められない/u);
      assert.equal(calls, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("remote HTTPはHTTPSに限定しendpoint credential/queryを拒否する", async () => {
  const root = await mkdtemp(join(tmpdir(), "feedback-uploader-url-"));
  try {
    const fixture = await signedFixture(root);
    const base = {
      bundlePath: fixture.bundlePath,
      uploadToken: "fixture-token",
      journalDir: join(root, "journal"),
      fetchImpl: async () => { throw new Error("到達してはいけない"); },
    };
    await assert.rejects(
      uploadHarnessFeedbackBundle({ ...base, endpoint: "http://feedback.example.test/v1/feedback/bundles" }),
      /HTTPS/u,
    );
    await assert.rejects(
      uploadHarnessFeedbackBundle({ ...base, endpoint: "https://user:pass@feedback.example.test/v1/feedback/bundles" }),
      /credential/u,
    );
    await assert.rejects(
      uploadHarnessFeedbackBundle({ ...base, endpoint: "https://feedback.example.test/v1/feedback/bundles?token=bad" }),
      /query/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
