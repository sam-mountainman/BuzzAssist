#!/usr/bin/env node
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, rename, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { basename, dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const RULES = [
  {
    id: "provider-prefixed-token",
    regex: /\b(?:sk-(?:proj-|svcacct-|ant-api\d{2}-)?|xai-|r8_)[A-Za-z0-9_-]{20,512}\b/gu,
    replace: () => "[REDACTED_PROVIDER_TOKEN]",
  },
  {
    id: "github-token",
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,512}\b/gu,
    replace: () => "[REDACTED_GITHUB_TOKEN]",
  },
  {
    id: "slack-token",
    regex: /\bxox(?:b|p|a|r|s)-[A-Za-z0-9-]{20,512}\b/gu,
    replace: () => "[REDACTED_SLACK_TOKEN]",
  },
  {
    id: "google-api-key",
    regex: /\bAIza[A-Za-z0-9_-]{30,512}\b/gu,
    replace: () => "[REDACTED_GOOGLE_API_KEY]",
  },
  {
    id: "provider-labeled-secret",
    regex: /((?:OPENAI|ELEVENLABS|ANTHROPIC|GROK|XAI|REPLICATE|GOOGLE|GITHUB|SLACK)[A-Z0-9_-]*(?:API[_-]?KEY|TOKEN|SECRET)[A-Z0-9_-]*(?:\\?["']?\s*(?:=|:)\s*\\?["']?))([A-Za-z0-9._-]{20,512})/giu,
    replace: (_match, label) => `${label}[REDACTED_LABELED_SECRET]`,
  },
  {
    id: "elevenlabs-header-secret",
    regex: /((?:xi-api-key)(?:\\?["']?\s*(?:=|:)\s*\\?["']?))([A-Za-z0-9._-]{20,512})/giu,
    replace: (_match, label) => `${label}[REDACTED_ELEVENLABS_KEY]`,
  },
];

function parseArgs(argv) {
  return {
    apply: argv.includes("--apply"),
    failOnFindings: argv.includes("--fail-on-findings"),
    paths: argv.filter((value) => !value.startsWith("--")).map((value) => resolve(value)),
  };
}

export function sanitizeAgentSessionText(input) {
  let text = String(input);
  const matchesByType = {};
  for (const rule of RULES) {
    let count = 0;
    text = text.replace(rule.regex, (...args) => {
      count += 1;
      return rule.replace(...args);
    });
    if (count > 0) matchesByType[rule.id] = count;
  }
  return {
    text,
    matchesByType,
    matchCount: Object.values(matchesByType).reduce((sum, count) => sum + count, 0),
  };
}

function detectBoundaryCrossing(text, initialEnd) {
  let safeEnd = initialEnd;
  for (const rule of RULES) {
    const regex = new RegExp(rule.regex.source, rule.regex.flags);
    for (const match of text.matchAll(regex)) {
      if (match.index < safeEnd && match.index + match[0].length > safeEnd) safeEnd = match.index;
    }
  }
  return safeEnd;
}

async function writeChunk(stream, text) {
  if (!stream || text.length === 0) return;
  if (!stream.write(text, "utf8")) await once(stream, "drain");
}

async function scanOrSanitizeFile(filePath, outputStream = null) {
  const decoder = new StringDecoder("utf8");
  const input = createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  const matchesByType = {};
  let carry = "";
  const processText = async (text, final = false) => {
    if (!final && text.length <= 8192) return text;
    const initialEnd = final ? text.length : text.length - 8192;
    const safeEnd = detectBoundaryCrossing(text, initialEnd);
    const sanitized = sanitizeAgentSessionText(text.slice(0, safeEnd));
    for (const [id, count] of Object.entries(sanitized.matchesByType)) {
      matchesByType[id] = (matchesByType[id] || 0) + count;
    }
    await writeChunk(outputStream, sanitized.text);
    return text.slice(safeEnd);
  };
  for await (const chunk of input) carry = await processText(carry + decoder.write(chunk));
  carry += decoder.end();
  await processText(carry, true);
  return {
    matchesByType,
    matchCount: Object.values(matchesByType).reduce((sum, count) => sum + count, 0),
  };
}

async function sanitizeFile(filePath, apply) {
  const metadata = await stat(filePath);
  const temporaryPath = join(dirname(filePath), `.${basename(filePath)}.redacting-${process.pid}`);
  let outputStream = null;
  if (apply) outputStream = createWriteStream(temporaryPath, { encoding: "utf8", mode: metadata.mode });
  let sanitized;
  try {
    sanitized = await scanOrSanitizeFile(filePath, outputStream);
    if (outputStream) {
      outputStream.end();
      await once(outputStream, "finish");
    }
    if (apply && sanitized.matchCount > 0) {
      await chmod(temporaryPath, metadata.mode);
      await rename(temporaryPath, filePath);
    } else if (apply) {
      await rm(temporaryPath, { force: true });
    }
  } catch (error) {
    outputStream?.destroy();
    if (apply) await rm(temporaryPath, { force: true });
    throw error;
  }
  return {
    filePath,
    matchCount: sanitized.matchCount,
    matchesByType: sanitized.matchesByType,
    changed: apply && sanitized.matchCount > 0,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.paths.length === 0) {
    throw new Error("Usage: node scripts/sanitize-agent-session-secrets.mjs [--apply] [--fail-on-findings] /absolute/session.jsonl ...");
  }
  const files = [];
  for (const filePath of options.paths) files.push(await sanitizeFile(filePath, options.apply));
  const matchCount = files.reduce((sum, row) => sum + row.matchCount, 0);
  process.stdout.write(`${JSON.stringify({
    version: "agent-session-secret-sanitizer-v1",
    mode: options.apply ? "apply" : "dry-run",
    fileCount: files.length,
    matchCount,
    files,
  }, null, 2)}\n`);
  if (!options.apply && options.failOnFindings && matchCount > 0) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  await main();
}
