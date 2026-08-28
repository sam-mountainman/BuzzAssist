# 音声品質ハーネス運用ランブック（R194）

2026-08-28時点の「音声品質最強化」の全体運用。ElevenLabs（対象チャンネル）と
Fish Audio（別案件）の両方に共通のゲート＋プロバイダ別の最適設定をまとめる。

## パイプライン全体

```
台本 → ①テキスト前処理 → ②読み辞書 → ③生成(Best-of-N) → ④品質ゲート → ⑤選定 → ⑥人間試聴
             ↑←←←←←←← 誤読2回でactive昇格（R194） ←←←←←←←←←←←←←←←←↓
```

## ① テキスト前処理

```bash
python3 scripts/prepare-speech-text.py input.json
```
同形異音・数字＋助数詞・英字・読み不明語をフラグし、読み辞書を適用した
`appliedText` とモーラ数・想定尺を返す。フラグは生成前に読みを確定するため
の助言で、放置した語が誤読されたら②の辞書に登録する。

## ② 読み辞書（config/koya-reading-dictionary.json）

- 誤読1回目 = candidate、2回目 = active（自動適用）。`recordMisreading` が管理し、
  矛盾する読みは上書きせずエラーで人間に返す。
- activeエントリは全エピソードの `speech.pronunciations` の下に自動マージ
  （エピソード側が優先）。
- **ElevenLabsへのネイティブ登録**:
  ```bash
  node scripts/sync-elevenlabs-reading-dictionary.mjs
  ```
  activeルールをPronunciation Dictionary（aliasルール・word_boundaries=false、
  日本語は分かち書きがないため必須）としてAPI登録し、以後の
  text-to-dialogue リクエストに `pronunciation_dictionary_locators` が自動で付く。
  ルール集合が変わるたび再実行（ハッシュ一致ならnoop）。

## ③ 生成のプロバイダ別最適設定

### ElevenLabs（漫画動画ハーネス・eleven_v3 dialogue API）
- 実装済み: stabilityサイクル（テイクごと0.43〜0.55）、seed固定、
  `language_code: ja`、`wav_44100`→`wav_24000`フォールバック、
  演技タグ（[determined]等）をperformancePromptで注入、辞書locators。
- 台詞タイプ別の目安: ナレーション stability 0.55〜0.6／通常台詞 0.45〜0.5／
  感情の強い台詞 0.35〜0.45（バラつきを許して演技を取る）。
- 1リクエストの合計2,000字制限に注意（カット分割で自然に満たされる）。

### Fish Audio（マイク）
- **モデルは `s2-pro`**（ヘッダで明示。API値として `s2.1-pro` は存在しない。
  s1 は括弧の感情タグを使う旧世代）。
- オフライン一括生成では `latency: "normal"`（安定優先）、`format: wav`、
  `sample_rate: 44100`。
- **`normalize` は日本語の数字・日付展開には効かない**（公式仕様は英語・中国語向け）。
  日本語の数字＋助数詞・日付は `scripts/prepare-speech-text.py` でローカルに
  読みを確定してから渡すこと。
- `temperature` は既定でまず生成し、テイク間バラつきが欲しい場合のみ±0.1〜0.2。
  アーティファクトが出たら `repetition_penalty` を1.1前後に。
- ボイスは Voice Library のネイティブ日本語モデルを `reference_id` で固定。
  実在人物の参考動画からの無断クローンは行わない。

## ④ 品質ゲート

```bash
python3 scripts/audit-voice-quality.py checks.json
```
- STT往復CER（kotoba-whisper・読みかな正規化・fail>0.13）
- UTMOS自然さ（fail<2.7、2秒未満はwarn格下げ）
- F0半音分散<1.2で棒読みfail／モーラ毎秒4〜10
- 内部無音・端無音（Silero VAD。内部ポーズ>1.2sでfail）
- ポーズ位置（単語タイムスタンプ。助詞・助動詞の直前に0.3s以上の間が
  落ちる場合はwarn＝不自然な息継ぎの疑い）
- クリッピング（原音サンプルで測定）・LUFS・話者アンカーcosine
- **実行系は固定**: `VOICE_QA_PYTHON`（既定 `/usr/bin/python3`）。
  `python3` は対話シェルとNode子プロセスで解決先が異なることがあり、
  依存の無い実行系を引くとゲートが黙って無効化される。
- **可用性チェックは有料生成の前**に走り、torch・faster-whisper・fugashi・
  UTMOSキャッシュの実体まで確認する。欠けていればカットを停止する。
- **fail-closed**: hard fail のテイクは選定の適格集合から除外される。
  全滅時は最大4テイクまで自動追加し、それでも全滅なら停止して人間へ。
  必須メトリクス（utmos / 全segmentのcer）が測れなかったテイクも hard fail。
- ElevenLabs側は公式CLIの既定でON。無効化は
  `--no-voice-quality-gate --voice-quality-gate-override-reason "<理由>"` の
  監査付きオーバーライドのみ。Fish側は生成後にCLIで同じゲートを通す。

## ⑤⑥ 選定と人間試聴

- 実測（2026-08-28・採用記録3組）: UTMOS順位と人間採用の一致は2/3。
  Wilson95%区間は0.21〜0.94と広く、**自動採用の根拠には足りない**。
  人間ペア比較50〜100件を集めてBradley-Terryで選好を学習するまでは、
  台詞・ナレーションとも最終選定は人間が行う。
  UTMOSv2も並走校正したが一致1/3で、置き換える根拠はなかった。
- 匿名A/B試聴は bestofn の arena をラッパー経由で使う:
  ```bash
  # 1) 匿名化＋SHA拘束してアリーナを開く
  node scripts/koya-blind-review.mjs open --set canvas/blind-reviews/<name>.json
  node /Users/higataiyu/まさお/bestofn-repo/bin/bon.js serve -d --open
  # 2) 人が選んだら、理由付きで記録（--note は必須）
  node scripts/koya-blind-review.mjs record --set canvas/blind-reviews/<name>.json \
    --winner A --reviewer taiyu --note "落ち着いたトーンがチャンネルに合う"
  ```
  開始時のコミットメントdigestを記録時に照合するため、レビュー中に
  候補や対応表が差し替わると検出して停止する。
  公式のblind packet（キャラ候補）を見るときは
  `scripts/koya-open-blind-arena.mjs --public <judge-packet.json>` を使う。
  **アリーナは閲覧用で、記録は公式CLI**（`character-approve` 等）に残す。

## 校正記録（2026-08-28）

- 承認済み実音声9件: CER床0.02〜0.10、UTMOS 2.86〜3.99（1.0秒の短尺のみ2.18）
- 誤判定を2件修正: 漢字/かな未正規化のCER膨張、短尺UTMOSの不当fail
- 既知の限界: UTMOSは感情演技の好みを測れない（cut-02で人間と逆転）。
  プロバイダ購読階層により `wav_44100` が拒否される場合は24kへ自動フォールバック。
- 校正の機械可読版: `docs/koya-voice-quality-calibration-2026-08-28.json`
  （閾値・環境・各チェックの入力SHA・UTMOSv2の並走結果を含む）。

## 監査ログ

- 2026-08-28: Codex（gpt-5.6-sol・max）による独立レビューを3回実施。
  fail-open経路（hard failでも採用される／CLI未配線／必須メトリクス欠如を
  passにする）、CERの循環参照、読み辞書の部分文字列置換事故、
  torch.hubの実行時コード取得を指摘され、すべて修正した。
  詳細は台帳 R194〜R200。
