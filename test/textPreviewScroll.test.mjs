import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  getTextPreviewLineColumns,
  getTextPreviewMaxColumns,
  normalizeTextPreviewScrollOffset
} from '../lib/textPreviewScroll.mjs'

test('text preview width accounts for tabs and full-width characters', () => {
  assert.equal(getTextPreviewLineColumns('ab\tcd'), 6)
  assert.equal(getTextPreviewLineColumns('字幕'), 4)
  assert.equal(getTextPreviewMaxColumns(['short', '<path>長い</path>']), 17)
})

test('legacy vertical offsets normalize to two-dimensional scroll positions', () => {
  assert.deepEqual(normalizeTextPreviewScrollOffset(42), { x: 0, y: 42 })
  assert.deepEqual(normalizeTextPreviewScrollOffset({ x: 18, y: 7 }), { x: 18, y: 7 })
  assert.deepEqual(normalizeTextPreviewScrollOffset({ x: -2, y: Number.NaN }), { x: 0, y: 0 })
})

test('SRT and XML canvas previews expose independent horizontal and vertical scrolling', async () => {
  const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const start = source.indexOf('function SubtitleCanvasOverlay')
  const end = source.indexOf('function VideoCanvasOverlay', start)
  const renderer = source.slice(start, end)
  const wheelStart = source.indexOf('// Wheel over an SRT/XML result card')
  const wheelEnd = source.indexOf('if (!initialScene)', wheelStart)
  const wheelHandler = source.slice(wheelStart, wheelEnd)

  assert.match(renderer, /overflowY: 'scroll'/)
  assert.match(renderer, /overflowX: 'scroll'/)
  assert.match(renderer, /el\.scrollTop = safeScrollTop/)
  assert.match(renderer, /el\.scrollLeft = safeScrollLeft/)
  assert.match(renderer, /pointerEvents: overlay\.isSelected \? 'auto' : 'none'/)
  assert.match(renderer, /onPointerMove=/)
  assert.match(renderer, /rect\.bottom - event\.clientY <= edgeThreshold/)
  assert.match(renderer, /rect\.right - event\.clientX <= edgeThreshold/)
  assert.match(renderer, /show-horizontal-scrollbar/)
  assert.match(renderer, /show-vertical-scrollbar/)
  assert.match(renderer, /scrollingScrollbarAxis/)
  assert.match(renderer, /previousVisibleScrollOffsetRef/)
  assert.match(renderer, /keepScrollbarsVisible\(activeAxis\)/)
  assert.match(renderer, /keepScrollbarsVisible\(`\$\{movedHorizontally/)
  assert.match(renderer, /window\.setTimeout\(\(\) => \{\s*setScrollingScrollbarAxis\(''\)/)
  assert.match(renderer, /data-scrollbar-axis="vertical"/)
  assert.match(renderer, /data-scrollbar-axis="horizontal"/)
  assert.match(renderer, /emphasizeVerticalScrollbar/)
  assert.match(renderer, /emphasizeHorizontalScrollbar/)
  assert.match(renderer, /beginScrollbarDrag/)
  assert.match(renderer, /moveScrollbarDrag/)
  assert.match(renderer, /setPointerCapture/)
  assert.match(renderer, /applyScrollbarOffset/)
  assert.match(renderer, /verticalThumbTop/)
  assert.match(renderer, /horizontalThumbLeft/)
  assert.match(renderer, /onScrollOffsetChange\(next\)/)
  assert.match(renderer, /position: 'sticky'/)
  assert.match(wheelHandler, /event\.deltaX/)
  assert.match(wheelHandler, /event\.deltaY/)
  assert.match(wheelHandler, /maxScrollX/)
  assert.match(wheelHandler, /maxScrollY/)
})

test('text preview scrollbars remain visible and draggable without selecting the card', async () => {
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')

  assert.match(styles, /lovart-subtitle-preview-scroll::?-webkit-scrollbar-thumb[\s\S]*background-color: transparent/)
  assert.match(styles, /show-vertical-scrollbar::?-webkit-scrollbar-track/)
  assert.match(styles, /show-horizontal-scrollbar::?-webkit-scrollbar-track/)
  assert.match(styles, /show-vertical-scrollbar::?-webkit-scrollbar-thumb/)
  assert.match(styles, /show-horizontal-scrollbar::?-webkit-scrollbar-thumb/)
  assert.doesNotMatch(styles, /scrollbar-thumb:vertical|scrollbar-thumb:horizontal/)
  assert.match(styles, /\.lovart-subtitle-preview-scrollbar\.is-vertical/)
  assert.match(styles, /\.lovart-subtitle-preview-scrollbar\.is-horizontal/)
  assert.match(styles, /\.lovart-subtitle-preview-scrollbar-thumb/)
  assert.match(styles, /\.lovart-subtitle-preview-scrollbar\.is-active/)
  assert.match(styles, /pointer-events: auto/)
  assert.match(styles, /width: 14px/)
  assert.match(styles, /height: 14px/)
})
