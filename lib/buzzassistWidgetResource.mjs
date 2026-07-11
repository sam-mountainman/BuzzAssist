import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

const require = createRequire(import.meta.url);
let cachedMcpAppsScript = "";
let cachedStaticWidgetHtml = "";

export const BUZZASSIST_WIDGET_URI = "ui://widget/buzzassist/canvas-inline.html";
export const BUZZASSIST_WIDGET_MIME_TYPE = RESOURCE_MIME_TYPE;

export function buzzAssistWidgetResourceMetadata({
  title = "BuzzAssist Canvas",
  description = "Experimental MCP Apps widget for the project-local BuzzAssist canvas. Use the local canvas URL for normal Codex and Claude Code work.",
} = {}) {
  return {
    title,
    description,
    mimeType: BUZZASSIST_WIDGET_MIME_TYPE,
    _meta: {
      ui: {
        prefersBorder: false,
        csp: {
          connectDomains: ["http://127.0.0.1:*", "http://localhost:*"],
          resourceDomains: ["data:", "blob:", "http://127.0.0.1:*", "http://localhost:*"],
          frameDomains: ["http://127.0.0.1:*", "http://localhost:*"],
        },
      },
      "openai/widgetDescription": description,
      "openai/widgetPrefersBorder": false,
      "openai/widgetCSP": {
        connect_domains: ["http://127.0.0.1:*", "http://localhost:*"],
        resource_domains: ["data:", "blob:", "http://127.0.0.1:*", "http://localhost:*"],
      },
    },
  };
}

export function createBuzzAssistWidgetHtml({ version = "0.1.6" } = {}) {
  if (/^(1|true|yes)$/i.test(String(process.env.BUZZASSIST_WIDGET_LAUNCHER || ""))) {
    return createBuzzAssistWidgetLauncherHtml({ version });
  }
  return createBuzzAssistStaticCanvasWidgetHtml({ version });
}

function createBuzzAssistWidgetLauncherHtml({ version = "0.1.6" } = {}) {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>BuzzAssist Canvas</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: Canvas;
      color: CanvasText;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at top left, rgba(255, 106, 77, 0.10), transparent 36rem),
        Canvas;
    }
    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    header {
      padding: 16px 18px 12px;
      border-bottom: 1px solid color-mix(in oklab, CanvasText 12%, transparent);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .brand {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    h1 {
      margin: 0;
      font-size: 18px;
      line-height: 1.2;
      font-weight: 720;
      letter-spacing: 0;
    }
    .subtitle {
      font-size: 12px;
      color: color-mix(in oklab, CanvasText 62%, transparent);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status {
      font-size: 12px;
      color: color-mix(in oklab, CanvasText 68%, transparent);
      padding: 6px 9px;
      border: 1px solid color-mix(in oklab, CanvasText 12%, transparent);
      border-radius: 999px;
      background: color-mix(in oklab, Canvas 92%, CanvasText 8%);
      white-space: nowrap;
    }
    main {
      position: relative;
      min-height: 0;
      overflow: hidden;
      background: Canvas;
    }
    iframe {
      width: 100%;
      height: 100%;
      min-height: calc(100vh - 61px);
      border: 0;
      display: block;
      background: Canvas;
    }
    .emptyState {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      text-align: center;
      color: color-mix(in oklab, CanvasText 66%, transparent);
      background: Canvas;
    }
    .emptyState strong {
      color: CanvasText;
      display: block;
      font-size: 16px;
      margin-bottom: 6px;
    }
    .side {
      position: absolute;
      right: 14px;
      top: 14px;
      width: min(360px, calc(100vw - 28px));
      max-height: calc(100vh - 90px);
      overflow: auto;
      padding: 12px;
      display: none;
      flex-direction: column;
      gap: 12px;
      min-height: 0;
      z-index: 10;
    }
    .panel {
      border: 1px solid color-mix(in oklab, CanvasText 12%, transparent);
      border-radius: 10px;
      background: color-mix(in oklab, Canvas 94%, CanvasText 6%);
      box-shadow: 0 12px 40px rgba(0,0,0,0.08);
      min-width: 0;
    }
    .side.is-open {
      display: flex;
    }
    .floatingActions {
      position: absolute;
      left: 14px;
      bottom: 14px;
      display: flex;
      gap: 8px;
      z-index: 11;
    }
    .sectionTitle {
      margin: 0 0 8px;
      font-size: 12px;
      font-weight: 700;
      color: color-mix(in oklab, CanvasText 74%, transparent);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    label {
      font-size: 12px;
      color: color-mix(in oklab, CanvasText 70%, transparent);
    }
    textarea {
      width: 100%;
      min-height: 126px;
      resize: vertical;
      border: 1px solid color-mix(in oklab, CanvasText 14%, transparent);
      border-radius: 8px;
      padding: 10px;
      font: inherit;
      line-height: 1.45;
      color: CanvasText;
      background: Canvas;
    }
    .row {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    button {
      appearance: none;
      border: 1px solid color-mix(in oklab, CanvasText 14%, transparent);
      background: Canvas;
      color: CanvasText;
      border-radius: 8px;
      padding: 8px 11px;
      font: inherit;
      font-weight: 650;
      font-size: 13px;
      cursor: pointer;
    }
    button.primary {
      background: #ff6a4d;
      border-color: #ff6a4d;
      color: white;
    }
    button.icon {
      width: 40px;
      height: 40px;
      padding: 0;
      display: grid;
      place-items: center;
      border-radius: 10px;
      background: color-mix(in oklab, Canvas 94%, CanvasText 6%);
      box-shadow: 0 8px 28px rgba(0,0,0,0.12);
    }
    button:disabled {
      opacity: 0.52;
      cursor: not-allowed;
    }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      word-break: break-all;
      color: color-mix(in oklab, CanvasText 72%, transparent);
    }
    .notice {
      border-radius: 8px;
      padding: 9px 10px;
      background: color-mix(in oklab, #ff6a4d 10%, Canvas);
      color: color-mix(in oklab, CanvasText 82%, transparent);
      font-size: 12px;
      line-height: 1.45;
    }
    @media (max-width: 780px) {
      .side {
        left: 10px;
        right: 10px;
        top: auto;
        bottom: 64px;
        width: auto;
        max-height: min(420px, calc(100vh - 120px));
      }
    }
  </style>
  <script id="buzzassistMcpAppsBundle">${escapeInlineScript(mcpAppsGlobalScript())}</script>
</head>
<body>
  <div class="shell">
    <header>
      <div class="brand">
        <h1>BuzzAssist Canvas</h1>
        <div class="subtitle" id="projectText">プロジェクトを読み込み中</div>
      </div>
      <div class="status" id="bridgeStatus">接続中</div>
    </header>
    <main>
      <iframe id="canvasFrame" title="BuzzAssist Canvas" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups"></iframe>
      <div class="emptyState" id="emptyState">
        <div>
          <strong>BuzzAssist Canvas</strong>
          <div>ローカルCanvasを読み込み中です。</div>
        </div>
      </div>
      <div class="floatingActions">
        <button class="icon" id="togglePanelButton" type="button" title="チャットへ送る">↗</button>
        <button class="icon" id="openCanvasButton" type="button" title="Canvasを別で開く">□</button>
      </div>
      <aside class="panel side">
        <section>
          <p class="sectionTitle">AIエージェントへ送る</p>
          <div class="field">
            <label for="followUpText">依頼内容</label>
            <textarea id="followUpText" placeholder="例: 選択中の画像をもっと明るくして、生成結果を右に置いて"></textarea>
          </div>
          <div class="row" style="margin-top: 8px">
            <button class="primary" id="sendFollowUpButton" type="button">チャットへ送る</button>
            <button id="sendSelectionButton" type="button">選択素材も読む</button>
          </div>
        </section>
        <section>
          <p class="sectionTitle">スマホ</p>
          <div class="row">
            <button id="startTunnelButton" type="button">スマホURLを作る</button>
            <button id="checkTunnelButton" type="button">状態確認</button>
          </div>
          <div class="mono" id="tunnelText" style="margin-top: 8px">Tunnel: -</div>
        </section>
        <div class="notice" id="messageText">
          このwidget入口は実験用です。CodexとClaude Codeの通常作業では、ローカルCanvas URLとMCP toolsを使います。
        </div>
        <div class="mono" id="canvasUrlText">Canvas URL: -</div>
      </aside>
    </main>
  </div>
  <script>
  (() => {
    "use strict";

    const apps = globalThis.__BUZZASSIST_MCP_APPS__;
    const state = {
      app: null,
      connected: false,
      payload: {},
      hostCapabilities: null,
    };
    const api = window.buzzassistMcp || {};
    window.buzzassistMcp = api;

    const els = {
      bridgeStatus: document.getElementById("bridgeStatus"),
      projectText: document.getElementById("projectText"),
      canvasUrlText: document.getElementById("canvasUrlText"),
      canvasFrame: document.getElementById("canvasFrame"),
      emptyState: document.getElementById("emptyState"),
      side: document.querySelector(".side"),
      tunnelText: document.getElementById("tunnelText"),
      messageText: document.getElementById("messageText"),
      followUpText: document.getElementById("followUpText"),
      togglePanelButton: document.getElementById("togglePanelButton"),
      openCanvasButton: document.getElementById("openCanvasButton"),
      sendFollowUpButton: document.getElementById("sendFollowUpButton"),
      sendSelectionButton: document.getElementById("sendSelectionButton"),
      startTunnelButton: document.getElementById("startTunnelButton"),
      checkTunnelButton: document.getElementById("checkTunnelButton"),
    };

    function setMessage(message) {
      els.messageText.textContent = message;
    }

    function urlFromPayload() {
      return state.payload?.canvasUrl || state.payload?.localCanvasUrl || "";
    }

    function projectFromPayload() {
      return state.payload?.projectDir || "";
    }

    function updateUi() {
      const canvasUrl = urlFromPayload();
      const tunnelUrl = state.payload?.tunnel?.accessUrl || state.payload?.tunnel?.publicUrl || state.payload?.tunnelUrl || "";
      els.bridgeStatus.textContent = state.connected ? "bridge接続済み" : "bridge未接続";
      els.projectText.textContent = projectFromPayload() || "プロジェクト未指定";
      els.canvasUrlText.textContent = \`Canvas URL: \${canvasUrl || "-"}\`;
      els.tunnelText.textContent = \`Tunnel: \${tunnelUrl || "-"}\`;
      const frameUrl = canvasUrl ? canvasUrl + "/?_host=widget" : "";
      if (frameUrl && els.canvasFrame.src !== frameUrl) {
        els.canvasFrame.src = frameUrl;
      }
      els.emptyState.style.display = canvasUrl ? "none" : "grid";
      els.openCanvasButton.disabled = !canvasUrl;
      els.startTunnelButton.disabled = !state.connected;
      els.checkTunnelButton.disabled = !state.connected;
      els.sendFollowUpButton.disabled = !state.connected;
      els.sendSelectionButton.disabled = !state.connected;
    }

    function hostMessageCapabilities() {
      const message = state.hostCapabilities?.message;
      return message && typeof message === "object" ? message : null;
    }

    function supportsMessageBlock(type) {
      const capabilities = hostMessageCapabilities();
      if (!capabilities) return true;
      if (type === "resource_link") return Boolean(capabilities.resourceLink);
      if (type === "resource") return Boolean(capabilities.resource);
      return Boolean(capabilities[type]);
    }

    function promptFromMessage(message) {
      if (typeof message === "string") return message.trim();
      if (message?.prompt) return String(message.prompt).trim();
      if (typeof message?.content === "string") return message.content.trim();
      return "";
    }

    function contentFromMessage(message, prompt) {
      if (message && Array.isArray(message.content)) return message.content;
      return [{ type: "text", text: prompt }];
    }

    function payloadFromToolResult(result) {
      const metadata = result && typeof result === "object" ? result._meta || {} : {};
      return metadata.widgetData || result?.structuredContent || result || {};
    }

    function handleToolResult(result) {
      state.payload = { ...state.payload, ...payloadFromToolResult(result) };
      updateUi();
    }

    async function withButton(button, label, fn) {
      const original = button.textContent;
      button.disabled = true;
      button.textContent = label;
      try {
        return await fn();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        button.textContent = original;
        updateUi();
      }
    }

    async function sendMessageContent(content, fallbackText) {
      try {
        const result = await state.app.sendMessage({
          role: "user",
          content,
        });
        if (result?.isError) throw new Error("Host rejected the message content.");
        return result;
      } catch (error) {
        if (!fallbackText) throw error;
        const result = await state.app.sendMessage({
          role: "user",
          content: [{ type: "text", text: fallbackText }],
        });
        if (result?.isError) throw new Error("Host rejected the fallback text message.");
        return result;
      }
    }

    api.sendFollowUpMessage = async (message) => {
      const prompt = promptFromMessage(message);
      if (!prompt) throw new Error("依頼内容を書いてください。");
      if (!state.app || typeof state.app.sendMessage !== "function") throw new Error("Host bridge is unavailable.");
      return sendMessageContent(contentFromMessage(message, prompt), null);
    };

    api.callServerTool = async (request, options = {}) => {
      return callServerTool(request?.name, request?.arguments || {}, options);
    };

    api.getHostCapabilities = () => state.hostCapabilities;

    api.requestDisplayMode = async (modeOrRequest) => {
      if (!state.app || typeof state.app.requestDisplayMode !== "function") return {};
      const request = typeof modeOrRequest === "string" ? { mode: modeOrRequest } : (modeOrRequest || { mode: "fullscreen" });
      return state.app.requestDisplayMode(request);
    };

    async function sendFollowUp(extraText = "") {
      const base = els.followUpText.value.trim();
      const text = [base, extraText].filter(Boolean).join("\\n\\n");
      if (!text) {
        setMessage("依頼内容を書いてください。");
        return;
      }
      await api.sendFollowUpMessage({ prompt: text });
      setMessage("チャットへ送信しました。");
    }

    function textFromToolContent(content) {
      return (Array.isArray(content) ? content : [])
        .filter((item) => item?.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\\n\\n");
    }

    function attachmentContentForHost(toolResult) {
      const content = Array.isArray(toolResult?.content) ? toolResult.content : [];
      const attachments = [];
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "image" && supportsMessageBlock("image")) {
          attachments.push({
            type: "image",
            data: item.data,
            mimeType: item.mimeType || "image/png",
          });
        } else if (item.type === "resource_link" && supportsMessageBlock("resource_link")) {
          attachments.push({
            type: "resource_link",
            uri: item.uri,
            name: item.name || "canvas-asset",
            title: item.title,
            description: item.description,
            mimeType: item.mimeType,
            size: item.size,
          });
        } else if (item.type === "resource" && supportsMessageBlock("resource")) {
          attachments.push({
            type: "resource",
            resource: item.resource,
          });
        } else if (item.type === "audio" && supportsMessageBlock("audio")) {
          attachments.push({
            type: "audio",
            data: item.data,
            mimeType: item.mimeType || "audio/mpeg",
          });
        }
      }
      return attachments;
    }

    function bundleInstruction(bundleId) {
      return bundleId
        ? \`BuzzAssistのキャンバス添付 \${bundleId} を read_canvas_attachment_bundle で読んで。\`
        : "BuzzAssistの現在のキャンバス選択素材を prepare_canvas_attachments で読み、依頼に使ってください。";
    }

    async function sendSelectedAttachments() {
      const base = els.followUpText.value.trim() || "この選択素材を見て、次の作業に使ってください。";
      const result = await callServerTool("prepare_canvas_attachments", {
        projectDir: projectFromPayload() || undefined,
        maxInlineImageBytes: 4 * 1024 * 1024,
      });
      const bundle = result.structuredContent || {};
      const bundleId = bundle.id || "";
      const summary = textFromToolContent(result.content);
      const attachments = attachmentContentForHost(result);
      const fallbackText = [base, bundleInstruction(bundleId)].filter(Boolean).join("\\n\\n");
      if (attachments.length === 0) {
        await sendMessageContent([{ type: "text", text: fallbackText }], null);
        setMessage("このホストは添付block未対応のため、bundle読み込み指示を送信しました。");
        return;
      }
      await sendMessageContent(
        [
          { type: "text", text: [base, summary].filter(Boolean).join("\\n\\n") },
          ...attachments,
        ],
        fallbackText,
      );
      setMessage(\`選択素材 \${attachments.length}件をチャットへ送信しました。\`);
    }

    async function callServerTool(name, args = {}) {
      if (!state.app || typeof state.app.callServerTool !== "function") {
        throw new Error("このホストはwidgetからMCP toolを呼べません。");
      }
      const result = await state.app.callServerTool({ name, arguments: args }, { timeout: 90000 });
      if (result?.isError) {
        const text = result.content?.map((item) => item.text).filter(Boolean).join("\\n") || "Tool call failed.";
        throw new Error(text);
      }
      return result;
    }

    els.openCanvasButton.addEventListener("click", async () => {
      const canvasUrl = urlFromPayload();
      if (!canvasUrl) return;
      try {
        if (state.app && typeof state.app.openLink === "function") {
          await state.app.openLink({ url: canvasUrl });
          return;
        }
      } catch (_error) {
        // Fallback below.
      }
      window.open(canvasUrl, "_blank", "noopener,noreferrer");
    });

    els.togglePanelButton.addEventListener("click", () => {
      els.side.classList.toggle("is-open");
    });

    els.sendFollowUpButton.addEventListener("click", () => withButton(els.sendFollowUpButton, "送信中", () => sendFollowUp()));

    els.sendSelectionButton.addEventListener("click", () => withButton(els.sendSelectionButton, "添付中", () => sendSelectedAttachments()));

    els.startTunnelButton.addEventListener("click", () => withButton(els.startTunnelButton, "起動中", async () => {
      const result = await callServerTool("buzzassist_canvas_tunnel_start", { projectDir: projectFromPayload() || undefined });
      const payload = result.structuredContent || {};
      state.payload = { ...state.payload, tunnel: payload.status || payload };
      setMessage("スマホURLを起動しました。");
      updateUi();
    }));

    els.checkTunnelButton.addEventListener("click", () => withButton(els.checkTunnelButton, "確認中", async () => {
      const result = await callServerTool("buzzassist_canvas_tunnel_status", { projectDir: projectFromPayload() || undefined });
      const payload = result.structuredContent || {};
      state.payload = { ...state.payload, tunnel: payload.status || payload };
      setMessage("スマホURLの状態を更新しました。");
      updateUi();
    }));

    window.addEventListener("message", (event) => {
      const result = event.data?.params?.result;
      if (event.data?.method === "ui/notifications/tool-result" && result) handleToolResult(result);
      const request = event.data;
      if (request?.type === "buzzassist:sendFollowUpMessage") {
        const message = request.message || {};
        api.sendFollowUpMessage(message)
          .then((result) => event.source?.postMessage?.({ type: "buzzassist:sendFollowUpMessage:result", id: request.id, result }, event.origin || "*"))
          .catch((error) => event.source?.postMessage?.({ type: "buzzassist:sendFollowUpMessage:result", id: request.id, error: error?.message || String(error) }, event.origin || "*"));
      }
    });

    async function connect() {
      if (!apps || typeof apps.App !== "function") {
        els.bridgeStatus.textContent = "bridgeなし";
        setMessage("MCP Apps bridgeを読み込めませんでした。Codex/Claude Desktopのwidget対応を確認してください。");
        updateUi();
        return;
      }
      try {
        state.app = new apps.App(
          { name: "buzzassist", version: ${JSON.stringify(version)} },
          { availableDisplayModes: ["inline", "fullscreen"] },
          { autoResize: true },
        );
        state.app.addEventListener("toolresult", handleToolResult);
        state.app.addEventListener("hostcontextchanged", () => updateUi());
        await state.app.connect();
        state.connected = true;
        state.hostCapabilities = state.app.getHostCapabilities?.() || null;
        try {
          await state.app.requestDisplayMode?.({ mode: "fullscreen" });
        } catch (_error) {
          // Inline is fine when fullscreen is unavailable.
        }
        setMessage("Widget bridgeに接続しました。");
      } catch (error) {
        state.connected = false;
        setMessage(error instanceof Error ? error.message : String(error));
      }
      updateUi();
    }

    updateUi();
    connect();
  })();
  </script>
</body>
</html>`;
}

function createBuzzAssistStaticCanvasWidgetHtml({ version = "0.1.6" } = {}) {
  if (cachedStaticWidgetHtml) return cachedStaticWidgetHtml;

  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const outDir = process.env.BUZZASSIST_WIDGET_STATIC_DIR || join(root, "dist-widget");
  const indexPath = join(outDir, "index.html");
  if (!existsSync(indexPath)) {
    throw new Error(`Missing BuzzAssist widget build: ${indexPath}`);
  }

  let html = readFileSync(indexPath, "utf8");
  const inlineScripts = [];
  const consumed = new Set();

  html = html.replace(/<link\s+rel="modulepreload"[^>]*>\s*/gi, "");
  html = html.replace(
    /<link\s+rel="stylesheet"[^>]+href="([^"]+)"[^>]*>/gi,
    (_match, href) => {
      const css = readWidgetAsset(outDir, href, consumed);
      return `<style>\n${escapeInlineStyle(css)}\n</style>`;
    },
  );
  html = html.replace(
    /<script\s+type="module"[^>]+src="([^"]+)"[^>]*><\/script>/gi,
    (_match, src) => {
      const js = readWidgetAsset(outDir, src, consumed);
      inlineScripts.push(`<script>\n(() => {\n${escapeInlineScript(js)}\n})();\n</script>`);
      return "";
    },
  );

  const assetsDir = join(outDir, "assets");
  if (existsSync(assetsDir)) {
    const leftovers = readdirSync(assetsDir).filter((name) => !consumed.has(`assets/${name}`));
    if (leftovers.length > 0) {
      throw new Error(`BuzzAssist widget build emitted non-inlined assets: ${leftovers.join(", ")}`);
    }
  }

  assertNoExternalWidgetAssets(html);

  const bridge = [
    '<script id="buzzassistMcpAppsBundle">',
    escapeInlineScript(mcpAppsGlobalScript()),
    "</script>",
    '<script id="buzzassistNativeWidgetBridge">',
    buzzAssistNativeWidgetBridgeScript(version),
    "</script>",
  ].join("\n");

  if (html.includes("</head>")) html = html.replace("</head>", () => `${bridge}\n</head>`);
  else html = `${bridge}\n${html}`;

  if (inlineScripts.length > 0) {
    const scripts = inlineScripts.join("\n");
    html = html.includes("</body>")
      ? html.replace("</body>", () => `${scripts}\n</body>`)
      : `${html}\n${scripts}`;
  }

  cachedStaticWidgetHtml = html;
  return cachedStaticWidgetHtml;
}

function mcpAppsGlobalScript() {
  if (cachedMcpAppsScript) return cachedMcpAppsScript;

  const sourcePath = require.resolve("@modelcontextprotocol/ext-apps/app-with-deps");
  const source = readFileSync(sourcePath, "utf8");
  const exportStart = source.lastIndexOf("export{");
  if (exportStart === -1) throw new Error("Could not find ext-apps browser export block.");

  const exportBlock = source.slice(exportStart).match(/^export\{([^}]+)\};?\s*$/s);
  if (!exportBlock) throw new Error("Could not parse ext-apps browser export block.");

  const exportMap = parseExportMap(exportBlock[1]);
  const requiredExports = ["App", "applyDocumentTheme", "applyHostFonts", "applyHostStyleVariables"];
  for (const name of requiredExports) {
    if (!exportMap.has(name)) throw new Error(`Missing ext-apps browser export: ${name}`);
  }

  cachedMcpAppsScript = [
    source.slice(0, exportStart),
    ";globalThis.__BUZZASSIST_MCP_APPS__={",
    requiredExports.map((name) => `${JSON.stringify(name)}:${exportMap.get(name)}`).join(","),
    "};",
  ].join("");
  return cachedMcpAppsScript;
}

function parseExportMap(body) {
  const exportMap = new Map();
  for (const rawEntry of body.split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const parts = entry.split(/\s+as\s+/);
    const local = parts[0]?.trim();
    const exported = (parts[1] || parts[0])?.trim();
    if (local && exported) exportMap.set(exported, local);
  }
  return exportMap;
}

function readWidgetAsset(outDir, href, consumed) {
  const normalized = String(href || "").replace(/^\//, "");
  consumed?.add(normalized);
  return readFileSync(join(outDir, normalized), "utf8");
}

function assertNoExternalWidgetAssets(html) {
  const shell = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "");
  const forbidden = [
    [/<script\b[^>]+\bsrc\s*=/i, "external script tag"],
    [/<script\b[^>]*\btype\s*=\s*["']module["']/i, "module script tag"],
    [/<link\b[^>]+\bhref\s*=/i, "external link tag"],
    [/<iframe\b/i, "iframe tag"],
    [/<(?:object|embed|base)\b/i, "embedded/base tag"],
  ];
  for (const [pattern, label] of forbidden) {
    if (pattern.test(shell)) throw new Error(`BuzzAssist widget is not CSP-compatible: found ${label}.`);
  }
  for (const match of shell.matchAll(/\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi)) {
    const value = match[2].trim();
    if (!value || /^(?:#|data:|blob:|about:blank\b)/i.test(value)) continue;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|\.{1,2}\/)/i.test(value)) {
      throw new Error(`BuzzAssist widget is not CSP-compatible: found external resource ${value}.`);
    }
  }
}

function buzzAssistNativeWidgetBridgeScript(version) {
  return `(() => {
  "use strict";

  const apps = globalThis.__BUZZASSIST_MCP_APPS__;
  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  const NativeEventSource = window.EventSource;
  const state = {
    app: null,
    connected: false,
    payload: {},
    hostCapabilities: null,
    baseResolvers: [],
  };

  window.__BUZZASSIST_NATIVE_WIDGET__ = true;
  window.__BUZZASSIST_WIDGET_DATA__ = window.__BUZZASSIST_WIDGET_DATA__ || {};

  function publishHostGlobals(globals) {
    window.openai = Object.assign(window.openai || {}, globals);
    window.dispatchEvent(new CustomEvent("openai:set_globals", {
      detail: { globals: window.openai },
    }));
  }

  function payloadFromToolResult(result) {
    const metadata = result && typeof result === "object" ? result._meta || {} : {};
    return metadata.widgetData || result?.structuredContent || result || {};
  }

  function canvasBaseFromPayload(payload = state.payload) {
    return String(payload?.canvasUrl || payload?.localCanvasUrl || "").replace(/\\/+$/, "");
  }

  function setWidgetData(payload) {
    state.payload = { ...state.payload, ...(payload || {}) };
    window.__BUZZASSIST_WIDGET_DATA__ = state.payload;
    const base = canvasBaseFromPayload();
    if (base) {
      window.__BUZZASSIST_WIDGET_CANVAS_BASE_URL__ = base;
      const resolvers = state.baseResolvers.splice(0);
      for (const resolve of resolvers) resolve(base);
    }
    publishHostGlobals({
      rawToolResult: window.openai?.rawToolResult,
      toolOutput: state.payload,
      widgetData: state.payload,
      hostCapabilities: state.hostCapabilities,
    });
  }

  window.__BUZZASSIST_SET_WIDGET_DATA__ = setWidgetData;

  function waitForCanvasBase() {
    const base = canvasBaseFromPayload();
    if (base) return Promise.resolve(base);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = state.baseResolvers.indexOf(resolve);
        if (index >= 0) state.baseResolvers.splice(index, 1);
        reject(new Error("BuzzAssist widget did not receive a local canvas URL."));
      }, 8000);
      state.baseResolvers.push((baseUrl) => {
        clearTimeout(timer);
        resolve(baseUrl);
      });
    });
  }

  function isCanvasPath(input) {
    const raw = typeof input === "string" || input instanceof URL
      ? String(input)
      : input instanceof Request
        ? input.url
        : "";
    if (!raw) return null;
    try {
      const url = new URL(raw, window.location.href);
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/excalidraw-assets/")) {
        return { url, raw };
      }
    } catch (_error) {
      // Leave non-URL requests untouched.
    }
    return null;
  }

  function rewriteWithBase(info, base) {
    return new URL(info.url.pathname + info.url.search + info.url.hash, base + "/").href;
  }

  if (originalFetch) {
    window.fetch = async (input, init) => {
      const info = isCanvasPath(input);
      if (!info) return originalFetch(input, init);
      const base = await waitForCanvasBase();
      const rewritten = rewriteWithBase(info, base);
      if (input instanceof Request) return originalFetch(new Request(rewritten, input), init);
      return originalFetch(rewritten, init);
    };
  }

  if (typeof NativeEventSource === "function") {
    window.EventSource = function BuzzAssistWidgetEventSource(input, init) {
      const info = isCanvasPath(input);
      const base = canvasBaseFromPayload();
      const url = info && base ? rewriteWithBase(info, base) : input;
      return new NativeEventSource(url, init);
    };
    window.EventSource.prototype = NativeEventSource.prototype;
  }

  function promptFromMessage(message) {
    if (typeof message === "string") return message.trim();
    if (message?.prompt) return String(message.prompt).trim();
    if (typeof message?.content === "string") return message.content.trim();
    return "";
  }

  function contentFromMessage(message, prompt) {
    if (message && Array.isArray(message.content)) return message.content;
    return [{ type: "text", text: prompt }];
  }

  function bridgeError(error) {
    return error instanceof Error ? error : new Error(String(error || "BuzzAssist host bridge is unavailable."));
  }

  async function waitForReady() {
    if (state.app?.ready) await state.app.ready;
    if (globalThis.__BUZZASSIST_MCP_HOST_ERROR__) throw bridgeError(globalThis.__BUZZASSIST_MCP_HOST_ERROR__);
  }

  function installApi(app) {
    const api = window.buzzassistMcp || {};
    window.buzzassistMcp = api;

    api.sendFollowUpMessage = async (message) => {
      const prompt = promptFromMessage(message);
      if (!prompt) throw new Error("依頼内容を書いてください。");
      if (!app || typeof app.sendMessage !== "function") throw new Error("Host bridge is unavailable.");
      await waitForReady();
      const result = await app.sendMessage({
        role: "user",
        content: contentFromMessage(message, prompt),
      });
      if (result?.isError) throw new Error("Host rejected the follow-up message.");
      return result || {};
    };

    api.callServerTool = async (request, options = {}) => {
      if (!app || typeof app.callServerTool !== "function") throw new Error("Host tool bridge is unavailable.");
      await waitForReady();
      return app.callServerTool(request, options);
    };

    api.getHostCapabilities = () => state.hostCapabilities;
    api.requestDisplayMode = (request) => app?.requestDisplayMode?.(typeof request === "string" ? { mode: request } : request);
  }

  function handleToolResult(result) {
    const payload = payloadFromToolResult(result);
    window.openai = Object.assign(window.openai || {}, { rawToolResult: result });
    setWidgetData(payload);
  }

  window.addEventListener("message", (event) => {
    const result = event.data?.params?.result;
    if (event.data?.method === "ui/notifications/tool-result" && result) handleToolResult(result);
  });

  try {
    if (!apps || typeof apps.App !== "function") throw new Error("MCP Apps bridge is unavailable.");
    state.app = new apps.App(
      { name: "buzzassist", version: ${JSON.stringify(version)} },
      { availableDisplayModes: ["inline", "fullscreen"] },
      { autoResize: true },
    );
    globalThis.__BUZZASSIST_MCP_APP__ = state.app;
    installApi(state.app);
    state.app.addEventListener("toolresult", handleToolResult);
    state.app.addEventListener("hostcontextchanged", () => {
      state.hostCapabilities = state.app.getHostCapabilities?.() || null;
      publishHostGlobals({ hostCapabilities: state.hostCapabilities });
    });
    state.app.ready = state.app.connect()
      .then(() => {
        state.connected = true;
        state.hostCapabilities = state.app.getHostCapabilities?.() || null;
        publishHostGlobals({ hostCapabilities: state.hostCapabilities });
        state.app.requestDisplayMode?.({ mode: "fullscreen" }).catch(() => {});
      })
      .catch((error) => {
        globalThis.__BUZZASSIST_MCP_HOST_ERROR__ = error;
      });
  } catch (error) {
    globalThis.__BUZZASSIST_MCP_HOST_ERROR__ = error;
  }
})();`;
}

function escapeInlineScript(source) {
  return source.replaceAll("</script", "<\\/script").replaceAll("</SCRIPT", "<\\/SCRIPT");
}

function escapeInlineStyle(source) {
  return source.replaceAll("</style", "<\\/style").replaceAll("</STYLE", "<\\/STYLE");
}
