# BuzzAssist

BuzzAssist は、Codex、Claude Desktop、Claude Code から同じローカル Excalidraw キャンバスを操作するための、プロジェクト単位のキャンバス・メディア生成プラグインです。

正しいセットアップ URL はこれです。

```text
https://github.com/sam-mountainman/BuzzAssist
```

古い所有者名のURLは使わないでください。

## まず答え

- **macOS でも Windows でも使えます。** Node.js 20 以上が必要です。macOS/Linux は `./scripts/*.sh` も使えますが、Windows は `node scripts/*.mjs` を使います。
- **主対象は Codex、Claude Desktop、Claude Code です。** Codex と Claude Desktop は native MCP Apps widget を使います。Claude Code は widget を描画しないため、ローカルURL + MCP tools を使います。Cursor / Antigravity は互換コードを残していますが、通常導線では扱いません。
- **スマホや別PCで同じ Excalidraw UI を開く場合は Canvas Tunnel を使います。** 既定は Cloudflare (`cloudflared`) です。PCが起動していて、ローカルのキャンバスサーバーとトンネルが動いている必要があります。
- **READMEとセットアップ手順は日本語前提です。** コマンド名、モデルID、環境変数だけ英語のままです。

## エージェントURLセットアップ

Codex、Claude Desktop、または Claude Code に次のURLを貼り付けて、「セットアップして」と指示してください。手動でプラグインIDを入力する必要はありません。

```text
https://github.com/sam-mountainman/BuzzAssist
```

エージェントはリポジトリを clone/open し、自分自身のホストだけを設定します。

```bash
node scripts/setup-agents.mjs --agent codex --project-dir /path/to/active/project
node scripts/setup-agents.mjs --agent claude-desktop --project-dir /path/to/active/project
node scripts/setup-agents.mjs --agent claude --project-dir /path/to/active/project
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

Codex と Claude Desktop では、PC上のエージェント作業は `BUZZASSIST_CANVAS_URL` を直接開かず、`render_buzzassist_canvas_widget` で native widget 内にキャンバス本体を表示します。Claude Code では `BUZZASSIST_CANVAS_URL` を in-app browser で開きます。スマホや別PCでは `BUZZASSIST_TUNNEL_ACCESS_URL` を開きます。

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
node scripts/setup-agents.mjs --agent claude-desktop --project-dir C:\path\to\active\project
node scripts/start-canvas.mjs C:\path\to\active\project
npm run tunnel:start -- --project-dir C:\path\to\active\project
```

### Linux

Node.js 20 以上と `cloudflared` があれば使えます。

## 対応ホスト

| ホスト | 対応 | セットアップ内容 |
|---|---:|---|
| Codex | 対応 | `.codex-plugin/plugin.json` とローカル marketplace を使って `buzzassist@buzzassist` を追加。`render_buzzassist_canvas_widget` で native MCP Apps widget 内にキャンバス本体を表示します。 |
| Claude Desktop | 対応 | `claude_desktop_config.json` に `mcpServers.buzzassist` を追加。Claude Desktopを再起動後、`render_buzzassist_canvas_widget` で native MCP Apps widget 内にキャンバス本体を表示します。 |
| Claude Code | 対応 | `.claude-plugin/plugin.json` とローカル marketplace を使って `buzzassist@buzzassist` を追加。Claude Codeはwidget描画を持たないためMCP tools中心です。 |

重要: セットアップスクリプトは、指定されたホスト以外を勝手に変更しません。

互換用にCursor / Antigravity設定コードは残っていますが、通常はCodex、Claude Desktop、またはClaude Codeだけを設定してください。

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
- `buzzassist_mcp`: このリポジトリのプロジェクトローカルMCPサーバー。必要に応じてローカルキャンバスを自動起動します。

主なローカルツール:

- `render_buzzassist_canvas_widget`: Codex / Claude Desktop互換のMCP Apps widget内にBuzzAssistキャンバス本体を表示する。裏側ではローカルCanvasサーバーを使い、スマホURL作成や依頼文のチャット送信もできます。
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
- `prepare_canvas_attachments`: キャンバスで選択中の画像・動画・SRT・XMLを現在のチャットへ添付bundleとして読み込む
- `read_canvas_attachment_bundle`: キャンバスUIで作成した添付bundleを現在のチャットで読む
- `list_canvas_attachment_bundles`: 最近作成した添付bundleを確認
- `buzzassist_login`: BuzzAssistアカウントへブラウザーサインイン
- `buzzassist_auth_status`: サインイン状態を確認

HTTP MCP はキャンバスプロセスの `/mcp` でも提供されますが、token保護されています。現在の `mcpUrl` と `token` は `canvas/.server.json` を見てください。

## キャンバスからチャットへ送る

キャンバス上の画像・動画・SRT・XMLを選択すると、選択ツールバーにチャット送信ボタンとダウンロードボタンが出ます。

チャット送信ボタンを押すと、キャンバス上に小さな入力ポップアップが出ます。そこで修正内容や依頼を書いて送信すると、選択ファイルを `canvas/.agent-attachments/` にbundle化し、依頼文と読み取り指示を現在のCodexチャットへ自動送信します。

```text
ここをもう少し明るくして、背景はそのままで。

BuzzAssistのキャンバス添付 <bundleId> を読んで。
```

Codex / Claude Code 側では、プラグインMCPツールがそのbundleを現在の会話に読み込みます。Codex widget内ではCowart同様にMCP Appsのnative host bridge (`app.sendMessage`) を使ってチャットへ送ります。ローカルURL/in-app browserではGUI自動送信を試し、自動送信できない環境では同じ文をクリップボードへ入れてfallbackします。

```text
prepare_canvas_attachments
read_canvas_attachment_bundle
list_canvas_attachment_bundles
```

この方式を本線にしている理由:

- bundle作成とMCP読み取りはmacOS/Windows共通です。チャット欄への自動貼り付けはホスト/OSが許す範囲で行い、無理な場合はコピーfallbackします。
- Claude Codeで別の新規チャットへ添付される事故を避けられます。
- 画像は小さい場合MCP結果に直接入り、動画や大きいファイルは安全なローカルresource linkとして渡ります。
- ブラウザがホストアプリのチャット欄を直接操作できない制約を回避できます。
- Codexの通常添付チップ表示はホスト側制限で安定しないため、Cowart寄りの「キャンバス上で依頼を書いて、native host bridgeまたはローカルGUI bridgeでチャットへ自動送信」を優先します。

古い `/api/chat/send` のGUI貼り付け経路は互換用に残っていますが、メディア添付の本線ではありません。

## Codex Widget / Claude Desktop Widget

Codex と Claude Desktop では、通常のローカルURLを直接開くのではなく、`render_buzzassist_canvas_widget` でMCP Apps widget内にキャンバス本体を表示します。

このwidgetは `ui://widget/buzzassist/canvas.html` としてホスト内に表示されます。普通のWeb URLではありません。ローカルCanvasサーバーは裏側の実行基盤として起動しますが、Codex / Claude Desktop上ではキャンバスUI自体がwidget内に出ます。

できること:

- キャンバス本体をwidget内に表示する
- Cloudflare Canvas TunnelのスマホURLを起動/確認する
- widget内の入力欄からCodex/Claude Desktopへfollow-up依頼を送る
- 選択素材を `prepare_canvas_attachments` で取得し、ホストが対応していれば `image` / `resource_link` / `resource` content blockとしてチャットへ直接送る

ホストが添付blockに未対応、または送信を拒否した場合は、従来どおりbundle読み込み指示へ自動fallbackします。

注意:

- Claude Codeはターミナル型ホストなので、widget自体は描画しません。Claude CodeではMCP toolsを使います。
- Claude Desktop / Claude web はMCP Apps対応ホストなので、同じ `ui://` resourceを表示できる可能性があります。
- スマホでは `ui://` は開けません。スマホはCloudflare Canvas Tunnel URLを使います。

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
