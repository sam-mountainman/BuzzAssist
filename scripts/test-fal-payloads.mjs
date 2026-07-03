import { previewFalImageRequest, previewFalVideoRequest } from "../lib/falMediaGeneration.mjs";
import { estimateCreditsForJob } from "../lib/mediaCredits.mjs";

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = Object.entries(expected).every(([key, value]) => {
    const got = key.includes(".") ? key.split(".").reduce((acc, part) => acc?.[part], actual) : actual[key];
    return JSON.stringify(got) === JSON.stringify(value);
  });
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  }
}

function checkThrows(label, fn, pattern) {
  try {
    fn();
    failed += 1;
    console.error(`FAIL ${label}: expected error matching ${pattern}`);
  } catch (error) {
    if (pattern.test(String(error.message))) passed += 1;
    else {
      failed += 1;
      console.error(`FAIL ${label}: error "${error.message}" does not match ${pattern}`);
    }
  }
}

const REF = "/tmp/ref.png";
const REF_VIDEO = "/tmp/ref.mp4";
const REF_AUDIO = "/tmp/ref.wav";

// --- images ---
check("nano-banana-2 gen", previewFalImageRequest({ prompt: "p", model: "nano-banana-2", aspectRatio: "16:9", imageSize: "2K" }), {
  endpoint: "fal-ai/nano-banana-2",
  "body.aspect_ratio": "16:9",
  "body.resolution": "2K",
  "body.safety_tolerance": "4",
});
check("nano-banana-2 edit", previewFalImageRequest({ prompt: "p", model: "nano-banana-2", referenceImagePaths: [REF] }), {
  endpoint: "fal-ai/nano-banana-2/edit",
});
check("gpt-image-2 gen", previewFalImageRequest({ prompt: "p", model: "gpt-image-2", aspectRatio: "1:1", quality: "auto" }), {
  endpoint: "fal-ai/gpt-image-2",
  "body.quality": "medium",
  "body.image_size": { width: 1024, height: 1024 },
});
check("gpt-image-2 edit", previewFalImageRequest({ prompt: "p", model: "gpt-image-2", quality: "high", referenceImagePaths: [REF] }), {
  endpoint: "openai/gpt-image-2/edit",
  "body.quality": "high",
});
check("seedream gen 2K 16:9", previewFalImageRequest({ prompt: "p", model: "seedream-v5-lite", aspectRatio: "16:9", imageSize: "2K" }), {
  endpoint: "fal-ai/bytedance/seedream/v5/lite/text-to-image",
  "body.image_size": { width: 2912, height: 1632 },
  "body.max_images": 1,
});
check("seedream edit no 0.5K", previewFalImageRequest({ prompt: "p", model: "seedream-v5-lite", imageSize: "0.5K", referenceImagePaths: [REF] }), {
  endpoint: "fal-ai/bytedance/seedream/v5/lite/edit",
  "body.image_size": { width: 1024, height: 1024 },
});
check("grok image quality gen", previewFalImageRequest({ prompt: "p", model: "grok-imagine-image-api", quality: "auto", imageSize: "2K" }), {
  endpoint: "xai/grok-imagine-image/quality/text-to-image",
  "body.resolution": "2k",
});
check("grok image standard edit", previewFalImageRequest({ prompt: "p", model: "grok-imagine-image-api", quality: "standard", referenceImagePaths: [REF] }), {
  endpoint: "xai/grok-imagine-image/edit",
});
checkThrows("grok image >3 refs", () => previewFalImageRequest({ prompt: "p", model: "grok-imagine-image-api", referenceImagePaths: ["/a.png", "/b.png", "/c.png", "/d.png"] }), /up to 3/);

// --- videos ---
check("grok t2v", previewFalVideoRequest({ prompt: "p", model: "grok-imagine-video-api", duration: "20", resolution: "720p" }), {
  endpoint: "xai/grok-imagine-video/text-to-video",
  "body.duration": 15,
});
check("grok i2v", previewFalVideoRequest({ prompt: "p", model: "grok-imagine-video-api", startFramePath: REF }), {
  endpoint: "xai/grok-imagine-video/image-to-video",
});
check("grok ref clamps 10", previewFalVideoRequest({ prompt: "p", model: "grok-imagine-video-api", useReference: true, referenceImagePaths: [REF], duration: "15" }), {
  endpoint: "xai/grok-imagine-video/reference-to-video",
  "body.duration": 10,
});
checkThrows("grok end frame", () => previewFalVideoRequest({ prompt: "p", model: "grok-imagine-video-api", startFramePath: REF, endFramePath: REF }), /end-frame/);

check("seedance t2v", previewFalVideoRequest({ prompt: "p", model: "seedance-2", duration: "2", aspectRatio: "21:9" }), {
  endpoint: "bytedance/seedance-2.0/text-to-video",
  "body.duration": "4",
  "body.aspect_ratio": "21:9",
  "body.generate_audio": true,
});
check("seedance fast i2v + end", previewFalVideoRequest({ prompt: "p", model: "seedance-2-fast", startFramePath: REF, endFramePath: REF, duration: "6" }), {
  endpoint: "bytedance/seedance-2.0/fast/image-to-video",
  "body.duration": "6",
  "body.end_image_url": "https://preview.invalid/image/ref.png",
});
check("seedance ref + audio", previewFalVideoRequest({ prompt: "p", model: "seedance-2", useReference: true, referenceImagePaths: [REF], referenceVideoPaths: [REF_VIDEO], referenceAudioPaths: [REF_AUDIO] }), {
  endpoint: "bytedance/seedance-2.0/reference-to-video",
  "body.image_urls": ["https://preview.invalid/image/ref.png"],
  "body.video_urls": ["https://preview.invalid/video/ref.mp4"],
  "body.audio_urls": ["https://preview.invalid/audio/ref.wav"],
});

check("kling v3 t2v standard", previewFalVideoRequest({ prompt: "p", model: "kling-v3", duration: "4" }), {
  endpoint: "fal-ai/kling-video/v3/standard/text-to-video",
  "body.duration": 4,
});
check("kling v3 i2v pro", previewFalVideoRequest({ prompt: "p", model: "kling-v3", mode: "pro", startFramePath: REF, endFramePath: REF }), {
  endpoint: "fal-ai/kling-video/v3/pro/image-to-video",
  "body.start_image_url": "https://preview.invalid/image/ref.png",
  "body.end_image_url": "https://preview.invalid/image/ref.png",
});
checkThrows("kling v3 no reference", () => previewFalVideoRequest({ prompt: "p", model: "kling-v3", useReference: true, referenceImagePaths: [REF] }), /reference/);

check("kling o3 video ref", previewFalVideoRequest({ prompt: "p", model: "kling-o3", useReference: true, referenceVideoPaths: [REF_VIDEO], referenceImagePaths: [REF] }), {
  endpoint: "fal-ai/kling-video/o3/standard/video-to-video/reference",
  "body.video_url": "https://preview.invalid/video/ref.mp4",
  "body.keep_audio": false,
});
check("kling o3 image ref pro", previewFalVideoRequest({ prompt: "p", model: "kling-o3", mode: "pro", useReference: true, referenceImagePaths: [REF] }), {
  endpoint: "fal-ai/kling-video/o3/pro/reference-to-video",
});

check("kling v2.6 t2v snaps duration", previewFalVideoRequest({ prompt: "p", model: "kling-v2-6", duration: "8" }), {
  endpoint: "fal-ai/kling-video/v2.6/pro/text-to-video",
  "body.duration": 10,
});
check("kling v2.6 motion standard", previewFalVideoRequest({ prompt: "p", model: "kling-v2-6", useMotion: true, startFramePath: REF, referenceVideoPaths: [REF_VIDEO], motionOrientation: "video" }), {
  endpoint: "fal-ai/kling-video/v2.6/standard/motion-control",
  "body.character_orientation": "video",
  "body.keep_original_sound": true,
});
check("kling v2.6 motion pro", previewFalVideoRequest({ prompt: "p", model: "kling-v2-6", mode: "pro", useMotion: true, startFramePath: REF, referenceVideoPaths: [REF_VIDEO] }), {
  endpoint: "fal-ai/kling-video/v2.6/pro/motion-control",
  "body.character_orientation": "image",
});
checkThrows("kling v2.6 motion needs inputs", () => previewFalVideoRequest({ prompt: "p", model: "kling-v2-6", useMotion: true }), /requires a start image/);

// --- credit estimates sanity ---
const seedance = estimateCreditsForJob({ kind: "video", model: "seedance-2", duration: "5", resolution: "720p" });
check("seedance credits", seedance, { credits: 78 });
const banana = estimateCreditsForJob({ kind: "image", model: "nano-banana-2", imageSize: "1K" });
check("nano-banana credits", banana, { credits: 5 });
const subtitle = estimateCreditsForJob({ kind: "subtitle", model: "elevenlabs-scribe-v2", durationSeconds: 60 });
check("subtitle credits", subtitle, { credits: 1 });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
