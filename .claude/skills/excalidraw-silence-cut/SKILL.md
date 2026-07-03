---
name: excalidraw-silence-cut
description: Remove silences from a local video with ffmpeg (jet cut) and insert the cut video into the local Excalidraw canvas with cut statistics. Use when the user asks for 無音カット, ジェットカット, silence cut, or tempo cut of a video on the canvas.
---

# Excalidraw Silence Cut

Use this skill when the user wants silences removed from a video and the result placed on the canvas.

## Preconditions

- `ffmpeg` and `ffprobe` must be available on PATH (or set `FFMPEG_PATH` / `FFPROBE_PATH`).
- Runs fully locally — no BuzzAssist login needed.

## Workflow

1. Call the MCP `silence_cut_excalidraw_video` tool:

```json
{
  "videoPath": "/absolute/path/to/talk.mp4",
  "detectSeconds": 0.6,
  "thresholdDb": -34,
  "keepSeconds": 0.25,
  "preMarginSeconds": 0.08,
  "postMarginSeconds": 0.12,
  "audioFadeSeconds": 0.03,
  "projectDir": "/absolute/path/to/project"
}
```

2. The tool detects silences with ffmpeg `silencedetect` (with adaptive threshold fallback), renders the jet-cut video, inserts it as a video media element with `silenceCut` statistics in customData, and returns `inputDuration`, `outputDuration`, `cutDuration`, `cutCount`.
3. Report the before/after durations and cut count to the user.

## Guardrails

- Defaults are tuned for Japanese talk videos; only override when the user asks (e.g. more aggressive cutting → raise `thresholdDb` toward -30 or lower `detectSeconds`).
- If the tool reports no detectable silence or near-total silence, relay the message instead of retrying with random parameters.
