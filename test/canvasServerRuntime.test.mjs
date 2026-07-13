import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  CANVAS_SERVER_PROTOCOL_VERSION,
  isCompatibleCanvasServerStatus,
} from "../lib/canvasServerRuntime.mjs";

test("canvas server compatibility rejects stale servers missing required asset APIs", () => {
  const projectDir = "/tmp/buzzassist-project";
  const canvasDir = join(projectDir, "canvas");
  assert.equal(isCompatibleCanvasServerStatus({ clients: 0 }, { canvasDir }), false);
  assert.equal(
    isCompatibleCanvasServerStatus({
      clients: 0,
      protocolVersion: CANVAS_SERVER_PROTOCOL_VERSION,
      canvasDir,
      capabilities: { openAssetsFolder: false },
    }, { canvasDir }),
    false,
  );
  assert.equal(
    isCompatibleCanvasServerStatus({
      clients: 0,
      protocolVersion: CANVAS_SERVER_PROTOCOL_VERSION,
      canvasDir,
      capabilities: { openAssetsFolder: true, syncDeletedAssets: false },
    }, { canvasDir }),
    false,
  );
});

test("canvas server compatibility accepts the current project's complete runtime", () => {
  const projectDir = "/tmp/buzzassist-project";
  const canvasDir = join(projectDir, "canvas");
  assert.equal(
    isCompatibleCanvasServerStatus({
      clients: 1,
      protocolVersion: CANVAS_SERVER_PROTOCOL_VERSION,
      projectDir,
      canvasDir,
      capabilities: { openAssetsFolder: true, syncDeletedAssets: true },
    }, { canvasDir }),
    true,
  );
  assert.equal(
    isCompatibleCanvasServerStatus({
      clients: 1,
      protocolVersion: CANVAS_SERVER_PROTOCOL_VERSION,
      projectDir,
      canvasDir: join("/tmp", "another-project", "canvas"),
      capabilities: { openAssetsFolder: true, syncDeletedAssets: true },
    }, { canvasDir }),
    false,
  );
});
