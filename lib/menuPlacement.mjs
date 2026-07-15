function finite(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function getViewportConstrainedMenuShift(rect = {}, viewport = {}, gutter = 16) {
  const safeGutter = Math.max(0, finite(gutter, 16))
  const viewportLeft = finite(viewport.offsetLeft)
  const viewportTop = finite(viewport.offsetTop)
  const viewportWidth = Math.max(0, finite(viewport.width))
  const viewportHeight = Math.max(0, finite(viewport.height))
  const minLeft = viewportLeft + safeGutter
  const minTop = viewportTop + safeGutter
  const maxRight = viewportLeft + viewportWidth - safeGutter
  const maxBottom = viewportTop + viewportHeight - safeGutter

  const left = finite(rect.left)
  const top = finite(rect.top)
  const right = finite(rect.right, left + Math.max(0, finite(rect.width)))
  const bottom = finite(rect.bottom, top + Math.max(0, finite(rect.height)))

  let shiftX = 0
  if (viewportWidth > 0) {
    if (right > maxRight) shiftX = maxRight - right
    if (left + shiftX < minLeft) shiftX += minLeft - (left + shiftX)
  }

  let shiftY = 0
  if (viewportHeight > 0) {
    if (bottom > maxBottom) shiftY = maxBottom - bottom
    if (top + shiftY < minTop) shiftY += minTop - (top + shiftY)
  }

  return {
    shiftX,
    shiftY,
    availableWidth: Math.max(120, viewportWidth - safeGutter * 2),
    availableHeight: Math.max(160, viewportHeight - safeGutter * 2)
  }
}
