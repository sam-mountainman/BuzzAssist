#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  adoptEpisodeCutImages,
  createEpisodeManifest,
  generateEpisodeSpeech,
  readEpisodeManifest,
  refreshEpisodeBubbleOverlays,
  renderEpisodeVideo,
} from "../lib/mangaVideoPipeline.mjs";
import { readCharacterRegistry, writeCharacterRegistry } from "../lib/characterRegistry.mjs";
import { getElevenLabsStatus, listAllElevenLabsVoices } from "../lib/speechGeneration.mjs";
import { castRegistryVoices } from "../lib/voiceCasting.mjs";
import {
  approveVoiceLibraryCasting,
  discoverVoiceLibraryCasting,
} from "../lib/voiceLibraryCasting.mjs";

function parseArgs(argv) {
  const result = { action: "full" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      if (index === 0) result.action = token;
      continue;
    }
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) result[key] = true;
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function usage() {
  return `Usage:
  node scripts/build-manga-video.mjs voices
  node scripts/build-manga-video.mjs cast-voices [--episode-id <id>] [--force-voice-cast]
  node scripts/build-manga-video.mjs voice-library-audition [--episode-id <id>] [--candidate-limit 5]
  node scripts/build-manga-video.mjs voice-library-approve --plan-path <audition.json> --selections-path <selections.json> --confirmed-voice-adds
  node scripts/build-manga-video.mjs plan --script-path <script.txt> --episode-id <id>
  node scripts/build-manga-video.mjs adopt-images --manifest-path <episode-manifest.json> --image-template '/path/{episode}-v7-{cut}.png'
  node scripts/build-manga-video.mjs refresh-bubbles --manifest-path <episode-manifest.json> --overrides-path <bubble-overrides.json> [--refresh-all]
  node scripts/build-manga-video.mjs speech --manifest-path <episode-manifest.json> --voice-id <id> [--utterance-ids cut-03-u02,cut-10-u03] [--speech-concurrency 4]
  node scripts/build-manga-video.mjs render --manifest-path <episode-manifest.json> [--cut-ids cut-05,cut-07] [--render-concurrency 2] [--bgm-path <music.mp3> --bgm-volume 0.1] [--master-target-lufs -14]
    Use --reuse-rendered-cuts to remux or add BGM without rerendering unchanged cut videos.
  node scripts/build-manga-video.mjs full --script-path <script.txt> --episode-id <id> --voice-id <id>

Defaults: model=eleven_multilingual_v2, motion=pull-out, speech-concurrency=4, render-concurrency=CPU-bounded 2-4, project-dir=current directory.`;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

const options = {
  ...args,
  projectDir: resolve(args.projectDir || process.cwd()),
  scriptPath: args.scriptPath ? resolve(args.scriptPath) : undefined,
  manifestPath: args.manifestPath ? resolve(args.manifestPath) : undefined,
  model: args.model || (["plan", "speech", "full"].includes(args.action) ? "eleven_multilingual_v2" : undefined),
  motion: args.motion || "pull-out",
  force: args.force === true,
  utteranceIds: args.utteranceIds,
  bgmVolume: args.bgmVolume === undefined ? undefined : Number(args.bgmVolume),
  width: args.width === undefined ? undefined : Number(args.width),
  height: args.height === undefined ? undefined : Number(args.height),
  fps: args.fps === undefined ? undefined : Number(args.fps),
  stability: args.stability === undefined ? undefined : Number(args.stability),
  similarityBoost: args.similarityBoost === undefined ? undefined : Number(args.similarityBoost),
  speed: args.speed === undefined ? undefined : Number(args.speed),
  speechConcurrency: args.speechConcurrency === undefined ? undefined : Number(args.speechConcurrency),
  renderConcurrency: args.renderConcurrency === undefined ? undefined : Number(args.renderConcurrency),
  candidateLimit: args.candidateLimit === undefined ? undefined : Number(args.candidateLimit),
  sameSpeakerGapSeconds: args.sameSpeakerGapSeconds === undefined ? undefined : Number(args.sameSpeakerGapSeconds),
  speakerChangeGapSeconds: args.speakerChangeGapSeconds === undefined ? undefined : Number(args.speakerChangeGapSeconds),
  emphasisGapSeconds: args.emphasisGapSeconds === undefined ? undefined : Number(args.emphasisGapSeconds),
  normalizeMasterAudio: args.disableMasterNormalization === true ? false : undefined,
  masterTargetLufs: args.masterTargetLufs === undefined ? undefined : Number(args.masterTargetLufs),
  masterLoudnessRange: args.masterLoudnessRange === undefined ? undefined : Number(args.masterLoudnessRange),
  masterTruePeakDb: args.masterTruePeakDb === undefined ? undefined : Number(args.masterTruePeakDb),
};

let output;
if (args.action === "voices") {
  const status = await getElevenLabsStatus();
  output = { status, ...(status.configured ? await listAllElevenLabsVoices({ ...options, japaneseOnly: true }) : { voices: [] }) };
} else if (args.action === "cast-voices") {
  const status = await getElevenLabsStatus();
  if (!status.configured) throw new Error("ElevenLabs API key is not configured.");
  const registry = await readCharacterRegistry(options);
  const characters = registry.characters.filter((character) => character.kind === "character"
    && (!args.episodeId || character.episodeId === args.episodeId));
  const catalog = await listAllElevenLabsVoices({ ...options, japaneseOnly: true });
  const cast = castRegistryVoices({
    registry,
    voices: catalog.voices,
    characters,
    episodeId: args.episodeId || "global",
    includeNarration: args.includeNarration !== false,
    preserveExisting: args.preserveExistingVoices !== false,
    force: args.forceVoiceCast === true,
    requireNativeJapanese: args.requireNativeJapaneseVoices !== false,
    modelId: args.model,
  });
  const written = cast.changed ? await writeCharacterRegistry(options, cast.registry) : cast.registry;
  output = {
    status,
    changed: cast.changed,
    assignments: cast.assignments,
    catalogCount: cast.catalogCount,
    japaneseCandidateCount: cast.japaneseCandidateCount,
    nativeJapaneseCandidateCount: cast.nativeJapaneseCandidateCount,
    registryCharacters: written.characters.length,
    registryVoices: written.voices.length,
  };
} else if (args.action === "voice-library-audition") {
  output = await discoverVoiceLibraryCasting({
    ...options,
    episodeId: args.episodeId || "global",
    characterIds: args.characterIds,
    includeNarration: args.includeNarration !== false,
  });
} else if (args.action === "voice-library-approve") {
  if (!args.selectionsPath) throw new Error("--selections-path is required.");
  const selectionsPayload = JSON.parse(await readFile(resolve(args.selectionsPath), "utf8"));
  output = await approveVoiceLibraryCasting({
    ...options,
    planPath: args.planPath ? resolve(args.planPath) : undefined,
    selections: Array.isArray(selectionsPayload) ? selectionsPayload : selectionsPayload.selections,
    confirmedVoiceAdds: args.confirmedVoiceAdds === true,
  });
} else if (args.action === "plan") {
  output = await createEpisodeManifest(options);
} else if (args.action === "adopt-images") {
  output = await adoptEpisodeCutImages(options);
} else if (args.action === "refresh-bubbles") {
  output = await refreshEpisodeBubbleOverlays(options);
} else if (args.action === "speech") {
  output = await generateEpisodeSpeech(options);
} else if (args.action === "render") {
  output = await renderEpisodeVideo(options);
} else if (args.action === "full") {
  const planned = await createEpisodeManifest(options);
  const spoken = await generateEpisodeSpeech({ ...options, manifestPath: planned.filePath });
  if (spoken.failedCount > 0) throw new Error(`${spoken.failedCount} utterance(s) failed; render was not started.`);
  output = await renderEpisodeVideo({ ...options, manifestPath: planned.filePath });
} else if (args.action === "status") {
  output = await readEpisodeManifest(options);
} else {
  throw new Error(`Unknown action: ${args.action}\n${usage()}`);
}

const publicOutput = output?.manifest
  ? {
      filePath: output.filePath,
      outputPath: output.outputPath || "",
      status: output.manifest.status,
      episodeId: output.manifest.id,
      cuts: output.manifest.cuts?.length || 0,
      utterances: output.manifest.utterances?.length || 0,
      failedCount: output.failedCount || 0,
      adopted: output.adopted || [],
      refreshed: output.refreshed || [],
      metrics: output.manifest.metrics || {},
      outputs: output.manifest.outputs || {},
    }
  : output;
process.stdout.write(`${JSON.stringify(publicOutput, null, 2)}\n`);
