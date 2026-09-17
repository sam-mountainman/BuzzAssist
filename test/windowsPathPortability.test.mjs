import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// file URL を `.pathname` でパスにすると、Windows では "/D:/a/..." になり、
// resolve や join を通すと "D:\D:\a\..." という存在しないパスになる。空白も
// "%20" のまま残るので、macOS でも空白を含むパスで壊れる。Windows の CI で
// テストと本体の20件以上がこれで落ちていた。fileURLToPath を使う。
const root = fileURLToPath(new URL("..", import.meta.url));

// npm の files から外している一回限りのスクリプトは対象外（配布に入らない）。
const EXCLUDED_SCRIPT = /^(?:koya-.*-2026.*|tmp-.*|build-koya-setting-sheet-.*|fill-koya-setting-sheet-.*)\.mjs$/u;
const FORBIDDEN = [
  { id: "import.meta.url の pathname", pattern: /new URL\([^()]*,\s*import\.meta\.url\)\.pathname/u },
  { id: "自分自身の URL の pathname", pattern: /new URL\(import\.meta\.url\)\.pathname/u },
  { id: "file URL の pathname", pattern: /startsWith\("file:\/\/"\)\s*\?\s*new URL\([^()]*\)\.pathname/u },
  // ディレクトリの包含を "/" 付きの前方一致で見ると、Windows では中のファイルまで外になる。
  { id: "/ 決め打ちの包含判定", pattern: /startsWith\(`\$\{\w*(?:Dir|Root|Path)\}\/`\)/u },
];

function sourceFiles(dir, { recursive = false, filter = () => true } = {}) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (recursive && name !== "fixtures") out.push(...sourceFiles(full, { recursive, filter }));
      continue;
    }
    if (name.endsWith(".mjs") && filter(name)) out.push(full);
  }
  return out;
}

test("配布コードとテストは file URL を pathname でパスにしない", () => {
  const files = [
    ...sourceFiles(join(root, "lib")),
    join(root, "mcp/server.mjs"),
    ...sourceFiles(join(root, "scripts"), { filter: (name) => !EXCLUDED_SCRIPT.test(name) }),
    // このファイル自身は、壊れた書き方を例として持っているので除く。
    ...sourceFiles(join(root, "test"), { recursive: true }).filter((file) => file !== fileURLToPath(import.meta.url)),
  ];
  assert.ok(files.length > 100, `走査対象が少なすぎる: ${files.length}`);
  const hits = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/u);
    lines.forEach((line, index) => {
      for (const { id, pattern } of FORBIDDEN) {
        if (pattern.test(line)) hits.push(`${relative(root, file)}:${index + 1} ${id}`);
      }
    });
  }
  assert.deepEqual(hits, [], `fileURLToPath を使うこと:\n${hits.join("\n")}`);
});

test("配布する Python スクリプトは、文字コードを明示してテキストを読み書きする", () => {
  // Windows の Python は既定の文字コードがロケール（cp1252 など）になり、日本語の
  // JSON を読んだ時点で UnicodeDecodeError になる（Windows の CI で原画の顔検出が落ちた）。
  // 起動側でも UTF-8 モードにしているが、スクリプトを直接走らせる経路もあるので、
  // 読み書きの側でも明示する。
  const scripts = readdirSync(join(root, "scripts"))
    .filter((name) => name.endsWith(".py") && !/^koya-.*-2026.*\.py$/u.test(name));
  assert.ok(scripts.length > 20, `走査対象が少なすぎる: ${scripts.length}`);
  const hits = [];
  for (const name of scripts) {
    const source = readFileSync(join(root, "scripts", name), "utf8");
    for (const match of source.matchAll(/\.(read_text|write_text)\(/gu)) {
      // 対応する閉じ括弧までに encoding が無ければ既定の文字コードで読み書きしている。
      let depth = 0;
      let end = match.index + match[0].length - 1;
      for (; end < source.length; end += 1) {
        if (source[end] === "(") depth += 1;
        else if (source[end] === ")" && --depth === 0) break;
      }
      const call = source.slice(match.index, end + 1);
      if (!call.includes("encoding")) {
        hits.push(`scripts/${name}:${source.slice(0, match.index).split("\n").length} ${call.slice(0, 60)}`);
      }
    }
  }
  assert.deepEqual(hits, [], `encoding="utf-8" を指定すること:\n${hits.join("\n")}`);
});

test("検査の型は、実際に壊れていた書き方を見つける", () => {
  const broken = [
    'const root = new URL("..", import.meta.url).pathname;',
    "const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), \"..\");",
    'const filePath = raw.startsWith("file://") ? new URL(raw).pathname : raw;',
    "if (!sourcePath.startsWith(`${projectDir}/`) || !await exists(sourcePath)) {",
    "if (outPath !== outputDir && !outPath.startsWith(`${outputDir}/`)) {",
  ];
  for (const line of broken) {
    assert.ok(FORBIDDEN.some(({ pattern }) => pattern.test(line)), `見逃した: ${line}`);
  }
  const fine = [
    'const root = fileURLToPath(new URL("..", import.meta.url));',
    "const extension = extname(new URL(url).pathname);",
    'if (endpoint.pathname === "/") endpoint.pathname = "/v1/feedback/bundles";',
    "if (!parsed.mimeType.startsWith(`${kind}/`)) {",
    "if (layer.route && pathname !== layer.route && !pathname.startsWith(`${layer.route}/`)) {",
  ];
  for (const line of fine) {
    assert.equal(FORBIDDEN.some(({ pattern }) => pattern.test(line)), false, `誤検出: ${line}`);
  }
});
