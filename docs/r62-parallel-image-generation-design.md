# R62 設計メモ — 画像生成の最大並列化（共有app-server + 適応型並列）

状態: 設計段階（R60/R61音声サイクル完了後に着手）。方針はユーザー承認済み（共有app-server+適応型並列）。

## 現行の制約（実測箇所）

- `scripts/codex-image-bridge.mjs`（577行）: 画像1枚ごとにCodex app-serverプロセスを起動・終了。429/使用上限はメッセージ変換のみで再試行なし（friendlyCodexError, :125付近）
- `lib/mediaGeneration.mjs:28-31`: `DEFAULT_MEDIA_BATCH_CONCURRENCY = 10` が上限を兼ね、`normalizeMediaBatchConcurrency` が1〜10へ丸め
- `lib/mangaScriptImagePipeline.mjs:41`: `DEFAULT_SCRIPT_IMAGE_CONCURRENCY = 10` 固定。QA・再生成が同一実行枠を占有

## 変更ファイル一覧（予定）

| ファイル | 変更 |
|---|---|
| `scripts/codex-image-bridge.mjs` | 共有app-serverモード追加（長寿命1プロセス+スレッドJIT作成、`--server-mode shared`）。クラッシュ検知→自動再起動→台帳未完了ジョブのみ再接続。429/timeoutを構造化エラー（retryable/backoff/waiting区分）で返す |
| `lib/adaptiveConcurrency.mjs`（新規） | AIMDコントローラ: 初期16→成功N連続で×2（上限256）→429/timeoutで÷2（下限4）→安定で再拡大。使用上限検知で「waiting」状態（失敗扱いにしない・自動再開タイマー）。RSS監視（`process.memoryUsage`+子プロセス集計）で総メモリ目標3〜5GBを超えたら拡大停止/縮小 |
| `lib/mediaGeneration.mjs` | 1〜10丸め撤廃。`--concurrency auto|<n>|unlimited`（autoが既定、unlimitedは検証用と明記）。画像受領は即ディスク書き出し→Base64バッファ解放 |
| `lib/mangaScriptImagePipeline.mjs` | プール分離: 生成(auto)/Visual QA(8〜16固定)/分割合成(cpu-2〜4)/再生成(低優先: 生成プールの空き枠のみ)。ジョブ全件を台帳へ即登録→実行直前にスレッド確保。既存DAG順序（キャラ/環境シート→本編→分割合成）は維持 |
| `scripts/generate-manga-script-images.mjs` | CLIフラグ互換維持（`--concurrency` 数値指定は尊重、未指定=auto） |
| `test/adaptiveConcurrency.test.mjs`（新規） | AIMD決定論テスト（モック時計）: 成功→倍増/429→半減/上限→waiting→自動再開/RSS超過→縮小 |
| `test/mangaScriptImagePipeline.test.mjs` | 再開安全性: 途中kill（モックserver切断）→台帳から未完了のみ再実行を固定。プール分離の非ブロッキング検証 |

## 段階計画

1. **P1**: `lib/adaptiveConcurrency.mjs` + ユニットテスト（純ロジック、外部依存なし）
2. **P2**: bridge共有サーバ化 + 構造化エラー + 再起動/再接続（モックserverでテスト固定）
3. **P3**: mediaGeneration/pipelineの結線（丸め撤廃・プール分離・即時ディスク書き出し）+ 再開安全性テスト
4. **P4**: ベンチマーク（12〜20枚の実生成: 現行10固定 vs auto、完了時間とピークRSS比較）→ 台帳・スキルへ記録
5. **P5**: 373+新規テスト全緑、v40動画成果物に影響なし（動画系監査を再実行して無変化確認）

## リスクと対策

- 共有スレッドの実効上限はChatGPT側の制約に依存 → AIMDが自動探索（固定仮定を置かない）
- app-serverクラッシュ時の生成中ジョブ: 台帳status=running→再接続時にrunningを再キュー（冪等: 出力ファイル存在+ハッシュ検証で二重生成防止）
- unlimitedはOOM危険 → 非推奨明記+RSSガードはunlimitedでも有効
