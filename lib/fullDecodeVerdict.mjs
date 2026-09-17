/**
 * `ffmpeg -v error -xerror -i <video> -f null -` による全デコードの判定。
 *
 * 終了コードだけでは足りない。デコーダーが壊れた部分を補って（concealing）
 * 成功を返すと、-xerror を付けても 0 で終わる版がある——Ubuntu の ffmpeg 6.1 では、
 * 真ん中を壊した動画がこれで全デコードを通った。-v error で何かが報告されたら、
 * それはデコードの誤りとして落とす（健全な実動画では、この出力は空だった）。
 *
 * @param {{ error?: unknown, stderr?: string }} result 実行が失敗したときの error か、成功したときの stderr
 * @returns {{ pass: boolean, detail: string }}
 */
export function fullDecodeVerdict({ error = null, stderr = "" } = {}) {
  if (error) {
    return { pass: false, detail: String(error?.stderr || error?.message || error).slice(0, 500) };
  }
  const reported = String(stderr || "").trim();
  return reported ? { pass: false, detail: reported.slice(0, 500) } : { pass: true, detail: "" };
}
