import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";

import {
  formatBestOfNCommand,
  resolveBestOfNInvocation,
  runBestOfN,
} from "../lib/bestOfNRuntime.mjs";

test("explicit JavaScript BON_CLI expands home and uses the active Node runtime", async () => {
  const expected = join("/portable/home", "tools", "bestofn", "bin", "bon.js");
  const invocation = await resolveBestOfNInvocation({
    env: { HOME: "/portable/home", BON_CLI: "~/tools/bestofn/bin/bon.js" },
    cwd: "/project",
    execPath: "/runtime/node",
    accessImpl: async (path) => {
      assert.equal(path, expected);
    },
  });
  assert.deepEqual(invocation, {
    command: "/runtime/node",
    argsPrefix: [expected],
    source: "BON_CLI-path",
  });
});

test("BESTOFN_ROOT works without a user-specific folder name", async () => {
  const expected = join("/opt/shared", "bestofn", "bin", "bon.js");
  const invocation = await resolveBestOfNInvocation({
    env: { BESTOFN_ROOT: "/opt/shared/bestofn" },
    cwd: "/project",
    execPath: "/runtime/node",
    accessImpl: async (path) => {
      if (path !== expected) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  assert.equal(invocation.argsPrefix[0], expected);
  assert.equal(invocation.source, "discovered-file");
});

test("relative BESTOFN_ROOT resolves from the requested working directory", async () => {
  // 本体は相対の root を resolve で解決する。Windows では resolve がドライブ名を
  // 付けるので、期待値も join ではなく resolve で作る。
  const expected = resolve("/project", "vendor", "bestofn", "bin", "bon.js");
  const invocation = await resolveBestOfNInvocation({
    env: { BESTOFN_ROOT: "vendor/bestofn" },
    cwd: "/project",
    execPath: "/runtime/node",
    accessImpl: async (path) => {
      if (path !== expected) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  assert.deepEqual(invocation, {
    command: "/runtime/node",
    argsPrefix: [expected],
    source: "discovered-file",
  });
});

test("does not discover a machine-specific Masao checkout", async () => {
  const attempted = [];
  const invocation = await resolveBestOfNInvocation({
    env: { HOME: "/portable/home" },
    cwd: "/project",
    accessImpl: async (path) => {
      attempted.push(path);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  assert.equal(invocation.source, "PATH");
  assert.ok(attempted.length > 0);
  assert.ok(attempted.every((path) => !path.includes("まさお")));
});

test("falls back to bon on PATH and passes arguments without a shell", async () => {
  const calls = [];
  const result = await runBestOfN(["serve", "-d"], {
    env: {},
    cwd: "/project",
    accessImpl: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    execFileImpl: async (...args) => {
      calls.push(args);
      return { stdout: "ok", stderr: "" };
    },
  });
  assert.equal(result.stdout, "ok");
  assert.equal(result.invocation.source, "PATH");
  assert.equal(calls[0][0], "bon");
  assert.deepEqual(calls[0][1], ["serve", "-d"]);
});

test("missing PATH command gives portable setup guidance", async () => {
  await assert.rejects(
    () => runBestOfN(["serve"], {
      env: {},
      cwd: "/project",
      accessImpl: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      execFileImpl: async () => { throw Object.assign(new Error("spawn bon ENOENT"), { code: "ENOENT" }); },
    }),
    /BON_CLI.*absolute/u,
  );
});

test("formatted next command quotes paths with spaces", () => {
  assert.equal(
    formatBestOfNCommand({ command: "/runtime/node", argsPrefix: ["/path with spaces/bon.js"] }, ["serve", "-d"]),
    '/runtime/node "/path with spaces/bon.js" serve -d',
  );
});
