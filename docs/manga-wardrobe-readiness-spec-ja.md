# wardrobe-readiness ゲート仕様（草案 v1・2026-08-30）

漫画動画ハーネス（genre: manga-video-production）に追加する、台本駆動の衣装ゲート。
実装はチャンネルの固定キャラベース確定後・最初のエピソード制作前に行う。
背景となる決定と経緯はチャンネルパック側の
`channel-packs/koya/docs/koya-client-reply-2026-08-30.md`（長期ワードローブ設計の節）と
学習提案 `963ccdec443e` にある。

## 0. 原則

- **台本駆動・遅延評価**: ワードローブは台本が実際に要求した服だけで育てる。推測で先作りしない
- **承認は1話1回**: シーンごとの逐次承認はしない。plan段階で全数検出し、1つの承認パケットにまとめる
- **「一瞬だから承認不要」という区分は存在しない**: 漫画動画は1カットを数秒以上ホールドするため、固定キャラの服は必ず視認される（2026-08-30ユーザー訂正）
- **fail-closed**: 未解決の衣装スロットが残っている間は `images` 工程へ進めない
- **例外はモブ・エキストラのみ**（キャラ台帳外の人物）: 従来どおり都度生成

## 1. 用語

| 用語 | 定義 |
|---|---|
| ワードローブ | キャラ台帳（characters.json）の当該キャラに登録された、SHA凍結済み衣装シートの集合 |
| 衣装シート | 承認済みidentity faceだけを人物参照に生成し、原寸QAを通した完全シート（`referenceAssets`に`role:"outfit"`で登録） |
| 衣装スロット | あるエピソードのあるシーンで、登場固定キャラの既存ワードローブに適合する服が無い箇所 |
| 承認パケット | 1エピソード分の全スロットの候補をまとめた匿名比較パケット（blind packet形式） |

## 2. フロー

```
台本 → plan（台本解析・シーン属性抽出）
     → wardrobe-readiness 照合
        ├─ 全シーン適合 → pass（exit 0）→ images へ
        └─ 不適合スロットあり → スロット一覧（exit 2）
            → 一括候補生成（スロットごとに2〜3案）
            → 承認パケット（1話1回）→ 人間が番号選択
            → character-style-select で記録 → シートSHA凍結・台帳登録
            → wardrobe-readiness 再実行 → pass → images へ
```

### 2.1 照合（plan段階）

- 入力: story review／episode plan のシーン属性（場所・状況・時間帯）、character bible の登場人物
- 各シーン×登場固定キャラについて「ワードローブ内のどの衣装が適合するか」を判定する
  - 機械判定できる部分: 衣装シートのメタデータ（`sceneTags`: 例 `daily`, `work`, `home`, `swim`, `formal`, `sleep`, `winter-out`）とシーン属性のタグ照合
  - タグで決まらない場合: LLM判断（別コンテキスト）で適合/不適合を理由つきで判定し、判定はレポートに残す
- 出力（inventory JSON）: スロットの一覧
  ```json
  {
    "episodeId": "manga-xxx-001",
    "generatedAt": "<ISO8601>",
    "scriptDigest": "<sha256>",
    "slots": [
      {
        "slotId": "wardrobe-manga-xxx-001-<castId>-pool",
        "castId": "appare-fixed-cast-character-N",
        "sceneRef": "cut-12〜cut-15",
        "sceneTags": ["swim"],
        "requirement": "プールサイド。ベースのジャージ姿は不適合",
        "matchedOutfit": null,
        "status": "pending"
      }
    ]
  }
  ```
- 同一キャラ×同一場面タグのスロットはエピソード内で1つに束ねる（カット列挙は`sceneRef`に持つ）

### 2.2 一括候補生成

- スロットごとに `character-style-generate` を流用し、styling round idは
  `wardrobe-<episodeId>-<castId>-<slotSlug>` で安定化（再開時に同一roundを再実行）
- 人物参照は**承認済みidentity faceのみ**（比較資料・他候補は渡さない）
- 各スロット2〜3案。案の軸は場面要求の中で明確に分ける（色違いだけの微差テイク禁止）
- 生成物は原寸QA（同一人物性・装飾/ブランド風金具スクリーニング・意図外変更）を別コンテキストで通す
- 並列はcastId単位（`harness-parallel-execution`の既存規則。`images`とは別枠だが
  `character-workflows.json`の規則に従う）

### 2.3 承認パケット（1話1回）

- 全スロットの合格候補を1つのパケットにまとめ、スロット内はA〜Cの匿名ラベル＋SHA-256のみ
- provider・生成順・内部IDのmappingはprivate側へ分離（既存blind packet規則）
- クライアント（または運用者）が「スロット×記号」で選択する

### 2.4 凍結・蓄積

- 選択は `character-style-select` で記録（アリーナ閲覧は記録ではない）
- 採用シートを `referenceAssets` に `role:"outfit"`, `id:"outfit-<slug>"`, `sceneTags:[...]` で登録し、SHA凍結
- 以後のエピソードでは照合段階で `sceneTags` が適合すれば**生成なしで再利用**（無料・完全一致）

## 3. CLI（案）

```bash
node scripts/koya-manga-video.mjs wardrobe-readiness --episode-id <id>
# exit 0: 全シーン適合（inventoryにmatchedOutfitを記録）
# exit 2: pendingスロットあり（inventoryパスを表示。imagesはこの状態では起動拒否）
```

- `images` / `full` は wardrobe-readiness の pass レポート（episodeId・scriptDigest一致）を前提条件に加える
- 台本が変わったら（scriptDigest不一致）照合をやり直す

## 4. 実装時の注意（既存規則との接続）

- 共有状態: `canvas/character-workflows.json`（castId単位並列可）、`canvas/characters.json`
  （registerは1件ずつ）、episodeの`koya-production-state.json`（ロックなし）— 既存の並列規則に従う
- 承認・採用の記録は公式CLIのみ。generatorとreviewerは別コンテキスト必須
- 衣装シートも `character-attribute-gate` の対象（髪色Δ・pHash微差・装飾スクリーニング・意図外変更）
- 契約への組み込み: `config/koya-manga-production-contract.json` に必須監査として追加し、
  スキーマで閉じる（未知キー拒否）
- クライアント自走フェーズでは選択者＝運用者になるため、承認パケットの提示はホスト
  （Claude Code / Codex）のUIで番号選択させる形に寄せる

## 5. 未決事項（実装前に確定する）

1. `sceneTags` の正規語彙（初期セット: daily / work / home / formal / swim / sleep / winter-out / summer-out。チャンネルパック側で拡張可にするか）
2. スロット粒度の最終決定（シーン単位で束ねる方針だが、シーン境界の定義をstory reviewのどのフィールドに置くか）
3. 適合判定LLMのrubricと、判定の証跡形式（既存のquality-harness incident ledgerへの接続有無）
4. エマのように衣装が複数ある場合の既定衣装選択規則（シーンタグ無指定シーンでどれを着るか — show bibleに`defaultOutfit`を持たせる案）
5. ベース衣装のsceneTags初期付与（登録済みキャラへの遡及タグ付け）
