// 子エージェントは学習を書かない、を環境変数1つで伝えるための置き場。
//
// scripts/harness-parallel-agents.mjs は同じタスク定義を複数の CLI エージェントへ
// 同時に投げる。子がそれぞれ harness-learn で capture / sync すると:
//
//   - 同じ台帳・同じ overlay へ並列に書き、共有状態ファイルの競合になる
//   - 同じ観測が子の数だけ別 session として数えられ、繰り返し回数が水増しされる
//   - 子の観測はまだ親が確かめていない。確かめていないものを台帳へ積むと、
//     学習が「自分で自分に合格を出す」側へ寄る
//
// だから子の環境には印を渡し、harness-learn の書き込み系はその印を見て拒否する。
// 子は捕捉したい内容を結果本文に書いて親へ返し、親がまとめて capture する。

export const LEARNING_WRITE_FORBIDDEN_ENV = "BUZZASSIST_LEARNING_WRITE_FORBIDDEN";

/** 子エージェントを起動するときの環境。親の環境を引き継ぎ、印だけを足す。 */
export function childAgentEnvironment(env = process.env) {
  return { ...env, [LEARNING_WRITE_FORBIDDEN_ENV]: "child-agent" };
}

/** 印が立っているか。空文字と "0" は立っていないとみなす（明示の解除だけを許す）。 */
export function learningWritesForbidden(env = process.env) {
  const value = String(env?.[LEARNING_WRITE_FORBIDDEN_ENV] ?? "").trim();
  return value !== "" && value !== "0";
}

export function learningWriteRefusalMessage(action = "書き込み") {
  return `子エージェントからは学習を書きません（${LEARNING_WRITE_FORBIDDEN_ENV} が立っています。操作: ${action}）。`
    + "捕捉したい指摘や実測の事実は結果本文に書いて親へ返してください。親が確かめてから capture します。"
    + "子が並列に書くと、同じ台帳の取り合いになり、同じ観測が子の数だけ別の回数として数えられます。";
}

export function assertLearningWriteAllowed(env = process.env, action = "書き込み") {
  if (learningWritesForbidden(env)) {
    const error = new Error(learningWriteRefusalMessage(action));
    error.code = "LEARNING_WRITE_FORBIDDEN_IN_CHILD_AGENT";
    throw error;
  }
}
