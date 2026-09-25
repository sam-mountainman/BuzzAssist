// 学習の宛先に関する定義を、harness-learn・feedback bundle・Canvas feedback・
// Receipt からの自動捕捉が**同じもの**を読むための置き場。
//
// 以前は旧名 → 新名の対応表が scripts/harness-learn.mjs と
// lib/harnessFeedbackBundle.mjs に別々に書かれていた。片方だけ直すと、
// 同じ提案が harness-learn では genre: に数えられ、feedback bundle では
// 別の宛先に見える（あるいはその逆）という食い違いが起きる。
// 宛先の定義を2か所に持つと片方だけ古くなる——このリポジトリで何度も見た形。
//
// ここはコードから読む定数だけを置く。宛先そのもの（正本・overlay・方式）は
// 従来どおり docs/learning/targets.json が持つ。

/**
 * 宛先の名前空間を platform: / genre: / channel-pack: の3層へ変える前の旧名。
 *
 * 提案IDは kind+target+text から作るので、**記録済みの target 文字列は書き換えない**
 * （書き換えると ID が変わり、過去の apply 記録と結び付かなくなる）。翻訳は読むとき
 * だけに留める。
 */
export const LEARNING_TARGET_ALIASES = Object.freeze({
  "skill:manga-video-production": "genre:manga-video-production",
  "skill:manga-page-camera": "genre:manga-page-camera",
  "skill:harness-parallel-execution": "platform:harness-parallel-execution",
  "skill:harness-self-improvement": "platform:harness-self-improvement",
  "ledger:koya": "channel-pack:koya",
  "doc:mike-audio-gates": "channel-pack:narrated-story",
});

/** 旧名なら新名へ、それ以外はそのまま返す。未知の名前を推測で別の宛先へ寄せない。 */
export function resolveLearningTarget(target) {
  const value = String(target ?? "");
  return Object.hasOwn(LEARNING_TARGET_ALIASES, value) ? LEARNING_TARGET_ALIASES[value] : value;
}

/**
 * Harness ごとに、自動経路（Canvas feedback・Receipt 捕捉）が既定で書いてよい宛先。
 *
 * 既定は Channel Pack 宛。自動で拾ったものはまず運営者専用の非公開台帳へ置き、
 * genre / platform へ一般化するのは人が target を明示したときだけにする
 * （推測でチャンネル固有の観測を共有層へ持ち上げない）。
 */
export const HARNESS_LEARNING_ROUTES = Object.freeze({
  "koya-manga-video": Object.freeze({
    channel: "channel-pack:koya",
    genres: Object.freeze([
      "genre:manga-video-production",
      "genre:manga-page-camera",
    ]),
  }),
  "narrated-story-video": Object.freeze({
    channel: "channel-pack:narrated-story",
    genres: Object.freeze(["genre:narrated-story-video"]),
  }),
});

/**
 * 台本の品質ループ（lib/scriptQualityLoop.mjs）のジャンルごとに、台本の直し・訂正と、不合格の回から
 * 自動で拾った候補を積む宛先。動画の Channel Pack 宛（channel-pack:narrated-story）とは宛先を分け、
 * 台帳の置き場（非公開）は同じにする。台本の型を直す人が、台本の話だけを読めるようにするため。
 */
export const SCRIPT_LEARNING_ROUTES = Object.freeze({
  "narrated-story": "channel-pack:narrated-story-script",
});

/** 自動経路が platform 層として受け付ける宛先。 */
export const PLATFORM_LEARNING_TARGETS = Object.freeze([
  "platform:platform-craft",
  "platform:harness-parallel-execution",
  "platform:harness-self-improvement",
]);
