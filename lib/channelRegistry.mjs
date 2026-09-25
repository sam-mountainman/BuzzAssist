// チャンネルの台帳。運営者の配置表（追跡外の config/harness-deployments.json）の `channels` を読み、検査する。
//
// 1つのチャンネルは次を持つ:
//   { id, projectDir, channelPack,
//     production: { kind: "harness", harnessId } | { kind: "external", note },
//     strategy: { workDir, requireBrief, strategySkillDir? },
//     scriptQuality?: { genre, channelConfig? } }
//
// scriptQuality はチャンネルの台本の品質ループの設定（ジャンルと、ループを始めるときのチャンネル設定）。
// ループの作業フォルダは台本ごと（制作の Job の options.scriptQualityWorkDir。省けば台本のあるフォルダ）なので
// 台帳には持たない。制作がハーネスのチャンネルでは、ジャンルは制作の Job が有料の処理の前に問うジャンル
// （lib/scriptQualityUseGate.mjs）と同じでなければならない（違えば channel-script-quality-genre-mismatch）。
//
// 守ること:
//   - チャンネルどうしで projectDir・channelPack・strategy.workDir が重なる（同じ・入れ子）なら拒否する。
//     重なると、あるチャンネルの Job・Pack・ブリーフが別のチャンネルの作業に混ざる
//   - 公開リポジトリの作業木の直下（ルートそのもの）と、作業木の中の追跡される場所を指す path は拒否する。
//     作業木の中で置いてよいのは追跡しない場所（canvas/・channel-packs/・client-work/）だけ
//   - 学習の宛先（channel-pack:<id>。台帳の種類）はチャンネルの制作のハーネス（と台本のジャンル）から決まる。
//     保存先はチャンネルごとに分ける: channelLearning の { target, channel, root } の宣言か、無ければ学習の置き場の
//     channels/<チャンネルの id>（lib/harnessLearningState.mjs の channelStoreDefaultRoot）。同じハーネスの
//     チャンネルどうしでも、提案・反映記録・正本の台帳が混ざらない（harness-learn の --channel と、Job の確定時の
//     自動の捕捉が同じ保存先を使う）
//   - 保存先どうし・保存先と別のチャンネルの場所が重なる（同じ・入れ子）なら拒否する。チャンネルの無い Job の
//     保存先（宛先単位の { target, root } の宣言か、Channel Pack の既定の置き場）に重なる保存先は、その宛先を
//     使うチャンネルがそれ1つのときだけ許す（従来の台帳をそのチャンネルが引き継ぐとき）
//   - 既定の Pack の探索（lib/channelPackResolver.mjs の resolveDefaultPackId）や環境変数の Pack を使わない。
//     チャンネルの値は台帳の値だけ
//   - 読むだけ。ファイルを作らない・書かない
//
// 例のファイル（config/harness-deployments.example.json）の channels は空。書き方は channelTemplate にあり、
// 読み込みでは使わない（例を写した配置表に合成のチャンネルが入らないように）。

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { channelLedgerDir, channelStoreDefaultRoot, resolveLearningState } from "./harnessLearningState.mjs";
import { HARNESS_LEARNING_ROUTES, SCRIPT_LEARNING_ROUTES, resolveLearningTarget } from "./harnessLearningTargets.mjs";

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CHANNEL_REGISTRY_VERSION = "buzzassist-channel-registry-v1";
export const CHANNEL_REGISTRY_INVALID_CODE = "channel-registry-invalid";
export const CHANNEL_UNKNOWN_CODE = "channel-unknown";
/**
 * 配置表の代わりにチャンネルの台帳を読むファイル（配置表と同じ形の JSON。channels だけを読む）。
 * 試験と、台帳を配置表とは別に置く端末用。使ったことは registry.source に出る。
 */
export const CHANNEL_REGISTRY_PATH_ENV = "BUZZASSIST_CHANNEL_REGISTRY";
/** 公開リポジトリの作業木の中で、チャンネルの場所として置いてよい（追跡しない）場所。 */
export const PRIVATE_REPO_SUBTREES = Object.freeze(["canvas", "channel-packs", "client-work"]);
/** 重なりを見るチャンネルの場所。 */
export const CHANNEL_OVERLAP_FIELDS = Object.freeze(["projectDir", "channelPack", "strategy.workDir"]);

const CHANNEL_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const HARNESS_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const GENRE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const PLACEHOLDER = /<[^>]+>/u;
const TOP_KEYS = new Set(["id", "displayName", "note", "projectDir", "channelPack", "production", "strategy", "scriptQuality"]);
const PRODUCTION_KEYS = new Set(["kind", "harnessId", "note"]);
const STRATEGY_KEYS = new Set(["workDir", "requireBrief", "strategySkillDir"]);
const SCRIPT_QUALITY_KEYS = new Set(["genre", "channelConfig"]);
const MAX_NOTE = 500;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function caseInsensitive(pathApi) {
  return pathApi.sep === "\\" || (pathApi === path && process.platform === "win32");
}

/** 比べるための形。実在するなら実体の path（macOS の /var と /private/var など）、Windows は大文字小文字を無視。 */
function comparable(value, pathApi = path) {
  let resolved = pathApi.resolve(value);
  if (pathApi === path) {
    try { resolved = realpathSync.native(resolved); } catch { /* 無い path はそのまま比べる */ }
  }
  return caseInsensitive(pathApi) ? resolved.toLowerCase() : resolved;
}

/**
 * 2つの path の重なり。"same"（同じ）/ "inside"（left が right の中）/ "contains"（left が right を含む）/ null。
 * pathApi に path.win32 を渡すと Windows の規則（ドライブ名・大文字小文字の無視）で比べる。
 */
export function pathOverlap(left, right, pathApi = path) {
  const a = comparable(left, pathApi);
  const b = comparable(right, pathApi);
  if (a === b) return "same";
  const inside = (child, parent) => {
    const rel = pathApi.relative(parent, child);
    return rel !== "" && !rel.startsWith("..") && !pathApi.isAbsolute(rel);
  };
  if (inside(a, b)) return "inside";
  if (inside(b, a)) return "contains";
  return null;
}

/**
 * 公開リポジトリの作業木に対する場所。"repo-root"（作業木の直下＝ルートそのもの）/ "contains-repo"（作業木を
 * 含む）/ "public-tree"（作業木の中の追跡される場所）/ null（作業木の外か、追跡しない場所）。
 */
export function publicTreePlacement(target, repoRoot, pathApi = path) {
  const overlap = pathOverlap(target, repoRoot, pathApi);
  if (overlap === "same") return "repo-root";
  if (overlap === "contains") return "contains-repo";
  if (overlap !== "inside") return null;
  const rel = pathApi.relative(comparable(repoRoot, pathApi), comparable(target, pathApi));
  const first = rel.split(/[\\/]+/u).filter(Boolean)[0] || "";
  const privateRoots = PRIVATE_REPO_SUBTREES.map((entry) => (caseInsensitive(pathApi) ? entry.toLowerCase() : entry));
  return privateRoots.includes(caseInsensitive(pathApi) ? first.toLowerCase() : first) ? null : "public-tree";
}

function fieldValue(channel, field) {
  return field.split(".").reduce((value, key) => (value && typeof value === "object" ? value[key] : undefined), channel);
}

function registryError(issues, sourcePath) {
  const error = new Error(
    `${CHANNEL_REGISTRY_INVALID_CODE}: チャンネルの台帳（${sourcePath || "channels"}）を使えない。`
    + issues.map((issue) => ` [${issue.code}] ${issue.detail}`).join(""),
  );
  error.code = CHANNEL_REGISTRY_INVALID_CODE;
  error.issues = issues;
  return error;
}

/** 学習の宛先（制作のハーネスと台本のジャンルから決まる）。外部の制作のチャンネルは制作の宛先を持たない。 */
export function channelLearningTargets(channel) {
  const targets = [];
  const harnessId = channel?.production?.kind === "harness" ? channel.production.harnessId : "";
  const production = harnessId ? HARNESS_LEARNING_ROUTES[harnessId]?.channel : "";
  if (production) targets.push({ area: "production", target: production });
  const genre = nonEmpty(channel?.scriptQuality?.genre);
  const script = genre ? SCRIPT_LEARNING_ROUTES[genre] : "";
  // 台本の宛先が制作の宛先と同じ（漫画）なら1つにまとめる。
  if (script && !targets.some((entry) => entry.target === script)) targets.push({ area: "script", target: script });
  return targets;
}

/**
 * channelLearning の行を2種類に分ける。
 *   - 宛先単位（channel が無い従来の行）: チャンネルの無い Job の保存先。形の誤りは書く工程（harness-learn）が
 *     理由つきで止めるので、ここでは読める行だけを使う（従来どおり）
 *   - チャンネル単位（{ target, channel, root }）: そのチャンネルの保存先。新しい書き方なので、形の誤りは読み込みで拒む
 */
function channelLearningRows(parsed, root, pathApi, issues) {
  const targetWide = new Map();
  const perChannel = new Map();
  if (!Array.isArray(parsed?.channelLearning)) return { targetWide, perChannel };
  const resolvePath = (value) => (pathApi.isAbsolute(value) ? pathApi.resolve(value) : pathApi.resolve(root, value));
  parsed.channelLearning.forEach((row, index) => {
    // 旧名（ledger: など）は harness-learn と同じ対応表で新しい宛先へ解決してから見る。
    const target = resolveLearningTarget(nonEmpty(row?.target));
    const value = nonEmpty(row?.root);
    if (row?.channel === undefined) {
      if (!target || !value || PLACEHOLDER.test(value)) return;
      targetWide.set(target, resolvePath(value));
      return;
    }
    const channelId = nonEmpty(row.channel);
    const label = `${channelId || `#${index + 1}`}:${target || "?"}`;
    const issue = (code, detail) => {
      issues.push({ code: `${code}:${label}`, channelId, detail: `channelLearning の ${label}: ${detail}` });
    };
    if (!CHANNEL_ID.test(channelId)) return issue("channel-learning-row-invalid", "channel は台帳のチャンネルの id にする");
    if (!target.startsWith("channel-pack:")) {
      return issue("channel-learning-row-invalid", "target は channel-pack: の宛先にする（共有層の宛先はチャンネルごとに分けない）");
    }
    if (!value) return issue("channel-learning-row-invalid", "root が要る");
    if (PLACEHOLDER.test(value)) return issue("channel-learning-root-placeholder", "root が未完成（<...> のまま）");
    const key = `${channelId}\u001f${target}`;
    if (perChannel.has(key)) return issue("channel-learning-row-duplicate", "同じチャンネルと宛先の宣言が2回ある（どちらが効くか決められない）");
    perChannel.set(key, { channel: channelId, target, root: resolvePath(value) });
    return undefined;
  });
  return { targetWide, perChannel };
}

let targetPackIds = null;

/** 宛先の Channel Pack の id（docs/learning/targets.json の packId。台本の宛先は動画の Pack と同じ置き場を使う）。 */
function packIdOfTarget(target) {
  if (targetPackIds === null) {
    targetPackIds = new Map();
    try {
      const parsed = JSON.parse(readFileSync(path.join(MODULE_ROOT, "docs", "learning", "targets.json"), "utf8"));
      for (const [key, definition] of Object.entries(parsed?.targets || {})) {
        if (definition?.scope === "channel-pack" && nonEmpty(definition.packId)) targetPackIds.set(key, definition.packId);
      }
    } catch {
      // 読めなければ宛先の名前から取る（下）。
    }
  }
  return targetPackIds.get(target) || String(target).slice("channel-pack:".length);
}

/** 学習の置き場（既定の保存先の親と、チャンネルの無い Job の既定の置き場を決める）。決められなければ null。 */
function learningStateFor({ learningState, root, env, pathApi }) {
  if (learningState !== undefined) return learningState;
  try {
    return resolveLearningState({ codeRoot: root, env, pathApi });
  } catch {
    return null;
  }
}

function placementWords(placement) {
  if (placement === "repo-root") return "直下";
  if (placement === "contains-repo") return "全体（作業木を含む場所）";
  return "中の追跡される場所";
}

/**
 * チャンネルの学習の保存先を決めて検査する。問題は issues に積む。返す stores は、チャンネル id → 宛先 → 保存先。
 * 保存先は root（中に docs/learning と宛先の正本を置く）と source（"channel-learning" は宣言、"channel-default" は既定）。
 */
function channelLearningStores({ parsed, channels, root, pathApi, state, issues }) {
  const rows = channelLearningRows(parsed, root, pathApi, issues);
  const named = channels.filter((channel) => channel?.id && CHANNEL_ID.test(channel.id));
  const usersOf = new Map();
  for (const channel of named) {
    for (const { target } of channelLearningTargets(channel)) usersOf.set(target, [...(usersOf.get(target) || []), channel.id]);
  }
  // 宛先を1つのチャンネルだけが使うなら、そのチャンネルはチャンネルの無い Job の保存先を引き継いでよい。
  const soleUser = (target, channelId) => {
    const users = usersOf.get(target) || [];
    return users.length === 1 && users[0] === channelId;
  };

  for (const row of rows.perChannel.values()) {
    const owner = named.find((channel) => channel.id === row.channel);
    const label = `${row.channel}:${row.target}`;
    if (!owner) {
      issues.push({ code: `channel-learning-channel-unknown:${label}`, channelId: row.channel, detail: `channelLearning の ${label}: チャンネル ${row.channel} は channels に無い` });
    } else if (!channelLearningTargets(owner).some((entry) => entry.target === row.target)) {
      issues.push({
        code: `channel-learning-target-unused:${label}`,
        channelId: row.channel,
        detail: `channelLearning の ${label}: チャンネル ${row.channel} の学習の宛先（制作のハーネスと台本のジャンルから決まる）に ${row.target} は無い`,
      });
    }
  }

  const stores = new Map();
  const list = [];
  for (const channel of named) {
    const byTarget = new Map();
    for (const { target } of channelLearningTargets(channel)) {
      const declared = rows.perChannel.get(`${channel.id}\u001f${target}`);
      let store;
      if (declared) {
        store = { source: "channel-learning", root: declared.root };
      } else if (state?.channelStoreRoot) {
        store = { source: "channel-default", root: channelStoreDefaultRoot(state, channel.id, pathApi) };
      } else {
        issues.push({
          code: `channel-learning-store-unresolved:${channel.id}`,
          channelId: channel.id,
          detail: `${channel.id}: 学習の既定の保存先（学習の置き場の channels/）を決められない。channelLearning に { target, channel, root } を書く`,
        });
        continue;
      }
      byTarget.set(target, store);
      list.push({ channel, target, store });
    }
    stores.set(channel.id, byTarget);
  }

  // 保存先の置き場: 公開リポジトリの作業木の直下・作業木を含む場所・追跡される場所は拒む（チャンネルの場所と同じ規則）。
  const seen = new Set();
  const push = (code, channelId, detail) => {
    if (seen.has(code)) return;
    seen.add(code);
    issues.push({ code, channelId, detail });
  };
  for (const { channel, store } of list) {
    const placement = publicTreePlacement(store.root, root, pathApi);
    if (!placement) continue;
    push(
      `channel-learning-store-${placement}:${channel.id}`,
      channel.id,
      `${channel.id} の学習の保存先が公開リポジトリの作業木の${placementWords(placement)}に当たる。`
        + `リポジトリの外か、追跡しない ${PRIVATE_REPO_SUBTREES.map((entry) => `${entry}/`).join("・")} に置く`,
    );
  }

  // 保存先と、別のチャンネルの場所（projectDir・channelPack・strategy.workDir）。
  for (const { channel, target, store } of list) {
    for (const other of named) {
      if (other.id === channel.id) continue;
      for (const field of CHANNEL_OVERLAP_FIELDS) {
        const value = fieldValue(other, field);
        if (!value || !pathOverlap(store.root, value, pathApi)) continue;
        push(
          `channel-learning-store-overlap:${channel.id}:${other.id}.${field}`,
          channel.id,
          `${channel.id} の学習の保存先（${target}）が ${other.id}.${field} に重なる。学習が別のチャンネルの場所に積まれる`,
        );
      }
    }
  }

  // 保存先どうし（別のチャンネル）。同じチャンネルの宛先どうし（動画と台本）は同じ置き場でよい。
  for (let left = 0; left < list.length; left += 1) {
    for (let right = left + 1; right < list.length; right += 1) {
      const a = list[left];
      const b = list[right];
      if (a.channel.id === b.channel.id || !pathOverlap(a.store.root, b.store.root, pathApi)) continue;
      push(
        `channel-learning-store-shared:${a.channel.id}:${b.channel.id}`,
        a.channel.id,
        `${a.channel.id} と ${b.channel.id} の学習の保存先が重なる。チャンネルごとに別の root にする——重なると提案・反映記録・台帳が混ざる`,
      );
    }
  }

  // 保存先と、チャンネルの無い Job の保存先（宛先単位の宣言か、Channel Pack の既定の置き場）。
  const unscopedLedgerDir = (target) => {
    if (rows.targetWide.has(target)) return pathApi.join(rows.targetWide.get(target), "docs", "learning");
    if (!state) return null;
    try {
      return channelLedgerDir(state, packIdOfTarget(target), pathApi);
    } catch {
      return null;
    }
  };
  const unscopedTargets = [...new Set([...usersOf.keys(), ...rows.targetWide.keys()])].filter((target) => target.startsWith("channel-pack:"));
  for (const { channel, store } of list) {
    const ledgerDir = pathApi.join(store.root, "docs", "learning");
    for (const target of unscopedTargets) {
      const unscoped = unscopedLedgerDir(target);
      if (!unscoped || soleUser(target, channel.id) || !pathOverlap(ledgerDir, unscoped, pathApi)) continue;
      push(
        `channel-learning-store-unscoped-overlap:${channel.id}:${target}`,
        channel.id,
        `${channel.id} の学習の保存先が、チャンネルの無い Job の ${target} の保存先に重なる。引き継げるのは、`
          + `その宛先を使うチャンネルが1つのときだけ（今は ${(usersOf.get(target) || []).join(", ") || "使うチャンネルが無い"}）`,
      );
    }
  }

  // チャンネルの無い Job の保存先（宛先単位の宣言）と、チャンネルの場所。
  for (const [target, storeRoot] of rows.targetWide) {
    if (!target.startsWith("channel-pack:")) continue;
    for (const channel of named) {
      if (soleUser(target, channel.id)) continue;
      for (const field of CHANNEL_OVERLAP_FIELDS) {
        const value = fieldValue(channel, field);
        if (!value || !pathOverlap(storeRoot, value, pathApi)) continue;
        push(
          `channel-learning-unscoped-store-overlap:${target}:${channel.id}.${field}`,
          channel.id,
          `チャンネルの無い Job の ${target} の保存先（channelLearning の宛先単位の宣言）が ${channel.id}.${field} に重なる。`
            + "チャンネルの無い Job の学習がそのチャンネルの場所に積まれる",
        );
      }
    }
  }
  return { stores, usersOf };
}

/**
 * 1つのチャンネルの行を検査して、path を絶対にした形へ直す。問題は issues に積む（例外にしない）。
 */
function normalizeChannel(row, index, { root, pathApi, harnessIds, genres, genreForHarness, issues }) {
  const label = nonEmpty(row?.id) || `#${index + 1}`;
  const issue = (code, detail) => issues.push({ code: `${code}:${label}`, channelId: label, detail: `${label}: ${detail}` });
  if (!plainObject(row)) {
    issue("channel-invalid", "チャンネルは JSON object にする");
    return null;
  }
  for (const key of Object.keys(row)) if (!TOP_KEYS.has(key)) issue("channel-unknown-key", `知らない欄 ${key}（書き間違いなら直す）`);
  const id = nonEmpty(row.id);
  if (!CHANNEL_ID.test(id)) issue("channel-id-invalid", "id は英小文字・数字・_・- の64文字まで");

  const pathField = (value, field, { optional = false } = {}) => {
    if (value === undefined && optional) return undefined;
    const text = nonEmpty(value);
    if (!text) {
      issue("channel-path-missing", `${field} が要る`);
      return null;
    }
    if (PLACEHOLDER.test(text)) {
      issue("channel-path-placeholder", `${field} が未完成（<...> のまま）`);
      return null;
    }
    const resolved = pathApi.isAbsolute(text) ? pathApi.resolve(text) : pathApi.resolve(root, text);
    const placement = publicTreePlacement(resolved, root, pathApi);
    if (placement === "repo-root") {
      issue("channel-path-repo-root", `${field} が公開リポジトリの作業木の直下を指す。チャンネルの場所はリポジトリの外に置く`);
    } else if (placement === "contains-repo") {
      issue("channel-path-contains-repo", `${field} が公開リポジトリの作業木を含む。チャンネルの作業と公開物が同じ木に混ざるので、リポジトリの外の別のフォルダにする`);
    } else if (placement === "public-tree") {
      issue(
        "channel-path-in-public-tree",
        `${field} が公開リポジトリの作業木の中の追跡される場所を指す。リポジトリの外か、追跡しない ${PRIVATE_REPO_SUBTREES.map((entry) => `${entry}/`).join("・")} に置く`,
      );
    }
    return resolved;
  };

  const projectDir = pathField(row.projectDir, "projectDir");
  const channelPack = pathField(row.channelPack, "channelPack");

  let production = null;
  if (!plainObject(row.production)) {
    issue("channel-production-invalid", "production は { kind: \"harness\", harnessId } か { kind: \"external\", note }");
  } else {
    for (const key of Object.keys(row.production)) if (!PRODUCTION_KEYS.has(key)) issue("channel-unknown-key", `知らない欄 production.${key}`);
    if (row.production.kind === "harness") {
      const harnessId = nonEmpty(row.production.harnessId);
      if (!HARNESS_ID.test(harnessId)) issue("channel-production-invalid", "production.harnessId が要る");
      else if (Array.isArray(harnessIds) && !harnessIds.includes(harnessId)) issue("channel-harness-unknown", `宣言に無いハーネス ${harnessId}`);
      production = { kind: "harness", harnessId };
    } else if (row.production.kind === "external") {
      const note = nonEmpty(row.production.note);
      if (!note) issue("channel-production-invalid", "production.kind が external なら note に制作の仕組みを一言書く");
      else if (Array.from(note).length > MAX_NOTE) issue("channel-production-invalid", `production.note は ${MAX_NOTE} 文字まで`);
      production = { kind: "external", note };
    } else {
      issue("channel-production-invalid", "production.kind は harness か external");
    }
  }

  let strategy = null;
  if (!plainObject(row.strategy)) {
    issue("channel-strategy-invalid", "strategy は { workDir, requireBrief, strategySkillDir? }");
  } else {
    for (const key of Object.keys(row.strategy)) if (!STRATEGY_KEYS.has(key)) issue("channel-unknown-key", `知らない欄 strategy.${key}`);
    if (typeof row.strategy.requireBrief !== "boolean") issue("channel-strategy-invalid", "strategy.requireBrief は true か false を書く（省略しない）");
    strategy = {
      workDir: pathField(row.strategy.workDir, "strategy.workDir"),
      requireBrief: row.strategy.requireBrief === true,
      ...(row.strategy.strategySkillDir !== undefined
        ? { strategySkillDir: pathField(row.strategy.strategySkillDir, "strategy.strategySkillDir", { optional: true }) }
        : {}),
    };
  }

  let scriptQuality = null;
  if (row.scriptQuality !== undefined) {
    if (!plainObject(row.scriptQuality)) {
      issue("channel-script-quality-invalid", "scriptQuality は { genre, channelConfig? }");
    } else {
      for (const key of Object.keys(row.scriptQuality)) if (!SCRIPT_QUALITY_KEYS.has(key)) issue("channel-unknown-key", `知らない欄 scriptQuality.${key}`);
      const genre = nonEmpty(row.scriptQuality.genre);
      if (!GENRE_ID.test(genre)) issue("channel-script-quality-invalid", "scriptQuality.genre が要る");
      else if (Array.isArray(genres) && !genres.includes(genre)) issue("channel-script-quality-genre-unknown", `台本の品質ループに無いジャンル ${genre}`);
      else if (typeof genreForHarness === "function" && production?.kind === "harness") {
        // 制作の Job は、ハーネスのジャンルの採点表で合格した台本しか通さない（lib/scriptQualityUseGate.mjs）。
        // 台帳のジャンルが違うと、ループで合格しても start が script-quality-genre-mismatch で止まる。
        const expected = genreForHarness(production.harnessId);
        if (expected && expected !== genre) {
          issue("channel-script-quality-genre-mismatch", `scriptQuality.genre ${genre} は制作のハーネス ${production.harnessId} の台本のジャンル（${expected}）と違う`);
        }
      }
      scriptQuality = {
        genre,
        ...(row.scriptQuality.channelConfig !== undefined
          ? { channelConfig: pathField(row.scriptQuality.channelConfig, "scriptQuality.channelConfig", { optional: true }) }
          : {}),
      };
    }
  }

  return {
    id,
    ...(nonEmpty(row.displayName) ? { displayName: nonEmpty(row.displayName) } : {}),
    projectDir,
    channelPack,
    production,
    strategy,
    ...(scriptQuality ? { scriptQuality } : {}),
  };
}

/**
 * チャンネルの行の一覧を検査する（ファイルを読まない純関数）。問題が1つでもあれば理由の一覧つきの例外。
 * pathApi は試験で path.win32 を渡せる。
 */
export function validateChannelRegistry(parsed, {
  repoRoot = MODULE_ROOT,
  sourcePath = "",
  harnessIds = null,
  genres = null,
  genreForHarness = null,
  pathApi = path,
  env = process.env,
  learningState = undefined,
} = {}) {
  const root = pathApi.resolve(repoRoot);
  const rows = parsed?.channels;
  if (rows === undefined) return [];
  const issues = [];
  if (!Array.isArray(rows)) throw registryError([{ code: "channels-not-array", detail: "channels は配列にする" }], sourcePath);
  const channels = rows.map((row, index) => normalizeChannel(row, index, { root, pathApi, harnessIds, genres, genreForHarness, issues }));

  const seen = new Map();
  for (const channel of channels) {
    if (!channel?.id) continue;
    if (seen.has(channel.id)) issues.push({ code: `channel-id-duplicate:${channel.id}`, channelId: channel.id, detail: `id ${channel.id} が2回ある` });
    seen.set(channel.id, channel);
  }

  // チャンネルどうしの場所の重なり（同じ・入れ子）。同じチャンネルの中の入れ子（projectDir の中の workDir）は許す。
  for (let left = 0; left < channels.length; left += 1) {
    for (let right = left + 1; right < channels.length; right += 1) {
      const a = channels[left];
      const b = channels[right];
      if (!a || !b) continue;
      for (const fieldA of CHANNEL_OVERLAP_FIELDS) {
        for (const fieldB of CHANNEL_OVERLAP_FIELDS) {
          const valueA = fieldValue(a, fieldA);
          const valueB = fieldValue(b, fieldB);
          if (!valueA || !valueB) continue;
          const overlap = pathOverlap(valueA, valueB, pathApi);
          if (!overlap) continue;
          const how = overlap === "same" ? "同じ場所" : overlap === "inside" ? `${b.id}.${fieldB} の中` : `${b.id}.${fieldB} を含む`;
          issues.push({
            code: `channel-paths-overlap:${a.id}.${fieldA}:${b.id}.${fieldB}`,
            channelId: a.id,
            detail: `${a.id}.${fieldA} が ${how}（${overlap === "same" ? `${b.id}.${fieldB}` : "入れ子"}）。チャンネルごとに別の場所にする——重なると Job・Pack・ブリーフが別のチャンネルの作業に混ざる`,
          });
        }
      }
    }
  }

  // 学習の保存先（チャンネルごと）。重なり（別のチャンネルの場所・保存先どうし・チャンネルの無い Job の保存先）は拒否する。
  const { stores, usersOf } = channelLearningStores({
    parsed,
    channels,
    root,
    pathApi,
    state: learningStateFor({ learningState, root, env, pathApi }),
    issues,
  });

  if (issues.length > 0) throw registryError(issues, sourcePath);
  return channels.map((channel) => ({
    ...channel,
    learning: channelLearningTargets(channel).map((entry) => ({
      ...entry,
      store: { ...stores.get(channel.id).get(entry.target) },
      // 同じ宛先（同じ種類の台帳）を使う別のチャンネル。保存先は別なので学習は混ざらない（知らせるだけ）。
      sameTargetChannels: (usersOf.get(entry.target) || []).filter((id) => id !== channel.id),
    })),
  }));
}

function registrySource({ repoRoot, deploymentPath, env }) {
  const root = path.resolve(repoRoot);
  if (nonEmpty(deploymentPath)) return { candidates: [path.resolve(deploymentPath)], source: "explicit", required: true };
  const fromEnv = nonEmpty(env?.[CHANNEL_REGISTRY_PATH_ENV]);
  if (fromEnv) return { candidates: [path.resolve(fromEnv)], source: "env", required: true };
  return {
    candidates: [path.join(root, "config", "harness-deployments.json"), path.join(root, "config", "harness-deployments.example.json")],
    source: "operator-map",
    required: false,
  };
}

/**
 * チャンネルの台帳として読むファイル（loadChannelRegistry と同じ決め方）。path は見つかったファイル（無ければ null）、
 * required はファイルが要る呼び出し（明示・環境変数）か、expected は最初に探したファイル、example は例のファイルに
 * 落ちたか。harness-learn は、チャンネルの無い Job の保存先（channelLearning の宛先単位の行）もこのファイルから読む
 * （BUZZASSIST_CHANNEL_REGISTRY で台帳を別のファイルにした端末でも、保存先と台帳の重なりの検査が同じ宣言を見る）。
 */
export function channelRegistrySourcePath({ repoRoot = MODULE_ROOT, deploymentPath = "", env = process.env } = {}) {
  const { candidates, source, required } = registrySource({ repoRoot, deploymentPath, env });
  const found = candidates.find((candidate) => existsSync(candidate)) || null;
  return {
    path: found,
    source,
    required,
    expected: candidates[0],
    example: Boolean(found) && source === "operator-map" && path.basename(found) === "harness-deployments.example.json",
  };
}

/**
 * チャンネルの台帳を読む。配置表（config/harness-deployments.json、無ければ例）の channels を使う。
 * channels が無ければ空の台帳。形が壊れていれば理由の一覧つきで例外（fail-closed）。
 */
export function loadChannelRegistry({
  repoRoot = MODULE_ROOT,
  deploymentPath = "",
  env = process.env,
  harnessIds = null,
  genres = null,
  genreForHarness = null,
} = {}) {
  const { candidates, source, required } = registrySource({ repoRoot, deploymentPath, env });
  const sourcePath = candidates.find((candidate) => existsSync(candidate)) || null;
  const empty = { version: CHANNEL_REGISTRY_VERSION, source, sourcePath, channels: [] };
  if (!sourcePath) {
    if (required) throw registryError([{ code: "channel-registry-missing", detail: `ファイルが無い: ${candidates[0]}` }], candidates[0]);
    return empty;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(sourcePath, "utf8"));
  } catch (error) {
    throw registryError([{ code: "channel-registry-unreadable", detail: `JSON として読めない: ${error.message}` }], sourcePath);
  }
  const channels = validateChannelRegistry(parsed, { repoRoot, sourcePath, harnessIds, genres, genreForHarness, env });
  return {
    version: CHANNEL_REGISTRY_VERSION,
    source: source === "operator-map" && sourcePath.endsWith("harness-deployments.example.json") ? "example" : source,
    sourcePath,
    channels,
  };
}

/** id でチャンネルを引く。無ければ理由コードつきの例外（別のチャンネルや既定へ落ちない）。 */
export function findChannel(registry, channelId) {
  const id = nonEmpty(channelId);
  const channel = (registry?.channels || []).find((entry) => entry.id === id) || null;
  if (!channel) {
    const known = (registry?.channels || []).map((entry) => entry.id);
    const error = new Error(
      `${CHANNEL_UNKNOWN_CODE}: チャンネル ${id || "(空)"} は台帳に無い。`
      + (known.length > 0 ? `台帳にあるチャンネル: ${known.join(", ")}。` : "台帳にチャンネルが無い（config/harness-deployments.json の channels）。"),
    );
    error.code = CHANNEL_UNKNOWN_CODE;
    error.knownChannels = known;
    throw error;
  }
  return channel;
}

/**
 * path からチャンネルを探す（--channel が無い呼び出しの向き先を知るため）。Pack が一致するチャンネル、
 * project が一致するチャンネルを返す。どちらも無ければ null。
 */
export function channelsMatchingPaths(registry, { channelPackPath = "", projectDir = "" } = {}) {
  const channels = registry?.channels || [];
  const byPack = nonEmpty(channelPackPath)
    ? channels.filter((channel) => channel.channelPack && pathOverlap(channelPackPath, channel.channelPack) === "same")
    : [];
  const byProject = nonEmpty(projectDir)
    ? channels.filter((channel) => channel.projectDir && pathOverlap(projectDir, channel.projectDir) === "same")
    : [];
  return { byPack, byProject };
}

export const CHANNEL_INPUT_CONFLICT_CODE = "channel-input-conflict";

function inputConflict(problems) {
  const error = new Error(`${CHANNEL_INPUT_CONFLICT_CODE}: ${problems.join(" / ")}。チャンネルの値は台帳の値だけを使う（別のチャンネルの Pack・場所を混ぜない）。`);
  error.code = CHANNEL_INPUT_CONFLICT_CODE;
  error.problems = problems;
  return error;
}

/**
 * 呼び出しで渡された値が、チャンネルの台帳の値と食い違わないかを確かめる。食い違えば例外（黙ってどちらかを採らない）。
 * 空の値は「渡されていない」で、台帳の値を使う。
 */
export function assertChannelInputs(channel, { harnessId = "", channelPackPath = "", projectDir = "" } = {}) {
  const problems = [];
  const harness = nonEmpty(harnessId);
  if (harness) {
    if (channel.production.kind !== "harness") problems.push(`チャンネル ${channel.id} の制作は外部の仕組みで、ハーネス ${harness} は使わない`);
    else if (harness !== channel.production.harnessId) problems.push(`ハーネス ${harness} はチャンネル ${channel.id} の台帳のハーネス（${channel.production.harnessId}）と違う`);
  }
  if (nonEmpty(channelPackPath) && pathOverlap(channelPackPath, channel.channelPack) !== "same") {
    problems.push(`渡された Channel Pack はチャンネル ${channel.id} の台帳の Pack と違う`);
  }
  if (nonEmpty(projectDir) && pathOverlap(projectDir, channel.projectDir) !== "same") {
    problems.push(`渡された作業フォルダはチャンネル ${channel.id} の台帳の projectDir と違う`);
  }
  if (problems.length > 0) throw inputConflict(problems);
}

/**
 * 呼び出しのチャンネルを決める。明示の id が最優先。無ければ Pack か作業フォルダが一致するチャンネル
 * （--channel を付け忘れた呼び出しでも、台帳のチャンネルの決まり（requireBrief など）を外さないため）。
 * Pack と作業フォルダが別のチャンネルを指せば例外。どれにも当たらなければ null。
 */
export function resolveChannelForCall(registry, { channelId = "", channelPackPath = "", projectDir = "" } = {}) {
  if (nonEmpty(channelId)) return { channel: findChannel(registry, channelId), selectedBy: "explicit" };
  const { byPack, byProject } = channelsMatchingPaths(registry, { channelPackPath, projectDir });
  if (byPack.length === 0 && byProject.length === 0) return null;
  if (byPack.length > 0 && byProject.length > 0 && byPack[0].id !== byProject[0].id) {
    throw inputConflict([`渡された Channel Pack はチャンネル ${byPack[0].id}、作業フォルダはチャンネル ${byProject[0].id} の台帳の値`]);
  }
  return byPack.length > 0
    ? { channel: byPack[0], selectedBy: "channel-pack" }
    : { channel: byProject[0], selectedBy: "project-dir" };
}

/** 出力用のチャンネルの形（台帳の値だけ。別のチャンネルの値は入らない）。 */
export function channelView(channel) {
  return {
    id: channel.id,
    ...(channel.displayName ? { displayName: channel.displayName } : {}),
    projectDir: channel.projectDir,
    channelPack: channel.channelPack,
    production: { ...channel.production },
    strategy: { ...channel.strategy },
    scriptQuality: channel.scriptQuality ? { ...channel.scriptQuality } : null,
    learning: (channel.learning || []).map((entry) => ({ ...entry, store: { ...entry.store }, sameTargetChannels: [...entry.sameTargetChannels] })),
  };
}
