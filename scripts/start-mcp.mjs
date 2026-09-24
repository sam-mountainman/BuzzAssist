import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { envWithNodeOnPath, resolveNpmInvocation } from "../lib/npmInvocation.mjs";
import { appendManagedToolsToPath } from "../lib/prerequisiteTools.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_DEPENDENCIES = [
  "@excalidraw/excalidraw",
  "@modelcontextprotocol/ext-apps",
  "@modelcontextprotocol/sdk",
  "@vitejs/plugin-react",
  "fractional-indexing",
  "kuromoji",
  "react",
  "react-dom",
  "vite",
  "zod",
];

function dependencyDir(packageName) {
  return path.join(ROOT_DIR, "node_modules", ...packageName.split("/"));
}

function missingDependencies() {
  return REQUIRED_DEPENDENCIES.filter((packageName) => !existsSync(dependencyDir(packageName)));
}

function npmInstallCommand() {
  // ホストが起動する MCP server の PATH に npm があるとは限らない（install.sh が
  // ~/.buzzassist/tools/node に入れた Node は PATH に載っていない）。同梱の npm-cli.js を
  // 今動いている Node で起動する。見つからないときだけ従来どおり名前で呼ぶ。
  const npm = resolveNpmInvocation();
  if (npm.source === "bundled-npm-cli") return { command: npm.command, args: [...npm.args, "install"] };
  if (process.platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "npm", "install"],
    };
  }
  return { command: "npm", args: ["install"] };
}

function runNpmInstall() {
  const { command, args } = npmInstallCommand();
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
