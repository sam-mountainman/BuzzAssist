# キャラクター工程 品質ゲート ランブック

候補生成から設定画（三面図・表情シート）までの、機械ゲートと人間判断の運用手順。
根拠は台帳 R187〜R193、R196、R198〜R200。

## パイプライン全体

```
候補/修正の生成 → ①属性ゲート（決定論） → ②人間の目視 → ③承認登録
                        ↑                         ↓
                    ④repair-plan ←──── 不合格の指摘
```

機械で測れるものを先に落とし、人間には「機械が測れないもの」だけを見せる。
逆順にすると、今日の事故（紋章の混入・ネックレスの湧き・髪色ドリフト・
目の左右反転）のように、人間の目視が唯一の防衛線になって取りこぼす。

## ① 属性ゲート

```bash
node scripts/koya-manga-video.mjs character-attribute-gate \
  --inventory-path canvas/attribute-gates/<cast>-<round>.json
```

inventory の書き方:

```json
{
  "castId": "horo",
  "reference": "canvas/assets/.../approved-base.png",
  "assets": [
    {
      "id": "turnaround-front",
      "file": "canvas/assets/.../new.png",
      "base": "canvas/assets/.../previous.png",
      "allowedRegions": [[0.0, 0.15, 0.30, 0.60]],
      "cleanReference": "canvas/assets/.../no-ornament.png"
    }
  ],
  "humanGates": [
    { "id": "attribute-eye-side-fullview-human", "status": "pass", "reviewer": "taiyu" }
  ]
}
```

- `reference` … 髪色の基準（承認済みの色）。無いと「省略」ではなく**欠落として不合格**
- `base` … 修正前の画像。指定領域外が変わっていないかを見る
- `allowedRegions` … 今回変えてよい範囲。ここ以外の変化は意図外変更として落とす
- `cleanReference` … 装飾のない同キャラ画像。金色装飾の相対比較に使う
- `humanGates` … 目の左右など機械が判定できないもの。**reviewer名が必須**

測っているもの（すべて2026-08-27の実資産で校正）:

| ゲート | 内容 | 閾値 |
|---|---|---|
| hairColorDelta | 平均Lab距離 | warn 3.5 / fail 8.0 |
| duplicateTakes | 正面頭部16×16 pHash | fail ≤36 / warn ≤44 |
| unintendedChange | 許可領域外ブロックのLabΔ | 変化ブロック率 >2% でfail |
| neckOrnament | 金色画素の基準画像比 | warn のみ（明色地は検出限界） |
| wd14Tags | 八重歯・装飾等のMLタグ | 用途ごとに指定 |
| 目の左右 | 人間の目視 | reviewerアテステーション必須 |

**被覆はasset単位**。ある画像のチェックが別の画像の未実施を肩代わりすることはない。
1件でも欠ければ `missingCoverage` に出て不合格になる。

## ② 人間の目視

機械を通ったものだけを見る。見るべきは「機械が測れないもの」に限る:

- 顔が別人になっていないか（キャラの同一性）
- 表情・演技が意図どおりか
- 運営者の要望との適合（雰囲気・キャラらしさ）

匿名で比較したいときは公式パケットのビューアを使う:

```bash
node scripts/koya-open-blind-arena.mjs --public <judge-packet.json>
node /Users/higataiyu/まさお/bestofn-repo/bin/bon.js serve -d --open
```

**アリーナは閲覧用**。採用の記録は公式CLI（`character-approve` /
`character-style-select` に `--selection-reason`）に残す。二重帳簿を作らない。

## ③ 承認登録

人間が選んだ個別assetだけを正式工程へ渡す。比較資料そのものは台帳へ登録しない。

## ④ repair-plan（不合格時）

やり直しは「直して」ではなく、機械が検証できる計画を作ってから始める:

```js
createCharacterRepairPlan({
  contract, state,
  entries: [{
    cellId: "turnaround-front",
    findingId: "front-hair-drift",     // 同一セルに複数の所見を持てる
    issue: "髪色が承認色より明るい",
    repairRegion: [0.5, 0.0, 0.5, 0.5],  // 次ラウンドのallowedRegionsになる
    acceptCriteria: ["hairColorDelta < 3.5 vs 承認基準"],
    rejectCriteria: ["顔領域の変化"],
  }],
})
```

- 修正ROIが次ラウンドの許可領域になり、**それ以外の変化はhard gateで落ちる**
- image/base の対応が欠けたエントリはその場で停止する（黙って監査対象から
  外れると、直したはずのセルが検証されない）
- 前ラウンドのfailure fingerprintに拘束されるので、何を直すのかが空欄にならない

## 生成の実務メモ

- 修正生成は `scripts/koya-generate-revision.mjs --jobs <jobs.json>` を使う。
  プロンプト・参照SHA・出力SHA・実使用モデルがマニフェストに残る
- 資料PDFは `scripts/build-koya-candidate-pdf.py <spec.json>`。
  タイトルや注記は生成後に決定論で焼くこと（画像モデルに文字を描かせない）
- 左右の修正は「その部分だけ入れ替えて」では通らない。
  **シート全体／ビュー単位の反転として描き直しを依頼**する（R188）
- 微差テイクを並べない。シルエット・質感・長さで一目で違うものだけ残す（R190）

## 実行系

`KOYA_GATE_PYTHON`（既定 `/usr/bin/python3`）。cv2 / numpy / onnxruntime が
入った実行系を明示する。`python3` の解決先は対話シェルとNode子プロセスで
異なることがあり、依存の無い方を引くとゲートが黙って無効になる（R199）。
