import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { App } from "@modelcontextprotocol/ext-apps";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  canvasAttachmentBundleToMcpResult,
  createCanvasAttachmentBundle,
} from "../lib/canvasAttachmentBundle.mjs";
import { createBuzzAssistWidgetHtml } from "../lib/buzzassistWidgetResource.mjs";

class MemoryTransport {
  peer = null;
  onmessage = undefined;
  onerror = undefined;
  onclose = undefined;

  async start() {}

  async send(message) {
    queueMicrotask(() => this.peer?.onmessage?.(message));
  }

  async close() {
    this.onclose?.();
  }
}

function linkedTransports() {
  const appTransport = new MemoryTransport();
  const bridgeTransport = new MemoryTransport();
  appTransport.peer = bridgeTransport;
  bridgeTransport.peer = appTransport;
  return [appTransport, bridgeTransport];
}

test("plugin MCP exposes current-chat canvas attachment tools", async () => {
  const mcpSource = await readFile(new URL("../mcp/server.mjs", import.meta.url), "utf8");
  const viteSource = await readFile(new URL("../vite.config.js", import.meta.url), "utf8");

  for (const source of [mcpSource, viteSource]) {
    assert.match(source, /prepare_canvas_attachments/);
    assert.match(source, /read_canvas_attachment_bundle/);
    assert.match(source, /list_canvas_attachment_bundles/);
    assert.match(source, /canvasAttachmentBundleToMcpResult/);
    assert.match(source, /createCanvasAttachmentBundle/);
  }

  assert.match(viteSource, /server\.middlewares\.use\('\/api\/agent-attachments'/);
  assert.match(viteSource, /BuzzAssistのキャンバス添付 \$\{bundle\.id\} を読んで。/);
});

test("chat auto-send bridge supports macOS and Windows GUI automation", async () => {
  const source = await readFile(new URL("../lib/chatBridge.mjs", import.meta.url), "utf8");

  assert.match(source, /export function runOsascript/);
  assert.match(source, /export function runPowershell/);
  assert.match(source, /process\.platform === 'darwin'/);
  assert.match(source, /process\.platform === 'win32'/);
  assert.match(source, /Set-Clipboard -Value \$message/);
  assert.match(source, /AppActivate\('\$\{quotedAppName\}'\)/);
  assert.match(source, /SendKeys\]::SendWait\('\^v'\)/);
  assert.match(source, /SendKeys\]::SendWait\('\{ENTER\}'\)/);
});

test("plugin MCP exposes a Codex and Claude Desktop widget entrypoint", async () => {
  const mcpSource = await readFile(new URL("../mcp/server.mjs", import.meta.url), "utf8");
  const widgetSource = await readFile(new URL("../lib/buzzassistWidgetResource.mjs", import.meta.url), "utf8");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

  assert.match(mcpSource, /render_buzzassist_canvas_widget/);
  assert.match(mcpSource, /BUZZASSIST_WIDGET_URI/);
  assert.match(mcpSource, /McpServer/);
  assert.match(mcpSource, /registerAppResource/);
  assert.match(mcpSource, /registerAppTool/);
  assert.match(mcpSource, /openai\/outputTemplate/);
  assert.match(mcpSource, /openai\/widgetAccessible/);
  assert.match(widgetSource, /ui:\/\/widget\/buzzassist\/canvas-inline\.html/);
  assert.match(widgetSource, /RESOURCE_MIME_TYPE/);
  assert.match(widgetSource, /text\/html;profile=mcp-app|BUZZASSIST_WIDGET_MIME_TYPE/);
  assert.match(widgetSource, /sendMessage/);
  assert.match(widgetSource, /sendMessageContent/);
  assert.match(widgetSource, /window\.buzzassistMcp = api/);
  assert.match(widgetSource, /api\.sendFollowUpMessage/);
  assert.match(widgetSource, /contentFromMessage\(message, prompt\)/);
  assert.match(widgetSource, /createBuzzAssistStaticCanvasWidgetHtml/);
  assert.match(widgetSource, /createBuzzAssistWidgetLauncherHtml/);
  assert.match(widgetSource, /BUZZASSIST_WIDGET_LAUNCHER/);
  assert.match(widgetSource, /buzzassist:sendFollowUpMessage/);
  assert.match(widgetSource, /prepare_canvas_attachments/);
  assert.match(widgetSource, /resource_link/);
  assert.match(widgetSource, /resourceLink/);
  assert.match(widgetSource, /attachmentContentForHost/);
  assert.match(widgetSource, /buzzassist_canvas_tunnel_start/);
  assert.match(readme, /render_buzzassist_canvas_widget/);
  assert.match(readme, /通常は `BUZZASSIST_CANVAS_URL` をローカルのin-app browser/);
});

test("native widget defaults to the inlined canvas app instead of a localhost iframe shell", () => {
  const previous = process.env.BUZZASSIST_WIDGET_LAUNCHER;
  delete process.env.BUZZASSIST_WIDGET_LAUNCHER;
  try {
    const html = createBuzzAssistWidgetHtml({ version: "0.1.5" });
    assert.match(html, /__BUZZASSIST_NATIVE_WIDGET__/);
    assert.match(html, /__BUZZASSIST_SET_WIDGET_DATA__/);
    assert.match(html, /window\.fetch/);
    assert.doesNotMatch(html, /id="canvasFrame"/);
    assert.ok(Buffer.byteLength(html) > 1024 * 1024, "default widget should inline the canvas app bundle");
  } finally {
    if (previous === undefined) delete process.env.BUZZASSIST_WIDGET_LAUNCHER;
    else process.env.BUZZASSIST_WIDGET_LAUNCHER = previous;
  }
});

test("MCP Apps host bridge receives canvas assets as message content blocks", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "buzzassist-widget-message-"));
  const canvasDir = join(projectDir, "canvas");
  const assetsDir = join(canvasDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  await writeFile(join(assetsDir, "cat.png"), Buffer.from("fake-png"));
  await writeFile(join(assetsDir, "cut.xml"), "<xmeml />\n", "utf8");

  let receivedMessage = null;
  const bridge = new AppBridge(
    null,
    { name: "Codex host simulator", version: "0.0.0" },
    { message: { text: {}, image: {}, resourceLink: {}, resource: {} }, serverTools: {} },
  );
  bridge.oncalltool = async ({ name, arguments: args }) => {
    assert.equal(name, "prepare_canvas_attachments");
    const bundle = await createCanvasAttachmentBundle({
      canvasDir,
      source: "widget-test",
      assets: [
        { assetUrl: "/excalidraw-assets/cat.png", fileName: "cat.png", kind: "image", mimeType: "image/png" },
        { assetUrl: "/excalidraw-assets/cut.xml", fileName: "cut.xml", kind: "xml", mimeType: "application/xml" },
      ],
    });
    return canvasAttachmentBundleToMcpResult({ ...args, canvasDir, bundleId: bundle.id });
  };
  bridge.onmessage = async (params) => {
    receivedMessage = params;
    return {};
  };

  const app = new App(
    { name: "buzzassist-widget-test", version: "0.1.5" },
    { availableDisplayModes: ["inline", "fullscreen"] },
    { autoResize: false },
  );
  const [appTransport, bridgeTransport] = linkedTransports();
  await Promise.all([bridge.connect(bridgeTransport), app.connect(appTransport)]);

  const toolResult = await app.callServerTool({
    name: "prepare_canvas_attachments",
    arguments: { canvasDir, maxInlineImageBytes: 4 * 1024 * 1024 },
  });
  const attachments = [];
  for (const item of toolResult.content ?? []) {
    if (item.type === "image") attachments.push({ type: "image", data: item.data, mimeType: item.mimeType });
    if (item.type === "resource_link") attachments.push({ type: "resource_link", uri: item.uri, name: item.name, mimeType: item.mimeType });
    if (item.type === "resource") attachments.push({ type: "resource", resource: item.resource });
  }

  await app.sendMessage({
    role: "user",
    content: [{ type: "text", text: "キャンバス素材の自動送信テスト" }, ...attachments],
  });

  assert.equal(receivedMessage?.role, "user");
  assert.deepEqual(receivedMessage.content.map((item) => item.type), ["text", "resource_link", "image", "resource_link", "resource"]);
  assert.ok(receivedMessage.content.some((item) => item.type === "image" && item.mimeType === "image/png"));
  assert.ok(receivedMessage.content.some((item) => item.type === "resource_link" && item.name === "cut.xml"));
  assert.ok(receivedMessage.content.some((item) => item.type === "resource" && item.resource.text.includes("<xmeml")));

  await app.close();
  await bridge.close();
  await rm(projectDir, { recursive: true, force: true });
});
