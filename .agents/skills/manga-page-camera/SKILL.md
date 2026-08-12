---
name: manga-page-camera
description: 漫画動画ページのカメラ移動を設計・実装・レビュー・監査する。方向移動、引き、方向移動後の引きの3系統、元画像の視点意味、一定速、分割ページ全体の単一カメラを強制する。
---

# 漫画ページカメラ

完成した漫画画像・ページを動かすとき、`manga-video-production`と併用する。詳細な数値契約は`references/camera-contract-ja.md`を読む。

## 必須の3系統

通常の1作品には、意味に合わせて次をすべて混在させる。

1. 方向移動のみ: `left-only`、`right-only`、`top-only`
2. 引きのみ: `pullout-only`
3. 方向移動後に引く: `left-then-pullout`、`right-then-pullout`、`top-then-pullout`

全カットを引きだけにしない。話者交代、視線、空間、証拠、次に見せる対象から選ぶ。

## 元画像と動き

`left`、`right`、`top`は実際に生成した元画像の視点であり、正面絵のクロップ移動で偽装しない。最初に話者か重要物を見せ、必要な顔を画角内へ保つ。

横移動は通常0.22、上移動は0.19程度を基本とし、横0.14未満・上0.12未満は不合格。引きは最低24%広いページ領域を見せる。全区間を線形、先頭・末尾holdなしで動かす。

push-in、下移動、ease、停止、反転、bounce、crop端clamp、同一画像のreset、phase resetは禁止。複合移動の第2段階は、第1段階で到達したfocusを厳密に継承する。

## 場面別の選び方

- 場面開始・場面転換: 広い元画像と引きを基本候補にする
- 感情頂点: 正面close-up
- 一人の台詞: 聞き手視点の正面
- 二人の会話: left/right/frontal/wideを交替し、最初に話者へ到達しつつ両顔を保つ
- top: 証拠の俯瞰や分割ページに限定し、安易な冒頭画にしない
- 一画像で複数の連続吹き出しを読ませてよい。発話ごとに新画像を作らない

## 分割ページ

意味のある同時進行・比較・時間経過だけに使う。各パネルを静止クロップし、黒いガターで組み、吹き出しを合成し、1920×1080の1ページへflattenしてから、7種類の正規modeのいずれかでページ全体を1台のカメラとして動かす。パネル、ガター、吹き出しは一緒に動く。各パネルを別々に動かさない。

## 実装と証拠

`lib/mangaPageCameraGrammar.mjs`の`manga-page-camera-v2`以降を使い、`cameraMode`と`motion`の両方へmodeを保存する。通常shotは`applyMangaCameraGrammarToShot`を使う。

```bash
node scripts/audit-koya-camera-manifest.mjs --manifest-path /absolute/episode-manifest.json
node scripts/audit-koya-rendered-camera.mjs --manifest-path /absolute/episode-manifest.json --video-path /absolute/video.mp4
```

3系統の件数、移動量、reveal量、push-in/down/reset/reversal/hold/repeat/clamp違反0件、分割ページIDと静止パネル証拠、実MP4のoptical-flow測定、全デコードを報告する。
