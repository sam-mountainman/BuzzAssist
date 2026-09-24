---
name: excalidraw-silence-cut
description: Premiere XML またはローカルの動画から無音部分を取り除く、非破壊の Premiere Pro XML（FCP7 xmeml）を作る。「無音カットして」「ジェットカットして」「間を詰めて」「テンポよくカットして」「カット用のXMLがほしい」など、無音カット・ジェットカット・silence cut・tempo cut・XML のカットプラン出力を求められたときに使う。
---

# Excalidraw 無音カット

ユーザーが無音カットの編集プランを求めたときに使う。出力は `canvas/assets/` に置く
**Premiere XML だけ**。キャンバスにも、行番号・スクロール・ダウンロード・チャット添付の
操作を持つ、SRT 風の選択できるテキストプレビューとして挿入される。書き出し済みの動画や
動画メディア要素ができるとは約束しない。

## 前提

- 現在（current）の Codex / Claude Code タスクのワークスペースルートを特定し、すべての
  BuzzAssist ツール呼び出しへ `projectDir` として渡す。plugin cache、BuzzAssist の
  ソースリポジトリ、インストール時に記憶したプロジェクトへは書き込まない。現在の
  プロジェクトのキャンバスが開いていなければ、先に `open_buzzassist_canvas({ projectDir })`
  を呼ぶ。
- `ffmpeg` と `ffprobe` が PATH 上にあること（または `FFMPEG_PATH` / `FFPROBE_PATH` を設定する）。
- 既定かつ推奨のモデルは、BuzzAssist ログイン経由の `elevenlabs-scribe-v2`。`ffmpeg-local` は、ユーザーが完全にローカル／オフラインのしきい値カットを望むときだけ使う。

## 生成前の確認（必須）

`silence_cut_excalidraw_video` は `confirmedSettings: true` なしの本実行を拒否する（`dryRun: true` のカットプラン確認は例外で常に可）。ユーザーのメッセージで全設定が明示されていない限り、本実行前に AskUserQuestion を1回だけ出して確認する。

- 入力: Premiere XML（推奨）または動画
- モデル: `elevenlabs-scribe-v2`（推奨）または `ffmpeg-local`
- Scribe の場合: フィラー・咳・言い直しの削除強度（0/30/60/90、既定は 40/0/0）

確認できたら `confirmedSettings: true` を付けて呼び出す。

## 手順

1. plugin の `silence_cut_excalidraw_video` ツールを呼ぶ。

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

2. ツールは `.xml` ファイルを `canvas/assets/` に出力し、行番号付きの SRT 風 XML プレビューを
   キャンバスへ挿入して、`assetUrl`、`elementId`、`inputDuration`、`outputDuration`、
   `cutDuration`、`cutCount`、`clipCount` を返す。
3. カット前後の長さと XML のファイル名を報告する。XML をカット適用済みのシーケンスとして
   Premiere Pro へ読み込むよう、ユーザーに伝える。

## 精度についての補足

- XML 入力を優先する。既存のタイムラインのクリップへ、非破壊でカットを適用し直せるため。
- `thresholdDb: "auto"` はメディアのノイズフロアを測り、ffmpeg-local の検出にはノイズフロア + 6dB を使う。
- ffmpeg-local は、highpass・ノイズ除去をかけた発話向けの一時音声トラックを解析する。元のメディアには手を加えない。
- Scribe モードは単語のタイムスタンプを使い、息継ぎ程度の間は残し、文末の後には長めの間を残す。フィラー・咳・言い直しも取り除ける。

## SRTと併用するときの順序

字幕も付ける場合は**先に無音カットXMLを作る → Premiereで適用/書き出し → カット後の音声から `generate_excalidraw_subtitles` でSRT生成**。逆順だとカットした分だけ字幕の全タイムコードがズレる。

## 守ること

- 検出できる無音が無い、またはほぼ全体が無音だとツールが報告したら、パラメーターを当てずっぽうに変えて再試行せず、そのメッセージを伝える。
- `audioFadeSeconds` は付けない。XML 出力には、書き出した音声のクロスフェードが存在しないため。
