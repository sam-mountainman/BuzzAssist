// 学びのパターンの記録（純粋な処理だけ。台帳の読み書き・検査語彙の照合は scripts/harness-learn.mjs）。
//
// 提案台帳（proposals.jsonl）は「観測を1件ずつ積む」場所で、まとめる処理（review の clusterForConsolidation、
// lib/harnessLearningCurator.mjs）はあるが、まとめた結果を根拠・当てはまる条件・原因の見立て・反証と結び付けて
// 更新し続ける置き場が無かった。WikiSkill（arXiv 2608.27454）の知識の層の考え方を、既存の台帳の上に小さく足す
// （2026-10-09。論文の読み込みと別文脈のレビューを経て、丸ごとではなくこの形にした）。
//
// 決まり:
// - パターンは提案の上に立つ。元の提案 id を1件以上持ち、提案は書き換えない
// - 記録は版を積むだけ（patterns.jsonl への追記）。最新の版がそのパターンの今の姿。消さない
// - 原因は「見立て」として状態（仮説・確かめた・否定された）を持つ。後から否定されたら版を上げて直す
//   （課金の前提を確かめずに固定した 2026-09-27 の誤りと同じことを、パターンで繰り返さない）
// - 当てはまる条件と、当てはまらない条件を書く。古いモデル向けの回避策が強いモデルを縛る（論文の負の転移）ので、
//   ホスト・モデルの範囲も持てる
// - 学びの束（learned-auto.md）にパターンを使うかは宛先ごとの設定（targets.json の overlayMode: "patterns"）。
//   使うときも、禁止（constraint）の提案は原文のまま残す（短くした規則で必須の条件を落とさない）

export const PATTERN_RECORD_VERSION = "buzzassist-learning-pattern-v1";
export const PATTERN_STATUSES = Object.freeze(["draft", "active", "superseded", "refuted"]);
export const CAUSE_STATUSES = Object.freeze(["hypothesis", "confirmed", "refuted"]);
export const PATTERN_HOSTS = Object.freeze(["claude", "codex"]);

const PATTERN_ID = /^pat-[a-z0-9][a-z0-9-]{2,62}$/u;
const MAX = Object.freeze({ title: 80, rule: 400, text: 600, note: 300, items: 40, listText: 300 });

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value) {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}

function length(value) {
  return Array.from(String(value || "")).length;
}

/**
 * 入力（JSON）を検証して、追記する1版を作る。台帳・検査語彙は見ない（呼ぶ側が渡す）。
 *
 * @param input       { id, target, title, rule, problem, appliesWhen, notWhen?, causeHypotheses[], proposalIds[],
 *                      scope?, successEvidence?, counterEvidence?, changeIds?, evalRefs?, status, supersededBy?, note }
 * @param options.resolveTarget  旧名を新しい宛先へ寄せる関数
 * @param options.knownTargets   宛先の一覧（targets.json のキー）
 * @param options.proposalTargets 提案 id → 解決後の宛先（台帳にある提案だけ）
 * @param options.previous       同じ id の最新の版（無ければ null）
 * @param options.patternIds     既にある id（supersededBy の照合）
 */
export function buildPatternRevision(input, {
  now,
  actor = "agent",
  resolveTarget = (value) => value,
  knownTargets = [],
  proposalTargets = new Map(),
  previous = null,
  patternIds = new Set(),
} = {}) {
  const problems = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { record: null, problems: ["パターンは JSON の object で渡してください"] };
  }
  const id = text(input.id);
  if (!PATTERN_ID.test(id)) problems.push("id は pat- で始まる英小文字・数字・ハイフン（例: pat-billing-source-check）");
  const target = resolveTarget(text(input.target));
  if (!knownTargets.includes(target)) problems.push(`target が宛先の一覧にありません: ${text(input.target) || "（空）"}`);
  if (previous && previous.target !== target) problems.push(`宛先は変えられません（${previous.target} のパターン）。別の id で作ってください`);

  const title = text(input.title);
  const rule = text(input.rule);
  const problem = text(input.problem);
  const appliesWhen = text(input.appliesWhen);
  const notWhen = text(input.notWhen);
  const note = text(input.note);
  if (length(title) < 4 || length(title) > MAX.title) problems.push(`title は 4〜${MAX.title} 文字`);
  if (length(rule) < 12 || length(rule) > MAX.rule) problems.push(`rule（作業する側が読む短い規則）は 12〜${MAX.rule} 文字`);
  if (length(problem) < 8 || length(problem) > MAX.text) problems.push(`problem（何が起きたか）は 8〜${MAX.text} 文字`);
  if (length(appliesWhen) < 4 || length(appliesWhen) > MAX.text) problems.push(`appliesWhen（当てはまる条件）は 4〜${MAX.text} 文字`);
  if (length(notWhen) > MAX.text) problems.push(`notWhen は ${MAX.text} 文字まで`);
  if (length(note) < 4 || length(note) > MAX.note) problems.push(`note（この版で何を変えたか）は 4〜${MAX.note} 文字`);

  const causes = Array.isArray(input.causeHypotheses) ? input.causeHypotheses : [];
  const causeHypotheses = [];
  for (const cause of causes) {
    const causeText = text(cause?.text);
    const status = text(cause?.status) || "hypothesis";
    if (length(causeText) < 4 || length(causeText) > MAX.listText) problems.push(`causeHypotheses の text は 4〜${MAX.listText} 文字`);
    if (!CAUSE_STATUSES.includes(status)) problems.push(`causeHypotheses の status は ${CAUSE_STATUSES.join(" / ")}`);
    causeHypotheses.push({ text: causeText, status });
  }
  if (causeHypotheses.length === 0) problems.push("causeHypotheses（原因の見立て）を1つ以上。確かめていなければ status: hypothesis");

  const proposalIds = [...new Set(stringList(input.proposalIds))];
  if (proposalIds.length === 0) problems.push("proposalIds（元の提案 id）を1つ以上");
  for (const proposalId of proposalIds) {
    const proposalTarget = proposalTargets.get(proposalId);
    if (!proposalTarget) problems.push(`提案 ${proposalId} が台帳にありません`);
    else if (proposalTarget !== target) problems.push(`提案 ${proposalId} の宛先（${proposalTarget}）がパターンの宛先と違います`);
  }

  const evidenceList = (value, label) => {
    const out = [];
    for (const item of Array.isArray(value) ? value : []) {
      const itemText = text(typeof item === "string" ? item : item?.text);
      const ref = text(item?.ref);
      if (length(itemText) < 4 || length(itemText) > MAX.listText) problems.push(`${label} の text は 4〜${MAX.listText} 文字`);
      out.push({ text: itemText, ...(ref ? { ref } : {}) });
    }
    return out;
  };
  const successEvidence = evidenceList(input.successEvidence, "successEvidence");
  const counterEvidence = evidenceList(input.counterEvidence, "counterEvidence");
  const changeIds = [...new Set(stringList(input.changeIds))];
  const evalRefs = [...new Set(stringList(input.evalRefs))];
  for (const [label, list] of [["proposalIds", proposalIds], ["successEvidence", successEvidence], ["counterEvidence", counterEvidence],
    ["changeIds", changeIds], ["evalRefs", evalRefs], ["causeHypotheses", causeHypotheses]]) {
    if (list.length > MAX.items) problems.push(`${label} は ${MAX.items} 件まで`);
  }

  const scopeInput = input.scope && typeof input.scope === "object" ? input.scope : {};
  const hosts = [...new Set(stringList(scopeInput.hosts))];
  for (const host of hosts) if (!PATTERN_HOSTS.includes(host)) problems.push(`scope.hosts は ${PATTERN_HOSTS.join(" / ")}`);
  const models = [...new Set(stringList(scopeInput.models))];
  const scope = {
    ...(hosts.length > 0 ? { hosts } : {}),
    ...(models.length > 0 ? { models } : {}),
  };

  const status = text(input.status) || "draft";
  if (!PATTERN_STATUSES.includes(status)) problems.push(`status は ${PATTERN_STATUSES.join(" / ")}`);
  const supersededBy = text(input.supersededBy);
  if (status === "superseded") {
    if (!supersededBy) problems.push("superseded にするなら supersededBy（置き換えたパターンの id）が要ります");
    else if (supersededBy === id || !patternIds.has(supersededBy)) problems.push(`supersededBy のパターンがありません: ${supersededBy}`);
  }
  if (status === "refuted" && counterEvidence.length === 0) problems.push("refuted にするなら counterEvidence（否定した根拠）が要ります");
  if (status === "active" && !causeHypotheses.some((cause) => cause.status !== "refuted")) {
    problems.push("active のパターンには、否定されていない原因の見立てが1つ以上要ります");
  }

  if (problems.length > 0) return { record: null, problems };
  const record = {
    version: PATTERN_RECORD_VERSION,
    id,
    revision: (Number(previous?.revision) || 0) + 1,
    target,
    title,
    rule,
    problem,
    appliesWhen,
    ...(notWhen ? { notWhen } : {}),
    causeHypotheses,
    proposalIds,
    ...(Object.keys(scope).length > 0 ? { scope } : {}),
    ...(successEvidence.length > 0 ? { successEvidence } : {}),
    ...(counterEvidence.length > 0 ? { counterEvidence } : {}),
    ...(changeIds.length > 0 ? { changeIds } : {}),
    ...(evalRefs.length > 0 ? { evalRefs } : {}),
    status,
    ...(status === "superseded" ? { supersededBy } : {}),
    note,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    updatedBy: actor === "human" ? "human" : "agent",
  };
  return { record, problems: [] };
}

/** 検査語彙と文字列の形の検査にかける本文（パターンの全ての文字列欄）。 */
export function patternInspectionText(record) {
  return [
    record.title, record.rule, record.problem, record.appliesWhen, record.notWhen, record.note,
    ...(record.causeHypotheses || []).map((cause) => cause.text),
    ...(record.successEvidence || []).map((item) => `${item.text} ${item.ref || ""}`),
    ...(record.counterEvidence || []).map((item) => `${item.text} ${item.ref || ""}`),
    ...(record.scope?.models || []),
  ].filter(Boolean).join("\n");
}

/** 台帳の行から、各パターンの最新の版。形の崩れた行は読まない。 */
export function latestPatterns(rows = []) {
  const latest = new Map();
  for (const row of rows) {
    if (row?.version !== PATTERN_RECORD_VERSION || !PATTERN_ID.test(String(row?.id || ""))) continue;
    const previous = latest.get(row.id);
    if (!previous || Number(row.revision) > Number(previous.revision)) latest.set(row.id, row);
  }
  return latest;
}

/**
 * 宛先の未反映の提案を、active のパターンでまとめたものと、まとまっていないものに分ける。
 * 禁止（constraint）の提案は、パターンに入っていても原文のまま残す（mandatory）。
 */
export function patternCoverage(entries = [], patterns = []) {
  const active = patterns.filter((pattern) => pattern.status === "active");
  const coveredBy = new Map();
  for (const pattern of active) {
    for (const proposalId of pattern.proposalIds || []) {
      if (!coveredBy.has(proposalId)) coveredBy.set(proposalId, pattern.id);
    }
  }
  const mandatory = entries.filter((entry) => entry.kind === "constraint");
  const covered = entries.filter((entry) => entry.kind !== "constraint" && coveredBy.has(entry.id));
  const uncovered = entries.filter((entry) => entry.kind !== "constraint" && !coveredBy.has(entry.id));
  const referenced = new Set(entries.map((entry) => entry.id));
  const usedPatterns = active.filter((pattern) => (pattern.proposalIds || []).some((proposalId) => referenced.has(proposalId)));
  return { active: usedPatterns, coveredBy, covered, uncovered, mandatory };
}

const CAUSE_LABEL = Object.freeze({ hypothesis: "見立て", confirmed: "確かめた" });

/**
 * 学びの束のうち、パターンの節。redact は本文の私的語の置き換え（overlay と同じもの）。
 * 原因は否定されたものを載せない。元の提案 id と版を載せて、規則から根拠へ戻れるようにする。
 */
export function renderPatternRuleLines(patterns, redact = (value) => value) {
  const lines = [];
  for (const pattern of patterns) {
    lines.push(`- **${redact(pattern.title)}**: ${redact(pattern.rule)}`);
    lines.push(`  - 当てはまるとき: ${redact(pattern.appliesWhen)}`);
    if (pattern.notWhen) lines.push(`  - 当てはまらないとき: ${redact(pattern.notWhen)}`);
    const scope = [
      ...(pattern.scope?.hosts?.length ? [`ホスト ${pattern.scope.hosts.join("・")}`] : []),
      ...(pattern.scope?.models?.length ? [`モデル ${pattern.scope.models.map((model) => redact(model)).join("・")}`] : []),
    ];
    if (scope.length > 0) lines.push(`  - 範囲: ${scope.join(" / ")}`);
    const causes = (pattern.causeHypotheses || []).filter((cause) => cause.status !== "refuted");
    for (const cause of causes) lines.push(`  - 原因（${CAUSE_LABEL[cause.status] || "見立て"}）: ${redact(cause.text)}`);
    lines.push(`  - パターン: \`${pattern.id}\` 第${pattern.revision}版 / 元の提案: ${(pattern.proposalIds || []).map((id) => `\`${id}\``).join(", ")}`);
  }
  return lines;
}
