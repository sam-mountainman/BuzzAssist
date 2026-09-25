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
//   - 学習の宛先はチャンネルの制作のハーネス（と台本のジャンル）から決まる。別のチャンネルと同じ宛先になるときは
//     sharedWith に出す（推測で別の宛先へ寄せない）。宛先の保存先（channelLearning）が別のチャンネルの場所に
//     重なるなら拒否する
//   - 既定の Pack の探索（lib/channelPackResolver.mjs の resolveDefaultPackId）や環境変数の Pack を使わない。
//     チャンネルの値は台帳の値だけ
//   - 読むだけ。ファイルを作らない・書かない
//
// 例のファイル（config/harness-deployments.example.json）の channels は空。書き方は channelTemplate にあり、
// 読み込みでは使わない（例を写した配置表に合成のチャンネルが入らないように）。

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HARNESS_LEARNING_ROUTES, SCRIPT_LEARNING_ROUTES } from "./harnessLearningTargets.mjs";

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

function channelLearningRows(parsed, root, pathApi) {
  if (!Array.isArray(parsed?.channelLearning)) return new Map();
  const rows = new Map();
  for (const row of parsed.channelLearning) {
    const target = nonEmpty(row?.target);
    const value = nonEmpty(row?.root);
    if (!target || !value || PLACEHOLDER.test(value)) continue;
    rows.set(target, pathApi.isAbsolute(value) ? pathApi.resolve(value) : pathApi.resolve(root, value));
  }
  return rows;
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

  // 学習の保存先（channelLearning で宣言した私有の場所）が別のチャンネルの場所に重なるなら拒否する。
  const learningRows = channelLearningRows(parsed, root, pathApi);
  for (const channel of channels) {
    if (!channel?.id) continue;
    for (const { target } of channelLearningTargets(channel)) {
      const store = learningRows.get(target);
      if (!store) continue;
      for (const other of channels) {
        if (!other?.id || other.id === channel.id) continue;
        // 同じ宛先を共有するチャンネル（同じハーネス）どうしは sharedWith で出す。ここは場所の重なりだけ。
        if (channelLearningTargets(other).some((entry) => entry.target === target)) continue;
        for (const field of CHANNEL_OVERLAP_FIELDS) {
          const value = fieldValue(other, field);
          if (value && pathOverlap(store, value, pathApi)) {
            issues.push({
              code: `channel-learning-store-overlap:${channel.id}:${other.id}.${field}`,
              channelId: channel.id,
              detail: `${channel.id} の学習の保存先（${target}）が ${other.id}.${field} に重なる。学習が別のチャンネルの場所に積まれる`,
            });
          }
        }
      }
    }
  }

  if (issues.length > 0) throw registryError(issues, sourcePath);
  const byTarget = new Map();
  for (const channel of channels) {
    for (const { target } of channelLearningTargets(channel)) {
      byTarget.set(target, [...(byTarget.get(target) || []), channel.id]);
    }
  }
  return channels.map((channel) => ({
    ...channel,
    learning: channelLearningTargets(channel).map((entry) => ({
      ...entry,
      store: learningRows.has(entry.target)
        ? { source: "channel-learning", root: learningRows.get(entry.target) }
        : { source: "channel-pack-default" },
      sharedWith: (byTarget.get(entry.target) || []).filter((id) => id !== channel.id),
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
  const channels = validateChannelRegistry(parsed, { repoRoot, sourcePath, harnessIds, genres, genreForHarness });
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
    learning: (channel.learning || []).map((entry) => ({ ...entry, store: { ...entry.store }, sharedWith: [...entry.sharedWith] })),
  };
}
