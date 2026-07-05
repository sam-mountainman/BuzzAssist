---
name: excalidraw-silence-cut
description: Create a non-destructive Premiere Pro XML (FCP7 xmeml) that removes silences from a Premiere XML or local video. Use when the user asks for 無音カット, ジェットカット, silence cut, tempo cut, or XML cut-plan output.
---

# Excalidraw Silence Cut

Use this skill when the user wants a silence-cut edit plan. The output is **Premiere XML only** under `canvas/assets/`; do not promise a rendered video, a video media element, or a result card on the canvas.

## Preconditions

- `ffmpeg` and `ffprobe` must be available on PATH (or set `FFMPEG_PATH` / `FFPROBE_PATH`).
- Default/recommended model is `elevenlabs-scribe-v2` via BuzzAssist login. Use `ffmpeg-local` only when the user wants a fully local/offline threshold cut.

## 生成前の確認（必須）

`silence_cut_excalidraw_video` は `confirmedSettings: true` なしの本実行を拒否します（`dryRun: true` のカットプラン確認は例外で常に可）。ユーザーのメッセージで全設定が明示されていない限り、本実行前に AskUserQuestion を1回だけ出して確認してください:

- 入力: Premiere XML（推奨）または動画
- モデル: `elevenlabs-scribe-v2`（推奨）または `ffmpeg-local`
- Scribe の場合: フィラー・咳・言い直しの削除強度（0/30/60/90、既定は 40/0/0）

確認できたら `confirmedSettings: true` を付けて呼び出します。

## Workflow

1. Call the plugin `silence_cut_excalidraw_video` tool:

```json
{
  "videoPath": "/absolute/path/to/timeline.xml",
  "model": "elevenlabs-scribe-v2",
  "detectSeconds": 0.6,
  "thresholdDb": "auto",
  "keepSeconds": 0.25,
  "preMarginSeconds": 0.08,
  "postMarginSeconds": 0.12,
  "fillerRemoval": 40,
  "coughRemoval": 0,
  "retakeRemoval": 0,
  "projectDir": "/absolute/path/to/project",
  "confirmedSettings": true
}
```

2. The tool outputs a `.xml` file in `canvas/assets/` and returns `assetUrl`, `inputDuration`, `outputDuration`, `cutDuration`, `cutCount`, and `clipCount`.
3. Report the before/after durations and the XML filename. Tell the user to import the XML into Premiere Pro as the cut-applied sequence.

## Precision Notes

- XML input is preferred because cuts are applied back onto existing timeline clips non-destructively.
- `thresholdDb: "auto"` measures the media noise floor and uses noise floor + 6dB for ffmpeg-local detection.
- ffmpeg-local analyzes a speech-focused temporary audio track with highpass/noise reduction, while leaving source media untouched.
- Scribe mode uses word timestamps, keeps breath-like pauses, leaves longer pauses after sentence endings, and can remove fillers/coughs/retakes.

## SRTと併用するときの順序

字幕も付ける場合は**先に無音カットXMLを作る → Premiereで適用/書き出し → カット後の音声から `generate_excalidraw_subtitles` でSRT生成**。逆順だとカットした分だけ字幕の全タイムコードがズレます。

## Guardrails

- If the tool reports no detectable silence or near-total silence, relay the message instead of retrying with random parameters.
- Do not add `audioFadeSeconds`; XML output has no rendered audio crossfade.
