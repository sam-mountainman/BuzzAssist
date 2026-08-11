import test from "node:test";
import assert from "node:assert/strict";
import { planSpeechBubbleLayout, renderSpeechBubbleSvg } from "../lib/speechBubbleRenderer.mjs";

function overlapArea(a, b) {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}

test("one-to-five-character replies use the compact reference-video silhouette", () => {
  for (const text of ["え？", "なぜ？", "本当か？"]) {
    const result = renderSpeechBubbleSvg({
      width: 1280,
      height: 720,
      bubbles: [{ id: text, text, target: { x: 0.78, y: 0.28 } }],
    });
    const bounds = result.plan.bubbles[0].bounds;
    assert.ok(bounds.width / 1280 >= 0.055 && bounds.width / 1280 <= 0.096, text);
    assert.ok(bounds.height / 720 >= 0.14 && bounds.height / 720 <= 0.301, text);
    assert.equal(result.quality[0].overflow, false, text);
    assert.equal(result.quality[0].textLoss, false, text);
  }
});

test("excess authoring line breaks reflow into a narrow three-column reference oval", () => {
  const text = "信用して\n来てくれた\nお客様を\n裏切るのは\n許されない";
  const result = renderSpeechBubbleSvg({
    width: 1672,
    height: 941,
    bubbles: [{
      id: "reflowed-dialogue",
      text,
      target: { x: 0.82, y: 0.26 },
    }],
  });
  const quality = result.quality[0];
  const bounds = result.plan.bubbles[0].bounds;
  assert.equal(quality.columns, 3);
  assert.equal(quality.inputCharacterCount, text.replace(/\s/g, "").length);
  assert.equal(quality.renderedCharacterCount, text.replace(/\s/g, "").length);
  assert.equal(quality.textLoss, false);
  assert.equal(quality.overflow, false);
  assert.ok(bounds.width / 1672 <= 0.19);
  assert.ok(bounds.height > bounds.width * 1.45);
  assert.ok(quality.fontSize >= 941 * 0.043);
});

test("more than three locked columns fail with a reference-video reflow instruction", () => {
  assert.throws(() => renderSpeechBubbleSvg({
    width: 1280,
    height: 720,
    bubbles: [{ columns: ["一列目", "二列目", "三列目", "四列目"] }],
  }), /Remove manual line breaks or split it into another bubble/);
});

test("two-speaker dialogue occupies separate outer zones and avoids protected faces", () => {
  const result = planSpeechBubbleLayout({
    width: 1672,
    height: 941,
    bubbles: [
      { id: "left-speaker", text: "この資料は確認しました", speakerPosition: "left" },
      { id: "right-speaker", text: "では次へ進めましょう", speakerPosition: "right" },
    ],
    avoidRegions: [
      { x: 0.12, y: 0.10, width: 0.20, height: 0.22, kind: "face" },
      { x: 0.68, y: 0.10, width: 0.20, height: 0.22, kind: "face" },
    ],
  });
  const [a, b] = result.bubbles.map((bubble) => bubble.bounds);
  assert.equal(overlapArea(a, b), 0);
  for (const bubble of result.bubbles) {
    for (const face of result.avoidRegions) assert.equal(overlapArea(bubble.bounds, face), 0);
  }
});

test("reference profile is resolution-stable at HD, source size, and Full HD", () => {
  for (const [width, height] of [[1280, 720], [1672, 941], [1920, 1080]]) {
    const result = renderSpeechBubbleSvg({
      width,
      height,
      bubbles: [{
        text: "元気にしてるか\n気になったの。\n私がいなくて寂しかったでしょ？",
        target: { x: 0.74, y: 0.25 },
      }],
    });
    const bounds = result.plan.bubbles[0].bounds;
    assert.equal(result.quality[0].columns, 3);
    assert.equal(result.quality[0].overflow, false);
    assert.equal(result.quality[0].textLoss, false);
    assert.ok(bounds.width / width >= 0.15 && bounds.width / width <= 0.19);
    assert.ok(bounds.height / height >= 0.59 && bounds.height / height <= 0.72);
  }
});

test("editorial presets keep distinct reference-video silhouettes at normal weight", () => {
  const expectedShapes = new Map([
    ["dialogue", "ellipse"],
    ["thought", "thought-radial"],
    ["shout", "shout-irregular"],
    ["panic", "panic-wavy"],
    ["tremble", "tremble-wavy"],
  ]);
  const renderedGroups = [];
  for (const [preset, shape] of expectedShapes) {
    const result = renderSpeechBubbleSvg({
      width: 1280,
      height: 720,
      bubbles: [{ id: preset, preset, text: "同じ被害を受けて客足は遠のくわ", bounds: { x: 0.70, y: 0.08, width: 0.18, height: 0.62 } }],
    });
    const group = result.svg.match(new RegExp(`<g id="${preset}"[\\s\\S]*?<\\/g>`))?.[0] ?? "";
    assert.match(group, new RegExp(`data-shape="${shape}"`));
    assert.match(group, /font-weight="400"/);
    assert.doesNotMatch(group, /font-weight="[5-9]00"/);
    renderedGroups.push(group);
  }
  assert.equal(new Set(renderedGroups).size, expectedShapes.size);
});

test("shout and tremble balloons use OpenCV-extracted reference contours", () => {
  const shout = renderSpeechBubbleSvg({
    width: 1672,
    height: 941,
    bubbles: [{
      id: "measured-shout",
      preset: "shout",
      text: "ちょっと待ってください。そんな決め方では納得できません！",
      bounds: { x: 0.405, y: 0.055, width: 0.18, height: 0.72 },
    }],
  });
  const tremble = renderSpeechBubbleSvg({
    width: 1672,
    height: 941,
    bubbles: [{
      id: "measured-tremble",
      preset: "tremble",
      text: "ご、ごごごごめんなさぁぁぁい！",
      bounds: { x: 0.45, y: 0.10, width: 0.15, height: 0.62 },
    }],
  });

  assert.match(shout.svg, /data-shape-template="reference-frame-32"/);
  assert.match(tremble.svg, /data-shape-template="reference-frame-37"/);
  assert.ok((shout.svg.match(/ L /g) || []).length >= 45);
  assert.ok((tremble.svg.match(/ L /g) || []).length >= 100);
  assert.doesNotMatch(shout.svg, / Q /);
});

test("reference-contour typography stays inside concave shoulders", () => {
  const result = renderSpeechBubbleSvg({
    width: 1672,
    height: 941,
    bubbles: [{
      id: "concave-safe",
      preset: "shout",
      text: "私は戻らない。あの写真は、祖母の最後の夏を撮った大切な記録なの",
      bounds: { x: 0.405, y: 0.055, width: 0.18, height: 0.72 },
    }],
  });
  const quality = result.quality[0];
  assert.equal(quality.shapeTemplateId, "reference-frame-32");
  assert.equal(quality.shapeContainmentPass, true);
  assert.ok(quality.shapeTextClearance >= quality.fontSize * 0.13);
  assert.equal(quality.overflow, false);
  assert.equal(quality.textLoss, false);
});

test("thought balloon uses the measured dense equal-arc radial ink ring", () => {
  const result = renderSpeechBubbleSvg({
    width: 1672,
    height: 941,
    bubbles: [{
      id: "measured-thought",
      preset: "thought",
      text: "……でも、もし静音が覚えていて、それを俺が破ってしまったら",
      bounds: { x: 0.18, y: 0.08, width: 0.18, height: 0.72 },
    }],
  });
  const group = result.svg.match(/<g id="measured-thought"[\s\S]*?<\/g>/)?.[0] ?? "";
  const radialPath = group.match(/<path d="([^"]+)" data-decoration="reference-frame-27-radial-ink"/)?.[1] ?? "";
  assert.match(group, /data-shape-template="reference-frame-27-radial-ink"/);
  assert.match(group, /data-decoration="reference-frame-27-radial-ink"/);
  assert.equal((radialPath.match(/M /g) || []).length, 160);
  assert.equal((radialPath.match(/L /g) || []).length, 160);
});

test("vertical punctuation and digits use upright Japanese video typography", () => {
  const result = renderSpeechBubbleSvg({
    width: 1672,
    height: 941,
    bubbles: [{ text: "2026年に『本当に？』と聞いたんです..." }],
  });
  assert.match(result.svg, /data-layout="explicit-vertical-glyph"/);
  assert.doesNotMatch(result.svg, /writing-mode=/);
  assert.match(result.svg, /２０２６年/);
  assert.match(result.svg, /︙/);
  assert.doesNotMatch(result.svg, />2026|\.\.\./);
});

test("all six presets pass the no-loss readability gate", () => {
  const cases = [
    { preset: "dialogue", text: "約束は守ってください" },
    { preset: "shout", text: "ふざけるな！" },
    { preset: "thought", text: "そういうことか…" },
    { preset: "panic", text: "ご、ごめんなさい！" },
    { preset: "tremble", text: "ご、ごごごめんなさぁぁぁい！" },
    { preset: "narration", text: "その日の夜、事態は動き始めた" },
  ];
  for (const entry of cases) {
    const result = renderSpeechBubbleSvg({ width: 1280, height: 720, bubbles: [entry] });
    assert.equal(result.quality[0].textLoss, false, entry.preset);
    assert.equal(result.quality[0].tooSmall, false, entry.preset);
    assert.ok(result.quality[0].fontSize >= 720 * 0.043, entry.preset);
  }
});
