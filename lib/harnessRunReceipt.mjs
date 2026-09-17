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
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { channelPackRootEntries } from "./channelPackResolver.mjs";
import { productionDependencyIdentity } from "./productionDependencyManifest.mjs";

export const RUN_RECEIPT_VERSION = "harness-run-receipt-v1";

// 指紋の区切り。制御文字（特に NUL）は使わない——git がファイルを binary と
// みなして diff も grep も履歴書き換えも効かなくなる事故を実際に出した。
const FIELD_SEPARATOR = "\u001f";

// new URL(...).pathname は空白を %20 のまま残し、Windows では /C:/... になる。
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
function digestTree(root, { extensions = null, exclude = [] } = {}) {
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
  const excluded = new Set(exclude.map((rel) => join(root, rel)));
  const kept = files.filter((file) => !excluded.has(file));
  if (kept.length === 0) return null;
  const hash = createHash("sha256");
  for (const file of kept) {
    hash.update(relative(root, file));
    hash.update(FIELD_SEPARATOR);
    hash.update(readFileSync(file));
    hash.update(FIELD_SEPARATOR);
  }
  return { digest: hash.digest("hex"), fileCount: kept.length };
}

/**
 * ハーネス宣言の canonicalSkills を、スキルのディレクトリへ解決する。
 * `.agents/skills/<name>/SKILL.md`（完全相対パス）でも `<name>` でも受ける。
 */
function resolveDeclaredSkillRoot(repoRoot, declared) {
  const value = String(declared || "").trim();
  if (!value) return join(repoRoot, ".agents", "skills", "");
  const withoutFile = value.endsWith(".md") ? dirname(value) : value;
  // 区切りを含むならリポジトリルートからの相対パス、含まないならスキル名。
  return withoutFile.includes("/")
    ? join(repoRoot, withoutFile)
    : join(repoRoot, ".agents", "skills", withoutFile);
}

/**
 * 走ったハーネスの指紋。3層それぞれを別に取る——どの層を直したら
 * 結果が変わったのかが、層を混ぜた1つのハッシュでは分からないため。
 */
export function computeHarnessBuild({
  projectDir = process.cwd(),
  harnessId,
  repoRoot = REPO_ROOT,
  deploymentRoot = repoRoot,
  expectedProductionDependencies = null,
  verifiedChannelPack = null,
} = {}) {
  const declarationPath = join(repoRoot, "config", "harnesses", `${harnessId}.harness.json`);
  if (!existsSync(declarationPath)) {
    throw new Error(`ハーネス宣言が見つからない: ${harnessId}。config/harnesses/${harnessId}.harness.json を先に置くこと。`);
  }
  const declaration = JSON.parse(readFileSync(declarationPath, "utf8"));

  const genreSkills = {};
  for (const declared of declaration.canonicalSkills || []) {
    // 宣言は `.agents/skills/<name>/SKILL.md` という完全相対パスで書かれている。
    // スキル名として `.agents/skills/` に連結していたので、存在しない
    // パスを指し、**全スキルの指紋が null になっていた**。
    // 記録の目的が「どの版で壊れたかを後から辿ること」なのに、
    // ジャンル層の指紋が丸ごと空だった。どちらの書き方も受ける。
    const skillRoot = resolveDeclaredSkillRoot(repoRoot, declared);
    const skillName = basename(skillRoot);
    // overlay は別枠で出すので tree から外す。両方に入れると
    // 「スキル本体は変えていないのに tree が動いた」が読めない。
    const tree = digestTree(skillRoot, { extensions: [".md", ".json", ".mjs"], exclude: ["references/learned-auto.md"] });
    // learned-auto.md は自己改善で書き換わる層なので、別に出す。
    // 混ぜると「スキル本体は変えていないのに指紋が動いた」が読めない。
    const overlay = digestFile(join(skillRoot, "references", "learned-auto.md"));
    genreSkills[skillName] = { tree: tree?.digest || null, fileCount: tree?.fileCount || 0, learnedOverlay: overlay };
  }

  // platform craft の指紋。全ジャンルで共有される道具なので、
  // ここが動いたときは全ハーネスの結果を疑う必要がある。
  const platformModules = [
    "lib/harnessRouting.mjs",
    "lib/channelPackResolver.mjs",
    "lib/channelPackEnvelope.mjs",
    "lib/harnessRunReceipt.mjs",
    "lib/harnessRuntimeResolver.mjs",
    "lib/paidMediaJobBroker.mjs",
    "lib/videoHarnessAdapters.mjs",
    "lib/videoHarnessCanvasAdapter.mjs",
    "lib/videoHarnessJob.mjs",
    "lib/videoHarnessReceipt.mjs",
    "lib/videoHarnessService.mjs",
    "lib/canvasRunState.mjs",
    "lib/canvasRunProjection.mjs",
    "lib/canvasRunMediaProjection.mjs",
  ];
  const platform = {};
  for (const rel of platformModules) platform[rel] = digestFile(join(repoRoot, rel));

  // Channel Pack は id と指紋だけ。中身も名前も記録に残さない——
  // この記録はプラットフォーム側へ返る前提なので、返せないものは入れない。
  // 解決層と同じ探索順を使う。`<project>/channel-packs` だけを見ていたので、
  // BUZZASSIST_CHANNEL_PACK で外を指した pack が記録に残らなかった。
  const channelPack = [];
  if (verifiedChannelPack) {
    const digest = String(verifiedChannelPack.payloadSha256 || "").replace(/^sha256:/u, "");
    const fileCount = Number(verifiedChannelPack.fileCount || 0);
    if (!/^[a-f0-9]{64}$/u.test(digest) || !Number.isSafeInteger(fileCount) || fileCount <= 0) {
      throw new Error("署名検証済みChannel Packのpayload SHAまたはfileCountが不正。");
    }
    channelPack.push({
      packId: String(verifiedChannelPack.id || "signed-pack"),
      packVersion: String(verifiedChannelPack.version || "content-sha"),
      source: "signed-envelope",
      digest,
      fileCount,
      signerKeyId: String(verifiedChannelPack.signerKeyId || ""),
      trustedPublicKeyId: String(verifiedChannelPack.trustedPublicKeyId || ""),
    });
  } else {
    for (const entry of channelPackRootEntries(projectDir)) {
      // fixture は合成データなので記録しない。env / pack のどちらも、
      // entry.root そのものが1つの pack ディレクトリ（配下は pack の中身）。
      if (entry.kind === "fixture" || !existsSync(entry.root)) continue;
      const tree = digestTree(entry.root, { extensions: [".json"] });
      channelPack.push({
        packId: basename(entry.root),
        source: entry.kind,
        digest: tree?.digest || null,
        fileCount: tree?.fileCount || 0,
      });
    }
  }

  // 指紋が取れないまま記録を作らない。null の指紋を受理していたせいで、
  // 「全スキルの指紋が null」という状態が長く残った。同じ故障は別環境で
  // いつでも再発する——空の pack、配置替え、パスの取り違え。
  const emptyFingerprints = [
    ...Object.entries(genreSkills).filter(([, v]) => !v.tree || v.fileCount === 0).map(([k]) => `skill:${k}`),
    ...Object.entries(platform).filter(([, v]) => !v).map(([k]) => `platform:${k}`),
    ...(channelPack || []).filter((entry) => !entry.digest || entry.fileCount === 0).map((entry) => `pack:${entry.packId}`),
  ];
  if (emptyFingerprints.length > 0) {
    throw new Error(
      `指紋を取れなかった層がある: ${emptyFingerprints.join(", ")}。`
      + "指紋の無い記録は「どの版で壊れたか」を辿れず、記録の目的を果たさない。"
      + "宣言の canonicalSkills、platform モジュールの配置、Channel Pack の中身を確認すること。",
    );
  }

  const productionDependencies = productionDependencyIdentity({
    runtimeRoot: repoRoot,
    deploymentRoot,
  });
  if (expectedProductionDependencies
    && JSON.stringify(productionDependencies) !== JSON.stringify(expectedProductionDependencies)) {
    throw new Error(
      "Production dependency treeがJob計画時と一致しない。"
      + "transitive moduleを含む実行コードが変更されたため、新しいJobとして計画し直すこと。",
    );
  }

  return {
    harness: { id: declaration.id, version: declaration.version, declarationDigest: sha256(readFileSync(declarationPath)) },
    genreSkills,
    platform,
    productionDependencies,
    channelPack: channelPack.length > 0 ? channelPack : null,
    declaredGates: (declaration.guarantees || []).map((entry) => entry.id),
  };
}

/**
 * 記録を開く。宣言された保証がそのままゲートの一覧になる——
 * 走らせる側が一覧を自分で書ける形にすると、都合の悪いゲートを
 * 一覧から外すだけで「全部通った」と書けてしまう。
 */
export function openRunReceipt({
  projectDir = process.cwd(),
  harnessId,
  entrypoint,
  action,
  inputs = {},
  repoRoot = REPO_ROOT,
  deploymentRoot = repoRoot,
  expectedProductionDependencies = null,
  verifiedChannelPack = null,
} = {}) {
  if (!entrypoint) throw new Error("RunReceipt には entrypoint が要る。どの入口から走ったかが分からない記録は使えない。");
  const build = computeHarnessBuild({
    projectDir,
    harnessId,
    repoRoot,
    deploymentRoot,
    expectedProductionDependencies,
    verifiedChannelPack,
  });
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
    approvals: [],
    artifacts: [],
    mediaJobs: [],
    finalized: false,
  };
}

/** 成果物のpathや本文を持たず、種類・byte数・SHAだけを記録する。 */
export function recordRunArtifact(receipt, { kind, sha256: digest, bytes = null, mimeType = "" } = {}) {
  if (receipt?.finalized) throw new Error("finalize 済みの RunReceipt に成果物は足せない。");
  if (!Array.isArray(receipt?.artifacts)) throw new Error("RunReceipt の artifacts が壊れている。");
  const normalizedDigest = String(digest || "").replace(/^sha256:/u, "");
  if (!String(kind || "").trim() || !/^[a-f0-9]{64}$/u.test(normalizedDigest)) {
    throw new Error("成果物にはkindとSHA-256が要る。");
  }
  const normalizedBytes = bytes === null || bytes === undefined ? null : Number(bytes);
  if (normalizedBytes !== null && (!Number.isSafeInteger(normalizedBytes) || normalizedBytes < 0)) {
    throw new Error("成果物bytesが不正。");
  }
  receipt.artifacts.push({
    kind: String(kind),
    sha256: normalizedDigest,
    bytes: normalizedBytes,
    mimeType: String(mimeType || ""),
  });
  return receipt;
}

/** paidMediaJobReceiptSummaryのallowlistだけをRunReceiptへ移す。 */
export function recordPaidMediaJob(receipt, summary = {}) {
  if (receipt?.finalized) throw new Error("finalize 済みの RunReceipt にMedia Jobは足せない。");
  if (!Array.isArray(receipt?.mediaJobs)) throw new Error("RunReceipt の mediaJobs が壊れている。");
  const inputHash = String(summary.inputHash || "").replace(/^sha256:/u, "");
  if (!String(summary.provider || "").trim() || !String(summary.kind || "").trim()
    || !/^[a-f0-9]{64}$/u.test(inputHash)) {
    throw new Error("Media Jobにはprovider、kind、inputHashが要る。");
  }
  const finiteOrNull = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
  receipt.mediaJobs.push({
    version: String(summary.version || ""),
    jobId: String(summary.jobId || ""),
    providerJobId: String(summary.providerJobId || ""),
    requestKeyDigest: sha256(String(summary.requestKey || "")),
    status: String(summary.status || ""),
    kind: String(summary.kind),
    provider: String(summary.provider),
    adapterVersion: String(summary.adapterVersion || ""),
    model: String(summary.model || ""),
    voiceId: String(summary.voiceId || ""),
    inputHash,
    reservation: {
      reservationId: String(summary.reservation?.reservationId || ""),
      status: String(summary.reservation?.status || ""),
      estimatedSeconds: finiteOrNull(summary.reservation?.estimatedSeconds),
      estimatedUnits: finiteOrNull(summary.reservation?.estimatedUnits),
      estimatedCost: finiteOrNull(summary.reservation?.estimatedCost),
      currency: String(summary.reservation?.currency || ""),
    },
    usage: {
      seconds: finiteOrNull(summary.usage?.seconds),
      units: finiteOrNull(summary.usage?.units),
      cost: finiteOrNull(summary.usage?.cost),
      currency: String(summary.usage?.currency || ""),
      freeRegeneration: summary.usage?.freeRegeneration === true,
    },
    artifact: {
      sha256: String(summary.artifact?.sha256 || "").replace(/^sha256:/u, ""),
      mimeType: String(summary.artifact?.mimeType || ""),
      bytes: finiteOrNull(summary.artifact?.bytes),
    },
    attempts: {
      total: finiteOrNull(summary.attempts?.total) ?? 0,
      retryCount: Array.isArray(summary.attempts?.retries) ? summary.attempts.retries.length : 0,
    },
  });
  return receipt;
}

/**
 * 人間確認・独立agent確認・自動検査を同じ「承認済み」に潰さず記録する。
 * 証拠本文やreviewer名はplatform exportへ出さず、種別とscopeだけ集計する。
 */
export function recordApproval(receipt, {
  type,
  scope,
  evidence,
  reviewer = "",
  reviewerContextId = "",
  decidedAt = "",
} = {}) {
  if (receipt?.finalized) throw new Error("finalize 済みの RunReceipt に承認は足せない。");
  if (!Array.isArray(receipt?.approvals)) throw new Error("RunReceipt の approvals が壊れている。");
  if (!["human", "independent-agent", "automated"].includes(type)) throw new Error(`承認種別が不正: ${type || "(空)"}`);
  if (!String(scope || "").trim()) throw new Error("承認には scope が要る。");
  if (evidence === undefined || evidence === null || evidence === "") throw new Error("承認には証拠が要る。");
  if (!String(decidedAt || "").trim()) throw new Error("承認には decidedAt が要る。");
  if (type === "human" && (!String(reviewer || "").trim() || !String(reviewerContextId || "").trim())) {
    throw new Error("人間承認には reviewer と reviewerContextId が要る。agent自己申告を人間承認として残さない。");
  }
  const suppliedDigest = typeof evidence === "string"
    ? String(evidence).trim().match(/^(?:sha256:)?([a-f0-9]{64})$/iu)?.[1]?.toLowerCase()
    : "";
  receipt.approvals.push({
    type,
    scope: String(scope),
    // 検証済みSHAをもう一度hashすると、Receipt/Canvasから元signoffとの
    // 対応を確認できなくなる。digest形式だけは値を保存し、それ以外は従来通り要約hashにする。
    evidenceDigest: suppliedDigest || (typeof evidence === "string" ? sha256(evidence) : sha256(JSON.stringify(evidence))),
    reviewer: String(reviewer || ""),
    reviewerContextId: String(reviewerContextId || ""),
    decidedAt: String(decidedAt),
  });
  return receipt;
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

// 契約の版は「系列-v番号」（例: koya-manga-production-v52）。同じ系列の番号だけを比べる。
// 系列が違う・形が読めないときは比べられない。比べられないものを「古い」とは扱わない。
function contractSeriesNumber(version) {
  const match = /^(?<series>.+)-v(?<number>\d+)$/u.exec(String(version || "").trim());
  return match ? { series: match.groups.series, number: Number(match.groups.number) } : null;
}

function contractPredates(contractVersion, since) {
  const contract = contractSeriesNumber(contractVersion);
  const start = contractSeriesNumber(since);
  return Boolean(contract && start && contract.series === start.series && contract.number < start.number);
}

/**
 * この skip が「当時の契約にはまだ無かった保証」だと確かめられるか。
 * finalize と集計はゲートに付いた印を信じず、版の比較をここでやり直す。
 */
export function isGateNotInForce(gate) {
  return gate?.verdict === "skip"
    && Boolean(gate.notInForce)
    && contractPredates(gate.notInForce.contractVersion, gate.notInForce.since);
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
  // 同じ id が2度来ると Map は黙って後勝ちにする。fail のあとに pass が
  // 来れば pass になり、順序ひとつで判定が変わる。どちらが正しいか決められない
  // 入力は、黙って片方を選ぶより落とす方がいい。
  const duplicateOf = (values) => {
    const seen = new Set();
    return [...new Set(values.filter((id) => (seen.has(id) ? true : (seen.add(id), false))))];
  };
  const duplicateSteps = duplicateOf((steps || []).map((step) => step.id));
  const duplicateGuarantees = duplicateOf((declaration?.guarantees || []).map((entry) => entry.id));
  const duplicateRequired = duplicateOf(Array.isArray(requiredAuditIds) ? requiredAuditIds : []);
  const collisions = [
    ...duplicateSteps.map((id) => `監査結果 ${id}`),
    ...duplicateGuarantees.map((id) => `保証 ${id}`),
    ...duplicateRequired.map((id) => `契約の必須監査 ${id}`),
  ];
  if (collisions.length > 0) {
    throw new Error(
      `同じ id が重複している: ${collisions.join(", ")}。`
      + "重複を黙って後勝ちにすると、fail のあとに pass が来ただけで通ってしまう。",
    );
  }
  const byId = new Map((steps || []).map((step) => [step.id, step]));
  // 契約は版で増減する。当時の契約に無かった監査を「未実施」と数えると、
  // 過去のエピソードが後から一斉に不合格になる——実際 v50 のエピソードを
  // v51 の契約で測って、その版に存在しない audio-speaker-continuity の
  // ぶんだけ落ちた。効力のあった契約が分かるならそれで測る。
  const inForce = Array.isArray(requiredAuditIds) && requiredAuditIds.length > 0 ? new Set(requiredAuditIds) : null;

  // 対応表と契約が食い違っていないかを、走らせる前に見る。
  //
  // 契約に必須監査が増えたのに宣言への対応付けを忘れると、記録だけが pass に
  // なる（最終監査は落ちるのに）。テストでは捕まえていたが、それは
  // 「対応表を更新し忘れたときにテストも一緒に更新し忘れない」前提に
  // 乗っていて、実行時には何も守っていなかった。
  if (inForce) {
    const declared = (declaration?.guarantees || []).flatMap((entry) => entry.evidenceAuditIds || []);
    const seen = new Set();
    const duplicated = declared.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    const unmapped = [...inForce].filter((id) => !seen.has(id));
    const problems = [];
    // 契約が要求しているのにどの保証も裏づけていない——これが本当の穴。
    // 監査が増えたのに対応付けを忘れた状態で、記録だけが pass になる。
    if (unmapped.length > 0) problems.push(`契約の必須監査がどの保証にも紐づいていない: ${unmapped.join(", ")}`);
    if (duplicated.length > 0) problems.push(`同じ監査が複数の保証に紐づいている: ${[...new Set(duplicated)].join(", ")}`);
    // 逆向き（宣言が契約に無い監査を参照）は落とさない。過去の契約で測るとき、
    // 当時まだ存在しなかった監査を宣言が持っているのは正常で、
    // これは applicable の絞り込みで「対象外」として扱われる。
    if (problems.length > 0) {
      throw new Error(
        `${contractVersion || "(版不明)"} と ${declaration?.id || "(宣言不明)"} の対応が壊れている。`
        + `${problems.join(" / ")}。`
        + "対応が壊れたまま記録を作ると、最終監査が落ちる条件でも記録だけが pass になる。",
      );
    }
  }

  // 版が読めない inForceSince を黙って無視すると、後の版の契約で測れなくなった
  // 保証まで「当時は無かった」に見える形へ倒れうる。宣言の誤りは先に止める。
  const malformedSince = (declaration?.guarantees || [])
    .filter((entry) => entry.inForceSince !== undefined && !contractSeriesNumber(entry.inForceSince))
    .map((entry) => entry.id);
  if (malformedSince.length > 0) {
    throw new Error(
      `保証の inForceSince が契約の版として読めない: ${malformedSince.join(", ")}。`
      + "「系列-v番号」（例: koya-manga-production-v52）で書くこと。",
    );
  }

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
    //
    // ただし、保証そのものがこの契約より後の版で入ったのなら話が違う。
    // カット単位の動画差し替え（v52）を足したとき、v50 の合格作が後から
    // 不合格に変わった。監査単位では「当時無かった監査は対象外」にして
    // いたのに、保証単位には同じ区別が無かった。
    // 「縮んだ」と「まだ無かった」は監査 id だけでは見分けられないので、
    // 保証がいつ入ったかを宣言の inForceSince に書いてもらう。書いていない、
    // 系列が違う、版が読めない——どれも見分けられないので従来どおり skip のまま
    // （finalize で不合格）に倒す。
    if (applicable.length === 0) {
      const since = guarantee.inForceSince || "";
      const notInForce = Boolean(since) && contractPredates(contractVersion, since);
      recordGate(receipt, {
        id: guarantee.id,
        verdict: "skip",
        evidence: { notApplicable, contractVersion, inForceSince: since || null },
        detail: notInForce
          ? `この保証は ${since} から。契約 ${contractVersion} の時点では存在しなかったので測定対象外: ${evidenceIds.join(", ")}`
          : `契約 ${contractVersion || "(版不明)"} にこの保証を裏づける監査が1件も無い: ${evidenceIds.join(", ")}`,
      });
      if (notInForce) receipt.gates[guarantee.id].notInForce = { since, contractVersion };
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
 * `{ checkId: true }` または `{ checkId: {pass, detail} }` を使う監査を、
 * RunReceiptの共通step形式へ変換する。未定義・truthy文字列はpassにしない。
 */
export function auditStepsFromCheckMap(checks = {}) {
  if (!checks || typeof checks !== "object" || Array.isArray(checks)) {
    throw new Error("監査checksはobjectであること。");
  }
  return Object.entries(checks).map(([id, value]) => {
    if (typeof value === "boolean") return { id, pass: value, detail: value ? "check=true" : "check=false" };
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { id, pass: value.pass === true, detail: String(value.detail || value.reason || "") };
    }
    return { id, pass: false, detail: `booleanまたは{pass,detail}ではない: ${typeof value}` };
  });
}

export function recordGatesFromAuditChecks(receipt, { declaration, checks, requiredAuditIds = null, contractVersion = "" } = {}) {
  return recordGatesFromAuditSteps(receipt, {
    declaration,
    steps: auditStepsFromCheckMap(checks),
    requiredAuditIds,
    contractVersion,
  });
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
  // 当時の契約に存在しなかった保証だけは、測っていなくても不合格に数えない。
  // 印は recordGatesFromAuditSteps しか付けないが、ここでも版を比べ直す。
  const notInForce = declared.filter((id) => isGateNotInForce(receipt.gates[id]));
  const skipped = declared.filter((id) => receipt.gates[id]?.verdict === "skip" && !notInForce.includes(id));

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
  // skip は「測っていない」であって「通った」ではない。理由つきの skip を
  // 受け取る仕組みにしたのは記録のためで、免除のためではなかったのに、
  // 全体の判定が skipped を見ていなかった——**欠落を許可として扱う**という、
  // このコードベースで最も繰り返し見つかった型がここにも入っていた。
  const incompleteMediaJobs = (receipt.mediaJobs || []).filter((job) => job.status !== "completed");
  const derived = failed.length > 0 || skipped.length > 0 || knownRemainingIssues.length > 0
    || incompleteMediaJobs.length > 0 ? "fail" : requested;

  receipt.finalized = true;
  receipt.finalizedAt = timestamp;
  receipt.outcome = derived;
  receipt.outcomeRequested = requested;
  receipt.outcomeOverridden = derived !== requested;
  receipt.knownRemainingIssues = knownRemainingIssues.map(String);
  receipt.summary = {
    declaredGateCount: declared.length,
    passed: declared.length - failed.length - skipped.length - notInForce.length,
    failed: failed.length,
    skipped: skipped.length,
    notInForce: notInForce.length,
    failedGates: failed,
    skippedGates: skipped,
    notInForceGates: notInForce,
    unexpectedGates: [...new Set(receipt.unexpectedGates)],
    artifactCount: (receipt.artifacts || []).length,
    mediaJobCount: (receipt.mediaJobs || []).length,
    incompleteMediaJobCount: incompleteMediaJobs.length,
    mediaCostByCurrency: (receipt.mediaJobs || []).reduce((totals, job) => {
      const currency = job.usage?.currency || job.reservation?.currency || "unknown";
      const cost = Number(job.usage?.cost);
      if (Number.isFinite(cost)) totals[currency] = (totals[currency] || 0) + cost;
      return totals;
    }, {}),
    approvalCounts: (receipt.approvals || []).reduce((counts, approval) => ({
      ...counts,
      [approval.type]: (counts[approval.type] || 0) + 1,
    }), {}),
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
    // 版の文字列は返さない。「当時は無かった」という事実だけを返す。
    gates: Object.fromEntries(Object.entries(receipt.gates).map(([id, gate]) => [
      id,
      isGateNotInForce(gate) ? { verdict: gate.verdict, notInForce: true } : { verdict: gate.verdict },
    ])),
    approvals: (receipt.approvals || []).map((approval) => ({ type: approval.type, scope: approval.scope })),
    artifacts: (receipt.artifacts || []).map(({ kind, sha256: digest, bytes, mimeType }) => ({ kind, sha256: digest, bytes, mimeType })),
    mediaJobs: (receipt.mediaJobs || []).map((job) => ({
      status: job.status,
      kind: job.kind,
      provider: job.provider,
      adapterVersion: job.adapterVersion,
      inputHash: job.inputHash,
      artifactSha256: job.artifact?.sha256 || "",
      usage: job.usage,
      retryCount: job.attempts?.retryCount || 0,
    })),
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
