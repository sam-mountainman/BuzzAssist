import test from "node:test";
import assert from "node:assert/strict";
import { getImageDimensionsFromBuffer } from "../lib/canvasScene.mjs";
import {
  buildBubbleAwareCompositionPrompt,
  planSpeechBubbleLayout,
  renderSpeechBubbleSvg,
} from "../lib/speechBubbleRenderer.mjs";

test("R5 locked-reference renderer uses Mincho type and one integrated curved tail path", () => {
  const result = renderSpeechBubbleSvg({
    width: 1672,
    height: 941,
    bubbles: [{
      id: "boss",
      text: "勝手な推測で私を疑うのか！",
      emphasis: "私を疑うのか！",
      accentColor: "#e53935",
      tail: true,
      target: { x: 0.67, y: 0.24 },
      bounds: { x: 0.72, y: 0.20, width: 0.22, height: 0.66 },
    }],
  });

  assert.match(result.svg, /writing-mode="vertical-rl"/);
  assert.match(result.svg, /Hiragino Mincho ProN/);
  assert.match(result.svg, /data-profile="reference-video-locked-v2"/);
  assert.match(result.svg, /font-weight="600"/);
  assert.match(result.svg, /data-tail="integrated"/);
  assert.match(result.svg, /<path d="M [^"]+ Q [^"]+" fill="#ffffff" stroke="#111111"/);
  assert.equal((result.svg.match(/<path /g) || []).length, 1);
  assert.match(result.svg, /fill="#e53935"/);
  assert.equal(result.quality[0].overflow, false);
  assert.equal(result.quality[0].faceOverlapRatio, 0);
  assert.ok(result.quality[0].tailLengthRatio <= 0.0521);
  assert.deepEqual(result.exportStrategy.nativeDependencies, []);
  assert.equal(result.exportStrategy.transparent, true);
});

test("reference-video profile defaults to a clean no-tail ellipse", () => {
  const result = renderSpeechBubbleSvg({
    width: 1672,
    height: 941,
    bubbles: [{ text: "約束は守ってください", target: { x: 0.20, y: 0.28 } }],
  });
  assert.match(result.svg, /data-tail="none"/);
  assert.doesNotMatch(result.svg, / Q /);
  assert.doesNotMatch(result.svg, /fill="#e53935"/);
});

test("locked reference profile preserves semantic newlines as video-style vertical columns", () => {
  const result = renderSpeechBubbleSvg({
    width: 1280,
    height: 720,
    bubbles: [{
      text: "標高が高いところは\n肌寒いね。大丈夫？",
      target: { x: 0.75, y: 0.25 },
    }],
  });

  const bounds = result.plan.bubbles[0].bounds;
  assert.equal(result.profile.id, "reference-video-locked-v2");
  assert.equal(result.quality[0].columns, 2);
  assert.equal(result.quality[0].overflow, false);
  assert.ok(bounds.width / 1280 >= 0.13 && bounds.width / 1280 <= 0.15);
  assert.ok(bounds.height / 720 >= 0.49 && bounds.height / 720 <= 0.56);
  assert.match(result.svg, />標高が高いところは<\/tspan>/);
  assert.match(result.svg, />肌寒いね。大丈夫？<\/tspan>/);
});

test("three semantic columns reproduce the measured long-dialogue proportions", () => {
  const result = renderSpeechBubbleSvg({
    width: 1280,
    height: 720,
    bubbles: [{
      text: "欲張りプレート…\n何かと思えば\n大人向けのお子様ランチ？",
      target: { x: 0.78, y: 0.30 },
    }],
  });

  const bounds = result.plan.bubbles[0].bounds;
  assert.equal(result.quality[0].columns, 3);
  assert.ok(bounds.width / 1280 >= 0.17 && bounds.width / 1280 <= 0.18);
  assert.ok(bounds.height / 720 >= 0.66 && bounds.height / 720 <= 0.69);
  assert.equal(result.quality[0].overflow, false);
});

test("long reference-style dialogue can expand beyond three vertical columns", () => {
  const result = renderSpeechBubbleSvg({
    width: 1672,
    height: 941,
    bubbles: [{
      id: "long-dialogue",
      text: "君は随分と絶望した顔をしているが本当に辛いのはこちらの店は当然約束を守っていると信用して食事に来たお客様だ",
      target: { x: 0.80, y: 0.32 },
      bounds: { x: 0.08, y: 0.10, width: 0.34, height: 0.72 },
    }],
  });

  assert.ok(result.quality[0].columns >= 4);
  assert.equal(result.quality[0].overflow, false);
  assert.ok(result.quality[0].frameCoverage < 0.26);
});

test("narration uses the square black-outline card seen in the references", () => {
  const result = renderSpeechBubbleSvg({
    width: 1672,
    height: 941,
    bubbles: [{
      id: "narration",
      preset: "narration",
      text: "人々の生活を全て知るなんて不可能で",
      target: { x: 0.80, y: 0.30 },
      bounds: { x: 0.76, y: 0.08, width: 0.18, height: 0.56 },
    }],
  });

  assert.match(result.svg, /data-preset="narration"/);
  assert.match(result.svg, /<path d="M [^"]+ H [^"]+ V [^"]+ H [^"]+ Z"[^>]+stroke="#111111"/);
  assert.doesNotMatch(result.svg, /stroke="#d9d9d9"/);
});

test("R5 placement moves away from protected face regions", () => {
  const result = planSpeechBubbleLayout({
    width: 1920,
    height: 1080,
    bubbles: [{ text: "この場所には置かないでください", target: { x: 0.82, y: 0.24 } }],
    avoidRegions: [{ x: 0.68, y: 0.04, width: 0.27, height: 0.43, kind: "face" }],
  });
  const bounds = result.bubbles[0].bounds;
  const face = { x: 1920 * 0.68, y: 1080 * 0.04, width: 1920 * 0.27, height: 1080 * 0.43 };
  const overlapWidth = Math.max(0, Math.min(bounds.x + bounds.width, face.x + face.width) - Math.max(bounds.x, face.x));
  const overlapHeight = Math.max(0, Math.min(bounds.y + bounds.height, face.y + face.height) - Math.max(bounds.y, face.y));
  assert.equal(overlapWidth * overlapHeight, 0);
});

test("cut-table speaker hints provide the mouth anchor without face-detection ML", () => {
  const result = planSpeechBubbleLayout({
    width: 1000,
    height: 600,
    bubbles: [{
      text: "それは違います",
      speakerHint: {
        facing: "left",
        faceBounds: { x: 0.70, y: 0.10, width: 0.16, height: 0.30 },
      },
    }],
  });
  assert.equal(Math.round(result.bubbles[0].target.x), 767);
  assert.equal(Math.round(result.bubbles[0].target.y), 184);
});

test("August scope exposes exactly the four reference-video presets", () => {
  for (const preset of ["dialogue", "shout", "thought", "narration"]) {
    const result = renderSpeechBubbleSvg({
      width: 1280,
      height: 720,
      bubbles: [{ id: preset, preset, text: "確認します", target: { x: 0.2, y: 0.3 } }],
    });
    assert.match(result.svg, new RegExp(`data-preset="${preset}"`));
  }
});

test("bubble-aware prompt requires composition space before artwork generation", () => {
  const prompt = buildBubbleAwareCompositionPrompt({ bubbles: [{ text: "a" }, { text: "b" }] });
  assert.match(prompt, /2 dialogue beats/);
  assert.match(prompt, /negative space/);
  assert.match(prompt, /do not draw balloons, tails, captions, or readable text/);
});

test("canvas image insertion reads SVG width and height", () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1672" height="941" viewBox="0 0 1672 941"></svg>');
  assert.deepEqual(getImageDimensionsFromBuffer(svg, "overlay.svg"), { width: 1672, height: 941 });
});
