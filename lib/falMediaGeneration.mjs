import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { extForMimeType, mimeTypeForFile, nonEmptyString, sanitizeFileName } from "./canvasScene.mjs";
import { runFalQueueRequest, runFalSyncRequest, uploadBufferToFalStorage } from "./buzzassistApi.mjs";

export const FAL_IMAGE_MODELS = [
  { id: "nano-banana-2", label: "Nano Banana 2" },
  { id: "gpt-image-2", label: "GPT Image 2(API)" },
  { id: "seedream-v5-lite", label: "Seedream 5.0 Lite" },
  { id: "grok-imagine-image-api", label: "Grok Imagine(API)" },
];

export const FAL_VIDEO_MODELS = [
  { id: "seedance-2", label: "Seedance 2" },
  { id: "seedance-2-fast", label: "Seedance 2 Fast" },
  { id: "kling-v3", label: "Kling v3" },
  { id: "kling-o3", label: "Kling o3" },
  { id: "kling-v2-6", label: "Kling v2.6" },
  { id: "grok-imagine-video-api", label: "Grok Imagine(API)" },
];

export function isFalImageModel(model) {
  return FAL_IMAGE_MODELS.some((entry) => entry.id === model);
}

export function isFalVideoModel(model) {
  return FAL_VIDEO_MODELS.some((entry) => entry.id === model);
}

const IMAGE_ASPECT_RATIO_DIMENSIONS = {
  "21:9": { width: 1568, height: 672 },
  "16:9": { width: 1456, height: 816 },
  "4:3": { width: 1232, height: 928 },
  "3:2": { width: 1344, height: 896 },
  "1:1": { width: 1024, height: 1024 },
  "9:16": { width: 816, height: 1456 },
  "3:4": { width: 928, height: 1232 },
  "2:3": { width: 896, height: 1344 },
  "5:4": { width: 1280, height: 1024 },
  "4:5": { width: 1024, height: 1280 },
};

const GROK_IMAGE_ASPECT_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20"]);
const KLING_VIDEO_ASPECT_RATIOS = new Set(["16:9", "9:16", "1:1"]);
const SEEDANCE_VIDEO_ASPECT_RATIOS = new Set(["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
const GROK_VIDEO_ASPECT_RATIOS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"]);

function imageSizeMultiplier(imageSize) {
  const raw = String(imageSize || "1K").trim().toUpperCase();
  if (raw === "0.5K") return 0.5;
  if (raw === "2K") return 2;
  if (raw === "4K") return 4;
  return 1;
}

function imageDimensionsFor(aspectRatio, imageSize) {
  const base = IMAGE_ASPECT_RATIO_DIMENSIONS[aspectRatio] ?? IMAGE_ASPECT_RATIO_DIMENSIONS["1:1"];
  const multiplier = imageSizeMultiplier(imageSize);
  return {
    width: Math.round(base.width * multiplier),
    height: Math.round(base.height * multiplier),
  };
}

function sanitizeImageAspectRatio(model, aspectRatio) {
  const raw = String(aspectRatio || "").trim();
  if (model === "grok-imagine-image-api") {
    return GROK_IMAGE_ASPECT_RATIOS.has(raw) ? raw : "1:1";
  }
  return IMAGE_ASPECT_RATIO_DIMENSIONS[raw] ? raw : "1:1";
}

function normalizeFalImageSize(model, imageSize) {
  const raw = String(imageSize || "1K").trim().toUpperCase().replace("0.5K", "0.5K");
  if (model === "gpt-image-2") return "1K";
  if (model === "grok-imagine-image-api") return raw === "2K" ? "2K" : "1K";
  if (model === "seedream-v5-lite" && raw === "0.5K") return "1K";
  return ["0.5K", "1K", "2K", "4K"].includes(raw) ? raw : "1K";
}

function normalizeGptImageQuality(quality) {
  const raw = String(quality || "").trim().toLowerCase();
  return ["low", "medium", "high"].includes(raw) ? raw : "auto";
}

function normalizeGrokImageQuality(quality) {
  const raw = String(quality || "").trim().toLowerCase();
  if (raw === "standard" || raw === "low" || raw === "medium") return "standard";
  if (raw === "quality" || raw === "high") return "quality";
  return "auto";
}

function getVideoDurationRange(model) {
  if (model === "seedance-2" || model === "seedance-2-fast") return { min: 4, max: 15 };
  if (model === "grok-imagine-video-api") return { min: 1, max: 15 };
  if (model === "kling-v2-6") return { min: 5, max: 10 };
  return { min: 3, max: 15 };
}

function sanitizeVideoDuration(model, duration, { useReference = false } = {}) {
  const parsed = Number.parseInt(String(duration ?? "5"), 10);
  if (model === "kling-v2-6") {
    return Number.isFinite(parsed) && parsed >= 8 ? 10 : 5;
  }
  const range = getVideoDurationRange(model);
  const max = model === "grok-imagine-video-api" && useReference ? 10 : range.max;
  if (!Number.isFinite(parsed)) return Math.min(Math.max(5, range.min), max);
  return Math.min(max, Math.max(range.min, parsed));
}

function sanitizeVideoAspectRatio(model, aspectRatio) {
  const raw = String(aspectRatio || "").trim();
  if (model === "seedance-2" || model === "seedance-2-fast") {
    return SEEDANCE_VIDEO_ASPECT_RATIOS.has(raw) ? raw : "16:9";
  }
  if (model === "grok-imagine-video-api") {
    return GROK_VIDEO_ASPECT_RATIOS.has(raw) ? raw : "16:9";
  }
  return KLING_VIDEO_ASPECT_RATIOS.has(raw) ? raw : "16:9";
}

function sanitizeVideoResolution(resolution) {
  const raw = String(resolution || "").trim().toLowerCase();
  return raw === "480p" || raw === "720p" ? raw : "720p";
}

function extractFalErrorMessage(payload, fallback) {
  if (!payload || typeof payload !== "object") return fallback;
  for (const key of ["detail", "error", "message", "msg", "reason", "description", "title", "code"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const nested = extractFalErrorMessage(value, "");
      if (nested) return nested;
    }
  }
  return fallback;
}

function parseDataUrl(value) {
  const match = String(value || "").match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/s);
  if (!match) return null;
  return {
    mimeType: match[1] || "application/octet-stream",
    buffer: Buffer.from(match[2], "base64"),
  };
}

async function resolveMediaInputUrl(value, kind, cache) {
  const raw = nonEmptyString(value);
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;

  const cacheKey = raw.length > 4096 ? `${kind}:${raw.slice(0, 4096)}:${raw.length}` : `${kind}:${raw}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const uploadPromise = (async () => {
    const parsed = parseDataUrl(raw);
    if (parsed) {
      if (!parsed.mimeType.startsWith(`${kind}/`)) {
        throw new Error(`Reference data URL is not ${kind} media.`);
      }
      return uploadBufferToFalStorage(parsed.buffer, {
        mimeType: parsed.mimeType,
        fileName: `buzzassist-${kind}-${Date.now()}${extForMimeType(parsed.mimeType)}`,
      });
    }
    const filePath = raw.startsWith("file://") ? new URL(raw).pathname : raw;
    const mimeType = mimeTypeForFile(filePath);
    if (!mimeType.startsWith(`${kind}/`)) {
      throw new Error(`Reference is not ${kind} media: ${filePath}`);
    }
    const buffer = await readFile(filePath);
    return uploadBufferToFalStorage(buffer, {
      mimeType,
      fileName: sanitizeFileName(basename(filePath)),
    });
  })();
  cache.set(cacheKey, uploadPromise);
  return uploadPromise;
}

async function resolveMediaInputUrls(values, kind, cache) {
  const list = Array.isArray(values) ? values : [];
  const resolved = [];
  for (const value of list) {
    const url = await resolveMediaInputUrl(value, kind, cache);
    if (url) resolved.push(url);
  }
  return [...new Set(resolved)];
}

function buildFalImageRequest({ prompt, model, aspectRatio, imageSize, quality, referenceImageUrls }) {
  const isEdit = referenceImageUrls.length > 0;

  if (model === "gpt-image-2") {
    const gptQuality = normalizeGptImageQuality(quality);
    return {
      endpoint: isEdit ? "openai/gpt-image-2/edit" : "fal-ai/gpt-image-2",
      body: {
        prompt,
        image_size: imageDimensionsFor(aspectRatio, "1K"),
        num_images: 1,
        output_format: "png",
        quality: gptQuality === "auto" ? "medium" : gptQuality,
        ...(isEdit ? { image_urls: referenceImageUrls } : {}),
      },
    };
  }

  if (model === "grok-imagine-image-api") {
    if (referenceImageUrls.length > 3) {
      throw new Error("Grok Imagine(API) supports up to 3 reference images.");
    }
    const grokQuality = normalizeGrokImageQuality(quality);
    const useQualityEndpoint = grokQuality !== "standard";
    return {
      endpoint: isEdit
        ? useQualityEndpoint ? "xai/grok-imagine-image/quality/edit" : "xai/grok-imagine-image/edit"
        : useQualityEndpoint ? "xai/grok-imagine-image/quality/text-to-image" : "xai/grok-imagine-image",
      body: {
        prompt,
        num_images: 1,
        aspect_ratio: aspectRatio,
        resolution: normalizeFalImageSize(model, imageSize).toLowerCase(),
        output_format: "png",
        ...(isEdit ? { image_urls: referenceImageUrls } : {}),
      },
    };
  }

  if (model === "seedream-v5-lite") {
    return {
      endpoint: isEdit ? "fal-ai/bytedance/seedream/v5/lite/edit" : "fal-ai/bytedance/seedream/v5/lite/text-to-image",
      body: {
        prompt,
        image_size: imageDimensionsFor(aspectRatio, normalizeFalImageSize(model, imageSize)),
        num_images: 1,
        max_images: 1,
        enable_safety_checker: true,
        ...(isEdit ? { image_urls: referenceImageUrls } : {}),
      },
    };
  }

  return {
    endpoint: isEdit ? "fal-ai/nano-banana-2/edit" : "fal-ai/nano-banana-2",
    body: {
      prompt,
      num_images: 1,
      aspect_ratio: aspectRatio,
      output_format: "png",
      safety_tolerance: "4",
      resolution: normalizeFalImageSize(model, imageSize),
      limit_generations: true,
      ...(isEdit ? { image_urls: referenceImageUrls } : {}),
    },
  };
}

async function downloadMedia(url, fallbackMimeType) {
  const inline = parseDataUrl(url);
  if (inline) return inline;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download generated media: ${response.status} ${response.statusText}`);
  const mimeType = response.headers.get("content-type")?.split(";")[0] || fallbackMimeType || "application/octet-stream";
  return { mimeType, buffer: Buffer.from(await response.arrayBuffer()) };
}

export async function generateFalImageMedia(input = {}) {
  const prompt = nonEmptyString(input.prompt);
  if (!prompt) throw new Error("prompt is required.");
  const model = isFalImageModel(input.model) ? input.model : "nano-banana-2";
  const aspectRatio = sanitizeImageAspectRatio(model, input.aspectRatio);

  const cache = new Map();
  const referenceImageUrls = await resolveMediaInputUrls(
    [
      ...(Array.isArray(input.referenceImages) ? input.referenceImages : []),
      ...(Array.isArray(input.referenceImagePaths) ? input.referenceImagePaths : []),
    ],
    "image",
    cache,
  );

  const { endpoint, body } = buildFalImageRequest({
    prompt,
    model,
    aspectRatio,
    imageSize: input.imageSize ?? input.size,
    quality: input.quality,
    referenceImageUrls,
  });

  const result = await runFalSyncRequest(endpoint, body, { timeoutMs: 5 * 60 * 1000 });
  const imageUrl = result?.images?.[0]?.url || result?.image?.url;
  if (!imageUrl) {
    throw new Error(extractFalErrorMessage(result, `fal image generation (${model}) returned no image URL.`));
  }
  const media = await downloadMedia(imageUrl, "image/png");
  return {
    kind: "image",
    model,
    mimeType: media.mimeType,
    buffer: media.buffer,
    fileName: input.fileName || `generated-${Date.now()}${extForMimeType(media.mimeType, ".png")}`,
    source: imageUrl.startsWith("data:") ? "data-url" : imageUrl,
  };
}

function getVideoGenerationContext(input, media) {
  if (input.useMotion) return "motion";
  if (input.useReference) return "reference";
  if (input.useKeyframe) return "keyframe";
  if (!media.startFrameUrl && (media.referenceImageUrls.length || media.referenceVideoUrls.length || media.referenceAudioUrls.length)) {
    return "reference";
  }
  return "keyframe";
}

function buildFalVideoRequest(input, media) {
  const model = isFalVideoModel(input.model) ? input.model : "kling-v2-6";
  const mode = String(input.mode || "").trim().toLowerCase() === "pro" ? "pro" : "standard";
  const aspectRatio = sanitizeVideoAspectRatio(model, input.aspectRatio);
  const resolution = sanitizeVideoResolution(input.resolution);
  const generateAudio = input.generateAudio !== false;
  const context = getVideoGenerationContext(input, media);
  const { startFrameUrl, endFrameUrl, referenceImageUrls, referenceVideoUrls, referenceAudioUrls } = media;

  if (model === "grok-imagine-video-api") {
    if (context === "motion") throw new Error("Grok Imagine(API) does not support motion mode.");
    if (endFrameUrl) throw new Error("Grok Imagine(API) does not support end-frame interpolation.");
    if (context === "reference") {
      if (referenceVideoUrls.length) throw new Error("Grok Imagine(API) reference mode supports images only.");
      if (referenceImageUrls.length > 7) throw new Error("Grok Imagine(API) supports up to 7 reference images.");
      return {
        endpoint: "xai/grok-imagine-video/reference-to-video",
        body: {
          prompt: input.prompt,
          reference_image_urls: referenceImageUrls,
          duration: sanitizeVideoDuration(model, input.duration, { useReference: true }),
          aspect_ratio: aspectRatio,
          resolution,
        },
      };
    }
    if (startFrameUrl) {
      return {
        endpoint: "xai/grok-imagine-video/image-to-video",
        body: {
          prompt: input.prompt,
          image_url: startFrameUrl,
          duration: sanitizeVideoDuration(model, input.duration),
          aspect_ratio: aspectRatio,
          resolution,
        },
      };
    }
    return {
      endpoint: "xai/grok-imagine-video/text-to-video",
      body: {
        prompt: input.prompt,
        duration: sanitizeVideoDuration(model, input.duration),
        aspect_ratio: aspectRatio,
        resolution,
      },
    };
  }

  if (model === "seedance-2" || model === "seedance-2-fast") {
    if (context === "motion") throw new Error("Seedance 2 does not support motion mode.");
    const basePath = model === "seedance-2-fast" ? "bytedance/seedance-2.0/fast" : "bytedance/seedance-2.0";
    const duration = String(sanitizeVideoDuration(model, input.duration));
    if (context === "reference") {
      return {
        endpoint: `${basePath}/reference-to-video`,
        body: {
          prompt: input.prompt,
          duration,
          aspect_ratio: aspectRatio,
          resolution,
          generate_audio: generateAudio,
          ...(referenceImageUrls.length ? { image_urls: referenceImageUrls } : {}),
          ...(referenceVideoUrls.length ? { video_urls: referenceVideoUrls } : {}),
          ...(referenceAudioUrls.length ? { audio_urls: referenceAudioUrls } : {}),
        },
      };
    }
    if (startFrameUrl) {
      return {
        endpoint: `${basePath}/image-to-video`,
        body: {
          prompt: input.prompt,
          image_url: startFrameUrl,
          duration,
          aspect_ratio: aspectRatio,
          resolution,
          generate_audio: generateAudio,
          ...(endFrameUrl ? { end_image_url: endFrameUrl } : {}),
        },
      };
    }
    return {
      endpoint: `${basePath}/text-to-video`,
      body: {
        prompt: input.prompt,
        duration,
        aspect_ratio: aspectRatio,
        resolution,
        generate_audio: generateAudio,
      },
    };
  }

  if (model === "kling-v3") {
    if (context === "motion") throw new Error("Kling v3 does not support motion mode.");
    if (context === "reference") throw new Error("Kling v3 does not support reference mode.");
    const variant = mode === "pro" ? "pro" : "standard";
    const duration = sanitizeVideoDuration(model, input.duration);
    if (startFrameUrl) {
      return {
        endpoint: `fal-ai/kling-video/v3/${variant}/image-to-video`,
        body: {
          prompt: input.prompt,
          start_image_url: startFrameUrl,
          duration,
          generate_audio: generateAudio,
          ...(endFrameUrl ? { end_image_url: endFrameUrl } : {}),
        },
      };
    }
    return {
      endpoint: `fal-ai/kling-video/v3/${variant}/text-to-video`,
      body: {
        prompt: input.prompt,
        duration,
        aspect_ratio: aspectRatio,
        generate_audio: generateAudio,
      },
    };
  }

  if (model === "kling-o3") {
    if (context === "motion") throw new Error("Kling o3 does not support motion mode.");
    const variant = mode === "pro" ? "pro" : "standard";
    const duration = sanitizeVideoDuration(model, input.duration);
    if (context === "reference") {
      if (referenceVideoUrls.length > 1) throw new Error("Kling o3 supports at most 1 reference video.");
      if (referenceVideoUrls.length === 1) {
        return {
          endpoint: `fal-ai/kling-video/o3/${variant}/video-to-video/reference`,
          body: {
            prompt: input.prompt,
            video_url: referenceVideoUrls[0],
            ...(referenceImageUrls.length ? { image_urls: referenceImageUrls } : {}),
            duration,
            aspect_ratio: aspectRatio,
            keep_audio: false,
          },
        };
      }
      return {
        endpoint: `fal-ai/kling-video/o3/${variant}/reference-to-video`,
        body: {
          prompt: input.prompt,
          image_urls: referenceImageUrls,
          duration,
          aspect_ratio: aspectRatio,
          generate_audio: generateAudio,
        },
      };
    }
    if (startFrameUrl) {
      return {
        endpoint: `fal-ai/kling-video/o3/${variant}/image-to-video`,
        body: {
          prompt: input.prompt,
          image_url: startFrameUrl,
          duration,
          generate_audio: generateAudio,
          ...(endFrameUrl ? { end_image_url: endFrameUrl } : {}),
        },
      };
    }
    return {
      endpoint: `fal-ai/kling-video/o3/${variant}/text-to-video`,
      body: {
        prompt: input.prompt,
        duration,
        aspect_ratio: aspectRatio,
        generate_audio: generateAudio,
      },
    };
  }

  // kling-v2-6
  if (context === "reference") throw new Error("Kling v2.6 does not support reference mode.");
  const duration = sanitizeVideoDuration(model, input.duration);
  if (context === "motion") {
    if (!startFrameUrl || referenceVideoUrls.length === 0) {
      throw new Error("Kling v2.6 motion control requires a start image and a reference video.");
    }
    const variant = mode === "standard" ? "standard" : "pro";
    const motionOrientation = String(input.motionOrientation || "image").trim().toLowerCase() === "video" ? "video" : "image";
    return {
      endpoint: `fal-ai/kling-video/v2.6/${variant}/motion-control`,
      body: {
        prompt: input.prompt,
        image_url: startFrameUrl,
        video_url: referenceVideoUrls[0],
        character_orientation: motionOrientation,
        keep_original_sound: true,
      },
    };
  }
  if (startFrameUrl) {
    return {
      endpoint: "fal-ai/kling-video/v2.6/pro/image-to-video",
      body: {
        prompt: input.prompt,
        start_image_url: startFrameUrl,
        duration,
        generate_audio: generateAudio,
        ...(endFrameUrl ? { end_image_url: endFrameUrl } : {}),
      },
    };
  }
  return {
    endpoint: "fal-ai/kling-video/v2.6/pro/text-to-video",
    body: {
      prompt: input.prompt,
      duration,
      aspect_ratio: aspectRatio,
      generate_audio: generateAudio,
    },
  };
}

export async function generateFalVideoMedia(input = {}) {
  const prompt = nonEmptyString(input.prompt);
  if (!prompt) throw new Error("prompt is required.");
  const model = isFalVideoModel(input.model) ? input.model : "kling-v2-6";

  const cache = new Map();
  const media = {
    startFrameUrl: await resolveMediaInputUrl(
      input.startFrameDataURL ?? input.start_frame_data_url ?? input.startFramePath ?? input.start_frame_path ?? input.imageUrl ?? input.image_url,
      "image",
      cache,
    ),
    endFrameUrl: await resolveMediaInputUrl(
      input.endFrameDataURL ?? input.end_frame_data_url ?? input.endFramePath ?? input.end_frame_path,
      "image",
      cache,
    ),
    referenceImageUrls: await resolveMediaInputUrls(
      [
        ...(Array.isArray(input.referenceImages) ? input.referenceImages : []),
        ...(Array.isArray(input.referenceImagePaths) ? input.referenceImagePaths : []),
      ],
      "image",
      cache,
    ),
    referenceVideoUrls: await resolveMediaInputUrls(
      [
        ...(Array.isArray(input.referenceVideos) ? input.referenceVideos : []),
        ...(Array.isArray(input.referenceVideoPaths) ? input.referenceVideoPaths : []),
      ],
      "video",
      cache,
    ),
    referenceAudioUrls: await resolveMediaInputUrls(
      [
        ...(Array.isArray(input.referenceAudios) ? input.referenceAudios : []),
        ...(Array.isArray(input.referenceAudioPaths) ? input.referenceAudioPaths : []),
      ],
      "audio",
      cache,
    ),
  };

  const { endpoint, body } = buildFalVideoRequest({ ...input, prompt, model }, media);
  const result = await runFalQueueRequest(endpoint, body, { timeoutMs: 30 * 60 * 1000 });
  const videoUrl = result?.video?.url || result?.videos?.[0]?.url || result?.video_url;
  if (!videoUrl) {
    throw new Error(extractFalErrorMessage(result, `fal video generation (${model}) returned no video URL.`));
  }
  const fallbackMime = result?.video?.content_type || result?.content_type || "video/mp4";
  const downloaded = await downloadMedia(videoUrl, fallbackMime);
  const ext = extname(String(videoUrl).split("?")[0]) || extForMimeType(downloaded.mimeType, ".mp4");
  return {
    kind: "video",
    model,
    mimeType: downloaded.mimeType,
    buffer: downloaded.buffer,
    fileName: input.fileName || `generated-video-${Date.now()}${ext}`,
    source: videoUrl,
  };
}
