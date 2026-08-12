# カメラ数値契約

## 正規modeと変換

| 系統 | mode | 変換 |
| --- | --- | --- |
| 方向のみ | `left-only` / `right-only` / `top-only` | zoom一定、単軸を十分移動 |
| 引きのみ | `pullout-only` | focus固定、zoom減少 |
| 方向後に引き | `left-then-pullout` / `right-then-pullout` / `top-then-pullout` | 到達focusを保って引く |

共通: `linear`、lead/tail比0、downなし、push-inなし、反転なし、全keyframeが合法crop内。

方向のみ: `zoomStart == zoomEnd`。leftは`focusXEnd < focusX`、rightは逆、topは`focusYEnd < focusY`。横移動0.14以上、上移動0.12以上、交差軸driftなし。

引きのみ: `zoomStart > zoomEnd`、focus不変、reveal 24%以上。

複合: K0=開始対象、K1=方向移動の到達点、K2=同じ到達点で広いzoom。`K1.focus == K2.focus`が必須。K0へ戻すphase resetは禁止。

| 強度 | 横 | 上 |
| --- | ---: | ---: |
| 例外的に弱い | 0.14 | 0.12 |
| 標準 | 0.18 | 0.16 |
| 強い既定 | 0.22 | 0.19 |

cropが許す最も強い安全な移動を選び、rendererのclamp壁へ当てない。

## 分割ページ

`静止panel crop → 決定論的な黒gutter → 吹き出し合成 → 完成ページflatten → 正規modeのページcamera 1台`の順を守る。

必須metadataは`composition=post-composite-then-flatten`、`motionPolicy=whole-page`、`flattenBeforeCamera=true`、`panelCamera=static`、`pageCameraMode`と`pageMotion`の一致。全panel transformの開始・終了zoom/focusは同一である。

## 例外と不合格

静止を許すのは、場所を持たないeditorial plateで`motion:none`、`characterPolicy:strictly-none`、`environmentPolicy:none`の場合だけ。

引きだけへの縮退、方向shotのzoom変化、引きshotのfocus移動、同時複合、phase reset、弱すぎる移動、down、push-in、ease、停止、反転、clamp、視点とmodeの不一致、flatten前のcamera、panel別cameraは不合格。
