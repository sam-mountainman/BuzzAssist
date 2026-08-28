<!-- このファイルは harness-learn が自動で書きます。手で編集しないでください。 -->

# 自動で積み上がった指摘

隣の `SKILL.md` が正本で、**矛盾したときは SKILL.md が優先**します。
ここは運用上の補助指示であって、**監査・承認・合否の証跡には使えません**。

- **Claude Codeの並列上限を min(16, CPU-2) と書いたが、それはWorkflowツール専用の式。通常のサブエージェントは既定10でコア数非依存**
  - 根拠: 実行ファイル2.1.237に CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY??10 を確認
  - 種別: correction / 初回: 2026-08-28 / id: `f8b11ac1431b`
- **Codexのネイティブ子スレッドは同時3本で、4本目は agent thread limit reached**
  - 根拠: Codexレビューでの実測（0.150.0-alpha.8）
  - 種別: fact / 初回: 2026-08-28 / id: `af895bf4ea2c`

_最終更新: 2026-08-28T20:51:29.073Z_
