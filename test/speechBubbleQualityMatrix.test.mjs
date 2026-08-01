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
    assert.ok(bounds.width / 1280 >= 0.085 && bounds.width / 1280 <= 0.131, text);
    assert.ok(bounds.height / 720 >= 0.20 && bounds.height / 720 <= 0.341, text);
    assert.equal(result.quality[0].overflow, false, text);
    assert.equal(result.quality[0].textLoss, false, text);
  }
});

test("five explicit semantic columns are never truncated even in a deliberately tight box", () => {
  const columns = ["信用して", "来てくれた", "お客様を", "裏切るのは", "許されない"];
  const result = renderSpeechBubbleSvg({
    width: 1280,
    height: 720,
    bubbles: [{
      id: "five-columns",
      columns,
      bounds: { x: 0.70, y: 0.08, width: 0.15, height: 0.42 },
      target: { x: 0.82, y: 0.26 },
    }],
  });
  const quality = result.quality[0];
  assert.equal(quality.columns, 5);
  assert.equal(quality.inputCharacterCount, columns.join("").length);
  assert.equal(quality.renderedCharacterCount, columns.join("").length);
  assert.equal(quality.textLoss, false);
  assert.equal(quality.overflow, true, "tight boxes should fail visibly instead of dropping dialogue");
  for (const column of columns) assert.match(result.svg, new RegExp(`>${column}</tspan>`));
});

test("more than six explicit columns fail with an actionable split instruction", () => {
  assert.throws(() => renderSpeechBubbleSvg({
    width: 1280,
    height: 720,
    bubbles: [{ columns: ["一", "二", "三", "四", "五", "六", "七"] }],
  }), /Split it into another bubble so no dialogue is lost/);
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
    assert.ok(bounds.width / width >= 0.17 && bounds.width / width <= 0.19);
    assert.ok(bounds.height / height >= 0.65 && bounds.height / height <= 0.72);
  }
});

test("shout preset uses eight broad spikes like the reference video", () => {
  const result = renderSpeechBubbleSvg({
    width: 1280,
    height: 720,
    bubbles: [{ id: "shout", preset: "shout", text: "同じ被害を受けて\n客足は遠のくわ", target: { x: 0.74, y: 0.28 } }],
  });
  const shoutGroup = result.svg.match(/<g id="shout"[\s\S]*?<\/g>/)?.[0] ?? "";
  assert.equal((shoutGroup.match(/ L /g) || []).length, 15);
  assert.match(shoutGroup, /font-weight="800"/);
  assert.equal(result.quality[0].textLoss, false);
});

test("all four presets pass the no-loss readability gate", () => {
  const cases = [
    { preset: "dialogue", text: "約束は守ってください" },
    { preset: "shout", text: "ふざけるな！" },
    { preset: "thought", text: "そういうことか…" },
    { preset: "narration", text: "その日の夜、事態は動き始めた" },
  ];
  for (const entry of cases) {
    const result = renderSpeechBubbleSvg({ width: 1280, height: 720, bubbles: [entry] });
    assert.equal(result.quality[0].textLoss, false, entry.preset);
    assert.equal(result.quality[0].tooSmall, false, entry.preset);
    assert.ok(result.quality[0].fontSize >= 720 * 0.036, entry.preset);
  }
});
