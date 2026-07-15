import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { getViewportConstrainedMenuShift } from '../lib/menuPlacement.mjs'

test('menu placement pulls every overflowing edge back into the viewport gutter', () => {
  const viewport = { width: 842, height: 833, offsetLeft: 0, offsetTop: 0 }

  assert.deepEqual(
    getViewportConstrainedMenuShift(
      { left: 700, top: 700, right: 920, bottom: 980, width: 220, height: 280 },
      viewport,
      16
    ),
    { shiftX: -94, shiftY: -163, availableWidth: 810, availableHeight: 801 }
  )

  assert.deepEqual(
    getViewportConstrainedMenuShift(
      { left: -40, top: -30, right: 180, bottom: 250, width: 220, height: 280 },
      viewport,
      24
    ),
    { shiftX: 64, shiftY: 54, availableWidth: 794, availableHeight: 785 }
  )
})

test('generator menus scroll inside the viewport without hiding utility attachments', async () => {
  const appSource = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')

  assert.match(appSource, /getViewportConstrainedMenuShift\(menu\.getBoundingClientRect\(\), viewport, gutter\)/)
  assert.match(css, /\.lovart-menu\[data-lovart-menu\][\s\S]*?max-height: var\(--lovart-menu-max-height[\s\S]*?overflow-y: auto/)
  assert.doesNotMatch(css, /\.lovart-panel-close/)
  assert.doesNotMatch(appSource, /menu-over-tray/)
  assert.doesNotMatch(css, /\.lovart-utility-panel\.menu-over-tray[\s\S]*?opacity:\s*0/)
})
