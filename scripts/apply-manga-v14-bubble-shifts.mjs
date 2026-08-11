#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const projectDir = "/Users/higataiyu/Documents/Excalidraw";
const episodeDir = path.join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001",
);

const shifts = [
  {
    utteranceId: "cut-03-u02",
    dx: 470,
    dy: 0,
    reason: "Move Ren's bubble from his face to the empty right-side wall.",
  },
  {
    utteranceId: "cut-04-u02",
    dx: 925,
    dy: 0,
    reason: "Move Ren's bubble from his face to the central/right floor-background lane.",
  },
];

function shiftBounds(bounds, dx, dy) {
  if (!bounds) return;
  bounds.x += dx;
  bounds.y += dy;
}

for (const rule of shifts) {
  const specPath = path.join(
    episodeDir,
    "overlay-specs",
    `${rule.utteranceId}.json`,
  );
  const svgPath = path.join(
    episodeDir,
    "overlays",
    `${rule.utteranceId}.svg`,
  );

  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  if (spec.v14BubbleShift) {
    throw new Error(`${rule.utteranceId} already has a V14 bubble shift`);
  }
  shiftBounds(spec.bubble?.bounds, rule.dx, rule.dy);
  for (const bubble of spec.plan?.bubbles ?? []) {
    shiftBounds(bubble.bounds, rule.dx, rule.dy);
  }
  shiftBounds(spec.placementOverride?.bounds, rule.dx, rule.dy);
  spec.v14BubbleShift = {
    dx: rule.dx,
    dy: rule.dy,
    reason: rule.reason,
    appliedAt: new Date().toISOString(),
  };
  fs.writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);

  const svg = fs.readFileSync(svgPath, "utf8");
  const groupMarker = `<g id="bubble-${rule.utteranceId}"`;
  if (!svg.includes(groupMarker)) {
    throw new Error(`Bubble group not found in ${svgPath}`);
  }
  if (svg.includes(`data-v14-shift="${rule.dx},${rule.dy}"`)) {
    throw new Error(`${rule.utteranceId} SVG already shifted`);
  }
  const shiftedSvg = svg.replace(
    groupMarker,
    `${groupMarker} transform="translate(${rule.dx} ${rule.dy})" data-v14-shift="${rule.dx},${rule.dy}"`,
  );
  fs.writeFileSync(svgPath, shiftedSvg);
  console.log(`${rule.utteranceId}: dx=${rule.dx}, dy=${rule.dy}`);
}
