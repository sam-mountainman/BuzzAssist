import test from "node:test";
import assert from "node:assert/strict";

import {
  buildChannelArtStylePromptLines,
  buildDefaultStatePrecedence,
  buildRegisteredCharacterPromptLines,
  readApprovedRegisteredCharacter,
  registeredCharacterAsset,
  registeredCharacterTextAuthority,
} from "../lib/characterRenderDirectives.mjs";

// この共有層は特定チャンネルを知らないので、フィクスチャも架空のものにする。
// 実物の欠陥（雰囲気の形容が体型の不変条件に勝つ）と同じ形だけを再現する。
const registry = {
  characters: [
    {
      id: "cast-a",
      name: "Cast A",
      status: "approved",
      description: "An adult woman with a relaxed seductive adult expression and a hint of loose sexiness; petite and short with a small frame and a modest bust; holds a small cup.",
      invariants: [
        "petite short build with compact six-heads-tall proportions and modest bust",
        "closed-arc slit eyes as default expression",
        "petite short build with compact six-heads-tall proportions and modest bust",
      ],
      negativePrompt: "no large bust, no tall stature, no open wide eyes as default",
      referenceAssets: [
        { role: "identity-face", path: "assets/cast-a/face.png" },
        { role: "eye-open", path: "/abs/cast-a/eye-open.png" },
      ],
    },
    { id: "cast-b", name: "Cast B", status: "draft", description: "Not approved yet." },
  ],
};

test("only approved registered characters resolve", () => {
  assert.equal(readApprovedRegisteredCharacter(registry, "cast-a").id, "cast-a");
  assert.throws(() => readApprovedRegisteredCharacter(registry, "cast-b"), /No approved registered character/u);
  assert.throws(() => readApprovedRegisteredCharacter(registry, "missing"), /No approved registered character/u);
  assert.throws(() => readApprovedRegisteredCharacter({}, "cast-a"), /no characters array/u);
});

test("reference assets resolve relative to a base dir and keep absolute paths", () => {
  const cast = readApprovedRegisteredCharacter(registry, "cast-a");
  assert.equal(registeredCharacterAsset(cast, "identity-face", { baseDir: "/canvas" }), "/canvas/assets/cast-a/face.png");
  assert.equal(registeredCharacterAsset(cast, "eye-open", { baseDir: "/canvas" }), "/abs/cast-a/eye-open.png");
  assert.throws(() => registeredCharacterAsset(cast, "turnaround", { baseDir: "/canvas" }), /No turnaround reference asset/u);
});

test("the approved text is carried through verbatim, deduped, and never paraphrased", () => {
  const cast = readApprovedRegisteredCharacter(registry, "cast-a");
  const authority = registeredCharacterTextAuthority(cast);
  assert.equal(authority.description, cast.description);
  assert.equal(authority.negativePrompt, cast.negativePrompt);
  // 重複した不変条件は1回だけ。文言そのものは書き換えない。
  assert.deepEqual(authority.invariants, [
    "petite short build with compact six-heads-tall proportions and modest bust",
    "closed-arc slit eyes as default expression",
  ]);
});

test("prompt lines reach the model with the body clauses AND an explicit precedence over mood adjectives", () => {
  const cast = readApprovedRegisteredCharacter(registry, "cast-a");
  const text = buildRegisteredCharacterPromptLines(cast).join("\n");

  // 1) 実際の欠陥: 体型と胸の節がプロンプトから丸ごと落ちていた。
  assert.match(text, /modest bust/u);
  assert.match(text, /six-heads-tall/u);
  // 2) 承認済みの否定語も届いていなかった。
  assert.match(text, /no large bust/u);
  // 3) 承認済みの説明文は削らない。矛盾する形容もそのまま残す。
  assert.match(text, /relaxed seductive adult expression/u);
  // 4) そのうえで順位を明示する。これが lib/characterPipeline.mjs の
  //    STANCE PRECEDENCE と同じ解き方。
  assert.match(text, /REGISTRY PRECEDENCE/u);
  assert.match(text, /ADJECTIVES NEVER CHANGE THE BODY/u);
  assert.match(text, /REFERENCE SHEET PRECEDENCE/u);
  assert.match(text, /SCENE DIRECTION PRECEDENCE/u);
  // 5) 不変条件は番号付きで、各節が独立の要求だと言い切る。
  assert.match(text, /\(1\) petite short build/u);
  assert.match(text, /\(2\) closed-arc slit eyes/u);
  assert.match(text, /FINAL CHECK BEFORE YOU FINISH/u);
});

test("a character with no description is a hard failure, not a silently empty prompt", () => {
  assert.throws(
    () => buildRegisteredCharacterPromptLines({ id: "cast-c", status: "approved" }),
    /has no description/u,
  );
});

test("default-state precedence says the default is in force, or that a deviation is deliberate", () => {
  const asDefault = buildDefaultStatePrecedence({
    label: "eye state",
    defaultSummary: "closed-arc slit eyes, with a wide-open eye kept as a rare trump card",
    selectedDirective: "BOTH eyes are closed-arc slits.",
    isDefault: true,
  });
  assert.match(asDefault, /DEFAULT-STATE PRECEDENCE — EYE STATE/u);
  assert.match(asDefault, /RARE EXCEPTION that is NOT in force here/u);

  const asDeviation = buildDefaultStatePrecedence({
    label: "eye state",
    defaultSummary: "closed-arc slit eyes, with a wide-open eye kept as a rare trump card",
    selectedDirective: "ONE eye is thrown wide open.",
    isDefault: false,
  });
  assert.match(asDeviation, /deliberate, explicitly chosen departure/u);
  assert.match(asDeviation, /changes the eye state and NOTHING else/u);

  assert.throws(() => buildDefaultStatePrecedence({ label: "eye state" }), /needs label, defaultSummary and selectedDirective/u);
});

test("the channel art style is read from a declaration, never invented here", () => {
  const declaration = {
    id: "example-style-v1",
    medium: "clean 2D drawn artwork",
    sharedIdiom: ["Thin uniform contours."],
    characterIdiom: ["flat pale skin"],
    environmentIdiom: ["Backgrounds stay quieter than characters."],
    forbidden: ["photoreal rendering"],
  };
  const withEnvironment = buildChannelArtStylePromptLines(declaration).join("\n");
  assert.match(withEnvironment, /example-style-v1/u);
  assert.match(withEnvironment, /clean 2D drawn artwork/u);
  assert.match(withEnvironment, /Backgrounds stay quieter than characters\./u);
  assert.match(withEnvironment, /NEVER: photoreal rendering\./u);

  const characterOnly = buildChannelArtStylePromptLines(declaration, { includeEnvironment: false }).join("\n");
  assert.doesNotMatch(characterOnly, /Backgrounds stay quieter/u);
  assert.match(characterOnly, /Characters are drawn with flat pale skin\./u);

  assert.throws(() => buildChannelArtStylePromptLines({ id: "x" }), /no medium sentence/u);
});
