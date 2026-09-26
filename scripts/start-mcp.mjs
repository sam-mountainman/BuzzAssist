import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { envWithNodeOnPath } from "../lib/npmInvocation.mjs";
import { missingRuntimeDependencies, npmInstallInvocation } from "../lib/pluginRuntimeDependencies.mjs";
import { appendManagedToolsToPath } from "../lib/prerequisiteTools.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 必須の依存の一覧は lib/pluginRuntimeDependencies.mjs に置く。導入後の検証
// （scripts/verify-plugin-runtime.mjs）が、依存の無い置き場を確かめるときに同じ一覧を使う。
function missingDependencies() {
  return missingRuntimeDependencies(ROOT_DIR);
}

function runNpmInstall() {
  // ホストが起動する MCP server の PATH に npm があるとは限らない（install.sh が
  // ~/.buzzassist/tools/node に入れた Node は PATH に載っていない）。同梱の npm-cli.js を
  // 今動いている Node で起動する。見つからないときだけ従来どおり名前で呼ぶ。
  const { command, args } = npmInstallInvocation();
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    env: {
      ...envWithNodeOnPath(process.env),
      FORCE_COLOR: "0",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm install failed while preparing BuzzAssist MCP (exit ${result.status}).`);
  }
}

if (missingDependencies().length > 0) {
  runNpmInstall();
}

// setup が ~/.buzzassist/tools に入れた ffmpeg / ffprobe を、MCP から起動する全工程に見せる
// （PATH の後ろに足すので、運営者の ffmpeg が先に効く）。
appendManagedToolsToPath(process.env);

process.chdir(ROOT_DIR);
await import(pathToFileURL(path.join(ROOT_DIR, "mcp", "server.mjs")).href);
