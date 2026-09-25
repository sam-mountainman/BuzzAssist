// 画の寸法を見出しだけから読む（PNG / JPEG / WebP の VP8X / SVG）。
//
// 外部パッケージに依存しないモジュールに置く。lib/canvasScene.mjs は fractional-indexing を
// 静的に読むので、配布物の実行系（依存を入れる前でも読み込めること、test/runtimeDependencies.test.mjs）
// からは直接 import できない。寸法の読み方はここの1か所で、lib/canvasScene.mjs は再公開するだけ。

export function getImageDimensionsFromBuffer(buffer, label = "image") {
  if (buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const size = buffer.readUInt16BE(offset + 2);
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + size;
    }
  }
  if (buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      };
    }
  }
  const svgHeader = buffer.toString("utf8", 0, Math.min(buffer.length, 8192)).replace(/^\uFEFF/, "");
  if (/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(svgHeader)) {
    const widthMatch = /\bwidth=["']\s*([0-9]+(?:\.[0-9]+)?)/i.exec(svgHeader);
    const heightMatch = /\bheight=["']\s*([0-9]+(?:\.[0-9]+)?)/i.exec(svgHeader);
    if (widthMatch && heightMatch) {
      return { width: Math.max(1, Math.round(Number(widthMatch[1]))), height: Math.max(1, Math.round(Number(heightMatch[1]))) };
    }
    const viewBoxMatch = /\bviewBox=["']\s*[-+0-9.eE]+[\s,]+[-+0-9.eE]+[\s,]+([0-9]+(?:\.[0-9]+)?)[\s,]+([0-9]+(?:\.[0-9]+)?)/i.exec(svgHeader);
    if (viewBoxMatch) {
      return { width: Math.max(1, Math.round(Number(viewBoxMatch[1]))), height: Math.max(1, Math.round(Number(viewBoxMatch[2]))) };
    }
  }
  throw new Error(`Could not read image dimensions for ${label}. Pass displayWidth/displayHeight and use a PNG/JPEG/WebP/SVG source.`);
}
