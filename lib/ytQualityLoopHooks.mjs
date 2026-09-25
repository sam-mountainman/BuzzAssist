// yt-quality-loop のフックが、BuzzAssist の制作 Job の会話へ介入し得る状態かを見る（読むだけ）。
//
// yt-quality-loop（別リポジトリ・別配布のプラグイン）は、Claude Code と Codex に
// Stop / UserPromptSubmit フックを入れる。フックの中身（1.8.x、2026-09-25 に読んだもの）:
//
//   - Stop: 入力の cwd と session_id から `<cwd>/.yt-loop/sessions/<session_id>/state.json` を読み、
//     無ければ何もしない。`active: true` のループがあるときだけ `{"decision":"block"}` を返して
//     終了を止め、ループの続き（評価・次の回・最終報告）を指示する
//   - UserPromptSubmit: 入力を書き換えない。毎回 `YT_LOOP_SESSION_ID=<id>` の1行を文脈に足し、
//     同じ会話に動いているループがあればその状態も足す
//
// つまり制作 Job（run-video-harness / koya-manga-video / narrated-story-video）の続行判定に
// 口を出すのは、**同じ会話・同じ作業フォルダーで yt-quality-loop のループが動いているとき**だけ。
// その状態を doctor で見つけて知らせる。yt-quality-loop 側は変更しない。

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const PLUGIN_NAME = "yt-quality-loop";

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readText(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/** Claude Code の settings.json（端末全体とプロジェクト）で有効になっているか。 */
function claudeEnabled({ homeDir, projectDirs }) {
  const files = [
    path.join(homeDir, ".claude", "settings.json"),
    ...projectDirs.flatMap((dir) => [
      path.join(dir, ".claude", "settings.json"),
      path.join(dir, ".claude", "settings.local.json"),
    ]),
  ];
  return files.some((file) => {
    const enabled = readJson(file)?.enabledPlugins;
    if (!enabled || typeof enabled !== "object") return false;
    return Object.entries(enabled).some(([key, value]) => key.split("@")[0] === PLUGIN_NAME && value === true);
  });
}

/** Codex の config.toml で `[plugins."yt-quality-loop@..."]` が enabled = true か。 */
function codexEnabled({ codexHome }) {
  const text = readText(path.join(codexHome, "config.toml"));
  if (!text) return false;
  const header = /^\[plugins\."yt-quality-loop@[^"]*"\]\s*$/mu;
  const match = header.exec(text);
  if (!match) return false;
  const rest = text.slice(match.index + match[0].length);
  const nextTable = rest.search(/^\[/mu);
  const body = nextTable >= 0 ? rest.slice(0, nextTable) : rest;
  return /^\s*enabled\s*=\s*true\s*$/mu.test(body);
}

/** `<dir>/.yt-loop/sessions/<id>/state.json` のうち、active なものを集める。 */
export function findActiveYtLoops(projectDirs) {
  const loops = [];
  for (const dir of projectDirs) {
    const sessionsDir = path.join(dir, ".yt-loop", "sessions");
    let sessions = [];
    try {
      sessions = readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const session of sessions) {
      const stateFile = path.join(sessionsDir, session.name, "state.json");
      const state = readJson(stateFile);
      if (state?.active !== true) continue;
      let updatedAt = null;
      try { updatedAt = new Date(statSync(stateFile).mtimeMs).toISOString(); } catch {}
      loops.push({
        sessionId: session.name,
        iteration: state.iteration ?? null,
        maxIterations: state.max_iterations ?? null,
        updatedAt,
      });
    }
  }
  return loops;
}

export function probeYtQualityLoopHooks({ projectDirs = [], homeDir, env = process.env } = {}) {
  const dirs = [...new Set(projectDirs.filter(Boolean).map((dir) => path.resolve(dir)))];
  const codexHome = String(env.CODEX_HOME || "").trim() || path.join(homeDir, ".codex");
  const hosts = [
    ...(claudeEnabled({ homeDir, projectDirs: dirs }) ? ["Claude Code"] : []),
    ...(codexEnabled({ codexHome }) ? ["Codex"] : []),
  ];
  const activeLoops = findActiveYtLoops(dirs);
  if (activeLoops.length > 0 && hosts.length === 0) {
    return {
      ok: true,
      hosts,
      activeLoops,
      detail: "この作業フォルダーに動いている yt-quality-loop のループの記録があるが、Claude Code / Codex のどちらでも"
        + "yt-quality-loop は有効になっていないので、フックは走らない",
      fix: "",
    };
  }
  if (activeLoops.length > 0) {
    const sessions = activeLoops.map((loop) => `${loop.sessionId}（${loop.iteration ?? "?"}/${loop.maxIterations ?? "?"} 回目）`).join(", ");
    return {
      ok: false,
      code: "yt-loop-active",
      hosts,
      activeLoops,
      detail: `この作業フォルダーで yt-quality-loop のループが動いている: ${sessions}。`
        + "その会話で制作 Job を回すと、yt-quality-loop の Stop フックが終了を止めてループの続きを指示する",
      fix: "ループを最後まで終えるか、yt-quality-loop の loop-cancel で止めてから、ループとは別の会話で制作 Job を回す。"
        + "BuzzAssist からはループの状態ファイルを書き換えない",
    };
  }
  return {
    ok: true,
    hosts,
    activeLoops: [],
    detail: hosts.length > 0
      ? `yt-quality-loop のフックが入っている（${hosts.join(" / ")}）が、この作業フォルダーに動いているループは無い。`
        + "フックが終了を止めるのは同じ会話で動いているループがあるときだけなので、制作 Job の続行判定には介入しない"
        + "（入力は書き換えず、毎回の入力に会話 ID の1行を足すだけ）"
      : "yt-quality-loop のフックは入っていない",
    fix: "",
  };
}
