---
name: excalidraw-subtitle-gen
description: 音声ファイルから BuzzAssist クラウド（ElevenLabs）で日本語の SRT 字幕を作り、ローカルの Excalidraw キャンバスへ SRT カードとして置く。「字幕を作って」「SRTにして」「テロップを付けて」「音声を文字起こしして字幕にして」など、音声やナレーション台本から subtitles / SRT / テロップ / 字幕 を求められたときに使う。動画ファイルからの字幕や、複数ファイルの一括字幕生成もここで扱う。
---

# Excalidraw 字幕生成

ユーザーが音声から SRT 字幕を作ってキャンバスへ置きたいときに使う。

## 前提

- 現在（current）の Codex / Claude Code タスクのワークスペースルートを特定し、すべての
  BuzzAssist ツール呼び出しへ `projectDir` として渡す。plugin cache、BuzzAssist の
  ソースリポジトリ、インストール時に記憶したプロジェクトへは書き込まない。現在の
  プロジェクトのキャンバスが開いていなければ、先に `open_buzzassist_canvas({ projectDir })`
  を呼ぶ。
- Excalidraw キャンバスのサービスが動いている必要がある。既定のポートが使用中だった場合は `canvas/.server.json` を読む。
- BuzzAssist へのログインが必要。plugin の `buzzassist_auth_status` ツールで確かめ、`buzzassist_login`（ブラウザーが開く）でサインインする。
- `durationSeconds` を渡さないときは、音声の長さを `ffprobe` で調べる。

## 生成前の確認（必須）

`generate_excalidraw_subtitles` は `confirmedSettings: true` なしの呼び出しを拒否する。ユーザーのメッセージで全設定が明示されていない限り、生成前に AskUserQuestion を1回だけ出して確認する: モード（台本あり=scripted / 台本なし=scriptless）・行数（1 or 2）・最大文字数。推奨デフォルト: 台本があるなら scripted・2行・30字。確認できたら `confirmedSettings: true` を付けて呼び出す（two-step LLM フローの2回目の呼び出しにも付ける）。

## 手順

1. 現在のタスクの絶対パスの `projectDir` を特定してから、`buzzassist_auth_status` で
   認証を確かめる。ログインしていなければ `buzzassist_login` を実行し、ブラウザーで
   サインインを済ませるようユーザーに頼む。
2. モードがはっきりしないときは、どちらかを聞く。
   - 台本あり (scripted): `scriptText` か `scriptPath` を渡す。ElevenLabs Forced Alignment を使う。
   - 台本なし (scriptless): 音声だけ。ElevenLabs Scribe v2 を使う。
3. plugin の `generate_excalidraw_subtitles` ツールを呼ぶ。

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

4. このツールは BuzzAssist のクレジットを予約し、タイムスタンプ付きの単語を作り、SRT の
   キューをローカルで組み立て、`.srt` を `canvas/assets/` に保存し、SRT カードをキャンバスへ
   置く。`cueCount`、`credits`、アセットパスを報告する。

## 改行の質を上げる（LLM フロー）

最良の品質にするには、1回の呼び出しではなく2段階のフローを使う。2段階目で決めるのは字幕の改行位置だけ。

1. `returnWordsOnly: true` を付けて `generate_excalidraw_subtitles` を呼ぶ。文字起こしとタイムスタンプ付きの `words` が返る。
2. タイムスタンプ付きの単語からキューの区切りを決める。日本語として自然な文節の境目で切り（助詞の直後では決して切らない、複合動詞の途中でも切らない）、1キュー1〜2行にし、`maxCharsPerLine` を守り、2行目は `\n` で改行する。
3. `subtitleLines: [{text, start, end}, ...]` を付けてツールをもう一度呼ぶ。SRT を描き出してカードを置くが、クラウドは2回目を呼ばない（追加のクレジットはかからない）。各キューの start/end は単語のタイミングから取ったまま保つ。

## 無音カットと併用するときの順序

先に `silence_cut_excalidraw_video` でカットし、**カット後の動画/音声からSRTを生成**する。逆順だとカットした分だけ全タイムコードがズレる。

## 高精度化オプション

- `audioPath` は動画ファイル（mp4/mov/webm/mkv…）も可 — 音声トラックを自動抽出して転写
- `glossary: [{from, to}]` — 固有名詞の表記補正（用語辞書）。文字起こし直後に適用され、カタカナ/ひらがなの表記ゆれにも自動でマッチ
- `normalizeAudio` (default true) — 常にラウドネス正規化＋低域ノイズ除去（highpass 80Hz）をかけてから転写。認識精度と時刻精度が上がる
- 品質検証: 行長超過・重複・極短キュー・読速超過（10.5字/秒超）を自動検出し、違反があれば文字数を詰めて一度だけ再分割した良い方を採用。さらに音声エネルギーと照合して「無音区間の字幕」「字幕のない発話区間」も警告（結果の `quality.issues` で確認可能）

## 一括生成

複数の音声/動画をまとめて処理するときは `generate_excalidraw_subtitles_batch` を使う: `jobs: [{audioPath, scriptText?, fileName?}, …]` に共有設定（lineCount/maxCharsPerLine/…）を添えて1回で呼び、ジョブごとにSRTカードが置かれる。設定確認（AskUserQuestion）は共有設定に対して1回だけ。

## 守ること

- ユーザーが指定していないとき、出力を大きく変える設定（mode、lineCount、maxCharsPerLine）は推測せずに確認する。
- 失敗するとクレジットの予約は自動で返金される。エラーメッセージは手を加えずそのまま伝える。
