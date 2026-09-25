// 複数のファイルを「全部入れ替わる」か「1つも変わらない」かのどちらかにする書き込み（redo journal）。
//
// なぜ要るか:
// 1つのファイルは temp → rename（writeJsonAtomic）で原子的に書けるが、確定の工程は
// 完成 MP4・監査の報告・Receipt・状態ファイルのように複数のファイルを続けて書く。途中で落ちると、
// 監査の報告だけが pass になり状態ファイルは古いまま、という半端な組み合わせが残る。状態ファイルは
// 成果物を SHA で縛っているので、組み合わせが崩れると「再利用できない」と判定され、描き直しから
// やり直しになる。
//
// 手順:
//   1. 新しい中身を全部、置き場（<root>/.transactions/<id>/）へ書く。対象の場所にはまだ触らない
//   2. 置き場のファイルの sha256 を記録した journal.json を原子的に書く ← ここが確定の点
//   3. 置き場のファイルを順に対象の場所へ rename する（同じファイルシステムの中なので各1回は原子的）
//   4. 置き場を消す
//
// 落ちたときの戻し方（recoverFileTransactions。状態を読む前に呼ぶ）:
//   - journal が無い置き場 … 確定の前に落ちた。対象は1つも変わっていないので、置き場を捨てる
//   - journal がある置き場 … 確定の後に落ちた。残りの rename を journal どおりにやり切る（redo）。
//     置き場のファイルか対象のどちらかが journal の sha256 と合わなければ、誰かが途中で触っているので
//     何も直さずに止める（fail-closed。置き場は調べられるように残す）
//
// Node の標準機能だけで書く（配布プラグインが外部依存なしで読めるように。lib/atomicJsonFile.mjs と同じ理由）。
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { renameWithRetry, writeJsonAtomic } from "./atomicJsonFile.mjs";

export const FILE_TRANSACTION_VERSION = "buzzassist-file-transaction-v1";
export const FILE_TRANSACTION_DIR = ".transactions";
const JOURNAL_NAME = "journal.json";

/**
 * 試験だけで使う「ここで落ちた」の差し込み（node --test の中でしか効かない）。
 * 値は `<label>:before-journal` か `<label>:after-rename-<n>`。確定の途中で落ちたときに
 * 半端な状態が残らないこと（次の実行がやり切るか捨てること）を、本物の経路で確かめるため。
 */
export const FILE_TRANSACTION_TEST_FAULT_ENV = "BUZZASSIST_TEST_FILE_TRANSACTION_FAULT";

function injectedFault(label) {
  if (!String(process.env.NODE_TEST_CONTEXT || "").trim()) return "";
  const raw = String(process.env[FILE_TRANSACTION_TEST_FAULT_ENV] || "").trim();
  const prefix = `${label}:`;
  return label && raw.startsWith(prefix) ? raw.slice(prefix.length) : "";
}

function interrupted(id, point) {
  const error = new Error(`file transaction ${id} interrupted at ${point} (test fault injection)`);
  error.code = "file-transaction-test-interrupt";
  return error;
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function fileState(path) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return { exists: true, file: false };
    return { exists: true, file: true, bytes: info.size, sha256: await sha256File(path) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

function insideRoot(root, target) {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * 置き場を開く。`root` は対象のファイルが全部入るディレクトリ（同じファイルシステムの中で rename するため）。
 * 返す操作:
 *   stagePath(target)          … 対象の代わりに書く置き場の path（中身は呼び出し側が書く）
 *   stageJson(target, value)   … JSON を置き場へ書く（writeJsonAtomic と同じ整形）
 *   stageCopy(target, source)  … 既存のファイルを置き場へ写す
 *   record(target)             … 置き場の中身から { path: 対象, sha256, bytes } を作る（確定の前に状態へ書くため）
 *   commit()                   … journal を書いてから全部を入れ替える
 *   abort()                    … 置き場を捨てる（対象には触らない）
 */
export async function openFileTransaction(root, { label = "" } = {}) {
  const base = resolve(root);
  const id = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const dir = join(base, FILE_TRANSACTION_DIR, id);
  await mkdir(dir, { recursive: true });
  const entries = [];
  const byTarget = new Map();
  let settled = false;
  const assertOpen = () => {
    if (settled) throw new Error(`file transaction ${id} is already committed or aborted.`);
  };
  const stagePath = (target) => {
    assertOpen();
    const absolute = resolve(target);
    if (!insideRoot(base, absolute)) {
      throw new Error(`file transaction target must be inside ${base}: ${absolute}`);
    }
    if (byTarget.has(absolute)) return byTarget.get(absolute).staged;
    const staged = join(dir, `${String(entries.length).padStart(3, "0")}-${basename(absolute)}`);
    const entry = { target: absolute, staged };
    entries.push(entry);
    byTarget.set(absolute, entry);
    return staged;
  };
  return {
    id,
    dir,
    label,
    stagePath,
    async stageJson(target, value, { mode = 0o600 } = {}) {
      const staged = stagePath(target);
      await writeFile(staged, `${JSON.stringify(value, null, 2)}\n`, { mode });
      return staged;
    },
    async stageCopy(target, source) {
      const staged = stagePath(target);
      await copyFile(source, staged);
      return staged;
    },
    async record(target) {
      const entry = byTarget.get(resolve(target));
      if (!entry) throw new Error(`file transaction has no staged file for ${target}`);
      const info = await stat(entry.staged);
      if (!info.isFile() || info.size === 0) throw new Error(`Staged artifact is missing or empty: ${entry.target}`);
      return { path: entry.target, sha256: await sha256File(entry.staged), bytes: info.size };
    },
    async commit() {
      assertOpen();
      const rows = [];
      for (const entry of entries) {
        const state = await fileState(entry.staged);
        if (!state.file) throw new Error(`file transaction ${id}: staged file was not written for ${entry.target}`);
        rows.push({ target: entry.target, staged: basename(entry.staged), sha256: state.sha256, bytes: state.bytes });
      }
      const fault = injectedFault(label);
      if (fault === "before-journal") {
        settled = true;
        throw interrupted(id, fault);
      }
      // 確定の点。ここより前に落ちれば対象は1つも変わらず、後に落ちれば recover がやり切る。
      await writeJsonAtomic(join(dir, JOURNAL_NAME), {
        version: FILE_TRANSACTION_VERSION,
        id,
        label,
        committedAt: new Date().toISOString(),
        entries: rows,
      });
      settled = true;
      for (const [index, entry] of entries.entries()) {
        await mkdir(dirname(entry.target), { recursive: true });
        await renameWithRetry(entry.staged, entry.target);
        if (fault === `after-rename-${index + 1}`) throw interrupted(id, fault);
      }
      await rm(dir, { recursive: true, force: true });
      await rmdir(dirname(dir)).catch(() => {});
      return { id, committed: rows.length };
    },
    async abort() {
      if (settled) return;
      settled = true;
      await rm(dir, { recursive: true, force: true });
      await rmdir(dirname(dir)).catch(() => {});
    },
  };
}

/**
 * 落ちた置き場を片付ける。状態ファイルを読む前（同じ作業場の錠の中）に呼ぶこと。
 * 戻り値: { rolledForward: [id], discarded: [id] }。やり切れない置き場があれば例外（何も直さない）。
 */
export async function recoverFileTransactions(root) {
  const base = resolve(root);
  const parent = join(base, FILE_TRANSACTION_DIR);
  let names = [];
  try {
    names = (await readdir(parent, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return { rolledForward: [], discarded: [] };
    throw error;
  }
  const rolledForward = [];
  const discarded = [];
  for (const name of names) {
    const dir = join(parent, name);
    let journal = null;
    try {
      journal = JSON.parse(await readFile(join(dir, JOURNAL_NAME), "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`file transaction journal is unreadable: ${join(dir, JOURNAL_NAME)} (${error.message})`);
    }
    if (!journal) {
      // 確定の前に落ちた: 対象は変わっていない。置き場を捨てる（書きかけの一時ファイルもここで消える）。
      await rm(dir, { recursive: true, force: true });
      discarded.push(name);
      continue;
    }
    if (journal.version !== FILE_TRANSACTION_VERSION || !Array.isArray(journal.entries)) {
      throw new Error(`file transaction journal has an unknown shape: ${join(dir, JOURNAL_NAME)}`);
    }
    // 先に全部を確かめてから動かす（途中まで動かしてから食い違いに気づく、を作らない）。
    const plan = [];
    for (const entry of journal.entries) {
      const target = resolve(String(entry.target || ""));
      if (!insideRoot(base, target)) throw new Error(`file transaction journal points outside ${base}: ${target}`);
      const staged = join(dir, basename(String(entry.staged || "")));
      const stagedState = await fileState(staged);
      if (stagedState.file) {
        if (stagedState.sha256 !== entry.sha256) {
          throw new Error(`file transaction ${name}: staged ${basename(staged)} no longer matches its journal; left for inspection at ${dir}`);
        }
        plan.push({ staged, target });
        continue;
      }
      const targetState = await fileState(target);
      if (!targetState.file || targetState.sha256 !== entry.sha256) {
        throw new Error(`file transaction ${name}: ${target} is neither staged nor committed with the journaled sha256; left for inspection at ${dir}`);
      }
    }
    for (const move of plan) {
      await mkdir(dirname(move.target), { recursive: true });
      await renameWithRetry(move.staged, move.target);
    }
    await rm(dir, { recursive: true, force: true });
    rolledForward.push(name);
  }
  // 置き場の親は空なら消す（別の確定が同時に置き場を作っていれば残る）。
  await rmdir(parent).catch(() => {});
  return { rolledForward, discarded };
}
