/**
 * MCP の client SDK を読み込む（scripts/verify-plugin-runtime.mjs 用）。
 *
 * このファイルは、依存をつないだ置き場（lib/pluginRuntimeDependencies.mjs の runtimeRoot）の
 * 中にあるものを、ファイルの URL で読み込む。bare specifier はこのファイルの場所から解決される
 * ので、その置き場の node_modules の SDK が使われる。依存の無い置き場で読み込んでも落ちない
 * よう、静的には import しない（呼んだときだけ読む）。
 */
export async function loadMcpClientSdk() {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
  ]);
  return { Client, StdioClientTransport };
}
