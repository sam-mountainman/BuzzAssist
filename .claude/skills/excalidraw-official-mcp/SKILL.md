---
name: excalidraw-official-mcp
description: Use the official Excalidraw MCP App for prompt-to-diagram creation. Prefer this when the user asks for the original Excalidraw MCP, official Excalidraw MCP, or a quick generated diagram rather than editing this repository's local persisted canvas.
---

# Excalidraw Official MCP

Use this skill when the user asks for the official Excalidraw MCP or wants a prompt-to-diagram workflow. If the user wants the result on the currently open local browser canvas, use the local `excalidraw_mcp` HTTP endpoint, not the remote official server.

## MCP Server

The plugin config exposes the official open-source Excalidraw MCP App as:

```json
{
  "name": "excalidraw_official",
  "type": "http",
  "url": "https://mcp.excalidraw.com/mcp"
}
```

For the local browser canvas, the plugin config exposes:

```json
{
  "name": "excalidraw_mcp",
  "type": "http",
  "url": "http://127.0.0.1:43219/mcp"
}
```

## Routing

- Use `excalidraw_official` for the hosted official Excalidraw MCP App generation and interactive MCP App rendering.
- Use the local `excalidraw_mcp` HTTP server when the user says "this canvas", "browser screen", "local Excalidraw canvas", or needs the result to appear in `http://127.0.0.1:43219/`.
- The local `excalidraw_mcp` implements official-compatible `read_me` and `create_view`; `create_view` writes directly into this repository's persisted canvas and the browser updates through the canvas event stream.
- If a client does not support MCP Apps, explain that the official server may still connect as MCP but the interactive app rendering may be unavailable in that client.

## Prompting

Give the official MCP a concrete diagram goal, including:

- diagram type
- nodes or actors
- relationships or flow direction
- labels that must appear
- visual grouping requirements

Keep follow-up edits specific, such as "move the database below the API server" or "make the auth path a dashed arrow."
