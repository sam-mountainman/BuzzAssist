---
name: excalidraw-subtitle-gen
description: Generate Japanese SRT subtitles from an audio file via BuzzAssist cloud (ElevenLabs) and place an SRT card on the local Excalidraw canvas. Use when the user asks for subtitles, SRT, テロップ, or 字幕 from audio or a narration script.
---

# Excalidraw Subtitle Gen

Use this skill when the user wants SRT subtitles generated from audio and placed on the canvas.

## Preconditions

- Resolve the current Codex/Claude Code task's workspace root and pass it as
  `projectDir` to every BuzzAssist tool call. Never write into the plugin cache,
  BuzzAssist source repository, or a project remembered at install time. Call
  `open_buzzassist_canvas({ projectDir })` first when the current project's
  canvas is not open.
- The Excalidraw canvas service should be running; read `canvas/.server.json` if the default port was busy.
- BuzzAssist login is required. Check with the plugin `buzzassist_auth_status` tool; sign in with `buzzassist_login` (opens a browser).
- `ffprobe` is used to probe audio duration when `durationSeconds` is not given.

## 生成前の確認（必須）

`generate_excalidraw_subtitles` は `confirmedSettings: true` なしの呼び出しを拒否します。ユーザーのメッセージで全設定が明示されていない限り、生成前に AskUserQuestion を1回だけ出して確認してください: モード（台本あり=scripted / 台本なし=scriptless）・行数（1 or 2）・最大文字数。推奨デフォルト: 台本があるなら scripted・2行・30字。確認できたら `confirmedSettings: true` を付けて呼び出します（two-step LLM フローの2回目の呼び出しにも付ける）。

## Workflow

1. Resolve the current task's absolute `projectDir`, then confirm auth with
   `buzzassist_auth_status`. If not logged in, run `buzzassist_login` and ask
   the user to finish sign-in in the browser.
2. Ask which mode when unclear:
   - 台本あり (scripted): pass `scriptText` or `scriptPath` — uses ElevenLabs Forced Alignment.
   - 台本なし (scriptless): audio only — uses ElevenLabs Scribe v2.
3. Call the plugin `generate_excalidraw_subtitles` tool:

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

For the best quality, use the two-step flow instead of one call. Step 2 only decides subtitle line breaks:

1. Call `generate_excalidraw_subtitles` with `returnWordsOnly: true` — you get the transcript and timed `words`.
2. Decide cue boundaries from the timed words: natural Japanese bunsetsu boundaries (never right after a particle, never mid compound verb), 1-2 lines per cue, respect `maxCharsPerLine`, and use `\n` for the second line.
3. Call the tool again with `subtitleLines: [{text, start, end}, ...]` — it renders the SRT and places the card without a second cloud call (no extra credits). Keep each cue's start/end from the word timings.

## 無音カットと併用するときの順序

先に `silence_cut_excalidraw_video` でカットし、**カット後の動画/音声からSRTを生成**してください。逆順だとカットした分だけ全タイムコードがズレます。

## 高精度化オプション

- `audioPath` は動画ファイル（mp4/mov/webm/mkv…）も可 — 音声トラックを自動抽出して転写
- `glossary: [{from, to}]` — 固有名詞の表記補正（用語辞書）。文字起こし直後に適用され、カタカナ/ひらがなの表記ゆれにも自動でマッチ
- `normalizeAudio` (default true) — 常にラウドネス正規化＋低域ノイズ除去（highpass 80Hz）をかけてから転写。認識精度と時刻精度が上がる
- 品質検証: 行長超過・重複・極短キュー・読速超過（10.5字/秒超）を自動検出し、違反があれば文字数を詰めて一度だけ再分割した良い方を採用。さらに音声エネルギーと照合して「無音区間の字幕」「字幕のない発話区間」も警告（結果の `quality.issues` で確認可能）

## 一括生成

複数の音声/動画をまとめて処理するときは `generate_excalidraw_subtitles_batch` を使う: `jobs: [{audioPath, scriptText?, fileName?}, …]` に共有設定（lineCount/maxCharsPerLine/…）を添えて1回で呼び、ジョブごとにSRTカードが置かれる。設定確認（AskUserQuestion）は共有設定に対して1回だけ。

## Guardrails

- Confirm settings that materially change output (mode, lineCount, maxCharsPerLine) instead of guessing when the user did not specify them.
- Credit reservation is refunded automatically on failure; surface the error message as-is.
