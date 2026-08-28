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
export const LEARNING_TARGETS = {
  "skill:manga-video-production": ".agents/skills/manga-video-production/SKILL.md",
  "skill:manga-page-camera": ".agents/skills/manga-page-camera/SKILL.md",
  "skill:harness-parallel-execution": ".agents/skills/harness-parallel-execution/SKILL.md",
  "ledger:koya": "docs/koya-channel-requirements-ledger.md",
  "doc:mike-audio-gates": "deployments/narrated-story-video/docs/AUDIO-BGM-GATES.md",
};

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
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
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
export function summarizeProposals(proposals, applied) {
  const appliedIds = new Set(applied.map((entry) => entry.id));
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
  const summary = summarizeProposals(proposals, applied);

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
      appendJsonl(APPLIED_PATH, {
        id: entry.id,
        target: entry.target,
        targetPath: rel,
        // 反映後の正本のダイジェスト。後から「本当にこの版に入ったのか」を
        // 突き合わせられるようにする。
        targetSha256: createHash("sha256").update(fs.readFileSync(full)).digest("hex"),
        text: entry.text,
        reviewer: args.reviewer.trim(),
        note: typeof args.note === "string" ? args.note.trim() : "",
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
