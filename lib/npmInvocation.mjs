import { existsSync } from "node:fs";
import path from "node:path";

/**
 * npm を「いま動いている Node に同梱の npm-cli.js」で呼ぶ。
 *
 * 名前（npm / npm.cmd）で呼ぶと PATH 次第になる。launchd / systemd から起動された
 * 自動更新器や、ホストが起動した MCP server の PATH には npm が無いことが多く、
 * `~/.buzzassist/tools/node` に入れた Node はそもそも PATH に載っていない。
 * 同梱の npm-cli.js を process.execPath で起動すれば、どの起動経路でも同じ npm が動く。
 * 見つからないときだけ、従来どおり名前で呼ぶ（Windows は npm.cmd をシェル経由で）。
 */
export function resolveNpmInvocation({
  execPath = process.execPath,
  platform = process.platform,
  exists = existsSync,
} = {}) {
  const api = platform === "win32" ? path.win32 : path.posix;
  const nodeDir = api.dirname(execPath);
  const candidates = platform === "win32"
    ? [api.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js")]
    : [
        api.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
        api.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
      ];
  for (const candidate of candidates) {
    const resolved = api.resolve(candidate);
    if (exists(resolved)) return { command: execPath, args: [resolved], shell: false, source: "bundled-npm-cli" };
  }
  return platform === "win32"
    ? { command: "npm.cmd", args: [], shell: true, source: "path" }
    : { command: "npm", args: [], shell: false, source: "path" };
}

/**
 * npm の lifecycle script（postinstall の `node scripts/...` など）が同じ Node を使うよう、
 * 実行中の Node の置き場所を PATH の先頭に足した env を返す。npm 自身は足さない。
 */
export function envWithNodeOnPath(env = process.env, { execPath = process.execPath, platform = process.platform } = {}) {
  const api = platform === "win32" ? path.win32 : path.posix;
  const separator = platform === "win32" ? ";" : ":";
  const nodeDir = api.dirname(execPath);
  const next = { ...env };
  const keys = Object.keys(next).filter((key) => /^path$/iu.test(key));
  const key = keys[0] || "PATH";
  // Windows では Path と PATH が両方あると子プロセスで片方しか効かない。中身を合わせて1つにする。
  const parts = [];
  for (const name of keys) {
    for (const part of String(next[name] || "").split(separator)) {
      if (part && !parts.includes(part)) parts.push(part);
    }
  }
  for (const extra of keys.slice(1)) delete next[extra];
  next[key] = [nodeDir, ...parts.filter((part) => part !== nodeDir)].join(separator);
  return next;
}
