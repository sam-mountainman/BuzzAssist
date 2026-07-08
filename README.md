# BuzzAssist

BuzzAssist は、Codex / Claude Code / Cursor / Antigravity から同じローカル Excalidraw キャンバスを操作するための、プロジェクト単位のキャンバス・メディア生成プラグインです。

正しいセットアップ URL はこれです。

```text
https://github.com/sam-mountainman/BuzzAssist
```

古い所有者名のURLは使わないでください。

## まず答え

- **macOS でも Windows でも使えます。** Node.js 20 以上が必要です。macOS/Linux は `./scripts/*.sh` も使えますが、Windows は `node scripts/*.mjs` を使います。
- **Codex / Claude Code / Cursor / Antigravity に対応しています。** セットアップスクリプトは、指定したホストだけを設定します。全ホストをまとめて設定したい時だけ `--all-agents` を使います。
- **スマホや別PCで同じ Excalidraw UI を開く場合は Canvas Tunnel を使います。** 既定は Cloudflare (`cloudflared`) です。PCが起動していて、ローカルのキャンバスサーバーとトンネルが動いている必要があります。
- **READMEとセットアップ手順は日本語前提です。** コマンド名、モデルID、環境変数だけ英語のままです。

## エージェントURLセットアップ

Codex、Claude Code、Cursor、Antigravity に次のURLを貼り付けて、「セットアップして」と指示してください。手動でプラグインIDを入力する必要はありません。

```text
https://github.com/sam-mountainman/BuzzAssist
```

エージェントはリポジトリを clone/open し、自分自身のホストだけを設定します。

```bash
node scripts/setup-agents.mjs --agent codex --project-dir /path/to/active/project
node scripts/setup-agents.mjs --agent claude --project-dir /path/to/active/project
node scripts/setup-agents.mjs --agent cursor --project-dir /path/to/active/project
node scripts/setup-agents.mjs --agent antigravity --project-dir /path/to/active/project
```

スマホから同じキャンバスを開きたい場合は `--tunnel` を付けます。

```bash
node scripts/setup-agents.mjs --agent codex --project-dir /path/to/active/project --tunnel
```

セットアップが成功すると、ローカルPC用のURLが出ます。

```text
BUZZASSIST_CANVAS_URL=http://127.0.0.1:<port>/
BUZZASSIST_CANVAS_CHECK=ok
```

`--tunnel` を付けた場合は、スマホ用のURLも出ます。

```text
BUZZASSIST_TUNNEL_URL=https://<slug>.trycloudflare.com
BUZZASSIST_TUNNEL_ACCESS_URL=https://<slug>.trycloudflare.com/?t=<generated>
BUZZASSIST_TUNNEL_CHECK=ok
```

PC上のエージェント作業では `BUZZASSIST_CANVAS_URL` を in-app browser で開きます。スマホや別PCでは `BUZZASSIST_TUNNEL_ACCESS_URL` を開きます。

## 対応OS

### macOS

```bash
brew install node
brew install cloudflared
```

ローカルキャンバスだけなら `cloudflared` は不要です。スマホアクセスを使う時だけ必要です。

### Windows

PowerShell で使う想定です。

```powershell
winget install OpenJS.NodeJS.LTS
winget install Cloudflare.cloudflared
```

Windows では `.sh` ではなく、次のように `.mjs` を直接実行します。

```powershell
node scripts/setup-agents.mjs --agent codex --project-dir C:\path\to\active\project
node scripts/start-canvas.mjs C:\path\to\active\project
npm run tunnel:start -- --project-dir C:\path\to\active\project
```

### Linux

Node.js 20 以上と `cloudflared` があれば使えます。

## 対応ホスト

| ホスト | 対応 | セットアップ内容 |
|---|---:|---|
| Codex | 対応 | `.codex-plugin/plugin.json` とローカル marketplace を使って `buzzassist@buzzassist` を追加 |
| Claude Code | 対応 | `.claude-plugin/plugin.json` とローカル marketplace を使って `buzzassist@buzzassist` を追加 |
| Cursor | 対応 | アクティブプロジェクトに `.cursor/mcp.json` と `.cursor/rules/buzzassist.mdc` を書き込み |
| Antigravity | 対応 | アクティブプロジェクトに `.agents/mcp_config.json` と `GEMINI.md` の管理ブロックを書き込み |

重要: セットアップスクリプトは、指定されたホスト以外を勝手に変更しません。全対応ホストをまとめて設定する場合だけ、明示的に `--all-agents` を使います。

```bash
node scripts/setup-agents.mjs --all-agents --project-dir /path/to/active/project
```

## キャンバスの起動

```bash
# macOS / Linux
./scripts/start-canvas.sh /path/to/user/project

# Windowsを含む全OS
node scripts/start-canvas.mjs /path/to/user/project

# package経由
npx buzzassist-canvas-mcp
npx buzzassist-canvas /path/to/user/project
```

既定URLは空いていれば次です。

```text
http://127.0.0.1:43219/
```

ポートが埋まっている場合は次の空きポートを使い、実際のURL、HTTP MCP URL、Bearer token をここに書きます。

```text
canvas/.server.json
```

プロジェクトごとのデータは、そのプロジェクト配下に保存されます。

```text
canvas/excalidraw-canvas.json
canvas/excalidraw-selection.json
canvas/excalidraw-view-state.json
canvas/assets/
canvas/assets-trash/
```

## スマホ・別PCで開く Canvas Tunnel

Canvas Tunnel は、ローカルPCで動いている同じ BuzzAssist / Excalidraw UI を、スマホや別PCから開くための機能です。Remote Canvas の簡易ビューアではなく、ローカルで開くものと同じUIを外から開きます。

```bash
npm run tunnel:start -- --project-dir /path/to/user/project
npm run tunnel:status
npm run tunnel:stop
```

既定は Cloudflare quick tunnel です。アカウントなしでランダムな `*.trycloudflare.com` URL を作れます。

```bash
brew install cloudflared                 # macOS
winget install Cloudflare.cloudflared    # Windows
```

固定URLにしたい場合は、Cloudflareでドメインを管理したうえで、初回だけログインとnamed tunnel作成をします。

```bash
cloudflared tunnel login
cloudflared tunnel create buzzassist-canvas
npm run tunnel:start -- --cf-hostname canvas.buzzassist.ai
```

ngrokを使いたい場合だけ、明示的にproviderを変えます。

```bash
npm run tunnel:start -- --provider ngrok --ngrok-authtoken <token>
```

注意点:

- スマホURLを使うには、ローカルPCが起動していて、キャンバスサーバーとトンネルが動いている必要があります。
- PCとスマホで同時に強く編集すると競合する可能性があります。確認・軽い編集・生成指示が主用途です。
- Cloudflare free plan は単一リクエストのアップロード上限が100MBです。大きい動画をスマホから直接アップロードする場合は引っかかります。
- トンネルURLはセッションtoken付きです。不要になったら `npm run tunnel:stop` で止めます。

MCPツールからも操作できます。

```text
buzzassist_canvas_tunnel_start
buzzassist_canvas_tunnel_status
buzzassist_canvas_tunnel_stop
```

## Cloud Remote Canvas との違い

BuzzAssist Cloud Relay の実験用コマンドも残っていますが、これは Canvas Tunnel とは別物です。

- **Canvas Tunnel**: ローカルと同じフル Excalidraw UI をスマホや別PCで開く。本命の実用ルート。
- **Cloud Remote Canvas**: Cloud側のrelay実験用。フルUIではなく、構成や同期の検証用。

「ローカルで開くものと同じUIが欲しい」場合は Canvas Tunnel を使ってください。

```bash
npm run serve -- \
  --remote-canvas-url https://buzzassist.ai \
  --remote-canvas-session rc_xxx \
  --remote-canvas-token <desktopToken>
```

設計メモ: [docs/remote-canvas-relay-architecture.md](docs/remote-canvas-relay-architecture.md)

## プラグインツール

BuzzAssist は内部的に2つの Excalidraw 系MCPエントリを持ちます。

- `excalidraw_official`: 公式Excalidraw MCP App。prompt-to-diagramやMCP Appレンダリング向け。
- `excalidraw_mcp`: このリポジトリのプロジェクトローカルMCPサーバー。必要に応じてローカルキャンバスを自動起動します。

主なローカルツール:

- `read_me`: `create_view` 用のExcalidraw互換フォーマット説明を返す
- `create_view`: JSON配列のExcalidraw風要素を書き込み
- `get_excalidraw_selection`: 選択中の要素を読む
- `insert_excalidraw_image`: ローカル画像を `canvas/assets/` にコピーして配置
- `insert_excalidraw_video`: ローカル動画を `canvas/assets/` にコピーして配置
- `generate_excalidraw_image`: 画像生成してキャンバスへ挿入
- `generate_excalidraw_video`: 動画生成してキャンバスへ挿入
- `generate_excalidraw_images_batch`: 複数の画像生成フレームを作って順次生成
- `generate_excalidraw_videos_batch`: 複数の動画生成フレームを作って順次生成
- `generate_excalidraw_subtitles`: 音声から日本語SRTを生成してカード配置
- `silence_cut_excalidraw_video`: Premiere XMLまたは動画から無音カットXMLを作成
- `buzzassist_login`: BuzzAssistアカウントへブラウザーサインイン
- `buzzassist_auth_status`: サインイン状態を確認

HTTP MCP はキャンバスプロセスの `/mcp` でも提供されますが、token保護されています。現在の `mcpUrl` と `token` は `canvas/.server.json` を見てください。

## 画像・動画・字幕生成

キャンバスUIとプラグインツールは同じ生成バックエンドを使います。UI上ではモデル名は正規化され、実行先は設定行の `実行先` pill で Codex / Hermes / BuzzAssist / Lovart から選ばれます。

ローカル系モデル:

```text
gpt-image-2-codex
grok-imagine-image-hermes
grok-imagine-video-hermes
```

BuzzAssist cloud系モデル:

```text
nano-banana-2            gpt-image-2              seedream-v5-lite
grok-imagine-image-api   seedance-2               seedance-2-fast
kling-v3                 kling-o3                 kling-v2-6
grok-imagine-video-api
```

Lovart系モデル:

```text
images: lovart-midjourney  lovart-flux-2-max  lovart-nano-banana-pro  lovart-ideogram-v4  lovart-agent
videos: lovart-veo-3-1  lovart-veo-3-1-fast  lovart-hailuo-2-3  lovart-kling-3-omni  lovart-wan-2-6
```

BuzzAssist cloudモデル、cloud字幕、クレジット利用にはサインインが必要です。

```text
buzzassist_login
buzzassist_auth_status
```

headless/CIでは `BUZZASSIST_MEDIA_TOKEN` を使えます。tokenは `~/.buzzassist/excalidraw-media-auth.json` に保存されます。

## SRT・無音カット

- `generate_excalidraw_subtitles` は BuzzAssist subtitle API を呼び、`lib/subtitleGeneration.mjs` の日本語分割でSRTを作ってキャンバスに配置します。
- `silence_cut_excalidraw_video` は `lib/tempoCut.mjs` のffmpegベース処理で、非破壊のPremiere XMLを `canvas/assets/` に出力します。
- どちらも必要な設定が不足している場合は、エージェントが勝手に推測せず確認する設計です。

## バッチ生成

大量生成では、まずキャンバス上に生成フレームを並べ、その後に結果ができたものから置き換えます。

```text
generate_excalidraw_images_batch
generate_excalidraw_videos_batch
```

HTTPでも同じbackendを使えます。

```text
POST /api/generate/images/batch
POST /api/generate/videos/batch
```

## ホスト構成ファイル

```text
.codex-plugin/plugin.json
.claude-plugin/plugin.json
.cursor/mcp.json
.cursor/rules/buzzassist.mdc
.antigravity-plugin/plugin.json
.agents/mcp_config.json
AGENTS.md
CLAUDE.md
GEMINI.md
.mcp.json
skills/
```

プラグイン本体のリポジトリにはユーザーのキャンバスデータを保存しません。必ず作業中プロジェクトの `canvas/` に保存します。

## 開発

```bash
npm install
npm run build
npm test
npm pack --dry-run
```

Excalidraw package は大きめのchunkを含むため、初回のproduction buildは40〜50秒ほどかかることがあります。
