// ジャンル別ハーネスが、上位ハーネスの求める条件をそろえているかを表にする（harness-conformance）。
//
// 「どのハーネスも同じ条件で回る」を文章の表で持つと、ハーネスを足した・直したときに表だけが古くなる。
// ここでは宣言（config/harnesses/*.harness.json と *.capabilities.json）と、Core が実際に持っている
// ジャンルごとの部品（上位の Job の adapter・Channel Pack の中身の検査・Receipt の signoff の照合・Canvas の写し）
// と、正本スキル・学習の宛先・試験の実在から、条件ごとに ○（ある）・△（一部）・×（無い）を決める。
// 読むだけ。宣言も Core も書き換えない。
//
// 必須の条件（required）が × のハーネスは、上位ハーネスの下で同じ条件では回らない。試験（test/harnessConformance）は
// 宣言のある全ハーネスで必須の条件が × でないことを確かめる。△ は表と残件に出す（直す順は docs の監査の一覧）。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CONFORMANCE_MARKS = Object.freeze({ ok: "○", partial: "△", missing: "×" });

/** 条件の一覧。label は表の列名、required は「× なら同じ条件で回らない」。 */
export const CONFORMANCE_CONDITIONS = Object.freeze([
  { id: "declaration", label: "ハーネスの宣言と能力カード", required: true },
  { id: "upper-adapter", label: "上位の入口から起動できる（Core の adapter・有料の明示の確認）", required: true },
  { id: "signed-channel-pack", label: "署名済みの Channel Pack（宣言の要件と Core の中身の検査）", required: true },
  { id: "script-quality", label: "台本の品質ループの合格を有料の処理の前に求める", required: true },
  { id: "quality-gates", label: "品質の関門・品質ループの保証", required: true },
  { id: "guarantee-evidence", label: "保証ごとに監査の証拠（evidenceAuditIds）", required: true },
  { id: "separate-signoff", label: "生成と別の文脈の人の確認（署名つきの signoff を Receipt で照合）", required: true },
  { id: "receipt-gates", label: "RunReceipt に門ごとの判定を写す（receiptAdapter）", required: false },
  { id: "canonical-skills", label: "正本スキルがあり、棚卸しに載っている", required: true },
  { id: "learning-targets", label: "指摘から学ぶ宛先（harness-learn）", required: true },
  { id: "canvas-progress", label: "途中の成果物を Canvas へ写す", required: false },
  { id: "tests", label: "試験", required: true },
]);

function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, "utf8")) };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function mark(status, detail) {
  return { status, mark: CONFORMANCE_MARKS[status], detail };
}

function listHarnessIds(repoRoot) {
  const dir = path.join(repoRoot, "config", "harnesses");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".harness.json"))
    .map((name) => name.slice(0, -".harness.json".length))
    .sort();
}

function testFilesMentioning(repoRoot, harnessId) {
  const dir = path.join(repoRoot, "test");
  if (!existsSync(dir)) return [];
  const hits = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".test.mjs")) continue;
    let text = "";
    try { text = readFileSync(path.join(dir, name), "utf8"); } catch { continue; }
    if (text.includes(harnessId)) hits.push(name);
  }
  return hits;
}

/** Core が持っているジャンルごとの部品（読み込みに失敗したら空にして、その条件を × にする）。 */
export async function loadCoreSupport() {
  const support = { upperAdapters: [], packPayloads: [], signoffSubjects: [], canvasProgress: [] };
  try {
    const adapters = await import("./videoHarnessAdapters.mjs");
    support.upperAdapters = [...(adapters.UPPER_JOB_ADAPTER_HARNESS_IDS || [])];
    support.packPayloads = [...(adapters.CHANNEL_PACK_PAYLOAD_HARNESS_IDS || [])];
  } catch { /* 表で × になる */ }
  try {
    support.signoffSubjects = [...((await import("./videoHarnessReceipt.mjs")).SIGNOFF_BINDING_SUBJECTS || [])];
  } catch { /* 表で × になる */ }
  try {
    support.canvasProgress = [...((await import("./videoHarnessCanvasAdapter.mjs")).PROGRESS_SNAPSHOT_HARNESS_IDS || [])];
  } catch { /* 表で × になる */ }
  return support;
}

const QUALITY_GUARANTEE = /quality|final-audit|gate/u;

/**
 * 1つのハーネスの条件を判定する。declaration / capabilities は読み込んだ JSON（読めなければ null）。
 */
export function evaluateHarnessConformance({ harnessId, declaration, capabilities, repoRoot = MODULE_ROOT, support, inventory = null, learningTargets = null }) {
  const results = {};
  const requires = new Set((declaration?.requiresFromOperator || []).map((row) => row?.id));
  const guarantees = Array.isArray(declaration?.guarantees) ? declaration.guarantees : [];

  results.declaration = !declaration
    ? mark("missing", "宣言が読めない")
    : !capabilities
      ? mark("partial", "能力カード（*.capabilities.json）が無い・読めない")
      : capabilities.harnessId !== harnessId || declaration.id !== harnessId
        ? mark("partial", "宣言・能力カードの id がファイル名と違う")
        : mark("ok", `status=${declaration.status || "-"}`);

  results["upper-adapter"] = support.upperAdapters.includes(harnessId)
    ? mark("ok", "run-video-harness の start / resume（--confirmed が無ければ計画だけ）から起動できる")
    : mark("missing", "Core（lib/videoHarnessAdapters.mjs）に上位の Job の adapter が無い。共通の子の約束が要る");

  const packDeclared = requires.has("signed-channel-pack");
  const packChecked = support.packPayloads.includes(harnessId);
  results["signed-channel-pack"] = packDeclared && packChecked
    ? mark("ok", "宣言に要件があり、Core が中身を検査する")
    : packChecked
      ? mark("partial", "Core は中身を検査するが、宣言の requiresFromOperator に signed-channel-pack が無い")
      : packDeclared
        ? mark("partial", "宣言に要件はあるが、Core が中身を検査できない（channel-pack-adapter-missing で止まる）")
        : mark("missing", "宣言にも Core にも無い");

  results["script-quality"] = requires.has("script-quality-acceptance")
    ? mark("ok", "台本の品質ループの合格か人の受け入れを、有料の処理の前に求める")
    : mark("missing", "宣言の requiresFromOperator に script-quality-acceptance が無い");

  const qualityGuarantees = guarantees.filter((row) => QUALITY_GUARANTEE.test(String(row?.id || "")));
  results["quality-gates"] = qualityGuarantees.length > 0
    ? mark("ok", qualityGuarantees.map((row) => row.id).join(", "))
    : mark("missing", "品質の関門・品質ループの保証が宣言に無い");

  const withoutEvidence = guarantees.filter((row) => !Array.isArray(row?.evidenceAuditIds) || row.evidenceAuditIds.length === 0);
  results["guarantee-evidence"] = guarantees.length === 0
    ? mark("missing", "保証が宣言に無い")
    : withoutEvidence.length > 0
      ? mark("partial", `証拠の無い保証: ${withoutEvidence.map((row) => row.id).join(", ")}`)
      : mark("ok", `${guarantees.length} 件すべてに監査の証拠`);

  const subject = String(declaration?.reviewAttestation?.subject || "");
  results["separate-signoff"] = subject && support.signoffSubjects.includes(subject)
    ? mark("ok", `reviewAttestation.subject=${subject}（信頼リストの鍵で署名・Receipt で照合）`)
    : subject
      ? mark("partial", `subject=${subject} の照合が Receipt に無い（completed にならない）`)
      : mark("missing", "宣言に reviewAttestation が無い");

  const adapter = declaration?.receiptAdapter;
  results["receipt-gates"] = adapter?.status === "ready"
    ? mark("ok", String(adapter.implementation || ""))
    : adapter?.status === "pending"
      ? mark("partial", `pending: ${adapter.reason || ""}`)
      : mark("partial", "receiptAdapter の宣言が無い（監査の報告の steps / checks だけを Receipt に写す）");

  const skills = Array.isArray(declaration?.canonicalSkills) ? declaration.canonicalSkills : [];
  const missingSkills = skills.filter((file) => !existsSync(path.join(repoRoot, file)));
  const inventoried = new Set((inventory?.skills || []).flatMap((row) => {
    const canonical = String(row?.canonicalPath || "").replace(/\/+$/u, "");
    return canonical ? [canonical, canonical.endsWith("SKILL.md") ? path.posix.dirname(canonical) : `${canonical}/SKILL.md`] : [];
  }));
  const notInventoried = inventory ? skills.filter((file) => !inventoried.has(file) && !inventoried.has(path.posix.dirname(file))) : [];
  results["canonical-skills"] = skills.length === 0
    ? mark("missing", "canonicalSkills が宣言に無い")
    : missingSkills.length > 0
      ? mark("missing", `無いファイル: ${missingSkills.join(", ")}`)
      : notInventoried.length > 0
        ? mark("partial", `棚卸し（.agents/skills/inventory.manifest.json）に無い: ${notInventoried.join(", ")}`)
        : mark("ok", skills.map((file) => path.basename(path.dirname(file))).join(", "));

  const targets = Array.isArray(declaration?.learningTargets) ? declaration.learningTargets : [];
  const unknownTargets = learningTargets ? targets.filter((target) => !Object.hasOwn(learningTargets, target)) : [];
  results["learning-targets"] = targets.length === 0
    ? mark("missing", "learningTargets が宣言に無い")
    : unknownTargets.length > 0
      ? mark("partial", `学習の宛先の一覧（docs/learning/targets.json）に無い: ${unknownTargets.join(", ")}`)
      : mark("ok", targets.join(", "));

  results["canvas-progress"] = support.canvasProgress.includes(harnessId)
    ? mark("ok", "途中の成果物を写す")
    : mark("partial", "Run と成果物だけを写す（途中の成果物の写しは無い）");

  const tests = testFilesMentioning(repoRoot, harnessId);
  results.tests = tests.length > 0 ? mark("ok", `${tests.length} ファイル`) : mark("missing", "試験が無い");

  const gaps = CONFORMANCE_CONDITIONS
    .filter((condition) => results[condition.id].status !== "ok")
    .map((condition) => ({ condition: condition.id, label: condition.label, required: condition.required, ...results[condition.id] }));
  const failing = gaps.filter((gap) => gap.required && gap.status === "missing");
  return { harnessId, displayName: declaration?.displayName || harnessId, status: declaration?.status || "", results, gaps, conforms: failing.length === 0 };
}

/** リポジトリの全ハーネスの表。 */
export async function harnessConformanceReport({ repoRoot = MODULE_ROOT, support = null } = {}) {
  const core = support || await loadCoreSupport();
  const inventory = readJson(path.join(repoRoot, ".agents", "skills", "inventory.manifest.json"));
  const targets = readJson(path.join(repoRoot, "docs", "learning", "targets.json"));
  const targetMap = targets.ok ? (targets.value?.targets || targets.value) : null;
  const rows = listHarnessIds(repoRoot).map((harnessId) => {
    const declaration = readJson(path.join(repoRoot, "config", "harnesses", `${harnessId}.harness.json`));
    const capabilities = readJson(path.join(repoRoot, "config", "harnesses", `${harnessId}.capabilities.json`));
    return evaluateHarnessConformance({
      harnessId,
      declaration: declaration.ok ? declaration.value : null,
      capabilities: capabilities.ok ? capabilities.value : null,
      repoRoot,
      support: core,
      inventory: inventory.ok ? inventory.value : null,
      learningTargets: targetMap && typeof targetMap === "object" ? targetMap : null,
    });
  });
  return { conditions: CONFORMANCE_CONDITIONS, rows, conforms: rows.every((row) => row.conforms) };
}

/** 表を Markdown にする（列＝ハーネス、行＝条件）。 */
export function conformanceMarkdown(report) {
  const header = ["条件", ...report.rows.map((row) => row.harnessId)];
  const lines = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`];
  for (const condition of report.conditions) {
    const cells = report.rows.map((row) => row.results[condition.id].mark);
    lines.push(`| ${condition.label}${condition.required ? "" : "（任意）"} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}
