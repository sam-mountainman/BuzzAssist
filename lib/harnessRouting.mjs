// ハーネスのルーティング（プラットフォーム層）
//
// BuzzAssist は3層に分かれている:
//
//   platform craft  — 全ジャンル共通の技法。有償APIのリトライ、証拠の指紋、
//                     原子的書き込み、並列制御。誰のチャンネルでも同じ。
//   genre harness   — ジャンル共通の工程とゲート。漫画動画、ナレーション物語動画。
//                     「漫画系のchなら漫画系の共通ハーネスを使う」の単位。
//   channel pack    — チャンネル固有のキャスト、番組ルール、承認記録。
//                     公開リポジトリには置かない。運営者の手元にだけある。
//
// ここが答えるのは1つだけ——「この依頼に、どの層のどの入口を使わせるか」。
// 判断を各ツールのハンドラに散らすと、後から増えた1つが素通りする。

import { resolve } from "node:path";

/**
 * ジャンルごとの、ガバナンスを通る唯一の入口。
 * 旧入口は同じ絵を出せてしまうぶん危険なので、ここで名指ししておく。
 */
export const GENRE_CANONICAL_ENTRYPOINTS = Object.freeze({
  "manga-video": Object.freeze({
    cli: "node scripts/koya-manga-video.mjs",
    mcpTool: "run_koya_manga_pipeline",
    legacyEntrypoints: Object.freeze([
      "build_excalidraw_manga_video",
      "run_excalidraw_manga_production_dag",
      "scripts/build-manga-video.mjs",
    ]),
    // 旧入口が通らないゲート。エラー文でここを読ませて、
    // 「同じものが作れるのになぜ止められるのか」を疑わせない。
    gatesBypassed: Object.freeze(["番組ルール", "配役ゲート", "外部サインオフ", "MP4実デコード監査"]),
  }),
});

/**
 * 旧入口が本番として使われようとしていないかを判定する。
 *
 * Channel Pack が置かれている＝上位のルーターがそのチャンネルを選んでいる、
 * ということなので、そこでガバナンスを迂回する入口を通す理由はない。
 * 過去成果物の再現（ベンチマーク移行）だけは、そう明言したときに通す。
 */
export function checkCanonicalRouting({ genre = "manga-video", toolName, projectDir, acknowledgedBenchmarkMigration = false } = {}) {
  const canonical = GENRE_CANONICAL_ENTRYPOINTS[genre];
  if (!canonical) return { allowed: true, reason: `未知のジャンル ${genre}: ルーティング規則なし` };
  if (!canonical.legacyEntrypoints.includes(toolName)) return { allowed: true, reason: "正規入口" };

  // pack の有無で判定していたが、それは間違いだった。旧入口が迂回するのは
  // 番組ルール（channel 層）だけでなく、最終監査・カメラ文法・サインオフという
  // **ジャンル層のゲート全部**なので、pack が無くても通してはいけない。
  // しかも新しい運営者の初期状態は「pack 無し」——最も危険な時間帯だけ
  // 迂回路が開いていた。CLAUDE.md も旧入口を「ベンチマーク移行専用」と
  // 条件なしで定めている。
  const dir = resolve(projectDir || process.cwd());
  if (acknowledgedBenchmarkMigration === true) {
    return { allowed: true, reason: "ベンチマーク移行として明示的に宣言された", benchmarkMigration: true };
  }
  return {
    allowed: false,
    reason: "ベンチマーク移行専用の旧入口が本番として使われようとしている",
    canonical,
    message:
      `${toolName} は移行ベンチマーク専用の旧入口。`
      + `新規エピソードは ${canonical.mcpTool}（CLI なら ${canonical.cli}）を使うこと——`
      + `旧入口は ${canonical.gatesBypassed.join("、")} のいずれも通らないため、`
      + `ここを通した成果物は監査に耐えない。`
      + `過去成果物の再現が目的なら benchmarkMigration: true を明示的に渡すこと。`,
  };
}

/** checkCanonicalRouting の throw 版。ハンドラの1行目に置く用。 */
export function assertCanonicalRouting(options = {}) {
  const verdict = checkCanonicalRouting(options);
  if (!verdict.allowed) throw new Error(verdict.message);
  return verdict;
}
