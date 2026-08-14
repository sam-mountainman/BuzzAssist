import test from "node:test";
import assert from "node:assert/strict";
import { getImageDimensionsFromBuffer } from "../lib/canvasScene.mjs";
import {
  buildBubbleAwareCompositionPrompt,
  planSpeechBubbleLayout,
  REFERENCE_SEQUENCE_PLACEMENT_POLICY,
  renderSpeechBubbleSvg,
} from "../lib/speechBubbleRenderer.mjs";
import { buildCameraAwareBubblePlacement } from "../lib/mangaBubbleCameraPlacement.mjs";

test("R5 locked-reference renderer uses upright Mincho type and one integrated curved tail path", () => {
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

  assert.match(result.svg, /data-layout="explicit-vertical-glyph"/);
  assert.doesNotMatch(result.svg, /writing-mode=/);
  assert.match(result.svg, /Hiragino Mincho ProN/);
  assert.match(result.svg, /data-profile="reference-video-locked-v3"/);
  assert.match(result.svg, /font-weight="400"/);
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

test("locked reference profile treats script newlines as soft breaks", () => {
  const result = renderSpeechBubbleSvg({
    width: 1280,
    height: 720,
    bubbles: [{
      text: "標高が高いところは\n肌寒いね。大丈夫？",
      target: { x: 0.75, y: 0.25 },
    }],
  });

  const bounds = result.plan.bubbles[0].bounds;
  assert.equal(result.profile.id, "reference-video-locked-v3");
  assert.equal(result.quality[0].columns, 2);
  assert.equal(result.quality[0].overflow, false);
  assert.ok(bounds.width / 1280 >= 0.12 && bounds.width / 1280 <= 0.15);
  assert.ok(bounds.height / 720 >= 0.47 && bounds.height / 720 <= 0.62);
  assert.doesNotMatch(result.svg, /\n/);
  assert.equal(result.quality[0].inputCharacterCount, "標高が高いところは肌寒いね。大丈夫？".length);
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
  assert.ok(bounds.width / 1280 >= 0.15 && bounds.width / 1280 <= 0.19);
  assert.ok(bounds.height / 720 >= 0.48 && bounds.height / 720 <= 0.60);
  assert.equal(result.quality[0].overflow, false);
});

test("automatic Japanese columns avoid splitting a negative auxiliary from its phrase", () => {
  const result = renderSpeechBubbleSvg({
    width: 1672,
    height: 941,
    bubbles: [{
      preset: "narration",
      text: "時計は午後１０時。誰もいない営業部で、田中だけが契約書を直していた。",
      target: { x: 0.75, y: 0.25 },
    }],
  });

  assert.equal(result.quality[0].columns, 3);
  assert.equal(result.quality[0].textLoss, false);
  assert.ok(!result.quality[0].columnTexts.some((column) => column.endsWith("誰もい")));
  assert.ok(!result.quality[0].columnTexts.some((column) => column.startsWith("ない")));
  assert.deepEqual(result.quality[0].columnTexts, [
    "時計は午後１０時。誰もいない",
    "営業部で、田中だけが",
    "契約書を直していた。",
  ]);
});

test("automatic Japanese columns keep a demonstrative with its following noun", () => {
  const result = renderSpeechBubbleSvg({
    width: 1672,
    height: 941,
    bubbles: [{
      text: "雨、強くなったな。閉店前に、この現像だけ終わらせよう",
      speakerPosition: "left",
    }],
  });

  assert.equal(result.quality[0].columns, 3);
  assert.equal(result.quality[0].textLoss, false);
  assert.ok(!result.quality[0].columnTexts.some((column) => column.endsWith("この")));
  assert.ok(result.quality[0].columnTexts.some((column) => column.includes("この現像")));
});

test("vertical dialogue preserves authored punctuation without inventing a final Japanese period", () => {
  const source = "澪なのか？　東京にいるはずじゃ……";
  const result = renderSpeechBubbleSvg({
    width: 1672,
    height: 941,
    bubbles: [{ text: source, speakerPosition: "left" }],
  });

  assert.equal(result.quality[0].textLoss, false);
  assert.equal(result.quality[0].columnTexts.join(""), "澪なのか？東京にいるはずじゃ︙");
  assert.ok(!result.quality[0].columnTexts.at(-1).endsWith("。"));
  assert.match(result.svg, /data-text="澪なのか？東京にいるはずじゃ︙"/);
});

test("explicit human-approved Japanese columns remain available through the renderer", () => {
  const result = renderSpeechBubbleSvg({
    width: 1672,
    height: 941,
    bubbles: [{
      text: "田中、この条件のまま今夜中に先方へ送れ。余計な確認はするな",
      columns: ["田中、この条件のまま", "今夜中に先方へ送れ。", "余計な確認はするな"],
      target: { x: 0.75, y: 0.25 },
    }],
  });

  assert.deepEqual(result.quality[0].columnTexts, [
    "田中、この条件のまま",
    "今夜中に先方へ送れ。",
    "余計な確認はするな",
  ]);
  assert.equal(result.quality[0].textLoss, false);
  assert.equal(result.quality[0].exactTextMatch, true);
});

test("approved narration columns retain phrase groups when only final punctuation was omitted", () => {
  const text = "けれど、写した人の名前まで守ってくれるわけではない。";
  const result = renderSpeechBubbleSvg({
    width: 1672,
    height: 941,
    bubbles: [{
      preset: "narration",
      text,
      columns: ["けれど、写した人の", "名前まで守ってくれる", "わけではない"],
      bounds: { x: 0.42, y: 0.12, width: 0.18, height: 0.76 },
    }],
  });

  assert.deepEqual(result.quality[0].columnTexts, [
    "けれど、写した人の",
    "名前まで守ってくれる",
    "わけではない。",
  ]);
  assert.equal(result.quality[0].renderedText, text);
  assert.equal(result.quality[0].exactTextMatch, true);
  assert.equal(result.quality[0].textLoss, false);
  assert.equal(result.quality[0].overflow, false);
});

test("stale explicit columns never replace or truncate the current dialogue text", () => {
  const text = "田中さん、元の見積書とメールを開いてください。二つを並べれば改ざんが証明できます";
  const result = renderSpeechBubbleSvg({
    width: 1672,
    height: 941,
    bubbles: [{
      text,
      columns: ["二つを並べれば", "改ざんが証明できます"],
      target: { x: 0.75, y: 0.25 },
    }],
  });

  assert.equal(result.quality[0].inputCharacterCount, text.length);
  assert.equal(result.quality[0].renderedCharacterCount, text.length);
  assert.equal(result.quality[0].textLoss, false);
  assert.equal(result.quality[0].columnTexts.join(""), text);
});

test("reference bubbles keep a full character-height safety margin from the body edge", () => {
  const result = renderSpeechBubbleSvg({
    width: 1672,
    height: 941,
    bubbles: [{ text: "また僕だけ残業か……。でも、明日の契約だけは失敗できない" }],
  });

  assert.equal(result.quality[0].overflow, false);
  assert.ok(result.quality[0].edgeClearanceRatio >= 0.9);
  assert.ok(result.quality[0].ellipseContainmentScore <= 0.96);
});

test("long reference-style dialogue never widens beyond three columns and reports overflow", () => {
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

  assert.equal(result.quality[0].columns, 3);
  assert.equal(result.quality[0].overflow, true);
  assert.equal(result.quality[0].textLoss, false);
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

test("default placement uses the negative space opposite the speaker", () => {
  for (const speakerPosition of ["left", "right"]) {
    const result = planSpeechBubbleLayout({
      width: 1672,
      height: 941,
      bubbles: [{ text: "参考動画と同じ位置", speakerPosition }],
    });
    const bounds = result.bubbles[0].bounds;
    const centerX = bounds.x + bounds.width / 2;
    if (speakerPosition === "left") assert.ok(centerX >= 1672 * 0.75, "use the right outer negative-space lane");
    else assert.ok(centerX <= 1672 * 0.25, "use the left outer negative-space lane");
    assert.ok(bounds.y + bounds.height / 2 < 941 * 0.72);
  }
});

test("reference sequence policy moves a new balloon out of the previous lane and band", () => {
  const result = planSpeechBubbleLayout({
    width: 1000,
    height: 600,
    bubbles: [{ id: "next", text: "連続して同じ場所には置かない", speakerPosition: "left" }],
    placementHistory: [{
      id: "previous",
      preset: "dialogue",
      bounds: { x: 0.798, y: 0.055, width: 0.157, height: 0.62 },
    }],
  });
  const bubble = result.bubbles[0];
  assert.equal(bubble.sequencePlacement.policyId, REFERENCE_SEQUENCE_PLACEMENT_POLICY.id);
  assert.equal(bubble.sequencePlacement.historyDepth, 1);
  assert.equal(bubble.sequencePlacement.nearRepeat, false);
  assert.equal(bubble.sequencePlacement.immediate.laneChanged, true);
  assert.equal(bubble.sequencePlacement.immediate.bandChanged, true);
  assert.ok(
    bubble.sequencePlacement.immediate.centerDistanceRatio
      >= REFERENCE_SEQUENCE_PLACEMENT_POLICY.preferredMovementDistanceRatio,
  );
});

test("sequence variation never wins by covering a protected face", () => {
  const protectedFaces = [
    { x: 0.36, y: 0.02, width: 0.30, height: 0.72, kind: "face" },
    { x: 0.04, y: 0.02, width: 0.24, height: 0.72, kind: "face" },
  ];
  const result = planSpeechBubbleLayout({
    width: 1000,
    height: 600,
    bubbles: [{ text: "顔を避ける方が優先", speakerPosition: "left" }],
    placementHistory: [{ bounds: { x: 0.798, y: 0.055, width: 0.157, height: 0.62 } }],
    avoidRegions: protectedFaces,
  });
  const selected = result.bubbles[0].bounds;
  for (const face of protectedFaces) {
    const absolute = { x: face.x * 1000, y: face.y * 600, width: face.width * 1000, height: face.height * 600 };
    const overlapWidth = Math.max(0, Math.min(selected.x + selected.width, absolute.x + absolute.width) - Math.max(selected.x, absolute.x));
    const overlapHeight = Math.max(0, Math.min(selected.y + selected.height, absolute.y + absolute.height) - Math.max(selected.y, absolute.y));
    assert.equal(overlapWidth * overlapHeight, 0);
  }
  assert.equal(result.bubbles[0].sequencePlacement.immediate.bandChanged, true);
  assert.equal(result.bubbles[0].placementScore < 5000, true);
});

test("camera-aware authored placement can lock a bubble to the requested outer lane", () => {
  for (const placementSide of ["left", "right"]) {
    const result = planSpeechBubbleLayout({
      width: 1672,
      height: 941,
      bubbles: [{
        text: "話者の顔を避ける位置",
        placementSide,
        lockPlacementSide: true,
        target: placementSide === "left" ? { x: 0.82, y: 0.28 } : { x: 0.18, y: 0.28 },
      }],
    });
    const bounds = result.bubbles[0].bounds;
    const centerX = bounds.x + bounds.width / 2;
    if (placementSide === "left") assert.ok(centerX < 1672 / 2);
    else assert.ok(centerX > 1672 / 2);
  }
});

test("multi-person dialogue uses the nearest face-safe center gap instead of a distant outer edge", () => {
  const result = planSpeechBubbleLayout({
    width: 1000,
    height: 600,
    bubbles: [{
      text: "話している人の近くに置く",
      placementSide: "left",
      target: { x: 0.74, y: 0.30 },
      speakerProximityTargets: [
        { x: 0.71, y: 0.29 },
        { x: 0.74, y: 0.30 },
        { x: 0.77, y: 0.31 },
      ],
    }],
    avoidRegions: [
      { x: 0.66, y: 0.08, width: 0.18, height: 0.34, kind: "face" },
      { x: 0.10, y: 0.10, width: 0.14, height: 0.30, kind: "body", weight: 80 },
    ],
  });
  const bubble = result.bubbles[0];
  const centerX = bubble.bounds.x + bubble.bounds.width / 2;
  assert.ok(centerX > 1000 * 0.34 && centerX < 1000 * 0.66, "use the clean gap near the active speaker");
  assert.equal(bubble.speakerProximityTargets.length, 3);
});

test("camera-swept active face gets a candidate directly beside its movement envelope", () => {
  const result = planSpeechBubbleLayout({
    width: 1000,
    height: 600,
    bubbles: [{
      text: "移動中も話者の近く",
      placementSide: "right",
      target: { x: 0.25, y: 0.25 },
      speakerProximityTargets: [
        { x: 0.34, y: 0.25 },
        { x: 0.25, y: 0.25 },
        { x: 0.16, y: 0.25 },
      ],
    }],
    avoidRegions: [{ x: 0.06, y: 0.02, width: 0.39, height: 0.38, kind: "face", weight: 1600 }],
  });
  const bounds = result.bubbles[0].bounds;
  assert.ok(bounds.x >= 450, "place the balloon just beyond the swept face region");
  assert.ok(bounds.x < 700, "do not send it to the far outer edge");
});

test("an authored bubble is rejected when it covers any protected speaker-head sample", () => {
  assert.throws(() => renderSpeechBubbleSvg({
    width: 1000,
    height: 600,
    bubbles: [{
      text: "顔には絶対に重ねない",
      bounds: { x: 0.42, y: 0.10, width: 0.20, height: 0.60 },
    }],
    avoidRegions: [{
      x: 0.50,
      y: 0.20,
      width: 0.16,
      height: 0.28,
      kind: "active-speaker-head",
    }],
  }), /no collision-free placement/);
});

test("a natural narration box may shrink marginally to fit a camera-visible pocket", () => {
  const result = planSpeechBubbleLayout({
    width: 1672,
    height: 941,
    bubbles: [{ id: "narration-margin", preset: "narration", text: "佐藤は駅舎の防犯映像と回数" }],
    avoidRegions: [
      { x: 0, y: 0, width: 317, height: 941, kind: "page-offscreen" },
      { x: 1355, y: 0, width: 317, height: 941, kind: "page-offscreen" },
      { x: 317, y: 0, width: 1038, height: 268, kind: "page-offscreen" },
      { x: 317, y: 673, width: 1038, height: 268, kind: "page-offscreen" },
    ],
  });
  assert.ok(result.bubbles[0].placementScale < 1);
  assert.ok(result.bubbles[0].placementScale >= 0.86);
  assert.equal(result.bubbles[0].bounds.y >= 268, true);
  assert.equal(result.bubbles[0].bounds.y + result.bubbles[0].bounds.height <= 673, true);
});

test("single-person dialogue tracks the speaker across the complete camera interval", () => {
  const placement = buildCameraAwareBubblePlacement({
    width: 1000,
    height: 600,
    shot: {
      id: "moving-single-speaker",
      startSeconds: 0,
      endSeconds: 6,
      durationSeconds: 6,
      camera: {
        zoomStart: 1.4,
        zoomEnd: 1.4,
        focusX: 0.60,
        focusXEnd: 0.40,
        focusY: 0.5,
        focusYEnd: 0.5,
      },
    },
    utterance: {
      id: "single-u01",
      preset: "dialogue",
      timing: { bubbleStartInCutSeconds: 0.5, bubbleEndInCutSeconds: 5.5 },
    },
    overlaySpec: {
      avoidRegions: [{ id: "speaker-face", kind: "face", x: 0.43, y: 0.12, width: 0.14, height: 0.25 }],
      cameraAwarePlacement: {
        sourceSpeakerFace: { id: "speaker-face", kind: "face", x: 0.43, y: 0.12, width: 0.14, height: 0.25 },
      },
    },
  });
  assert.ok(placement.sampledCameraPositions >= 33);
  assert.equal(placement.speakerProximitySampleCount, 9);
  assert.ok(placement.cameraAwareAvoidRegions.every((region) => region.kind === "active-speaker-head"));
  assert.equal(placement.hardOverlapTolerancePixels, 0);
});

test("locked reference profile never synthesizes bold emphasis", () => {
  const result = renderSpeechBubbleSvg({
    width: 1672,
    height: 941,
    bubbles: [{ text: "太字にはしない", emphasis: "太字", target: { x: 0.8, y: 0.3 } }],
  });
  assert.doesNotMatch(result.svg, /font-weight="(?:[5-9]\d\d)"/);
  assert.match(result.svg, /font-synthesis:none/);
});

test("supplemental source faces remain hard across every camera sample", () => {
  const placement = buildCameraAwareBubblePlacement({
    width: 1000,
    height: 600,
    shot: {
      id: "two-face-shot",
      startSeconds: 0,
      endSeconds: 4,
      durationSeconds: 4,
      camera: { zoomStart: 1, zoomEnd: 1, focusX: 0.5, focusY: 0.5 },
    },
    utterance: {
      id: "u1",
      speakerId: "speaker",
      preset: "dialogue",
      timing: { bubbleStartInCutSeconds: 0, bubbleEndInCutSeconds: 4 },
    },
    overlaySpec: {
      sourceAvoidRegions: [
        { id: "speaker", kind: "face", x: 0.1, y: 0.1, width: 0.15, height: 0.25 },
        { id: "listener", kind: "face", hardProtection: true, x: 0.7, y: 0.1, width: 0.15, height: 0.25 },
      ],
      cameraAwarePlacement: {
        sourceSpeakerFace: { id: "speaker", kind: "face", x: 0.1, y: 0.1, width: 0.15, height: 0.25 },
      },
    },
  });
  assert.ok(placement.cameraAwareAvoidRegions.some((region) => region.id.startsWith("listener-") && region.kind === "head"));
});

test("hash-bound story evidence remains hard across every camera sample", () => {
  const placement = buildCameraAwareBubblePlacement({
    width: 1000,
    height: 600,
    shot: {
      id: "evidence-shot",
      startSeconds: 0,
      endSeconds: 4,
      durationSeconds: 4,
      camera: { zoomStart: 1.2, zoomEnd: 1, focusX: 0.5, focusY: 0.5 },
    },
    utterance: {
      id: "u1",
      speakerId: "narration",
      preset: "narration",
      timing: { bubbleStartInCutSeconds: 0, bubbleEndInCutSeconds: 4 },
    },
    overlaySpec: {
      sourceAvoidRegions: [
        { id: "phone-proof", kind: "evidence", hardProtection: true, x: 0.4, y: 0.3, width: 0.2, height: 0.2 },
      ],
    },
  });
  assert.ok(placement.cameraAwareAvoidRegions.length >= 33);
  assert.ok(placement.cameraAwareAvoidRegions.every((region) => region.kind === "protected-evidence"));
  assert.throws(() => renderSpeechBubbleSvg({
    width: 1000,
    height: 600,
    bubbles: [{ id: "blocked", text: "証拠を隠さない", bounds: { x: 350, y: 150, width: 300, height: 300 } }],
    avoidRegions: placement.cameraAwareAvoidRegions,
  }), /no collision-free placement/u);
});

test("camera-sampled important overlap reports the worst instant instead of summing time", () => {
  const result = renderSpeechBubbleSvg({
    width: 1000,
    height: 600,
    bubbles: [{
      id: "sampled-overlap",
      text: "証拠を隠さない",
      bounds: { x: 100, y: 100, width: 200, height: 300 },
    }],
    avoidRegions: [0, 0.5, 1].map((cameraProgress, index) => ({
      id: `evidence-camera-sample-${index + 1}`,
      kind: "evidence",
      x: 100,
      y: 100,
      width: 100,
      height: 300,
      cameraProgress,
    })),
  });
  assert.ok(result.quality[0].importantOverlapRatio <= 0.51);
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

test("editorial scope exposes all six reference-video presets", () => {
  for (const preset of ["dialogue", "shout", "thought", "panic", "tremble", "narration"]) {
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

test("R135 vertical Latin stays upright: 'vrt2' is withheld from Latin and digits only", () => {
  const result = renderSpeechBubbleSvg({
    width: 1920,
    height: 1080,
    bubbles: [{
      id: "brag",
      text: "T大の彼氏ができたわ。3年ぶり",
      target: { x: 0.5, y: 0.4 },
      bounds: { x: 0.1, y: 0.1, width: 0.25, height: 0.7 },
    }],
  });

  const glyphs = [...result.svg.matchAll(/<text[^>]*data-glyph-kind="([^"]+)"[^>]*style="([^"]+)"[^>]*>([^<]+)<\/text>/gu)]
    .map(([, kind, style, char]) => ({ kind, style, char }));
  // The pipeline normalises the ASCII digit to its full-width form; both the
  // half-width letter and the full-width digit must stay upright.
  const latin = glyphs.filter((glyph) => /^[A-Za-z0-9０-９Ａ-Ｚａ-ｚ]$/u.test(glyph.char));
  assert.deepEqual(latin.map((glyph) => glyph.char).sort(), ["T", "３"]);
  for (const glyph of latin) {
    assert.equal(glyph.kind, "upright-latin");
    assert.doesNotMatch(glyph.style, /vrt2/);
    assert.doesNotMatch(glyph.style, /'vert'/);
  }
  // Japanese glyphs must keep the rotating vertical alternates.
  const japanese = glyphs.filter((glyph) => glyph.char === "大" || glyph.char === "彼");
  assert.ok(japanese.length >= 2);
  for (const glyph of japanese) {
    assert.match(glyph.style, /'vrt2' 1/);
    assert.equal(glyph.kind, "character");
  }
});
