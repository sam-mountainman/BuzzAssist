import assert from "node:assert/strict";
import test from "node:test";

import { resolveCodexImageBridgeCwd } from "../lib/mediaGeneration.mjs";

test("bundled Codex image bridge honors an isolated working-directory override", () => {
  assert.equal(
    resolveCodexImageBridgeCwd({ CODEX_IMAGE_BRIDGE_CWD: " /tmp/koya-image-bridge " }, "/project"),
    "/tmp/koya-image-bridge",
  );
  assert.equal(resolveCodexImageBridgeCwd({}, "/project"), "/project");
});
