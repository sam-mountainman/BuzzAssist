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
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const LEARN_DIR = path.join(REPO_ROOT, "docs", "learning");
const PROPOSALS_PATH = path.join(LEARN_DIR, "proposals.jsonl");
const APPLIED_PATH = path.join(LEARN_DIR, "applied.jsonl");

// 提案が向かう先。ここに無いものは apply できない。
// 正本スキルと台帳だけを対象にするのは、次のセッションが必ず読む場所が
// この2つだからで、それ以外へ書いても学習として効かない。
// 宛先の定義は docs/learning/targets.json に持つ。コード内に二重に
// 持たせると、片方だけ古くなる——今日このリポジトリで何度も見た形。
export const LEARNING_TARGETS = new Proxy({}, {
  get(_t, key) {
    if (typeof key !== "string") return undefined;
    return loadTargets()[key]?.canonical;
  },
  has(_t, key) { return typeof key === "string" && key in loadTargets(); },
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
const TARGETS_PATH = path.join(LEARN_DIR, "targets.json");

export function loadTargets(targetsPath = TARGETS_PATH) {
  const raw = JSON.parse(fs.readFileSync(targetsPath, "utf8"));
  return raw.targets ?? {};
}

export const OVERLAY_HEADER = [
  "<!-- このファイルは harness-learn が自動で書きます。手で編集しないでください。 -->",
  "",
  "# 自動で積み上がった指摘",
  "",
  "隣の `SKILL.md` が正本で、**矛盾したときは SKILL.md が優先**します。",
  "ここは運用上の補助指示であって、**監査・承認・合否の証跡には使えません**。",
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

export function renderOverlay(entries, now) {
  const lines = [OVERLAY_HEADER];
  if (entries.length === 0) {
    lines.push("_まだ自動反映された項目はありません。_", "");
  } else {
    for (const entry of entries) {
      const repeat = entry.occurrences > 1 ? `（${entry.occurrences}回指摘）` : "";
      lines.push(`- **${sanitizeForOverlay(entry.text)}**${repeat}`);
      for (const ev of entry.evidence) lines.push(`  - 根拠: ${sanitizeForOverlay(ev)}`);
      lines.push(`  - 種別: ${entry.kind} / 初回: ${String(entry.firstSeenAt).slice(0, 10)} / id: \`${entry.id}\``);
    }
    lines.push("");
  }
  lines.push(`_最終更新: ${now}_`, "");
  return lines.join("\n");
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

export function proposalId(entry) {
  return createHash("sha256")
    .update([entry.kind, entry.target, entry.text].join(""))
    .digest("hex")
    .slice(0, 12);
}

// 同じ指摘が何度も来るのは「まだ直っていない」という強い信号なので、
// 重複を捨てずに回数として数える。1回の思いつきと、3回言われたことを
// 同じ重みで扱わないための材料。
// 反映済みの判定。id が1行あるだけでは足りない——正本にその規則が
// 実在することまで見る。以前は id だけで判定していたので、正本を
// 1文字も変えずに apply を通せてしまい、status からも消えていた。
export function isActuallyApplied(record, readCanonical) {
  if (!record?.id) return false;
  // 昇格記録には、何をどこへ書いたかが要る。
  if (!record.reviewer || !String(record.reviewer).trim()) return false;
  if (!record.targetPath) return false;
  const text = readCanonical(record.targetPath);
  if (text === null) return false;
  // 正本にその規則の痕跡があること。丸写しは求めないので、
  // 記録した note か text の主要部分のどちらかが載っていればよい。
  const needles = [record.note, record.text].filter((v) => typeof v === "string" && v.trim().length >= 5);
  return needles.some((n) => text.includes(n.trim()));
}

export function summarizeProposals(proposals, applied, readCanonical = null) {
  const appliedIds = new Set(
    readCanonical
      ? applied.filter((entry) => isActuallyApplied(entry, readCanonical)).map((entry) => entry.id)
      : applied.map((entry) => entry.id),
  );
  const byId = new Map();
  for (const entry of proposals) {
    const id = entry.id ?? proposalId(entry);
    const existing = byId.get(id);
    if (existing) {
      existing.occurrences += 1;
      existing.lastSeenAt = entry.capturedAt ?? existing.lastSeenAt;
      if (entry.evidence && !existing.evidence.includes(entry.evidence)) {
        existing.evidence.push(entry.evidence);
      }
    } else {
      byId.set(id, {
        ...entry,
        id,
        occurrences: 1,
        firstSeenAt: entry.capturedAt ?? null,
        lastSeenAt: entry.capturedAt ?? null,
        evidence: entry.evidence ? [entry.evidence] : [],
        applied: appliedIds.has(id),
      });
    }
  }
  return [...byId.values()].sort((a, b) => {
    if (a.applied !== b.applied) return a.applied ? 1 : -1;
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
    return String(a.firstSeenAt).localeCompare(String(b.firstSeenAt));
  });
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

function requireTarget(target) {
  if (!LEARNING_TARGETS[target]) {
    throw new Error(
      `未知の target: ${target}\n使えるのは:\n`
        + Object.keys(LEARNING_TARGETS).map((key) => `  ${key}`).join("\n"),
    );
  }
  const rel = LEARNING_TARGETS[target];
  const full = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(full)) {
    throw new Error(`target のファイルがありません: ${rel}`);
  }
  return { rel, full };
}

export function buildProposal({ kind, target, text, evidence, session, now }) {
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
  requireTarget(target);
  const entry = {
    kind,
    target,
    text: text.trim(),
    evidence: evidence?.trim() || null,
    session: session || null,
    capturedAt: now,
  };
  return { ...entry, id: proposalId(entry) };
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
    --session "セッションIDなど（任意）"

  status    未反映の提案を、繰り返された回数順に出す

  sync      **自動反映**。LEARNED マーカーのある正本の機械区画を書き直す。
            人が書いた本文には触らないので reviewer は要らない

  promote   機械区画の項目を人の規則へ格上げする（reviewer 必須）
    --id <提案ID>  --reviewer <名前>  --note "どこにどう書いたか"

  review    統合案を出す（既定は dry-run。スキルには触らない）
    --apply-hint   まとめ方の助言を詳しく出す

  apply     提案を反映済みとして記録する
    --id <提案ID>  --reviewer <名前>  --note "何をどう書いたか"

  なぜこの形か: 捕捉は書き換えない、review は既定 dry-run、apply には
  reviewer 名が要る。自動で正本を書き換える作りにすると、「スクリプトが
  自分で自分に合格を出す」のと同じ構造になるため。
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date().toISOString();

  if (!args.action || args.action === "--help" || args.action === "-h") {
    printHelp();
    process.exit(args.action ? 0 : 2);
  }

  const proposals = readJsonl(PROPOSALS_PATH);
  const applied = readJsonl(APPLIED_PATH);
  // 正本を実際に読んで反映を確かめる。記録を信じない。
  const readCanonical = (rel) => {
    const full = path.join(REPO_ROOT, rel);
    return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
  };
  const summary = summarizeProposals(proposals, applied, readCanonical);

  switch (args.action) {
    case "capture": {
      const entry = buildProposal({
        kind: args.kind,
        target: args.target,
        text: args.text,
        evidence: args.evidence,
        session: args.session,
        now,
      });
      appendJsonl(PROPOSALS_PATH, entry);
      const repeats = proposals.filter((p) => (p.id ?? proposalId(p)) === entry.id).length;
      process.stdout.write(`記録しました: ${entry.id}\n`);
      if (repeats > 0) {
        process.stdout.write(
          `  ⚠️ 同じ指摘は これで ${repeats + 1} 回目です。まだ正本へ反映できていません\n`,
        );
      }
      process.stdout.write(`  反映先候補: ${LEARNING_TARGETS[entry.target]}\n`);
      break;
    }

    case "status": {
      const pending = summary.filter((entry) => !entry.applied);
      if (pending.length === 0) {
        process.stdout.write("未反映の提案はありません\n");
        break;
      }
      process.stdout.write(`未反映 ${pending.length} 件（繰り返し回数順）\n\n`);
      for (const entry of pending) {
        const repeat = entry.occurrences > 1 ? ` ×${entry.occurrences}` : "";
        process.stdout.write(`  [${entry.id}]${repeat} ${entry.kind} → ${entry.target}\n`);
        process.stdout.write(`      ${entry.text}\n`);
        for (const ev of entry.evidence) process.stdout.write(`      根拠: ${ev}\n`);
      }
      break;
    }

    case "review": {
      const clusters = clusterForConsolidation(summary);
      if (clusters.length === 0) {
        process.stdout.write("統合するものはありません\n");
        break;
      }
      process.stdout.write("統合案（dry-run。ここでは何も書き換えていません）\n\n");
      for (const cluster of clusters) {
        process.stdout.write(`▼ ${cluster.target} → ${LEARNING_TARGETS[cluster.target]}\n`);
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
        + "書いたあと apply --id <id> --reviewer <名前> --note \"どう書いたか\" を実行する。\n",
      );
      break;
    }

    case "sync": {
      // 自動反映。機械が丸ごと所有する overlay ファイルだけを書き直す。
      // 人が書く正本（canonical）には一切触らない。
      // review-only の宛先は、そこが承認と監査の記録そのものなので
      // 自動反映しない——機械がゲート基準を緩められる余地を作らない。
      const targets = loadTargets();
      const pending = summary.filter((entry) => !entry.applied);
      const byTarget = new Map();
      for (const entry of pending) {
        if (!byTarget.has(entry.target)) byTarget.set(entry.target, []);
        byTarget.get(entry.target).push(entry);
      }
      let wrote = 0;
      const held = [];
      for (const [target, def] of Object.entries(targets)) {
        const entries = byTarget.get(target) ?? [];
        if (def.mode === "review-only") {
          if (entries.length > 0) held.push({ target, count: entries.length, reason: def.reason });
          continue;
        }
        if (!def.overlay) continue;
        const full = path.join(REPO_ROOT, def.overlay);
        const next = renderOverlay(entries, now);
        const before = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
        if (before === next) continue;
        fs.mkdirSync(path.dirname(full), { recursive: true });
        // 一時ファイル＋rename。書き込み途中で落ちた overlay を
        // 次のセッションが指示として読むことがないように。
        const temp = `${full}.${process.pid}.partial`;
        fs.writeFileSync(temp, next);
        fs.renameSync(temp, full);
        process.stdout.write(`✅ ${def.overlay}（${entries.length}件）\n`);
        wrote += 1;
      }
      if (wrote === 0 && held.length === 0) process.stdout.write("更新するものはありませんでした\n");
      for (const h of held) {
        process.stdout.write(
          `⏸  ${h.target} は review-only なので自動反映しません（${h.count}件保留）\n`
          + `    ${h.reason ?? "人が書く記録です"}\n`,
        );
      }
      break;
    }

    case "promote": {
      // 機械区画の項目を、人が書いた規則へ格上げする。ここは reviewer 必須。
      // 「機械が書いた」と「人が確認した」の差がこの一手で、
      // この差が無くなると自己改善が自己認証に変わる。
      if (!args.id) throw new Error("--id が必要です");
      if (typeof args.reviewer !== "string" || args.reviewer.trim() === "") {
        throw new Error(
          "--reviewer <名前> が必要です。機械区画から人の規則へ上げるのは人の判断です",
        );
      }
      const entry = summary.find((item) => item.id === args.id);
      if (!entry) throw new Error(`提案が見つかりません: ${args.id}`);
      if (entry.applied) throw new Error(`${args.id} は既に昇格済みです`);
      const { rel, full } = requireTarget(entry.target);
      // overlay に載っているのは sync の当然の結果なので、それを拒否の
      // 条件にすると promote が永久に通らなくなる（実際そうなっていた）。
      // 見るべきは overlay ではなく **正本に書かれたか**。
      const canonicalText = fs.readFileSync(full, "utf8");
      const note = typeof args.note === "string" ? args.note.trim() : "";
      const evidenceInCanon = [note, entry.text]
        .filter((v) => v && v.length >= 5)
        .some((v) => canonicalText.includes(v));
      if (!evidenceInCanon) {
        throw new Error(
          `${rel} に該当の記述が見つかりません。\n`
          + "promote は「正本へ書いたことの記録」です。先に人の言葉で正本へ書き、\n"
          + "--note にその文言（正本に実在する一節）を渡してください。",
        );
      }
      appendJsonl(APPLIED_PATH, {
        id: entry.id,
        target: entry.target,
        targetPath: rel,
        targetSha256: createHash("sha256").update(fs.readFileSync(full)).digest("hex"),
        text: entry.text,
        reviewer: args.reviewer.trim(),
        note: typeof args.note === "string" ? args.note.trim() : "",
        promotedAt: now,
      });
      process.stdout.write(`${entry.id} を人の規則へ昇格しました（reviewer: ${args.reviewer}）\n`);
      break;
    }

    case "apply": {
      if (!args.id) throw new Error("--id が必要です（status か review で確認）");
      if (typeof args.reviewer !== "string" || args.reviewer.trim() === "") {
        throw new Error(
          "--reviewer <名前> が必要です。誰が反映を確認したか記録しない自動反映は証跡になりません",
        );
      }
      const entry = summary.find((item) => item.id === args.id);
      if (!entry) throw new Error(`提案が見つかりません: ${args.id}`);
      if (entry.applied) throw new Error(`${args.id} は既に反映済みです`);
      const { rel, full } = requireTarget(entry.target);
      // apply も promote と同じ検証を通す。緩い経路を1つでも残すと、
      // そちらから素通りできてしまう。
      const applyNote = typeof args.note === "string" ? args.note.trim() : "";
      const applyText = fs.readFileSync(full, "utf8");
      if (![applyNote, entry.text].filter((v) => v && v.length >= 5).some((v) => applyText.includes(v))) {
        throw new Error(
          `${rel} に該当の記述が見つかりません。\n`
          + "apply は「正本へ書いたことの記録」です。先に書いてから、\n"
          + "--note に正本へ実在する一節を渡してください。",
        );
      }
      appendJsonl(APPLIED_PATH, {
        id: entry.id,
        target: entry.target,
        targetPath: rel,
        targetSha256: createHash("sha256").update(fs.readFileSync(full)).digest("hex"),
        text: entry.text,
        reviewer: args.reviewer.trim(),
        note: applyNote,
        appliedAt: now,
      });
      process.stdout.write(`${entry.id} を反映済みとして記録しました（reviewer: ${args.reviewer}）\n`);
      break;
    }

    default:
      throw new Error(`不明なアクション: ${args.action}`);
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invoked && invoked === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
}
