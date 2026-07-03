---
name: excalidraw-subtitle-gen
description: Generate Japanese SRT subtitles from an audio file via BuzzAssist cloud (ElevenLabs) and place an SRT card on the local Excalidraw canvas. Use when the user asks for subtitles, SRT, テロップ, or 字幕 from audio or a narration script.
---

# Excalidraw Subtitle Gen

Use this skill when the user wants SRT subtitles generated from audio and placed on the canvas.

## Preconditions

- The Excalidraw canvas service should be running (default `http://127.0.0.1:43219`).
- BuzzAssist login is required. Check with the MCP `buzzassist_auth_status` tool; sign in with `buzzassist_login` (opens a browser).
- `ffprobe` is used to probe audio duration when `durationSeconds` is not given.

## Workflow

1. Confirm auth with `buzzassist_auth_status`. If not logged in, run `buzzassist_login` and ask the user to finish sign-in in the browser.
2. Ask which mode when unclear:
   - 台本あり (scripted): pass `scriptText` or `scriptPath` — uses ElevenLabs Forced Alignment.
   - 台本なし (scriptless): audio only — uses ElevenLabs Scribe v2.
3. Call the MCP `generate_excalidraw_subtitles` tool:

```json
{
  "audioPath": "/absolute/path/to/narration.wav",
  "scriptText": "<optional full script>",
  "lineCount": 2,
  "maxCharsPerLine": 14,
  "holdSeconds": 0,
  "punctuationMode": "auto",
  "fillerMode": "safe",
  "projectDir": "/absolute/path/to/project"
}
```

4. The tool reserves BuzzAssist credits, generates timed words, builds SRT cues locally, saves the `.srt` under `canvas/assets/`, and places an SRT card on the canvas. Report `cueCount`, `credits`, and the asset path.

## Higher-Quality Line Breaks (LLM Flow)

For the best semantic line breaks, use the two-step flow instead of one call:

1. Call `generate_excalidraw_subtitles` with `returnWordsOnly: true` — you get the transcript and timed `words`.
2. Decide cue boundaries yourself: natural Japanese phrase boundaries, 1-2 lines per cue, respect `maxCharsPerLine`, never split 名詞+助詞 pairs awkwardly, and use `\n` for the second line.
3. Call the tool again with `subtitleLines: [{text, start, end}, ...]` — it renders the SRT and places the card without a second cloud call (no extra credits).

## Guardrails

- Confirm settings that materially change output (mode, lineCount, maxCharsPerLine) instead of guessing when the user did not specify them.
- Credit reservation is refunded automatically on failure; surface the error message as-is.
