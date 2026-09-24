---
name: excalidraw-open-canvas
description: 現在のプロジェクトに紐づくローカルの BuzzAssist Excalidraw キャンバスを開く。Codex や Claude Code で「キャンバスを開いて」「Excalidrawを起動して」「キャンバスを見せて」「Excalidrawで作業したい」と言われたとき（open / launch / view / work in Excalidraw）に使う。スマホなどマシンの外から同じキャンバスを開きたいとき（Canvas Tunnel）もここから始める。
---

# Excalidraw キャンバスを開く

## 手順

1. ホストのタスクの current workspace/project root（現在のワークスペース／プロジェクトのルート）
   を特定する。これはユーザーがいま Codex や Claude Code で開いているプロジェクトのこと。
   BuzzAssist の plugin・cache・リポジトリのディレクトリで代用しない。以前のセットアップで
   選んだプロジェクトも、そこにサーバーがすでにあるという理由だけで使い回さない。

2. その絶対パスを渡して、plugin の `open_buzzassist_canvas` ツールを呼ぶ。

```json
{
  "projectDir": "/absolute/path/to/current/user/project"
}
```

`projectDir` を省略しても MCP サーバーはホストの MCP workspace roots を自動で読むが、
ホストが現在の作業ディレクトリを公開しているときは必ず明示して渡す。このツールは
このプロジェクトのサーバーを起動（すでにあれば再利用）し、`<project>/canvas/assets` を作り、
そのプロジェクトの live な `canvasUrl` を返す。

3. plugin ツールが使えない場合は、サービスを手動で起動し、動かし続ける。

```bash
node scripts/serve-canvas.mjs /path/to/current/user/project
```

これは BuzzAssist リポジトリのルートで実行する。macOS、Windows PowerShell、Linux の
どれでも同じコマンドで動く。

4. 返ってきたローカル URL は、まず現在のホストの in-app browser で開く。Codex では
in-app Browser ツールを、Claude Code ではそのブラウザーツールを使う。その機能が公開されて
いるときは、これが必須。キャンバスの接続クライアントがいま 0 件だというだけで、
機能が利用できないと推測しない。

現在のホストが in-app Browser 機能を公開していない（利用できない）ときに限り、明示的な
external-browser フォールバックを付けて plugin ツールをもう一度呼ぶ。

```json
{
  "projectDir": "/absolute/path/to/current/user/project",
  "openExternalBrowser": true
}
```

これは Chrome/Chromium を優先し、無ければプラットフォームの既定ブラウザーへフォールバックする。
in-app Browser を試す前に `open`、`xdg-open` などのコマンドを実行しない。

既定の URL はたいてい次のとおり。

```text
http://127.0.0.1:43219/
```

そのポートが使用中なら、サーバーは別のローカルポートを選ぶ。live な `url` は現在の
プロジェクトの `canvas/.server.json` から読む。プロジェクトが違えば、別々の localhost
ポートで同時に動かせる。

キャンバスのデータは次に保存される。

```text
<current-project>/canvas/excalidraw-canvas.json
<current-project>/canvas/excalidraw-selection.json
<current-project>/canvas/assets/
```

ブラウザーを操作できず、明示的な外部ブラウザーのフォールバックも呼べない場合は、
サービスの起動を成功として扱い、ユーザーにローカル URL を伝える。

## スマホ・モバイルから同じ UI で開く

ユーザーがスマホからキャンバスを開きたい、マシンの外へ共有したい、まったく同じ
Excalidraw UI をリモートで使いたいと言ったら、BuzzAssist Remote Canvas ではなく
Canvas Tunnel を使う。

```bash
npm run tunnel:start -- --project-dir /path/to/user/project
```

Canvas Tunnel は既定で Cloudflare（`cloudflared`）を使う。quick tunnel ならアカウントは
要らない。`cloudflared` が入っていなければ、インストールするようユーザーに伝える。
固定の `canvas.buzzassist.ai` URL を使うときは、ユーザーが `cloudflared tunnel login` を
1回実行し、そのあと `--cf-hostname canvas.buzzassist.ai` を付けて起動する。

ngrok は、ユーザーが ngrok を明示的に求めたときだけ使う。

```bash
npm run tunnel:start -- --project-dir /path/to/user/project --provider ngrok --ngrok-authtoken <token>
```

トンネルは公開 URL と Access URL を表示する。スマホ用にはユーザーへ Access URL を渡す。
デスクトップでの作業には、引き続きローカルの `BUZZASSIST_CANVAS_URL` を現在のホストの
in-app browser で開く。external-browser のフォールバックは、その in-app 機能が利用できない
ときだけ使う。

終わったらトンネルを止める。

```bash
npm run tunnel:stop -- --project-dir /path/to/user/project
```

## 補足

この設計は意図的に Cowart のローカルサービスの形にそろえている。ブラウザーはプロジェクト内の
キャンバスファイルを編集し、Codex は状態の読み書きを plugin ツールで安定して行う。
