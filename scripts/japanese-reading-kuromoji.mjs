#!/usr/bin/env node
import kuromoji from "kuromoji";
import { join } from "node:path";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const texts = JSON.parse(input || "[]");
if (!Array.isArray(texts) || texts.some((text) => typeof text !== "string")) {
  throw new Error("Expected a JSON array of strings on stdin.");
}
const tokenizer = await new Promise((resolve, reject) => {
  kuromoji.builder({ dicPath: join(process.cwd(), "node_modules/kuromoji/dict") })
    .build((error, built) => error ? reject(error) : resolve(built));
});
const readings = texts.map((text) => tokenizer.tokenize(text).map((token) => (
  token.reading || token.surface_form
)).join(""));
process.stdout.write(JSON.stringify(readings));
