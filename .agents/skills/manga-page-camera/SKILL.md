---
name: manga-page-camera
description: 漫画動画ページのカメラ移動を設計・実装・レビュー・監査する。方向移動、引き、方向移動後の引きの3系統、元画像の視点意味、一定速、分割ページ全体の単一カメラを強制する。完成した漫画画像やページを動かす、カメラワークを直す、カメラ監査を通すときに必ず読む。
---

# 漫画ページカメラ

完成した漫画画像・ページを動かすとき、`manga-video-production`と併用する。
詳細な数値契約は`references/camera-contract-ja.md`を読む。

このスキルが存在する理由は1つで、**全カットが引きになるのを防ぐこと**にある。
放っておくと引きだけの単調な回になる。3系統を意味で使い分けるのが本体。

## 自動で積み上がった指摘

<!-- LEARNED:BEGIN — この節は harness-learn が自動で書く。手で編集しない -->

_まだ自動反映された項目はありません。_

<!-- LEARNED:END -->

## 必須の3系統

通常の1作品には、意味に合わせて次をすべて混在させる。系統を代用しない。

1. **方向移動のみ**: `left-only`、`right-only`、`top-only`
   - 元画像が実際にその視点（左手／右手／俯瞰）で生成されていること
   - ページのクロップを一定ズームのままその方向へ大きく動かす
   - これは引きではない
2. **引きのみ**: `pullout-only`
   - 最初の重要対象か話者から始め、目に見えて広い構図を現す
   - focus anchorは固定。これは方向移動ではない
3. **方向移動後に引く**: `left-then-pullout`、`right-then-pullout`、`top-then-pullout`
   - 第1段階は一定ズームで指定方向へ動く
   - 第2段階は**第1段階が到達したfocusから厳密に**引き始める
   - 引く前に冒頭のクロップへ戻さない

全カットを引きだけにしない。話者交代、視線、空間、証拠、次に見せる対象から選ぶ。

## 元画像と動き

`left`、`right`、`top`は実際に生成した元画像の視点であり、正面絵のクロップ移動で
偽装しない。正面画像を横にクロップしても左右視点にはならない。
最初に話者か重要物を見せ、必要な顔を画角内へ保つ。方向移動で応答者や次の重要物へ
フレームを渡してよい。modeと元画像の視点は一致していること。

| 項目 | 既定 | 不合格 |
|---|---|---|
| 横移動 | 約0.22（正規化フレーム空間） | 0.14未満 |
| 上移動 | 約0.19 | 0.12未満 |
| 引きのreveal | **最低24%、推奨は約30%** | 24%未満 |
| イージング | `linear`、`motionLeadRatio = 0`、`motionTailRatio = 0` | hold・ease |

カメラは指定区間の全体で動き続ける。終盤で減速・停止・bounce・反転せず、
端に達した後に戻らない。

`push-in`、`zoom-in`、`slow-push`、正のzoom区間、下移動、ease、停止、反転、
bounce、crop端clamp、同一画像のreset、phase resetは禁止。
同じ元画像を冒頭位置から再利用して多段移動を偽装しない。
全キーフレームを合法なクロップ範囲に収め、FFmpegがページ端でclampしないようにする。

## 場面別の選び方

- 場面開始・場面転換: 広い元画像と引きを基本候補にする
- 感情頂点: 正面close-up
- 一人の台詞: 聞き手視点の正面
- 二人の会話: left/right/frontal/wideを交替し、最初に話者へ到達しつつ両顔を保つ
- top: 証拠の俯瞰や分割ページに限定し、安易な冒頭画にしない
- 一画像で複数の連続吹き出しを読ませてよい。発話ごとに新画像を作らない

## 分割ページ

意味のある同時進行・比較・時間経過だけに使う。黒2〜3パネル構成の手順:

1. 各パネルを指定の静止フレーミングにクロップする
2. パネル内のカメラを固定する。パネル内部を個別に動かさない
3. 決定論的に黒いガターを組む
4. 吹き出しとページ上のグラフィックを正確に合成する
5. 1920×1080の完成ページ1枚へflattenする
6. **flatten後のページ全体**に、7種類の正規modeのいずれかを適用する

黒い仕切り・吹き出し・全パネルは1ページとして一緒に動く。
分割ページも方向移動のみ／引きのみ／方向移動後の引きのどれでもよく、
引きを強制されるわけではない。

## 実装と証拠

`lib/mangaPageCameraGrammar.mjs`の`manga-page-camera-v2`以降を正とする。

1. 契約の次のフラグをすべて`true`にする。ここが落ちていると、
   文法違反があってもゲートが素通りする:
   `video.requireSemanticCameraViews` / `video.forbidPushInCameraMotion` /
   `video.requireWholePageSplitCamera` / `video.requireConstantCameraSpeed` /
   `video.forbidCameraStops` / `video.forbidDownwardCameraMotion` /
   `video.forbidRepeatedCameraImages`
2. 正規のmodeを`cameraMode`と`motion`の**両方**へ保存する
3. 通常shotは`applyMangaCameraGrammarToShot`で正規化する
4. 分割ページは`applyMangaCameraGrammarToPanelLayout`で正規化する
5. 監査を回す:

```bash
node scripts/audit-koya-camera-manifest.mjs --manifest-path /absolute/episode-manifest.json
node scripts/audit-koya-rendered-camera.mjs --manifest-path /absolute/episode-manifest.json --video-path /absolute/video.mp4
node --test test/mangaPageCameraGrammar.test.mjs test/mangaVideoPipeline.test.mjs
```

マニフェスト単体を文法・mode面から見るだけなら、このスキル同梱の
`scripts/audit-manifest.mjs <manifest.json> [projectDir]`も使える。

3系統の件数、移動量、reveal量、push-in/down/reset/reversal/hold/repeat/clamp違反
0件、分割ページIDと静止パネル証拠、ページごとにページ級カメラが1台であること、
テスト結果、実MP4のoptical-flow測定、全デコードを報告する。

**次のいずれかが残っているうちは完了と報告しない**: 弱い／誤った方向移動、
隠れzoom、push-in、下移動、phase reset、crop衝突、hold、非線形イージング、
画像の再利用、動く分割パネル、flatten前の分割カメラ。
