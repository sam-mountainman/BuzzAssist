<!-- このファイルは harness-learn が自動で書きます。手で編集しないでください。 -->

# 自動で積み上がった指摘

隣の `SKILL.md` が正本で、**矛盾したときは SKILL.md が優先**します。
ここは運用上の補助指示であって、**監査・承認・合否の証跡には使えません**。
根拠は逐語ではなく sha256 先頭12桁の digest だけを載せます（このファイルは配布物に
同梱されるため）。逐語は `node scripts/harness-learn.mjs status` で id から引けます。

- **Claude Codeの並列上限を min(16, CPU-2) と書いたが、それはWorkflowツール専用の式。通常のサブエージェントは既定10でコア数非依存**
  - 根拠digest: `60e170c27255`
  - 種別: correction / 初回: 2026-08-28 / id: `f8b11ac1431b`
- **Codexのネイティブ子スレッドは同時3本で、4本目は agent thread limit reached**
  - 根拠digest: `5e11a7e9e531`
  - 種別: fact / 初回: 2026-08-28 / id: `af895bf4ea2c`
- **Codex CLIのprobeは終了コード0かつ期待応答一致なら、無関係なMCPの401/unauthorized警告をCodex本体の未ログインとして扱わない。認証エラー判定は非0終了時に限定する**
  - 根拠digest: `354f71fc09a4`
  - 種別: correction / 初回: 2026-08-29 / id: `c0f0c7b1ec69`
- **Codex app-server画像ブリッジを漫画プロジェクト直下のcwdで起動すると、画像生成用の短命タスクがプロジェクトAGENTSの漫画制作スキルを再帰的に読み、画像生成itemを出さずinterruptedで終わる場合がある。画像ブリッジはCODEX_IMAGE_BRIDGE_CWDの中立ディレクトリを尊重し、turn/completedが画像payloadなしなら30分待たず即失敗させる。**
  - 根拠digest: `8c5a5e2a00d6`
  - 種別: fact / 初回: 2026-08-31 / id: `ea0506a8f155`
- **Codex app-serverのread_threadがturn status=interruptedを返しても、画像生成が停止したとは限らない。imagegenをfunctions.exec内で開始してcell idを受け取った後、同じセッションJSONLでfunctions.waitが約121秒ごとに継続している場合は生成中である。read_thread表示だけで親プロセスを中断せず、session JSONLのwait継続または親の公式timeout/ledger確定を確認する。**
  - 根拠digest: `0580826cf68c`
  - 種別: correction / 初回: 2026-08-31 / id: `ef918598dc0e`
- **利用者が指定する Opus Ultracode のような製品上のモードを、独立したモデル ID が見つからないことだけで不存在と扱わない。モデル、推論レベル、作業編成モードを区別して実装と実行状態を確認し、単なる xhigh を Ultracode 有効化と同一視しない。静的な機能の存在と、そのアカウントで実際に有効になったことは別々に報告する。**
  - 根拠digest: `559f3271fd5d`
  - 種別: correction / 初回: 2026-09-05 / id: `a5dd5b706825`
- **Claude Code のユーザー向け推論レベルの選択肢として Ultracode を扱う。ユーザーが Opus Ultracode と指定した場合はモデル Opus、推論レベル Ultracode と明記し、内部の xhigh と作業編成機能の組合せという説明を理由に指定可能な推論レベルであることを否定しない。通常の xhigh への置換や、サブエージェントへ同じ値が渡せるとの未検証の断定をしない。**
  - 根拠digest: `815a53bb9ab6`
  - 種別: correction / 初回: 2026-09-05 / id: `545f81ec58ed`
- **claude CLI は --tools Read,Grep,Glob・--disallowedTools Bash,PowerShell,Edit,Write,NotebookEdit・--permission-mode dontAsk・--strict-mcp-config の組み合わせで書き込みの道具を持たず、並列の読み取り専用エンジンとして使える。引数の無い古い CLI は --help で判定して外す**
  - 根拠digest: `582cacec6d6a`
  - 種別: fact / 初回: 2026-09-25 / id: `1e6aa1ff288b`

_最終更新: 2026-09-26T07:30:31.284Z_
