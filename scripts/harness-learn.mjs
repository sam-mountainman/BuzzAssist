#!/usr/bin/env node
// ハーネス自己改善ループ（Claude Code / Codex 共通）
//
// ユーザーの指摘を、その場の修正で終わらせずに、次のセッションが読む正本へ
// 積み上げるための仕組み。Nous Research の hermes-agent が採っている
// 3層（ターン内の捕捉 → 定期的な統合 → 人間起動の取り込み）を、この
// リポジトリの方針に合わせて移植した。
//
//   node scripts/harness-learn.mjs capture --text "..." --evidence "..."
//   node scripts/harness-learn.mjs status
//   node scripts/harness-learn.mjs review              # dry-run（既定）
//   node scripts/harness-learn.mjs apply --id <id> --reviewer <名前>
//
// 本家より厳しくしている点と、その理由:
//
// - **捕捉は何も書き換えない**。提案を追記するだけ。自己改善が
//   「スクリプトが自分で正本を書き換える」形になると、今日このリポジトリで
//   何度も潰した「自分で自分に合格を出す」構造と同じものになる。
// - **review は既定で dry-run**。統合案を出すだけで、スキルには触らない。
// - **apply には reviewer 名が要る**。人手ゲートに reviewer を必須にした
//   のと同じ理由（台帳R196）。誰も見ていない自動反映は証跡にならない。
// - **削除しない**。置き換えたものは superseded として残す。
// - **一件一スキルにしない**。hermes の curator が明言しているとおり、
//   1セッションの個別事象を1スキルにする蓄積は失敗であって機能ではない。
//   狙うのはクラスレベルの規則。

import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  channelPackRootEntries,
  resolveChannelPackPath,
  resolveChannelPackSource,
} from "../lib/channelPackResolver.mjs";
import {
  CHANNEL_REGISTRY_PATH_ENV,
  channelRegistrySourcePath,
  findChannel,
  loadChannelRegistry,
} from "../lib/channelRegistry.mjs";
import { isDirectCli } from "../lib/cliEntrypoint.mjs";
import { loadHarnessDeployments } from "../lib/harnessDeploymentResolver.mjs";
import { redactSharedLearningText } from "../lib/harnessFeedbackBundle.mjs";
import { LEARNING_TARGET_ALIASES, resolveLearningTarget } from "../lib/harnessLearningTargets.mjs";
import { assertLearningWriteAllowed } from "../lib/harnessLearningGuard.mjs";
import {
  ARCHIVE_RECORD_VERSION,
  CURATE_DEFAULT_GATE_WINDOW_DAYS,
  CURATE_DEFAULT_STALE_DAYS,
  archivePathForOverlay,
  curateOverlayCandidates,
  effectiveArchiveRecords,
  knownGateVocabulary,
} from "../lib/harnessLearningCuration.mjs";
import {
  LEARNING_INSPECTION_VERSION,
  blockedOriginalDigest,
  describeLearningBlockReasons,
  inspectLearningProposal,
  inspectLearningText,
  learningBlockReasons,
  neutralizeLearningText,
} from "../lib/harnessLearningInspection.mjs";
import {
  digestVocabularyTerm,
  extractVocabularyTokens,
  normalizeVocabularyTerm,
} from "../lib/packageTarballAudit.mjs";
import { buildPublicProposalCatalog, renderPublicProposalCatalog } from "../lib/harnessLearningCurator.mjs";
import { loadSensitiveVocabulary, SENSITIVE_VOCABULARY_DIGEST_PATH } from "./audit-package-tarball.mjs";
import { collectSensitiveSignals } from "./audit-public-surface.mjs";
import { loadReceipts } from "./harness-receipts.mjs";
import {
  ARCHIVE_STATE_FILE,
  LEARNING_DIR_ENV,
  LOCAL_OVERLAY_BEGIN,
  LOCAL_OVERLAY_END,
  OVERLAY_STATE_FILE,
  channelLedgerDir,
  deliverLearningOverlays,
  learningOverlayCopies,
  appendJsonlRows,
  migrateLegacyLearningState,
  resolveLearningState,
  sameIgnoringOverlayTimestamp,
  sharedLedgerPath,
  stripLocalOverlayBlock,
  withLearningFileLock,
  writeLearningSyncState,
  writeStateOverlayFile,
} from "../lib/harnessLearningState.mjs";
import { learningWritesForbidden } from "../lib/harnessLearningGuard.mjs";
import { REFLECTION_INTERVAL_ENV, resetReflectionCounter } from "../lib/harnessLearningReflection.mjs";
import {
  AGENT_SELF_ATTESTED,
  CHANGE_ACTOR_AGENT,
  CHANGE_ID_PATTERN,
  expandAppliedRecords,
} from "../lib/harnessLearningChangeRecords.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// リリースと一緒に配る設定（targets.json）の置き場。写しの側から読む。
const CODE_LEARNING_DIR = path.join(REPO_ROOT, "docs", "learning");

/**
 * 学習の可変状態の置き場（lib/harnessLearningState.mjs）。開発用チェックアウトでは
 * リポジトリの docs/learning、配布された写しでは ~/.buzzassist/learning/
 * （BUZZASSIST_LEARNING_DIR で上書き可）。ホストごと・版ごとに台帳が分かれないよう、
 * 写しがどこにあっても同じ場所を指す。
 */
export function learningState() {
  return resolveLearningState({ codeRoot: REPO_ROOT });
}

function sharedLedgerFile(kind = "proposals") {
  return sharedLedgerPath(learningState(), kind);
}

function publicCatalogFile() {
  return sharedLedgerFile("proposals.public");
}

/**
 * 配布された写しで初めて台帳に触るとき、古い写し（各ホストの版別キャッシュ・
 * ~/plugins/buzzassist/plugin・自動更新の控え）に残った台帳を1回だけ取り込む。
 * 開発用チェックアウトと子エージェントでは何もしない。取り込んだら公開 catalog も作り直す。
 */
export function ensureLearningStateReady({ env = process.env, state = learningState() } = {}) {
  if (state.mode !== "installed" || learningWritesForbidden(env)) return null;
  const result = migrateLegacyLearningState({ state });
  const ledger = sharedLedgerPath(state, "proposals");
  const catalog = sharedLedgerPath(state, "proposals.public");
  if ((result.imported > 0 || !fs.existsSync(catalog)) && fs.existsSync(ledger)) {
    refreshPublicProposalCatalog({ ledgerPath: ledger, catalogPath: catalog });
  }
  return result;
}

function describeMigration(result) {
  if (!result || !(result.imported > 0)) return "";
  const { proposals = 0, applied = 0, archived = 0, receipts = 0 } = result.byKind || {};
  return `古い写しの台帳から ${result.imported} 件を取り込みました（提案 ${proposals} / 反映 ${applied} / 退避 ${archived} / Receipt ${receipts}。元のファイルは消していません）\n`;
}

/**
 * 共有台帳から、配布物に入れる公開 catalog（id / kind / target だけ）を作り直す。
 *
 * catalog は派生物なのに、捕捉は台帳だけに書いていた。そのため**別セッションが
 * 捕捉するたびに catalog が台帳とずれ、テストが落ち、誰かが手で再生成する**
 * 状態だった（2026-09-17 には台帳 74 件・catalog 63 件）。手で直す運用は、
 * 直す人がいない回にずれたまま配布される。捕捉と同じロックの中で作り直す。
 */
export function refreshPublicProposalCatalog({
  ledgerPath = sharedLedgerFile("proposals"), catalogPath = publicCatalogFile(), read = readJsonl,
} = {}) {
  const rendered = renderPublicProposalCatalog(buildPublicProposalCatalog(read(ledgerPath)).entries);
  const current = fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, "utf8") : null;
  if (current === rendered) return { written: false, catalogPath };
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  const temporary = `${catalogPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, rendered, "utf8");
  fs.renameSync(temporary, catalogPath);
  return { written: true, catalogPath };
}

function refreshCatalogForSharedLedger(ledgerPath) {
  // pack 側の台帳は公開 catalog の材料ではない。
  if (path.resolve(ledgerPath) !== path.resolve(sharedLedgerFile("proposals"))) return { written: false, skipped: true };
  return refreshPublicProposalCatalog({ ledgerPath });
}

/**
 * その提案をどの台帳へ書くか。
 *
 * capture は宛先に関わらず共有台帳（公開リポジトリで追跡）へ書いていた。
 * `channelTermsInSharedEntry` は「共有層宛の提案に固有語が入っていないか」
 * しか見ないので、**宛先が channel-pack: なら固有語ごと通り、そのまま
 * 公開側の台帳に溜まった**。層を分けたつもりが、分けていたのは宛先の
 * ラベルだけで、書き先は1つだった。
 *
 * 実害として、別セッションが捕捉するたびに公開面の検査が赤くなり、
 * こちらが手で pack 側へ移す、を繰り返していた。手で移す運用は、
 * 移す人がいない回に漏れる。
 */
export function ledgerPathFor(target, kind = "proposals", { channel = null, env = process.env } = {}) {
  const name = `${kind}.jsonl`;
  const resolvedTarget = resolveTarget(String(target || ""));
  if (resolvedTarget.startsWith("channel-pack:")) {
    const definition = loadTargets()[resolvedTarget] ?? {};
    // チャンネルの学習の保存先は、制作プログラムの配備 root とは別の設定で決める
    // （resolveChannelLearningStore）。配備 root が "." のとき、以前はここが共有台帳と同じ
    // 場所に解決され、隔離の検査で捕捉そのものが止まっていた。
    // channel（台帳のチャンネル）を渡せば、そのチャンネルの保存先（同じハーネスの別のチャンネルとは別の場所）。
    const store = resolveChannelLearningStore(resolvedTarget, definition, { channel, env });
    if (store) return path.join(store.root, "docs", "learning", name);
    // ambient BUZZASSIST_CHANNEL_PACK_ID を使うと、narrated-story宛の提案が
    // たまたまactiveなKoya packへ入る。target自身をpack IDとして固定する。
    // 保存先の宣言が無いときの置き場は、開発用チェックアウトなら <repo>/channel-packs/<id>/docs/learning、
    // 配布された写しなら状態の置き場の channel-packs/<id>/（写しの中に置くと更新で消える）。
    const packId = packIdForTarget(resolvedTarget, definition);
    return path.join(channelLedgerDir(learningState(), packId), name);
  }
  return sharedLedgerFile(kind);
}

/**
 * 共有台帳と、設定済みの各Channel Pack台帳を重複なく列挙する。
 *
 * channel（台帳のチャンネル）を渡せば、共有台帳とそのチャンネルの保存先の台帳だけ。チャンネルの保存先は
 * channel を渡さない一覧には入らない——チャンネルで作った Job の学習が、チャンネルの無い一覧（従来の
 * status・pending・overlay の材料）や別のチャンネルの一覧に出ないようにするため。
 */
export function learningLedgerPaths(kind = "proposals", { channel = null } = {}) {
  const paths = new Set([sharedLedgerFile(kind)]);
  const scope = channelLearningScopeOf(channel);
  if (scope) {
    for (const target of scope.stores.keys()) paths.add(ledgerPathFor(target, kind, { channel: scope }));
    return [...paths];
  }
  for (const [target, definition] of Object.entries(loadTargets())) {
    if (definition.scope !== "channel-pack") continue;
    try {
      paths.add(ledgerPathFor(target, kind));
    } catch (error) {
      // 保存先の設定が壊れているチャンネルは読まない（書く工程は同じ理由で止まる）。
      // 他のチャンネルと共有台帳の読み取りまで止めない。
      if (error?.code !== CHANNEL_LEARNING_STORE_ERROR) throw error;
    }
  }
  return [...paths];
}

/**
 * チャンネルの範囲に入る行か。保存先のファイルには、従来の台帳を引き継いだ保存先（その宛先を使うチャンネルが
 * 1つのとき）の古い行や、同じ置き場を使う別の宛先の行が入りうる。範囲の宛先でない行と、別のチャンネルの印の
 * ある行は読まない（印の無い行は、そのチャンネルが引き継いだ従来の行として読む）。
 */
export function rowInChannelScope(row, scope) {
  const recorded = typeof row?.channel === "string" ? row.channel : "";
  if (recorded && recorded !== scope.channelId) return false;
  return scope.stores.has(resolveTarget(String(row?.target || "")));
}

/**
 * 台帳の行を読む。channel を渡さなければ従来どおり（共有台帳と各 Channel Pack の既定の台帳）。渡せば、
 * 共有台帳の行と、そのチャンネルの保存先の範囲の行だけ（rowInChannelScope）。
 */
export function readLearningLedgerRows(kind = "proposals", { channel = null } = {}) {
  const scope = channelLearningScopeOf(channel);
  if (!scope) return learningLedgerPaths(kind).flatMap(readJsonl);
  const shared = sharedLedgerFile(kind);
  return learningLedgerPaths(kind, { channel: scope }).flatMap((file) => {
    const rows = readJsonl(file);
    return samePath(file, shared) ? rows : rows.filter((row) => rowInChannelScope(row, scope));
  });
}

/** チャンネルの学習の保存先が決められない・共有台帳と重なるときの失敗コード。 */
export const CHANNEL_LEARNING_STORE_ERROR = "channel-learning-store-invalid";
/** チャンネル（台帳の channels の id）の学習の範囲を決められないときの失敗コード。 */
export const CHANNEL_LEARNING_SCOPE_ERROR = "channel-learning-scope-invalid";
/** 共有層（genre: / platform:）の宛先にチャンネルを付けたときの失敗コード。 */
export const CHANNEL_SCOPE_SHARED_TARGET_ERROR = "channel-scope-shared-target";

function channelScopeError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

/**
 * チャンネル（台帳の channels の id）の学習の範囲。保存先は台帳（lib/channelRegistry.mjs）が決めた
 * チャンネルごとの root（channelLearning の { target, channel, root } か、学習の置き場の channels/<id>）で、
 * 台帳の読み込みが重なり（別のチャンネル・チャンネルの無い Job の保存先）を拒んでいる。
 * 台帳に無いチャンネル・壊れた台帳は理由つきで止める（チャンネルの無い保存先へ黙って落とさない）。
 */
export function resolveChannelLearningScope(channelId, { repoRoot = REPO_ROOT, env = process.env, registry = undefined } = {}) {
  const id = String(channelId ?? "").trim();
  if (!id) return null;
  let channel;
  try {
    channel = findChannel(registry ?? loadChannelRegistry({ repoRoot, env }), id);
  } catch (error) {
    throw channelScopeError(
      CHANNEL_LEARNING_SCOPE_ERROR,
      `チャンネル ${id} の学習の保存先を決められません（${String(error?.message || error).slice(0, 400)}）。`
        + "チャンネルの無い保存先へは書きません。",
    );
  }
  const stores = new Map();
  for (const entry of channel.learning || []) {
    if (entry?.store?.root) stores.set(entry.target, { root: entry.store.root, source: entry.store.source });
  }
  return Object.freeze({ channelId: channel.id, stores });
}

/** チャンネルの id か resolveChannelLearningScope の結果を、学習の範囲にする。どちらでもなければ null。 */
export function channelLearningScopeOf(value, options = {}) {
  if (!value) return null;
  if (typeof value === "object" && value.stores instanceof Map && typeof value.channelId === "string") return value;
  if (typeof value !== "string") throw channelScopeError(CHANNEL_LEARNING_SCOPE_ERROR, "channel はチャンネルの id にしてください。");
  return resolveChannelLearningScope(value, options);
}

function channelScopeStore(scope, target) {
  const store = scope.stores.get(target);
  if (store) return store;
  throw channelScopeError(
    CHANNEL_LEARNING_SCOPE_ERROR,
    `チャンネル ${scope.channelId} は ${target} を学習の宛先に持ちません`
      + `（台帳の制作のハーネスと台本のジャンルから決まる宛先: ${[...scope.stores.keys()].join(", ") || "無し"}）。`,
  );
}

function channelLearningStoreError(target, reason) {
  const error = new Error(
    `${CHANNEL_LEARNING_STORE_ERROR}: ${target} の学習の保存先を使えません。${reason}`
    + " チャンネルの台帳と提案は、共有台帳（docs/learning）とも公開リポジトリの作業木の直下とも別の場所"
    + "（Channel Pack か運営者の私有プロジェクト）に置くこと。",
  );
  error.code = CHANNEL_LEARNING_STORE_ERROR;
  return error;
}

function samePath(left, right) {
  const normalize = (value) => {
    try { return fs.realpathSync(value); } catch { return path.resolve(value); }
  };
  return normalize(left) === normalize(right);
}

/**
 * 運営者の配置表（追跡外の config/harness-deployments.json）の `channelLearning` で宣言した、
 * チャンネルの学習の保存先（運営者の私有プロジェクト）。制作プログラムの配備（deployments[].root）
 * とは別の設定。形:
 *   "channelLearning": [{ "target": "channel-pack:<id>", "root": "<私有プロジェクトの dir>" }]
 * root は配置表のあるリポジトリからの相対か絶対。宣言が無ければ null。
 *
 * 読むファイルはチャンネルの台帳（lib/channelRegistry.mjs）と同じ（channelRegistrySourcePath）。
 * BUZZASSIST_CHANNEL_REGISTRY で台帳を別のファイルにした端末では、そのファイルの channelLearning を読む。
 * 以前はここだけ config/harness-deployments.json を読み、台帳の読み込みの重なりの検査は別のファイルの
 * 宣言を見ていた（検査した保存先と、実際に書く保存先がずれる）。例のファイルは読まない（従来どおり）。
 */
function operatorChannelLearningRoot(target, repoRoot = REPO_ROOT, env = process.env) {
  const source = channelRegistrySourcePath({ repoRoot, env });
  if (!source.path) {
    if (source.required) {
      throw channelLearningStoreError(target, `チャンネルの台帳のファイルがありません（${CHANNEL_REGISTRY_PATH_ENV}）: ${source.expected}`);
    }
    return null;
  }
  if (source.example) return null;
  const operatorMap = source.path;
  const label = source.source === "env" ? `${CHANNEL_REGISTRY_PATH_ENV} のファイル` : "config/harness-deployments.json";
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(operatorMap, "utf8"));
  } catch {
    return null;
  }
  if (parsed?.channelLearning === undefined) return null;
  if (!Array.isArray(parsed.channelLearning)) {
    throw channelLearningStoreError(target, `${label} の channelLearning が配列ではありません。`);
  }
  // チャンネル単位の行（{ target, channel, root }）はそのチャンネルの保存先で、チャンネルの無い Job の保存先ではない。
  const rows = parsed.channelLearning.filter((row) => row?.channel === undefined && resolveTarget(String(row?.target || "")) === target);
  if (rows.length === 0) return null;
  if (rows.length > 1) throw channelLearningStoreError(target, "channelLearning に同じ target が2回あります（どちらが効くか決められない）。");
  const value = typeof rows[0]?.root === "string" ? rows[0].root.trim() : "";
  if (!value || /<[^>]+>/u.test(value)) throw channelLearningStoreError(target, "channelLearning の root が未完成です。");
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(repoRoot, value);
}

/**
 * channel-pack 宛の学習の保存先（正本の台帳・提案台帳・反映記録を置く root）。
 *   0. channel（台帳のチャンネルの id か resolveChannelLearningScope の結果）を渡せば、そのチャンネルの保存先
 *      （source "channel"）。チャンネルで作った Job の学習はここ。下の 1〜3 へは落とさない
 *   1. 運営者の配置表の channelLearning の宛先単位の行（私有プロジェクト）
 *   2. 配置先相対の宛先（relativeToDeployment）で、配備 root がリポジトリの外にあるもの（従来の配置）
 *   3. どちらも無ければ null（Channel Pack: channel-packs/<packId>、正本は pack-first）
 * 1〜3 はチャンネルの無い Job（従来）の保存先。
 * 共有台帳と同じ場所・リポジトリの作業木の直下に解決されたら、黙って使わず理由つきで止める（fail-closed）。
 */
export function resolveChannelLearningStore(target, definition = {}, {
  repoRoot = REPO_ROOT,
  deploymentRootFor = undefined,
  channel = null,
  // チャンネルの台帳（BUZZASSIST_CHANNEL_REGISTRY）と学習の置き場（BUZZASSIST_LEARNING_DIR）を読む環境。
  env = process.env,
} = {}) {
  if (!isChannelPackTarget(target)) return null;
  const sharedLedgerDir = path.join(repoRoot, "docs", "learning");
  const checked = (root, source) => {
    if (samePath(root, repoRoot)) {
      throw channelLearningStoreError(target, `保存先がリポジトリの作業木の直下（${source}）に解決されました。そこへ書くと台帳が公開面に混ざり、提案は共有台帳と同じ場所になります。`);
    }
    if (samePath(path.join(root, "docs", "learning"), sharedLedgerDir)) {
      throw channelLearningStoreError(target, `提案台帳が共有台帳と同じ場所（${source}）に解決されました。`);
    }
    return { root, source };
  };
  const scope = channelLearningScopeOf(channel, { repoRoot, env });
  if (scope) {
    const store = channelScopeStore(scope, resolveTarget(target));
    return { ...checked(store.root, "channel"), channelId: scope.channelId };
  }
  const declared = operatorChannelLearningRoot(target, repoRoot, env);
  if (declared) return checked(declared, "operator-project");
  if (definition?.relativeToDeployment) {
    const deployment = (deploymentRootFor ?? ((id) => resolveDeploymentRoot(id, repoRoot)))(definition.relativeToDeployment);
    if (deployment) {
      const absolute = path.resolve(repoRoot, deployment);
      // 配備 root がリポジトリそのもの（既定の "."）なら、それは制作プログラムの置き場であって
      // チャンネルの学習の保存先ではない。Channel Pack へ置く。
      if (!samePath(absolute, repoRoot)) return checked(absolute, "deployment");
    }
  }
  return null;
}

// 提案が向かう先。ここに無いものは apply できない。
// 正本スキルと台帳だけを対象にするのは、次のセッションが必ず読む場所が
// この2つだからで、それ以外へ書いても学習として効かない。
// 宛先の定義は docs/learning/targets.json に持つ。コード内に二重に
// 持たせると、片方だけ古くなる——今日このリポジトリで何度も見た形。
export const LEARNING_TARGETS = new Proxy({}, {
  get(_t, key) {
    if (typeof key !== "string") return undefined;
    return loadTargets()[resolveTarget(key)]?.canonical;
  },
  has(_t, key) { return typeof key === "string" && resolveTarget(key) in loadTargets(); },
  ownKeys() { return Object.keys(loadTargets()); },
  getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
});

// 機械が書き換えてよい範囲の境界。hermes の curator が
// 「agent作成スキルだけ触り、bundled / hub-installed には手を出さない」
// としているのと同じ役割を、ここでは**ファイル単位の所有**が担う。
//
// 当初は正本の中にマーカーを埋めて内側だけ書き換える方式にしたが、
// Codexレビューの指摘で改めた。機械が人の文書の一部を編集する構造だと、
// マーカーが壊れたときに人の記述を巻き込むうえ、差分と巻き戻しを
// 独立して扱えない。機械には**専用のファイルを丸ごと持たせる**方が明快。
//
// もう一点、overlay は「運用上の補助指示」であって
// **監査・承認・合否の証跡には使えない**。だから台帳やゲート基準のように
// 承認の記録そのものである文書は review-only にして自動反映しない。
const TARGETS_PATH = path.join(CODE_LEARNING_DIR, "targets.json");

export function loadTargets(targetsPath = TARGETS_PATH) {
  const raw = JSON.parse(fs.readFileSync(targetsPath, "utf8"));
  return raw.targets ?? {};
}

/** repoRoot 基準の targets.json。既定のリポジトリなら TARGETS_PATH と同じ。 */
function loadTargetsFor(repoRoot = REPO_ROOT) {
  return loadTargets(path.resolve(repoRoot) === REPO_ROOT ? TARGETS_PATH : path.join(repoRoot, "docs", "learning", "targets.json"));
}

// 宛先の名前空間を platform: / genre: / channel-pack: の3層へ変えたとき、
// 既に記録した提案は旧IDのまま残る。捨てるとその指摘が無かったことに
// なるので、読むときに翻訳する。提案IDは kind+target+text から作るため、
// **翻訳は解決時だけに留め、記録した target 文字列は書き換えない**
// （書き換えるとIDが変わり、過去の apply 記録と結び付かなくなる）。
//
// 対応表そのものは lib/harnessLearningTargets.mjs に1つだけ置き、feedback bundle と
// 共有する。以前はここと feedback bundle に別々に書かれていた。
export const TARGET_ALIASES = LEARNING_TARGET_ALIASES;

export function resolveTarget(target) {
  return resolveLearningTarget(target);
}

function isChannelPackTarget(target) {
  return String(target || "").startsWith("channel-pack:");
}

/** target 自身が pack ID を決める（ambient な BUZZASSIST_CHANNEL_PACK_ID には頼らない）。 */
function packIdForTarget(target, definition = {}) {
  return definition?.packId || String(target).slice("channel-pack:".length);
}

export const OVERLAY_HEADER = [
  "<!-- このファイルは harness-learn が自動で書きます。手で編集しないでください。 -->",
  "",
  "# 自動で積み上がった指摘",
  "",
  "隣の `SKILL.md` が正本で、**矛盾したときは SKILL.md が優先**します。",
  "ここは運用上の補助指示であって、**監査・承認・合否の証跡には使えません**。",
  "根拠は逐語ではなく sha256 先頭12桁の digest だけを載せます（このファイルは配布物に",
  "同梱されるため）。逐語は `node scripts/harness-learn.mjs status` で id から引けます。",
  "",
].join("\n");

// overlay は次のセッションが**指示として読む**。捕捉した文字列をそのまま
// Markdown へ埋めると、改行や見出しで箇条書きの外へ出て、あたかも
// 正規の指示のように見える行を作れてしまう。1行へ畳んで記法を無効化する。
export function sanitizeForOverlay(value) {
  return String(value ?? "")
    .replace(/\r?\n/gu, " ")        // 改行で項目の外へ出さない
    .replace(/^[\s>#*-]+/u, "")      // 行頭の見出し・引用・箇条書き記号
    .replace(/`/gu, "'")             // コードブロックを開かせない
    .replace(/<!--|-->/gu, "")       // HTMLコメントでマーカーを偽装させない
    .replace(/\s{2,}/gu, " ")
    .trim();
}

// overlay は `.agents/skills/<name>/references/learned-auto.md` に置かれ、
// setup-agents と npm tarball の両方へ**そのまま同梱される**。以前は evidence を
// 逐語で書いていたので、capture 時の検査（channelTermsInSharedEntry）を
// すり抜けたキャスト名・顧客識別子・端末 path が配布物へ出ていた
// （2026-09-05 独立レビュー D-1）。
//
// 語彙に頼る除去は、語彙に無い固有名詞を保証できない。だから根拠は
// **digest だけ**を主とし、text 側は語彙ベースの redaction を補助として通す。
// 逐語が要るときは台帳（proposals.jsonl）を id で引けばよく、overlay に
// 逐語を置く必要は元から無かった。
export const EVIDENCE_DIGEST_CHARS = 12;

export function evidenceDigest(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex").slice(0, EVIDENCE_DIGEST_CHARS);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * 鍵つき digest 語彙（docs/learning/sensitive-vocabulary.digest.json）に一致した
 * token を置換する。tarball 監査（countVocabularyDigestHits）と同じ tokenizer と
 * 正規化を使うので、ここで消したものは監査でも当たらない。語そのものは
 * この関数の外へ出さない。
 */
export function redactVocabularyDigestTokens(value, vocabulary) {
  let text = String(value ?? "");
  if (!vocabulary || vocabulary.count === 0) return { text, hits: 0 };
  const matched = [...extractVocabularyTokens(text)].filter((token) => {
    const normalized = normalizeVocabularyTerm(token);
    if (!vocabulary.lengths.has([...normalized].length)) return false;
    return vocabulary.digests.has(digestVocabularyTerm(normalized, vocabulary.key));
  }).sort((left, right) => right.length - left.length);
  let hits = 0;
  for (const token of matched) {
    text = text.replace(new RegExp(escapeRegExp(token), "giu"), () => { hits += 1; return "<private-term>"; });
  }
  return { text, hits };
}

/** 語彙照合なしで書かれた overlay のヘッダに刻む印。読む側と監査側が見分けられるようにする。 */
export const OVERLAY_VOCABULARY_MISSING_NOTE =
  "<!-- 語彙照合なし: sensitive-vocabulary.digest.json を照合できない状態（一覧か鍵が無い）で --allow-missing-vocabulary により生成。私的語の残存を検出していない。 -->";

/**
 * overlay の text 側に掛ける redaction の材料。Channel Pack 由来の語（運営者端末
 * にしか無い）と、コミット済みの digest 語彙（CI でも効く）の両方を使う。
 *
 * digest ファイルが壊れていれば throw する——壊れた語彙で「除去済み」の
 * overlay を書くより、sync が止まる方がよい。**無い場合も同じ扱いで throw する。**
 * 以前は「壊れていれば止まる、無ければ通る」だった（2026-09-05 再レビュー R2-L1）。
 * 語彙が無い overlay 生成は私的語の残存を検出できないのに、出力は「除去済み」と
 * 区別が付かない。欠落を許可として扱う型（platform-craft「欠落を許可として扱う」）。
 * 明示の `allowMissingVocabulary` でだけ通し、その場合は返り値に印を付けて
 * overlay ヘッダへ刻む。
 */
/** 検査語彙を照合できない（一覧か鍵が無い）ときの失敗コード。 */
export const OVERLAY_VOCABULARY_UNAVAILABLE = "overlay-vocabulary-unavailable";

export function overlayRedactionContext({
  projectDir = REPO_ROOT,
  homeRoot = homedir(),
  allowMissingVocabulary = false,
} = {}) {
  const signals = collectSensitiveSignals(projectDir);
  const vocabularyPath = path.join(projectDir, SENSITIVE_VOCABULARY_DIGEST_PATH);
  const loaded = loadSensitiveVocabulary(vocabularyPath, { projectDir });
  const vocabulary = loaded.vocabulary;
  if (vocabulary === null) {
    if (allowMissingVocabulary !== true) {
      const error = new Error(
        `digest 語彙を照合できないので overlay を生成しない: ${SENSITIVE_VOCABULARY_DIGEST_PATH}（${loaded.reason}）\n`
        + "語彙無しの overlay は私的語の残存を検出できない（tarball 監査と同じ理由）。\n"
        + "  node scripts/audit-package-tarball.mjs build-vocabulary で語彙を作るか、\n"
        + "  開発用途に限り --allow-missing-vocabulary を付ける（overlay ヘッダに「語彙照合なし」が刻まれる）。",
      );
      // 自動 sync は理由だけを記録して止まる（パスを含む本文ではなく、この印で理由を分ける）。
      error.code = OVERLAY_VOCABULARY_UNAVAILABLE;
      error.vocabularyState = loaded.state;
      throw error;
    }
    return { terms: signals.terms, castIds: signals.castIds, homeRoot, vocabulary: null, vocabularyMissing: true };
  }
  return { terms: signals.terms, castIds: signals.castIds, homeRoot, vocabulary, vocabularyMissing: false };
}

export function redactForOverlay(value, context = {}) {
  const shared = redactSharedLearningText(value, {
    terms: context.terms || [],
    castIds: context.castIds || [],
    homeRoot: context.homeRoot || "",
  });
  const vocabulary = redactVocabularyDigestTokens(shared.text, context.vocabulary || null);
  return sanitizeForOverlay(vocabulary.text);
}

/** overlay の1項目ずつの行。同梱の overlay と、運営者の端末の区画が同じ書式を使う。 */
function overlayEntryLines(entries, redaction) {
  const lines = [];
  for (const entry of entries) {
    const repeat = entry.occurrences > 1 ? `（${entry.occurrences}回指摘）` : "";
    lines.push(`- **${redactForOverlay(entry.text, redaction)}**${repeat}`);
    const digests = [...new Set((entry.evidence || []).map((ev) => evidenceDigest(ev)))];
    if (digests.length > 0) {
      lines.push(`  - 根拠digest: ${digests.map((digest) => `\`${digest}\``).join(", ")}`);
    }
    lines.push(`  - 種別: ${entry.kind} / 初回: ${String(entry.firstSeenAt).slice(0, 10)} / id: \`${entry.id}\``);
  }
  return lines;
}

export function renderOverlay(entries, now, context = null) {
  const lines = [OVERLAY_HEADER];
  // 語彙照合なしで生成した overlay は、空でもヘッダで見分けられるようにする。
  // 明示フラグ（vocabularyMissing === true）だけを見る。vocabulary: null は
  // テスト用の素通しコンテキストでも使うので、null だけでは印を付けない。
  if (context?.vocabularyMissing === true) lines.push(OVERLAY_VOCABULARY_MISSING_NOTE, "");
  if (entries.length === 0) {
    lines.push("_まだ自動反映された項目はありません。_", "");
  } else {
    lines.push(...overlayEntryLines(entries, context ?? overlayRedactionContext()), "");
  }
  lines.push(`_最終更新: ${now}_`, "");
  return lines.join("\n");
}

/**
 * 運営者の端末で積み上がった項目の区画。状態の置き場（overlays/<skill>/learned-auto.md）に
 * 置き、sync と setup のたびにホストが読む各写しの learned-auto.md の末尾へ届ける
 * （lib/harnessLearningState.mjs の deliverLearningOverlays）。同梱の項目には触らない。
 */
export function renderLocalOverlayBlock(entries, now, context = null) {
  const lines = [
    `${LOCAL_OVERLAY_BEGIN} この区画はこの端末の harness-learn sync が書きます。手で編集しないでください。 -->`,
    "",
    "## この端末で積み上がった指摘",
    "",
    "上の同梱項目と同じく運用上の補助指示で、**監査・承認・合否の証跡には使えません**。",
    "逐語はこの端末の `node scripts/harness-learn.mjs status` で id から引けます。",
    "",
  ];
  if (context?.vocabularyMissing === true) lines.push(OVERLAY_VOCABULARY_MISSING_NOTE, "");
  lines.push(...overlayEntryLines(entries, context ?? overlayRedactionContext()));
  lines.push("", `_この端末での最終更新: ${now}_`, LOCAL_OVERLAY_END, "");
  return lines.join("\n");
}

/** 同梱の overlay に既に載っている提案 id（運営者の区画へ二重に載せないため）。 */
function shippedOverlayIds(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return new Set(); }
  return new Set([...stripLocalOverlayBlock(text).matchAll(/id: `([a-f0-9]{12})`/gu)].map((match) => match[1]));
}

/** `.agents/skills/<id>/references/learned-auto.md` から skill id を取り出す。 */
function skillIdFromOverlay(overlay) {
  const match = String(overlay || "").replaceAll("\\", "/").match(/^\.agents\/skills\/([^/]+)\/references\/learned-auto\.md$/u);
  return match ? match[1] : null;
}

export const PROPOSAL_KINDS = new Set([
  "correction",   // ユーザーがこちらの誤りを正した
  "preference",   // 作り方・進め方の好み
  "constraint",   // やってはいけないこと
  "fact",         // 実測で分かったこと
]);

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        // 壊れた行を黙って読み飛ばすと、記録が欠けたことに誰も気づかない。
        throw new Error(`${filePath}:${index + 1} が壊れています: ${error.message}`);
      }
    });
}

/** 台帳（JSONL）を読む。壊れた行があれば止める（黙って読み飛ばさない）。 */
export function readLearningJsonl(filePath) {
  return readJsonl(filePath);
}

/** 台帳へ1行追記する（1回の write。他プロセスの行と混ざらない）。 */
export function appendLearningJsonl(filePath, entry) {
  appendJsonl(filePath, entry);
}

function appendJsonl(filePath, entry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // 1行を1回の write で出す。JSON.stringify は改行を含まないので、
  // 追記モードの単一 write なら別プロセスと行が混ざらない。
  const line = `${JSON.stringify(entry)}\n`;
  const fd = fs.openSync(filePath, "a");
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// 台帳ファイル単位の排他は lib/harnessLearningState.mjs に1つだけ置く（移行と Receipt の索引も同じ規則で取る）。
const withProposalCaptureLock = withLearningFileLock;

function canonicalPotentialPathSync(filePath) {
  let current = path.resolve(filePath);
  const missing = [];
  while (true) {
    try {
      return path.join(fs.realpathSync(current), ...missing.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function assertCaptureLedgerIsolation(target, ledgerPath, ledgerPathResolver) {
  if (!String(target).startsWith("channel-pack:")) return;
  const channel = canonicalPotentialPathSync(ledgerPath);
  const shared = canonicalPotentialPathSync(ledgerPathResolver("platform:platform-craft", "proposals"));
  const rel = path.relative(path.dirname(shared), channel);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    throw new Error("Channel Pack proposal台帳が共有learning台帳から分離されていない。captureを停止する。");
  }
}

export function proposalId(entry) {
  return createHash("sha256")
    .update([entry.kind, entry.target, entry.text].join("\u001f"))
    .digest("hex")
    .slice(0, 12);
}

// 正本側へこの一意マーカーを置くことで、よくある短い語句が偶然どこかに
// 存在しただけで別の提案を「反映済み」にできないようにする。
export const PROMOTION_NOTE_MIN_CHARS = 12;

export function promotionMarker(id) {
  return `buzzassist-learning:${String(id || "").trim()}`;
}

// marker と note が正本のどこにあってもよい、では足りない。note は「何をどう書いたか」
// なので、marker の近く（同じ節）に無ければ、別の変更の文を証拠に流用できる（cx-a4）。
export const PROMOTION_EVIDENCE_WINDOW_LINES = 40;

export function canonicalHasPromotionEvidence(record, canonicalText) {
  if (!record?.id || typeof canonicalText !== "string") return false;
  const note = typeof record.note === "string" ? record.note.trim() : "";
  if (Array.from(note).length < PROMOTION_NOTE_MIN_CHARS) return false;
  const marker = promotionMarker(record.id);
  const lines = canonicalText.split("\n");
  const markerLines = lines.map((line, index) => (line.includes(marker) ? index : -1)).filter((index) => index >= 0);
  if (markerLines.length === 0) return false;
  // note は複数行にまたがってよい。marker の前後 N 行を1つの窓として見る。
  return markerLines.some((at) => {
    const start = Math.max(0, at - PROMOTION_EVIDENCE_WINDOW_LINES);
    const end = Math.min(lines.length, at + PROMOTION_EVIDENCE_WINDOW_LINES + 1);
    return lines.slice(start, end).join("\n").includes(note);
  });
}

// 同じ指摘が何度も来るのは「まだ直っていない」という強い信号なので、
// 重複を捨てずに回数として数える。1回の思いつきと、3回言われたことを
// 同じ重みで扱わないための材料。
// 反映済みの判定。id が1行あるだけでは足りない——正本にその規則が
// 実在することまで見る。以前は id だけで判定していたので、正本を
// 1文字も変えずに apply を通せてしまい、status からも消えていた。
/** 差分の承認キューでエージェントが当てた変更（expandAppliedRecords が展開した行）か。 */
export function isAgentAppliedChange(record) {
  return record?.via === "approve"
    && record.actor === CHANGE_ACTOR_AGENT
    && record.attestedBy === AGENT_SELF_ATTESTED
    && CHANGE_ID_PATTERN.test(String(record.changeId || ""));
}

export function isActuallyApplied(record, readCanonical, hashCanonical = null) {
  if (!record?.id) return false;
  // 昇格記録には、何をどこへ書いたかが要る。
  if (!record.reviewer || !String(record.reviewer).trim()) return false;
  // **人の確認が無いものを「反映済み」として数えない。**
  //
  // ここが実効の中心だった。reviewer が空でないことしか見ていなかったので、
  // agent-self-attested も unverified-agent-typed も attestedBy 欠落も、
  // 人の確認とまったく同じ効力で applied になっていた。しかも
  // summarizeProposals が applied を未反映一覧から消すので、**後から人が
  // 昇格しようとすると「既に反映済み」で拒まれる**——機械の自己申告が、
  // 人の確認を締め出していた。
  //
  // 例外は1つだけ: 差分の承認キュー（pending → approve）でエージェントが当てた変更
  // （actor: agent）。運営者の決定（2026-09-26）で、正本スキルの人の確認はリリースのときの
  // 1回にまとめた。キューを通った変更は、変更前後の sha256・元の提案・時刻・当てた者が
  // 残り、1件ずつ巻き戻せる。apply --agent-attested（直接の編集の自己申告）は、変更前の版も
  // 巻き戻しも残らないので、今までどおり反映済みに数えない。
  if (record.attestedBy !== HUMAN_VERIFIED && !isAgentAppliedChange(record)) return false;
  if (!record.targetPath) return false;
  // 記録そのものも渡す。channel-pack 宛は同じ相対パスでも pack 側が正本で、
  // 相対パスだけでは「どちらの写しを読むか」を決められない（ops-7）。
  const text = readCanonical(record.targetPath, record);
  if (text === null) return false;
  // 一意な proposal marker と、十分な長さの exact note の両方を要求する。
  // 「正本のどこかに5文字だけ一致」で別の変更を証拠にできた旧判定は使わない。
  if (!canonicalHasPromotionEvidence(record, text)) return false;
  // 記録した digest は保存するだけでなく突き合わせる。保存して照合しない
  // ハッシュは、証跡があるように見えて何も担保していない。
  // 正本が変わっていれば「別の版に対する記録」なので、文言が残っていても
  // その記録は現在の版を保証しない。
  if (record.targetSha256 && typeof hashCanonical === "function") {
    const current = hashCanonical(record.targetPath, record);
    if (current && current !== record.targetSha256) return false;
  }
  return true;
}

export function summarizeProposals(proposals, applied, readCanonical = null, hashCanonical = null) {
  // approve が書いた「適用した変更」の行（1変更に1行）は、提案ごとの反映記録として数える。
  // 巻き戻した変更と、巻き戻しの行そのものは反映記録に数えない（lib/harnessLearningChangeRecords.mjs）。
  const records = expandAppliedRecords(applied);
  const appliedIds = new Set(
    readCanonical
      ? records
        .filter((entry) => isActuallyApplied(entry, readCanonical, hashCanonical))
        .map((entry) => entry.id)
      : records.map((entry) => entry.id),
  );
  const byId = new Map();
  const seenSessionOccurrences = new Set();
  for (const entry of proposals) {
    const id = entry.id ?? proposalId(entry);
    const session = typeof entry.session === "string" ? entry.session.trim() : "";
    const sessionOccurrence = session ? `${id}\u001f${session}` : "";
    const existing = byId.get(id);
    if (existing) {
      // 同じturn/sessionでcaptureが再実行されても、独立した指摘回数にしない。
      // session不明の旧記録は別事象か判定できないため従来どおり数える。
      if (!sessionOccurrence || !seenSessionOccurrences.has(sessionOccurrence)) {
        existing.occurrences += 1;
      }
      existing.lastSeenAt = entry.capturedAt ?? existing.lastSeenAt;
      if (entry.evidence && !existing.evidence.includes(entry.evidence)) {
        existing.evidence.push(entry.evidence);
      }
    } else {
      // 旧名（skill: / ledger: / doc:）で記録された提案も、数えるときは新しい宛先へ寄せる。
      // 寄せないと status・review・curator では旧名が別の宛先として並び、同じ正本に
      // 溜まった提案が「1件ずつ」に見えて、まとめて書くべき合図が出なかった
      // （2026-09-24 時点で共有台帳の 10 件がこの状態）。記録した行は書き換えず、
      // 元の文字列は recordedTarget に残す。
      const recordedTarget = entry.target;
      const target = resolveTarget(recordedTarget);
      byId.set(id, {
        ...entry,
        target,
        ...(target !== recordedTarget ? { recordedTarget } : {}),
        id,
        occurrences: 1,
        firstSeenAt: entry.capturedAt ?? null,
        lastSeenAt: entry.capturedAt ?? null,
        evidence: entry.evidence ? [entry.evidence] : [],
        applied: appliedIds.has(id),
      });
    }
    if (sessionOccurrence) seenSessionOccurrences.add(sessionOccurrence);
  }
  return [...byId.values()].sort((a, b) => {
    if (a.applied !== b.applied) return a.applied ? 1 : -1;
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
    return String(a.firstSeenAt).localeCompare(String(b.firstSeenAt));
  });
}

/**
 * sync が各 overlay へ何を載せ、何を保留するかを決める（書き込みはしない）。
 *
 * 旧名で記録された提案は summarizeProposals が新しい宛先へ寄せ済みなので、
 * ここでは解決後の target だけを見る。review-only の宛先は自動反映せず件数と
 * 理由だけを返す——そこは承認と監査の記録そのものなので、機械が書き足すと
 * 何を人が決めたのかが分からなくなる。
 */
export function planOverlaySync(summary, targets, { homeRoot = homedir(), archivedRecords = [] } = {}) {
  const byTarget = new Map();
  const archivedByTarget = new Map();
  const blocked = [];
  // 人が退避を決めた（human-verified）項目は overlay から外し、learned-archive.md へ移す。
  // 退避後に同じ提案が再発していたら記録は効力を失い、overlay へ戻る。
  const archive = effectiveArchiveRecords(summary, archivedRecords, { humanVerified: HUMAN_VERIFIED });
  for (const entry of summary.filter((item) => !item.applied)) {
    const target = resolveTarget(entry.target);
    // 書き込み前の検査に当たったもの（捕捉時の印か、いま読み直して当たったもの）は
    // overlay に載せない。overlay は次のセッションが指示として読む場所なので、
    // 注入文や見えない文字をそこへ運ばない。台帳の行は消さず、status に理由を出す。
    const reasons = learningBlockReasons(entry, { homeRoot });
    if (reasons.length > 0) {
      blocked.push({ id: entry.id, target, reasons });
      continue;
    }
    if (archive.has(entry.id)) {
      if (!archivedByTarget.has(target)) archivedByTarget.set(target, []);
      archivedByTarget.get(target).push({ ...entry, archivedAt: archive.get(entry.id).archivedAt });
      continue;
    }
    if (!byTarget.has(target)) byTarget.set(target, []);
    byTarget.get(target).push(entry);
  }
  const overlays = [];
  const held = [];
  for (const [target, def] of Object.entries(targets)) {
    const entries = byTarget.get(target) ?? [];
    if (def.mode === "review-only") {
      if (entries.length > 0) held.push({ target, count: entries.length, reason: def.reason });
      continue;
    }
    if (!def.overlay) continue;
    overlays.push({
      target,
      overlay: def.overlay,
      entries,
      archive: archivePathForOverlay(def.overlay),
      archivedEntries: archivedByTarget.get(target) ?? [],
    });
  }
  return { overlays, held, blocked };
}

export const ARCHIVE_HEADER = [
  "<!-- このファイルは harness-learn が自動で書きます。手で編集しないでください。 -->",
  "",
  "# 退避した自動項目",
  "",
  "`learned-auto.md` から、人の判断（`harness-learn curate --archive`、human-verified）で",
  "退避した項目です。**作業前に読む対象ではありません**。消してはいないので、同じ指摘が",
  "再発すれば次の sync で `learned-auto.md` へ戻ります。",
  "",
  "長く再発していないことは「もう起きない」とも「その規則が効いている」とも読めるので、",
  "機械は候補を出すだけで、退避は人が決めます。",
  "",
].join("\n");

/** learned-archive.md の本文。overlay と同じ redaction（本文は置換済み・根拠は digest）を通す。 */
export function renderArchive(entries, now, context = null) {
  const lines = [ARCHIVE_HEADER];
  if (context?.vocabularyMissing === true) lines.push(OVERLAY_VOCABULARY_MISSING_NOTE, "");
  const redaction = entries.length > 0 ? (context ?? overlayRedactionContext()) : null;
  for (const entry of entries) {
    lines.push(`- ${redactForOverlay(entry.text, redaction)}`);
    const digests = [...new Set((entry.evidence || []).map((ev) => evidenceDigest(ev)))];
    if (digests.length > 0) lines.push(`  - 根拠digest: ${digests.map((digest) => `\`${digest}\``).join(", ")}`);
    lines.push(
      `  - 種別: ${entry.kind} / 最後の再発: ${String(entry.lastSeenAt ?? entry.firstSeenAt ?? "").slice(0, 10)}`
      + ` / 退避: ${String(entry.archivedAt ?? "").slice(0, 10)} / id: \`${entry.id}\``,
    );
  }
  if (entries.length === 0) lines.push("_退避した項目はありません。_");
  lines.push("", `_最終更新: ${now}_`, "");
  return lines.join("\n");
}

function writeMachineOwnedFile(full, text) {
  const before = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
  // 項目が同じで最終更新の行だけが違うなら書き直さない（sync のたびに差分を作らない）。
  if (sameIgnoringOverlayTimestamp(before, text)) return false;
  fs.mkdirSync(path.dirname(full), { recursive: true });
  // 一時ファイル＋rename。書き込み途中で落ちた overlay を
  // 次のセッションが指示として読むことがないように。
  const temp = `${full}.${process.pid}.partial`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, full);
  return true;
}

/**
 * planOverlaySync の計画どおりに、機械所有の2ファイル（learned-auto.md と
 * learned-archive.md）だけを書き直す。人が書く SKILL.md には触らない。
 * 退避ファイルは、退避した項目があるか、既にファイルがあるときだけ書く。
 */
export function writeOverlayFiles(plan, { now, redaction, repoRoot = REPO_ROOT } = {}) {
  const written = [];
  for (const { overlay, entries, archive, archivedEntries = [] } of plan.overlays) {
    if (writeMachineOwnedFile(path.join(repoRoot, overlay), renderOverlay(entries, now, redaction))) {
      written.push({ file: overlay, count: entries.length });
    }
    if (!archive) continue;
    const archiveFull = path.join(repoRoot, archive);
    if (archivedEntries.length === 0 && !fs.existsSync(archiveFull)) continue;
    if (writeMachineOwnedFile(archiveFull, renderArchive(archivedEntries, now, redaction))) {
      written.push({ file: archive, count: archivedEntries.length });
    }
  }
  return written;
}

/**
 * 運営者の端末（配布された写し）の sync。台帳に積んだのはこの端末の指摘だけなので、
 * 同梱の overlay を丸ごと書き直すと配布物の項目が消える。だから:
 *
 *   1. この端末の項目だけの区画を、状態の置き場 overlays/<skill>/learned-auto.md に書く
 *      （同梱の overlay に既にある id は載せない）
 *   2. ホストが実際に読む全部の写し（Claude の installPath、Codex の使用中の版、
 *      ~/plugins/buzzassist/plugin、いま動いている写し）の learned-auto.md の末尾へ届ける
 *
 * 写しの中で書き換えるのは、印で囲んだ区画だけ。setup と自動更新が写しを置き換えても、
 * 状態の置き場から同じ区画をまた届ける。
 */
export function writeLocalOverlayFiles(plan, { now, redaction, state, repoRoot = REPO_ROOT } = {}) {
  const written = [];
  for (const { overlay, entries, archive, archivedEntries = [] } of plan.overlays) {
    const skill = skillIdFromOverlay(overlay);
    if (!skill) continue;
    const shipped = shippedOverlayIds(path.join(repoRoot, overlay));
    const local = entries.filter((entry) => !shipped.has(entry.id));
    const block = local.length > 0 ? renderLocalOverlayBlock(local, now, redaction) : "";
    if (writeStateOverlayFile(state.overlaysDir, skill, OVERLAY_STATE_FILE, block)) {
      written.push({ file: path.join("overlays", skill, OVERLAY_STATE_FILE), count: local.length });
    }
    if (!archive) continue;
    const archiveFull = path.join(state.overlaysDir, skill, ARCHIVE_STATE_FILE);
    if (archivedEntries.length === 0 && !fs.existsSync(archiveFull)) continue;
    if (writeMachineOwnedFile(archiveFull, renderArchive(archivedEntries, now, redaction))) {
      written.push({ file: path.join("overlays", skill, ARCHIVE_STATE_FILE), count: archivedEntries.length });
    }
  }
  return written;
}

/**
 * 置き場の種類に応じて overlay を書く。開発用チェックアウトは従来どおりリポジトリの
 * `.agents/skills/<id>/references/` を書き直す。配布された写しでは状態の置き場へ書いて、
 * ホストが読む写しへ届け、sync の状態を残す。
 */
export function syncOverlaysForState(plan, {
  now,
  redaction,
  state = learningState(),
  repoRoot = REPO_ROOT,
  homeDir = homedir(),
} = {}) {
  if (state.mode !== "installed") {
    return { mode: state.mode, written: writeOverlayFiles(plan, { now, redaction, repoRoot }), delivery: null };
  }
  const written = writeLocalOverlayFiles(plan, { now, redaction, state, repoRoot });
  const delivery = deliverLearningOverlays({
    overlaysDir: state.overlaysDir,
    copies: learningOverlayCopies({ homeDir, extraRoots: [repoRoot] }),
  });
  writeLearningSyncState(state, {
    at: now,
    overlays: written,
    delivered: { copies: delivery.copies, filesWritten: delivery.written.length, skills: delivery.skillsWithLocalBlock },
  });
  return { mode: state.mode, written, delivery };
}

/**
 * 状態の置き場の台帳（共有台帳と、Channel Pack の既定の置き場）を読む関数。setup のように、
 * 動いているスクリプトの写しとは別の写し（~/plugins/buzzassist/plugin）の状態を sync するときに使う。
 */
export function stateLedgerReader(state, targets) {
  return (kind) => {
    const files = new Set([sharedLedgerPath(state, kind)]);
    for (const [target, definition] of Object.entries(targets || {})) {
      if (definition?.scope !== "channel-pack") continue;
      try {
        files.add(path.join(channelLedgerDir(state, packIdForTarget(target, definition)), `${kind}.jsonl`));
      } catch {
        // pack id が置き場の名前として使えない宛先は読まない（捕捉も同じ理由で止まる）。
      }
    }
    return [...files].flatMap(readJsonl);
  };
}

/**
 * sync の本体（CLI の sync と自動 sync が同じものを使う）。台帳を読み、overlay の計画を立て、
 * 機械が所有する overlay だけを書き直す。人が書く正本には触らない。
 * redaction は呼び出し側が作る（語彙を照合できなければ、作る時点で止まる）。
 */
export function runOverlaySync({
  state = learningState(),
  repoRoot = REPO_ROOT,
  targets = undefined,
  readLedger = undefined,
  redaction,
  now = new Date().toISOString(),
  homeDir = homedir(),
} = {}) {
  const targetMap = targets ?? loadTargetsFor(repoRoot);
  const read = readLedger
    ?? (path.resolve(repoRoot) === REPO_ROOT ? (kind) => learningLedgerPaths(kind).flatMap(readJsonl) : stateLedgerReader(state, targetMap));
  const { readCanonical, hashCanonical } = createCanonicalReaders({ repoRoot, targets: targetMap });
  const summary = summarizeProposals(read("proposals"), read("applied"), readCanonical, hashCanonical);
  const plan = planOverlaySync(summary, targetMap, { homeRoot: homeDir, archivedRecords: read("archived") });
  const synced = syncOverlaysForState(plan, { now, redaction, state, repoRoot, homeDir });
  return { plan, synced };
}

/** 自動 sync を止める環境変数（"0" / "off" で止める）。既定は有効。 */
export const AUTO_SYNC_ENV = "BUZZASSIST_LEARNING_AUTO_SYNC";
export const AUTO_SYNC_LOG_VERSION = "buzzassist-learning-auto-sync-v1";

export function autoSyncDisabled(env = process.env) {
  const value = String(env?.[AUTO_SYNC_ENV] ?? "").trim().toLowerCase();
  return value === "0" || value === "off" || value === "false";
}

/**
 * 自動 sync（Job の決着時と setup のたび）。手動の sync と同じ本体（runOverlaySync）を通す。
 *
 * - 例外を外へ出さない。Job の結果も setup も止めない
 * - 検査語彙を照合できない端末では、今どおり overlay を書かない（fail-closed）。そのときは
 *   理由（vocabulary-missing-file / vocabulary-missing-key など）だけを学習の置き場の
 *   auto-sync.jsonl に残す。--allow-missing-vocabulary 相当の抜け道は無い
 * - 子エージェントの環境と BUZZASSIST_LEARNING_AUTO_SYNC=0 では何もしない
 *
 * @param vocabularyRoot 検査語彙（docs/learning/sensitive-vocabulary.digest.json）と Channel Pack の語を
 *   読む root。既定は repoRoot。setup は自分のソースの root を渡す（配布された写しに語彙は入らない）
 */
export function autoSyncLearningOverlays({
  trigger = "manual",
  env = process.env,
  now = () => new Date().toISOString(),
  state = undefined,
  repoRoot = REPO_ROOT,
  vocabularyRoot = undefined,
  targets = undefined,
  readLedger = undefined,
  homeDir = homedir(),
} = {}) {
  const at = String(typeof now === "function" ? now() : now);
  const label = /^[a-z][a-z0-9-]{0,40}$/u.test(String(trigger)) ? String(trigger) : "manual";
  if (learningWritesForbidden(env)) return { status: "skipped", reason: "child-agent", trigger: label };
  if (autoSyncDisabled(env)) return { status: "skipped", reason: "disabled", trigger: label };
  let resolvedState;
  try {
    resolvedState = state ?? resolveLearningState({ codeRoot: repoRoot, env, homeDir });
  } catch {
    return { status: "failed", reason: "state-unresolved", trigger: label };
  }
  const log = (result) => {
    try {
      appendJsonlRows(resolvedState.autoSyncLogPath, [{ version: AUTO_SYNC_LOG_VERSION, at, mode: resolvedState.mode, ...result }]);
    } catch {
      // 記録できなくても Job と setup は止めない。
    }
    return result;
  };
  let redaction;
  try {
    redaction = overlayRedactionContext({ projectDir: vocabularyRoot ?? repoRoot, homeRoot: homeDir, allowMissingVocabulary: false });
  } catch (error) {
    const reason = error?.code === OVERLAY_VOCABULARY_UNAVAILABLE
      ? `vocabulary-${/^[a-z-]{1,40}$/u.test(String(error.vocabularyState)) ? error.vocabularyState : "unavailable"}`
      : "vocabulary-invalid";
    return log({ status: "skipped", reason, trigger: label });
  }
  try {
    const { plan, synced } = withLearningFileLock(resolvedState.autoSyncLogPath, () => runOverlaySync({
      state: resolvedState, repoRoot, targets, readLedger, redaction, now: at, homeDir,
    }), { timeoutMs: 5000 });
    return log({
      status: "synced",
      trigger: label,
      written: synced.written.length,
      delivered: synced.delivery?.written.length ?? 0,
      held: plan.held.length,
      blocked: plan.blocked.length,
    });
  } catch (error) {
    // 本文やパスは残さない（コードだけ）。
    const code = /^[A-Za-z][A-Za-z0-9_-]{0,60}$/u.test(String(error?.code || "")) ? String(error.code) : "error";
    return log({ status: "failed", reason: "sync-error", code, trigger: label });
  }
}

function overlayRedactionContextForCli(args) {
  const allowMissingVocabulary = args.allowMissingVocabulary === true;
  const redaction = overlayRedactionContext({ allowMissingVocabulary });
  if (redaction.vocabularyMissing) {
    process.stdout.write(
      `⚠️  ${SENSITIVE_VOCABULARY_DIGEST_PATH} が無いまま生成します（--allow-missing-vocabulary）。\n`
      + "    overlay ヘッダに「語彙照合なし」を刻みます。配布前に語彙を作って再 sync してください。\n",
    );
  }
  return redaction;
}

function reportOverlaySync(plan, written, { mode = "development", delivery = null, stateDir = "" } = {}) {
  for (const { file, count } of written) process.stdout.write(`✅ ${file}（${count}件）\n`);
  if (written.length === 0 && plan.held.length === 0) process.stdout.write("更新するものはありませんでした\n");
  if (plan.blocked.length > 0) {
    process.stdout.write(
      `⛔ 書き込み前の検査に当たった ${plan.blocked.length} 件は overlay に載せていません（台帳には残っています）。\n`
      + "    理由は status に出ます。書き直して capture し直してください。\n",
    );
  }
  for (const h of plan.held) {
    process.stdout.write(
      `⏸  ${h.target} は review-only なので自動反映しません（${h.count}件保留）\n`
      + `    ${h.reason ?? "人が書く記録です"}\n`,
    );
  }
  if (mode === "installed") {
    // 運営者の端末: 状態の置き場の区画を、ホストが読む写しへもう届けてある。
    process.stdout.write(
      `\nこの端末の学習の置き場: ${stateDir}\n`
      + `ホストが読む写し ${delivery?.copies.length ?? 0} 個へ届けました（書き換え ${delivery?.written.length ?? 0} ファイル）`
      + `${delivery?.copies.length ? `: ${delivery.copies.join(", ")}` : ""}\n`
      + "新しいセッションから読まれます。setup と自動更新のあとも、同じ区画を届け直します。\n",
    );
    return;
  }
  // 正本を書き換えても、ホストが読むのは配布コピー。setup を再実行
  // しないと、エージェントは古い指示を読み続ける。
  process.stdout.write(
    "\n配布し直しが要ります: 正本を書き換えたので、ホストが読む配布コピーは古いままです。\n"
    + "  node scripts/setup-agents.mjs --agent <host> --project-dir <dir> --no-launch\n"
    + "  確認: node scripts/harness-doctor.mjs（shipped-skill-drift）\n",
  );
}

// hermes の curator が言う「クラスレベルへ寄せる」を、機械的にできる範囲で
// 用意する。同じ target に複数の未反映提案が溜まっていたら、それは
// 個別に足すのではなくまとめて1つの節にすべきという合図。
export function clusterForConsolidation(summary) {
  const pending = summary.filter((entry) => !entry.applied);
  const byTarget = new Map();
  for (const entry of pending) {
    if (!byTarget.has(entry.target)) byTarget.set(entry.target, []);
    byTarget.get(entry.target).push(entry);
  }
  return [...byTarget.entries()]
    .map(([target, entries]) => ({
      target,
      entries,
      // 2件以上溜まっていたら、個別追記ではなくまとめて書き直す方が良い。
      recommendation: entries.length >= 2
        ? "この target の未反映をまとめて1つの節に書く（個別に追記しない）"
        : "1件のみ。既存の節へ吸収できないか先に確認する",
    }))
    .sort((a, b) => b.entries.length - a.entries.length);
}

// 宛先が deployment 相対なら、配置先を運営者の配置表（config/harness-deployments.json）から引く。
// 解析は共通の解決器（lib/harnessDeploymentResolver.mjs）に任せる（同じ規則を2か所に持たない）。
//
// ただし、共通の解決器が持つ「配置表が無ければ同梱の example へ戻る」はここでは使わない。
// example の root は "." で、実行する場所としては正しいが、**台帳の置き場としては共有台帳と
// 同じ場所になる**。新規インストール（配置表なし）では pack 側の台帳へ書く（ledgerPathFor の
// 既定）のが正しく、配布シミュレーションもそれを確かめている。
//
// リポジトリ内の配置は相対で返す（記録に端末の絶対パスを残さない）。
function resolveDeploymentRoot(harnessId, repoRoot = REPO_ROOT) {
  const operatorMap = path.join(repoRoot, "config", "harness-deployments.json");
  if (!fs.existsSync(operatorMap)) return null;
  let deployment;
  try {
    deployment = loadHarnessDeployments({ repoRoot, deploymentPath: operatorMap }).get(harnessId);
  } catch {
    return null;
  }
  if (!deployment) return null;
  const rel = path.relative(repoRoot, deployment.root);
  if (rel === "") return ".";
  return rel.startsWith("..") || path.isAbsolute(rel) ? deployment.root : rel;
}

/** 正本をどこから読んだかの表示名。出力と applied 記録（targetSource）で使う。 */
export const CANONICAL_SOURCE_LABELS = Object.freeze({
  "channel-pack": "Channel Pack",
  "channel-pack-env": "Channel Pack（BUZZASSIST_CHANNEL_PACK）",
  deployment: "配置先（config/harness-deployments.json）",
  "operator-project": "運営者の私有プロジェクト（config/harness-deployments.json の channelLearning）",
  channel: "チャンネルの学習の保存先（台帳の channels と channelLearning の channel ごとの宣言）",
  repository: "リポジトリ",
});

function sameFile(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

/**
 * channel-pack 宛の正本を「Channel Pack を先に見る」順で解決する（ops-7）。
 *
 * 以前はリポジトリの docs/ を先に見て、そこに無いときだけ pack を見ていた。
 * docs/ には pack へ移す前の写しが git 管理外のまま残りうる（.gitignore 済みで
 * 誰も気づかない）。**古い写しがあると、それが本物の pack より優先され、
 * promote / apply は古い写しで印を探し、古い写しの sha256 を記録した**。
 * status の読み取り側（readCanonical / hashCanonical）は pack をまったく見て
 * いなかったので、書く側と読む側で別のファイルを比べることもあった。
 *
 * 探す順は共通の解決器（lib/channelPackResolver.mjs）に任せる:
 * BUZZASSIST_CHANNEL_PACK → <repo>/channel-packs/<packId>/ → リポジトリ直下。
 * 合成 fixture は承認記録の材料にならないので候補から外す。リポジトリ直下は
 * pack 側に正本が無いときだけ使い、どちらを使ったかを呼び出し側へ返す。
 */
export function resolvePackFirstCanonical(relativePath, { repoRoot = REPO_ROOT, packId } = {}) {
  const found = resolveChannelPackSource(repoRoot, relativePath, packId, { includeFixture: false });
  const repoPath = path.resolve(repoRoot, relativePath);
  if (found.kind !== "legacy") {
    const shadowed = fs.existsSync(repoPath) && !sameFile(repoPath, found.path);
    return {
      full: found.path,
      source: found.kind === "env" ? "channel-pack-env" : "channel-pack",
      missing: false,
      packRoot: found.root,
      // pack が勝ったので読まなかったリポジトリ側の写し。出力で知らせる。
      ignoredRepoCopy: shadowed ? repoPath : null,
      packRootWithoutCanonical: null,
    };
  }
  // pack 側のどこにも正本が無い。ここで初めてリポジトリ直下（従来の配置）を使う。
  const presentRoot = channelPackRootEntries(repoRoot, packId)
    .find((entry) => entry.kind !== "fixture" && fs.existsSync(entry.root));
  return {
    full: repoPath,
    source: "repository",
    missing: !fs.existsSync(repoPath),
    packRoot: null,
    ignoredRepoCopy: null,
    packRootWithoutCanonical: presentRoot ? presentRoot.root : null,
  };
}

/**
 * target の正本の置き場を解決する。requireTarget / promote / apply / status の
 * 表示が同じ規則を使う。
 *
 * - channel-pack 宛（配置先相対でないもの）: pack を先に見る。
 * - channel-pack 宛で配置先相対: 運営者が宣言した配置先がそのチャンネルの置き場。
 * - それ以外（platform / genre）: 従来どおり。リポジトリを先に見る。
 */
export function resolveCanonicalTarget(rawTarget, {
  repoRoot = REPO_ROOT,
  targets = undefined,
  deploymentRootFor = undefined,
  channel = null,
} = {}) {
  const target = resolveTarget(rawTarget);
  const targetMap = targets ?? loadTargetsFor(repoRoot);
  const def = targetMap[target];
  if (!def?.canonical) {
    throw new Error(
      `未知の target: ${target}\n使えるのは:\n`
        + Object.keys(targetMap).map((key) => `  ${key}`).join("\n"),
    );
  }
  let rel = def.canonical;
  if (isChannelPackTarget(target)) {
    // チャンネルの保存先、運営者の私有プロジェクト（channelLearning）か、リポジトリの外の配備。共有台帳と重なる設定は止める。
    const store = resolveChannelLearningStore(target, def, { repoRoot, deploymentRootFor, channel });
    if (store?.source === "operator-project" || store?.source === "channel") {
      // 記録には保存先の中の相対 path だけを残す（端末の絶対 path を記録に持ち込まない）。
      const full = path.resolve(store.root, rel);
      return {
        target,
        rel,
        full,
        missing: !fs.existsSync(full),
        source: store.source,
        storeRoot: store.root,
        ...(store.channelId ? { channelId: store.channelId } : {}),
      };
    }
    if (store?.source === "deployment") {
      const root = path.relative(repoRoot, store.root);
      rel = path.join(root && !root.startsWith("..") && !path.isAbsolute(root) ? root : store.root, rel);
      const full = path.resolve(repoRoot, rel);
      return { target, rel, full, missing: !fs.existsSync(full), source: "deployment" };
    }
  }
  if (isChannelPackTarget(target)) {
    // 捕捉は正本が手元に無くても受け取る（missing を返すだけ）。書き込む工程
    // （promote / apply）だけが requireWritableTarget で実在を要求する。
    return { target, rel, ...resolvePackFirstCanonical(rel, { repoRoot, packId: packIdForTarget(target, def) }) };
  }
  // platform / genre は従来どおり: リポジトリに無いときだけ pack 側を試す。
  let full = path.resolve(repoRoot, rel);
  if (!fs.existsSync(full)) {
    const viaPack = resolveChannelPackPath(repoRoot, rel);
    if (fs.existsSync(viaPack)) full = viaPack;
  }
  // 捕捉は「あとで判断するための記録」なので、正本が手元に無くても
  // 受け取る。書き込む工程（sync / promote）だけが正本の実在を要求する
  // ——ここで拒否すると、pack を持たない人は指摘を残すことすらできない。
  return { target, rel, full, missing: !fs.existsSync(full), source: "repository" };
}

function requireTarget(rawTarget) {
  return resolveCanonicalTarget(rawTarget);
}

/** 書き込む工程だけが要求する。読むだけの工程は missing を許す。 */
export function requireWritableTarget(rawTarget, options = {}) {
  const resolved = resolveCanonicalTarget(rawTarget, options);
  if (resolved.missingDeployment) {
    throw new Error(
      `${resolveTarget(rawTarget)} は ${resolved.missingDeployment} の配置先が要ります。`
      + "config/harness-deployments.json に root を書いてください"
      + "（このファイルは運営者固有なので追跡しません。捕捉はできますが、書き込みは配置先が要ります）",
    );
  }
  if (resolved.missing) {
    throw new Error(
      `target の正本がこの環境にありません: ${resolved.rel}\n`
      + (resolved.packRootWithoutCanonical
        ? `  Channel Pack（${resolved.packRootWithoutCanonical}）にもリポジトリ側にも見つかりません。\n`
        : "")
      + "Channel Pack を配置するか BUZZASSIST_CHANNEL_PACK を指定してください"
      + "（捕捉はできますが、書き込みは正本が要ります）",
    );
  }
  return resolved;
}

/**
 * applied 記録の targetPath を、記録した target の規則で読む場所へ解決する。
 * status / curator が「反映済みか」を判定するときの読み先。promote / apply が
 * 印を探して sha256 を取ったのと同じファイルを指さなければ、照合が意味を持たない。
 *
 * record が無い（相対パスだけで呼ばれた）ときと共有層宛は、従来どおりリポジトリ基準。
 */
export function resolveRecordedCanonical(record, {
  repoRoot = REPO_ROOT,
  targets = undefined,
  channel = null,
} = {}) {
  const rel = record?.targetPath;
  if (typeof rel !== "string" || rel === "") return null;
  const target = resolveTarget(String(record?.target || ""));
  if (!isChannelPackTarget(target)) {
    const full = path.resolve(repoRoot, rel);
    return { full, source: "repository", missing: !fs.existsSync(full) };
  }
  const def = (targets ?? loadTargetsFor(repoRoot))[target] ?? {};
  let store = null;
  try {
    store = resolveChannelLearningStore(target, def, { repoRoot, channel });
  } catch (error) {
    if (error?.code !== CHANNEL_LEARNING_STORE_ERROR && error?.code !== CHANNEL_LEARNING_SCOPE_ERROR) throw error;
    return { full: null, source: channel ? "channel" : "operator-project", missing: true };
  }
  if (store?.source === "operator-project" || store?.source === "channel") {
    // 私有プロジェクト・チャンネルの保存先への記録は、保存先の中の相対 path で残っている。
    const full = path.resolve(store.root, rel);
    return { full, source: store.source, missing: !fs.existsSync(full) };
  }
  if (store?.source === "deployment") {
    // 記録の targetPath は配置先を含む形で残っている。配置先がそのチャンネルの置き場。
    const full = path.resolve(repoRoot, rel);
    return { full, source: "deployment", missing: !fs.existsSync(full) };
  }
  return resolvePackFirstCanonical(rel, { repoRoot, packId: packIdForTarget(target, def) });
}

/**
 * summarizeProposals / isActuallyApplied へ渡す読み手。readCanonical(rel, record) の
 * 第2引数で記録の target を受け取り、channel-pack 宛なら pack を先に読む。
 */
export function createCanonicalReaders({ repoRoot = REPO_ROOT, targets = undefined, channel = null } = {}) {
  // targets.json は記録ごとに読み直さない。共有層宛しか無ければ読みもしない。
  let targetMap = targets;
  // チャンネルの範囲で読むなら、channel-pack 宛の記録はそのチャンネルの保存先の正本と照合する。
  const scope = channelLearningScopeOf(channel, { repoRoot });
  const locate = (rel, record = null) => {
    const target = String(record?.target || "");
    const packTarget = isChannelPackTarget(resolveTarget(target));
    if (packTarget) targetMap ??= loadTargetsFor(repoRoot);
    return resolveRecordedCanonical({ target, targetPath: rel }, {
      repoRoot,
      targets: packTarget ? targetMap : {},
      channel: packTarget ? scope : null,
    });
  };
  return {
    locate,
    readCanonical: (rel, record = null) => {
      const location = locate(rel, record);
      return location && !location.missing ? fs.readFileSync(location.full, "utf8") : null;
    },
    hashCanonical: (rel, record = null) => {
      const location = locate(rel, record);
      return location && !location.missing
        ? createHash("sha256").update(fs.readFileSync(location.full)).digest("hex")
        : null;
    },
  };
}

function displayCanonicalPath(full, repoRoot = REPO_ROOT) {
  if (!full) return "(未解決)";
  const rel = path.relative(repoRoot, full);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : full;
}

/**
 * channel-pack 宛の正本をどこから読んだかを、人が読める行にする。
 * 共有層宛は従来の出力を変えないので空配列を返す。
 */
export function describeCanonicalResolution(resolved, { repoRoot = REPO_ROOT, indent = "  " } = {}) {
  if (!resolved || !isChannelPackTarget(resolved.target)) return [];
  if (resolved.missingDeployment) {
    return [`${indent}正本: 配置先が未設定（${resolved.missingDeployment}。config/harness-deployments.json）`];
  }
  const label = CANONICAL_SOURCE_LABELS[resolved.source] ?? resolved.source;
  const lines = [
    resolved.missing
      ? `${indent}正本: 見つかりません（${label} を探した: ${displayCanonicalPath(resolved.full, repoRoot)}）`
      : `${indent}正本: ${displayCanonicalPath(resolved.full, repoRoot)}（${label}）`,
  ];
  if (resolved.ignoredRepoCopy) {
    lines.push(`${indent}  リポジトリ側の同名ファイルは読みません（pack 側が優先）: ${displayCanonicalPath(resolved.ignoredRepoCopy, repoRoot)}`);
  }
  if (resolved.packRootWithoutCanonical) {
    lines.push(`${indent}  Channel Pack（${displayCanonicalPath(resolved.packRootWithoutCanonical, repoRoot)}）に正本が無いので、リポジトリ側を使います`);
  }
  return lines;
}

/**
 * status（--channel なし）の末尾に出す、チャンネルごとの保存先の未反映の件数。中身は混ぜずに件数だけを出す。
 * 台帳を読めなくても status 自体は止めない（理由のコードだけを出す）。
 */
export function channelStoreStatusLines({ repoRoot = REPO_ROOT, env = process.env } = {}) {
  let registry;
  try {
    registry = loadChannelRegistry({ repoRoot, env });
  } catch (error) {
    return ["", `チャンネル単位の台帳は数えていません（台帳を読めない: ${String(error?.code || "error")}）`];
  }
  const lines = [];
  for (const channel of registry.channels || []) {
    if ((channel.learning || []).length === 0) continue;
    try {
      const scope = resolveChannelLearningScope(channel.id, { repoRoot, env, registry });
      const readers = createCanonicalReaders({ repoRoot, channel: scope });
      const pending = summarizeProposals(
        readLearningLedgerRows("proposals", { channel: scope }),
        readLearningLedgerRows("applied", { channel: scope }),
        readers.readCanonical,
        readers.hashCanonical,
      ).filter((entry) => !entry.applied && isChannelPackTarget(resolveTarget(entry.target))).length;
      lines.push(`  ${channel.id}: 未反映 ${pending} 件`);
    } catch (error) {
      lines.push(`  ${channel.id}: 読めません（${String(error?.code || "error")}）`);
    }
  }
  if (lines.length === 0) return [];
  return ["", "チャンネル単位の台帳（チャンネルで作った Job の学習。上の一覧には含めない。見るときは --channel <id>）", ...lines];
}

/** promote / apply の失敗文に添える「実際に読んだファイル」。共有層宛は従来の文面のまま。 */
function checkedCanonicalNote(resolved) {
  const lines = describeCanonicalResolution(resolved, { indent: "  " });
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * applied 記録に残す「どの写しの sha256 か」。channel-pack 宛だけに付ける
 * （共有層宛の記録の形は変えない）。絶対パスは残さない。
 */
function recordedCanonicalSource(resolved) {
  return isChannelPackTarget(resolved?.target) ? resolved.source : undefined;
}

/**
 * 共有層へ書く提案に、チャンネル固有語が混ざっていないか。
 *
 * 宛先が共有層（platform / genre / skill）でも、evidence にキャスト名や
 * 番組名が入りうる。実際そうなった——ジャンル層の提案の根拠に
 * 固定キャスト3人の名前が書かれ、**公開リポジトリへ commit された**。
 * 宛先の層と、書かれる中身の層は別物。
 *
 * 検出した語そのものは返さない。呼び出し側のエラー文もログに残る。
 */
/**
 * 人が確認したことを、機械が名乗れないようにする。
 *
 * このスキルの大原則は「promote には reviewer 名が要る。『機械が書いた』と
 * 『人が確認した』の差がこの一手で、この差が無くなると自己改善が自己認証に変わる」。
 *
 * だが reviewer をコマンドライン引数で受けていたので、**エージェントが
 * ユーザーの名前を打ち込めば通った**。実際そうなった——台帳に残る17件の
 * `reviewer` は、人が確認したのではなくエージェントが打ったものだった。
 * ガードを書いた本人が、そのガードを迂回していた。
 *
 * 最初の修正は TTY の有無で区別した。**これは証明にならない。** Codex の
 * レビューで実測された: `script -q /dev/null node ...` を通せば
 * `process.stdin.isTTY` は true になり、エージェントは人を名乗れる。
 * しかも当時は TTY を先に見ていたので、**PTY 経由で --agent-attested を
 * 付けても「人の確認」として記録された**。
 *
 * シェルを持つエージェントが同じ機械にいる以上、人の確認を機械的に
 * 強制することはできない。できるのは3つだけで、ここはそれをやる:
 *
 *   1. 既定を拒否にする（黙って人を名乗れる状態を無くす）
 *   2. 詐称に明示的な一手を要求し、何を名乗ったかを記録に残す
 *   3. **人の確認が無いものを「反映済み」として数えない**
 *
 * 3が実効の中心。ここを見ていなかったので、`agent-self-attested` も
 * `unverified-agent-typed` も、人の確認と同じ効力で applied になっていた。
 *
 * 本当の関門は、この台帳が git で追跡されていること——commit を人が読む
 * ところにある。ここで作るのは関門ではなく、**読める証跡**。
 */

/**
 * 人の確認として数える印。これ以外は記録に残るが「反映済み」にはならない（例外は、差分の承認キューで
 * エージェントが当てた変更だけ。isAgentAppliedChange を参照）。
 */
export const HUMAN_VERIFIED = "human-verified";

export function attestationFor({ reviewer, isInteractive, agentAttested, humanVerified }) {
  const name = String(reviewer || "").trim();
  if (!name) {
    return { ok: false, message: "reviewer 名が要ります（--reviewer <名前>）。" };
  }
  // 明示が推測に勝つ。TTY より --agent-attested を先に見る。
  // 逆順だったので、PTY 経由の機械が人として記録されていた。
  if (agentAttested) {
    return {
      ok: true,
      attestation: { reviewer: "agent", attestedBy: "agent-self-attested", claimedReviewer: name },
    };
  }
  if (humanVerified) {
    if (!isInteractive) {
      return {
        ok: false,
        message:
          "--human-verified は対話端末からのみ受け付けます。"
          + "機械の判断として残すなら --agent-attested を付けてください。",
      };
    }
    // 二手を要求する。TTY だけでは足りない（PTY で作れる）。
    // これは詐称を止める仕掛けではなく、詐称を「既定の経路」から外して
    // 記録に残す仕掛け。止めるのは commit を読む人。
    return { ok: true, attestation: { reviewer: name, attestedBy: HUMAN_VERIFIED } };
  }
  if (isInteractive) {
    // 対話端末だったという事実だけ。人が読んだ証拠ではない。
    return {
      ok: true,
      attestation: { reviewer: name, attestedBy: "cli-interactive-claimed" },
    };
  }
  return {
    ok: false,
    message:
      "人の確認として記録しようとしていますが、その裏づけがありません。"
      + "人が確認したのなら、その人自身の端末から --human-verified を付けて実行してください。"
      + "機械の判断として残すなら --agent-attested を付けてください"
      + "（reviewer は 'agent' として記録され、人の確認とは区別されます）。",
  };
}

export function channelTermsInSharedEntry(entry, signals) {
  const target = String(entry?.target || "");
  // 旧名（ledger: / doc:）も対応表で channel-pack: へ解決してから層を判定する。
  const isShared = !resolveTarget(target).startsWith("channel-pack:");
  if (!isShared) return { ok: true, hits: 0 };
  const body = `${entry?.text || ""}\u001f${entry?.evidence || ""}`;
  const terms = (signals?.terms || []).filter((term) => body.includes(term));
  const ids = (signals?.castIds || []).filter((id) => new RegExp(`\\b${id}\\b`, "u").test(body));
  const hits = terms.length + ids.length;
  return {
    ok: hits === 0,
    hits,
    message: hits === 0 ? "" :
      `共有層（${target}）の提案に、チャンネル固有の語が ${hits} 箇所ある。`
      + "宛先が共有層でも、根拠にキャスト名や番組名を書くと公開リポジトリへ入る。"
      + "根拠を一般的な言い方へ書き換えるか、宛先を channel-pack: へ変えること。",
  };
}

/**
 * 共有層の提案に、検査語彙（語彙ファイルにだけある語）が入っていないか。
 *
 * channelTermsInSharedEntry は Channel Pack の語しか見ない。語彙ファイルにだけある
 * 語——依頼者や運営者の名前、顧客の識別子、端末の作業ディレクトリ名——は素通りし、
 * 実際に共有台帳へ「依頼者の名前＋発言の引用」が入ったまま push されるところだった。
 * 共有台帳は公開リポジトリで追跡されるので、書く前に止める。
 * 語彙を照合できない環境（鍵が無い端末）では通す——push 前の検査が同じ語彙で止める。
 */
export function privateTermsInSharedEntry(entry, vocabulary) {
  const target = String(entry?.target || "");
  // 旧名（ledger: / doc:）も対応表で channel-pack: へ解決してから層を判定する。
  const isShared = !resolveTarget(target).startsWith("channel-pack:");
  if (!isShared || !vocabulary) return { ok: true, hits: 0, checked: Boolean(vocabulary) };
  const { hits } = redactVocabularyDigestTokens(`${entry?.text || ""} ${entry?.evidence || ""}`, vocabulary);
  return {
    ok: hits === 0,
    hits,
    checked: true,
    message: hits === 0 ? "" :
      `共有層（${target}）の提案に、公開してはいけない語が ${hits} 箇所ある（検査語彙に一致）。`
      + "人の名前・顧客の識別子・端末のパスを一般的な言い方へ書き換えること。"
      + "発言をそのまま引用せず、何を直すべきかの形にすること。",
  };
}

function defaultPrivateVocabulary() {
  try {
    return loadSensitiveVocabulary(path.join(REPO_ROOT, SENSITIVE_VOCABULARY_DIGEST_PATH), { projectDir: REPO_ROOT }).vocabulary;
  } catch {
    return null;
  }
}

/**
 * 書き込み前の検査（lib/harnessLearningInspection.mjs）に当たった提案を、削除せず
 * blocked として残せる形にする。
 *
 * 共有台帳は公開リポジトリで追跡されるので、資格情報と端末パスは逐語で残さず
 * 置き換える（元の文字列は指紋だけ）。ID は置き換え後の本文から作り直す——同じ
 * 危ない文字列を何度捕捉しても同じ ID になり、台帳の行と ID が自己矛盾しない。
 * blocked の提案は sync で overlay に載らず、promote / apply でも昇格できない。
 */
export function blockProposalIfUnsafe(entry, { homeRoot = homedir(), now = entry?.capturedAt } = {}) {
  const reasons = inspectLearningProposal(entry, { homeRoot });
  if (reasons.length === 0) return entry;
  const neutralized = {
    ...entry,
    text: neutralizeLearningText(entry.text, { homeRoot }),
    evidence: entry.evidence === null || entry.evidence === undefined
      ? entry.evidence
      : neutralizeLearningText(entry.evidence, { homeRoot }),
  };
  const { id: _previousId, ...withoutId } = neutralized;
  const blocked = {
    version: LEARNING_INSPECTION_VERSION,
    reasons,
    detectedAt: now ?? null,
    originalSha256: blockedOriginalDigest(entry),
  };
  const next = { ...withoutId, blocked };
  return { ...next, id: proposalId(next) };
}

/**
 * promote / apply の前に見る。blocked の提案と、検査に当たる --note は通さない。
 *
 * note は applied 台帳（公開リポジトリで追跡）に残り、正本にも同じ文が要る。
 * 注入文や端末パスを含む note を通すと、検査を迂回して正本と台帳へ運べてしまう。
 */
export function assertPromotableProposal(entry, note = "", { homeRoot = homedir() } = {}) {
  const reasons = learningBlockReasons(entry, { homeRoot });
  if (reasons.length > 0) {
    throw new Error(
      `${entry?.id} は書き込み前の検査に当たった提案（blocked）なので昇格できません。`
      + `理由: ${describeLearningBlockReasons(reasons)}。`
      + "何を直すかの形に書き直して capture し直してください。",
    );
  }
  const noteReasons = inspectLearningText(typeof note === "string" ? note : "", { homeRoot });
  if (noteReasons.length > 0) {
    throw new Error(
      `--note が書き込み前の検査に当たりました: ${describeLearningBlockReasons(noteReasons)}。`
      + "note は applied 台帳と正本の両方に残るので、この形では記録しません。",
    );
  }
}

// 機械の捕捉経路（Receipt からの自動捕捉など）が提案に添える付帯情報。ID には
// 入れない（同じ観測を別の Receipt から捕捉したときに同じ提案として数えるため）。
// 自由文を入れさせないよう、キーごとに形を固定する。
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const METADATA_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
export const PROPOSAL_METADATA_CREATORS = new Set(["auto-receipt", "auto-script-quality"]);
export const PROPOSAL_RECEIPT_SOURCES = new Set(["run-receipt", "adapter-run-receipt", "job-state", "script-quality-round"]);

export function normalizeProposalMetadata(metadata) {
  if (metadata === undefined || metadata === null) return {};
  if (typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("metadata は object にしてください");
  const allowed = new Set(["createdBy", "receiptDigest", "receiptSource", "skillShaAtCapture", "gateIds", "harness"]);
  const unknown = Object.keys(metadata).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`metadata に未知のキーがあります: ${unknown.join(", ")}`);
  const out = {};
  if (metadata.createdBy !== undefined) {
    if (!PROPOSAL_METADATA_CREATORS.has(metadata.createdBy)) throw new Error("metadata.createdBy が既知の捕捉経路ではありません");
    out.createdBy = metadata.createdBy;
  }
  if (metadata.receiptDigest !== undefined) {
    if (!SHA256_HEX.test(String(metadata.receiptDigest))) throw new Error("metadata.receiptDigest は sha256 にしてください");
    out.receiptDigest = String(metadata.receiptDigest);
  }
  if (metadata.receiptSource !== undefined) {
    if (!PROPOSAL_RECEIPT_SOURCES.has(metadata.receiptSource)) throw new Error("metadata.receiptSource が不正です");
    out.receiptSource = metadata.receiptSource;
  }
  if (metadata.skillShaAtCapture !== undefined) {
    const value = metadata.skillShaAtCapture;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("metadata.skillShaAtCapture は object にしてください");
    const entries = Object.entries(value);
    if (entries.length > 20 || entries.some(([name, sha]) => !METADATA_ID.test(name) || !SHA256_HEX.test(String(sha)))) {
      throw new Error("metadata.skillShaAtCapture はスキル名 → sha256 の対応にしてください");
    }
    out.skillShaAtCapture = Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
  }
  if (metadata.gateIds !== undefined) {
    const ids = Array.isArray(metadata.gateIds) ? metadata.gateIds.map(String) : null;
    if (!ids || ids.length > 50 || ids.some((id) => !METADATA_ID.test(id))) throw new Error("metadata.gateIds はゲート id の配列にしてください");
    out.gateIds = [...new Set(ids)].sort();
  }
  if (metadata.harness !== undefined) {
    const { id, version } = metadata.harness || {};
    if (!METADATA_ID.test(String(id || "")) || (version !== undefined && !METADATA_ID.test(String(version)))) {
      throw new Error("metadata.harness は { id, version } にしてください");
    }
    out.harness = { id: String(id), ...(version !== undefined ? { version: String(version) } : {}) };
  }
  return out;
}

export function buildProposal({ kind, target, text, evidence, session, now, metadata }) {
  if (!PROPOSAL_KINDS.has(kind)) {
    throw new Error(`kind は ${[...PROPOSAL_KINDS].join(" / ")} のいずれかにしてください: ${kind}`);
  }
  // 文字数は具体性の雑な代理でしかない。日本語では「目の左右が逆」のような
  // 6文字が十分に具体的な指摘になる一方、長くても中身の無い文はある。
  // ここで弾きたいのは「だめ」「違う」のような、次に読む人が何も判断できない
  // 反応だけ。本当の具体性は evidence と、status を読む人が見る。
  if (typeof text !== "string" || text.trim().length < 5) {
    throw new Error("text が短すぎます。何をどうすべきかが分かる形で書いてください");
  }
  const normalizedSession = typeof session === "string" ? session.trim() : "";
  if (!normalizedSession) {
    throw new Error("session が必要です。同じセッション内の重複捕捉を水増ししないため --session を指定してください");
  }
  requireTarget(target);
  const entry = {
    kind,
    target,
    text: text.trim(),
    evidence: evidence?.trim() || null,
    session: normalizedSession,
    capturedAt: now,
    ...normalizeProposalMetadata(metadata),
  };
  return { ...entry, id: proposalId(entry) };
}

/**
 * capture CLI と外部collectorが共有する、proposal台帳への唯一の追記経路。
 * 正本・overlay・applied台帳には触れない。
 *
 * channelId（台帳のチャンネルの id）か channelScope（resolveChannelLearningScope の結果）を渡せば、
 * そのチャンネルの保存先へ書き、行に channel を残す。チャンネルを付けられるのは channel-pack 宛だけで、
 * 共有層（genre: / platform:）宛に付けると止める——チャンネル固有の事実を共有層へ上げないため。一般化するなら、
 * チャンネルを外し、一般的な言い方で別の提案として capture する（共有層の語の検査はそちらで効く）。
 */
export function captureLearningProposal(input, {
  append = appendJsonl,
  read = readJsonl,
  ledgerPathResolver = ledgerPathFor,
  lock = withProposalCaptureLock,
  signals = collectSensitiveSignals(REPO_ROOT),
  refreshCatalog = refreshCatalogForSharedLedger,
  privateVocabulary = undefined,
  homeRoot = homedir(),
  env = process.env,
  channelId = "",
  channelScope = null,
} = {}) {
  // 子エージェントの印があれば、台帳へ書く前に止める（Canvas feedback や Receipt の
  // 自動捕捉もこの関数を通るので、CLI だけでなくここでも見る）。
  assertLearningWriteAllowed(env, "capture");
  const proposal = buildProposal(input);
  const scope = channelLearningScopeOf(channelScope ?? (String(channelId || "").trim() || null), { env });
  if (scope && !isChannelPackTarget(resolveTarget(proposal.target))) {
    throw channelScopeError(
      CHANNEL_SCOPE_SHARED_TARGET_ERROR,
      `共有層の宛先（${proposal.target}）にチャンネル（${scope.channelId}）は付けません。チャンネル固有の事実を共有層へ上げないためです。`
        + "一般化するなら、チャンネルを外して一般的な言い方で別の提案として capture してください。",
    );
  }
  // 行に残すチャンネルの印（ID には入れない。同じ観測は同じ提案として数える）。
  const built = scope ? { ...proposal, channel: scope.channelId } : proposal;
  const verdict = channelTermsInSharedEntry(built, signals);
  if (!verdict.ok) throw new Error(verdict.message);
  const vocabulary = privateVocabulary === undefined ? defaultPrivateVocabulary() : privateVocabulary;
  const privateVerdict = privateTermsInSharedEntry(built, vocabulary);
  if (!privateVerdict.ok) throw new Error(privateVerdict.message);
  // 語彙の照合とは別の層として、文字列の形（注入・隠しコメント・不可視文字・
  // 資格情報・端末パス）を見る。検出しても捨てずに blocked として残す。
  const entry = blockProposalIfUnsafe(built, { homeRoot });
  // 配布された写しでの最初の書き込みの前に、古い写しの台帳を取り込む（1回だけ）。
  // 先に書くと「状態の置き場が空ではない」になり、古い台帳を取り込む機会が無くなる。
  if (ledgerPathResolver === ledgerPathFor) ensureLearningStateReady({ env });
  // 台帳（チャンネルの保存先・チャンネルの無い Job の保存先の宣言）は、捕捉と同じ env で読む。
  const ledgerPath = ledgerPathResolver(entry.target, "proposals", { ...(scope ? { channel: scope } : {}), env });
  assertCaptureLedgerIsolation(entry.target, ledgerPath, ledgerPathResolver);
  return lock(ledgerPath, () => {
    const duplicate = read(ledgerPath).some((row) => {
      const id = row?.id ?? proposalId(row);
      return id === entry.id && row?.session === entry.session;
    });
    if (!duplicate) append(ledgerPath, entry);
    const catalog = duplicate ? { written: false } : refreshCatalog(ledgerPath);
    return { entry, ledgerPath, appended: !duplicate, catalog };
  });
}

/** config/harnesses/*.harness.json を読む。ゲート id の語彙に使う。 */
function loadHarnessDeclarations(repoRoot = REPO_ROOT) {
  const dir = path.join(repoRoot, "config", "harnesses");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".harness.json"))
    .sort()
    .flatMap((name) => {
      try {
        return [JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))];
      } catch {
        return [];
      }
    });
}

/**
 * curate --archive の記録を作る。候補に出ていない項目は退避させない
 * （機械が「長く再発していない・関連ゲートも出ていない」と確かめた項目に限る）。
 */
export function archiveRecordsFor(report, { ids = [], reason, attestation, now } = {}) {
  if (!attestation?.ok) throw new Error(attestation?.message || "reviewer 名が要ります（--reviewer <名前>）。");
  if (ids.length === 0) throw new Error("--id <提案ID>[,<提案ID>...] が必要です（curate の候補から選ぶ）");
  const text = typeof reason === "string" ? reason.trim() : "";
  if (Array.from(text).length < 5) throw new Error("--reason に退避の理由を書いてください（何を見て、もう要らないと判断したか）");
  const reasonFindings = inspectLearningText(text);
  if (reasonFindings.length > 0) {
    throw new Error(`--reason が書き込み前の検査に当たりました: ${describeLearningBlockReasons(reasonFindings)}`);
  }
  const byId = new Map(report.candidates.map((candidate) => [candidate.id, candidate]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(
      `退避の候補ではありません: ${missing.join(", ")}。`
      + "curate（dry-run）が候補に出したものだけを退避できます——最近再発した項目や、"
      + "関連ゲートが直近の Receipt で落ちている項目は、効いている規則かもしれないので外さない。",
    );
  }
  return ids.map((id) => {
    const candidate = byId.get(id);
    return {
      version: ARCHIVE_RECORD_VERSION,
      id,
      target: candidate.target,
      overlay: candidate.overlay,
      lastSeenAt: candidate.lastSeenAt,
      idleDays: candidate.idleDays,
      relatedGates: candidate.relatedGates,
      reason: text,
      reviewer: attestation.attestation.reviewer,
      attestedBy: attestation.attestation.attestedBy,
      ...(attestation.attestation.claimedReviewer ? { claimedReviewer: attestation.attestation.claimedReviewer } : {}),
      archivedAt: now,
    };
  });
}

function printCurateReport(report) {
  process.stdout.write(
    `退避候補（dry-run。何も書き換えていません。最後の再発から ${report.staleDays} 日以上、`
    + `関連ゲートが直近 ${report.gateWindowDays} 日の Receipt で不合格・skip に出ていない項目）\n\n`,
  );
  if (report.candidates.length === 0) {
    process.stdout.write("候補はありません\n");
  }
  for (const candidate of report.candidates) {
    process.stdout.write(`  [${candidate.id}] → ${candidate.target}（${candidate.occurrences}回指摘）\n`);
    process.stdout.write(`      ${candidate.reason}\n`);
  }
  process.stdout.write(
    `\n見た項目 ${report.considered} 件 / 最近再発して残す ${report.kept.recent} 件 / 関連ゲートが直近に出て残す ${report.kept.gateSeen} 件`
    + ` / 退避済み ${report.archivedCount} 件\n`
    + "再発しないのは、その規則が効いているからかもしれません。機械はここで止まり、退避は人が決めます:\n"
    + "  node scripts/harness-learn.mjs curate --archive --id <id>[,<id>] --reviewer <名前> --reason \"何を見て判断したか\" --human-verified\n",
  );
}

/** 台帳・overlay・正本側の記録を書く操作。子エージェントの印があれば拒否する。 */
export const LEARNING_WRITE_ACTIONS = new Set(["capture", "sync", "promote", "apply", "curate", "pending", "approve", "reject", "rollback"]);

/** 読むだけの呼び方（curate の一覧、pending の一覧と表示）は子エージェントからも通す。 */
export function isLearningWriteInvocation(args) {
  if (!LEARNING_WRITE_ACTIONS.has(args.action)) return false;
  if (args.action === "curate") return args.archive === true;
  if (args.action === "pending") return typeof args.proposed === "string";
  return true;
}

function parseArgs(argv) {
  const out = { action: argv[0] };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-([a-z])/gu, (_m, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`ハーネス自己改善ループ

  capture   ユーザーの指摘を提案として記録する（何も書き換えない）
    --kind <correction|preference|constraint|fact>
    --target <${Object.keys(LEARNING_TARGETS).join("|")}>
    --text "指摘の内容を、次に読む人が判断できる粒度で"
    --evidence "根拠（ファイル:行、実測値、ユーザーの発言など）"
    --session "セッションIDなど（必須。同一セッションの重複をまとめる）"
    --channel <id>  台帳のチャンネルの保存先へ書く（channel-pack 宛だけ。下の「チャンネル単位の保存先」）
            書く前に検査する: 検査語彙（HMAC digest）に当たる語は拒否。プロンプト注入らしい
            言い回し・隠し HTML コメント・不可視 Unicode・資格情報らしい文字列・端末の絶対パスは
            捨てずに blocked として残す（資格情報とパスは置き換えて記録。overlay には載らない）

  status    未反映の提案を、繰り返された回数順に出す。旧名（skill: など）で記録した提案も
            新しい宛先で数える。blocked は理由つきで別に出す（本文は出さない）

  sync      **自動反映**。各スキルの references/learned-auto.md（機械が
            丸ごと所有するファイル）を書き直す。人が書く SKILL.md には
            触らないので reviewer は要らない。review-only の宛先
            （台帳・ゲート基準）は自動反映せず保留として報告する。
            blocked の提案は載せない。人が退避した項目は references/learned-archive.md へ移す。
            docs/learning/sensitive-vocabulary.digest.json か、その鍵
            （BUZZASSIST_SENSITIVE_VOCABULARY_KEY / ~/.buzzassist/sensitive-vocabulary.key）が無ければ止まる
            （語彙無しでは私的語の残存を検出できない）
    --allow-missing-vocabulary  開発用途のみ。語彙無しで生成し、overlay ヘッダに
                                「語彙照合なし」を刻む
            同じ sync は Job の決着時（Receipt からの自動捕捉のあと）と setup のたびにも自動で走る。
            語彙を照合できない端末では今どおり書かず、理由だけを学習の置き場の auto-sync.jsonl に残す
            （Job も setup も止めない）。${AUTO_SYNC_ENV}=0 で自動 sync を止める

  curate    長く再発していない overlay 項目を、退避の**候補として列挙するだけ**（既定 dry-run）。
            見るのは「最後に再発・再捕捉された日」と「関連するゲートが直近の RunReceipt に
            不合格・skip で出たか」。overlay は毎回まるごと読まれるので「使われた回数」は使わない
    --stale-days <N>         最後の再発からの日数の下限（既定 ${CURATE_DEFAULT_STALE_DAYS}）
    --gate-window-days <N>   直近とみなす Receipt の期間（既定 ${CURATE_DEFAULT_GATE_WINDOW_DAYS}）
    --receipts-dir <dir>     RunReceipt の置き場（既定は状態の置き場の receipts/。索引 index.jsonl も読む）
    --archive --id <id>[,<id>] --reviewer <名前> --reason "何を見て判断したか" --human-verified
            候補に出た項目だけを learned-archive.md へ退避する（削除しない。再発すれば戻る）。
            人の確認（human-verified）が無い退避記録は効力を持たない——再発しないのは
            その規則が効いているからかもしれず、機械には見分けられないため

  promote   overlay の項目を人の規則へ格上げする（reviewer 必須）。
            正本にその文言が実在しないと通らない。blocked の提案と、検査に当たる --note は通さない
    --id <提案ID>  --reviewer <名前>  --note "どこにどう書いたか"

  review    統合案を出す（既定は dry-run。スキルには触らない）
    --apply-hint   まとめ方の助言を詳しく出す

  apply     提案を反映済みとして記録する（promote と同じ検査を通す）
    --id <提案ID>  --reviewer <名前>  --note "何をどう書いたか"
            人が skill-creator で正本を直接直したときの記録。機械が提案を正本へ反映するなら、
            下の pending → approve を使う（approve が apply と同じ記録を残すので、apply は要らない）。
            apply --agent-attested は記録に残るが反映済みには数えない（変更前の版と巻き戻しが残らない）

  pending   正本（SKILL.md・台帳）の書き換え案を、差分と「読んだ時点の正本の sha256（base）」つきで
            キューに置く。正本には触らない。案には提案ごとの印（buzzassist-learning:<提案ID>）と
            --note と完全一致の規則本文が要る（apply と同じ反映証跡）。追加する本文は書き込み前の検査を通す
    --id <提案ID>[,<提案ID>]  --proposed <書き換え後の正本の全文のファイル>  --note "規則本文"
    [--base <案を作るときに読んだ正本の sha256>]  [--target <宛先>]
            --base を渡せば今の正本と照合し、違えば base-changed で止める
  pending   （--proposed なし）キューの一覧。base が今の正本と違うものは「base-changed」と出す
    --all                     却下・承認・巻き戻し済みも出す
    --show <変更ID>           差分を出す。--out <file> で書き換え後の全文を別のファイルへ書く
                              （その写しで skill-evals を流すため。正本そのものへは書かない）

  approve   キューの変更を正本へ当てる。エージェントも当てられる（--reviewer を省けば「エージェントが
            当てた」actor: agent）。人が自分の端末から --reviewer <名前> --human-verified で打てば「人が当てた」
            actor: human として分けて残す。名前だけ（--human-verified なし）は受け付けない。正本の今の
            sha256 が base と一致するときだけ書き、違えば base-changed で拒否する（読んでから書く）。
            当てたら applied 台帳へ「適用した変更」（対象・変更前後の sha256・当てた者・時刻・元の提案 ID・
            差分）を1行残す。正本スキルを人が確かめるのは、運営者へ配る版を出すリリースのときの1回
            （npm run skills:check:release と承認者の端末の skill-inventory --approve）。
            Channel Pack の台帳（review-only）はリリースを通らないので、今までどおり人だけが当てて戻す
    --change <変更ID>  [--reviewer <名前> --human-verified]
    [--require-evals]  [--evals-dir <dir>]
            正本スキル（.agents/skills/<id>/SKILL.md）なら、skill-evals の記録で「変更後の版の
            contentSha256 に両ホストの結果があり、変更前の版より悪化していない」かを見る。既定は警告、
            --require-evals のときだけ止める。eval は流さない（モデルを呼ばない）

  reject    キューの変更を却下する（記録は消さない。正本は書き換えない）。誰が外したかを approve と同じく残す
    --change <変更ID>  --reason "何を見て外したか"  [--reviewer <名前> --human-verified]

  rollback  approve した変更を巻き戻す。正本の今の sha256 が「変更後」と一致するときだけ変更前へ戻し、
            違えば rollback-conflict で拒否する。戻したことも applied 台帳へ残す。エージェントも人も戻せ、
            どちらが戻したかを approve と同じく分けて残す
    --change <変更ID>  --reason "何を見て戻すか"  [--reviewer <名前> --human-verified]

  自動で入ってくる提案（どちらも提案台帳への追記だけで、正本と overlay には触らない）:
    - Receipt からの自動捕捉: Video Harness の Job が completed / failed / awaiting-human-review で
      決着すると、RunReceipt の不合格ゲート・knownRemainingIssues のコード・再試行と再開の回数を、
      Channel Pack 宛の台帳へ createdBy=auto-receipt として積む（本文はゲート id とコードだけ。
      同じ Receipt からは二重に積まない。全部通った Run からは何も積まない）。
      BUZZASSIST_LEARNING_AUTO_CAPTURE=0 で止まる
    - Canvas feedback: Canvas 上の採択・却下・コメント（collect_video_harness_feedback）
    - 台本の品質ループ: scripts/script-quality-loop.mjs record で合格しなかった回の、下限割れの
      評価項目 id・落ちた機械ゲート id・止まった理由のコードを、台本の非公開台帳
      （channel-pack:narrated-story-script）へ createdBy=auto-script-quality として積む（本文なし・
      同じ回からは二重に積まない）。BUZZASSIST_LEARNING_AUTO_CAPTURE=0 で止まる
  台本の直し・訂正を人から受けたら、--target channel-pack:narrated-story-script で capture する。
  ユーザーの訂正らしい発言は、プラグインの UserPromptSubmit フック（scripts/harness-learn-hook.mjs）が
  見つけてエージェントに capture を促す。フックは何も書き換えず、発言本文も保存しない。
  同じフックが会話ごとにユーザーの発言の回数だけを数え（学習の置き場の reflection/）、既定で 10 回ごとに
  「この会話で残すものがあれば capture する」と短く促す。同じ --session で capture すると0に戻る。
  間隔は ${REFLECTION_INTERVAL_ENV}（0 で数えるのも促すのも止まる）。子エージェントでは数えない。

  子エージェント（harness-parallel-agents が起動）には BUZZASSIST_LEARNING_WRITE_FORBIDDEN が
  渡り、capture / sync / promote / apply / curate --archive は拒否される。捕捉したい内容は
  結果本文で親へ返し、親が確かめてから capture する。

  学習の置き場（台帳・applied・退避・Receipt の索引・sync の状態・この端末の overlay）:
    開発用チェックアウト（.git と .claude/skills と .agents/skills がある）ではリポジトリの docs/learning。
    配布された写し（Claude Code と Codex の版別キャッシュ、~/plugins/buzzassist/plugin）では、
    どの写しから動かしても ~/.buzzassist/learning/（${LEARNING_DIR_ENV} で上書き可）。初回だけ古い写しに
    残った台帳を ID で重複を除いて取り込む（元のファイルは消さない）。配布された写しの sync は、
    この端末の項目だけの区画を overlays/<skill>/learned-auto.md に書き、ホストが読む全部の写しの
    references/learned-auto.md の末尾へ届ける（同梱の項目には触らない。setup のたびにも届け直す）。

  channel-pack 宛の正本は Channel Pack（BUZZASSIST_CHANNEL_PACK →
  channel-packs/<id>/）を先に読み、pack 側に無いときだけリポジトリ直下を読む。
  どれを読んだかは status / review / promote / apply の出力に出る。

  チャンネル単位の保存先（--channel <id>。capture / status / review / promote / apply / pending / approve /
  reject / rollback で使える。sync と curate では使わない）:
    台帳（config/harness-deployments.json の channels）のチャンネルで作った Job の学習は、ハーネス単位の
    Channel Pack の台帳ではなく、そのチャンネルの保存先に積む（Job の確定時の自動の捕捉と Canvas feedback も同じ）。
    品質ループ（台本・途中の成果物・企画ブリーフ）の自動の捕捉も、制作の Job・作業フォルダ（Job の台本の作業フォルダ・
    projectDir・strategy.workDir）・ブリーフの channel.id から台帳のチャンネルが分かれば、そのチャンネルの保存先に積む。
    保存先は channelLearning の { "target": "channel-pack:<id>", "channel": "<チャンネルの id>", "root": "<dir>" }、
    宣言が無ければ学習の置き場（${LEARNING_DIR_ENV} か ~/.buzzassist/learning）の channels/<チャンネルの id>。
    提案と反映記録は <root>/docs/learning/、宛先の正本（要求台帳）は <root>/<正本の相対 path>。
    --channel を付けると、共有台帳とそのチャンネルの保存先だけを読み書きし、別のチャンネル・チャンネルの無い
    保存先の提案・反映記録・承認待ちの変更は出さない。--channel なしの status は末尾にチャンネルごとの件数だけを出す。
    共有層（genre: / platform:）宛に --channel は付けられない（チャンネル固有の事実を共有層へ上げない。
    一般化するなら、チャンネルを外して一般的な言い方で別の提案として capture する）。
    チャンネルの無い Job（従来）の学習は、今までどおりハーネス単位の Channel Pack の台帳へ積む。

  なぜこの形か: 捕捉は書き換えない、review と curate は既定 dry-run、promote と退避には人の確認が要る。
  正本はエージェントも pending → approve で直せるが、変更前後の sha256・元の提案・時刻・当てた者を残し、
  1件ずつ rollback できる。正本スキルを人が確かめるのは、運営者へ配る版（Release）を出すときの1回
  （skills:check:release の関門と、承認者の端末の skill-inventory --approve）。人が見ないまま他人の端末へ
  届き、有料 API を動かす指示になるのを防ぐのはそこ。提案ゼロは正常で、毎回何かを書かせる圧はかけない。
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date().toISOString();

  if (!args.action || args.action === "--help" || args.action === "-h") {
    printHelp();
    // process.exit を呼ばない。パイプへの stdout は非同期で、長い help が途中で切れる。
    process.exitCode = args.action ? 0 : 2;
    return;
  }

  // 書き込み系は、子エージェントの印があれば台帳を読む前に止める。
  if (isLearningWriteInvocation(args)) {
    assertLearningWriteAllowed(process.env, args.action);
  }

  // 配布された写しでは、ホストや版に依らず同じ状態の置き場を読む。初回だけ古い写しの台帳を取り込む。
  const state = learningState();
  process.stdout.write(describeMigration(ensureLearningStateReady({ state })));

  // --channel <id>: 台帳のチャンネルの保存先だけを読み書きする（共有台帳は共通なので読む）。
  // チャンネルの無い保存先や別のチャンネルの保存先の提案・反映記録・承認待ちの変更は出さない。
  if (args.channel === true) throw new Error("--channel にはチャンネルの id を渡してください（config/harness-deployments.json の channels）");
  const scope = typeof args.channel === "string" ? resolveChannelLearningScope(args.channel) : null;
  if (scope && ["sync", "curate"].includes(args.action)) {
    throw new Error(
      `--channel は ${args.action} では使いません。overlay は共有層（genre: / platform:）だけを書き、`
        + "チャンネルの台帳（channel-pack:）は review-only で overlay に載りません。",
    );
  }

  // 差分の承認キュー（lib/harnessLearningChanges.mjs）。正本の書き換えはここだけが行う。
  if (["pending", "approve", "reject", "rollback"].includes(args.action)) {
    await runLearningChangeCli(args, now, scope);
    return;
  }

  const proposals = readLearningLedgerRows("proposals", { channel: scope });
  const applied = readLearningLedgerRows("applied", { channel: scope });
  const archived = readLearningLedgerRows("archived", { channel: scope });
  // 正本を実際に読んで反映を確かめる。記録を信じない。
  // channel-pack 宛は promote / apply と同じく pack を先に読む（ops-7）。チャンネルの範囲ならその保存先を読む。
  const { readCanonical, hashCanonical } = createCanonicalReaders({ channel: scope });
  const summary = summarizeProposals(proposals, applied, readCanonical, hashCanonical);
  // channel-pack 宛の正本をどこから読んだかを出す。共有層宛の出力は変えない。
  // 記録に残った古い target（定義から消えたもの）で表示が落ちないようにする。
  const resolutionLinesFor = (id, indent = "  ") => {
    if (!isChannelPackTarget(resolveTarget(id))) return [];
    try {
      return describeCanonicalResolution(resolveCanonicalTarget(id, { channel: scope }), { indent });
    } catch {
      return [`${indent}正本: 未知の target（${resolveTarget(id)}）`];
    }
  };
  const canonicalResolutionLines = (targetIds) => [...new Set(targetIds.map((id) => resolveTarget(id)))]
    .filter((id) => isChannelPackTarget(id))
    .sort()
    .flatMap((id) => [`  ${id}`, ...resolutionLinesFor(id, "    ")]);

  switch (args.action) {
    case "capture": {
      const { entry } = captureLearningProposal({
        kind: args.kind,
        target: args.target,
        text: args.text,
        evidence: args.evidence,
        session: args.session,
        now,
      }, scope ? { channelScope: scope } : {});
      const repeats = proposals.filter((p) => (p.id ?? proposalId(p)) === entry.id).length;
      process.stdout.write(`記録しました: ${entry.id}${scope ? `（チャンネル ${scope.channelId} の保存先）` : ""}\n`);
      // 回数で起動する振り返り（UserPromptSubmit フック）の数を、この会話（--session）で0に戻す。
      if (resetReflectionCounter(args.session, { now: () => now })) {
        process.stdout.write("  この会話の振り返りの数を0に戻しました\n");
      }
      if (repeats > 0) {
        process.stdout.write(
          `  ⚠️ 同じ指摘は これで ${repeats + 1} 回目です。まだ正本へ反映できていません\n`,
        );
      }
      process.stdout.write(`  反映先候補: ${LEARNING_TARGETS[entry.target]}\n`);
      for (const line of resolutionLinesFor(entry.target)) process.stdout.write(`${line}\n`);
      break;
    }

    case "status": {
      // 書き込み前の検査に当たったものは、未反映一覧と分けて理由つきで出す。
      const blockedById = new Map(summary
        .filter((entry) => !entry.applied)
        .map((entry) => [entry.id, learningBlockReasons(entry)])
        .filter(([, reasons]) => reasons.length > 0));
      const blockedEntries = summary.filter((entry) => blockedById.has(entry.id));
      const writeBlocked = () => {
        if (blockedEntries.length === 0) return;
        process.stdout.write(
          `\n⛔ blocked ${blockedEntries.length} 件（書き込み前の検査に当たった。overlay に載らず、昇格もできない）\n`,
        );
        for (const entry of blockedEntries) {
          process.stdout.write(`  [${entry.id}] ${entry.kind} → ${entry.target}\n`);
          process.stdout.write(`      理由: ${describeLearningBlockReasons(blockedById.get(entry.id))}\n`);
        }
        process.stdout.write("  何を直すかの形に書き直して capture し直すこと（台帳の行は消さない）。\n");
      };
      const pending = summary.filter((entry) => !entry.applied && !blockedById.has(entry.id));
      // 反映済みの判定に使った正本の読み先（channel-pack 宛だけ）。
      const resolution = canonicalResolutionLines(summary.map((entry) => entry.target));
      const writeResolution = () => {
        if (resolution.length === 0) return;
        process.stdout.write(`\n正本の読み先（channel-pack 宛は Channel Pack を先に見る）\n${resolution.join("\n")}\n`);
      };
      // チャンネルの範囲で見ているなら、それを冒頭に出す。見ていないなら、チャンネルごとの保存先の件数だけを末尾に出す
      // （中身は混ぜない。見るときは --channel <id>）。
      if (scope) process.stdout.write(`チャンネル ${scope.channelId} の保存先と共有台帳だけを読んでいます\n\n`);
      const writeChannelStores = () => {
        if (scope) return;
        const lines = channelStoreStatusLines();
        if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
      };
      if (pending.length === 0) {
        process.stdout.write("未反映の提案はありません\n");
        writeBlocked();
        writeResolution();
        writeChannelStores();
        break;
      }
      process.stdout.write(`未反映 ${pending.length} 件（繰り返し回数順）\n\n`);
      for (const entry of pending) {
        const repeat = entry.occurrences > 1 ? ` ×${entry.occurrences}` : "";
        const legacy = entry.recordedTarget ? `（旧名 ${entry.recordedTarget} で記録）` : "";
        process.stdout.write(`  [${entry.id}]${repeat} ${entry.kind} → ${entry.target}${legacy}\n`);
        process.stdout.write(`      ${entry.text}\n`);
        for (const ev of entry.evidence) process.stdout.write(`      根拠: ${ev}\n`);
      }
      writeBlocked();
      writeResolution();
      writeChannelStores();
      break;
    }

    case "review": {
      // blocked は統合案に入れない（本文を出すと、注入らしい文をそのまま読ませることになる）。
      const reviewable = summary.filter((entry) => entry.applied || learningBlockReasons(entry).length === 0);
      const blockedCount = summary.length - reviewable.length;
      if (blockedCount > 0) process.stdout.write(`⛔ blocked ${blockedCount} 件は統合案から外しました（理由は status）\n`);
      const clusters = clusterForConsolidation(reviewable);
      if (clusters.length === 0) {
        process.stdout.write("統合するものはありません\n");
        break;
      }
      process.stdout.write("統合案（dry-run。ここでは何も書き換えていません）\n\n");
      for (const cluster of clusters) {
        process.stdout.write(`▼ ${cluster.target} → ${LEARNING_TARGETS[cluster.target]}\n`);
        // 書き足す先を取り違えないよう、実際に読む（promote / apply が照合する）ファイルを出す。
        for (const line of resolutionLinesFor(cluster.target)) process.stdout.write(`${line}\n`);
        process.stdout.write(`  ${cluster.recommendation}\n`);
        for (const entry of cluster.entries) {
          const repeat = entry.occurrences > 1 ? ` ×${entry.occurrences}` : "";
          process.stdout.write(`  - [${entry.id}]${repeat} ${entry.text}\n`);
        }
        process.stdout.write("\n");
      }
      process.stdout.write(
        "反映するときは、ここに出た提案を **1件ずつ追記するのではなく**、\n"
        + "その target の既存の節へ吸収するか、クラスレベルの1節にまとめて書く。\n"
        + "個別事象を並べた文書は読まれなくなり、学習として機能しない。\n"
        + `書いたあと apply --id <id> --reviewer <名前> --note "どう書いたか"${scope ? ` --channel ${scope.channelId}` : ""} を実行する。\n`,
      );
      break;
    }

    case "sync": {
      // 自動反映。機械が丸ごと所有する overlay ファイルだけを書き直す。
      // 人が書く正本（canonical）には一切触らない。
      // review-only の宛先は、そこが承認と監査の記録そのものなので
      // 自動反映しない——機械がゲート基準を緩められる余地を作らない。
      // redaction の材料は1回だけ集める（Channel Pack の走査と digest 語彙の読み込み）。
      // digest 語彙が無ければここで止まる（fail-closed）。--allow-missing-vocabulary
      // でだけ通し、その overlay にはヘッダで印が付く。
      const redaction = overlayRedactionContextForCli(args);
      // 本体は自動 sync（Job の決着時・setup）と同じ runOverlaySync。
      const ledgers = { proposals, applied, archived };
      const { plan, synced } = runOverlaySync({ state, redaction, now, readLedger: (kind) => ledgers[kind] ?? [] });
      reportOverlaySync(plan, synced.written, { mode: synced.mode, delivery: synced.delivery, stateDir: state.stateDir });
      break;
    }

    case "curate": {
      // 長く再発していない overlay 項目を、退避の候補として列挙する（既定は dry-run）。
      // 「使われた回数」は overlay では意味を持たない（毎回まるごと読まれる）ので、
      // 最後の再発日と、関係するゲートが直近の Receipt に出たかで見る。
      // 再発しないのは「その規則が効いているから」かもしれず、機械には見分けられない。
      // だから機械は候補を出すだけで、退避は reviewer 名つきの人の判断に限る。
      const targets = loadTargets();
      const numberArg = (value, fallback) => (value === undefined || value === true ? fallback : Number(value));
      const report = curateOverlayCandidates({
        summary,
        targets,
        receipts: loadReceipts(typeof args.receiptsDir === "string" ? path.resolve(args.receiptsDir) : undefined),
        autoRows: proposals,
        archivedRecords: archived,
        knownGateIds: knownGateVocabulary(loadHarnessDeclarations()),
        now,
        staleDays: numberArg(args.staleDays, CURATE_DEFAULT_STALE_DAYS),
        gateWindowDays: numberArg(args.gateWindowDays, CURATE_DEFAULT_GATE_WINDOW_DAYS),
        isBlocked: (entry) => learningBlockReasons(entry).length > 0,
      });
      if (args.archive !== true) {
        printCurateReport(report);
        break;
      }
      const records = archiveRecordsFor(report, {
        ids: String(args.id || "").split(",").map((value) => value.trim()).filter(Boolean),
        reason: args.reason,
        attestation: attestationFor({
          reviewer: args.reviewer,
          isInteractive: Boolean(process.stdin.isTTY),
          agentAttested: args["agent-attested"] === true || args.agentAttested === true,
          humanVerified: args["human-verified"] === true || args.humanVerified === true,
        }),
        now,
      });
      for (const record of records) appendJsonl(ledgerPathFor(record.target, "archived"), record);
      if (records[0].attestedBy !== HUMAN_VERIFIED) {
        process.stdout.write(
          `${records.length} 件の退避を機械の自己申告として記録しました（attestedBy: ${records[0].attestedBy}）。`
          + "人の確認が無い退避は効力を持たないので、overlay は変えていません。\n",
        );
        break;
      }
      const plan = planOverlaySync(summary, targets, { archivedRecords: [...archived, ...records] });
      const synced = syncOverlaysForState(plan, { now, redaction: overlayRedactionContextForCli(args), state });
      process.stdout.write(`${records.length} 件を learned-archive.md へ退避しました（削除はしていません。再発すれば overlay へ戻ります）。\n`);
      reportOverlaySync(plan, synced.written, { mode: synced.mode, delivery: synced.delivery, stateDir: state.stateDir });
      break;
    }

    case "promote": {
      // 機械区画の項目を、人が書いた規則へ格上げする。ここは reviewer 必須。
      // 「機械が書いた」と「人が確認した」の差がこの一手で、
      // この差が無くなると自己改善が自己認証に変わる。
      if (!args.id) throw new Error("--id が必要です");
      const attested = attestationFor({
        reviewer: args.reviewer,
        isInteractive: Boolean(process.stdin.isTTY),
        agentAttested: args["agent-attested"] === true || args.agentAttested === true,
        humanVerified: args["human-verified"] === true || args.humanVerified === true,
      });
      if (!attested.ok) throw new Error(attested.message);
      if (typeof args.reviewer !== "string" || args.reviewer.trim() === "") {
        throw new Error(
          "--reviewer <名前> が必要です。機械区画から人の規則へ上げるのは人の判断です",
        );
      }
      const entry = summary.find((item) => item.id === args.id);
      if (!entry) throw new Error(`提案が見つかりません: ${args.id}`);
      if (entry.applied) throw new Error(`${args.id} は既に昇格済みです`);
      assertPromotableProposal(entry, args.note);
      const resolvedTarget = requireWritableTarget(entry.target, { channel: scope });
      const { rel, full } = resolvedTarget;
      // overlay に載っているのは sync の当然の結果なので、それを拒否の
      // 条件にすると promote が永久に通らなくなる（実際そうなっていた）。
      // 見るべきは overlay ではなく **正本に書かれたか**。
      // 印を探したバイト列と sha256 を取るバイト列を同じにする。
      const canonicalBytes = fs.readFileSync(full);
      const canonicalText = canonicalBytes.toString("utf8");
      const note = typeof args.note === "string" ? args.note.trim() : "";
      if (!canonicalHasPromotionEvidence({ id: entry.id, note }, canonicalText)) {
        throw new Error(
          `${rel} に該当の記述が見つかりません。\n`
          + checkedCanonicalNote(resolvedTarget)
          + "promote は「正本へ書いたことの記録」です。先に正本へ、\n"
          + `  ${promotionMarker(entry.id)}\n`
          + `という一意マーカーと、${PROMOTION_NOTE_MIN_CHARS}文字以上の規則本文を書き、`
          + "--note にその本文を完全一致で渡してください。",
        );
      }
      appendJsonl(ledgerPathFor(entry.target, "applied", { channel: scope }), {
        id: entry.id,
        target: entry.target,
        ...(scope && isChannelPackTarget(resolveTarget(entry.target)) ? { channel: scope.channelId } : {}),
        targetPath: rel,
        targetSha256: createHash("sha256").update(canonicalBytes).digest("hex"),
        targetSource: recordedCanonicalSource(resolvedTarget),
        text: entry.text,
        reviewer: attested.attestation.reviewer,
        attestedBy: attested.attestation.attestedBy,
        claimedReviewer: attested.attestation.claimedReviewer ?? undefined,
        note: typeof args.note === "string" ? args.note.trim() : "",
        evidenceVersion: 2,
        promotionMarker: promotionMarker(entry.id),
        promotedAt: now,
      });
      for (const line of describeCanonicalResolution(resolvedTarget)) process.stdout.write(`${line}\n`);
      if (attested.attestation.attestedBy === HUMAN_VERIFIED) {
        process.stdout.write(`${entry.id} に人の確認記録を追加しました（reviewer: ${attested.attestation.reviewer}）\n`);
      } else {
        process.stdout.write(
          `${entry.id} を機械の自己申告として記録しました。人の確認済みにはなりません`
          + `（attestedBy: ${attested.attestation.attestedBy}）\n`,
        );
      }
      break;
    }

    case "apply": {
      if (!args.id) throw new Error("--id が必要です（status か review で確認）");
      const attested = attestationFor({
        reviewer: args.reviewer,
        isInteractive: Boolean(process.stdin.isTTY),
        agentAttested: args["agent-attested"] === true || args.agentAttested === true,
        humanVerified: args["human-verified"] === true || args.humanVerified === true,
      });
      if (!attested.ok) throw new Error(attested.message);
      if (typeof args.reviewer !== "string" || args.reviewer.trim() === "") {
        throw new Error(
          "--reviewer <名前> が必要です。誰が反映を確認したか記録しない自動反映は証跡になりません",
        );
      }
      const entry = summary.find((item) => item.id === args.id);
      if (!entry) throw new Error(`提案が見つかりません: ${args.id}`);
      if (entry.applied) throw new Error(`${args.id} は既に反映済みです`);
      assertPromotableProposal(entry, args.note);
      const resolvedTarget = requireWritableTarget(entry.target, { channel: scope });
      const { rel, full } = resolvedTarget;
      // apply も promote と同じ検証を通す。緩い経路を1つでも残すと、
      // そちらから素通りできてしまう。
      const applyNote = typeof args.note === "string" ? args.note.trim() : "";
      const applyBytes = fs.readFileSync(full);
      const applyText = applyBytes.toString("utf8");
      if (!canonicalHasPromotionEvidence({ id: entry.id, note: applyNote }, applyText)) {
        throw new Error(
          `${rel} に該当の記述が見つかりません。\n`
          + checkedCanonicalNote(resolvedTarget)
          + "apply は「正本へ書いたことの記録」です。先に正本へ、\n"
          + `  ${promotionMarker(entry.id)}\n`
          + `という一意マーカーと、${PROMOTION_NOTE_MIN_CHARS}文字以上の規則本文を書き、`
          + "--note にその本文を完全一致で渡してください。",
        );
      }
      appendJsonl(ledgerPathFor(entry.target, "applied", { channel: scope }), {
        id: entry.id,
        target: entry.target,
        ...(scope && isChannelPackTarget(resolveTarget(entry.target)) ? { channel: scope.channelId } : {}),
        targetPath: rel,
        targetSha256: createHash("sha256").update(applyBytes).digest("hex"),
        targetSource: recordedCanonicalSource(resolvedTarget),
        text: entry.text,
        reviewer: attested.attestation.reviewer,
        attestedBy: attested.attestation.attestedBy,
        claimedReviewer: attested.attestation.claimedReviewer ?? undefined,
        note: applyNote,
        evidenceVersion: 2,
        promotionMarker: promotionMarker(entry.id),
        appliedAt: now,
      });
      for (const line of describeCanonicalResolution(resolvedTarget)) process.stdout.write(`${line}\n`);
      if (attested.attestation.attestedBy === HUMAN_VERIFIED) {
        process.stdout.write(`${entry.id} に人の確認記録を追加しました（reviewer: ${attested.attestation.reviewer}）\n`);
      } else {
        process.stdout.write(
          `${entry.id} を機械の自己申告として記録しました。人の確認済みにはなりません`
          + `（attestedBy: ${attested.attestation.attestedBy}）。`
          + "機械が提案を正本へ反映するなら pending → approve を使うと、変更前後の sha256 と巻き戻しが残り、反映済みに数えます\n",
        );
      }
      break;
    }

    default:
      throw new Error(`不明なアクション: ${args.action}`);
  }
}

function attestationArgs(args) {
  return {
    reviewer: args.reviewer,
    isInteractive: Boolean(process.stdin.isTTY),
    agentAttested: args["agent-attested"] === true || args.agentAttested === true,
    humanVerified: args["human-verified"] === true || args.humanVerified === true,
  };
}

function shortSha(value) {
  return String(value || "").slice(0, 12);
}

/** 誰がした操作か（approve / reject / rollback の出力）。 */
function actorLabel(record) {
  return record.actor === CHANGE_ACTOR_AGENT
    ? `エージェントが実行${record.claimedReviewer ? `（名乗った名前: ${record.claimedReviewer}。人の確認ではない）` : ""}`
    : `人が実行: ${record.reviewer}（${record.attestedBy}）`;
}

/** pending / approve / reject / rollback。本体は lib/harnessLearningChanges.mjs。 */
async function runLearningChangeCli(args, now, scope = null) {
  const changes = await import("../lib/harnessLearningChanges.mjs");
  // --channel があれば、そのチャンネルの保存先のキュー・提案・正本だけを扱う。
  const common = { repoRoot: REPO_ROOT, now: () => now, ...(scope ? { channel: scope } : {}) };
  const channelFlag = scope ? ` --channel ${scope.channelId}` : "";
  switch (args.action) {
    case "pending": {
      if (typeof args.proposed === "string") {
        const proposedPath = path.resolve(args.proposed);
        const { change } = changes.enqueueLearningChange({
          ...common,
          proposalIds: String(args.id || "").split(",").map((value) => value.trim()).filter(Boolean),
          proposedText: fs.readFileSync(proposedPath, "utf8"),
          baseSha256: typeof args.base === "string" ? args.base : "",
          note: typeof args.note === "string" ? args.note : "",
          target: typeof args.target === "string" ? args.target : "",
        });
        process.stdout.write(
          `キューに置きました: ${change.changeId}（${change.target} / ${change.targetPath}）\n`
          + `  base ${shortSha(change.baseSha256)} → 変更後 ${shortSha(change.afterSha256)}`
          + `（${change.stats.hunks} hunk、+${change.stats.added} -${change.stats.removed}）/ 提案 ${change.proposalIds.join(", ")}\n`
          + "  正本はまだ書き換えていません。差分を読んでから当てます:\n"
          + `    node scripts/harness-learn.mjs pending --show ${change.changeId}${channelFlag}\n`
          + `    node scripts/harness-learn.mjs approve --change ${change.changeId}${channelFlag}`
          + "（エージェントが当てる。人が当てるなら自分の端末から --reviewer <名前> --human-verified を足す）\n",
        );
        return;
      }
      if (typeof args.show === "string") {
        const shown = changes.showLearningChange({ ...common, changeId: args.show, out: typeof args.out === "string" ? args.out : "" });
        const record = shown.change.record;
        process.stdout.write(`${shown.change.changeId}（${shown.change.status}）${record.target} / 提案 ${(record.proposalIds || []).join(", ")}\n`);
        process.stdout.write(shown.diff);
        if (shown.written) process.stdout.write(`書き換え後の全文を書きました: ${shown.written}\n`);
        return;
      }
      const list = changes.listLearningChanges({ ...common, includeClosed: args.all === true });
      if (list.length === 0) {
        process.stdout.write(args.all === true ? "変更の記録はありません\n" : "承認待ちの変更はありません\n");
        return;
      }
      process.stdout.write(`${args.all === true ? "変更の記録" : "承認待ちの変更"} ${list.length} 件\n\n`);
      for (const entry of list) {
        const stale = entry.stale ? `  ⚠ base-changed（今の正本 ${shortSha(entry.currentSha256)}。pending を作り直す）` : "";
        process.stdout.write(`  [${entry.changeId}] ${entry.status} → ${entry.target} ${entry.targetPath}${stale}\n`);
        process.stdout.write(`      提案 ${entry.proposalIds.join(", ")} / base ${shortSha(entry.baseSha256)} → ${shortSha(entry.afterSha256)}`
          + `${entry.stats ? `（+${entry.stats.added} -${entry.stats.removed}）` : ""}\n`);
      }
      process.stdout.write(`\n差分: node scripts/harness-learn.mjs pending --show <変更ID>${channelFlag}\n`);
      return;
    }
    case "approve": {
      const result = changes.approveLearningChange({
        ...common,
        ...attestationArgs(args),
        changeId: args.change,
        requireEvals: args.requireEvals === true,
        evalsDir: typeof args.evalsDir === "string" ? args.evalsDir : "",
      });
      process.stdout.write(changes.formatEvalGate(result.gate, { required: args.requireEvals === true }));
      process.stdout.write(
        `${result.record.changeId} を ${result.targetRel} へ当てました（${shortSha(result.record.beforeSha256)} → ${shortSha(result.record.afterSha256)}、`
        + `${actorLabel(result.record)}）。提案 ${result.record.proposalIds.join(", ")} は反映済みとして数えます。\n`
        + `  巻き戻すとき: node scripts/harness-learn.mjs rollback --change ${result.record.changeId}${channelFlag} --reason "..."\n`,
      );
      if (result.canonicalSkill) {
        process.stdout.write(
          "  正本スキルを書き換えました。.agents/skills/inventory.manifest.json の contentSha256 と bundleSha256 を今の内容へ更新してください"
          + "（値は npm run skills:check の食い違いの行に出ます）"
          + "（版の扱いは skill-creator の決まり）。開発用チェックアウトの制作は止まらず、RunReceipt に承認前の正本で作ったと残ります。"
          + "運営者へ配る版（Release）を出す前に、人が承認者の端末で skill-inventory --approve を打ちます（skills:check:release が確かめます）。\n",
        );
      }
      return;
    }
    case "reject": {
      const { record } = changes.rejectLearningChange({ ...common, ...attestationArgs(args), changeId: args.change, reason: args.reason });
      process.stdout.write(`${record.changeId} を却下しました（${actorLabel(record)}。記録は消していません）\n`);
      return;
    }
    case "rollback": {
      const result = changes.rollbackLearningChange({ ...common, ...attestationArgs(args), changeId: args.change, reason: args.reason });
      process.stdout.write(
        `${result.record.changeId} を巻き戻しました（${result.targetRel}: ${shortSha(result.record.fromSha256)} → ${shortSha(result.record.toSha256)}、`
        + `${actorLabel(result.record)}）。提案 ${result.record.proposalIds.join(", ")} は反映待ちへ戻ります。\n`,
      );
      return;
    }
    default:
      throw new Error(`不明なアクション: ${args.action}`);
  }
}

if (isDirectCli(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  });
}
