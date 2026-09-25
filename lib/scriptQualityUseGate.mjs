// 制作の Job が、使う台本について台本の品質ループの答え（scriptQualityVerdict）を有料の処理の前に問う入口。
// ナレーション物語と漫画の両ハーネスが同じものを使う。
//
// 照合そのもの（合格した版と同じ SHA か・人がそのまま使うと認めた SHA か）は lib/scriptQualityLoop.mjs の
// scriptQualityVerdict の1か所だけにある。ここが決めるのは次の4つだけで、判定を2か所に持たない:
//   - 台本の作業フォルダの決め方: Job の options.scriptQualityWorkDir。無ければ start に渡した台本のあるフォルダ
//     （台本スキルは script.md・script-package.json を1つのフォルダに出し、外部モデルの呼び出しの台帳と
//     ループの状態をその quality/ に置く。scripts/script-quality-loop.mjs・harness-external-call.mjs の
//     --work-dir と同じ場所）
//   - ハーネス → 台本のジャンル（lib/scriptQualityLoop.mjs の SCRIPT_QUALITY_GENRES の harnessId から引く）
//   - 止めるときの理由コード（script-quality-required:<verdict の理由コード>）と、次に打つコマンド
//     （依頼者・運営者の台本をそのまま使うなら accept-human、直しを提案するならループ）
//   - 監査に残す記録（台本の SHA・理由コード・受け入れ方・ループの版と点。台本の文・所見・人名・パスは持たない）
//
// 契約のどの版からこの関門が効くか（inForceSince）は、ジャンルの側が決める（漫画は制作契約、ナレーション物語は
// 監査契約）。ここは効力を判定しない。

import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { SCRIPT_QUALITY_GENRES, SCRIPT_QUALITY_VERDICT_CODES, scriptQualityVerdict } from "./scriptQualityLoop.mjs";

export const SCRIPT_QUALITY_USE_VERSION = "buzzassist-script-quality-use-v1";
/** Job の options の鍵（Job の識別子に入る）。 */
export const SCRIPT_QUALITY_WORK_DIR_OPTION = "scriptQualityWorkDir";
/** 止めたときの knownRemainingIssues の頭。後ろに verdict の理由コードが付く。 */
export const SCRIPT_QUALITY_REQUIRED_ISSUE = "script-quality-required";
/** 作業フォルダの指定の誤り（Job を作る前・有料の処理の前に止める）。 */
export const SCRIPT_QUALITY_WORK_DIR_INVALID_CODE = "script-quality-work-dir-invalid";
/** 子へ渡した作業フォルダが、上位 Job の options.scriptQualityWorkDir と違うときの error.code。 */
export const SCRIPT_QUALITY_WORK_DIR_UNBOUND_CODE = "script-quality-work-dir-not-bound-to-job";

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** そのハーネスの台本の品質ループのジャンル。台本の関門を持たないハーネスは ""。 */
export function scriptQualityGenreForHarness(harnessId) {
  const id = nonEmpty(harnessId);
  if (!id) return "";
  return Object.values(SCRIPT_QUALITY_GENRES).find((genre) => genre.harnessId === id)?.id || "";
}

function invalidWorkDir(message) {
  const error = new Error(`${SCRIPT_QUALITY_WORK_DIR_INVALID_CODE}: ${message}`);
  error.code = SCRIPT_QUALITY_WORK_DIR_INVALID_CODE;
  return error;
}

/**
 * 台本の作業フォルダ（絶対パス）。options.scriptQualityWorkDir があればそれ、無ければ台本のあるフォルダ。
 * 値が文字列でない・空白だけのときは止める（黙って台本のフォルダへ倒すと、別の場所のループを見る）。
 * 相対の明示は baseDir（start では Job の projectDir）から解く。MCP の server の作業フォルダ（配布の plugin の
 * フォルダ）から解かない。
 */
export function scriptQualityWorkDirFor({ options = {}, scriptPath = "", baseDir = "" } = {}) {
  const declared = plainObject(options) ? options[SCRIPT_QUALITY_WORK_DIR_OPTION] : undefined;
  if (declared !== undefined) {
    if (!nonEmpty(declared)) throw invalidWorkDir(`options.${SCRIPT_QUALITY_WORK_DIR_OPTION} は台本の作業フォルダの path（空にしない）。`);
    return nonEmpty(baseDir) ? resolve(nonEmpty(baseDir), nonEmpty(declared)) : resolve(nonEmpty(declared));
  }
  if (!nonEmpty(scriptPath)) throw invalidWorkDir("台本の作業フォルダを決められない（台本の path も options の作業フォルダも無い）。");
  return dirname(resolve(nonEmpty(scriptPath)));
}

/**
 * start の時点で、台本の関門を持つハーネスの Job の options に作業フォルダを入れる（Job の識別子に入り、
 * どのループを見るかを後から変えられない）。明示の値は絶対パスへそろえるだけで、上書きしない。
 * 台本の関門を持たないハーネス・ハーネスが決まらないときは options をそのまま返す。
 */
export function withScriptQualityWorkDirDefault({ harnessId = "", options = {}, scriptPath = "", baseDir = "" } = {}) {
  if (!plainObject(options)) return options;
  if (!scriptQualityGenreForHarness(harnessId)) return options;
  return { ...options, [SCRIPT_QUALITY_WORK_DIR_OPTION]: scriptQualityWorkDirFor({ options, scriptPath, baseDir }) };
}

/**
 * 子（narrated-story-video.mjs full / koya-manga-video.mjs full）へ渡した作業フォルダが、上位 Job の
 * options.scriptQualityWorkDir（Job の識別子に入る）と同じ path であること。どちらかだけ・別の path なら止める
 * （別のフォルダのループの合格を持ち込む道を残さない）。どちらも無い（start がまだ既定を入れていなかった Job）は通す。
 */
export function assertScriptQualityWorkDirBoundToJob({ job = null, scriptQualityWorkDir = "" } = {}) {
  const declaredValue = plainObject(job?.options) ? job.options[SCRIPT_QUALITY_WORK_DIR_OPTION] : undefined;
  const declared = nonEmpty(declaredValue);
  const passed = nonEmpty(scriptQualityWorkDir);
  if (!declared && !passed) return;
  if (!declared || !passed || resolve(declared) !== resolve(passed)) {
    const error = new Error(`${SCRIPT_QUALITY_WORK_DIR_UNBOUND_CODE}: the script quality work folder passed to the runner must be the one the outer Job declares in options.${SCRIPT_QUALITY_WORK_DIR_OPTION} (start the Job with --script-quality-work-dir, or let start use the folder of --script-path).`);
    error.code = SCRIPT_QUALITY_WORK_DIR_UNBOUND_CODE;
    throw error;
  }
}

function shellArgument(value) {
  const text = String(value ?? "");
  return /^[A-Za-z0-9_./:@%+=,\\-]+$/u.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

/** accept-human / record の --script に書ける台本の path（作業フォルダの中のときだけ。外なら置き場の説明）。 */
function scriptArgumentFor(workDir, scriptPath, scriptSha256) {
  const path = nonEmpty(scriptPath) ? resolve(nonEmpty(scriptPath)) : "";
  if (path) {
    const rel = relative(workDir, path);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return shellArgument(rel.split(sep).join("/"));
  }
  const sha = nonEmpty(scriptSha256);
  return `<作業フォルダの中の台本（sha256 ${sha ? `${sha.slice(0, 12)}…` : "が今の台本と同じもの"}）>`;
}

/**
 * 止めたときに次に打つコマンド（理由コードごと）。どの理由でも、依頼者・運営者が書いた台本をそのまま使う
 * 口（accept-human。確認した人が自分の対話端末から打つ）を先に、直しを提案する口（ループ）を次に書く。
 * 外側の Job は文字列の next を先頭から 1000 字までしか残さないので、よく使う口を先に置き、1行に1つのコマンドにする。
 */
export function scriptQualityNextCommands({ reasonCode = "", workDir, scriptPath = "", scriptSha256 = "", genre = "" } = {}) {
  const codes = SCRIPT_QUALITY_VERDICT_CODES;
  const dir = shellArgument(resolve(workDir));
  const script = scriptArgumentFor(resolve(workDir), scriptPath, scriptSha256);
  const loop = "node scripts/script-quality-loop.mjs";
  const genreArg = genre || "<ジャンル>";
  const lines = [
    `台本をそのまま使う（依頼者・運営者が書いた台本。確認した人が自分の端末で）: ${loop} accept-human --work-dir ${dir} --script ${script} --reviewer <確認した人> --reason "<誰が書いたか・何を確かめたか>" --human-verified`,
  ];
  const record = `${loop} record --work-dir ${dir} --script ${script} --version <版> --stage revision --review <別の文脈の採点>`;
  switch (reasonCode) {
    case codes.notStarted:
      lines.push(`直しを提案する（ループを始め、別の文脈で採点して record。手順は status で見る）: ${loop} start --work-dir ${dir} --genre ${genreArg} --generator-context <台本を書いた会話ID>`);
      break;
    case codes.noRound:
    case codes.panelIncomplete:
    case codes.notPassed:
      lines.push(`直しを提案する（次の手順は ${loop} status --work-dir ${dir}）: ${record}`);
      break;
    case codes.stopped:
      lines.push(`ループは止まっている。続けるかは人が決める（${loop} status --work-dir ${dir}）。続けるなら: ${loop} start --work-dir ${dir} --restart --reason "<何が変わったか>"`);
      break;
    case codes.changedAfterPass:
      lines.push(`合格した版の後で台本が変わった。今の台本を別の文脈で採点して記録する: ${record}`);
      break;
    case codes.genreMismatch:
      lines.push(`このフォルダのループは別ジャンルの採点表で合格している。${genreArg} で採点するなら別の作業フォルダで ${loop} start --genre ${genreArg} から始め、start の --script-quality-work-dir にそのフォルダを渡す`);
      break;
    case codes.stateInconsistent:
      lines.push(`ループの状態ファイルが契約と採点に合わない（手で書き換えた疑い）。${loop} status --work-dir ${dir} で確かめ、採点をやり直す`);
      break;
    case codes.scriptMissing:
      lines.push("台本のファイルが読めない。Job に保存した台本を確かめる");
      break;
    default:
      lines.push(`ループの状態を確かめる: ${loop} status --work-dir ${dir}`);
  }
  lines.push("済んだら同じ Job を resume する（有料の処理はまだ始めていない）");
  return lines;
}

/**
 * 有料の処理の前に、使う台本（scriptPath のバイト列の SHA）を verdict に問う。合格でなければ pass: false と
 * 理由コード・次のコマンドを返す（例外にはしない。止め方はジャンルが決める）。
 *   - scriptPath: 制作が実際に読む台本（Job に保存した写し）。SHA はこのバイト列で決まる
 *   - commandScriptPath: 次のコマンドに書く台本の path（start に渡した元の台本。作業フォルダの中のときだけ書く）
 */
export async function checkScriptQualityBeforeProduction({
  workDir,
  scriptPath,
  genre,
  commandScriptPath = "",
  verdict = scriptQualityVerdict,
} = {}) {
  const expectedGenre = nonEmpty(genre);
  if (!Object.hasOwn(SCRIPT_QUALITY_GENRES, expectedGenre)) throw new Error(`台本の関門のジャンルが不明: ${genre}`);
  if (!nonEmpty(workDir)) throw invalidWorkDir("台本の作業フォルダが無い。");
  if (!nonEmpty(scriptPath)) throw new Error("台本の関門には、制作が読む台本の path が要る。");
  const dir = resolve(nonEmpty(workDir));
  const answer = await verdict({ workDir: dir, scriptPath: resolve(nonEmpty(scriptPath)), genre: expectedGenre });
  const pass = answer?.pass === true;
  const reasonCode = nonEmpty(answer?.reasonCode) || SCRIPT_QUALITY_VERDICT_CODES.notStarted;
  const scriptSha256 = nonEmpty(answer?.scriptSha256);
  const evidence = {
    version: SCRIPT_QUALITY_USE_VERSION,
    genre: expectedGenre,
    pass,
    reasonCode,
    acceptedBy: pass ? (answer.acceptedBy === "human" ? "human" : "quality-loop") : null,
    scriptSha256,
    loop: {
      status: nonEmpty(answer?.status) || "not-started",
      versionLabel: nonEmpty(answer?.versionLabel),
      score: Number.isFinite(answer?.score) ? answer.score : null,
      targetScore: Number.isFinite(answer?.targetScore) ? answer.targetScore : null,
      contractDigest: nonEmpty(answer?.contractDigest),
    },
    ...(pass && answer.acceptedBy === "human" && answer.humanAcceptance
      ? { humanAcceptance: { recordedAt: nonEmpty(answer.humanAcceptance.recordedAt) } }
      : {}),
  };
  return {
    pass,
    reasonCode,
    acceptedBy: evidence.acceptedBy,
    scriptSha256,
    workDir: dir,
    detail: nonEmpty(answer?.detail),
    evidence,
    issues: pass ? [] : [`${SCRIPT_QUALITY_REQUIRED_ISSUE}:${reasonCode}`],
    next: pass ? [] : scriptQualityNextCommands({ reasonCode, workDir: dir, scriptPath: commandScriptPath, scriptSha256, genre: expectedGenre }),
  };
}
