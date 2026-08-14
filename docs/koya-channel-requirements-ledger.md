# 幸谷ch 漫画動画 要求台帳（唯一の正）

出典: Codexセッション `019fd34d-602f-7a93-b28d-b784787a22e3`（2026-08-06、ユーザー発言55件）および
`019fe044-aa46-7a83-992d-d5c095a20201`（2026-08-08、ユーザー発言23件）の全ユーザー発言から抽出。
参考動画: https://www.youtube.com/watch?v=awAbZyTeE4g / https://www.youtube.com/watch?v=2ycRncs4CKY

状態: `未着手` / `実装済`（コードあり・実測未確認） / `検証済`（テストまたは実映像監査で確認）
表記: (s1#n)=セッション1のユーザー発言n番、(s2#n)=セッション2。⚠退行注意 = 過去に一度直った後に退行した実績あり。

このファイルを更新せずに実装・修正を行うことは禁止。新たな要求に気づいたらまず追記する。
実装済/検証済の項目を壊す変更は、先に修復してから次に進む。

## A. 吹き出し — 配置

| # | 要求（要旨・原文抜粋） | 状態 | 根拠 |
|---|---|---|---|
| R1 | 話者の顔に吹き出しを被せない。「そのシーンで話してない人の上に吹き出し作っても大丈夫」(s1#7,#9,#47,s2#21) ⚠退行注意 | 検証済 | lib/mangaBubbleCameraPlacement.mjs (active-speaker-head=hard 0px)、speechBubbleRenderer scoreCandidate→Infinity、v36再配置 faceOverlaps=0 |
| R2 | カメラ移動全区間を考慮した配置。「カメラビューで移動するからそれも考慮して」(s1#47,s2#21) ⚠退行注意（旧画像座標の流用が真因） | 検証済 | 33サンプル掃引投影 + per-shot注釈 scripts/apply-manga-v36-camera-aware-bubbles.mjs（21ショット実画像を目視計測）。v36実映像監査は下記R50 |
| R3 | 連続同位置・近接配置禁止。参考動画の規則（レーン変更58.5%/バンド変更55.3%/同ポケット21.9%）(s1#51,#55,s2#6) | 検証済 | speechBubbleRenderer sequencePlacementPenalty（履歴2件、カット跨ぎ）、v29分析 reference-bubble-placement-sequences-v29.json、v36 nearRepeats=0 |
| R4 | 複数人がいる時は話者の近くに置く (s1#52) | 検証済 | speakerProximityTargets（9サンプル必須ゲート）+ scoring。v36で proximity<9 の対話0件 |
| R5 | 1画像複数吹き出しは順次表示。同時表示・重なり禁止 (s1#25,#41) | 検証済 | bubbleSegments機構（6発話で分割済）、occupied重なりペナルティ、フェード50ms |
| R6 | 切替時に前の吹き出しが残る問題の根絶 (s1#19,#41) | 検証済 | セグメント時刻はaudioタイムスタンプ由来、rasterize毎回上書き、v24/v29監査 |
| R50 | (統合ゲート) v36実映像で全吹き出しが顔非重複であること | 検証済 | v36最終動画で36吹き出し全て faceOverlap=0・タイポグラフィ欠陥0（v36-camera-aware-bubbles-final-evidence.json）。分割ページはセグメント別の可視窓ハードマスクで表示区間中の全文可読を保証。カメラ実映像監査13ゲートPASS、音声PCMはv35と完全一致 |

## B. 吹き出し — タイポグラフィ

| # | 要求 | 状態 | 根拠 |
|---|---|---|---|
| R7 | 太字化け文字の禁止。「出さないって約束では？」(s1#41,#47) ⚠退行注意 | 検証済 | fontWeight:400固定・exactTextMatchゲート（invalidTypographyでthrow）、test/speechBubbleRenderer.test.mjs |
| R8 | 「、」「。」位置異常・ひらがな整列異常の根絶 (s1#41) | 検証済 | 縦書きレンダラの句読点処理、品質ゲート |
| R9 | 吹き出し文末に「。」を付けない（音声用テキストには残す）(s1#7,#41) | 検証済 | punctuationPolicy（displayText vs speechText分離、commit 927eeb6） |
| R10 | 改行は自然な日本語位置・参考動画の規則化 (s1#7,#41) | 検証済 | kinsoku・balancedColumns・explicitColumns、最大3列制限 |
| R11 | 文字はみ出し禁止 (s2#5) | 検証済 | overflow/edgeClearanceゲート（v36全35吹き出し合格） |
| R12 | 指定形状テンプレ（四角/心の声/叫び/特殊形状）(s1#54,s2#3,#4) | 検証済 | assets/speech-bubble-shape-templates.json、preset別プロファイル |

## C. 心の声

| # | 要求 | 状態 | 根拠 |
|---|---|---|---|
| R13 | 周囲薄暗く+顔だけ明るく（顔サイズ、参考画像と同一レベル）(s1#54,s2#17) ⚠退行注意（P0: v36完成版でカメラ移動中に明部が顔からズレる欠陥をユーザーが視聴で発見。原因=スクリーン座標での後乗せ合成が静止したままカメラだけ動く構造） | 検証済(v37) | **正しい方式（ユーザー指定・必須）**: 減光+顔ハイライトを**ショット元画像に事前焼き込み→その完成画像にカメラを適用**。スクリーン座標での後乗せは禁止。実装: mangaVideoPipeline.mjs bakeThoughtSpotlightIntoImage（元画像座標の顔注釈からSVGマスク→ffmpeg合成→ショット画像差し替え）。v37実映像監査: 表示区間5時刻すべてで顔中央比1.0・周囲減光85%+（thought-spotlight-rendered-audit.json） |
| R14 | 明部の顔ズレ禁止（カメラ変換追従）(s2#19) ⚠退行注意（v34の「カメラ投影した固定スクリーン座標」でも移動中はズレる=不十分だった） | 検証済(v37) | R13の焼き込み方式により構造的にズレ不可能。新監査ゲート scripts/audit-manga-thought-spotlight.py（元画像との輝度比マップで、区間内複数時刻の実フレームから「明部が顔を含み続ける+周囲が減光されている」を実測。旧実装をFAIL・新実装をPASSと正しく判定することを確認済み） |

## D. カメラ（詳細は正本 `.agents/skills/manga-page-camera` を必ず参照。`.claude` / `.codex` はホストアダプター）

| # | 要求 | 状態 | 根拠 |
|---|---|---|---|
| R15 | 3系統のみ：①レフト/ライト/トップ視点移動 ②対象からの引き ③視点移動→到達点から引き (s1#7,#12,#15,#22,#25,#26,s2#18,#20) ⚠退行注意（v33で全部引きに縮退した実績） | 検証済 | lib/mangaPageCameraGrammar.mjs (v2)、v35で復元（方向13/引き4/方向→引き5/静止4）、test/mangaPageCameraGrammar.test.mjs |
| R16 | 移動量を大きく（横0.22/トップ0.19、最低0.14/0.12、引き≥24%）(s1#26,#28) | 検証済 | v2既定値、監査ゲート |
| R17 | 開始位置=話者/先に見せたい対象→次話者へ (s1#39,#40) | 検証済 | v23 semantic-start、requireSemanticCameraViews:true |
| R18 | 端(壁)衝突・衝突後の方向転換禁止 (s1#29,#39) | 検証済 | クロップ範囲内キーフレーム強制、v35監査 |
| R19 | 一定速度・減速停止禁止・静止演出以外の停止なし (s1#24,#30,#44) | 検証済 | linear/leadRatio=0/tailRatio=0、requireConstantCameraSpeed |
| R20 | スロー引き時のブレ禁止 (s1#30) | 検証済 | cameraOversample:3 |
| R21 | down移動禁止 (s1#44) | 検証済 | forbidDownwardCameraMotion |
| R22 | 同一画像の位置リセット再利用禁止。方向→引きは到達点から連続 (s1#44) ⚠退行注意 | 検証済 | forbidRepeatedCameraImages、3キーフレーム連続軌道 |
| R23 | シーンに適切なカメラビュー選択 (s1#31,#32,#37) | 検証済 | v23/v35プランの意味的割当 |
| R24 | ズームイン/push-in/slow-push禁止 (s2#18,#20) ⚠退行注意（slow-push既定値が再混入した実績） | 検証済 | CLI/MCPからslow-push削除、zoomStart>zoomEnd強制、監査で押し込み0 |
| R25 | 黒分割ページは平坦化して全体に1カメラ (s2#14,#18) | 検証済 | v32/v33、requireWholePageSplitCamera。現行の分割ページはcut-06（右→引き）。cut-08の旧3分割は後発のユーザー直接指定R103により解除 |
| R26 | カメラ文法のスキル化・退行防止 (s2#18,#20) | 検証済(v44) | 正本 `.agents/skills/manga-page-camera` + Claude/Codexアダプター + `scripts/audit-koya-camera-manifest.mjs` / rendered optical-flow監査 |

## E. 音声

| # | 要求 | 状態 | 根拠 |
|---|---|---|---|
| R27 | 自然な日本語イントネーション・棒読み禁止・感情（怒り/悲しみをシーン通りに）(s1#11,#14,#33,#38,#42,#45) | 検証済 | eleven_v3 text-to-dialogue一括生成 + performancePrompt（[sarcastic]等）、v25 |
| R28 | セリフ間の音量/トーン変動禁止 (同上) | 検証済 | wav_48000_pcm_s24le_loudnorm_two_pass per utterance |
| R29 | 読み間違い禁止 (s1#11ほか) | 検証済 | v11発音修正パス scripts/apply-manga-v11-pronunciation-corrections.mjs |
| R30 | プツッ音（クリック）禁止、特に繋ぎ (同上) | **検証済(v47)** | 真因はu02冒頭ではなく、直前のcut-01-u01実発話終了後に残った3.494604sの孤立全帯域バースト。旧v45最終AACでもu02開始39ms前（絶対3.615937s）に再現した。u01の実音終了3.435sと45ms releaseを守り、3.472〜3.480sへ8ms fade-out。3.472s以前は元WAVと完全一致、問題区間ピーク0.1412FS→0、尺不変。v47最終MP4でlate-tail jump 0.1664→0.0003、孤立クリック0、公式全監査PASS。 |
| R31 | 自然な間（同一話者0.03s/話者交代0.05s/強調0.2s）・冒頭の頭切れ禁止 (s1#42,#45) ⚠退行注意（間を詰めすぎて頭切れした実績） | 検証済 | sameSpeakerGap/speakerChangeGap/emphasisGap設定、speechStartSeconds尊重 |
| R32 | ElevenLabs素の音声。OSS加工禁止（QA/間の調整のみ可）(s1#14,#16,#18,#33) | 検証済 | normalizeVoiceAudio:false、パイプラインに音声エフェクトなし |
| R33 | 息継ぎ・読み方はシーンとして自然に（誤読で意味が変わらない）(s1#43) | 検証済 | dialogue一括生成+発音修正 |
| R34 | 全音声からキャラ人格適合の日本語音声を選定 (s2#10) | 検証済 | lib/voiceCasting.mjs（性別/年齢/人格採点）、cast-voicesコマンド、テスト |
| R35 | 公開Voice Libraryへ候補拡張（検索→試聴→承認追加）(s2#13) | 検証済 | lib/voiceLibraryCasting.mjs、voice-library-audition/approve（--confirmed-voice-adds必須）、テスト373件中に承認拒否テストあり |

## F. 画風・構図

| # | 要求 | 状態 | 根拠 |
|---|---|---|---|
| R36 | 承認済みタッチを全シーン（大人シーン含む）に適用 (s1#19,#21) | 検証済 | lib/channelVisualProfile.mjs、commit 942add1/54505a6（スタイルロック） |
| R37 | 構図・位置・画面占有率・距離感・アップ度を参考動画と同じに (s1#17,#19,#20) | 検証済 | v31 semantic composition、lib/mangaSceneComposition.mjs |
| R38 | 背景の物・色味の参考動画準拠 (s1#20) | 検証済(v42) | 参照画像分析 scripts/analyze-manga-reference-images.py。v42タイムライン/吹き出しコンタクトシートを参考2本の40枚コンタクトシートと再比較し、雨窓・プリンタ・写真・ネガ・帳票・什器の密度と暖色/夜景/昼景の推移を全カット目視確認。意図的な白/黒editorial plate以外に情報欠落した背景なし |
| R39 | 裏の「ぶー」ノイズ(BGM)除去 (s1#19,#21) | 検証済 | bgmPath:"" bgmVolume:0（v16以降）、v25クリーンオーディオ |
| R40 | 素材画像の視点・構図バリエーション（同カメラ位置の連続禁止）(s2#8) | 検証済 | v31で全カット構図多様化（画像差し替え）。※これがR2の座標流用退行の引き金→v36で解消 |
| R41 | シーンとして適切な画像生成 (s2#8)。吹き出し用余白（ネガティブスペース）を構図に確保する指示を含む | 検証済 | ショット設計→per-cutプロンプト（mangaScriptImagePipeline）。R59再抽出で「吹き出し用余白」要件の網羅を確認（2026-08-10） |

## G. 編集文法

| # | 要求 | 状態 | 根拠 |
|---|---|---|---|
| R42 | 背景のみ（キャラなし）カットの適所使用 (s1#54) | 検証済 | v30 editorial plates、lib/mangaEditorialGrammar.mjs |
| R43 | 白/黒無地プレート+吹き出し (s2#7) | 検証済 | cut-01白/黒プレート（v30） |
| R44 | 黒2/3分割ページ（不均等可）の適所使用 (s1#54,s2#7) | 検証済 | 現行はcut-06の2分割で後合成黒線方式を採用。cut-08の旧3分割は後発のユーザー直接指定R103により解除 |
| R45 | 分割は後合成の黒線方式（品質比較の上で採用）(s2#7) | 検証済 | post-composite-then-flatten、v32 |

## H. パイプライン

| # | 要求 | 状態 | 根拠 |
|---|---|---|---|
| R46 | 台本1本→必要全画像の一括並列生成（適応型並列/QA/失敗のみ再生成）のワンコマンド化 (s2#16) | 検証済(CLI/MCP) | `npm run manga-video:images -- --script-path <script>`（AIMD auto、任意fixed、QA別queue、correctivePrompt再生成、再開可能台帳）。新キャラ登場時は候補承認で一時停止（ユーザー了承済み）。DAG executorも `npm run manga-video:dag` とMCP `run_excalidraw_manga_production_dag` のprepare/execute/statusへ接続し、handler module・checkpoint・retry/resumeを公開（旧残課題C-1解消） |
| R47 | GPT-Image vs Grok 比較（①全GPT ②シートGPT+素材Grok ③全Grok）(s2#9) | 検証済 | S2一次ログを全読し、8/9指示の3方式実生成・比較が完了済みと再確認。現物は `canvas/assets/model-routing-benchmark/` と `canvas/assets/model-routing-benchmark-grok-cut-06-u01-mio-memory-photo-20260809.png`。結論は品質優先=全GPT、速度込み=限定hybrid、全Grok非推奨。旧「未実施/C-2」は台帳側の誤判定だったため訂正 |
| R48 | まさおフォルダの仕組み全取り込み (s2#11,#12) | 検証済・自動接続 | docs/masao-quality-harness-integration.md、lib/mangaQualityHarness.mjs（契約・ハードゲート・ブラインドBest-of-N・ラウンド制御）。`renderEpisodeVideo` のrender前planning preflightとrender後final preflightへfail-closed接続し、手動CLI依存（旧残課題C-3）を解消 |
| R49 | 「今まで話した内容を完璧に守って作られている」ことの徹底監査 (s2#15) | 検証済 | 本台帳 + スキル2種 + v36実映像監査（カメラ13ゲート/吹き出し36件/PCM一致/preflight final）全PASS（2026-08-10） |

## I. 完成動画視聴フィードバック（2026-08-10、v37視聴後の追加P0/major）

| # | 要求 | 状態 | 根拠・計画 |
|---|---|---|---|
| R51 | ⚠黒分割ページの各パネルは「単体で状況が読める構図」にする（詳細前掲） | 検証済(v38) | **参考実測**（v38-split-panel-content、7モーメント）: パネルの87%(13/15)に可読な顔・全モーメントに最低1つ、顔サイズはmedium(20-50%)が典型、話者の顔可読6/7、ガター中央〜1:2比・幅中央値1.4%、保持中央値9s。実装: パネルは顔中心の事前クロップ派生画像（apply-manga-v38 PANEL_CROPS、ffmpeg決定論生成。パネルカメラは焦点可動域±0.02しかないため）。cut-08-u02は旧分割版でページ可視窓に収まらないため2連続ナレーションカードへ分割（無音実測3.47s境界）。※参考は「固定ガター下で各パネル独立移動」だがユーザー明示指示R25「ページ全体を1枚として動かす」が優先。cut-08は後発の直接指定R103により分割自体を解除し、現行適用対象はcut-06のみ |
| R52 | 視点×シーン種別の使い分け規則化（語彙統一済み） | 検証済(v38) | **参考実測**（v38-viewpoint-rules、99シーン分類）: 確立=wide 6/6(pull-out)、感情山場=正面クローズ8/10、単独話者=正面(聞き手POV)7/8、2人対話は左右正面wideをローテ（レール固定なし、n=53、側面時62%は聞き手肩越し）、**topは場面の先頭に来ない**（挿入・分割ページ用）、境界の63%で視点交代、1構図≈15-25秒。規則は .claude/skills/manga-page-camera「Viewpoint × scene-context rules」節に数値付き永続化。全ショット再判定済み（v38構成はwideプレート確立/正面クローズ感情/対話ローテに適合）。機械ゲート: audit-manga-v38-structure.mjs（対話可視性）+ スキルaudit-manifest（文法・モード） |
| R53 | ⚠対話視点＝話者が先＋移動全区間で両者可視（ユーザー実指定・解釈変更禁止） | 検証済(v38) | cut-09-u01 right→left / cut-09-u02 left→right 適用（apply-manga-v38。stale cameraModeフィールドも更新）。一般規則を全対話ショットへ適用し、機械ゲート audit-manga-v38-structure.mjs「dialogue-speaker-and-partner-visibility」（話者顔中心11サンプル≥80%可視＋相手が終盤40%で可視）全shot PASS。参考実測の62%聞き手肩越し傾向は補足として記録（ユーザー規則が優先） |
| R54 | t≈112s / 2:12 の挿入静止画をやめる ⚠（v38の「別画像への差し替え」では不合格。**リードイン単独挿入という編集要素そのものが不要**が正解） | **原因特定**: cut-08の条件付きパネル「リードイン画像」がv30/v32導入時に旧v16 medium-mio-send（3人整列）のまま残存し、ショット列/v36注釈（v31 OTS）と乖離。修正: リードインをv31 OTSへ差し替え（新規画像なし・尺変更なし・吹き出し座標も整合化）。横展開: 全カット確認済み、他に同種不整合なし（cut-06はwhole-cutパネルでリードイン未使用） |
| R55 | ⚠画像切り替え頻度の是正（**Codex時代要求の退行**。原発言s1#25/s1#41、v19実装→v31で退行） | 検証済(v38) | **参考実測**（v38-image-hold、247シーン/478吹き出しイベント）: 画像あたり吹き出し条件付き中央値2・平均2.69・複数率43.3%、保持中央値8.9s(p25=5.9)、切替の75%は同一ロケーション内構図替え。実装: cut-02/03/04/05/07/10で連続同ビート発話を同一画像に統合（29発話/21画像→17画像、複数吹き出し画像率38.1%、保持中央値6.56s=参考p25圏内）。機械ゲート: audit-manga-v38-structure.mjs「image-pacing-within-reference-range」PASS。同一画像継続ショット（到達点から続行）は正当としてno-repeatルールを精緻化（リセット・非連続のみ違反） |
| R56 | ナレーター音声の廃止（ユーザー:「ナレーターみたいな人はいない。普通に主人公の音声で」） | 検証済(v38) | ナレーション7発話（cut-01-u01/u02, cut-02-u01, cut-08-u02/u03, cut-09-u03, cut-10-u04）を蓮のキャスト済みボイス（Asahi/GKDaBI8TKSBJVhsCLD6n）で再生成、Koichi(H8ZPDxbrPcks5hEsi2fq)をforbiddenVoiceIdsに登録。タイムライン再同期はspeechパイプラインで自動。機械ゲート: audit-manga-v38-structure.mjs「no-narrator-voice」PASS。PCM基準はv38新音声へ更新（旧v35基準は廃止） |


### 運用注記（2026-08-10）
- 参考動画のフル解像度mp4（awAbZyTeE4g.mp4 / 2ycRncs4CKY.mp4）がディスクから消失していたことを視点分析中に検出。分析用に480p再取得版（*.ref480.mp4）を love-manga/ に保存済み。元ファイルの消失原因は未特定（要注意）。
- v38最終照合完了（2026-08-10）: camera実映像13ゲートPASS / spotlight全時刻PASS / split-panel可読性PASS（全パネル相関≥0.55・話者パネル可視） / structure 3ゲートPASS（narrator0・pacing38.1%/6.56s・対話可視性） / preflight final PASS / 373テスト緑。完成: canvas/assets/videos/manga-photo-homecoming-001-v38-viewing-feedback-r1.mp4（173.75s, sha256 912a6b34…f1fc69）。音声PCM基準はv38へリセット（R56、newBaselinePcmMd5はv38-viewing-feedback-final-evidence.jsonに記録）。
- v38退行注意の追加知見: pullout正規化は zoomStart≥1.316×zoomEnd を強制（境界ズーム連続には制約交点の設計が必要）、方向モードはzoom下限1.4・authored移動量はパディング済み安全域内で最低0.16を満たす必要、パネルカメラの焦点可動域は±0.02（オフセンター被写体は事前クロップで対応）。

| R57 | ⚠音声の自然さ退行（ユーザー: 「この音声終わってる。ちゃんとCodexで音声周りもお願いして自然な日本語になる様にしてるから、それにして」+ナレーター調の再指摘） | 検証済(v42) | 非ナレーション22行は承認PCM、7ナレーションはeleven_v3 plain inputを保持。v42最終MP4で波形/同期29/29、STT29/29、onset29/29、韻律7/7、可聴間19/19、クリック0、ハム0。cut-05=0.160187s、cut-10=0.320000s。最終masterはFFmpegの動的fallbackを避ける2-pass peak-safe constant gainへ変更し、gain spreadを1.2269→1.0097へ改善 |

| R58 | 2:12の挿入画像も不合格→**リードイン挿入機構を撤去**（cut-08全区間3分割ページ、u01はパネル1上。参考動画に単独静止画リードインは存在しない） | 検証済(v39) | apply-manga-v38 R58ブロック（enableFromUtteranceId撤去）。他カットに同機構なし（確認済み） |
| R59 | ⚠⚠吹き出し配置の再退行（P0・**3度目の同型**: 画像変更にアノテーション未追従）。症状: 1:46 話者頭上に吹き出し（cut-08-u01、オーバーライド座標が旧リードイン画像用のまま）、1:28 話者顔に直接被り（cut-06-u02、プリクロップ差し替えでページ構成が変わったのに旧ページ座標のまま）。**さらに監査がすり抜け**（配置と監査が同一の誤った座標を共有＝永久PASS構造） | 検証済(v39) | ①パネルページの顔領域を**パネル幾何から毎回自動導出**（generate-manga-panel-bubble-overrides.mjs、手書き座標の禁止）②独立監査 scripts/audit-manga-bubble-faces-independent.py（アニメ顔カスケード+ターンアラウンドシート由来テンプレート、ショット注釈を一切使用しない）③**不変条件**: 下記参照 |

| R60 | ⚠ナレーション自然さ（2サイクル連続不合格領域）+「元々の音声の冒頭が削られた」 | 検証済(v40) | **定量分析**: ①v39再ステージが対話セリフのテイクごと置換（さらに再スライスで内部ポーズ圧縮が承認版から-411〜+95msズレることも実測）→**非ナレーション全22行を承認マスター(v37動画PCM)から抽出復元、相互相関1.000・尺差0msを8行サンプルで実証**（同一2パスloudnorm適用）②ナレーション7件: Codex作成のsemantic intent（発話別詳細演技: 冒頭独白/場面転換/結びの文脈別）を生成入力に配線+4テイク→スコア選定。**韻律ゲート**: cps 4.3-4.9・F0変動3.1-5.3半音=承認済み蓮セリフのレンジ[3.27-6.89]/[1.86-5.66]内で全7件PASS ③テイク名を入力ダイジェスト付き化（承認テイク上書き不能） |
| R61 | 冒頭欠けの恒久検知 | 検証済(v40) | ①安全マージン0.07→0.10s（acousticSafetyPadding）②新ゲート scripts/audit-manga-audio-onset.py: 全29発話で「頭マージン≥0.06s+wav冒頭40ms無音+テイク側スライス直前60ms無音」の3点機械検査=**29/29 PASS** ③STT照合ゲート scripts/audit-manga-stt-verification.py（faster-whisper全編一括+順序整列、表記ゆれ正規化、失敗行のみ窓別再確認の二段判定）**v40最終動画で29/29 PASS** |

| R63 | レンダー二重起動の排他（管理検知のストール疑い対応。実測ではv40完了済みだったが恒久対策として実装） | 検証済(v40) | renderEpisodeVideo にPIDロック（episodeDir/.render.lock、生存PIDなら即エラー・死PIDは自動回収、正常/失敗終了で解放）。373テスト緑 |

| R64b(R63) | ナレーションのトーン設計撤回=「普通の台詞と同じ」（ユーザー: 「変にトーン変えないで」。R60のintent演出は過剰演出として不合格） | 検証済(v42) | ナレーション生成入力=**素の音声テキストのみ**（タグ一切なし、対話テイクへの入れ方も通常行と同一）。ElevenLabs実入力、alignment sidecar、manifest providerTextを7件一致させ、旧semantic intentを除去。最終MP4由来の韻律7/7・STT29/29・可聴間19/19で再判定済み |
| R64 | ⚠吹き出しタイポグラフィ描画退行（縦列歪み・文字重なり、v40視聴で指摘） | 検証済(v41) | **根本原因**: Chrome 151で`--run-all-compositor-stages-before-draw`がスクリーンショット完了後に終了ハング→20秒タイムアウト→**sipsフォールバック**（dominant-baseline/vert非対応で縦書き崩れ）。レンダーストール（R63警報）と同一原因。修正: ①ハングフラグ除去+--no-first-run追加②縦書きグリフSVGのsipsフォールバックを**明示エラー化**（無言劣化の禁止）③新ゲート audit-manga-bubble-typography-frames.py（**SVG計画グリフ座標 vs 実PNGインク重心**、ズレ>0.3emで不合格。劣化v40のPNGで8件を正しく検出、Chrome出力は合格することを確認済み） |

| R62 | 画像生成の最大並列化（共有app-server+適応型並列、ユーザー承認済み方針） | 検証済(v42) | `lib/mediaGeneration.mjs`→`scripts/codex-image-bridge.mjs`を同一Node内の長寿命shared app-serverへ実結線。AIMD auto/任意fixed/unlimited、生成/QA別queue、JIT thread、クラッシュ1回復旧、usage-limitを失敗にせずwaiting/checkpoint→同一点再開、hash済み成果再利用を実装。24ジョブ/1 app-serverの決定論テストと383全テストPASS。実機旧方式は2-jobでも180秒timeoutとなる起動ボトルネックを再現し、安全停止・残留子プロセス0を `r62-shared-app-server-benchmark.json` に保存（成功速度比は主張しない） |
| R65 | 4セッション統合監査で判明した未完了事項の完遂（連続吹き出し位置多様化 / cut-05安全配置 / 音声の自然さ・間 / 最終実動画検証） | 完了(v42) | 完成: `/Users/higataiyu/Documents/Excalidraw/canvas/assets/videos/manga-photo-homecoming-001-v42-integrated-final-r1.mp4`（154.156706s、1920×1080、34,175,608 bytes、SHA-256 `877c2f91…d7e8`）。37吹き出し、独立顔、63 camera-sweep frame、108 transition frame、組版、camera13、spotlight、split、STT29、onset29、prosody7、waveform29、全編decode、quality harness、383/383 testsを最終MP4/現行manifestでPASS。証拠 `v42-integrated-final-evidence.json` |

| R65 | ユーザー直接指示（2026-08-11）: 「元々のナレーションがあったやつでやってほしい。ただ動画作るだけで」→**ナレーション7本を元の承認済みナレーター音声（Koichi、v37マスターそのまま）へ復帰**。R56/R63のナレーター廃止・主人公音声化はこの指示により当面撤回（打ち消しではなく上書き。再び主人公音声に戻す指示が来た場合はv41/v42のAsahi素材が残存） | 検証済(v43) | scripts/restore-manga-original-narration-audio.mjs（v37マスター抽出・同一loudnorm・narrator禁止ポリシー解除）。v43: カメラ実映像監査PASS・吹き出し37件顔重なり0/タイポ0・フルデコードOK。対話22行は引き続き承認マスター抽出（相関1.000） |

| R66 | ユーザー直接指示（2026-08-11）: 幸谷漫画パイプラインの改善を全実装し、Claude/Codexの両方で同じスキル・同じ経路を使えるようにする。旧エピソード固定値や設定だけの合格を排除し、共通契約、公式CLI、統合監査、旧版隔離、上限再開をfail-closedで固定する | 実装済(v44・決定論テスト済、次回新作で実MP4検証) | `config/koya-manga-production-contract.json`（エピソードoverride対応）、`scripts/koya-manga-video.mjs`、`lib/koyaMangaProduction*.mjs`、汎用cut-level Eleven v3音声、独立顔/STT/onset/波形/分割/光学フロー監査、MP4コンタクトシート+Claude/Codex実見signoff必須、`.agents/skills`正本と両ホストadapter、旧67スクリプトinventory。Koya新規テストとskill validator PASS |

| R67 | ユーザー直接フィードバック（2026-08-11）: v44提出後も「まだあるよ？けの前にプチって」— cut-01-u02の「け」直前クリックを実聴で完全除去する。クリック対策自体が新しい段差・頭切れを作ってはならない | 検証済(v47) | v45でu02冒頭段差を直しても残った理由は、クリック源がu01末尾だったため。48k PCM・AAC decode・短時間スペクトル・前後発話結合を再調査して特定。公式CLI `repair-tail` でu01だけ修復し、u02を含む他28発話は未変更。強化監査は旧v45でu01だけFAIL、新v47で29/29 PASS。 |

| R68 | ユーザー直接指示（2026-08-11）: 四角いナレーション枠は残すが専用ナレーターは使わず、その部分も主人公本人の声で読むことを新規制作ハーネスの標準にする。今回は動画を生成しない | 実装済(v46・決定論テスト対象) | 共通契約を`protagonist-voice`へ変更。公式CLIに`--protagonist-speaker-id`を追加し、複数人物で主人公が曖昧なら有料生成前にfail-closed。`speakerId/preset=narration`は四角枠表示用に維持しながら、Voice ID/Profile/設定/モデルを主人公と完全一致させ、contract-manifest監査で不一致を拒否。Claude/Codex共通スキルと両ホスト規則も更新。既存MP4・音声は未変更 |

| R69 | 新規エピソードでは有料画像生成前に、年齢段階・顔・髪・体格・衣装・配色・装飾・感情域・negative invariantsを持つキャラクターバイブルを固定する | 実装済(v46) | 公式CLI `--character-bible-path` から episode ID と非空castを検証し、候補生成のcast overrideへ直接接続。production state/planにバイブルの絶対パスとversionを保存し、場面画像より前の候補生成へ反映 |

| R70 | ナレーション行内の引用（例: `T大の彼氏にも「…」`）を新しい話者として誤抽出しない。候補承認・identity pack作成も公式CLIだけで完結させる | 実装済(v46) | 明示的な`話者:` prefixを最優先し、ナレーション等の非人物prefixに一致した行では引用符fallbackを打ち切る回帰テストを追加。公式CLI `character-approve` が選択候補からturnaround+expression sheetを生成し、承認済みregistryへ登録 |

| R71 | 主人公の台詞が無いナレーション専用カットでも、「俺」の視覚表現へ主人公identityを必ず引き継ぐ | 実装済(v46) | `createMangaScriptImagePlan` がナレーションを含む全カットへ承認済み主人公ID/参照画像を追加し、各ナレーションjobへ「俺=主人公、明示された他人物を置換しない」identity anchorを埋め込む。回帰テストでcharacterIdsとpromptを固定 |

| R72 | 高校→大学→社会人→30代をまたぐ新作では、承認identity packの服を全時代へ固定せず、顔・髪・体格を固定しながらキャラクターバイブルの年齢段階別衣装へ切り替える | 実装済(v46) | scene jobへ明示的な`storyStage`と該当人物のcharacter bible authorityを埋め込み、Visual QAにも「参照画像はidentity固定、衣装は明示stage優先」を渡す。高校制服・大学私服・社会人服・30代の回帰テストを追加 |

| R73 | 場面転換・新カット冒頭・同窓会会場の確立画でtop/overhead挿入を使わない。音楽室・同窓会・大学講義室・ラーメン店・街中・家庭を別ロケーションとして生成する | 実装済(v46) | semantic composition v2でscene-start/会場描写をwide系3種へhard-bindし、location rulesを物語用ロケーションへ拡張。新規場面冒頭がoverheadにならない回帰テストを追加 |

| R74 | QAで赤になった画像だけを公式CLIから安全に再試行し、合格済み画像は再生成しない | 実装済(v46) | `scripts/koya-manga-video.mjs images --retry-failed`を追加。executorは同一hashのfailed jobだけpendingへ戻し、complete+hash一致成果を再利用。prompt/hash変更時は古いfailed状態を自動解除し、再計画でDAGから消えたjobは`retiredJobs`へ隔離してactive集計を汚さない回帰テストを追加 |

| R75 | 背景参照アトラスは4面を黒いガターで明確に分け、複数ロケーションのモンタージュは別々の場所を一室へ混ぜない | 実装済(v46) | environment promptとblind Visual QA expected resultの双方へsolid black guttersを明記。`multiScene`ロケーションでは各場所の建築・配色・小道具を個別に固定し、QAも単一室の整合性を誤要求しない。回帰テスト追加 |

| R76 | 分割ページ用の単体panelを完成済み分割ページと誤認して、黒ガターや複数panelを再生成要求しない | 実装済(v46) | blind QAのstructure contractをjob kind別に分離。`split-panel`は1枚の連続画像・ガターなし、`split-page`は所定panel数・黒ガター必須、`scene-image`も単一連続画として評価する回帰テストを追加 |

| R77 | カット名にあるロケーション語を全発話へ「確立画」として誤適用せず、確立画は場面冒頭、以降の会話は反応・対面・挿入へ展開する。群衆が必要な会場では背景参加者を許可する | 実装済(v46) | semantic intentはcut purposeではなく各発話本文へ適用し、sceneStartだけをwide系へhard-bind。入口ローアングルの反復を除去し、人物禁止文を「意図しない主要人物は禁止、同窓会・卒業・職場・街では自然な背景群衆可」に修正。回帰テスト追加 |

| R78 | 季節・時間説明を机上俯瞰へ誤配分せず、大学・英語・就活等の説明で判読不能な生成文字や疑似文字を小道具へ混入させない | 実装済(v46) | `time-transition`を窓/引き画、`purpose-reflection`を人物の決意+単純な無地小道具へhard-bind。教育・進路・仕事関連jobでは本・資料・スマホ・掲示・名札・紙面を完全無地または非言語色面に限定し、文字/疑似文字/数字/記譜/ロゴ/グリフ線を禁止。回帰テスト追加 |

| R79 | 大量画像のblind QAでCodex判定プロセスを過負荷にせず、通信切断・timeout時に画像自体を再生成しない。冒頭の別れ2台詞は汎用構図任せにしない | 実装済(v46) | QA並列を12→4でも判定DB競合が残った実機結果を受け、最終的に完全直列1へ制限。同一生成画像上でQA infrastructure retryを最大2回実行し、画像生成回数1・QA試行3の回帰テストを追加。`別れよう`と長い拒絶台詞にはtight chest-up、明確なpalm-out、さくらの冷たい横顔、荒野の傷心、背景最小化をline-specific promptとして固定 |

| R80 | 画像生成サービスの利用上限へ再衝突しないよう、新規エピソード単位で生成・QA並列数を公式CLIから安全に絞れること | 実装済(v46) | `images`を含む公式CLI共通引数へ`--image-concurrency N\|auto`と`--qa-concurrency N`を追加し、共通契約の既定値を保ったまま当該実行だけ上書き可能にした。固定並列経路もAdaptiveConcurrencyControllerへ統一。利用上限でparkしたjobはキュー末尾ではなく現在cursorへ再挿入し、待機解除後に別jobへ進まず同じ未完了jobを最優先再試行する。2-job回帰テストで試行順`1→1→2`を固定 |

| R81 | 本作のCodex画像生成上限が長時間継続した場合も、既存合格画像を破棄せずBuzzAssist公式経路内で制作を完遂する | 実装済(v46・本作episode override) | 基本契約に空の`art.usageLimitFallbackModel`を追加し、本作だけ`grok-imagine-image-hermes`を明示。一次モデルがusage-limitの場合だけfallbackし、人物ごとのturnaround優先で最大3参照へ圧縮、同じblind Visual QAを必須化。各jobへ`generationModel`/`fallbackFromModel`、ledger summaryへfallback件数を記録し、一次モデルの合格済み成果はhash再利用する。決定論テストで一次上限→fallback成功・参照順・provenanceを固定 |

| R82 | Codex画像QAの利用枠が制作中に枯渇しても、通信失敗を絵の不合格として再生成せず、同じ画像を別のblind vision判定へ渡す | 実装済(v46・本作episode override) | Codex CLIのstderrとstdoutを併記してusage-limitを正しく分類。本作の`art.qaUsageLimitFallbackProvider=grok`により、候補384px＋承認参照最大4枚192pxをJPEG content blockとしてGrok headlessへ直接添付し、同一構造化schema・88点以上・hardFailuresゼロ基準を最大3ターンで適用。jobのsemantic evaluator/対象generation attemptとledgerのfallback承認件数を記録。過去の純QA infrastructure failureで画像ファイルが有効なら`retry-failed`は生成を省略して同じ画像だけ再判定する。決定論テストで画像生成1回のままCodex上限→Grok合格、およびQA障害後の再開を固定 |

| R83 | 契約でfallbackを明示した制作では、一つの画像パイプライン実行中に一次画像生成または一次画像QAの利用上限が確定したら、以後のjobや同じledgerからの再開で同じ上限照会を反復せず、契約済みfallbackへ直行する | 実装済(v46・契約時のみ) | `executeMangaScriptImagePlan`にrun-local circuitを追加し、既存ledgerの`primaryGenerationError`/fallback evaluator provenanceから再開時にも復元。一次画像生成・一次QAのusage-limitをそれぞれ記憶し、後続jobはfallback model/evaluatorを直接使用する。jobへ`primaryGenerationSkippedReason=usage-limit-circuit-open`と既存fallback provenanceを保持し、単一実行とledger再開の決定論テストで一次呼出し各1回・fallback各2回を固定。本作はR84によりfallback無効 |

| R84 | 本作の全生成ビジュアルはユーザー指定どおり`gpt-image-2-codex`だけを使用し、代替画像モデルで生成した試行物を本編へ混在させない | 実装済(v46・本作episode override) | 本作overrideの画像/QA fallbackを空へ固定。過去の代替モデル生成3カットと対応QAキャッシュを復元可能なTrashへ退避し、ledgerの該当jobを再実行対象に戻す。最終監査では全有料画像jobの計画モデルと生成provenanceを照合する |

| R85 | `--retry-failed`で視覚不合格画像を再生成するとき、前回のblind QA指摘を失わず、再開後の最初の生成から修正指示として適用する | 実装済(v46) | failed jobの`previousFailure.qa`へ構造化判定を保存し、再開時stateへ継承。最初の再生成promptを`correctivePrompt(job, previousFailure.qa)`へ切り替え、合格済みjobは再生成しない。決定論テストで2回目promptへのissue継承を固定 |

| R86 | 三人称ナレーションで明示された人物（例:「さくらは解雇された」「さくらの転落」）を、主人公の一人称ナレーションidentityへ誤置換しない。カット見出し・本文・登録aliasから実際の登場人物を解決し、主人公を描くナレーションだけ主人公参照を追加する | 実装済(v46) | `createMangaScriptImagePlan`のカット配役解決をspeaker-onlyから明示名・alias検出へ拡張。台詞のない三人称カットでは非主人公の明示主語を優先して主人公参照/anchorを外し、「俺」や主人公名を含む一人称カットは従来どおり主人公identityを維持。専用回帰テストを追加し全428テストPASS |

| R87 | 「無視して去る」「映画へ向かう」など人物の退出・移動が物語の中心のナレーションを、手元マクロや机上俯瞰へ割り当てず、退出動作・残された人物・進行方向が読める画角にする | 実装済(v46) | semantic composition v4へdeparture intentを追加し、OTS入口/出入口フレーム/ガラス越し引き画に限定。`去っていった`の回帰テストでmacro/overhead不使用とvisible actionを固定 |

| R88 | 3人場面のblind QAで参照上限により3人目を未承認人物と誤判定しない。各人物の代表参照を最低1枚ずつ優先し、期待cast名を判定文へ明示する。また「到着」「勢いを削がれる」ナレーションは机上俯瞰ではなく到着動作・反応ショットへ割り当て、3分割ページは最終クロップ安全域を各panel生成時に指示する | 実装済(v46) | compact turnaround参照を先頭に並べ、expected primary cast名をblind QAへ明示（同窓会等で物語上必要な非主要背景群衆はextra cast扱いしない）。arrival/deflation-reaction semantic intentとstory-3の左縦/右上/右下safe-zone promptを実装。専用回帰テストを含む全431テストPASS |

| R89 | 画像jobのprompt/hashが変わった再計画では、旧構図に対するQA指摘を新構図の初回生成へ混入させない。QA添付参照は人物名と順番を明示し、類似した女性キャラ名の取り違えを防ぐ | 実装済(v46) | `previousFailure.inputHash`一致時だけcorrective promptを継承し、blind QA promptへ候補以降の添付番号とcast名対応を追加。hash変更時は旧issueを使わず新promptだけで生成する決定論テストを追加 |

| R90 | 「それから」「その後」等の時間経過を3分割で描くモンタージュでは、意図した天候・時間差を連続性破綻と誤判定しない。分割ページQAにもcast・stage・モンタージュ意図と人物ごとの代表参照を引き継ぐ | 実装済(v46) | split-page jobへcomposition/cast/storyStage/fallback references/montageTimelineを継承し、blind QAへ時間経過の明示的な許容条件を追加。計画オブジェクトとQA文面を回帰テストで固定 |

| R91 | 長文台詞を1個の過密吹き出しに押し込まず、意味の切れ目で複数セグメントへ分け、各セグメントを独立した安全配置・表示時間で読ませる | 実装済(v46) | 長文bubble segmentationと各segmentのtiming/boundsをmanifestへ保存。実レンダーの全segmentを独立顔・組版監査の対象にした |

| R92 | 顔注釈がまだ無い初回配置でも吹き出しを仮置きでき、注釈確定後は同じアンカー体系で再配置する。引き画は左右パンへ偽装せず、画面中心を維持したpull-outとして扱う | 実装済(v46) | provisional face-aware placement、画面端アンカー、`wide`のsemantic pull-outを実装。cut-06/cut-14の実フレーム衝突はrender offsetで修復し、独立監査へ戻した |

| R93 | ElevenLabsが高品質WAV形式を拒否する環境でも、公式経路内で対応WAVへ安全にフォールバックする。またキャラクターバイブルの読み仮名を監査だけでなく実際のprovider発話文へ適用し、ルビを二重読みしない | 実装済(v46) | `wav_44100`拒否時のみ`wav_24000`へ再試行。読み仮名は長い固有名詞から置換し、`漢字（かな）`はかなだけをproviderへ渡す回帰テストを追加 |

| R94 | 静止画主体のカットを毎フレーム再計算してレンダーを停滞させず、bubble rasterの一時パス変更だけで映像キャッシュを無効化しない。Chromeスクリーンショットtimeout時は子プロセスを残さない | 実装済(v46) | 静止画`tpad`前処理、transient `rasterizedOverlayPath`のrender hash除外、timeout時のChrome子プロセス木終了を実装 |

| R95 | 30fps映像・48kHz音声のカット境界を小数秒丸めに依存させず、各カットを整数frame/整数sampleで固定して連結後の累積ドリフトを起こさない | 実装済(v46) | `exactCutMediaClock`、`-frames:v`、`apad=whole_len`、`atrim=end_sample`、ffconcatの明示durationを採用。境界カットをffprobeで実測 |

| R96 | カット単位AACの再連結でクリックや発話欠落を作らず、最終MP4音声は75本の承認済み発話WAVを絶対sample位置へ直接mixしてAAC化を一度だけ行う | 実装済(v46) | final muxの音声をsource-WAV direct mixへ変更。75/75発話存在、line-level spread、click/impulse、50/60Hz humを最終MP4のPCMから監査 |

| R97 | 音声分割は固定文字境界ではなく実音の開始・終了を検出し、100ms headと45ms以上のreleaseを確保する。長すぎる無音だけを詰め、実発話の立ち上がり/終端へ6–8ms microfadeを掛ける | 実装済(v46) | acoustic speech bounds、safe trim、0.68秒へのliteral-silence compaction、speech onset/release fadeを汎用cut-level音声へ実装。onset監査はv44 voice-segment metadataにも対応 |

| R98 | STT監査は固有名詞のルビ・表記差で正しい音声を誤不合格にせず、実発話の頭落ち・本文欠落は引き続きfail-closedにする | 実装済(v46) | `漢字（かな）`のruby collapse、長い発音mapping優先、Kuromojiによる期待文/認識文双方の読み正規化、日本語モーラ単位類似度、全編order alignment＋不合格行だけの局所再認識を実装。全編hotword強制は幻聴を起こすため不採用。読み仮名自体はR93により生成入力側で保証 |

| R99 | 独立顔監査はレンダー後の不透明白bubble内に完全包含されたcascade文字グリフや、吹き出し端に接する無地壁を顔と誤認しない一方、実顔との部分交差は厳格に検出する | 実装済(v46) | anime-cascadeの98%以上bubble内包hitをoverlay artifactとして除外。部分交差は吹き出し外に20%以上見える候補で、標準偏差<12・edge<1%・暗部<2%を同時に満たす完全な無地背景だけ除外し、目・髪・輪郭が残る候補、approved template hitは除外しない `bubble-faces-independent-v3-visible-face-evidence` |

| R100 | ユーザー直接フィードバック（2026-08-12）: 「まだ、けの直前にプチってなっている。徹底的に調査して無くして」。機械監査の合格よりユーザー実聴を優先し、同じ欠陥を三度提出しない | 検証済(v47) | 調査証拠 `audits/v47-click-investigation/`: 旧v45結合波形、u01末尾スペクトル、WAV/AAC sampleイベント、旧版FAIL/新版PASSレポート、比較試聴WAVを保存。監査へ「実発話終了後、静寂を挟んで出る孤立tail burst」ゲートを追加し、AAC遅延25msを許容しつつ当該欠陥だけ検出。完成 `manga-photo-homecoming-001-v47-tail-click-removed-r1.mp4` は公式監査16/16 PASS、Codex contact-sheet署名済み、`knownRemainingIssues=[]`。 |

| R101 | ユーザー直接フィードバック（2026-08-12）: cut-02の「商店街の古い写真店で…補修していた。」から「思い出は新品にできません」へ切り替わる間が早い。承認済み音声を変更せず、音声・吹き出し・カメラ尺を同期した自然な間へ広げる | 検証済(v48) | 公式CLI `adjust-gap` で設計可聴間0.18s→0.35s（明示pause 0.039999s→0.210000s）。最終AACを-48dBで再デコードした連続無音は0.200771s→0.370771s（+0.170000s）。29/29承認WAV hash不変。対象吹き出しは実MP4でold-last f576 / clear f579 / new-first f581、顔かぶり・残像なし。完成 `manga-photo-homecoming-001-v48-natural-pause-r1.mp4` は公式全監査16/16 PASS、Codex contact-sheet署名済み、`knownRemainingIssues=[]`。 |

| R102 | ユーザー直接フィードバック（2026-08-12）: cut-05の「君は僕の助手だ。勝手に帰られると困る」から「彼女の作品を、あなたの名前で出したんですか？」への間も短い。問い返し前の呼吸として自然な間へ広げる | 検証済(v49) | 公式CLI `adjust-gap` で設計可聴間0.064813s→0.28s（明示pause -0.075187s→0.14s）。最終AACの-48dB実測無音は0.136563s→0.351729s。29/29承認WAV hash不変、R101の実測0.370771sも維持。対象吹き出しは実MP4でold-last f1860 / clear f1866 / new-first f1872（画面上clear gap 0.336713s）、顔かぶり・残像なし。完成 `manga-photo-homecoming-001-v49-natural-pauses-r1.mp4` は公式全監査16/16 PASS、Codex contact-sheet署名済み、`knownRemainingIssues=[]`。 |

| R103 | ユーザー直接フィードバック（2026-08-12）: cut-08の3分割を使わず、全区間を通常の単一画像ショットで構成する。音声と吹き出しの切替は実発話へ一致させる | 検証済(v50) | 公式CLI `standard-cut` でcut-08の`panelLayout`/`flattenedSplitPage`を撤去し、証拠送信OTSと展示中止後の引き画の通常16:9単一画像2ショットへ置換。5吹き出しはElevenLabs文字時刻と-42dB実波形へ同期し、各発話の可聴開始80ms前に表示、句内clear gapはu01=0.15s/u02=0.08s、ショット切替間は0.4795s。実素材から顔・重要領域を再計測し、独立レンダー顔監査5/5 PASS。29/29承認WAV hash不変、R101/R102の間も維持。完成 `manga-photo-homecoming-001-v50-standard-cut08-r1.mp4` は公式監査16/16、Codex MP4 contact-sheet署名、音声・映像フルデコードすべてPASS、`knownRemainingIssues=[]`。 |

| R104 | ユーザー直接フィードバック（2026-08-12）: cut-08冒頭の背景画像は手とスマホが遠近で大きすぎるため、自然な人体比率・小道具比率のまともな構図へ差し替える | 検証済(v51) | built-in ImageGenの`precise-object-edit`で、美緒・蓮・礼司、写真店内、雨夜、送信行為を維持したままカメラを引いた肩越し構図へ再制作。スマホ高は旧注釈37%→新実測19%（約49%縮小）となり、両手も胸元の自然な把持へ修正。新画像上で3人の顔・身体・両手・スマホを再計測し、公式CLI `standard-cut` で吹き出し5件を再配置（顔/重要物overlap=0）。実MP4の対象5フレームと全編contact sheetをCodexが目視し、巨大な手・スマホ、指破綻、3分割再発なしを確認。29/29承認WAV hash不変、R101〜R103の尺・音声同期も維持。完成 `manga-photo-homecoming-001-v51-natural-phone-shot-r1.mp4` は公式監査16/16、独立顔監査、カメラ掃引、音声波形、フルデコードすべてPASS、`knownRemainingIssues=[]`。 |

| R105 | 2026-08-12のリポジトリ・Claude Code/Codexセッション横断分析で抽出した依頼を、公式Anthropic `skill-creator`方式の日本語スキルへ統合し、新規台本でも同じ品質契約を再現する。Claude CodeとCodexは別実装を持たず、同じ正本を読む | 実装済(v47契約) | `.agents/skills`を日本語の正本とし、`.claude/skills`と`.codex/skills`は正本へ誘導する薄い日本語アダプターに限定。SKILL本文は実行手順、詳細品質要件は一段下の`references/`へ分離し、両ホスト経路・日本語記述・評価ケースをテストで固定 |

| R106 | 機械監査合格だけで視聴品質を合格扱いしない。ユーザーの実聴・目視指摘を最優先し、人体/手/小道具比率、疑似文字、編集連続性、画像保持時間、台詞の間、音声の自然さ、頭切れ・末尾クリックまで明示的に知覚レビューする | 実装済(v48契約) | agent signoff v3 / review notes v2で、MP4全編、contact sheet、代表フレーム、音声スポットチェックの実ファイルhash・確認区間と、全品質項目ごとの証拠参照付きレビュー記録を必須化。単なる`--pass`、MP4/contact sheet/frame変更、契約変更、review notes改変後の古い署名を拒否する |

| R107 | 完成manifestへ過去工程の版名を現在状態のように残さず、正規のentrypoint・契約版・契約digestを一意に記録する | 実装済(v47契約) | `video.statusAfterRender`と曖昧な`production.version`を契約適用時に除去し、`production.pipeline`へ公式entrypoint、契約版、digestを保存。契約監査は旧ラベル残存とprovenance欠落をfail-closedで拒否 |

| R108 | Claude Code/Codexの生セッションログへ資格情報を残さない。既存ログは値を表示せず高確度パターンだけを原子的にマスクし、今後もdry-run監査できること | 実装済(v47契約) | `scripts/sanitize-agent-session-secrets.mjs`を追加。既定は読取専用監査、`--apply`時のみ対象ファイル内のprovider tokenを`[REDACTED_*]`へ置換し、値自体は標準出力へ出さない。fixture回帰テストを追加 |

| R109 | 新規制作経路から67本のversion固有migrationを隔離し、誤って旧full/speech/voice経路を呼ばない。現在の公式基盤を履歴へ固定し、再現可能な状態にする | 実装済(v47契約) | 旧migration inventoryをfail-closed監査し、packageの通常コマンドからlegacy aliasを撤去。新規制作は`node scripts/koya-manga-video.mjs`だけを入口とし、公式moduleからversion固有script参照が無いことをテスト。項目1の欠落MP4は対象外のため復元しない |

| R110 | 一画像へ複数発話を自然に保持し、文脈のない挿入画・過剰な画像切替・短すぎる保持・長すぎる保持を、目視メモだけでなく新規台本共通の必須機械監査で拒否する | 検証済(v48契約) | 汎用`editorial-quality`監査を17個目の必須監査へ追加。連続同一画像を一つの編集区間へ正規化し、複数発話画像比率35%以上、保持中央値6秒以上、最大69.6秒以下、全発話割当、未割当ショット0、条件付き分割導入0をfail-closedで検証。実MP4 manifestは21区間、複数発話比率0.381、中央値6.082秒、最大14.133秒、29/29発話割当でPASSし、合格/各失敗の回帰テストも固定 |

| R111 | Claude/Codexの知覚署名を自由記述の長さだけで合格させず、実MP4・contact sheet・代表フレーム・契約digest・レビュー時刻・確認区間へ暗号学的に拘束する | 検証済(v48契約) | review notes v2 / agent signoff v3でMP4・contact sheet・5代表フレーム・review notesファイル/正規化内容のSHA-256、契約digest、0〜149.087696秒全編、冒頭/中盤/終端を含む音声4区間、項目別evidence参照を固定。実証拠7ファイル再hashと署名ゲートがPASSし、ファイル変更、区間不足、古い契約、digest改変を拒否する回帰テストも固定 |

| R112 | 制作契約の一部だけを手書き検証する状態を廃止し、全フィールドをJSON Schemaで閉じ、未知キー・型崩れ・安全値の緩和を漏れなく拒否する | 実装済(v48契約) | `additionalProperties:false`の完全JSON Schemaを正本契約へ紐づけ、Ajv検証をbase/episode override解決後へ適用。契約の全leafを一つずつ不正型へ破壊するmutation test、未知のtop/nested key、安全値緩和テストを追加し、全454テストPASS。配布packageにも`config/`と要求台帳を含める |

| R113 | `/Users/higataiyu/まさお`全件監査で得た「外部状態・評価分離・三重停止条件」を名目上の部品で終わらせない。最終`quality-harness-final`は空の`active`状態を作り直して事前ゲートだけで合格してはならず、当該実MP4に対する全必須監査、独立知覚署名、契約digest、証拠hashから終端状態を導出して保存する | 検証済(v49契約) | standalone final preflightを拒否し、公式最終監査の最後で自己監査を除く全必須監査の証拠SHA-256、契約digest、実MP4 SHA-256へ拘束した`final-decision.json`/`quality-loop-state.json`を作成。旧v48署名では`needs-human-approval`停止、v49再署名後は実MP4の17/17監査、16/16 hash-bound evidence、`knownRemainingIssues=[]`、`final-koya-audited`を実証 |

| R114 | 曖昧な制作判断は、正解が機械判定できる場合・1案へ赤入れすべき場合・複数の異なる軸から選ぶ場合を明示分類する。Best-of-Nは2〜5案、軸の重複なし、匿名化、判定前の対応表非開示、採用理由の保存を必須とし、キャラクター・声・ブランド等の高コスト主観判断を自動採用しない | 実装済(v49契約) | `classifyMangaDecisionGate`でdeterministic/red-pen/human Best-of-N/fresh blind Best-of-Nを分類。匿名候補を2〜5件・variation axis一意・artifact必須・verdict先行へ強化。キャラクターCLIの`--approval-reason`と音声`selectionReason`/reviewerを永続化し、DAGにも人間判断と採用理由必須を明示 |

| R115 | 品質ループは固定rubricの全項目、独立evaluator、具体的な証拠、失敗fingerprint、前roundからの修正差分を欠いた自己採点で合格してはならない。品質閾値・最大round・最大時間・最大費用・停滞上限を別々に判定し、同型事故はchecklist→恒久指示→機械hard gateへ昇格する | 実装済(v49契約) | quality loop v2を完全schemaへ追加。全rubric項目、evaluator context分離、具体メモ、hash-bound evidence、hard-gate契約digest、failure fingerprint、直前failure参照、再試行差分を必須化。観測時刻から経過時間を算出し、`needs-human-approval / budget-exhausted / blocked`を区別。同型事故の昇格ロジックを維持 |

| R116 | ユーザー直接指示（2026-08-13）: 残っている改善をすべて実施する。品質ループ・独立評価provenance・証拠Merkle・匿名Best-of-N・事故昇格・公式DAG runtimeを本番経路へ接続し、旧契約で完成した実作品を現行契約で再監査し、さらに未見台本canaryで新規制作の再現性を実証してリモートへ反映する | 実装済(v50契約) | `full/audit/signoff`の終端条件を実round stateへ接続し、generator/reviewerのhost・ID・contextを別々に拘束。公開judge packetと秘密対応表、実ファイル再hash＋Merkle root、`final-decision.json`と`quality-loop-state.json`、既定DAG runtimeを本番接続した。写真店作品、旧v46荒野作品、完全未見canaryの3本で実MP4・独立context・全尺decode・空の未解決事項まで実証 |

| R117 | 表示上の末尾句点を除く契約は、台本本文や音声本文を書き換えず、旧SVG・新規台本・分割セグメントのすべてへ同じhard gateとして適用する | 実装済(v50) | `bubbleDisplayPolicy.preserveAuthoredSpeechText`と全SVG再生成を契約化。実MP4由来typography監査で末尾`。`と原文一致を独立検査し、同型事故2件をincident ledgerのhard-gateへ昇格 |

| R118 | 未見台本canaryと旧作品再準備で得た失敗を新規台本の既定品質へ一般化する。flatten済み分割ページ全顔、自然な日本語分節、顔検出誤検知、ナレーション主体長編の画面保持、旧承認音声・生成provenanceの保全を場当たり修正にしない | 実装済(v50) | 合成後1920×1080分割ページへ複数一意顔注釈と0件停止を導入。Intl.Segmenter由来の語境界監査で固有名詞・複合語・活用・助詞直前分割を拒否。吹き出し内cascade候補は直前直後のclear frameへ同位置顔が無い場合だけ誤検知除外。ナレーションと隣接台詞を最大2発話で共有し、代表画は台詞人物を優先。legacy stateの実生成者provenanceとdialogue alignmentに完全一致する既存PCMだけを復元し、有料再生成を防止 |

| R119 | v50長尺再レンダーで判明した実運用退行を新規制作へ残さない。timed segmentの文中句読点、計画矩形と実overlayの座標差、3倍oversampleのメモリ飽和、中断partial MP4、同一パス上書き後の旧STT cache誤再利用をfail-closedで防ぐ | 実装済(v50) | 表示全文にだけ末尾句点処理を行いsegment本文を保持。独立顔監査v5は実overlay PNGのalpha bboxを使用。3倍oversampleは約6GiB/jobで物理メモリ・CPU連動（16GiB既定2）。cut再利用は`status=complete`かつffprobeでvideo stream/正尺を確認。STT cacheは認識時PCM SHA-256と順序付き発話digestの完全一致だけを許す。一般化事故10件をtracked seed `config/koya-manga-quality-incidents.json`へ格納し、実行時台帳と強い昇格状態を保ってマージする |

| R120 | 荒野旧作品の実MP4監査で見つかった小顔・非話者顔・flatten済みページ顔を、新規台本でも話者判定に依存せず0px保護する。自動検出漏れは画像hash拘束付き原寸レビューで補い、分割座標は実overlay寸法へ展開する | 実装済(v50) | 全検出顔を`face + hardProtection=true`へ統一。`sourceAvoidRegionsInOverlaySpace`は契約1920x1080ではなく各specの実`imageSize`を使用。独立実MP4監査由来の補足顔レビューをSHA-256・reviewer・時刻へ拘束し、元画像変更時は拒否する回帰テストを追加 |

| R121 | 顔保護を強めた結果の狭い配置でも、文字縮小・顔保護緩和・空白だけの時限吹き出し・全件への先回り複数列化で解決しない | 実装済(v50) | 日本語語境界で12字以下への再分割を試し、成立しない場合は承認済み自然分割を維持。通常レイアウトが衝突または組版hard gateに失敗したsegmentだけ2〜3列へ退避し、空白だけのsegmentを生成前に拒否する回帰テストを追加 |

| R122 | 独立顔cascadeは光点・図形の低信頼誤検知を除外しつつ、遠景やスマホ内の小さい実顔を落とさない | 実装済(v50) | `detectMultiScale3`のlevelWeightを証拠化し、荒野編の実顔陽性（約1.8以上）と発光点陰性（-0.088）から保守的に1.0へ校正。高信頼候補には従来の0px重なり判定を維持し、陽性・陰性双方を回帰テストへ固定 |

| R123 | 実overlay PNGのalpha bboxは、元SVG/spec寸法ではなく、実際にdecodeしたPNG固有のpixel寸法で正規化する。制作時のraster resizeがあっても監査矩形を膨張・移動させない | 実装済(v50) | 独立顔監査v6は各raster PNGからalpha bboxと実`imageSize`を同時取得し、その座標系で正規化してから必要なpage-camera投影を行う。1920x1080 PNGと1672x941 specが異なる回帰ケースを固定 |

| R124 | 自動顔検出が顕著な顔を見落とし、opaque吹き出しで完全に隠した後はrendered cascadeでも復元できない。独立知覚レビューの実MP4指摘を元画像SHA拘束注釈へ戻し、重要証拠物も同じカメラ全区間0px契約で保護する | 実装済(v50) | `koya-source-region-review-v2`を導入し、face/hand/prop/evidence/textを画像hash・発話ID・根拠へ拘束。`hardProtection=true`の重要領域を`protected-*`へ投影し、候補配置で1pxでも重なれば拒否。荒野編385秒の顔、100/253/280秒のスマホ・地球儀・世界地図を回帰対象化 |

| R125 | 連続ナレーションをhold最適化だけで同一画像へ統合し、後続文専用の視覚証拠を消してはならない | 実装済(v50) | ナレーション同士は目的別画像を保持し、narration↔dialogueの意味的bridgeだけ従来どおり最大2発話共有。荒野編の「結婚」から「子供二人」へ専用家族画像が切り替わる回帰テストを追加 |

| R126 | 自動cascadeが別人物の大きな顔を発話者primaryへ誤対応しても、正しい手動話者顔を無視しない。ナレーション中を含むカメラ移動全区間で、同一画面の全人物頭部を0px保護する | 実装済(v50) | hash拘束付き手動発話者顔を自動primaryより常に優先し、自動hitは非話者hard obstacleとして保持。`purpose-reflection`ナレーションは直前対話へ統合せず承認済み専用画像を保持。荒野編45.802〜58.092秒のさくら頭髪と282秒付近の荒野右目を独立全編レビューが検出し、cut-01/cut-07の全人物頭部注釈と回帰テストへ固定 |

| R127 | 群衆画面の心の声で自動cascadeが背景人物を主人公primaryへ誤同定しても、明部を背景へ向けない。分割ページの独立顔監査は、腕時計や文字を顔と誤検知しても実顔保護を弱めず判別する | 実装済(v50) | `cut-03-u01`主人公頭部を元画像SHA-256拘束注釈へ戻し、thought明部・カメラ焦点・吹き出し回避を同じ正しいprimaryへ再構築。独立顔監査は合格閾値超過候補をbubble-clear frameへwhole-page camera再投影し、そこに同一顔がないoverlay由来候補だけを除外する回帰テストを追加 |

| R128 | `render --cut-ids`は再構築する最小集合であり、選択外cutの現在入力が前回完成bindingと同一なら再利用する。decode可能でもimage/audio/overlay/camera入力hashが変わった旧cutは再利用しない | 修正済(v50) | 当初の「選択外はdecodeできれば保持」が、prepare後の新SVGと旧overlay PNG/MP4を混在させ、荒野編cut-08のtypography監査を落とした。選択外にも`complete + inputHash一致 + ffprobe decode`を必須化し、入力変更cutは指定外でも再構築する回帰へ修正 |

| R129 | 思考スポットライト監査はmanifestの正規化前focusを実cropとして扱わず、レンダーが終端zoomの安全範囲へclampした後のcamera/keyframesで顔を投影する | 実装済(v50) | 荒野編cut-03の生focus `0.68/0.195` がレンダー時 `0.531037/0.468963` へ正規化される差を固定。監査も同じpull-out正規化を行い、実MP4の5点すべてで主人公顔明度比1.01以上・周囲暗部ありを検証する回帰テストを追加 |

| R130 | 別カットで一度手動顔注釈を追加しても、同一人物の別画像へ注釈を推測流用しない。独立全尺レビューで次の検出漏れが見つかったら、当該元画像を原寸再計測してhash拘束する | 実装済(v50) | 荒野編第3独立レビューが、既知8回帰点の修復確認後、指定外の305.25〜307.25秒で`cut-07-u04`の発話者・荒野の顔全体を吹き出しが覆うことを新規検出。元画像SHA-256 `52993cc5…b938c30`へ頭部注釈を拘束し、実設定ファイルを読む回帰テストを追加 |

| R131 | 反射・鏡像・写真内の顔も、本人の手前顔とは別の可視顔として同一元画像内に全件在庫化する | 実装済(v50) | 荒野編第3独立レビューが324〜328秒で窓反射の荒野顔への重なりを検出。`cut-07-u05`の手前頭部と窓反射頭部を同じ画像SHA-256 `e97fcc83…b04668e`上の別ID・別矩形でhard face化し、両方の実設定を回帰テストへ固定 |

| R132 | source-face detectorが無効注釈・hash不一致・実行エラーで失敗したとき、前回の合格`source-face-placement.json`を今回の証拠として再利用しない | 実装済(v50) | detector起動前に対象の派生reportを正確に削除し、今回呼び出しが新規reportを生成できなければprepareを例外停止。stale `pass:true`を事前配置した回帰テストで受理しないことを固定 |

| R133 | 部分レンダーで選択外cutを再利用するとき、旧MP4へ現在の入力hashを上書きして「一致したこと」にしてはならない | 実装済(v50) | 荒野編のcut-07修復時にcut-08の旧PNG/MP4を保持したまま、新SVGのhashをjobへ保存していたため、実ラスター監査だけが不一致を検出した。再利用判定をjob更新より先に厳格化し、staleな選択外cutは再レンダーする |

## パイプライン不変条件（違反禁止）

1. **画像変更（差し替え・クロップ・統合・構図変更）には、同一変更内で顔・領域アノテーションの再計測を必ず伴うこと。** 旧座標の流用が v31→v36、v38パネル、v38オーバーライドで3度同型の退行を起こした。
2. **配置と監査が同一の座標データを共有してはならない。** 監査はレンダー済みフレームからの独立検出（audit-manga-bubble-faces-independent.py）で行う。マニフェスト座標との照合だけの監査は「自分の宿題を自分で採点」であり、検証と認めない。
3. パネルページの回避領域は generate-manga-panel-bubble-overrides.mjs で毎回自動生成する（手書き座標の埋め込み禁止）。
4. 新規エピソードの音声生成は必ず公式 `scripts/koya-manga-video.mjs speech/full` の汎用cut-level Eleven v3経路を使う。`MANGA_DIALOGUE_VERSION=v25 scripts/generate-manga-v22-dialogue-audio.mjs` はベンチマーク固有IDを持つ旧移行であり、新規作品には使用禁止。legacy speechコマンドも禁止。
5. **承認済み音声の保全**: ユーザーが承認した演技のテイク・per-utterance WAVを上書きする再生成は禁止。テイクは入力ダイジェスト付きファイル名（R60で導入）。部分再生成時は対象外の発話の音声を変更しないこと（変更が避けられない場合は承認済みソースからの復元まで含めて1サイクル）。
6. **新規生成のナレーション/モノローグは普通の台詞と同じ素の音声テキストで、主人公の承認済みVoice IDを使って生成する。** 四角枠用の`speakerId/preset=narration`は維持するが、Voice ID/Profile/設定/モデルは主人公と完全一致させる。`semanticIntentByUtterance` や`[thoughtful]`等の演技タグを再混入させない。承認済み復元（manga-photo-homecoming-001のv43 Koichi等）は凍結済みepisode overrideだけの例外とする。実WAVの入力、sidecar、manifestの3者を同一値として監査する。

## 退行履歴（テストで固定済みであること）

1. カメラ文法が「全部引き」へ縮退（v33のスキル化ミス）→ v35で3系統復元、test/mangaPageCameraGrammar.test.mjs で固定。
2. slow-push既定値がCLI/MCP入口に残存し再混入 → 入口から削除、正規化+監査で拒否。
3. 吹き出しが話者の顔に被る（画像差し替え後の旧座標流用）→ v36 per-shot注釈 + 0px硬ゲート + 実映像監査。
4. 心の声の明部が顔からズレる（固定スクリーン座標）→ v34でカメラ投影方式+OpenCV実測、回帰テスト。
5. 太字化け文字の再発 → exactTextMatch/フォント契約ゲートでthrow。
6. 間の調整で冒頭の頭切れ → speechStartSeconds尊重+ギャップ設定。

## 運用ルール

- 実装・修正時は本台帳の該当項目の状態を必ず更新する。
- 変更のたびに `node --test test/*.test.mjs` で退行チェック（件数を固定値として扱わない）。
- 完了報告は設定値でなく、レンダー済みMP4の実測監査（rendered-camera / bubble-frames / 音声PCM md5）で行う。
