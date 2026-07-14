#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("grok 0.2.93 (test)\n");
  process.exit(0);
}

if (args[0] === "models") {
  if (process.env.FAKE_GROK_REFRESH_FAIL === "1") {
    process.stderr.write("authentication refresh failed\n");
    process.exit(1);
  }
  const home = process.env.GROK_HOME || join(os.homedir(), ".grok");
  const authPath = join(home, "auth.json");
  const auth = JSON.parse(await readFile(authPath, "utf8"));
  const updateSession = (node) => {
    if (!node || typeof node !== "object") return false;
    if (!Array.isArray(node) && typeof node.key === "string") {
      node.key = process.env.FAKE_GROK_REFRESH_TOKEN || "refreshed-oauth-token";
      node.expires_at = new Date(Date.now() + 60 * 60_000).toISOString();
      return true;
    }
    return Object.values(node).some(updateSession);
  };
  if (!updateSession(auth)) {
    process.stderr.write("no session\n");
    process.exit(1);
  }
  await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`);
  process.stdout.write("grok-4.5\n");
  process.exit(0);
}

process.stderr.write(`unsupported fake Grok CLI arguments: ${args.join(" ")}\n`);
process.exit(1);
