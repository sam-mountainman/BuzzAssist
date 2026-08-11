#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { renderSpeechBubbleSvg } from "../lib/speechBubbleRenderer.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(process.argv[3] || join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json",
));
const canvasDir = join(projectDir, "canvas");
const asset = (name) => join(canvasDir, "assets", name);
const rootDir = dirname(manifestPath);

const A = {
  renWide: asset("manga-photo-homecoming-001-v16-cut-01-wide-ren.png"),
  renClose: asset("manga-photo-homecoming-001-v16-proof-closeup-ren-r2.png"),
  renTop: asset("manga-photo-homecoming-001-v16-cut-02-top-ren-evidence.png"),
  mioEntry: asset("manga-photo-homecoming-001-v16-proof-medium-ren-mio-r2.png"),
  renReverse: asset("manga-photo-homecoming-001-v16-cut-03-reverse-ren-mio (1).png"),
  mioConfession: asset("manga-photo-homecoming-001-v16-cut-03-medium-mio-confession.png"),
  theft: asset("manga-photo-homecoming-001-v16-cut-04-medium-mio-photo-theft.png"),
  evidenceTop: asset("manga-photo-homecoming-001-v16-cut-04-top-evidence.png"),
  mioClose: asset("manga-photo-homecoming-001-v16-cut-04-close-mio-vulnerable.png"),
  reijiEntry: asset("manga-photo-homecoming-001-v16-cut-05-medium-reiji-entrance.png"),
  confrontation: asset("manga-photo-homecoming-001-v16-cut-05-wide-confrontation.png"),
  reijiClose: asset("manga-photo-homecoming-001-v16-cut-05-close-reiji.png"),
  mioResolve: asset("manga-photo-homecoming-001-v16-cut-06-medium-mio-resolve.png"),
  pressureWide: asset("manga-photo-homecoming-001-v16-cut-06-wide-reiji-pressure.png"),
  proofTop: asset("manga-photo-homecoming-001-v16-cut-07-top-evidence-proof.png"),
  reijiShock: asset("manga-photo-homecoming-001-v16-cut-07-close-reiji-shock.png"),
  mioSend: asset("manga-photo-homecoming-001-v16-cut-08-medium-mio-send.png"),
  consequence: asset("manga-photo-homecoming-001-v16-cut-08-wide-consequence.png"),
  childMio: asset("manga-photo-homecoming-001-v14-cut-09-right-r2.png"),
  childRen: asset("manga-photo-homecoming-001-v14-cut-09-left-r2.png"),
  childTop: asset("manga-photo-homecoming-001-v14-cut-09-top-wide-r2.png"),
  studio: asset("manga-photo-homecoming-001-v16-cut-10-medium-mio-studio.png"),
  mioLove: asset("manga-photo-homecoming-001-v16-cut-10-close-mio-confession.png"),
  closing: asset("manga-photo-homecoming-001-v16-cut-10-wide-closing.png"),
};

const camera = (type, focusX = 0.5, focusY = 0.42) => {
  const pullOut = type.includes("wide") || type === "top";
  return {
    saturation: 1,
    contrast: 1,
    brightness: 0,
    zoomStart: pullOut ? 1.03 : 1.015,
    zoomEnd: pullOut ? 1.008 : 1.035,
    focusX,
    focusY,
    focusXEnd: Math.max(0, Math.min(1, focusX + (focusX < 0.5 ? 0.012 : -0.012))),
    focusYEnd: focusY,
    easing: "smoothstep",
  };
};
const shot = (id, utteranceIds, imagePath, angle, type, focusX, focusY) => ({
  id,
  utteranceIds,
  imagePath,
  angle,
  viewpoint: angle.replace(/-wide$/u, ""),
  shotType: type,
  isSpatialWideShot: type === "wide",
  wideShotSource: type === "wide" ? "dedicated-camera-asset" : null,
  transition: "cut",
  motion: type === "wide" || angle === "top" ? "pull-out" : "slow-push",
  camera: camera(type === "wide" ? `${angle}-wide` : angle, focusX, focusY),
  reason: "V16 reference-video camera-distance match with neutral color and visible micro-motion",
});

const sequenceByCut = {
  "cut-01": [
    shot("cut-01-v16-wide", ["cut-01-u01", "cut-01-u02"], A.renWide, "left-wide", "wide", 0.22, 0.46),
    shot("cut-01-v16-close", ["cut-01-u03"], A.renClose, "left", "close-up", 0.36, 0.4),
  ],
  "cut-02": [
    shot("cut-02-v16-top", ["cut-02-u01"], A.renTop, "top", "medium", 0.37, 0.44),
    shot("cut-02-v16-close", ["cut-02-u02"], A.renClose, "left", "close-up", 0.36, 0.4),
  ],
  "cut-03": [
    shot("cut-03-v16-mio-entry", ["cut-03-u01"], A.mioEntry, "right", "medium", 0.66, 0.4),
    shot("cut-03-v16-ren-reverse", ["cut-03-u02"], A.renReverse, "right", "medium", 0.42, 0.4),
    shot("cut-03-v16-mio-confession", ["cut-03-u03"], A.mioConfession, "left", "medium", 0.7, 0.42),
  ],
  "cut-04": [
    shot("cut-04-v16-theft", ["cut-04-u01"], A.theft, "left", "medium", 0.72, 0.42),
    shot("cut-04-v16-evidence", ["cut-04-u02"], A.evidenceTop, "top", "medium", 0.5, 0.5),
    shot("cut-04-v16-mio-close", ["cut-04-u03"], A.mioClose, "right", "close-up", 0.56, 0.39),
  ],
  "cut-05": [
    shot("cut-05-v16-entry", ["cut-05-u01"], A.reijiEntry, "right", "medium", 0.67, 0.43),
    shot("cut-05-v16-wide", ["cut-05-u02"], A.confrontation, "right-wide", "wide", 0.54, 0.5),
    shot("cut-05-v16-reiji-close", ["cut-05-u03"], A.reijiClose, "left", "close-up", 0.36, 0.4),
  ],
  "cut-06": [
    shot("cut-06-v16-mio", ["cut-06-u01"], A.mioResolve, "left", "medium", 0.66, 0.4),
    shot("cut-06-v16-wide", ["cut-06-u02"], A.pressureWide, "right-wide", "wide", 0.54, 0.5),
  ],
  "cut-07": [
    shot("cut-07-v16-proof", ["cut-07-u01", "cut-07-u02"], A.proofTop, "top", "medium", 0.5, 0.48),
    shot("cut-07-v16-reiji", ["cut-07-u03"], A.reijiShock, "right", "close-up", 0.68, 0.4),
  ],
  "cut-08": [
    shot("cut-08-v16-send", ["cut-08-u01"], A.mioSend, "top", "medium", 0.38, 0.44),
    shot("cut-08-v16-consequence", ["cut-08-u02", "cut-08-u03"], A.consequence, "top-wide", "wide", 0.56, 0.48),
  ],
  "cut-09": [
    shot("cut-09-v16-mio", ["cut-09-u01"], A.childMio, "right", "medium", 0.63, 0.42),
    shot("cut-09-v16-ren", ["cut-09-u02"], A.childRen, "left", "medium", 0.34, 0.42),
    shot("cut-09-v16-top", ["cut-09-u03"], A.childTop, "top-wide", "wide", 0.5, 0.48),
  ],
  "cut-10": [
    shot("cut-10-v16-studio", ["cut-10-u01"], A.studio, "right", "medium", 0.68, 0.42),
    shot("cut-10-v16-mio-close", ["cut-10-u02"], A.mioLove, "left", "close-up", 0.64, 0.4),
    shot("cut-10-v16-closing", ["cut-10-u03", "cut-10-u04"], A.closing, "wide", "wide", 0.35, 0.5),
  ],
};

const regions = {
  [basename(A.renWide)]: [{ id: "ren-face", kind: "face", x: .075, y: .03, width: .12, height: .22 }],
  [basename(A.renClose)]: [{ id: "ren-face", kind: "face", x: .20, y: .01, width: .31, height: .50 }, { id: "photo", kind: "evidence", x: .39, y: .63, width: .25, height: .25 }],
  [basename(A.renTop)]: [{ id: "ren-face", kind: "face", x: .19, y: .04, width: .16, height: .27 }, { id: "photo", kind: "evidence", x: .36, y: .42, width: .24, height: .26 }],
  [basename(A.mioEntry)]: [{ id: "ren-face", kind: "face", x: .23, y: .10, width: .13, height: .23 }, { id: "mio-face", kind: "face", x: .63, y: .03, width: .23, height: .39 }],
  [basename(A.renReverse)]: [{ id: "ren-face", kind: "face", x: .41, y: .10, width: .17, height: .29 }, { id: "mio-face", kind: "face", x: .78, y: .02, width: .20, height: .42 }],
  [basename(A.mioConfession)]: [{ id: "ren-face", kind: "face", x: .52, y: .17, width: .11, height: .20 }, { id: "mio-face", kind: "face", x: .71, y: .04, width: .18, height: .34 }],
  [basename(A.theft)]: [{ id: "ren-face", kind: "face", x: .50, y: .23, width: .11, height: .19 }, { id: "mio-face", kind: "face", x: .72, y: .10, width: .16, height: .29 }, { id: "photo", kind: "evidence", x: .70, y: .46, width: .09, height: .14 }],
  [basename(A.evidenceTop)]: [{ id: "ren-face", kind: "face", x: .00, y: .66, width: .18, height: .31 }, { id: "mio-face", kind: "face", x: .64, y: .57, width: .16, height: .29 }, { id: "proof", kind: "evidence", x: .24, y: .42, width: .41, height: .35 }],
  [basename(A.mioClose)]: [{ id: "mio-face", kind: "face", x: .39, y: .02, width: .28, height: .50 }],
  [basename(A.reijiEntry)]: [{ id: "ren-face", kind: "face", x: .25, y: .25, width: .09, height: .16 }, { id: "mio-face", kind: "face", x: .49, y: .22, width: .09, height: .17 }, { id: "reiji-face", kind: "face", x: .67, y: .03, width: .16, height: .29 }],
  [basename(A.confrontation)]: [{ id: "ren-face", kind: "face", x: .32, y: .14, width: .08, height: .15 }, { id: "mio-face", kind: "face", x: .52, y: .16, width: .08, height: .15 }, { id: "reiji-face", kind: "face", x: .74, y: .10, width: .09, height: .16 }],
  [basename(A.reijiClose)]: [{ id: "reiji-face", kind: "face", x: .25, y: .01, width: .33, height: .52 }],
  [basename(A.mioResolve)]: [{ id: "mio-face", kind: "face", x: .50, y: .02, width: .22, height: .40 }, { id: "reiji-face", kind: "face", x: .13, y: .22, width: .11, height: .19 }],
  [basename(A.pressureWide)]: [{ id: "ren-face", kind: "face", x: .19, y: .20, width: .08, height: .14 }, { id: "mio-face", kind: "face", x: .45, y: .18, width: .08, height: .15 }, { id: "reiji-face", kind: "face", x: .72, y: .08, width: .10, height: .18 }],
  [basename(A.proofTop)]: [{ id: "ren-face", kind: "face", x: .25, y: .24, width: .10, height: .18 }, { id: "mio-face", kind: "face", x: .72, y: .53, width: .09, height: .17 }, { id: "reiji-face", kind: "face", x: .68, y: .03, width: .11, height: .20 }, { id: "proof", kind: "evidence", x: .35, y: .48, width: .34, height: .40 }],
  [basename(A.reijiShock)]: [{ id: "reiji-face", kind: "face", x: .52, y: .02, width: .30, height: .51 }],
  [basename(A.mioSend)]: [{ id: "ren-face", kind: "face", x: .07, y: .24, width: .10, height: .18 }, { id: "mio-face", kind: "face", x: .27, y: .04, width: .20, height: .36 }, { id: "reiji-face", kind: "face", x: .74, y: .13, width: .10, height: .18 }, { id: "phone", kind: "evidence", x: .25, y: .39, width: .15, height: .23 }],
  [basename(A.consequence)]: [{ id: "mio-face", kind: "face", x: .48, y: .43, width: .05, height: .09 }, { id: "reiji-face", kind: "face", x: .75, y: .20, width: .08, height: .15 }],
  [basename(A.childMio)]: [{ id: "young-ren-face", kind: "face", x: .10, y: .31, width: .11, height: .19 }, { id: "young-mio-face", kind: "face", x: .50, y: .01, width: .27, height: .44 }, { id: "camera", kind: "evidence", x: .57, y: .67, width: .14, height: .19 }],
  [basename(A.childRen)]: [{ id: "young-ren-face", kind: "face", x: .22, y: .01, width: .25, height: .43 }, { id: "young-mio-face", kind: "face", x: .77, y: .43, width: .10, height: .18 }],
  [basename(A.childTop)]: [{ id: "young-mio-face", kind: "face", x: .40, y: .28, width: .07, height: .11 }, { id: "young-ren-face", kind: "face", x: .51, y: .25, width: .07, height: .11 }, { id: "camera", kind: "evidence", x: .42, y: .44, width: .05, height: .09 }],
  [basename(A.studio)]: [{ id: "ren-face", kind: "face", x: .51, y: .19, width: .11, height: .20 }, { id: "mio-face", kind: "face", x: .74, y: .03, width: .18, height: .34 }],
  [basename(A.mioLove)]: [{ id: "mio-face", kind: "face", x: .50, y: .02, width: .29, height: .50 }],
  [basename(A.closing)]: [{ id: "ren-face", kind: "face", x: .25, y: .16, width: .10, height: .18 }, { id: "mio-face", kind: "face", x: .38, y: .17, width: .10, height: .18 }],
};

const layout = {
  "cut-01-u01": ["right", ["写真は、光がそこに", "あったことを証明する。"]],
  "cut-01-u02": ["right", ["けれど、写した人の", "名前まで守ってくれる", "わけではない。"]],
  "cut-01-u03": ["right", ["雨、強くなったな。", "閉店前に、この現像だけ", "終わらせよう"]],
  "cut-02-u01": ["right", ["商店街の古い写真店で、", "蓮は色あせた家族写真を", "一枚ずつ補修していた。"]],
  "cut-02-u02": ["right", ["思い出は新品に", "できません。でも、もう一度", "見える形には戻せます"]],
  "cut-03-u01": ["left", ["その言い方、", "昔と変わらないね"]],
  "cut-03-u02": ["right", ["澪なのか？", "東京にいるはずじゃ︙"]],
  "cut-03-u03": ["left", ["帰ってきたの。", "行く場所はあるのに、", "帰りたい場所が分からなくなって"]],
  "cut-04-u01": ["left", ["私が撮った写真を、", "恋人だった神谷さんが", "自分の作品として発表したの"]],
  "cut-04-u02": ["right", ["元データか、", "撮影した日を証明できる", "ものは？"]],
  "cut-04-u03": ["left", ["全部向こうに", "預けたまま。", "信じていたから"]],
  "cut-05-u01": ["left", ["連絡を無視するから迎えに来た。", "君は僕の助手だ。", "勝手に帰られると困る"]],
  "cut-05-u02": ["right", ["彼女の作品を、", "あなたの名前で", "出したんですか？"]],
  "cut-05-u03": ["right", ["世に出したのは僕だ。", "名前なんて、", "売れる側のものだろう"]],
  "cut-06-u01": ["left", ["私は戻らない。", "あの写真は、祖母の最後の夏を", "撮った大切な記録なの"]],
  "cut-06-u02": ["left", ["感情で仕事を", "失うつもりか？", "この町に君の居場所なんてない"]],
  "cut-07-u01": ["right", ["ある。澪が十年前に", "預けたネガです"]],
  "cut-07-u02": ["right", ["去年複製したデータも、", "作成日時も、", "依頼票も残っています"]],
  "cut-07-u03": ["left", ["そんな古い記録が、", "何になる"]],
  "cut-08-u01": ["right", ["展示の主催者へ送る。", "撮影者が誰か、", "私の名前で確かめてもらう"]],
  "cut-08-u02": ["left", ["翌週、展示は中止され、", "神谷との契約も", "解除された。"]],
  "cut-08-u03": ["left", ["彼が借りた光は、", "彼自身を照らし返した。"]],
  "cut-09-u01": ["left", ["私が遠くに行っても、", "写真を捨てないでね"]],
  "cut-09-u02": ["right", ["捨てない。いつか", "帰ってきたら、", "ちゃんと返す"]],
  "cut-09-u03": ["right", ["子供の約束は未来を", "縛らず、帰る道に小さな", "灯りを残すことがある。"]],
  "cut-10-u01": ["left", ["店の二階、空いてるよね。", "ここで写真スタジオを", "始めたい"]],
  "cut-10-u02": ["left", ["それから︙", "今度は、", "蓮の隣にいたい"]],
  "cut-10-u03": ["right", ["おかえり。", "仕事も、その先も、", "ゆっくり一緒に決めよう"]],
  "cut-10-u04": ["right", ["雨上がりの商店街で、", "二人の新しい一枚目が", "静かに写真になっていった。"]],
};

const speakerFace = {
  "cut-01-u03": "ren-face", "cut-02-u02": "ren-face", "cut-03-u01": "mio-face",
  "cut-03-u02": "ren-face", "cut-03-u03": "mio-face", "cut-04-u01": "mio-face",
  "cut-04-u02": "ren-face", "cut-04-u03": "mio-face", "cut-05-u01": "reiji-face",
  "cut-05-u02": "ren-face", "cut-05-u03": "reiji-face", "cut-06-u01": "mio-face",
  "cut-06-u02": "reiji-face", "cut-07-u01": "ren-face", "cut-07-u02": "ren-face",
  "cut-07-u03": "reiji-face", "cut-08-u01": "mio-face", "cut-09-u01": "young-mio-face",
  "cut-09-u02": "young-ren-face", "cut-10-u01": "mio-face", "cut-10-u02": "mio-face",
  "cut-10-u03": "ren-face",
};

function normalizedText(value) {
  return String(value ?? "")
    .replace(/\r?\n/gu, "")
    .replace(/\s+/gu, "")
    .replace(/\.{2,}|…+|⋯+|・{3,}/gu, "︙")
    .replace(/!/gu, "！")
    .replace(/\?/gu, "？");
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.video = {
  ...(manifest.video || {}),
  bgmPath: "",
  bgmVolume: 0,
  bubbleTransitionGapSeconds: 0,
  bubbleTransitionCrossfadeSeconds: 0.1,
  bubbleFadeInMilliseconds: 90,
  bubbleFadeOutMilliseconds: 90,
  fileName: "manga-photo-homecoming-001-v16-reference-touch-clean-audio-r1.mp4",
  statusAfterRender: "final-review-candidate-v16-reference-touch-r1",
};

for (const cut of manifest.cuts || []) {
  cut.cameraSequence = sequenceByCut[cut.id];
  if (!cut.cameraSequence) throw new Error(`Missing V16 sequence for ${cut.id}`);
  cut.imagePath = cut.cameraSequence[0].imagePath;
  cut.motion = cut.cameraSequence[0].motion;
  cut.camera = cut.cameraSequence[0].camera;
  cut.imageGeneration = {
    status: "approved-v16-reference-touch",
    route: "gpt-image-2-codex",
    visualProfileId: "manga-channel-reference-video-v1+user-child-touch",
    adoptedAt: new Date().toISOString(),
  };
  if (cut.thoughtFocus) cut.thoughtFocus = { ...cut.thoughtFocus, enabled: false, opacity: 0, faceBrightness: 0 };
}

const cuts = new Map(manifest.cuts.map((cut) => [cut.id, cut]));
const audit = [];
for (const utterance of manifest.utterances || []) {
  if (utterance.id === "cut-05-u02") utterance.text = "彼女の作品を、あなたの名前で出したんですか？";
  const cut = cuts.get(utterance.cutId);
  const selected = cut.cameraSequence.find((entry) => entry.utteranceIds.includes(utterance.id));
  const annotated = regions[basename(selected.imagePath)];
  if (!annotated) throw new Error(`No regions for ${selected.imagePath}`);
  const [lane, columns] = layout[utterance.id] || [];
  if (!lane || !columns) throw new Error(`No editorial layout for ${utterance.id}`);
  const activeFaceId = speakerFace[utterance.id];
  const avoidRegions = annotated.map((region) => (
    region.kind === "face" && activeFaceId && region.id !== activeFaceId
      ? { ...region, kind: "listener", weight: 20 }
      : region
  ));
  const spec = JSON.parse(await readFile(utterance.overlaySpecPath, "utf8"));
  const oldBubble = spec.bubble || {};
  const activeFace = annotated.find((region) => region.id === activeFaceId);
  const bubble = {
    ...oldBubble,
    bounds: undefined,
    id: utterance.bubbleId || `bubble-${utterance.id}`,
    order: utterance.order,
    text: utterance.text,
    preset: utterance.preset,
    utteranceId: utterance.id,
    tail: false,
    placementSide: lane,
    columns,
    maxColumns: 3,
    speakerHint: {
      ...(oldBubble.speakerHint || {}),
      position: activeFace ? (activeFace.x + activeFace.width / 2 < .5 ? "left" : "right") : "center",
      faceBand: "upper",
      ...(activeFace ? { faceBounds: activeFace } : {}),
    },
  };
  const rendered = renderSpeechBubbleSvg({
    width: spec.imageSize?.width || 1672,
    height: spec.imageSize?.height || 941,
    bubbles: [bubble],
    avoidRegions,
    profileId: "reference-video-v1",
    title: `${manifest.title} ${utterance.id} V16`,
  });
  const quality = rendered.quality[0];
  if (quality.overflow || quality.textLoss || quality.tooSmall || quality.faceOverlapRatio > .005 || quality.importantOverlapRatio > .10) {
    throw new Error(`V16 bubble gate failed for ${utterance.id}: ${JSON.stringify(quality)}`);
  }
  if (quality.columnTexts.join("") !== normalizedText(utterance.text)) {
    throw new Error(`V16 semantic columns changed text for ${utterance.id}`);
  }
  await writeFile(utterance.overlayPath, rendered.svg, "utf8");
  await writeFile(utterance.overlaySpecPath, `${JSON.stringify({
    ...spec,
    version: "v16-reference-video-locked",
    imagePath: selected.imagePath,
    cameraShotId: selected.id,
    cameraAngle: selected.angle,
    avoidRegions,
    bubble,
    plan: rendered.plan,
    quality: rendered.quality,
    profile: rendered.profile,
    punctuationPolicy: "dialogue-terminal-full-stop-omitted; narration-terminal-full-stop-kept; question-exclamation-ellipsis-preserved",
    lineBreakPolicy: "semantic-phrase-locked-v3",
    transitionPolicy: "90ms alpha fades with 100ms bubble crossfade",
    refreshedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  delete utterance.rasterizedOverlayPath;
  audit.push({
    utteranceId: utterance.id,
    shotId: selected.id,
    imagePath: selected.imagePath,
    lane,
    columns: quality.columnTexts,
    activeSpeakerFaceId: activeFaceId || null,
    quality,
  });
}

manifest.status = "v16-reference-plan-ready";
manifest.production = {
  ...(manifest.production || {}),
  version: "v16-reference-touch",
  referenceVideos: [
    "https://www.youtube.com/watch?v=awAbZyTeE4g",
    "https://www.youtube.com/watch?v=2ycRncs4CKY",
  ],
  bubblePolicy: {
    activeSpeakerFaceOverlapAllowed: false,
    listenerOverlapAllowedWhenNeeded: true,
    semanticLineBreaksLocked: true,
    artificialBackgroundDarkening: false,
    crossfadeSeconds: .1,
  },
  cameraPolicy: {
    shotMix: { environmentWide: .32, mediumTwoShot: .40, closeUp: .28 },
    neutralColorGrade: true,
    wideMeansSpatiallyWiderShotNotDigitalCrop: true,
    cameraMotionReferenceMedianZoomPercentPerSecond: .3121,
  },
  audioPolicy: {
    elevenLabsVoicesUnprocessedExceptEdgeClickFades: true,
    backgroundMusicRemoved: true,
  },
  ossStack: [
    { name: "FFmpeg", role: "camera motion, alpha bubble crossfades, H.264/AAC render" },
    { name: "OpenCV", role: "reference luma, saturation and edge-density QA" },
    { name: "NumPy", role: "reference distribution comparison" },
    { name: "SVG/Chromium", role: "deterministic vertical Japanese bubble overlays" },
  ],
};
if (manifest.outputs?.reviewVideo) delete manifest.outputs.reviewVideo;
manifest.updatedAt = new Date().toISOString();

await writeFile(join(rootDir, "v16-reference-plan-audit.json"), `${JSON.stringify({
  version: "v16-reference-touch",
  shotCount: Object.values(sequenceByCut).flat().length,
  overlayCount: audit.length,
  activeFaceSafeCount: audit.filter((row) => row.quality.faceOverlapRatio <= .005).length,
  semanticTextExactCount: audit.filter((row) => row.columns.join("") === normalizedText(
    manifest.utterances.find((utterance) => utterance.id === row.utteranceId)?.text,
  )).length,
  rows: audit,
}, null, 2)}\n`, "utf8");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({
  manifestPath,
  status: manifest.status,
  shotCount: Object.values(sequenceByCut).flat().length,
  overlayCount: audit.length,
  activeFaceSafeCount: audit.filter((row) => row.quality.faceOverlapRatio <= .005).length,
}, null, 2)}\n`);
