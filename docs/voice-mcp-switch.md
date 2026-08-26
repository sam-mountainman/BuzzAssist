# MCP の音声呼び先切替（ElevenLabs → BuzzAssist）

仕様書『音声サービス_基盤とWeb_詳細仕様_v1』②C の実装。
方針: **ElevenLabs の直叩きは廃止し、すべて BuzzAssist の音声基盤（`/api/voice/*`）経由にする。**

## 変更点

| ファイル | 変更 |
|---|---|
| `lib/buzzassistVoice.mjs`（新規） | BuzzAssist 音声APIのクライアント。生成・声一覧・残り分数・読み辞書・長文ジョブのポーリング |
| `lib/speechGeneration.mjs` | `generateSpeech()` / `listVoices()` / `resolveSpeechProvider()` を追加。`writeSpeechAsset()` の生成をプロバイダー切替経由に |
| `mcp/server.mjs` | `get_elevenlabs_voices` → **`get_voices`**（ライブラリ声＋アカウント専用声）。**`manage_elevenlabs_voice_library` は廃止（削除）**。`generate_excalidraw_speech` は BuzzAssist 経由に |
| `lib/mediaCredits.mjs` | `estimateVoiceGenerationCost()` を追加（¥40/分。`payloadPreview` で「約◯分・¥◯」を出せる） |

## プロバイダーの選択

既定は **BuzzAssist**。移行期間だけ環境変数で従来動作に戻せる。

```bash
SPEECH_PROVIDER=elevenlabs   # 一時的に ElevenLabs 直叩きへ戻す（移行期間のみ）
BUZZASSIST_API_BASE=https://buzzassist.ai   # 既定。ローカル検証時は http://localhost:3000
```

認証は既存のデスクトップ認証をそのまま使う（`buzzassist_login` / `BUZZASSIST_MEDIA_TOKEN`）。
新しい認証は作っていない。

## alignment（文字タイムスタンプ）

BuzzAssist は `[{char, start, end}]` で返すので、`alignmentFromBuzzAssist()` が
ElevenLabs 形式（`characters` / `characterStartTimesSeconds` / `characterEndTimesSeconds`）へ変換する。
そのため **`speechBoundsFromAlignment()` と吹き出し同期は無改修で動く**（仕様の要件）。

## 検証

`BUZZASSIST_API_BASE=http://localhost:3000 node scripts/voiceMcpE2E.mjs` → **10/10 PASS**

ローカルの BuzzAssist（next dev + ローカル Convex + MockProvider）に対して実際に音声を生成し、
実音声（87KB mp3・5.44秒）・alignment 32文字・`speechBoundsFromAlignment` の結果（0.1s〜5.32s）・
課金秒数の取得までを確認済み。

## 残作業

- 本番の BuzzAssist に対する疎通確認（`buzzassist_login` でログイン後に `get_voices` → `generate_excalidraw_speech`）
- `~/.buzzassist/elevenlabs.json`（ElevenLabs APIキー）を読むコードは、移行期間のフォールバック用に残してある。
  BuzzAssist 側の TTS サーバ接続が完了したら削除する
- `lib/voiceLibraryCasting.mjs` は `manage_elevenlabs_voice_library` の廃止で未使用になった。
  他から参照が無いことを確認のうえ削除してよい
