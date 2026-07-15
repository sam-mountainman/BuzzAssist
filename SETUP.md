# BuzzAssist セットアップ

このリポジトリは、GitHub URL と「セットアップして」という指示だけで導入できます。手動でプラグインIDを入力する必要はありません。Codexへ依頼した場合はCodexだけ、Claude Codeへ依頼した場合はClaude Codeだけを設定します。

正しいURL:

```text
https://github.com/sam-mountainman/BuzzAssist
```

古い所有者名のURLは使わないでください。

## 基本

エージェントはリポジトリを clone/open し、自分自身のホストだけを設定してから、ローカルキャンバスURLをまずそのホストの in-app browser で開きます。そのBrowser機能が利用できない場合だけChrome（またはOSの既定ブラウザー）へフォールバックします。

導入後は、別プロジェクトで `@BuzzAssist` を呼び出してもセットアップ時の
保存先を使い回しません。MCP workspace rootから現在のプロジェクトを解決し、
`<現在のプロジェクト>/canvas/` と `canvas/assets/` を作ります。
`--project-dir` は初回起動およびworkspace情報がないホスト向けのfallbackです。
各プロジェクトのURLはそれぞれの `canvas/.server.json` に保存され、同時起動時は
別の空きlocalhostポートを利用します。

```bash
node scripts/setup-agents.mjs --agent codex --project-dir /path/to/active/project
node scripts/setup-agents.mjs --agent claude --project-dir /path/to/active/project
node scripts/setup-agents.mjs --agent cursor --project-dir /path/to/active/project
node scripts/setup-agents.mjs --agent antigravity --project-dir /path/to/active/project
```

スマホから同じ Excalidraw UI を開きたい場合:

```bash
node scripts/setup-agents.mjs --agent codex --project-dir /path/to/active/project --tunnel
```

## Windows / macOS

macOS:

```bash
brew install node
```

Windows:

```powershell
winget install Git.Git
winget install OpenJS.NodeJS.LTS
```

Windowsでは `.sh` ではなく `.mjs` を使います。スマホ用Canvas Tunnelで`cloudflared`が未導入でも、BuzzAssistがCloudflare公式バイナリを初回起動時にユーザー領域へ自動取得し、SHA-256検証後に使用します。自動取得を止めたい場合は`--no-auto-download`または`BUZZASSIST_CLOUDFLARED_AUTO_DOWNLOAD=0`を指定してください。

```powershell
node scripts/setup-agents.mjs --agent codex --project-dir C:\path\to\active\project
node scripts/start-canvas.mjs C:\path\to\active\project
npm run tunnel:start -- --project-dir C:\path\to\active\project
```

## スクリプトがやること

- 必要に応じて npm dependencies をインストール
- 必要に応じてキャンバスUIをbuild
- `~/plugins/buzzassist` に軽量ローカルmarketplaceを作成
- 実際のplugin rootを `~/plugins/buzzassist/plugin` に配置
- Codex: `buzzassist@buzzassist` をCodexへ登録
- Claude Code: `buzzassist@buzzassist` をClaude Codeへ登録
- Cursor: アクティブプロジェクトに `.cursor/mcp.json` と `.cursor/rules/buzzassist.mdc` を作成
- Antigravity: アクティブプロジェクトに `.agents/mcp_config.json` と `GEMINI.md` 管理ブロックを作成
- ローカルキャンバスを起動して `BUZZASSIST_CANVAS_URL=...` を出力
- ブラウザーキャンバスを確認して `BUZZASSIST_CANVAS_CHECK=ok` を出力
- 対象ホストのplugin listを再確認し、`buzzassist@buzzassist`が見つからなければ非ゼロで終了
- Codex / Claude Codeでは、正式なstable Releaseだけを毎日確認する安全な自動更新を登録して`BUZZASSIST_AUTO_UPDATE=enabled`を出力
- `--tunnel` 付きなら Cloudflare Canvas Tunnel を起動して `BUZZASSIST_TUNNEL_ACCESS_URL=...` を出力

既定では指定ホスト以外は変更しません。全ホストを明示的に設定する時だけ使います。

```bash
node scripts/setup-agents.mjs --all-agents --project-dir /path/to/active/project
```

## 出力URL

ローカルPC上のエージェント作業ではこれを使います。

```text
BUZZASSIST_CANVAS_URL=http://127.0.0.1:<port>/
BUZZASSIST_CANVAS_CHECK=ok
BUZZASSIST_AUTO_UPDATE=enabled
```

スマホや別PCでは、`--tunnel` で出るAccess URLを使います。

```text
BUZZASSIST_TUNNEL_ACCESS_URL=https://<slug>.trycloudflare.com/?t=<generated>
BUZZASSIST_TUNNEL_CHECK=ok
```

ブラウザー制御が使えないホストでは、次のファイルのURLを使ってください。

```text
canvas/.server.json
```

トンネルを止める時:

```bash
npm run tunnel:stop
```

## Codex / Claude Codeの自動更新

通常のセットアップでは、対象にしたCodexまたはClaude Codeだけを自動更新対象として登録します。両方を明示的に設定する場合は`--agents codex,claude`を使います。

```bash
node scripts/setup-agents.mjs --agents codex,claude --project-dir /path/to/active/project
```

- macOS: `~/Library/LaunchAgents/ai.buzzassist.plugin-updater.plist`
- Windows: タスクスケジューラの`BuzzAssist Plugin Update`
- 実行時刻: 毎日03:17（ローカル時刻）
- 更新元: `sam-mountainman/BuzzAssist`の正式なstable GitHub Release
- 安全策: 隔離build・配布テスト・実MCP検査・更新前バックアップ・失敗時ロールバック
- 非対象: Draft、Prerelease、mainブランチ上だけの変更

認証情報は`~/.buzzassist/`内の既存設定を引き継ぎ、各プロジェクトの`canvas/`や生成物を更新処理で削除しません。成功した新版のskillsを確実に読み込むには、次回CodexまたはClaude Codeを再起動してください。

```bash
npm run update:status
npm run update:check
npm run update:now
npm run update:disable
```

定期更新を使わない明示的な導入では`--no-auto-update`を付けます。

```bash
node scripts/setup-agents.mjs --agent codex --project-dir /path/to/active/project --no-auto-update
```
