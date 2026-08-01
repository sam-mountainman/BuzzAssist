#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSpeechBubbleSvg } from "../lib/speechBubbleRenderer.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frame = { width: 1672, height: 941 };
const panel = { width: 720, previewHeight: 405, height: 473 };
const grid = { columns: 4, rows: 3, gap: 24, margin: 48, header: 112 };
const outputPath = join(root, "canvas/assets/speech-bubble-reference-matrix-v1.svg");
const reportPath = join(root, "canvas/speech-bubbles/reference-quality-matrix-v1.json");
const backgroundFiles = [
  "manga-office-001-cut-03.png",
  "manga-office-001-cut-07.png",
  "manga-office-001-cut-08.png",
];

const cases = [
  {
    id: "compact-reply",
    label: "短文 1列｜コンパクト楕円",
    bubbles: [{ text: "え？", side: "left", speakerPosition: "left" }],
  },
  {
    id: "dialogue-two-columns",
    label: "通常会話 2列｜参考動画比率",
    bubbles: [{ text: "標高が高いところは\n肌寒いね。大丈夫？", side: "right", speakerPosition: "right" }],
  },
  {
    id: "dialogue-three-columns",
    label: "通常会話 3列｜長セリフ",
    bubbles: [{ text: "元気にしてるか\n気になったの。\n私がいなくて寂しかったでしょ？", side: "right", speakerPosition: "right" }],
  },
  {
    id: "dialogue-four-columns",
    label: "通常会話 4列｜密度上限",
    bubbles: [{ columns: ["君は随分と", "絶望した顔を", "しているけど", "本当に辛いの？"], side: "left", speakerPosition: "left" }],
  },
  {
    id: "dialogue-five-columns",
    label: "通常会話 5列｜文字欠落ゼロ",
    bubbles: [{ columns: ["信用して", "来てくれた", "お客様を", "裏切るのは", "許されない"], side: "right", speakerPosition: "right" }],
  },
  {
    id: "two-speakers",
    label: "複数話者｜重なり回避",
    bubbles: [
      { id: "speaker-a", text: "資料は確認した？", side: "left", speakerPosition: "left" },
      { id: "speaker-b", text: "はい。問題ありません", side: "right", speakerPosition: "right" },
    ],
    avoidRegions: [
      { x: 0.15, y: 0.12, width: 0.17, height: 0.20, kind: "face" },
      { x: 0.68, y: 0.12, width: 0.17, height: 0.20, kind: "face" },
    ],
  },
  {
    id: "narration",
    label: "地の文｜細黒枠の長方形",
    bubbles: [{ preset: "narration", text: "その日の夜\n事態は静かに\n動き始めた", side: "left", target: { x: 0.24, y: 0.28 } }],
  },
  {
    id: "shout",
    label: "叫び｜8つの大きなトゲ",
    bubbles: [{ preset: "shout", text: "同じ被害を受けて\n客足は遠のくわ", side: "right", speakerPosition: "right" }],
  },
  {
    id: "thought",
    label: "心の声｜控えめな波形",
    bubbles: [{ preset: "thought", text: "そういう\nことか…", side: "left", speakerPosition: "left", tail: false }],
  },
  {
    id: "optional-tail",
    label: "任意尻尾｜本体と単一パス",
    bubbles: [{ text: "待ってください！", tail: true, side: "right", target: { x: 0.72, y: 0.29 } }],
    avoidRegions: [{ x: 0.48, y: 0.08, width: 0.30, height: 0.43, kind: "face" }],
  },
  {
    id: "protected-regions",
    label: "顔・手・小物｜自動衝突回避",
    bubbles: [{ text: "その証拠を見せてください", speakerPosition: "right" }],
    avoidRegions: [
      { x: 0.66, y: 0.08, width: 0.22, height: 0.34, kind: "face" },
      { x: 0.48, y: 0.50, width: 0.20, height: 0.30, kind: "prop" },
    ],
  },
  {
    id: "punctuation-and-digits",
    label: "禁則・数字・括弧｜欠落ゼロ",
    bubbles: [{ text: "2026年に\n『本当に？』と\n聞いたんです", side: "left", speakerPosition: "left" }],
  },
];

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]);
}

function innerOverlay(svg) {
  return svg.match(/<g fill="none">([\s\S]*)<\/g><\/svg>$/)?.[1] ?? "";
}

function dataUri(fileName) {
  const data = readFileSync(join(root, "canvas/assets", fileName)).toString("base64");
  return `data:image/png;base64,${data}`;
}

function casePass(result) {
  return result.quality.every((quality) => (
    !quality.overflow
    && !quality.tooSmall
    && !quality.textLoss
    && quality.faceOverlapRatio <= 0.01
    && quality.importantOverlapRatio <= 0.01
  ));
}

const backgrounds = backgroundFiles.map((fileName, index) => ({
  id: `background-${index}`,
  fileName,
  uri: dataUri(fileName),
}));
const renderedCases = cases.map((entry, index) => {
  const result = renderSpeechBubbleSvg({
    ...frame,
    bubbles: entry.bubbles,
    avoidRegions: entry.avoidRegions ?? [],
    title: entry.label,
  });
  return { ...entry, index, result, pass: casePass(result) };
});

const boardWidth = grid.margin * 2 + grid.columns * panel.width + (grid.columns - 1) * grid.gap;
const boardHeight = grid.header + grid.margin + grid.rows * panel.height + (grid.rows - 1) * grid.gap + grid.margin;
const defs = [
  `<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#0f172a" flood-opacity="0.18"/></filter>`,
  ...backgrounds.map((background) => `<image id="${background.id}" href="${background.uri}" width="${frame.width}" height="${frame.height}" preserveAspectRatio="xMidYMid slice"/>`),
  ...renderedCases.map((entry) => `<clipPath id="clip-${entry.id}"><rect width="${panel.width}" height="${panel.height}" rx="18"/></clipPath>`),
].join("");

const panels = renderedCases.map((entry) => {
  const column = entry.index % grid.columns;
  const row = Math.floor(entry.index / grid.columns);
  const x = grid.margin + column * (panel.width + grid.gap);
  const y = grid.header + grid.margin + row * (panel.height + grid.gap);
  const scaleX = panel.width / frame.width;
  const scaleY = panel.previewHeight / frame.height;
  const background = backgrounds[entry.index % backgrounds.length];
  const metrics = entry.result.quality
    .map((quality) => `${quality.columns}列 ${Math.round(quality.fontSize)}px${quality.textLoss ? " 欠落" : ""}${quality.overflow ? " はみ出し" : ""}`)
    .join(" / ");
  const badgeColor = entry.pass ? "#16a34a" : "#dc2626";
  return [
    `<g transform="translate(${x} ${y})" data-case-id="${entry.id}" filter="url(#shadow)">`,
    `<g clip-path="url(#clip-${entry.id})">`,
    `<use href="#${background.id}" transform="scale(${scaleX} ${scaleY})"/>`,
    `<g transform="scale(${scaleX} ${scaleY})">${innerOverlay(entry.result.svg)}</g>`,
    `<rect y="405" width="720" height="68" fill="#0f172a" fill-opacity="0.94"/>`,
    `<text x="20" y="433" fill="#ffffff" font-family="'Hiragino Sans','Yu Gothic',sans-serif" font-size="22" font-weight="700">${escapeXml(entry.label)}</text>`,
    `<text x="20" y="458" fill="#cbd5e1" font-family="'Hiragino Sans','Yu Gothic',sans-serif" font-size="16">${escapeXml(metrics)}</text>`,
    `<rect x="632" y="421" width="68" height="34" rx="17" fill="${badgeColor}"/>`,
    `<text x="666" y="444" text-anchor="middle" fill="#ffffff" font-family="Arial,sans-serif" font-size="16" font-weight="800">${entry.pass ? "PASS" : "CHECK"}</text>`,
    `</g>`,
    `<rect width="720" height="405" rx="18" fill="none" stroke="#ffffff" stroke-width="3"/>`,
    `</g>`,
  ].join("");
}).join("");

const passCount = renderedCases.filter((entry) => entry.pass).length;
const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${boardWidth}" height="${boardHeight}" viewBox="0 0 ${boardWidth} ${boardHeight}">`,
  `<title>BuzzAssist reference-video speech-bubble quality matrix</title>`,
  `<defs>${defs}</defs>`,
  `<rect width="100%" height="100%" fill="#eef2ff"/>`,
  `<text x="48" y="58" fill="#111827" font-family="'Hiragino Sans','Yu Gothic',sans-serif" font-size="38" font-weight="800">吹き出し品質マトリクス｜参考動画寄せ</text>`,
  `<text x="48" y="94" fill="#475569" font-family="'Hiragino Sans','Yu Gothic',sans-serif" font-size="21">通常会話・短文・長文・複数話者・地の文・叫び・心の声・尻尾・衝突回避・禁則を同じ基準で検証</text>`,
  `<rect x="${boardWidth - 250}" y="34" width="202" height="58" rx="29" fill="${passCount === renderedCases.length ? "#16a34a" : "#dc2626"}"/>`,
  `<text x="${boardWidth - 149}" y="72" text-anchor="middle" fill="#ffffff" font-family="Arial,sans-serif" font-size="25" font-weight="800">${passCount}/${renderedCases.length} PASS</text>`,
  panels,
  `</svg>`,
].join("");

const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  profileId: renderedCases[0]?.result.profile.id,
  sourceVideos: [
    "https://www.youtube.com/watch?v=awAbZyTeE4g",
    "https://www.youtube.com/watch?v=2ycRncs4CKY",
  ],
  referenceObservations: [
    "Standard dialogue is a smooth white vertical ellipse with a thin black outline and no default tail.",
    "Dialogue typography is black Mincho, vertically set, normally one to four semantic columns.",
    "Narration is a white rectangle with a thin black outline.",
    "Shout balloons use a small number of broad spikes, not a dense explosion shape.",
    "Balloons occupy outer negative-space zones and avoid faces, mouths, hands, and story-critical props.",
  ],
  summary: { passed: passCount, total: renderedCases.length },
  cases: renderedCases.map((entry) => ({
    id: entry.id,
    label: entry.label,
    pass: entry.pass,
    quality: entry.result.quality,
    bounds: entry.result.plan.bubbles.map((bubble) => bubble.bounds),
  })),
};

mkdirSync(dirname(outputPath), { recursive: true });
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(outputPath, svg);
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, reportPath, passed: passCount, total: renderedCases.length }));
