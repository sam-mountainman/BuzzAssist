// asset-backed なファイルの placeholder 判定。
//
// なぜ App.jsx から出したか:
// この判定は3箇所（hydration の要否、flush の要否、dehydrate の書き込み）で
// 使われる。散らばった直接比較のままだと、placeholder を1種類足すたびに
// どこか1箇所が取り残される。実際そうなった——SVG の placeholder を足したとき、
// hydration 側の除外が GIF しか見ておらず、**SVG の placeholder が
// 「取得済み」と判定されて本物が永久に読み込まれなくなった**。
// コンソールエラーは消えたが SVG は透明のまま。エラーを消すために表示を壊していた。
//
// もう一つの理由はテスト。App.jsx は JSX なので node --test から import できず、
// テストが判定ロジックを書き写すことになる。書き写したテストは本体を変えても
// 落ちない——変異を入れても素通りするのを実際に確認した。
// 本体と同じものを import できる形にしないと、検証したことにならない。

/** 本体が取れるまでの間に置く、中身の無い画像。 */
export const CANVAS_ASSET_PLACEHOLDER_DATA_URL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='

/**
 * SVG 用の placeholder。
 * mimeType が image/svg+xml のレコードへ GIF を渡すと、Excalidraw が
 * normalizeSVG で中身を SVG として解析して落ちる。種別に合った中身が要る。
 */
export const CANVAS_ASSET_PLACEHOLDER_SVG_DATA_URL =
  'data:image/svg+xml;base64,'
  + 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiLz4='

const PLACEHOLDERS = new Set([
  CANVAS_ASSET_PLACEHOLDER_DATA_URL,
  CANVAS_ASSET_PLACEHOLDER_SVG_DATA_URL,
])

/** その dataURL が placeholder か。種別を問わず、全ての placeholder を含む。 */
export function isAssetPlaceholderDataURL(dataURL) {
  return typeof dataURL === 'string' && PLACEHOLDERS.has(dataURL)
}

/** その種別に合った placeholder。 */
export function placeholderDataURLFor(file) {
  return String(file?.mimeType || '').toLowerCase().includes('svg')
    ? CANVAS_ASSET_PLACEHOLDER_SVG_DATA_URL
    : CANVAS_ASSET_PLACEHOLDER_DATA_URL
}

/**
 * 本体のバイト列を持っているか（＝もう取りに行かなくてよいか）。
 * placeholder は「持っていない」。パスも「持っていない」。
 */
export function hasRealAssetBytes(dataURL) {
  return typeof dataURL === 'string'
    && dataURL.startsWith('data:')
    && !isAssetPlaceholderDataURL(dataURL)
}
