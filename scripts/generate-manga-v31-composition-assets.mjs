#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { runWithConcurrency, generateImageMedia } from "../lib/mediaGeneration.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const force = process.argv.includes("--force");
const canvasDir = join(projectDir, "canvas");
const assetDir = join(canvasDir, "assets");
const episodeDir = join(canvasDir, "manga-videos/manga-photo-homecoming-001");
const outputManifestPath = join(episodeDir, "v31-composition-asset-generation.json");
const ref = (name) => join(assetDir, name);

const REN = ref("characters/manga-photo-homecoming-001-character-1-turnaround.png");
const MIO = ref("characters/manga-photo-homecoming-001-character-2-turnaround.png");
const REIJI = ref("characters/manga-photo-homecoming-001-character-3-turnaround.png");
const SHOP = ref("manga-photo-homecoming-001-v28-background-empty-photo-shop.png");
const STYLE = ref("style-reference-direct-v5-warm-interior.png");

const common = [
  "Create a completely new original 16:9 Japanese motion-comic illustration at 1920x1080.",
  "Use the supplied images only to preserve the approved character identities, wardrobe, photo-shop geography, and clean anime rendering style.",
  "Do not copy a reference camera position, pose, crop, or facial expression.",
  "Maintain consistent warm wood and cream photo-shop materials, rainy evening window light, crisp controlled linework, and restrained cinematic color.",
  "No speech bubble, no captions, no readable writing, no logo, no watermark, no extra people, no duplicated anatomy, no malformed hands.",
  "Do not default to a centered eye-level two-shot. The requested foreground, middle ground, background, elevation, and eyelines are mandatory.",
].join("\n");

const jobs = [
  {
    id: "cut-01-u03-counter-macro-ren",
    fileName: "manga-photo-homecoming-001-v31-cut-01-u03-counter-macro-ren.png",
    refs: [REN, SHOP, STYLE],
    prompt: `${common}\nStory: Ren works alone just before closing while heavy rain intensifies. Camera is almost at counter height, 35mm three-quarter side view. A photo enlarger arm and translucent negative strip cross the extreme foreground very large and slightly out of focus. Ren is a focused profile in the middle ground, one hand adjusting the print tray. The rainy window and dim shop aisle create a deep background. Reserve a clean upper-right pocket, but keep Ren off-center on the left.`,
  },
  {
    id: "cut-03-u01-ren-ots-mio-door",
    fileName: "manga-photo-homecoming-001-v31-cut-03-u01-ren-ots-mio-door.png",
    refs: [REN, MIO, SHOP, STYLE],
    prompt: `${common}\nStory: Mio unexpectedly returns after ten years and speaks from the entrance. Camera stands directly behind Ren's left shoulder; his head and shoulder are a large soft foreground silhouette occupying the left third. Mio is framed full-to-three-quarter length by the rain-streaked glass door in the middle distance, one hand still on the wet umbrella, hesitant but familiar smile. Long shop counter and hanging frames recede diagonally into the background. 40mm lens, eye height, strong three-plane depth. Reserve negative space above the counter on the right without putting Mio in the center.`,
  },
  {
    id: "cut-03-u02-mio-ots-ren-reaction",
    fileName: "manga-photo-homecoming-001-v31-cut-03-u02-mio-ots-ren-reaction.png",
    refs: [REN, MIO, SHOP, STYLE],
    prompt: `${common}\nStory: Ren realizes the visitor is Mio and silently thinks she should still be in Tokyo. Reverse over-the-shoulder close-up from just behind Mio. A soft edge of Mio's wet brown hair and coat fills the right foreground. Ren's surprised face is left-of-center in sharp focus, caught between the enlarger and a rack of hanging photographs; his hand has stopped above the tray. 70mm lens, shallow two-plane depth, eye-height but slightly canted to avoid symmetry. Leave a clean vertical pocket on the far left, away from his face.`,
  },
  {
    id: "cut-03-u03-mio-rain-reflection",
    fileName: "manga-photo-homecoming-001-v31-cut-03-u03-mio-rain-reflection.png",
    refs: [REN, MIO, SHOP, STYLE],
    prompt: `${common}\nStory: Mio admits that she has places she can go but no longer knows where she wants to return. Tight profile close-up of Mio beside the rain window, camera parallel to the glass. Her face is on the right third, eyes lowered, with a faint reflection offset beside her. Rain beads and city lights are sharp in the foreground plane; Ren is a small soft presence deep behind her near the counter. 85mm lens, restrained sadness, side light across only part of her face. Keep the entire left half quiet for editorial space.`,
  },
  {
    id: "cut-04-u01-photo-foreground-theft",
    fileName: "manga-photo-homecoming-001-v31-cut-04-u01-photo-foreground-theft.png",
    refs: [REN, MIO, SHOP, STYLE],
    prompt: `${common}\nStory: Mio explains that Reiji published her photograph as his own. Put an old mounted photograph and Mio's tense fingers extremely large in the bottom-left foreground; the photographed content is abstract and contains no readable marks. From the low counter-level camera, Mio is in three-quarter profile in the middle ground while Ren listens farther back across the counter. 35mm lens, diagonal composition, three distinct depth planes. Mio is not posing; she protects the photograph with one hand and avoids Ren's eyes. Reserve the upper-right wall as clean space.`,
  },
  {
    id: "cut-04-u03-mio-high-vulnerable",
    fileName: "manga-photo-homecoming-001-v31-cut-04-u03-mio-high-vulnerable.png",
    refs: [MIO, SHOP, STYLE],
    prompt: `${common}\nStory: Mio says she left every file with Reiji because she trusted him. High three-quarter view from above a shelf corner, 65mm lens. Mio is seated small in the lower-right quadrant, shoulders drawn inward, gripping the strap of her bag and the edge of an empty photo envelope. A blurred stack of albums partly occludes the lower-left foreground. The long empty counter and rainy wall dominate the frame, making her isolation visible. Soft top light, no melodramatic crying, large negative space on the upper left.`,
  },
  {
    id: "cut-05-u01-low-doorway-intrusion",
    fileName: "manga-photo-homecoming-001-v31-cut-05-u01-low-doorway-intrusion.png",
    refs: [REN, MIO, REIJI, SHOP, STYLE],
    prompt: `${common}\nStory: Reiji suddenly enters, claiming Mio is his assistant and must return. Low camera near the wet floor looking toward the glass entrance, 28mm lens. Reiji is framed tall in the open doorway on the right, backlit by cold rain. Ren and Mio appear only as unequal soft foreground silhouettes on opposite lower corners, creating a triangular depth composition and a clear invasion of their space. The shop aisle leads toward Reiji. Keep faces recognizable, no heroic pose, reserve a narrow clean upper-left pocket.`,
  },
  {
    id: "cut-05-u03-reiji-low-dominant",
    fileName: "manga-photo-homecoming-001-v31-cut-05-u03-reiji-low-dominant.png",
    refs: [REN, REIJI, SHOP, STYLE],
    prompt: `${common}\nStory: Reiji arrogantly says a name belongs to whoever can sell the work. Low close three-quarter view across the counter. The counter edge and Ren's out-of-focus shoulder form a dark foreground wedge. Reiji leans only slightly forward in the middle ground, controlled contempt rather than shouting, his face high on the right side and one open hand visible. A bright rectangular shop light behind him creates unequal power. 55mm lens, compressed two-plane depth, clean space on the left.`,
  },
  {
    id: "cut-06-u01-mio-memory-photo",
    fileName: "manga-photo-homecoming-001-v31-cut-06-u01-mio-memory-photo.png",
    refs: [MIO, REIJI, SHOP, STYLE],
    prompt: `${common}\nStory: Mio refuses to return and says the photograph records her grandmother's final summer. Camera at counter height in strict left profile, 45mm lens. The photograph edge and Mio's firm hand dominate the near foreground; Mio stands in the middle plane facing right with a newly steady posture. Reiji is only a soft partial figure far across the shop, not sharing her plane. Warm light catches the photo while cold rain remains behind. Reserve the upper-right pocket, and make this suitable as the left panel of an unequal two-panel confrontation.`,
  },
  {
    id: "cut-06-u02-reiji-pressure-profile",
    fileName: "manga-photo-homecoming-001-v31-cut-06-u02-reiji-pressure-profile.png",
    refs: [MIO, REIJI, SHOP, STYLE],
    prompt: `${common}\nStory: Reiji tells Mio that emotion will cost her career and she has no place in this town. Tight reverse profile from behind a rain-streaked display rack. A blurred edge of Mio's cheek and hair is a thin left foreground layer; Reiji is sharp in right-facing three-quarter close-up, calm and coercive, with cold window reflection cutting across his face. 75mm lens, no centered two-shot, very shallow depth. Reserve the lower-left area and make this suitable as the wider right panel of an unequal split.`,
  },
  {
    id: "cut-07-u01-negative-proof-macro",
    fileName: "manga-photo-homecoming-001-v31-cut-07-u01-negative-proof-macro.png",
    refs: [REN, MIO, REIJI, SHOP, STYLE],
    prompt: `${common}\nStory: Ren reveals the ten-year-old negative, duplicated data, timestamp, and order receipt. Extreme close object-led shot: Ren's hands hold a translucent negative strip against the warm inspection light, perfectly readable as photographic film but with no legible writing. The negative and fingertips occupy the center-left foreground. Beyond it, Reiji's shocked face is small and soft on the right, Mio even farther back. 90mm macro visual language, high angle, precise evidence hierarchy, clean upper-left pocket.`,
  },
  {
    id: "cut-08-u01-phone-send-ots",
    fileName: "manga-photo-homecoming-001-v31-cut-08-u01-phone-send-ots.png",
    refs: [REN, MIO, REIJI, SHOP, STYLE],
    prompt: `${common}\nStory: Mio sends the proof to the exhibition organizer under her own name. High over-the-shoulder close view from behind Mio, 55mm lens. Her phone and decisive thumb are sharp in the lower-right foreground; the screen shows only abstract attachment tiles and a send icon with absolutely no readable text. Ren stands supportive but not touching in the middle distance. Reiji is isolated beyond the counter near the cold entrance. Strong depth progression, reserve the upper-left wall.`,
  },
  {
    id: "cut-10-u01-staircase-studio",
    fileName: "manga-photo-homecoming-001-v31-cut-10-u01-staircase-studio.png",
    refs: [REN, MIO, SHOP, STYLE],
    prompt: `${common}\nStory: After the conflict, Mio proposes using the empty second floor as a photo studio. Architecture-led wide shot from high on the staircase looking diagonally down, 28mm lens. A wooden rail and hanging empty frames cross the foreground. Mio stands one step above Ren and points toward the bright unused upstairs room; Ren looks up from the lower landing. The renewed shop extends below in the background, rain now softened. Asymmetric diagonal composition, generous clean light on the upper-right wall.`,
  },
  {
    id: "cut-10-u02-intimate-side-confession",
    fileName: "manga-photo-homecoming-001-v31-cut-10-u02-intimate-side-confession.png",
    refs: [REN, MIO, SHOP, STYLE],
    prompt: `${common}\nStory: Mio quietly adds that this time she wants to stay beside Ren. Intimate side two-shot from behind a hanging photo frame, which creates a soft vertical foreground edge. Mio is sharp in left-facing profile on the right third, nervous but sincere. Ren is slightly farther away on the left, listening rather than posing, with warm stair light between them. 75mm lens, layered two-plane depth, faces at different sizes and heights, large quiet center pocket.`,
  },
];

await mkdir(assetDir, { recursive: true });
const outcomes = await runWithConcurrency(jobs, 4, async (job) => {
  const outputPath = join(assetDir, job.fileName);
  if (!force) {
    try {
      await access(outputPath);
      return { ...job, outputPath, status: "reused" };
    } catch {}
  }
  const media = await generateImageMedia({
    model: "gpt-image-2",
    prompt: job.prompt,
    aspectRatio: "16:9",
    imageSize: "1920x1080",
    quality: "high",
    fileName: job.fileName,
    referenceImagePaths: job.refs,
  });
  await writeFile(outputPath, media.buffer);
  return { ...job, outputPath, status: "generated", mimeType: media.mimeType, source: media.source };
}, { jobId: (job) => job.id });

const results = outcomes.map((outcome, index) => outcome.ok
  ? outcome.value
  : { ...jobs[index], status: "failed", error: outcome.error });
const report = {
  version: "v31-composition-assets-r1",
  generatedAt: new Date().toISOString(),
  model: "gpt-image-2",
  concurrency: 4,
  storyPolicy: {
    referenceRole: "identity/location/style only; never camera or pose",
    noBubbleInSource: true,
    requiredDepthPlanes: true,
    prohibitedDefault: "centered eye-level two-shot",
  },
  results,
  summary: {
    requested: results.length,
    generated: results.filter((result) => result.status === "generated").length,
    reused: results.filter((result) => result.status === "reused").length,
    failed: results.filter((result) => result.status === "failed").length,
  },
};
await writeFile(outputManifestPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputManifestPath, summary: report.summary, results: results.map(({ id, fileName, status, error }) => ({ id, fileName, status, error })) }, null, 2)}\n`);
if (report.summary.failed > 0) process.exitCode = 1;
