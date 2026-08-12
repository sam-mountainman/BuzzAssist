---
name: manga-video-production
description: 幸谷チャンネル向け日本語漫画動画の台本設計、キャラクター、画像、ElevenLabs音声、吹き出し、カメラ、レンダー、修復、実MP4監査を行う。漫画動画を新規制作・変更・レビュー・監査するときは常に使い、旧version固有スクリプトを新作へ流用しない。
---

# 幸谷漫画動画制作

これはClaude CodeとCodexが共用する正本スキルである。作業開始時に本スキルを使うことを伝え、カメラを扱う場合は`../manga-page-camera/SKILL.md`も最後まで読む。

## 最初に読むもの

変更や有料生成の前に次を最後まで読む。

1. `../../../config/koya-manga-production-contract.json` — 実行可能な既定値と必須監査。全項目は隣接するJSON Schemaで閉じ、未知キーや型崩れを許さない
2. `../../../docs/koya-channel-requirements-ledger.md` — ユーザー要求の時系列。矛盾時は、明示されたエピソード例外を除き、後の要求を優先する
3. `../../../config/koya-manga-episode-overrides/<episode-id>.json` — 存在するときだけ読む凍結済み例外
4. `references/quality-contract-ja.md` — セッション横断で一般化した台本・絵・音声・編集品質
5. `references/final-review-ja.md` — 実MP4の知覚レビューと完了判定

JSON契約が実行設定の正本、要求台帳が理由の正本である。コード・本スキル・契約が食い違う場合は制作を止め、同じ変更内で整合させる。

## 唯一の制作入口

新規作品は必ず次だけを使う。

```bash
node scripts/koya-manga-video.mjs <action> ...
```

`scripts/build-manga-video.mjs`の`full`/`speech`、`apply-manga-v*`、`finalize-manga-v*`、`generate-manga-v*`は新規作品へ使用しない。これらは`config/koya-manga-legacy-migrations.json`に隔離されたベンチマーク移行である。

新規制作の基本形:

```bash
node scripts/koya-manga-video.mjs plan --script-path /absolute/script.txt --episode-id manga-<new-id> --protagonist-speaker-id <話者IDまたは完全一致名>
node scripts/koya-manga-video.mjs full --script-path /absolute/script.txt --episode-id manga-<new-id> --protagonist-speaker-id <話者IDまたは完全一致名>
```

`full`は再開可能である。終了コード2または3は完成ではない。`koya-production-state.json`を読み、承認待ち・利用上限・失敗箇所から、合格済み成果を再生成せず再開する。

## 制作手順

1. 台本を省略・要約せず解析し、時系列、人物、読み、感情曲線、発話、画面上の証拠を固定する。
2. 有料生成前に主人公を一意に決め、`--protagonist-speaker-id`を渡す。複数候補なら推測せず停止する。
3. 年齢段階、顔、髪、体格、服、色、装飾、感情域、禁止差分を持つキャラクターバイブルを作る。新キャラクターは候補承認まで停止する。
4. 発話ごとの意味から構図を設計する。カット見出しだけを全発話へ誤適用しない。人物、背景、証拠、吹き出し余白を同時に設計する。
5. 独立画像jobを適応並列で生成し、技術・意味QAを行う。合格済みhashを再利用し、不合格だけを修正する。利用上限ではcheckpointを書いて停止する。
6. 承認済み日本語ネイティブ音声を人物ごとに固定する。新規作品の四角いナレーション枠は視覚様式を保ち、音声は主人公の承認済みVoice ID/Profile/設定/モデルと完全一致させる。専用ナレーターを作らない。
7. ElevenLabs `eleven_v3`のカット単位text-to-dialogue-with-timestampsで最低2テイクを作り、完全性と自然さで選ぶ。BGM・環境音・信号処理は使わない。
8. 実素材上で顔・手・小道具・重要証拠を測り、吹き出しを配置する。画像変更後は同じ変更内で注釈を再計測する。
9. `manga-page-camera`の3系統を意味に合わせて混在させ、レンダーする。
10. 実MP4から全必須監査と知覚レビューを行う。不合格なら該当範囲だけ修復し、最終監査をやり直す。

## 絶対条件

- 表示文は縦書き明朝、通常ウェイト、最大3列、自然な文節改行、末尾`。`なし。長文は意味の切れ目で分割し、同時表示せず1個ずつ切り替える。
- 表示中の話者の顔・頭と吹き出しの重なりは、カメラ移動中を含め0px。配置座標と最終監査の顔検出を共有しない。
- 思考場面の暗部と顔中心の明部は、カメラ前の元ページへ焼き込む。
- 人体、手、指、小道具、遠近、服装段階、人物同一性、背景密度、疑似文字を目視する。機械合格で代用しない。
- 一つの画像に複数発話を自然に保持できる場合、発話ごとに画像を乱造しない。場面転換と因果が読める編集連続性を優先する。
- 承認済み発話WAVを、画像・吹き出し・カメラ修正のついでに再生成しない。
- ユーザーの実聴・目視指摘は機械監査より上位。同型不具合を既知のまま再提出しない。

## 最終監査

```bash
node scripts/koya-manga-video.mjs audit --episode-id <episode-id>
```

監査で作った実MP4由来contact sheet、代表フレーム、音声区間、全編MP4を実際に確認し、`references/final-review-ja.md`の形式でレビュー記録JSONを作る。契約digest、実MP4/contact sheet/代表フレームのSHA-256、全編確認範囲、冒頭・中盤・終端の音声確認範囲を実値で記録した後だけ署名する。

```bash
node scripts/koya-manga-video.mjs signoff --episode-id <episode-id> --reviewer claude --review-notes-path /absolute/review.json --pass
# または --reviewer codex
node scripts/koya-manga-video.mjs audit --episode-id <episode-id>
```

完了は、契約の完了status、全必須監査PASS、`knownRemainingIssues=[]`、実MP4の全デコード、MP4 hashに結び付いたClaude/Codex署名がすべて揃ったときだけ宣言する。報告には絶対MP4パス、尺、解像度、fps、容量、主要監査、残課題0件を含める。
