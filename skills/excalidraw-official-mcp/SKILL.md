---
name: excalidraw-official-mcp
description: 公式の Excalidraw MCP App（official Excalidraw MCP）で、プロンプトから図を作る（prompt-to-diagram）。「公式のExcalidraw MCPで」「本家のExcalidraw MCP（original Excalidraw MCP）を使って」「図をさっと作って」と言われたときなど、このリポジトリのローカルに保存されるキャンバスを編集するのではなく、手早く図を生成したいときに優先して使う。
---

# 公式 Excalidraw MCP

ユーザーが公式の Excalidraw MCP を求めたとき、またはプロンプトから図を作る流れを望んだときに
使う。結果をいま開いているローカルのブラウザーキャンバスに置きたい場合は、リモートの公式
サーバーではなく、ローカルの `excalidraw_mcp` stdio サーバーを使う。

## MCP サーバー

plugin の設定は、オープンソースの公式 Excalidraw MCP App を次の名前で公開している。

```json
{
  "name": "excalidraw_official",
  "type": "http",
  "url": "https://mcp.excalidraw.com/mcp"
}
```

ローカルのブラウザーキャンバス用には、plugin の設定が次を公開している。

```json
{
  "name": "buzzassist_mcp",
  "command": "node",
  "args": ["<managed-plugin>/scripts/start-mcp.mjs"]
}
```

## 振り分け

- ホストされた公式 Excalidraw MCP App での生成と、対話型の MCP App 描画には
  `excalidraw_official` を使う。
- ユーザーが「このキャンバス」「ブラウザーの画面」「ローカルの Excalidraw キャンバス」
  （"this canvas"、"browser screen"、"local Excalidraw canvas"）と言ったら、ローカルの
  `buzzassist_mcp` サーバーを使う。現在のホストタスクのワークスペースルート（current
  workspace root）の絶対パスを `projectDir` として渡す。plugin cache、BuzzAssist のソース
  リポジトリ、セットアップ時のプロジェクトで代用しない。
- ローカルの `buzzassist_mcp` は公式互換の `read_me` と `create_view` を実装している。
  `create_view` は `<current-project>/canvas/` へ書き込み、ブラウザーはそのプロジェクトの
  キャンバスイベントストリーム経由で更新される。現在のプロジェクトのキャンバスが開いて
  いなければ、先に `open_buzzassist_canvas({ projectDir })` を呼ぶ。
- クライアントが MCP Apps に対応していない場合は、公式サーバーへの MCP 接続自体はできても、
  そのクライアントでは対話型アプリの描画が使えないことがあると説明する。

## プロンプトの書き方

公式 MCP には具体的な図の目的を渡す。次を含める。

- 図の種類
- ノード、または登場する主体（アクター）
- 関係、または流れの向き
- 必ず表示するラベル
- 見た目のグループ分けの要件

追加の修正も「データベースを API サーバーの下へ移動して」「認証の経路を破線の矢印にして」
のように具体的に指示する。
