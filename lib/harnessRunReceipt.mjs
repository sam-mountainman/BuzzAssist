// RunReceipt — 1回の本番実行が、何によって、どう検証されて出たかの記録
//
// これが無いと答えられないことが3つある:
//
//   1. この成果物は、どのハーネスのどの版が作ったのか
//   2. 宣言したゲートは、本当に全部走ったのか
//   3. ハーネスを直したら、実際に良くなったのか
//
// 3が答えられないと、自己改善のループが閉じない。スキルを賢くしても、
// 賢くなったかどうかを測る面が無いからだ。運営者の手元で回ったハーネスの
// 結果がこちら側に返ってくる道も、この記録が共通の形を持って初めて作れる。
//
// 設計の要は1つだけ——**走っていないゲートを「通った」と書けないこと**。
// このコードベースで繰り返し見つかった不具合は、機能が動いていないことでは
// なく「検証したと書いてあるのに検証していない」ことだった。finalizer が
// 観測文をハードコードして自分を pass にする、full-decode が一度もデコード
// していない、欠落を許可として扱う。記録の層で同じことをすれば、
// 嘘の証跡が増えるだけで何も良くならない。だからここでは、
// 宣言されたゲートに verdict が1つでも欠けていれば finalize が失敗する。

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export const RUN_RECEIPT_VERSION = "harness-run-receipt-v1";

// 指紋の区切り。制御文字（特に NUL）は使わない——git がファイルを binary と
// みなして diff も grep も履歴書き換えも効かなくなる事故を実際に出した。
const FIELD_SEPARATOR = "\u001f";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function digestFile(path) {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

/** ディレクトリ配下を相対パス順に畳んだ指紋。中身は返さない。 */
function digestTree(root, { extensions = null } = {}) {
  if (!existsSync(root)) return null;
  const files = [];
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!extensions || extensions.some((ext) => entry.name.endsWith(ext))) files.push(full);
    }
  };
  if (statSync(root).isFile()) files.push(root);
  else walk(root);
  if (files.length === 0) return null;
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(root, file));
    hash.update(FIELD_SEPARATOR);
    hash.update(readFileSync(file));
    hash.update(FIELD_SEPARATOR);
  }
  return { digest: hash.digest("hex"), fileCount: files.length };
}

/**
 * 走ったハーネスの指紋。3層それぞれを別に取る——どの層を直したら
 * 結果が変わったのかが、層を混ぜた1つのハッシュでは分からないため。
 */
export function computeHarnessBuild({ projectDir = process.cwd(), harnessId, repoRoot = REPO_ROOT } = {}) {
  const declarationPath = join(repoRoot, "config", "harnesses", `${harnessId}.harness.json`);
  if (!existsSync(declarationPath)) {
    throw new Error(`ハーネス宣言が見つからない: ${harnessId}。config/harnesses/${harnessId}.harness.json を先に置くこと。`);
  }
  const declaration = JSON.parse(readFileSync(declarationPath, "utf8"));

  const genreSkills = {};
  for (const skillName of declaration.canonicalSkills || []) {
    const skillRoot = join(repoRoot, ".agents", "skills", skillName);
    const tree = digestTree(skillRoot, { extensions: [".md", ".json", ".mjs"] });
    // learned-auto.md は自己改善で書き換わる層なので、別に出す。
    // 混ぜると「スキル本体は変えていないのに指紋が動いた」が読めない。
    const overlay = digestFile(join(skillRoot, "references", "learned-auto.md"));
    genreSkills[skillName] = { tree: tree?.digest || null, fileCount: tree?.fileCount || 0, learnedOverlay: overlay };
  }

  // platform craft の指紋。全ジャンルで共有される道具なので、
  // ここが動いたときは全ハーネスの結果を疑う必要がある。
  const platformModules = ["lib/harnessRouting.mjs", "lib/channelPackResolver.mjs", "lib/harnessRunReceipt.mjs"];
  const platform = {};
  for (const rel of platformModules) platform[rel] = digestFile(join(repoRoot, rel));

  // Channel Pack は id と指紋だけ。中身も名前も記録に残さない——
  // この記録はプラットフォーム側へ返る前提なので、返せないものは入れない。
  const packRoot = join(resolve(projectDir), "channel-packs");
  let channelPack = null;
  if (existsSync(packRoot)) {
    const ids = readdirSync(packRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    channelPack = ids.map((id) => {
      const tree = digestTree(join(packRoot, id), { extensions: [".json"] });
      return { packId: id, digest: tree?.digest || null, fileCount: tree?.fileCount || 0 };
    });
  }

  return {
    harness: { id: declaration.id, version: declaration.version, declarationDigest: sha256(readFileSync(declarationPath)) },
    genreSkills,
    platform,
    channelPack,
    declaredGates: (declaration.guarantees || []).map((entry) => entry.id),
  };
}

/**
 * 記録を開く。宣言された保証がそのままゲートの一覧になる——
 * 走らせる側が一覧を自分で書ける形にすると、都合の悪いゲートを
 * 一覧から外すだけで「全部通った」と書けてしまう。
 */
export function openRunReceipt({ projectDir = process.cwd(), harnessId, entrypoint, action, inputs = {}, repoRoot = REPO_ROOT } = {}) {
  if (!entrypoint) throw new Error("RunReceipt には entrypoint が要る。どの入口から走ったかが分からない記録は使えない。");
  const build = computeHarnessBuild({ projectDir, harnessId, repoRoot });
  const inputDigests = {};
  for (const [key, value] of Object.entries(inputs)) {
    // 入力そのものは記録しない。台本の本文が記録に残ると、記録を
    // プラットフォームへ返せなくなる。
    inputDigests[key] = typeof value === "string" ? sha256(value) : sha256(JSON.stringify(value ?? null));
  }
  return {
    version: RUN_RECEIPT_VERSION,
    harnessBuild: build,
    entrypoint,
    action: action || "",
    inputDigests,
    gates: {},
    unexpectedGates: [],
    finalized: false,
  };
}

/**
 * ゲートの判定を1件記録する。証拠の指紋を必ず要求する——
 * 判定だけを受け取る形にすると、何も見ずに pass と書ける。
 */
export function recordGate(receipt, { id, verdict, evidence, detail = "" } = {}) {
  if (receipt?.finalized) throw new Error("finalize 済みの RunReceipt にゲートは足せない。");
  if (!id) throw new Error("ゲートには id が要る。");
  if (!["pass", "fail", "skip"].includes(verdict)) {
    throw new Error(`ゲート ${id} の verdict は pass/fail/skip のいずれか: ${verdict}`);
  }
  if (evidence === undefined || evidence === null || evidence === "") {
    throw new Error(`ゲート ${id} には証拠が要る。判定だけを受け取ると、何も見ずに pass と書けてしまう。`);
  }
  if (verdict === "skip" && !String(detail || "").trim()) {
    throw new Error(`ゲート ${id} を skip にするなら理由が要る。理由のない skip は、要件を満たしたことにされる。`);
  }
  if (!receipt.harnessBuild.declaredGates.includes(id)) {
    // 宣言に無いゲートは捨てずに別枠へ。捨てると、宣言の更新漏れが
    // 誰にも見えないまま残る。
    receipt.unexpectedGates.push(id);
  }
  receipt.gates[id] = {
    verdict,
    evidenceDigest: typeof evidence === "string" ? sha256(evidence) : sha256(JSON.stringify(evidence)),
    detail: String(detail || "").slice(0, 500),
  };
  return receipt;
}

/**
 * 実測監査の結果から、宣言された保証の判定を埋める。
 *
 * 保証は抽象語（「最終監査」「音声品質ゲート」）で、実際に測っているのは
 * その下の18項目。対応を書かずに保証だけ記録できる形にすると、
 * 1つも走っていない状態でも「4つ全部通った」と書けてしまう。
 * だからここでは、宣言に evidenceAuditIds があることを要求し、
 * 紐づいた監査が1件でも欠けていれば保証を pass にしない。
 *
 * @param steps 実測監査の結果 [{ id, pass, detail }]
 */
export function recordGatesFromAuditSteps(receipt, { declaration, steps, requiredAuditIds = null, contractVersion = "" }) {
  const byId = new Map((steps || []).map((step) => [step.id, step]));
  // 契約は版で増減する。当時の契約に無かった監査を「未実施」と数えると、
  // 過去のエピソードが後から一斉に不合格になる——実際 v50 のエピソードを
  // v51 の契約で測って、その版に存在しない audio-speaker-continuity の
  // ぶんだけ落ちた。効力のあった契約が分かるならそれで測る。
  const inForce = Array.isArray(requiredAuditIds) && requiredAuditIds.length > 0 ? new Set(requiredAuditIds) : null;
  for (const guarantee of declaration?.guarantees || []) {
    const evidenceIds = guarantee.evidenceAuditIds || [];
    if (evidenceIds.length === 0) {
      throw new Error(
        `保証 ${guarantee.id} に evidenceAuditIds が無い。`
        + "何を測ったら通ったことになるのかを書かない保証は、走っていなくても pass にできる。",
      );
    }
    const applicable = inForce ? evidenceIds.filter((id) => inForce.has(id)) : evidenceIds;
    const notApplicable = evidenceIds.filter((id) => !applicable.includes(id));

    // 契約側が全部消していたら、この保証は測られていない。pass にはしない
    // ——契約が縮んだことで保証が黙って無効になるのが、この種の穴の入口。
    if (applicable.length === 0) {
      recordGate(receipt, {
        id: guarantee.id,
        verdict: "skip",
        evidence: { notApplicable, contractVersion },
        detail: `契約 ${contractVersion || "(版不明)"} にこの保証を裏づける監査が1件も無い: ${evidenceIds.join(", ")}`,
      });
      continue;
    }

    const observed = applicable.map((id) => ({ id, step: byId.get(id) || null }));
    const notRun = observed.filter((entry) => !entry.step).map((entry) => entry.id);
    const failedIds = observed.filter((entry) => entry.step && entry.step.pass !== true).map((entry) => entry.id);
    // 走っていない監査は、落ちた監査と同じに扱う。欠落を通過として
    // 扱う形が、このコードベースで最も繰り返し見つかった不具合だった。
    const verdict = notRun.length > 0 || failedIds.length > 0 ? "fail" : "pass";
    const detail = verdict === "pass"
      ? `${applicable.length}件の実測監査が全て pass`
        + (notApplicable.length > 0 ? `（契約 ${contractVersion || "(版不明)"} 対象外: ${notApplicable.join(", ")}）` : "")
      : `未実施: ${notRun.join(", ") || "なし"} / 不合格: ${failedIds.join(", ") || "なし"}`;
    recordGate(receipt, {
      id: guarantee.id,
      verdict,
      evidence: observed.map((entry) => ({ id: entry.id, pass: entry.step?.pass === true, detail: entry.step?.detail || "" })),
      detail,
    });
  }
  return receipt;
}

/**
 * 記録を閉じる。宣言されたゲートに1つでも判定が無ければ失敗する。
 * ここが緩いと、記録の層でも「検証したと書いてあるのに検証していない」を
 * 再生産することになる。
 */
export function finalizeRunReceipt(receipt, { outcome, knownRemainingIssues = [], timestamp } = {}) {
  if (receipt?.finalized) throw new Error("RunReceipt は二度 finalize できない。");
  if (!timestamp) throw new Error("RunReceipt には timestamp が要る（呼び出し側が渡す）。");
  const declared = receipt.harnessBuild.declaredGates;
  const missing = declared.filter((id) => !receipt.gates[id]);
  const failed = declared.filter((id) => receipt.gates[id]?.verdict === "fail");
  const skipped = declared.filter((id) => receipt.gates[id]?.verdict === "skip");

  if (missing.length > 0) {
    throw new Error(
      `宣言されたゲートに判定が無い: ${missing.join(", ")}。`
      + "記録を閉じる前に走らせるか、理由つきで skip すること——"
      + "判定の欠落を通過として扱うと、この記録は証跡の役に立たない。",
    );
  }

  const requested = outcome === "pass" || outcome === "fail" ? outcome : null;
  if (!requested) throw new Error("outcome は pass か fail。");
  // 申告より実測を優先する。落ちたゲートがあるのに pass と申告されたら
  // pass にはしない——申告を信じる形にした瞬間、記録は自己申告書になる。
  const derived = failed.length > 0 || knownRemainingIssues.length > 0 ? "fail" : requested;

  receipt.finalized = true;
  receipt.finalizedAt = timestamp;
  receipt.outcome = derived;
  receipt.outcomeRequested = requested;
  receipt.outcomeOverridden = derived !== requested;
  receipt.knownRemainingIssues = knownRemainingIssues.map(String);
  receipt.summary = {
    declaredGateCount: declared.length,
    passed: declared.length - failed.length - skipped.length,
    failed: failed.length,
    skipped: skipped.length,
    failedGates: failed,
    skippedGates: skipped,
    unexpectedGates: [...new Set(receipt.unexpectedGates)],
  };
  return receipt;
}

/**
 * プラットフォームへ返す形。チャンネル固有のものを一切含まない。
 * 何が残るか——ハーネスの指紋、ゲートごとの判定、結果。
 * それだけあれば「この版はどのゲートでよく落ちるか」が分かる。
 */
export function redactForPlatform(receipt) {
  if (!receipt?.finalized) throw new Error("finalize していない RunReceipt はプラットフォームへ返せない。");
  return {
    version: receipt.version,
    harness: receipt.harnessBuild.harness,
    genreSkills: receipt.harnessBuild.genreSkills,
    platform: receipt.harnessBuild.platform,
    // pack は「いくつあったか」だけ。id も digest も返さない。
    channelPackCount: Array.isArray(receipt.harnessBuild.channelPack) ? receipt.harnessBuild.channelPack.length : 0,
    entrypoint: receipt.entrypoint,
    action: receipt.action,
    finalizedAt: receipt.finalizedAt,
    outcome: receipt.outcome,
    outcomeOverridden: receipt.outcomeOverridden,
    gates: Object.fromEntries(Object.entries(receipt.gates).map(([id, gate]) => [id, { verdict: gate.verdict }])),
    summary: receipt.summary,
    knownRemainingIssueCount: receipt.knownRemainingIssues.length,
  };
}

/** 原子的に書く。途中で落ちた記録が「完成した記録」に見えないように。 */
export async function writeRunReceipt(receipt, filePath) {
  if (!receipt?.finalized) throw new Error("finalize していない RunReceipt は書けない。");
  const target = resolve(filePath);
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.tmp-${receipt.harnessBuild.harness.declarationDigest.slice(0, 8)}`;
  await writeFile(temp, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await rename(temp, target);
  return target;
}
