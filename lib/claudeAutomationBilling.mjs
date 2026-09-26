// `claude -p`（Claude Code の非対話の実行）で子エージェントを起動する前の、課金の注意。
//
// 2026-06-15 から、`claude -p`・Claude Agent SDK での自動実行は、サブスクリプションの利用枠では
// なく、別の月額クレジットから引かれる（API と同じ価格・繰り越しなし）。使い切ると、追加課金を
// 有効にしていれば API の価格で請求され、していなければ翌月まで止まる。手で打つ対話の Claude Code は
// 今までどおりサブスクの枠。
//
// BuzzAssist が `claude -p` を起動するのは次の3つ（2026-09-27 に rg で洗い出した）:
//   - scripts/harness-parallel-agents.mjs（LLM 判断の並列実行。既定のエンジン選びは codex が先）
//   - lib/skillEvals.mjs（scripts/skill-evals.mjs の run --execute。実行者と採点者）
//   - scripts/harness-parallel-run.mjs の計画に、command が claude で -p / --print を付けたジョブがあるとき
// ここは文面と「1回だけ出す」仕組みだけを持つ。起動の判断は呼ぶ側が決める（既定のエンジン選びは変えない）。

export const CLAUDE_AUTOMATION_BILLING_SINCE = "2026-06-15";

/** 課金の仕組みを1文で。計画の出力と注意の両方に使う。 */
export const CLAUDE_AUTOMATION_BILLING_SUMMARY =
  `${CLAUDE_AUTOMATION_BILLING_SINCE} から、claude -p（Claude Agent SDK を含む自動実行）はサブスクリプションの利用枠ではなく、`
  + "別の月額クレジットから引かれる（API と同じ価格・繰り越しなし。使い切ると、追加課金を有効にしていれば API の価格で請求、"
  + "していなければ翌月まで止まる）";

function launchesLabel(plannedLaunches) {
  if (plannedLaunches === null || plannedLaunches === undefined) return "";
  if (typeof plannedLaunches === "string") return plannedLaunches;
  const count = Number(plannedLaunches);
  return Number.isFinite(count) ? `${count} 回` : "";
}

/**
 * 計画・dry-run に載せる1行。起動の見込みが 0 回なら空文字（載せない）。
 * plannedLaunches は数か、条件つきの説明（「codex が使えなければ最大 N 回」など）。
 */
export function claudeAutomationPlanLine(plannedLaunches) {
  if (plannedLaunches === 0 || plannedLaunches === "0") return "";
  const label = launchesLabel(plannedLaunches);
  return `claude -p の起動見込み: ${label || "不明"}。${CLAUDE_AUTOMATION_BILLING_SUMMARY}`;
}

/**
 * 起動の直前に出す注意の本文（複数行）。
 * alternative には「codex で足りるなら --engine codex」のような、claude を使わずに済ませる方法を渡す。
 */
export function claudeAutomationBillingNotice({ plannedLaunches = null, purpose = "", alternative = "" } = {}) {
  const label = launchesLabel(plannedLaunches);
  const lines = [
    `[課金の注意] ${purpose ? `${purpose}で ` : ""}claude -p を起動します${label ? `（見込み ${label}）` : ""}。`,
    `  ${CLAUDE_AUTOMATION_BILLING_SUMMARY}。`,
    "  手で打つ対話の Claude Code は今までどおりサブスクの枠です。",
  ];
  if (alternative) lines.push(`  ${alternative}`);
  return `${lines.join("\n")}\n`;
}

/**
 * 注意を1回だけ出す係。最初の notify だけが書き、2回目以降は何もしない（戻り値 false）。
 * write の既定は標準エラー（標準出力の JSON や結果を汚さない）。
 */
export function createClaudeLaunchNotifier({ write = (text) => process.stderr.write(text) } = {}) {
  let shown = false;
  return {
    notify(options = {}) {
      if (shown) return false;
      shown = true;
      try {
        write(claudeAutomationBillingNotice(options));
      } catch {
        // 表示の失敗で起動の判断を変えない
      }
      return true;
    },
    get shown() {
      return shown;
    },
  };
}

// プロセスの中で1つ。CLI が別の係を渡さなかったときに使う。
const processNotifier = createClaudeLaunchNotifier();

/** プロセスで1回だけ、標準エラーへ注意を出す（CLI が係を渡さなかったときの既定）。 */
export function notifyClaudeLaunchOnce(options = {}) {
  return processNotifier.notify(options);
}

const CLAUDE_COMMAND = /(?:^|[\\/])claude(?:\.(?:cmd|exe|bat))?$/iu;

/** 計画のジョブが claude を非対話（-p / --print）で直接起動するか。 */
export function isClaudePrintInvocation(command, args = []) {
  if (!CLAUDE_COMMAND.test(String(command ?? "").trim())) return false;
  return (Array.isArray(args) ? args : []).some((arg) => arg === "-p" || arg === "--print" || /^--print=/u.test(String(arg)));
}
