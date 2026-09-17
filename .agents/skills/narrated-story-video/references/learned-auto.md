<!-- このファイルは harness-learn が自動で書きます。手で編集しないでください。 -->

# 自動で積み上がった指摘

隣の `SKILL.md` が正本で、**矛盾したときは SKILL.md が優先**します。
ここは運用上の補助指示であって、**監査・承認・合否の証跡には使えません**。
根拠は逐語ではなく sha256 先頭12桁の digest だけを載せます（このファイルは配布物に
同梱されるため）。逐語は `node scripts/harness-learn.mjs status` で id から引けます。

- **台本から完成動画までの制作hot pathへYouTube Analyticsやyt-quality-loopを混ぜない**
  - 根拠digest: `ca2ce297447d`
  - 種別: constraint / 初回: 2026-08-31 / id: `6edb2451ffe2`
- **本番の画像・Fish Audio・ElevenLabs呼び出しは共通の型付きMedia Job BrokerとRunReceiptを必ず経由する**
  - 根拠digest: `3a8eeea0e6e4`
  - 種別: constraint / 初回: 2026-08-31 / id: `079632f77850`
- **既存・手作業起点のナレーション物語動画を監査するとき、完成MP4の品質合格だけでハーネス完成と呼ばない。公式Job一覧、署名済みChannel Pack、RunReceipt、統合generation manifest、Canvas Run、独立音声・字幕成果物を別途実在確認し、欠けていれば動画単体合格と再利用ハーネス完成を明確に分ける。**
  - 根拠digest: `cffd191b18f5`
  - 種別: correction / 初回: 2026-09-01 / id: `145f594ef34e`
- **正本の唯一入口コマンドは実装CLIと同じ引数名を使う。現行run-video-harness.mjsは --harness と --channel-pack のみを読むため、SKILL.md記載の --harness-id / --channel-pack-path をそのまま実行させない。正本・usage・parseArgsを同一テストで拘束する。**
  - 根拠digest: `3b52b2d392cb`
  - 種別: correction / 初回: 2026-09-01 / id: `e778fdfbbc3e`
- **Seedance冒頭に台詞を入れる指定では、台詞を生成プロンプトへ明記し、Seedance映像内の人物自身に日本語で発話・口パク同期させる。生成音声を捨ててFish Audio等のTTSを後載せしてはならない。**
  - 根拠digest: `a68f35671563`
  - 種別: correction / 初回: 2026-09-01 / id: `cb63d77dbaea`
- **Fish AudioのWAV出力はprovider対応sample rateを明示して要求し、現行S2では44.1kHzを取得して親render graphで48kHz masterへresampleする。providerに不可能な48kHz WAVを要求せず、server側で黙って条件を変えない。**
  - 根拠digest: `cb560ae959bc`
  - 種別: fact / 初回: 2026-09-01 / id: `6261ec9acf18`
- **引用台詞を含む場面は、場面全文をナレーター1音声で合成せず、narratorとcharacterのspeaker turnへ分割し、承認済み役別referenceを結び付ける。**
  - 根拠digest: `cf50a0c5996b`
  - 種別: correction / 初回: 2026-09-01 / id: `1e408436698b`
- **字幕表記とTTS読みを分離できる契約にし、表示「開けずに」は保持しつつprovider本文を「ひらけずに」に固定するなど、読み指定を監査manifestへ残す。**
  - 根拠digest: `32cd26f43347`
  - 種別: correction / 初回: 2026-09-01 / id: `554024fe106c`
- **TTSの自然言語スタイル指示はreference依存で本文として発話される場合があるため、CER監査で指示文混入を検出し、混入したtakeだけ指示をspoken payloadから除去して再生成する。**
  - 根拠digest: `82496b4d460c`
  - 種別: fact / 初回: 2026-09-01 / id: `94d77630360e`
- **最終結合は旧既定版へ戻さず、直近で受入済みのreview素材のSHAと版を明示固定し、出力監査でもその入力SHAを再確認する。**
  - 根拠digest: `298448b6ebe3`
  - 種別: correction / 初回: 2026-09-01 / id: `5fc7cb6c8930`

_最終更新: 2026-09-05T17:09:39.198Z_
