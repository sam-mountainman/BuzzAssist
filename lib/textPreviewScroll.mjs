const WIDE_CHARACTER_PATTERN = /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/

export function getTextPreviewLineColumns(line, tabSize = 4) {
  const safeTabSize = Math.max(1, Number(tabSize) || 4)
  let columns = 0
  for (const character of String(line ?? '')) {
    if (character === '\t') {
      columns += safeTabSize - (columns % safeTabSize)
      continue
    }
    columns += WIDE_CHARACTER_PATTERN.test(character) ? 2 : 1
  }
  return columns
}

export function getTextPreviewMaxColumns(lines, tabSize = 4) {
  if (!Array.isArray(lines) || lines.length === 0) return 0
  return lines.reduce(
    (maximum, line) => Math.max(maximum, getTextPreviewLineColumns(line, tabSize)),
    0
  )
}

export function normalizeTextPreviewScrollOffset(value) {
  if (typeof value === 'number') {
    return { x: 0, y: Number.isFinite(value) ? Math.max(0, value) : 0 }
  }
  return {
    x: Number.isFinite(Number(value?.x)) ? Math.max(0, Number(value.x)) : 0,
    y: Number.isFinite(Number(value?.y)) ? Math.max(0, Number(value.y)) : 0
  }
}
