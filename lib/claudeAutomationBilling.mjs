// `claude -p`（Claude Code の非対話の実行）で子エージェントを起動する前の、利用枠の注意。
//
// `claude -p`・Claude Agent SDK での自動実行は、対話の Claude Code と同じ契約の利用枠から引かれる。
// 2026-06-15 から別の月額クレジットへ切り替えると予告されていたが、その変更は 2026-06-15 に止められた。
// 2026-10-07 の更新で、Max と Team には月次の API クレジットも付いた（Agent SDK・claude -p・API に使える）。
// 出典は CLAUDE_AUTOMATION_BILLING_SOURCE の公式案内（確かめた日は CLAUDE_AUTOMATION_BILLING_CHECKED_AT）。
//
// 2026-09-27 に「6/15 から別課金」と書いて配ったが、予告の時点の記事を確かめずに使った誤りだった
// （2026-10-09 に公式案内で確かめて直した）。課金の前提を変えるときは、公式案内の最新の更新日を先に確かめる。
//
// 注意を出す理由は今も残る: 子を多く並べると、対話の作業と同じ利用枠を短い時間で使い切る。
//
// BuzzAssist が `claude -p` を起動するのは次の3つ（2026-09-27 に rg で洗い出した）:
//   - scripts/harness-parallel-agents.mjs（LLM 判断の並列実行。既定のエンジン選びは codex が先）
//   - lib/skillEvals.mjs（scripts/skill-evals.mjs の run --execute。実行者と採点者）
//   - scripts/harness-parallel-run.mjs の計画に、command が claude で -p / --print を付けたジョブがあるとき
// ここは文面と「1回だけ出す」仕組みだけを持つ。起動の判断は呼ぶ側が決める（既定のエンジン選びは変えない）。

/** 課金の扱いを確かめた公式案内と、その更新日。 */
export const CLAUDE_AUTOMATION_BILLING_SOURCE = "https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan";
export const CLAUDE_AUTOMATION_BILLING_CHECKED_AT = "2026-10-07";

/** 利用枠の扱いを1文で。計画の出力と注意の両方に使う。 */
export const CLAUDE_AUTOMATION_BILLING_SUMMARY =
  "claude -p（Claude Agent SDK を含む自動実行）は、対話の Claude Code と同じ契約の利用枠から引かれる"
  + `（${CLAUDE_AUTOMATION_BILLING_CHECKED_AT} 時点の公式案内。予告されていた別課金への切り替えは止められ、Max・Team には月次の API クレジットも付く）。`
  + "多く並べると、その枠を短い時間で使い切り、対話の作業も止まる";

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
    `[利用枠の注意] ${purpose ? `${purpose}で ` : ""}claude -p を起動します${label ? `（見込み ${label}）` : ""}。`,
    `  ${CLAUDE_AUTOMATION_BILLING_SUMMARY}。`,
    `  出典: ${CLAUDE_AUTOMATION_BILLING_SOURCE}`,
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
