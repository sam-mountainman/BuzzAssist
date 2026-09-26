#!/usr/bin/env node
// 人は要所で選ぶだけにする（並べて選ぶ。Claude Code / Codex 共通）
//
//   node scripts/human-choice.mjs routes [--step <工程>] [--stage <並べて選ぶ工程>] [--json]
//        （判断の振り分け: 並べて選ぶ / 1案に赤を入れる / 人に聞かない。どの工程でどれを使うか。
//          --stage を付けると、その工程の決め手の札と、札が採点表のどの項目の候補になるかを出す）
//   node scripts/human-choice.mjs create --work-dir <dir> --harness <id> --stage <工程> --set <組の id> \
//        --candidates <候補の一覧.json> [--question "..."] [--open] [--restart --reason "..."]
//        （候補の組と、見せる1枚の HTML を作る。人に開いてもらう）
//   node scripts/human-choice.mjs choose --work-dir <dir> --stage <工程> --set <組の id> \
//        (--pick <A〜E> | --delegate) [--chip <決め手の札の id>]... [--note "..."] [--page-digest <hex>] \
//        --reviewer <名前> (--human-verified | --agent-attested) [--channel <id>] [--job <Job の ID>]
//        （--pick も --delegate も無ければ、対話端末で聞きながら答える。選んだ人が自分の端末で打つ）
//   node scripts/human-choice.mjs status --work-dir <dir> [--stage <工程> --set <組の id>] [--require-choice] [--json]
//
// 本体は lib/humanChoice.mjs（組・記録・ページ）と lib/humanChoiceLearning.mjs（理由を承認キューへ積む）。
// 説明は docs/human-choice-ja.md。
//
// 終了コード: 0 = 済んだ / 3 = 人待ち（記録していない、または人の選択に数えない）/
//             4 = --require-choice で人の選択が無い / 2 = 入力の誤り

import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import {
  HUMAN_CHOICE_CANDIDATES_VERSION,
  HUMAN_CHOICE_LIMITS,
  HUMAN_CHOICE_STAGES,
  HUMAN_CHOICE_STAGE_IDS,
  HUMAN_DECISION_ROUTES,
  HUMAN_DECISION_TABLE,
  createHumanChoiceSet,
  humanChoiceRubricProposal,
  humanChoiceStatus,
  humanDecisionFor,
  listHumanChoiceSets,
  readHumanChoiceSet,
  recordHumanChoice,
} from "../lib/humanChoice.mjs";
import { captureHumanChoiceLearning } from "../lib/humanChoiceLearning.mjs";
import { learningChannelCliHints } from "../lib/learningChannelResolver.mjs";
import { openLocalFile } from "../lib/openLocalFolder.mjs";

const VALUE_OPTIONS = new Set([
  "--work-dir", "--harness", "--stage", "--set", "--candidates", "--question", "--reason", "--pick", "--note",
  "--page-digest", "--reviewer", "--channel", "--job", "--step",
]);
const REPEATABLE_OPTIONS = new Set(["--chip"]);
const FLAG_OPTIONS = new Set([
  "--json", "--open", "--restart", "--delegate", "--require-choice", "--human-verified", "--agent-attested", "--help", "-h",
]);

function camel(option) {
  return option.replace(/^--?/u, "").replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
}

export function parseHumanChoiceArgs(argv) {
  const [action, ...rest] = argv;
  const args = { action: action || "", chip: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (FLAG_OPTIONS.has(token)) {
      args[token === "-h" ? "help" : camel(token)] = true;
      continue;
    }
    if (VALUE_OPTIONS.has(token) || REPEATABLE_OPTIONS.has(token)) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${token} に値が要ります。`);
      if (REPEATABLE_OPTIONS.has(token)) args[camel(token)].push(value);
      else args[camel(token)] = value;
      index += 1;
      continue;
    }
    throw new Error(`不明なオプション: ${token}`);
  }
  return args;
}

export function humanChoiceHelp() {
  const stages = HUMAN_CHOICE_STAGE_IDS.map((id) => `${id}（${HUMAN_CHOICE_STAGES[id].label}）`).join(" / ");
  return `人は要所で選ぶだけにする（並べて選ぶ）

  人に聞くのは「どれがいいか」を機械が決められない少数の点だけ。候補を ${HUMAN_CHOICE_LIMITS.minCandidates}〜${HUMAN_CHOICE_LIMITS.maxCandidates} 案（目安 ${HUMAN_CHOICE_LIMITS.recommendedCandidates}）、
  設計の軸を分けて出し、人は1つ選んで決め手（${HUMAN_CHOICE_LIMITS.maxReasonChips} つまで）か一言を言う。理由は、そのチャンネルの
  採点表に足す候補として学習の台帳の承認キュー（チャンネルの保存先の proposals）へ積む。採点表（署名済みの
  Channel Pack）は書き換えない。説明と、工程ごとの振り分けは docs/human-choice-ja.md。

  工程: ${stages}

  routes    判断の振り分け（${Object.values(HUMAN_DECISION_ROUTES).map((row) => `${row.label}＝${row.ask}`).join(" / ")}）を工程ごとに出す
    [--step <工程>] [--json]
    [--stage <並べて選ぶ工程>]    その工程の決め手の札（id・言葉）と、札が採点表のどの項目の候補になるか

  create    候補の組と、見せる1枚の HTML を作る（状態は <work-dir>/quality/choices/<工程>--<組>.json、ページは .html）
    --work-dir <dir> --harness <id> --stage <工程> --set <組の id> --candidates <候補の一覧.json> [--question "..."]
    [--open]                      ページを OS の既定のアプリで開く
    [--restart --reason "..."]    選択の記録がある組を出し直す（前の組と記録は history に残る）
    候補の一覧: { "version": "${HUMAN_CHOICE_CANDIDATES_VERSION}", "question"?,
                 "candidates": [{ "path": "<作業フォルダの中のファイル>" | "text": "<文の候補>", "axis": "<設計の軸>", "summary"? }],
                 "recommended"?: { "index": <1 から。一覧の順>, "reason": "..." } }
    軸は候補ごとに分ける（同じ指示の乱数違いにしない）。並べる順は生成の順にしない（組の id と中身で決まる）。

  choose    人の選択を記録する。選んだ人が自分の対話端末から --human-verified を付けたときだけ人の選択に数え、
            理由を承認キューへ積む。--agent-attested は agent-self-attested として残るが数えず、学習にも積まない
    --work-dir <dir> --stage <工程> --set <組の id> --reviewer <名前> (--human-verified | --agent-attested)
    (--pick <A〜E> | --delegate)  選んだ案か、お任せ（推奨の案。推奨の無い組では使えない。学習には積まない）
    [--chip <札の id>]...         決め手（${HUMAN_CHOICE_LIMITS.maxReasonChips} つまで。札の一覧は routes --stage <工程> とページに出る）
    [--note "..."]               一言（${HUMAN_CHOICE_LIMITS.noteMinChars} 文字以上）。決め手か一言のどちらかは要る（お任せを除く）
    [--page-digest <hex>]         ページが書いた組の digest。候補の組が変わった後の古いページの答えは記録しない
    [--channel <id>] [--job <Job の ID>]  学習を積むチャンネル（asset-quality-loop の record と同じ決め方）
    --pick も --delegate も無ければ、対話端末で候補と札を見せて聞く（--human-verified のときだけ）

  status    組の状態。選んだ案・理由・次の生成へ入れる一文（guidance）を出す
    --work-dir <dir> [--stage <工程> --set <組の id>] [--require-choice] [--json]
    --require-choice: 人の選択（human-verified）が無いか、選んだ案のファイルが変わっていれば終了コード 4

  終了コード: 0 済んだ / 3 人待ち / 4 --require-choice で人の選択が無い / 2 入力の誤り
`;
}

function interactiveTerminal() {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** 対話端末で1行ずつ聞く（Ctrl-C・Ctrl-D は「やめる」＝null）。 */
function terminalQuestioner({ input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, output });
  let closed = false;
  let pending = null;
  rl.on("close", () => {
    closed = true;
    if (pending) {
      const resolvePending = pending;
      pending = null;
      resolvePending(null);
    }
  });
  rl.on("SIGINT", () => rl.close());
  return {
    ask: (question) => new Promise((resolvePromise) => {
      if (closed) {
        resolvePromise(null);
        return;
      }
      pending = resolvePromise;
      rl.question(question, (answer) => {
        pending = null;
        resolvePromise(answer);
      });
    }),
    close: () => {
      if (!closed) rl.close();
    },
  };
}

/**
 * 対話端末で、候補・札を見せて答えを聞く（聞くのは3問: どれ・決め手・一言）。
 * 返す値: { pick, delegate, reasons, note } か、やめたら null。
 */
export async function askHumanChoice({ state, ask, write }) {
  write(`${state.question}\n`);
  for (const candidate of state.candidates) {
    const shown = candidate.kind === "text" ? ` 「${Array.from(candidate.text.replace(/\s+/gu, " ")).slice(0, 200).join("")}」` : "";
    write(`  ${candidate.label}: ${candidate.axis}${candidate.summary ? ` — ${candidate.summary}` : ""}${candidate.path ? `（${candidate.path}）` : ""}${shown}\n`);
  }
  if (state.recommended) write(`  推奨: ${state.recommended.label}（${state.recommended.reason}）\n`);
  write(`  ページ: ${state.pagePath}\n`);
  const labels = state.candidates.map((row) => row.label);
  let pick = "";
  let delegate = false;
  for (;;) {
    const answer = await ask(`どれにしますか（${labels.join("/")}${state.recommended ? "。お任せなら「お任せ」" : ""}。やめるなら q）: `);
    if (answer === null) return null;
    const text = String(answer).trim();
    if (text === "q") return null;
    if (state.recommended && ["お任せ", "おまかせ", "delegate"].includes(text)) {
      delegate = true;
      break;
    }
    if (labels.includes(text.toUpperCase())) {
      pick = text.toUpperCase();
      break;
    }
    write("  候補の記号で答える。\n");
  }
  if (delegate) return { pick: "", delegate: true, reasons: [], note: "" };
  write(`決め手（${HUMAN_CHOICE_LIMITS.maxReasonChips} つまで。番号をスペース区切り。無ければ Enter）:\n`);
  state.chips.forEach((row, index) => write(`  ${index + 1} ${row.label}\n`));
  let reasons = [];
  for (;;) {
    const answer = await ask("> ");
    if (answer === null) return null;
    const numbers = String(answer).trim().split(/[\s,、]+/u).filter(Boolean);
    const picked = numbers.map((value) => state.chips[Number(value) - 1]?.id);
    if (picked.some((id) => !id) || new Set(picked).size > HUMAN_CHOICE_LIMITS.maxReasonChips) {
      write(`  1〜${state.chips.length} の番号を ${HUMAN_CHOICE_LIMITS.maxReasonChips} つまで。\n`);
      continue;
    }
    reasons = [...new Set(picked)];
    break;
  }
  for (;;) {
    const answer = await ask(reasons.length > 0 ? "一言（任意。Enter で飛ばす）: " : `一言（決め手が無いので要る。${HUMAN_CHOICE_LIMITS.noteMinChars} 文字以上）: `);
    if (answer === null) return null;
    const note = String(answer).replace(/\s+/gu, " ").trim();
    if (!note && reasons.length > 0) return { pick, delegate: false, reasons, note: "" };
    if (Array.from(note).length >= HUMAN_CHOICE_LIMITS.noteMinChars) return { pick, delegate: false, reasons, note };
    write(`  ${HUMAN_CHOICE_LIMITS.noteMinChars} 文字以上で書く。\n`);
  }
}

function print(stdout, value, json) {
  if (json) {
    stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const lines = [];
  if (value.detail) lines.push(value.detail);
  for (const issue of value.issues || []) lines.push(`  - ${issue}`);
  stdout.write(`${lines.join("\n")}\n`);
}

function learningLine(learning) {
  if (!learning) return "";
  if (learning.skippedReason) return `理由は承認キューへ積んでいません（${learning.skippedReason}）\n`;
  return `理由 ${learning.captured} 件を ${learning.target}${learning.channelId ? `（チャンネル ${learning.channelId} の保存先）` : ""} の承認キューへ積みました`
    + `（既にあったもの ${learning.duplicates} 件）。反映は node scripts/harness-learn.mjs status${learning.channelId ? ` --channel ${learning.channelId}` : ""} から\n`;
}

async function readCandidatesFile(file) {
  if (!file) throw new Error("--candidates に候補の一覧（JSON）が要ります。");
  try {
    return JSON.parse(await readFile(path.resolve(file), "utf8"));
  } catch {
    throw new Error("--candidates の一覧が JSON として読めない。");
  }
}

export async function runHumanChoiceCli(argv = process.argv.slice(2), {
  env = process.env,
  stdout = process.stdout,
  now,
  captureLearning,
  isInteractive = interactiveTerminal(),
  ask = null,
  openPage = (file) => openLocalFile(file),
  attest = null,
} = {}) {
  const args = parseHumanChoiceArgs(argv);
  if (!args.action || ["--help", "-h", "help"].includes(args.action) || args.help) {
    stdout.write(humanChoiceHelp());
    return { exitCode: args.action ? 0 : 2 };
  }
  if ((args.channel !== undefined || args.job !== undefined) && args.action !== "choose") {
    throw new Error("--channel / --job は choose でだけ使える（学習を積むチャンネルの手がかり）。");
  }
  if (args.chip.length > 0 && args.action !== "choose") throw new Error("--chip は choose でだけ使える（決め手の札）。");
  if (args.reason !== undefined && args.action !== "create") throw new Error("--reason は create --restart でだけ使える（出し直す理由）。決め手は --chip、一言は --note。");
  switch (args.action) {
    case "routes": {
      if (args.stage) {
        const spec = HUMAN_CHOICE_STAGES[args.stage];
        if (!spec) throw new Error(`並べて選ぶ工程ではない: ${args.stage}（${HUMAN_CHOICE_STAGE_IDS.join(" / ")}）`);
        const chips = spec.chips.map((row) => humanChoiceRubricProposal(spec.id, row.id));
        if (args.json) {
          stdout.write(`${JSON.stringify({ stage: spec.id, label: spec.label, rubricHome: spec.rubricHome, chips }, null, 2)}\n`);
          return { exitCode: 0 };
        }
        stdout.write(`${spec.label}（${spec.id}）の決め手の札。反映先: ${spec.rubricHome}\n`);
        for (const row of chips) {
          stdout.write(`  ${row.chip}: ${row.label} → ${row.kind === "existing" ? "既定の評価項目を重く見る" : "足す評価項目の案"} ${row.criterionId}（${row.criterionLabel}）\n`);
        }
        return { exitCode: 0 };
      }
      const rows = args.step ? [humanDecisionFor(args.step)] : HUMAN_DECISION_TABLE;
      if (args.json) {
        stdout.write(`${JSON.stringify({ routes: HUMAN_DECISION_ROUTES, table: rows }, null, 2)}\n`);
        return { exitCode: 0 };
      }
      for (const route of Object.values(HUMAN_DECISION_ROUTES)) stdout.write(`${route.label}（${route.id}）: ${route.ask} — ${route.how}\n`);
      stdout.write("\n");
      for (const row of rows) stdout.write(`  ${row.step}（${row.label}）: ${HUMAN_DECISION_ROUTES[row.route].label} — ${row.entry}\n`);
      return { exitCode: 0 };
    }
    case "create": {
      const input = await readCandidatesFile(args.candidates);
      const result = await createHumanChoiceSet({
        workDir: args.workDir,
        harnessId: args.harness,
        stage: args.stage,
        setId: args.set,
        question: args.question,
        input,
        restart: args.restart === true,
        restartReason: args.reason || "",
        ...(now ? { now } : {}),
      });
      print(stdout, args.json ? result : { ...result, detail: `${result.detail}${result.pagePath ? `\n  ページ: ${result.pagePath}` : ""}` }, args.json);
      if (result.created && args.open) await openPage(result.pagePath);
      return { exitCode: result.created ? 0 : 3, result };
    }
    case "choose": {
      // 学習を積むチャンネルの明示（--channel / --job）。台帳に無いチャンネル・見つからない Job は、記録の前に止める。
      const hints = await learningChannelCliHints({ channelId: args.channel, jobId: args.job, env });
      const capture = captureLearning || ((input) => captureHumanChoiceLearning({ ...input, env }));
      const learn = (input) => capture({ ...input, ...hints.captureInput });
      let answer = { pick: args.pick || "", delegate: args.delegate === true, reasons: args.chip, note: args.note || "" };
      if (!answer.pick && !answer.delegate) {
        if (!(isInteractive && args.humanVerified === true && args.agentAttested !== true)) {
          throw new Error("--pick <A〜E> か --delegate が要ります（聞きながら答えるのは、選ぶ人が自分の対話端末から --human-verified を付けたときだけ）。");
        }
        const state = await readHumanChoiceSet({ workDir: args.workDir, stage: args.stage, setId: args.set });
        if (!state) {
          print(stdout, { issues: ["human-choice-set-not-found"], detail: "候補の組が無い（create で作る）" }, args.json);
          return { exitCode: 3, result: { recorded: false } };
        }
        const terminal = ask ? null : terminalQuestioner({ output: stdout });
        try {
          answer = await askHumanChoice({ state, ask: ask || terminal.ask, write: (text) => stdout.write(text) });
        } finally {
          terminal?.close();
        }
        if (!answer) {
          stdout.write("やめた。何も記録していない。\n");
          return { exitCode: 3, result: { recorded: false, quit: true } };
        }
      }
      const result = await recordHumanChoice({
        workDir: args.workDir,
        stage: args.stage,
        setId: args.set,
        pick: answer.pick,
        delegate: answer.delegate,
        reasons: answer.reasons,
        note: answer.note,
        pageDigest: args.pageDigest,
        reviewer: args.reviewer,
        humanVerified: args.humanVerified === true,
        agentAttested: args.agentAttested === true,
        isInteractive,
        ...(now ? { now } : {}),
        captureLearning: learn,
        ...(attest ? { attest } : {}),
      });
      print(stdout, result, args.json);
      if (!args.json) stdout.write(learningLine(result.learning));
      return { exitCode: result.recorded && result.counted ? 0 : 3, result };
    }
    case "status": {
      if (args.set || args.stage) {
        if (!args.set || !args.stage) throw new Error("1つの組を見るなら --stage と --set の両方が要ります。");
        const result = await humanChoiceStatus({ workDir: args.workDir, stage: args.stage, setId: args.set });
        if (args.json) print(stdout, result, true);
        else {
          print(stdout, result, false);
          if (result.started) {
            for (const candidate of result.candidates) {
              stdout.write(`  ${candidate.label}: ${candidate.axis}${candidate.path ? `（${candidate.path}）` : ""}`
                + `${result.choice?.pick?.label === candidate.label ? " ← 人が選んだ案" : ""}\n`);
            }
            for (const reason of result.choice?.reasons || []) {
              const proposal = humanChoiceRubricProposal(args.stage, reason.chip);
              stdout.write(`  決め手: ${reason.label} → ${proposal.kind === "existing" ? "既定の評価項目" : "足す評価項目の案"} ${proposal.criterionId}\n`);
            }
            if (result.choice?.note) stdout.write(`  一言: ${result.choice.note}\n`);
            stdout.write(`人の選択: ${result.pass ? "あり" : "なし"}\n`);
          }
        }
        if (!result.started) return { exitCode: 3, result };
        return { exitCode: args.requireChoice && !result.pass ? 4 : 0, result };
      }
      const result = await listHumanChoiceSets({ workDir: args.workDir });
      if (args.json) print(stdout, result, true);
      else {
        for (const entry of result.entries) stdout.write(`  ${entry.stage}/${entry.setId}: ${entry.pass ? `人が選んだ案 ${entry.choice}` : "人の選択を待っている"}\n`);
        stdout.write(`全部選ばれた: ${result.entries.length > 0 && result.entries.every((row) => row.pass) ? "はい" : "いいえ"}（${result.entries.length} 組）\n`);
      }
      if (!result.started) return { exitCode: 3, result };
      return { exitCode: args.requireChoice && !result.entries.every((row) => row.pass) ? 4 : 0, result };
    }
    default:
      throw new Error(`不明なアクション: ${args.action}（routes / create / choose / status）`);
  }
}

if (isDirectCli(import.meta.url)) {
  runHumanChoiceCli().then(({ exitCode }) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
