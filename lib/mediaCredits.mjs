// Node ESM port of BuzzAssist's client-side credit estimation.
// Source: Youtube-AGI/Covnex/src/lib/billing/mediaCredits.ts (bundled into the
// BuzzAssist canvas UI for pre-generation estimates). Keep the math identical.

export const DEFAULT_MEDIA_USD_TO_JPY = 160;
export const DEFAULT_MEDIA_CREDIT_VALUE_YEN = 3.112;
export const ELEVENLABS_SCRIBE_V1_V2_USD_PER_HOUR = 0.22;
export const ELEVENLABS_FORCED_ALIGNMENT_USD_PER_HOUR = ELEVENLABS_SCRIBE_V1_V2_USD_PER_HOUR;

function resolveConfig(config) {
  return {
    usdToJpyRate:
      typeof config?.usdToJpyRate === "number" && Number.isFinite(config.usdToJpyRate) && config.usdToJpyRate > 0
        ? config.usdToJpyRate
        : DEFAULT_MEDIA_USD_TO_JPY,
    creditValueYen:
      typeof config?.creditValueYen === "number" && Number.isFinite(config.creditValueYen) && config.creditValueYen > 0
        ? config.creditValueYen
        : DEFAULT_MEDIA_CREDIT_VALUE_YEN,
  };
}

function estimatePromptTokens(prompt) {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return 0;
  }
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

function calculateCreditsFromUsd(costUsd, config) {
  if (!(costUsd > 0)) {
    return 0;
  }
  const resolved = resolveConfig(config);
  return Math.max(1, Math.ceil((costUsd * resolved.usdToJpyRate) / resolved.creditValueYen));
}

function calculateCreditsFromYen(costYen, config) {
  if (!(costYen > 0)) {
    return 0;
  }
  const resolved = resolveConfig(config);
  return Math.max(1, Math.ceil(costYen / resolved.creditValueYen));
}

const SEEDANCE_VIDEO_PIXEL_SIZES = {
  "480p": {
    "21:9": { width: 992, height: 432 },
    "16:9": { width: 864, height: 496 },
    "4:3": { width: 752, height: 560 },
    "1:1": { width: 640, height: 640 },
    "3:4": { width: 560, height: 752 },
    "9:16": { width: 496, height: 864 },
  },
  "720p": {
    "21:9": { width: 1470, height: 630 },
    "16:9": { width: 1280, height: 720 },
    "4:3": { width: 1112, height: 834 },
    "1:1": { width: 960, height: 960 },
    "3:4": { width: 834, height: 1112 },
    "9:16": { width: 720, height: 1280 },
  },
};

function resolveSeedanceAspectRatio(aspectRatio) {
  const normalized = typeof aspectRatio === "string" ? aspectRatio.trim() : "";
  return normalized in SEEDANCE_VIDEO_PIXEL_SIZES["720p"] ? normalized : "16:9";
}

function resolveSeedanceResolution(resolution) {
  return resolution === "480p" ? "480p" : "720p";
}

function getSeedanceResolutionMultiplier(resolution, aspectRatio) {
  const resolvedResolution = resolveSeedanceResolution(resolution);
  if (resolvedResolution === "720p") {
    return 1;
  }
  const resolvedAspectRatio = resolveSeedanceAspectRatio(aspectRatio);
  const output = SEEDANCE_VIDEO_PIXEL_SIZES[resolvedResolution][resolvedAspectRatio];
  const base = SEEDANCE_VIDEO_PIXEL_SIZES["720p"][resolvedAspectRatio];
  return (output.width * output.height) / (base.width * base.height);
}

function toGptImageSize(aspectRatio) {
  if (aspectRatio === "1:1") {
    return "1024x1024";
  }
  if (typeof aspectRatio === "string" && aspectRatio.includes(":")) {
    const [widthText, heightText] = aspectRatio.split(":", 2);
    const width = Number.parseFloat(widthText);
    const height = Number.parseFloat(heightText);
    if (Number.isFinite(width) && Number.isFinite(height)) {
      if (width > height) {
        return "1536x1024";
      }
      if (width < height) {
        return "1024x1536";
      }
    }
  }
  if (aspectRatio === "3:2") {
    return "1536x1024";
  }
  if (aspectRatio === "2:3") {
    return "1024x1536";
  }
  return "1024x1024";
}

function resolveGptImageQuality(quality) {
  return quality === "low" || quality === "medium" || quality === "high" ? quality : "medium";
}

function resolveGptImage2PerImageCost(size, quality) {
  if (quality === "low") {
    return size === "1024x1024" ? 0.006 : 0.005;
  }
  if (quality === "high") {
    return size === "1024x1024" ? 0.211 : 0.165;
  }
  return size === "1024x1024" ? 0.053 : 0.041;
}

function resolveGrokImageResolution(imageSize) {
  return (imageSize ?? "1K").toUpperCase() === "2K" ? "2K" : "1K";
}

function resolveGrokImageQuality(quality) {
  return quality === "standard" ? "standard" : "quality";
}

export function estimateImageGenerationCost(input, config) {
  const numImages = Math.max(1, Math.round(input.numImages ?? 1));
  const resolved = resolveConfig(config);

  if (input.model === "gpt-image-2-codex") {
    return {
      credits: 0,
      estimatedCostYen: 0,
      source: "image",
    };
  }

  if (input.model === "seedream-v5-lite") {
    const estimatedCostYen = numImages * 0.035 * resolved.usdToJpyRate;
    return {
      credits: calculateCreditsFromYen(estimatedCostYen, resolved),
      estimatedCostYen,
      source: "image",
    };
  }

  if (input.model === "grok-imagine-image-api") {
    const resolution = resolveGrokImageResolution(input.imageSize);
    const quality = resolveGrokImageQuality(input.imageQuality);
    const referenceImageCount = Math.max(0, Math.round(input.referenceImageCount ?? 0));
    const outputUsdPerImage =
      quality === "standard"
        ? 0.02
        : resolution === "2K"
          ? 0.07
          : 0.05;
    const inputUsdPerImage = quality === "standard" ? 0.002 : 0.01;
    const costUsd =
      numImages * outputUsdPerImage
      + referenceImageCount * inputUsdPerImage;
    return {
      credits: calculateCreditsFromUsd(costUsd, resolved),
      estimatedCostYen: costUsd * resolved.usdToJpyRate,
      source: "image",
    };
  }

  if (input.model === "nano-banana-2") {
    const resolution = (input.imageSize ?? "1K").toUpperCase();
    const multiplier =
      resolution === "0.5K" ? 0.75
        : resolution === "2K" ? 1.5
          : resolution === "4K" ? 2
            : 1;
    const costUsd =
      numImages * 0.08 * multiplier
      + (input.enableWebSearch ? 0.015 : 0)
      + (input.highThinking ? 0.002 : 0);
    return {
      credits: calculateCreditsFromUsd(costUsd, resolved),
      estimatedCostYen: costUsd * resolved.usdToJpyRate,
      source: "image",
    };
  }

  const quality = resolveGptImageQuality(input.imageQuality);
  const size = toGptImageSize(input.aspectRatio);
  let costUsd =
    numImages * resolveGptImage2PerImageCost(size, quality)
    + (estimatePromptTokens(input.prompt ?? "") / 1000) * 0.005;

  if ((input.referenceImageCount ?? 0) > 0) {
    const inputImageTokens = 3050;
    costUsd += (((input.referenceImageCount ?? 0) * inputImageTokens) / 1000) * 0.008;
  }

  return {
    credits: calculateCreditsFromUsd(costUsd, resolved),
    estimatedCostYen: costUsd * resolved.usdToJpyRate,
    source: "image",
  };
}

export function estimateVideoGenerationCost(input, config) {
  const resolved = resolveConfig(config);
  const duration = Math.max(1, Math.round(input.durationSeconds ?? 5));
  const mode = input.mode ?? "pro";
  const tab = input.tab ?? "keyframe";
  const generateAudio = input.generateAudio !== false;

  if (input.model === "seedance-2" || input.model === "seedance-2-fast") {
    const hasVideoReference = tab === "reference" && Boolean(input.hasReferenceVideo);
    const isTextToVideo = tab !== "reference" && !input.hasStartImage;
    const standardRate = isTextToVideo ? 0.3034 : 0.3024;
    const baseRate = input.model === "seedance-2-fast" ? 0.2419 : standardRate;
    const resolutionMultiplier = getSeedanceResolutionMultiplier(input.resolution, input.aspectRatio);
    const ratePerSecond = (hasVideoReference ? baseRate * 0.6 : baseRate) * resolutionMultiplier;
    const costUsd = duration * ratePerSecond;
    return {
      credits: calculateCreditsFromUsd(costUsd, resolved),
      estimatedCostYen: costUsd * resolved.usdToJpyRate,
      source: "video",
    };
  }

  if (input.model === "kling-o3") {
    let ratePerSecond = 0;
    if (tab === "reference" && input.hasReferenceVideo) {
      ratePerSecond = mode === "pro" ? 0.168 : 0.126;
    } else if (generateAudio) {
      ratePerSecond = mode === "pro" ? 0.14 : 0.112;
    } else {
      ratePerSecond = mode === "pro" ? 0.112 : 0.084;
    }
    const costUsd = duration * ratePerSecond;
    return {
      credits: calculateCreditsFromUsd(costUsd, resolved),
      estimatedCostYen: costUsd * resolved.usdToJpyRate,
      source: "video",
    };
  }

  if (input.model === "kling-v3") {
    const ratePerSecond = generateAudio
      ? (mode === "pro" ? 0.168 : 0.126)
      : (mode === "pro" ? 0.112 : 0.084);
    const costUsd = duration * ratePerSecond;
    return {
      credits: calculateCreditsFromUsd(costUsd, resolved),
      estimatedCostYen: costUsd * resolved.usdToJpyRate,
      source: "video",
    };
  }

  if (input.model === "grok-imagine-video-api") {
    const resolution = resolveSeedanceResolution(input.resolution);
    const ratePerSecond = resolution === "480p" ? 0.05 : 0.07;
    const hasImageInput =
      Boolean(input.hasStartImage)
      || Math.max(0, Math.round(input.referenceImageCount ?? 0)) > 0;
    const costUsd = duration * ratePerSecond + (hasImageInput ? 0.002 : 0);
    return {
      credits: calculateCreditsFromUsd(costUsd, resolved),
      estimatedCostYen: costUsd * resolved.usdToJpyRate,
      source: "video",
    };
  }

  // kling-v2-6 (and any unrecognized model falls through to the same rates).
  const ratePerSecond =
    tab === "motion"
      ? (mode === "standard" ? 0.07 : 0.112)
      : generateAudio
        ? 0.14
        : 0.07;
  const costUsd = duration * ratePerSecond;
  return {
    credits: calculateCreditsFromUsd(costUsd, resolved),
    estimatedCostYen: costUsd * resolved.usdToJpyRate,
    source: "video",
  };
}

function resolveSubtitleUsdPerMinute(model) {
  if (model === "elevenlabs-scribe-v2") {
    return ELEVENLABS_SCRIBE_V1_V2_USD_PER_HOUR / 60;
  }
  if (model === "elevenlabs-forced-alignment") {
    return ELEVENLABS_FORCED_ALIGNMENT_USD_PER_HOUR / 60;
  }
  return 0;
}

export function estimateSubtitleGenerationCost(input, config) {
  const resolved = resolveConfig(config);
  const usdPerMinute = resolveSubtitleUsdPerMinute(input.model);
  const durationSeconds = Math.max(0, input.durationSeconds ?? 0);
  if (!(usdPerMinute > 0) || !(durationSeconds > 0)) {
    return {
      credits: 0,
      estimatedCostYen: 0,
      source: "subtitle",
    };
  }
  const costUsd = (durationSeconds / 60) * usdPerMinute;
  return {
    credits: calculateCreditsFromUsd(costUsd, resolved),
    estimatedCostYen: costUsd * resolved.usdToJpyRate,
    source: "subtitle",
  };
}

export function estimateCreditsForJob(job = {}, config) {
  const kind = String(job.kind || "").trim().toLowerCase();

  if (kind === "image") {
    const { credits, estimatedCostYen } = estimateImageGenerationCost(
      {
        model: job.model,
        prompt: job.prompt,
        numImages: job.numImages,
        imageSize: job.imageSize,
        aspectRatio: job.aspectRatio,
        imageQuality: job.quality ?? job.imageQuality,
        referenceImageCount: job.referenceImageCount,
        enableWebSearch: job.enableWebSearch,
        highThinking: job.highThinking,
      },
      config,
    );
    return { credits, estimatedCostYen };
  }

  if (kind === "video") {
    const { credits, estimatedCostYen } = estimateVideoGenerationCost(
      {
        model: job.model,
        mode: job.mode,
        tab: job.tab,
        durationSeconds: job.duration ?? job.durationSeconds,
        aspectRatio: job.aspectRatio,
        resolution: job.resolution,
        hasStartImage: job.hasStartImage,
        referenceImageCount: job.referenceImageCount,
        hasReferenceVideo: job.hasReferenceVideo,
        generateAudio: job.generateAudio,
      },
      config,
    );
    return { credits, estimatedCostYen };
  }

  if (kind === "subtitle") {
    const { credits, estimatedCostYen } = estimateSubtitleGenerationCost(
      {
        model: job.model || "elevenlabs-scribe-v2",
        durationSeconds: job.durationSeconds ?? job.duration,
      },
      config,
    );
    return { credits, estimatedCostYen };
  }

  throw new Error(`Unknown credit estimation kind: ${job.kind}. Expected "image", "video", or "subtitle".`);
}
