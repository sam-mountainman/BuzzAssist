#!/usr/bin/env node
import { access, copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { normalizeCameraShotSequence } from "../lib/mangaVideoPipeline.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const manifestPath = resolve(process.argv[3] || join(
  projectDir,
  "canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json",
));
const episodeDir = dirname(manifestPath);
const backupPath = join(episodeDir, "episode-manifest-v22-natural-dialogue-r1-backup.json");
const planPath = join(episodeDir, "v23-semantic-start-camera-plan.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
try {
  await access(backupPath);
} catch {
  await copyFile(manifestPath, backupPath);
}

const utteranceById = new Map(manifest.utterances.map((utterance) => [utterance.id, utterance]));
const keyFor = (cutId, utteranceIds) => `${cutId}:${utteranceIds.join(",")}`;
const point = (label, x, y, rx = .055, ry = .10) => ({ label, x, y, rx, ry });

// Each profile starts on the current speaker/story object.  A different end
// target is only authored when the script explicitly hands attention to that
// person or when a sustained image earns an environmental reveal.
const profiles = new Map([
  [keyFor("cut-01", ["cut-01-u01", "cut-01-u02"]), {
    mode: "pullout-only", angle: "wide", zoomStart: 1.48, zoomEnd: 1.18,
    startFocus: [.46, .49], endFocus: [.46, .49], easing: "smoothstep",
    startSubject: point("補修中の蓮と写真", .25, .43, .11, .20),
    endSubject: point("雨の写真店全景", .50, .48, .20, .25),
    purpose: "物語の核になる写真と作業中の蓮から、雨の写真店全体へ純粋に引く",
  }],
  [keyFor("cut-01", ["cut-01-u03"]), {
    mode: "left-only", angle: "left", zoomStart: 1.44, zoomEnd: 1.44,
    startFocus: [.52, .38], endFocus: [.60, .38], easing: "soft-linear",
    startSubject: point("話している蓮", .54, .24, .075, .13),
    endSubject: point("蓮と現像写真", .58, .43, .12, .20),
    utteranceTargets: { "cut-01-u03": point("蓮", .54, .24, .075, .13) },
    purpose: "蓮の顔から作業中の写真へ左側面の関係を保って流す",
  }],
  [keyFor("cut-02", ["cut-02-u01", "cut-02-u02"]), {
    mode: "pullout-plus-top", angle: "top", zoomStart: 1.65, zoomEnd: 1.18,
    startFocus: [.50, .58], endFocus: [.50, .50], easing: "smoothstep",
    startSubject: point("蓮の手元と家族写真", .31, .59, .13, .16),
    endSubject: point("補修台と証拠の全体", .50, .52, .23, .25),
    utteranceTargets: { "cut-02-u02": point("蓮", .29, .27, .07, .12) },
    purpose: "補修する手元から机全体へトップビューのまま大きく引く",
  }],
  [keyFor("cut-03", ["cut-03-u01", "cut-03-u02"]), {
    mode: "right-only", angle: "right", zoomStart: 1.58, zoomEnd: 1.58,
    startFocus: [.65, .39], endFocus: [.35, .39], easing: "ease-out-cubic",
    startSubject: point("最初に話す澪", .75, .25, .095, .16),
    endSubject: point("次に話す蓮", .28, .25, .06, .11),
    utteranceTargets: {
      "cut-03-u01": point("澪", .75, .25, .095, .16),
      "cut-03-u02": point("蓮", .28, .25, .06, .11),
    },
    purpose: "澪の最初の一言から、驚いて返す蓮へ右側面のまま渡す",
  }],
  [keyFor("cut-03", ["cut-03-u03"]), {
    mode: "pullout-only", angle: "right", zoomStart: 1.72, zoomEnd: 1.36,
    startFocus: [.60, .40], endFocus: [.60, .40], easing: "smoothstep",
    startSubject: point("帰る場所を語る澪", .69, .27, .09, .15),
    endSubject: point("澪と聞く蓮", .54, .36, .22, .22),
    utteranceTargets: { "cut-03-u03": point("澪", .69, .27, .09, .15) },
    purpose: "澪の告白を中心に保ち、聞く蓮まで純粋な引きで含める",
  }],
  [keyFor("cut-04", ["cut-04-u01", "cut-04-u02"]), {
    mode: "right-only", angle: "right", zoomStart: 1.58, zoomEnd: 1.58,
    startFocus: [.65, .38], endFocus: [.35, .38], easing: "ease-out-cubic",
    startSubject: point("盗用を告白する澪", .78, .25, .085, .15),
    endSubject: point("証拠を尋ねる蓮", .28, .28, .06, .11),
    utteranceTargets: {
      "cut-04-u01": point("澪", .78, .25, .085, .15),
      "cut-04-u02": point("蓮", .28, .28, .06, .11),
    },
    purpose: "告白する澪から、証拠を尋ねる蓮へ話者交代に合わせて渡す",
  }],
  [keyFor("cut-04", ["cut-04-u03"]), {
    mode: "pullout-only", angle: "right", zoomStart: 1.54, zoomEnd: 1.22,
    startFocus: [.53, .43], endFocus: [.53, .43], easing: "smoothstep",
    startSubject: point("傷ついた澪", .54, .30, .15, .23),
    endSubject: point("澪と雨の余白", .54, .42, .23, .28),
    utteranceTargets: { "cut-04-u03": point("澪", .54, .30, .15, .23) },
    purpose: "澪の表情から逃げず、感情の余白だけを純粋な引きで広げる",
  }],
  [keyFor("cut-05", ["cut-05-u01", "cut-05-u02"]), {
    mode: "pullout-plus-right", angle: "right-wide", zoomStart: 1.72, zoomEnd: 1.16,
    startFocus: [.69, .43], endFocus: [.45, .47], easing: "ease-out-cubic",
    startSubject: point("先に圧力をかける礼司", .86, .27, .065, .12),
    endSubject: point("問い返す蓮を含む三者", .15, .32, .055, .11),
    utteranceTargets: {
      "cut-05-u01": point("礼司", .86, .27, .065, .12),
      "cut-05-u02": point("蓮", .15, .32, .055, .11),
    },
    purpose: "礼司の圧力から始め、引きながら蓮の問い返しと三者関係を明かす",
  }],
  [keyFor("cut-05", ["cut-05-u03"]), {
    mode: "right-only", angle: "right", zoomStart: 1.65, zoomEnd: 1.65,
    startFocus: [.34, .39], endFocus: [.40, .39], easing: "soft-linear",
    startSubject: point("傲慢に言い切る礼司", .15, .29, .12, .18),
    endSubject: point("礼司の横顔と空間", .23, .34, .16, .22),
    utteranceTargets: { "cut-05-u03": point("礼司", .15, .29, .12, .18) },
    purpose: "礼司の横顔を外さず、右側面の空間だけを一方向に見せる",
  }],
  [keyFor("cut-06", ["cut-06-u01", "cut-06-u02"]), {
    mode: "pullout-plus-right", angle: "right-wide", zoomStart: 1.64, zoomEnd: 1.30,
    startFocus: [.50, .44], endFocus: [.59, .46], easing: "ease-out-cubic",
    startSubject: point("拒絶する澪", .49, .32, .055, .11),
    endSubject: point("反撃する礼司", .84, .29, .055, .11),
    utteranceTargets: {
      "cut-06-u01": point("澪", .49, .32, .055, .11),
      "cut-06-u02": point("礼司", .84, .29, .055, .11),
    },
    purpose: "澪の拒絶から始め、引きながら右の礼司の反撃へ渡す",
  }],
  [keyFor("cut-07", ["cut-07-u01", "cut-07-u02"]), {
    mode: "pullout-plus-top", angle: "top", zoomStart: 1.72, zoomEnd: 1.18,
    startFocus: [.31, .64], endFocus: [.50, .50], easing: "ease-in-cubic",
    startSubject: point("話す蓮とネガ", .18, .64, .025, .06),
    endSubject: point("ネガ・日時・依頼票の全体", .50, .54, .25, .25),
    utteranceTargets: {
      "cut-07-u01": point("蓮", .18, .64, .025, .06),
      "cut-07-u02": point("蓮", .18, .64, .025, .06),
    },
    purpose: "証拠を示す蓮から始め、トップビューの引きで資料の関係を開示する",
  }],
  [keyFor("cut-07", ["cut-07-u03"]), {
    imagePath: join(projectDir, "canvas/assets/manga-photo-homecoming-001-v16-cut-07-top-evidence-proof.png"),
    mode: "pullout-only", angle: "top", zoomStart: 1.58, zoomEnd: 1.42,
    startFocus: [.50, .39], endFocus: [.50, .39], easing: "smoothstep",
    startSubject: point("証拠を見下ろす礼司", .51, .17, .035, .06),
    endSubject: point("礼司と証拠の関係", .51, .35, .15, .22),
    utteranceTargets: { "cut-07-u03": point("礼司", .51, .17, .035, .06) },
    purpose: "同じトップ画像を保ち、礼司の反応から証拠との関係へ純粋に引く",
  }],
  [keyFor("cut-08", ["cut-08-u01"]), {
    mode: "top-only", angle: "top", zoomStart: 1.55, zoomEnd: 1.55,
    startFocus: [.45, .35], endFocus: [.47, .54], easing: "soft-linear",
    startSubject: point("話す澪", .45, .24, .07, .12),
    endSubject: point("送信するスマートフォン", .47, .60, .09, .11),
    utteranceTargets: { "cut-08-u01": point("澪", .45, .24, .07, .12) },
    purpose: "話す澪の顔から、実行する手元へトップ方向を一貫して移す",
  }],
  [keyFor("cut-08", ["cut-08-u02", "cut-08-u03"]), {
    mode: "pullout-only", angle: "wide", zoomStart: 1.52, zoomEnd: 1.16,
    startFocus: [.53, .48], endFocus: [.53, .48], easing: "smoothstep",
    startSubject: point("契約を失った礼司", .55, .31, .055, .11),
    endSubject: point("中止された展示空間", .53, .48, .27, .30),
    purpose: "礼司の結果から展示空間全体へ純粋に引き、社会的な帰結を見せる",
  }],
  [keyFor("cut-09", ["cut-09-u01"]), {
    mode: "right-only", angle: "right", zoomStart: 1.55, zoomEnd: 1.55,
    startFocus: [.55, .39], endFocus: [.38, .39], easing: "soft-linear",
    startSubject: point("先に話す幼い澪", .56, .25, .10, .16),
    endSubject: point("約束を受け取る幼い蓮", .15, .39, .055, .11),
    utteranceTargets: { "cut-09-u01": point("幼い澪", .56, .25, .10, .16) },
    purpose: "幼い澪の約束から、受け取る蓮へ右側面のまま視線を送る",
  }],
  [keyFor("cut-09", ["cut-09-u02"]), {
    mode: "left-only", angle: "left", zoomStart: 1.58, zoomEnd: 1.58,
    startFocus: [.43, .39], endFocus: [.66, .39], easing: "soft-linear",
    startSubject: point("返事をする幼い蓮", .43, .25, .10, .16),
    endSubject: point("返事を聞く幼い澪", .88, .43, .045, .09),
    utteranceTargets: { "cut-09-u02": point("幼い蓮", .43, .25, .10, .16) },
    purpose: "幼い蓮の返事から、聞く澪へ左側面のまま視線を返す",
  }],
  [keyFor("cut-09", ["cut-09-u03"]), {
    mode: "pullout-plus-top", angle: "top-wide", zoomStart: 1.60, zoomEnd: 1.12,
    startFocus: [.52, .56], endFocus: [.50, .50], easing: "smoothstep",
    startSubject: point("約束を交わした二人", .52, .55, .13, .18),
    endSubject: point("雨上がりの帰り道", .50, .50, .28, .30),
    purpose: "二人の約束から、帰る道全体へトップビューのまま大きく引く",
  }],
  [keyFor("cut-10", ["cut-10-u01"]), {
    mode: "right-only", angle: "right", zoomStart: 1.58, zoomEnd: 1.58,
    startFocus: [.65, .38], endFocus: [.46, .40], easing: "soft-linear",
    startSubject: point("提案する澪", .72, .24, .095, .16),
    endSubject: point("蓮とカメラとスタジオ", .39, .40, .17, .22),
    utteranceTargets: { "cut-10-u01": point("澪", .72, .24, .095, .16) },
    purpose: "提案する澪から、蓮とカメラが作る次の仕事へ右側面のまま流す",
  }],
  [keyFor("cut-10", ["cut-10-u02"]), {
    imagePath: join(projectDir, "canvas/assets/manga-photo-homecoming-001-v16-cut-10-medium-mio-studio.png"),
    mode: "pullout-only", angle: "right", zoomStart: 1.70, zoomEnd: 1.36,
    startFocus: [.60, .40], endFocus: [.60, .40], easing: "smoothstep",
    startSubject: point("告白する澪", .72, .24, .095, .16),
    endSubject: point("澪と告白を受け止める蓮", .55, .37, .22, .23),
    utteranceTargets: { "cut-10-u02": point("澪", .72, .24, .095, .16) },
    purpose: "同じスタジオ画像で澪へ寄り直し、告白から聞く蓮まで純粋に引く",
  }],
  [keyFor("cut-10", ["cut-10-u03", "cut-10-u04"]), {
    mode: "pullout-plus-wide", angle: "wide", zoomStart: 1.72, zoomEnd: 1.16,
    startFocus: [.42, .40], endFocus: [.50, .48], easing: "smoothstep",
    startSubject: point("先に返事をする蓮", .31, .25, .055, .11),
    endSubject: point("二人と新しい写真店", .38, .42, .16, .24),
    utteranceTargets: { "cut-10-u03": point("蓮", .31, .25, .055, .11) },
    purpose: "蓮の返事から始め、長い結びで二人と新しい店全体へ引いて開く",
  }],
]);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const rounded = (value, digits = 6) => Number(value.toFixed(digits));
const smoothstep = (value) => value * value * (3 - 2 * value);
const eased = (value, easing) => {
  const progress = clamp(value, 0, 1);
  if (easing === "smoothstep") return smoothstep(progress);
  if (easing === "soft-linear") return .82 * progress + .18 * smoothstep(progress);
  if (easing === "ease-in-cubic") return progress ** 3;
  if (easing === "ease-out-cubic") return 1 - ((1 - progress) ** 3);
  return progress;
};
const SOURCE_EDGE_BUFFER = .014;
const cameraAt = (camera, timeRatio) => {
  const progress = eased(timeRatio, camera.easing);
  return {
    progress,
    zoom: camera.zoomStart + (camera.zoomEnd - camera.zoomStart) * progress,
    focusX: camera.focusX + (camera.focusXEnd - camera.focusX) * progress,
    focusY: camera.focusY + (camera.focusYEnd - camera.focusY) * progress,
  };
};
const targetInViewport = (target, cameraState) => {
  const half = 1 / (2 * cameraState.zoom);
  const left = cameraState.focusX - half;
  const top = cameraState.focusY - half;
  return {
    centerX: (target.x - left) * cameraState.zoom,
    centerY: (target.y - top) * cameraState.zoom,
    radiusX: target.rx * cameraState.zoom,
    radiusY: target.ry * cameraState.zoom,
  };
};
const overlapRatio = (subject, bubble) => {
  const subjectBox = {
    left: subject.centerX - subject.radiusX,
    right: subject.centerX + subject.radiusX,
    top: subject.centerY - subject.radiusY,
    bottom: subject.centerY + subject.radiusY,
  };
  const width = Math.max(0, Math.min(subjectBox.right, bubble.right) - Math.max(subjectBox.left, bubble.left));
  const height = Math.max(0, Math.min(subjectBox.bottom, bubble.bottom) - Math.max(subjectBox.top, bubble.top));
  return width * height / Math.max(1e-8, (subjectBox.right - subjectBox.left) * (subjectBox.bottom - subjectBox.top));
};
async function bubbleBounds(utterance) {
  const svg = await readFile(utterance.overlayPath, "utf8");
  const width = Number(svg.match(/<svg[^>]*\bwidth=["']([0-9.]+)/u)?.[1] || 1920);
  const height = Number(svg.match(/<svg[^>]*\bheight=["']([0-9.]+)/u)?.[1] || 1080);
  const d = svg.match(/<path\s+[^>]*\bd=["']([^"']+)["']/u)?.[1] || "";
  const values = [...d.matchAll(/-?\d+(?:\.\d+)?/gu)].map((match) => Number(match[0]));
  if (values.length < 4) return null;
  const xs = values.filter((_, index) => index % 2 === 0);
  const ys = values.filter((_, index) => index % 2 === 1);
  return {
    left: Math.min(...xs) / width,
    right: Math.max(...xs) / width,
    top: Math.min(...ys) / height,
    bottom: Math.max(...ys) / height,
  };
}

for (const cut of manifest.cuts) {
  cut.cameraSequence = cut.cameraSequence.map((shot) => {
    const key = keyFor(cut.id, shot.utteranceIds || []);
    const profile = profiles.get(key);
    if (!profile) throw new Error(`Missing V23 semantic profile for ${key}`);
    const camera = {
      zoomStart: profile.zoomStart,
      zoomEnd: profile.zoomEnd,
      focusX: profile.startFocus[0],
      focusY: profile.startFocus[1],
      focusXEnd: profile.endFocus[0],
      focusYEnd: profile.endFocus[1],
      easing: profile.easing,
      motionLeadRatio: 0,
      motionTailRatio: 0,
      saturation: 1,
      contrast: 1,
      brightness: 0,
    };
    return {
      ...shot,
      id: String(shot.id).replace(/v21-master/u, "v23-semantic"),
      imagePath: profile.imagePath || shot.imagePath,
      angle: profile.angle,
      motion: profile.mode,
      cameraMode: profile.mode,
      camera,
      semanticStartSubject: profile.startSubject.label,
      semanticEndSubject: profile.endSubject.label,
      editorialPurpose: profile.purpose,
      reason: `${profile.purpose}。全フレームで安全余白を保ち、終端の別方向フォールバックは行わない`,
    };
  });
  cut.imagePath = cut.cameraSequence[0].imagePath;
  cut.motion = cut.cameraSequence[0].motion;
  cut.camera = cut.cameraSequence[0].camera;
}

const rows = [];
for (const cut of manifest.cuts) {
  const cutUtterances = cut.utteranceIds.map((id) => utteranceById.get(id)).filter(Boolean);
  const normalized = normalizeCameraShotSequence(cut, cutUtterances, cut.timing?.durationSeconds);
  for (const shot of normalized) {
    const source = cut.cameraSequence.find((entry) => entry.id === shot.id);
    const profile = profiles.get(keyFor(cut.id, shot.utteranceIds));
    const camera = shot.camera;
    let minEdgeBuffer = Number.POSITIVE_INFINITY;
    let cropClampCollision = false;
    const samples = [];
    for (let index = 0; index <= 600; index += 1) {
      const state = cameraAt(camera, index / 600);
      const legalHalf = 1 / (2 * state.zoom);
      const edgeBuffer = Math.min(
        state.focusX - legalHalf,
        1 - legalHalf - state.focusX,
        state.focusY - legalHalf,
        1 - legalHalf - state.focusY,
      );
      minEdgeBuffer = Math.min(minEdgeBuffer, edgeBuffer);
      if (edgeBuffer < SOURCE_EDGE_BUFFER - 1e-7) cropClampCollision = true;
      samples.push(state);
    }
    const signReversalCount = ["zoom", "focusX", "focusY"].reduce((count, field) => {
      let previousSign = 0;
      let reversals = 0;
      for (let index = 1; index < samples.length; index += 1) {
        const delta = samples[index][field] - samples[index - 1][field];
        const sign = Math.abs(delta) < 1e-9 ? 0 : Math.sign(delta);
        if (sign && previousSign && sign !== previousSign) reversals += 1;
        if (sign) previousSign = sign;
      }
      return count + reversals;
    }, 0);
    const startViewport = targetInViewport(profile.startSubject, cameraAt(camera, 0));
    const endViewport = targetInViewport(profile.endSubject, cameraAt(camera, 1));
    const utteranceChecks = [];
    for (const utteranceId of shot.utteranceIds) {
      const target = profile.utteranceTargets?.[utteranceId];
      if (!target) continue;
      const utterance = utteranceById.get(utteranceId);
      const localSeconds = utterance.timing.audioStartInCutSeconds - shot.startSeconds;
      const localRatio = clamp(localSeconds / Math.max(.001, shot.durationSeconds), 0, 1);
      const state = cameraAt(camera, localRatio);
      const viewport = targetInViewport(target, state);
      const bubble = await bubbleBounds(utterance);
      const bubbleOverlapRatio = bubble ? overlapRatio(viewport, bubble) : 0;
      utteranceChecks.push({
        utteranceId,
        target: target.label,
        localRatio: rounded(localRatio, 4),
        cameraProgress: rounded(state.progress, 4),
        viewportCenterX: rounded(viewport.centerX, 4),
        viewportCenterY: rounded(viewport.centerY, 4),
        activeSpeakerVisible: viewport.centerX >= .04 && viewport.centerX <= .96
          && viewport.centerY >= .04 && viewport.centerY <= .96,
        bubbleOverlapRatio: rounded(bubbleOverlapRatio, 5),
        activeSpeakerClearOfBubble: bubbleOverlapRatio <= .025,
      });
    }
    rows.push({
      cutId: cut.id,
      shotId: shot.id,
      imagePath: shot.imagePath,
      utteranceIds: shot.utteranceIds,
      firstSpeakerId: utteranceById.get(shot.utteranceIds[0])?.speakerId,
      angle: source.angle,
      cameraMode: source.cameraMode,
      editorialPurpose: source.editorialPurpose,
      startSubject: source.semanticStartSubject,
      endSubject: source.semanticEndSubject,
      startSeconds: rounded(shot.startSeconds, 4),
      endSeconds: rounded(shot.endSeconds, 4),
      durationSeconds: rounded(shot.durationSeconds, 4),
      camera,
      startSubjectViewport: {
        x: rounded(startViewport.centerX, 4), y: rounded(startViewport.centerY, 4),
      },
      endSubjectViewport: {
        x: rounded(endViewport.centerX, 4), y: rounded(endViewport.centerY, 4),
      },
      minSourceEdgeBuffer: rounded(minEdgeBuffer, 6),
      cropClampCollision,
      signReversalCount,
      terminalFallbackAllowed: false,
      utteranceChecks,
    });
  }
}

if (rows.length !== 20) throw new Error(`Expected 20 semantic camera shots, found ${rows.length}`);
for (const row of rows) {
  if (row.cropClampCollision) throw new Error(`Crop boundary collision: ${row.shotId}`);
  if (row.signReversalCount > 0) throw new Error(`Camera path reverses direction: ${row.shotId}`);
  if (row.startSubjectViewport.x < .03 || row.startSubjectViewport.x > .97
      || row.startSubjectViewport.y < .03 || row.startSubjectViewport.y > .97) {
    throw new Error(`Semantic start subject is outside the frame: ${row.shotId}`);
  }
  for (const check of row.utteranceChecks) {
    if (!check.activeSpeakerVisible) throw new Error(`Active speaker is outside the frame: ${row.shotId}/${check.utteranceId}`);
    if (!check.activeSpeakerClearOfBubble) {
      throw new Error(`Active speaker overlaps the bubble: ${row.shotId}/${check.utteranceId} ratio=${check.bubbleOverlapRatio}`);
    }
  }
}

const counts = {
  pulloutOnly: rows.filter((row) => row.cameraMode === "pullout-only").length,
  directionalOnly: rows.filter((row) => ["left-only", "right-only", "top-only"].includes(row.cameraMode)).length,
  combined: rows.filter((row) => row.cameraMode.startsWith("pullout-plus-")).length,
  multiUtterance: rows.filter((row) => row.utteranceIds.length > 1).length,
  explicitSpeakerHandoffs: rows.filter((row) => row.utteranceChecks.length > 1).length,
};
const plan = {
  version: "v23-semantic-start-camera",
  referenceVideoIds: ["awAbZyTeE4g", "2ycRncs4CKY"],
  referenceEvidence: {
    reportPath: join(
      projectDir,
      "canvas/reference-media/love-manga/analysis/v23-reference-camera-grammar/reference-camera-grammar.json",
    ),
    validMovingSceneRatio: .8,
    multiCaptionVisualBeatRatio: .5866,
    inspectedSpeakerHandoffExample: {
      videoId: "2ycRncs4CKY",
      detectedSceneNumber: 14,
      durationSeconds: 6.707,
      startDominantFaceX: .1949,
      endDominantFaceX: .7543,
      measuredMode: "pullout-plus-horizontal",
    },
  },
  policy: {
    startOnCurrentSpeakerOrStoryObject: true,
    revealNextSpeakerOnlyWhenScriptHandsOff: true,
    sustainedImageMayUseCombination: true,
    terminalFallbackAllowed: false,
    cropClampCollisionAllowed: false,
    minimumSourceEdgeBuffer: SOURCE_EDGE_BUFFER,
    pathSamplesPerShot: 601,
    signReversalAllowed: false,
    cameraOversample: 3,
  },
  counts,
  rows,
};

manifest.video = {
  ...(manifest.video || {}),
  fileName: "manga-photo-homecoming-001-v23-semantic-camera-r1.mp4",
  statusAfterRender: "final-review-candidate-v23-semantic-camera-r1",
  cameraOversample: 3,
  cameraRendererRevision: "parenthesized-easing-fixed-crop-pan-r2",
};
manifest.status = "v23-semantic-camera-plan-ready";
manifest.production = {
  ...(manifest.production || {}),
  version: "v23-semantic-start-camera",
  cameraPolicy: plan.policy,
  cameraCounts: counts,
};
manifest.updatedAt = new Date().toISOString();

await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ manifestPath, backupPath, planPath, counts }, null, 2)}\n`);
