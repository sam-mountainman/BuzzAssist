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

## 6. 決定（2026-09-18・v1 実装）

5章の未決事項をここで確定し、2.1 と 3、および「images/full は pass レポートを前提にする」
規則を実装した（契約 `koya-manga-production-v53`、必須監査 `wardrobe-readiness`、
実装 `lib/koyaWardrobeReadiness.mjs`）。2.2〜2.4（候補生成・承認パケット・凍結）は v1 の対象外。

1. **場面タグの語彙**: `daily` / `work` / `home` / `formal` / `swim` / `sleep` /
   `winter-out` / `summer-out`。チャンネルパックは show bible の
   `wardrobe.sceneTagVocabulary` で語を足し、`wardrobe.sceneTagKeywords {tag: [語]}` で
   検出語を足せる。コードが既定で持つ検出語は特別な場面の5タグぶんだけで（例:
   プール・海水浴・水着→`swim`、葬儀・通夜・結婚式・式典・パーティー→`formal`、
   パジャマ・寝間着・就寝・布団→`sleep`、雪・吹雪・真冬の屋外→`winter-out`、
   夏祭り・浴衣・花火大会→`summer-out`）、`daily` / `work` / `home` は
   チャンネルパックが検出語を足したときだけ検出される（＝それまではスロットを作らない）。
2. **スロット粒度**: 1場面＝1スロット群。場面は、場面台本形式なら `cut.scene.number`、
   旧形式（カット見出し）なら各カット。場面の属性は見出し（カット目的）とナレーション行
   からだけ取り、台詞本文は見ない（「今度プールに行こう」はプール場面の根拠にならない）。
   同一キャラ×同一タグはエピソード内で1スロットに束ね、カットは `sceneRef` に並べる。
3. **照合対象**: 台帳のチャンネル共通の承認済み人物（`episodeId` を持たない人物。場所・小物は除く）
   のうち、その場面で話す人物と、その場面のナレーションに名前（または別名）が出る人物。
   モブ・今回限りの人物は対象外。
4. **既定衣装**: ベース衣装は show bible `cast[].baseOutfitSceneTags`（既定
   `daily`/`work`/`home`）を覆う。登録済み衣装（`referenceAssets` の `role: "outfit"`）は
   自分の `sceneTags` を覆い、遡及タグ付けは show bible `cast[].outfitStages[].sceneTags`
   でもできる（`storyStage` で対応づける）。タグの無い場面で着る服は
   `cast[].defaultOutfit`（衣装 asset id か storyStage）。選ぶ順は
   defaultOutfit → ベース衣装 → 登録済み衣装（台帳の並び順）で、どれも全タグを覆わなければ
   pending スロットになる。
5. **機械で決められない場合**: v1 は LLM を使わない。1場面で特別なタグが2つ以上出て
   両方を覆う服が無い場合（undecidable）と、運用者が「この場面はこの服で問題ない」と
   判断する場合は、**生成とは別のコンテキスト**が書いた `koya-wardrobe-review-v1` の
   レビュー記録でだけ解決する。記録はスロットごとに判定（`fits` / `does-not-fit`）、
   適合する服、理由を持ち、レビュアー（host / id / contextId）と在庫の `inventoryDigest`
   に結び付ける。生成コンテキスト（エピソードの生成者・ゲート実行者・画像を生成する
   コンテキスト）と同じ contextId のレビューは受け取らない。

### 3 の CLI（確定形）

```bash
node scripts/koya-manga-video.mjs wardrobe-readiness --episode-id <id> \
  [--script-path FILE] [--wardrobe-review-path FILE]
# exit 0: 全場面適合（canvas/assets/<id>/wardrobe-readiness.json に matchedOutfit を記録）
# exit 2: pendingスロットあり（在庫パスを表示。images/full はこの状態では起動しない）
```

- `images` / `full` は、現在の台本（episodeId と scriptDigest 一致）に対する pass レポートが
  無ければ**有料呼び出しの前に**止まる。止まり方は声の人選ゲートと同じで、上位 Job は
  `awaiting-human-review` で待ち、同じ Job を再開できる（終了コード3）。
- 台帳・show bible・検出語が変わってレポートが再現しなくなった場合も、古い pass は使わない。
- 運営者の明示オーバーライドは `--wardrobe-readiness-override-reason TEXT` だけ。理由は在庫と
  エピソード状態（`overrideHistory`）に残り、最終監査の `wardrobe-readiness` が必ず表に出す。
  上位 Job では `node scripts/run-video-harness.mjs start --wardrobe-readiness-override-reason TEXT`。
- ゲート導入（契約 v53）より前に画像を作った回は、制作状態に wardrobe-readiness の記録が
  無いことで見分けて測定対象外にする。宣言側にも `inForceSince` を書いてあるので、
  前の版の契約で合格した回を後から不合格にしない。

## 7. 決定（2026-09-18・v1 修正round）

独立レビューで見つかった3点を直した。いずれも「閉じているはずのゲートが黙って開く」か
「関係の無い出来事で止まる」かのどちらかで、判定規則（6章）そのものは変えていない。

1. **伏せ字は人の名前だけ**: 場面タグの検出前に文から伏せるのは、台帳の人物
   （`kind` が `"character"` か未指定）と台本の登場人物・話者の名前だけにする。
   台帳には場所（`kind: "location"`）と小物（`kind: "prop"`）も入り、場所の名前は
   多くの場合そのまま場面見出しになる。これを伏せていたため、たとえば「市民プール」
   という場所を登録したチャンネルでは、プールの場面が `swim` を失って
   「スロット0件で pass」になっていた（＝有料生成がベース衣装のまま走る）。
   人の名前を伏せる規則は残す（「雪村」が `winter-out` を作らないため）が、
   伏せたせいで消えたキーワードは在庫の `scenes[].maskedKeywordHits` と
   `summary.maskedKeywordHitCount` に残し、CLI も表示する。黙って落とさない。
2. **レポートは「判定」に結び付ける**: 在庫全体の `inventoryDigest` は、承認済みの
   チャンネル共通キャスト全員とその全 reference asset を畳み込むので、この回に
   関係の無い登録（来期のキャストを足す、別人の表情シートを足す）でも変わる。
   画像工程の再確認をこれで行うと、季節を通して台帳へ書き続ける運用では、ただの
   登録作業が Job の停止になっていた。判定を決めた入力だけ（場面とタグと根拠、
   誰がどの服を着るか＝`matchedOutfit` の sha256、スロット、検出規則、台本）を
   畳み込んだ `verdictDigest` を在庫に持たせ、画像工程はこれと「今の入力でも
   pass すること」を見る。衣装が台帳から消えれば `matchedOutfit` が変わり、
   承認が外れれば割り当てが消えるので、ベース衣装のまま進む経路は塞がったまま。
   レビュー記録も `verdictDigest` に結び付けてよい（`inventoryDigest` しか持たない
   記録は今までどおり在庫全体で照合する）。
3. **止め方が再開位置を壊さない**: 照合の拒否は `knownRemainingIssues` を置き換えず
   自分の項目（`wardrobe-readiness-required`）だけを足し、画像を作り終えた回
   （`images-ready` 以降、またはエピソード manifest がある回）では `status` と
   `currentStage` に触れない。画像より前の回では今までどおり
   `awaiting-wardrobe-readiness` へ移すが、中断した位置を
   `wardrobeReadiness.interrupted` に控え、通ったらそこへ戻す。
   また、既にほかの台本が持っている episode id（画像計画の `scriptSha256` が違う）
   では何も書かずに譲る——所有権の誤りは計画が自分の言葉で断るのが正しく、
   有料呼び出しはその手前で止まる。
