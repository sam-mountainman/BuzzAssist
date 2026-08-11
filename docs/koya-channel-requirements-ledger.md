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

## D. カメラ（詳細は .claude/skills/manga-page-camera を必ず参照）

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
| R25 | 黒分割ページは平坦化して全体に1カメラ (s2#14,#18) | 検証済 | v32/v33、requireWholePageSplitCamera、cut-06右→引き/cut-08トップ→引き |
| R26 | カメラ文法のスキル化・退行防止 (s2#18,#20) | 検証済 | .claude/skills/manga-page-camera（~/.codex/skillsから移植）+ 決定論的監査スクリプト |

## E. 音声

| # | 要求 | 状態 | 根拠 |
|---|---|---|---|
| R27 | 自然な日本語イントネーション・棒読み禁止・感情（怒り/悲しみをシーン通りに）(s1#11,#14,#33,#38,#42,#45) | 検証済 | eleven_v3 text-to-dialogue一括生成 + performancePrompt（[sarcastic]等）、v25 |
| R28 | セリフ間の音量/トーン変動禁止 (同上) | 検証済 | wav_48000_pcm_s24le_loudnorm_two_pass per utterance |
| R29 | 読み間違い禁止 (s1#11ほか) | 検証済 | v11発音修正パス scripts/apply-manga-v11-pronunciation-corrections.mjs |
| R30 | プツッ音（クリック）禁止、特に繋ぎ (同上) | 検証済 | 無フェード結合の代わりにPCM連結+ローカルノーム、v25監査 |
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
| R44 | 黒2/3分割ページ（不均等可）の適所使用 (s1#54,s2#7) | 検証済 | cut-06(2分割)/cut-08(3分割)、後合成黒線方式を採用 |
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
| R51 | ⚠黒分割ページの各パネルは「単体で状況が読める構図」にする（詳細前掲） | 検証済(v38) | **参考実測**（v38-split-panel-content、7モーメント）: パネルの87%(13/15)に可読な顔・全モーメントに最低1つ、顔サイズはmedium(20-50%)が典型、話者の顔可読6/7、ガター中央〜1:2比・幅中央値1.4%、保持中央値9s。実装: パネルは顔中心の事前クロップ派生画像（apply-manga-v38 PANEL_CROPS、ffmpeg決定論生成。パネルカメラは焦点可動域±0.02しかないため）。cut-08-u02はページ可視窓に収まらないため2連続ナレーションカードへ分割（無音実測3.47s境界）。※参考は「固定ガター下で各パネル独立移動」だがユーザー明示指示R25「ページ全体を1枚として動かす」が優先（台帳注記） |
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

## パイプライン不変条件（違反禁止）

1. **画像変更（差し替え・クロップ・統合・構図変更）には、同一変更内で顔・領域アノテーションの再計測を必ず伴うこと。** 旧座標の流用が v31→v36、v38パネル、v38オーバーライドで3度同型の退行を起こした。
2. **配置と監査が同一の座標データを共有してはならない。** 監査はレンダー済みフレームからの独立検出（audit-manga-bubble-faces-independent.py）で行う。マニフェスト座標との照合だけの監査は「自分の宿題を自分で採点」であり、検証と認めない。
3. パネルページの回避領域は generate-manga-panel-bubble-overrides.mjs で毎回自動生成する（手書き座標の埋め込み禁止）。
4. 音声の再生成は必ず MANGA_DIALOGUE_VERSION=v25 パイプライン経由（legacy speechコマンドはナレーション調に退行する）。
5. **承認済み音声の保全**: ユーザーが承認した演技のテイク・per-utterance WAVを上書きする再生成は禁止。テイクは入力ダイジェスト付きファイル名（R60で導入）。部分再生成時は対象外の発話の音声を変更しないこと（変更が避けられない場合は承認済みソースからの復元まで含めて1サイクル）。
6. **v41以降のナレーション/モノローグは普通の台詞と同じ素の音声テキストで生成する。** `semanticIntentByUtterance` や `[thoughtful]` 等の演技タグを生成入力へ再混入させない。実WAVの入力、sidecar、manifestの3者を同一値として監査する（R64b）。

## 退行履歴（テストで固定済みであること）

1. カメラ文法が「全部引き」へ縮退（v33のスキル化ミス）→ v35で3系統復元、test/mangaPageCameraGrammar.test.mjs で固定。
2. slow-push既定値がCLI/MCP入口に残存し再混入 → 入口から削除、正規化+監査で拒否。
3. 吹き出しが話者の顔に被る（画像差し替え後の旧座標流用）→ v36 per-shot注釈 + 0px硬ゲート + 実映像監査。
4. 心の声の明部が顔からズレる（固定スクリーン座標）→ v34でカメラ投影方式+OpenCV実測、回帰テスト。
5. 太字化け文字の再発 → exactTextMatch/フォント契約ゲートでthrow。
6. 間の調整で冒頭の頭切れ → speechStartSeconds尊重+ギャップ設定。

## 運用ルール

- 実装・修正時は本台帳の該当項目の状態を必ず更新する。
- 変更のたびに `node --test test/*.test.mjs`（373件+）で退行チェック。
- 完了報告は設定値でなく、レンダー済みMP4の実測監査（rendered-camera / bubble-frames / 音声PCM md5）で行う。
