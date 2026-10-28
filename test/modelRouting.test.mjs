// モデルの振り分け（lib/modelRouting.mjs・config/model-routing.json）の試験。モデルは呼ばない。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MODEL_ROUTING_ENV, SEND_REFUSED_CODE, assertSendable, loadModelRouting, routeCommands, routeFor } from "../lib/modelRouting.mjs";
import { runModelRouteCli } from "../scripts/model-route.mjs";

test("既定の振り分け: 論理・事実・ライセンス・実装は Codex、見て聞いて判断する・長い資料・検索の調べものは Antigravity、段取りは今のエージェント", () => {
  const config = loadModelRouting({ env: {} });
  for (const task of ["code-review", "logic-review", "fact-check", "license-check", "information-gathering", "backend-implementation"]) {
    assert.equal(routeFor(config, task).provider, "codex", task);
  }
  for (const task of ["perceptual-review", "long-document-reading", "grounded-web-research"]) {
    assert.equal(routeFor(config, task).provider, "antigravity", task);
  }
  assert.equal(routeFor(config, "orchestration").provider, "host");
  // 工程からも引ける（完成動画の採点は見て聞いて判断する仕事）。
  assert.equal(routeFor(config, "final-video-review").taskId, "perceptual-review");
  assert.equal(routeFor(config, "harness-code-review").provider, "codex");
  assert.throws(() => routeFor(config, "synthetic-unknown"), /振り分けに無い/u);
});

test("打つコマンド: 呼び出しは agent-cli-bridge、呼んだ後に harness-external-call で記録する。今のエージェントの仕事はコマンドが無い", () => {
  const config = loadModelRouting({ env: {} });
  const route = routeFor(config, "perceptual-review");
  const commands = routeCommands(route, { promptFile: "/tmp/synthetic prompt.md", cwd: "/tmp/w", workDir: "/tmp/w", session: "s1" });
  assert.match(commands.run, /bridge\.sh run gemini --cwd '\/tmp\/w' --prompt-file '\/tmp\/synthetic prompt\.md' --mode ask --model \S+ --effort \S+ --selection-source preference/u);
  assert.match(commands.record, /^node scripts\/harness-external-call\.mjs record --host antigravity --model \S+/u);
  assert.equal(commands.direct, undefined);
  assert.equal(routeCommands(routeFor(config, "orchestration")), null);
  // Codex は bridge が使えないときの直の呼び出しも出す。書き込みを許すのは edit の仕事だけ。
  const ask = routeCommands(routeFor(config, "license-check"), { promptFile: "/tmp/p.md", cwd: "/tmp/w", outputFile: "/tmp/o.md" });
  assert.match(ask.direct, /^codex exec -m \S+ -c 'model_reasoning_effort="\S+"' -s read-only -C '\/tmp\/w' --skip-git-repo-check "\$\(cat '\/tmp\/p\.md'\)" < \/dev\/null > '\/tmp\/o\.md'$/u);
  assert.match(routeCommands(routeFor(config, "backend-implementation")).direct, / -s workspace-write /u);
});

test("送ってはいけない物（鍵・利用者の声や本文・実在の人の声）は止め、運営者の上書きでも外せない", (t) => {
  const config = loadModelRouting({ env: {} });
  assert.throws(() => assertSendable(config, ["secrets"]), { code: SEND_REFUSED_CODE });
  assert.throws(() => assertSendable(config, ["script-text", "real-person-voice"]), { code: SEND_REFUSED_CODE });
  assert.doesNotThrow(() => assertSendable(config, ["script-text"]));
  const dir = mkdtempSync(path.join(tmpdir(), "model-routing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const override = path.join(dir, "override.json");
  // 端末で使えるモデルに差し替える上書き。neverSend を空にしても、既定の禁止は残る。
  writeFileSync(override, JSON.stringify({ providers: { codex: { bridgeProvider: "codex", ledgerHost: "codex", models: ["synthetic-model"], effort: "high" } }, neverSend: [] }));
  const merged = loadModelRouting({ env: { [MODEL_ROUTING_ENV]: override } });
  assert.equal(routeFor(merged, "fact-check").model, "synthetic-model");
  assert.throws(() => assertSendable(merged, ["secrets"]), { code: SEND_REFUSED_CODE });
});

test("CLI: 一覧・回す先とコマンド・送ってはいけない物で終了コード 3", () => {
  let out = "";
  const stdout = { write: (text) => { out += text; } };
  assert.equal(runModelRouteCli(["list"], { stdout, env: {} }), 0);
  assert.match(out, /工程 final-video-review → antigravity/u);
  out = "";
  assert.equal(runModelRouteCli(["fact-check", "--json"], { stdout, env: {} }), 0);
  assert.equal(JSON.parse(out).route.provider, "codex");
  out = "";
  assert.equal(runModelRouteCli(["perceptual-review", "--send", "end-user-data"], { stdout, env: {} }), 3);
  assert.match(out, /送らない物/u);
  assert.throws(() => runModelRouteCli(["fact-check", "--bogus"], { stdout, env: {} }), /知らない引数/u);
});
