<!-- このファイルは harness-learn が自動で書きます。手で編集しないでください。 -->

# 自動で積み上がった指摘

隣の `SKILL.md` が正本で、**矛盾したときは SKILL.md が優先**します。
ここは運用上の補助指示であって、**監査・承認・合否の証跡には使えません**。

- **Codex app-server画像ブリッジを漫画プロジェクト直下のcwdで起動すると、画像生成用の短命タスクがプロジェクトAGENTSの漫画制作スキルを再帰的に読み、画像生成itemを出さずinterruptedで終わる場合がある。画像ブリッジはCODEX_IMAGE_BRIDGE_CWDの中立ディレクトリを尊重し、turn/completedが画像payloadなしなら30分待たず即失敗させる。**
  - 根拠: 2026-08-31 manga-approved-eight-canary-001: scene image thread 01a057c3-b963-7340-9a58-b3e5b3417fd9 had only skill-reading command then status=interrupted; image-generation-ledger remained running. Fixed lib/mediaGeneration.mjs and scripts/codex-image-bridge.mjs; 4 focused tests passed.
  - 種別: fact / 初回: 2026-08-31 / id: `ea0506a8f155`
- **Codex app-serverのread_threadがturn status=interruptedを返しても、画像生成が停止したとは限らない。imagegenをfunctions.exec内で開始してcell idを受け取った後、同じセッションJSONLでfunctions.waitが約121秒ごとに継続している場合は生成中である。read_thread表示だけで親プロセスを中断せず、session JSONLのwait継続または親の公式timeout/ledger確定を確認する。**
  - 根拠: 2026-08-31 thread 01a057eb-f048-7dc3-996f-8705c8c879b4: read_thread showed interrupted, but rollout JSONL ordinals 30-58 recorded repeated functions.wait for cell 2 through 13:17:40Z. Earlier concurrency runs were stopped too early based on the misleading status.
  - 種別: correction / 初回: 2026-08-31 / id: `ef918598dc0e`
- **Claude Codeの並列上限を min(16, CPU-2) と書いたが、それはWorkflowツール専用の式。通常のサブエージェントは既定10でコア数非依存**
  - 根拠: 実行ファイル2.1.237に CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY??10 を確認
  - 種別: correction / 初回: 2026-08-28 / id: `f8b11ac1431b`
- **Codexのネイティブ子スレッドは同時3本で、4本目は agent thread limit reached**
  - 根拠: Codexレビューでの実測（0.150.0-alpha.8）
  - 種別: fact / 初回: 2026-08-28 / id: `af895bf4ea2c`
- **Codex CLIのprobeは終了コード0かつ期待応答一致なら、無関係なMCPの401/unauthorized警告をCodex本体の未ログインとして扱わない。認証エラー判定は非0終了時に限定する**
  - 根拠: scripts/harness-parallel-agents.mjs:166-168。2026-08-30実測: codex execはstatus 0でPROBE-OKを返したが、別MCPのAuthRequired/401警告を含むためselectEngineが未ログインと誤判定した
  - 種別: correction / 初回: 2026-08-29 / id: `c0f0c7b1ec69`

_最終更新: 2026-08-31T17:01:41.872Z_
