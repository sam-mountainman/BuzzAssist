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
- **モデルは `s2.1-pro`**（ヘッダで明示。s1は旧世代）。
- オフライン一括生成では `latency: "normal"`（安定優先）、`format: wav`、
  `sample_rate: 44100`、`normalize: true`（数字・日付の読み展開）。
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
- 内部無音（エンベロープ検出、>0.9sでwarn=意図確認）
- 端無音・クリッピング・LUFS・話者アンカーcosine
- ElevenLabs側はテイク選定に自動合成（`KOYA_VOICE_QUALITY_GATE=1`）。
  Fish側は生成後にCLIで同じゲートを通す。

## ⑤⑥ 選定と人間試聴

- 実測（2026-08-28・採用記録3組）: UTMOS順位と人間採用の一致は2/3。
  よって**ナレーションは自動選定可、台詞の最終選定は人間**。
- 台詞のA/B試聴には bestofn の arena を使う（コードはリポジトリへコピーしない。
  ライセンス表記がないためローカル利用に限定する）:
  ```bash
  node /Users/higataiyu/まさお/bestofn-repo/bin/bon.js serve -d
  # 候補WAVを匿名ラベルで登録 → ブラウザでA/B → 採用записを保存
  ```

## 校正記録（2026-08-28）

- 承認済み実音声9件: CER床0.02〜0.10、UTMOS 2.86〜3.99（1.0秒の短尺のみ2.18）
- 誤判定を2件修正: 漢字/かな未正規化のCER膨張、短尺UTMOSの不当fail
- 既知の限界: UTMOSは感情演技の好みを測れない（cut-02で人間と逆転）。
  プロバイダ購読階層により `wav_44100` が拒否される場合は24kへ自動フォールバック。
