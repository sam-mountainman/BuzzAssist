# 4セッション統合監査・完遂報告（2026-08-10）

## 対象一次資料

| 系統 | セッション | 一次資料 | 読み取り結果 |
|---|---|---|---|
| Codex | `019fd34d-602f-7a93-b28d-b784787a22e3` | `~/.codex/sessions/2026/08/06/rollout-2026-08-06T03-01-31-019fd34d-602f-7a93-b28d-b784787a22e3.jsonl` | 18,672 events、明示 user message 48件。v7〜v27の要求・実装・検証・差し戻しを全順序で照合 |
| Codex | `019fe044-aa46-7a83-992d-d5c095a20201` | `~/.codex/sessions/2026/08/08/rollout-2026-08-08T15-27-04-019fe044-aa46-7a83-992d-d5c095a20201.jsonl` | 7,393 events、明示 user message 21件。v28〜v35と中断時点を全順序で照合 |
| Claude Code | Codex セッション分析と動画制作 | `~/.claude/projects/-Users-higataiyu-Documents-Excalidraw/024c09db-3b36-43ac-9a16-5f334356e7e6.jsonl` | 2,496行。v36〜v40の引継ぎ・実装・ユーザー差し戻し・レンダーを照合 |
| Claude Code | セッション目的達成管理 | 同プロジェクトの `5a313d2a…jsonl` と `b3600eae…jsonl` にまたがる論理セッション | 要求台帳、独立検品、完了判定、後続委任を照合 |

巨大な画像/base64イベントを本文として数えず、human-origin要求、実ファイル変更、テスト、レンダー成果物、ユーザーの視聴フィードバック、task complete宣言を別々に抽出した。結論は、履歴内に「ユーザー視聴で最終承認された完成版」は存在しない。自動監査PASS後に人間視聴で欠陥が見つかる流れが複数回あり、task completeの文言は完成証拠として扱わなかった。

## 時系列で判明したこと

### Codexセッション1（v7〜v27）

- v7で参考動画計測、TTS/FFmpeg並列、ハッシュ再開を実装したが、画は既存カット再利用だった。
- v8は70/70のカメラ素材を本編へ使い切り、監査はPASSしたが、人間視聴では切替過多。v9で25ショットへ整理し、全尺ブラウザ再生 `ended:true` まで確認した。
- v11のStyle-Bert系処理は、ユーザーが求めたElevenLabs自然音声と合わず撤回対象となった。
- v12は変更を宣言したが、ユーザー視聴では「何も変わってない」。v13以降の全pull-out化は、その後の「方向移動が消えた」退行を生んだ。
- v20は同時2吹き出しを意図的に導入したが、後続の「同時表示禁止」と衝突。v24で順次表示・残留禁止・組版を修正した。
- v25〜v27で音声、一定速カメラ、話者近接配置を進めたが、最後の要求「連続して同じ近い場所に置かない」が次セッションへ残った。

### Codexセッション2（v28〜v35）

- v28の輪郭・心の声形状は、文字はみ出しと品質不足で差し戻し。v29で478表示を解析し、連続同一ポケット0、近接0へ修正した。
- v30〜v32で無地プレート、2/3分割、後合成黒線、whole-page cameraを統合。画像差替え後に古い顔座標を流用したため、顔被りが再発した。
- GPT Image 2 / GPT sheet→Grok / 全Grokの3方式比較は実施済みで、現物は `canvas/assets/model-routing-benchmark/` にある。台帳の「未実施」は誤記だった。
- 1台本→全画像のワンコマンド、最大10並列、QA、失敗再試行、再開台帳を実装した。
- v33でカメラ文法をスキル化した一方、全pull-outへ上書きする退行を発生。v35で方向13、引き4、combined 5を復元した。
- セッション終了時は、カメラ変換後の話者顔0pxハード除外を実装中で、21ショット再注釈とcut-05安全解の確定が未完了だった。task completeも無い。

### Claude Code「Codex セッション分析と動画制作」（v36〜v40）

- v36でS2中断分を引継ぎ、21ショット再注釈、36吹き出し、26 camera、373 testsを完了したが、ユーザーが0:32の心の声スポットずれを発見。
- v37で「スポットをsource imageへ焼込んでからページ全体へcamera」を正方式にした。
- v37視聴では、分割パネルの意味不明な腕/後頭部、viewpointの意味誤用、cut-09スワップ、112秒の不適切3人画像、切替過多、ナレーター声が新たに見つかった。
- v38でsplit可読性、視点規則、画像保持、主人公声を修正。独立管理は合格したが、ユーザーは音声、2:12挿入画像、1:46/1:28吹き出し顔被りを発見した。
- v39でv25 dialogue pipeline、リードイン撤去、独立顔監査を導入したが、主人公ナレーションと既存音声冒頭が再度不合格。
- v40は非ナレーション22行を承認PCMから復元し、ナレーション7行を複数take化した。ログ終端は最終レンダー中で、セッション内の完了報告は無い。

### Claude Code「セッション目的達成管理」

- R1〜R64台帳と独立ゲートを整備したが、v36/v38/v39の管理PASSはいずれも、その後のユーザー視聴で監査盲点が判明した。
- v41はナレーションを普通の台詞と同じ素の入力へ戻し、Chrome 151の縦書き退行を直した。しかし、その後ユーザーが音声の自然さと間を再度問題化したため、v41も承認版ではない。
- 適応型並列はAIMDコントローラだけが先行し、共有app-serverのproduction実結線、クラッシュ復旧、生成/QA別プール、CLIモード、実機計測は未完了だった。

## 統合監査で実測したv41の未完了事項

`manga-photo-homecoming-001-v41-natural-narration-typography-r1.mp4` を設定値ではなくデコード済みPCMと実フレームで再監査した。

- 29/29発話の波形相関とcut内同期は合格、最低相関0.99815。クリック0、ハム0、ピーク -1.245 dBFS。
- speech onsetの相対ゲイン幅は `1.2269218548` で、許容 `1.12` を超過。最小はcut-05-u01、最大はcut-01-u01。原因は最終1-pass loudnormが動的モードになり、同じ基準で整えたWAV間の相対音量を変えたこと。
- cut-05-u01→u02は実間0.235187秒、目標0.16秒（+0.075187秒）。cut-10-u01→u02は実間0.38秒、目標0.32秒（+0.06秒）。
- 連続吹き出しは37件で同一/近接再配置0、active speaker顔重なり0。cut-05は別ショットと再注釈済みで安全解あり。
- cut-01の吹き出し切替監査は時刻だけを見ると空白0フレームと誤判定したが、実フレームは旧カード→完全空白→新カードfade開始。監査側がalpha=0の初期frameを数えていない偽陰性だった。
- t=47.3秒の吹き出しは非話者の蓮の髪へ17.1%かかるが、話者の澪は0px。原要求は非話者上を許可しているため違反ではない。ただし「全顔0」という古い証跡表現は不正確。

## 実装した恒久修正

### 吹き出し・cut-05・映像監査

- `lib/mangaBubbleCameraPlacement.mjs` のactive speaker 0pxハード除外、33点camera sweep、fine grid、直近2配置履歴を現行マニフェストへ再適用。
- `scripts/refresh-manga-v38-bubbles.mjs` で37 overlayを再構築し、face overlap 0、near repeat 0を取得。
- cut-05はu01/u02とu03で適切な別ショット・別顔注釈を使い、安全配置不能を解消。
- `scripts/audit-manga-v24-bubble-transitions.mjs` を、fade-in最初のalpha=0 frameを考慮する実フレーム判定へ修正。
- `lib/mangaVideoPipeline.mjs` はfadeありなら1/fps、zero-fadeなら2/fpsを最低切替間隔にする。

### 音声・間・音量

- 承認済み22対話WAVと7ナレーションWAVは再生成せず、PCMを保持。
- cut-05-u02は無音先頭を0.075187秒だけオーバーラップし、可聴間を0.16秒へ補正。
- cut-10-u02は無音先頭を0.06秒追加し、可聴間を0.32秒へ補正。
- ナレーション7件はprovider実入力、sidecar、manifestを素の台詞入力へ一致させ、古いsemantic intent/tagを除去。
- 最終masterは1-pass動的loudnormから、測定pass→ピーク余裕0.3dBを確保する一定ゲインpassへ変更。`linear=true`でも目標LUFSとtrue-peakを同時達成できない場合はFFmpegが動的処理へ戻るため、測定値から一定ゲインを明示計算して発話ごとの相対音量を維持する。
- STT監査へ `--manifest/--video/--output` を追加し、対象MP4の取り違えを防止。
- v38構造監査は、対話ではperformance prompt必須、ナレーションでは空prompt/タグなし必須へ修正した。

### 共有app-server・適応型並列画像生成

- `scripts/codex-image-bridge.mjs`: 1つの長寿命app-server、ジョブ単位のJIT thread、singleton再利用、クラッシュ時1回再起動、usage-limit parking、rate-limit throttleを実装。
- `lib/mediaGeneration.mjs`: 既定のCodex画像経路をshell子プロセス乱立から、同一Nodeプロセス内の共有bridgeへ実結線。明示的な外部bridge指定だけshellを維持。
- `lib/mangaScriptImagePipeline.mjs`: `auto` AIMD、任意fixed値、検証用`unlimited`、生成/QA別キュー、resume/retryを実結線。
- `scripts/generate-manga-script-images.mjs`: `--concurrency auto|N|unlimited` と `--qa-concurrency` を公開。
- 24並列ジョブでapp-server start 1回、クラッシュ後の未完了job再接続を決定論テストで確認。
- 実機の旧方式12-jobと2-job再現ペアはcold startで180秒を超えたため監督条件どおり停止。残留benchmark/app-server子プロセス0を確認。成功した速度比は捏造せず、timeoutそのものを旧起動コストの実測結果として `r62-shared-app-server-benchmark.json` に保存した。

### 品質ハーネス

- `lib/mangaQualityHarness.mjs` をrender前planning preflightとrender後final preflightへfail-closed接続。従来の「手動CLIを実行したつもり」を完成条件から排除した。

## 最終成果物・検証

v42のレンダー・最終検証結果は同ディレクトリの `v42-integrated-final-evidence.json` を機械可読な一次証拠とする。

- 完成MP4: `<repo>/canvas/assets/videos/manga-photo-homecoming-001-v42-integrated-final-r1.mp4`
- ffprobe: 154.156706秒、1920×1080、30fps、H.264 + AAC 48kHz stereo、34,175,608 bytes、平均1,773,551 bit/s。
- SHA-256: `877c2f91920838e952f8a512d0ca33fa530de40c0bb96d74725a80060589d7e8`。decoded audio PCM MD5: `4c7241228b3d54edd4416a3d32572f3a`。
- 音声: 29/29発話の波形・cut内同期PASS、最低波形相関0.999468、speech-onset gain spread 1.009736（v41は1.226922）、19/19可聴間PASS。cut-05は0.160187秒、cut-10は0.320000秒。STT 29/29、冒頭余白29/29、ナレーション韻律7/7、ハム候補0、孤立クリック0、ピーク-1.774dBFS。
- 映像: 37吹き出しでsame pocket 0、near repeat 0、話者顔重なり0、組版37/37。独立顔検出37/37、吹き出し中間フレーム37枚、camera sweep 63枚、全36切替の旧→空白→新を108枚で確認。スポットライト5/5、split panel 5/5、camera 13/13ゲートPASS（static 4 / directional 10 / pullout 5 / combined 2 / push-in 0）。
- 目視: タイムライン、全吹き出し、全切替、cut-05、cameraの各コンタクトシートを確認。参考2本のコンタクトシートとも比較し、背景の色・小物密度を再検証した。波形・スペクトログラムと冒頭/cut-05/cut-10のデコード済み試聴用クリップを証拠として保存した。
- 実行検証: finalizerが完成MP4を全編`ffmpeg -xerror`デコードし、stream/サイズ/hashを再計測。`node --test test/*.test.mjs`は383/383 PASS。render内planning/final quality harnessもfail-closedでPASS。
- 共有app-server: production入口の実結線、24ジョブで1 app-server、クラッシュ復旧、usage-limit waiting/checkpoint/同地点再開をテスト。実機旧方式は2-jobでも180秒timeoutとなり、残留子プロセス0を確認して証拠保存した。
- 機械可読な最終証拠: `<repo>/canvas/manga-videos/manga-photo-homecoming-001/v42-integrated-final-evidence.json`。
- 完成動画の既知問題: 無し。Codexランタイムが音声サンプルをモデルへ返さない制約は、最終音声のデコード、STT、韻律、波形相関、onset、間、音量、クリック/ハム監査と、保持した試聴用実ファイルで補完した。

## セキュリティと保全

- 過去セッション本文にElevenLabs等の秘密情報が貼られている。値は本報告へ転記していない。既に失効していても、漏洩済みとしてrotationすることを推奨する。
- worktreeにはセッション由来の大量のmodified/untracked成果がある。今回、ユーザー変更のreset・checkout・削除は行っていない。commit/branch化は依頼範囲外のため勝手に実施していない。

## 判定原則

自動ゲートPASSだけを「完成」と呼ばない。最終判定には、別データ源の顔監査、複数時刻の実フレーム、タイムライン/吹き出しコンタクトシート、最終MP4由来のPCM相関・可聴間・音量・STT、全尺デコードを同時に要求する。
