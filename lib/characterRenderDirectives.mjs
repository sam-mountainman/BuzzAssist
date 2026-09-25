// 登録済みキャラクターの承認済み文章を、そのまま画像プロンプトへ届けるための共通層。
//
// なぜ要るか（この層が無かったあいだに起きたこと）:
//   1枚物の生成スクリプトは characters.json を「参照画像のパスを引くため」だけに開き、
//   description / invariants / negativePrompt は一度も読まずに、人手で短く打ち直した
//   キャラクター説明を JS の文字列定数として持っていた。打ち直しの過程で
//   体型と胸の指定が丸ごと落ち、承認済みの否定語（large bust 等）は一度も
//   モデルへ届かなかった。「書いてあるのに絵に出ない」の原因は、モデルの
//   無視ではなく、そもそも送っていないこと。
//
//   さらに、送っていた場合でも負けることがある。承認済みの説明文は
//   人格や雰囲気の形容（"relaxed seductive adult expression" のような）を
//   含むことがあり、それが体型の不変条件と同じ平面に並ぶと、画像モデルは
//   雰囲気の形容を体つきで表現しにいく。lib/characterPipeline.mjs の
//   STANCE PRECEDENCE が姿勢について解いたのと同じ問題なので、同じ形で解く：
//   承認済みの文章は消さず、順位を明示する。
//
// この層はチャンネルにもキャストにも依存しない。特定チャンネルの文章・名前・
// 画風はここに書かず、Channel Pack と登録簿から読むだけにすること。
export const CHARACTER_RENDER_DIRECTIVES_VERSION = "character-render-directives-v1";

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function uniqueLines(value, limit = 40) {
  const list = (Array.isArray(value) ? value : []).map(nonEmpty).filter(Boolean);
  return [...new Set(list)].slice(0, limit);
}

/**
 * 登録簿から承認済みキャラクターを引く。承認されていないものは返さない。
 */
export function readApprovedRegisteredCharacter(registry, characterId) {
  const characters = Array.isArray(registry) ? registry : registry?.characters;
  if (!Array.isArray(characters)) throw new Error("Character registry has no characters array.");
  const id = nonEmpty(characterId);
  const character = characters.find((entry) => entry?.id === id && entry?.status === "approved");
  if (!character) throw new Error(`No approved registered character: ${id || "(missing id)"}`);
  return character;
}

/**
 * 登録簿の参照アセットを role で引く。
 */
export function registeredCharacterAsset(character, role, options = {}) {
  const wanted = nonEmpty(role);
  const asset = (character?.referenceAssets || []).find((entry) => entry?.role === wanted);
  if (!asset) throw new Error(`No ${wanted || "(missing role)"} reference asset for ${character?.id || "(unknown)"}`);
  const path = nonEmpty(asset.path);
  if (!path) throw new Error(`Reference asset ${wanted} for ${character?.id} has no path.`);
  const baseDir = nonEmpty(options.baseDir);
  if (path.startsWith("/") || !baseDir) return path;
  return `${baseDir.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

/**
 * 承認済みの三点（説明・不変条件・禁止）をそのまま取り出す。
 * ここで書き換えないのが要点。クライアント承認済みの文章を、
 * 生成器の都合で要約したり言い換えたりしない。
 */
export function registeredCharacterTextAuthority(character) {
  const description = nonEmpty(character?.description);
  if (!description) throw new Error(`Registered character ${character?.id || "(unknown)"} has no description.`);
  return {
    id: nonEmpty(character?.id),
    name: nonEmpty(character?.name) || nonEmpty(character?.id),
    description,
    invariants: uniqueLines(character?.invariants),
    negativePrompt: nonEmpty(character?.negativePrompt),
  };
}

/**
 * 既定状態（目つき・口元・持ち物など）の順位を明示する一段落を作る。
 *
 * 「基本は X、Y はレアな切り札」という登録簿の宣言は、選択肢表のほうが
 * 全案 Y になっていると事実上無効になる。既定を選んだ回では「他所に
 * 出てくる別状態の記述は、ここでは発動していない例外だ」と言い切り、
 * 逸脱を選んだ回では「これは1枚だけの意図的な逸脱で、他は何も変えない」
 * と言い切る。どちらの文章もチャンネル固有語を含まない。
 */
export function buildDefaultStatePrecedence(state) {
  const label = nonEmpty(state?.label);
  const defaultSummary = nonEmpty(state?.defaultSummary);
  const selectedDirective = nonEmpty(state?.selectedDirective);
  if (!label || !defaultSummary || !selectedDirective) {
    throw new Error("A default-state precedence needs label, defaultSummary and selectedDirective.");
  }
  const isDefault = state?.isDefault === true;
  return [
    `DEFAULT-STATE PRECEDENCE — ${label.toUpperCase()}: the approved registry declares this character's DEFAULT ${label} to be ${defaultSummary}. For this single render the ${label} is: ${selectedDirective}`,
    isDefault
      ? `This render uses the declared default. Any phrase elsewhere in this prompt, and anything in the supplied reference sheets, that shows a different ${label} is describing a RARE EXCEPTION that is NOT in force here. Draw the default ${label}.`
      : `This render is a deliberate, explicitly chosen departure from the declared default, approved for this one image only. It changes the ${label} and NOTHING else: every other registered trait stays exactly as the numbered clauses below require.`,
  ].join(" ");
}

/**
 * 承認済み文章 + 順位宣言をプロンプト行として組み立てる。
 *
 * 返すのは行の配列。呼び出し側が自分の並び順に差し込めるようにする。
 */
export function buildRegisteredCharacterPromptLines(character, options = {}) {
  const authority = registeredCharacterTextAuthority(character);
  const referenceNote = nonEmpty(options.referenceNote);
  const defaultStates = (Array.isArray(options.defaultStates) ? options.defaultStates : []).map(buildDefaultStatePrecedence);
  const displayName = nonEmpty(options.displayName) || authority.name;

  const numbered = authority.invariants.map((clause, index) => `(${index + 1}) ${clause}`);

  const lines = [
    `APPROVED REGISTRY TEXT FOR ${displayName} — quoted verbatim from the approved character registry, not paraphrased: ${authority.description}`,
    numbered.length > 0
      ? `MUST PRESERVE — each numbered clause is a separate hard requirement, and every one of them must be visibly satisfied in the finished drawing: ${numbered.join(" ")}`
      : "",
    authority.negativePrompt ? `FORBIDDEN — none of the following may appear: ${authority.negativePrompt}.` : "",
    // lib/characterPipeline.mjs の STANCE PRECEDENCE と同じ形。承認済みの
    // 文章を削らずに、どれがどれに勝つかだけを言う。
    "REGISTRY PRECEDENCE: the numbered MUST-PRESERVE clauses and the FORBIDDEN list outrank every other sentence in this prompt — including the free-text registry description quoted above, the framing, expression, background and composition directions written for this particular image, and the supplied reference sheets. Those other texts are authoritative for mood, staging, camera and scene; they are never authoritative for body proportion, height, head-count proportion, overall build, bust size, or how much of the body a garment covers.",
    "ADJECTIVES NEVER CHANGE THE BODY: where any descriptive or atmospheric word anywhere in this prompt — allure, sexiness, seductive, glamorous, mature, adult, cute, sultry, striking, star quality — would pull a proportion, a bust size, a neckline or a garment's coverage away from what a numbered clause states, the numbered clause wins without exception. Satisfy that adjective through the FACE, the GAZE, the POSTURE, the colour and the lighting only. Never through a larger bust, a deeper neckline, a longer leg, a taller frame or more exposed skin. Do not add cleavage, do not deepen a neckline, and do not add shading whose purpose is to emphasise a chest.",
    // 逆向きの譲歩も明示する。これを書かないと、登録簿の一文（「手に猪口を
    // 持つ」など）が、その1枚の演出指示（小道具なし・胸から上）を上書きする。
    // STANCE PRECEDENCE が「持ち物は姿勢規則に譲る」と書いたのと同じ形。
    "SCENE DIRECTION PRECEDENCE — the other direction: the registry texts are authoritative for WHO this character is and WHAT she wears. They are never authoritative for what THIS PARTICULAR image contains as a scene: the camera, the crop, the background, the pose, and which props are present are set by this render's own directions. When a registry sentence names a held prop, a garment or a body part that this render's framing or prop direction excludes, satisfy it by keeping the identity and the wardrobe exactly and following this render's direction for the scene.",
    "REFERENCE SHEET PRECEDENCE: the supplied reference sheets are evidence of IDENTITY — face, hair, colour, markings, garment design. A sheet is never evidence that a trait a numbered clause forbids has become acceptable. Where a sheet disagrees with a numbered clause or with the FORBIDDEN list, the clause wins: redraw that part of the figure to match the clause and keep everything else from the sheet.",
    ...defaultStates,
    referenceNote,
    numbered.length > 0
      ? `FINAL CHECK BEFORE YOU FINISH: walk the numbered clauses in order and confirm the drawing satisfies each one by looking at what you actually drew. Clauses about height, head-count proportion, frame size and bust size are checked against the drawn body, not against your intention for the character.`
      : "",
  ];
  return lines.filter(Boolean);
}

/**
 * チャンネルの画風宣言（Channel Pack 側）を、そのままプロンプト行にする。
 * 文章は宣言から取るだけで、この層は特定チャンネルの画風を知らない。
 */
export function buildChannelArtStylePromptLines(artStyle, options = {}) {
  const medium = nonEmpty(artStyle?.medium);
  if (!medium) throw new Error("Channel art style declaration has no medium sentence.");
  const shared = uniqueLines(artStyle?.sharedIdiom);
  const character = uniqueLines(artStyle?.characterIdiom);
  const environment = uniqueLines(artStyle?.environmentIdiom);
  const forbidden = uniqueLines(artStyle?.forbidden);
  const includeEnvironment = options.includeEnvironment !== false;
  // 人物を描かない板（人物なしの背景アトラス）では人物の描き方を渡さない。
  const includeCharacter = options.includeCharacter !== false;
  const styleId = nonEmpty(artStyle?.id);
  return [
    `CHANNEL ART STYLE${styleId ? ` (${styleId})` : ""} — this is the single declared art style for the whole channel; every asset is drawn in it: ${medium}.`,
    ...shared,
    includeCharacter && character.length > 0 ? `Characters are drawn with ${character.join(", ")}.` : "",
    includeEnvironment && environment.length > 0 ? environment.join(" ") : "",
    forbidden.length > 0 ? `NEVER: ${forbidden.join("; ")}.` : "",
  ].filter(Boolean);
}
