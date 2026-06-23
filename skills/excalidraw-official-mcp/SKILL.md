---
name: excalidraw-official-mcp
description: Use the official Excalidraw MCP App for prompt-to-diagram creation. Prefer this when the user asks for the original Excalidraw MCP, official Excalidraw MCP, or a quick generated diagram rather than editing this repository's local persisted canvas.
---

# Excalidraw Official MCP

Use this skill when the user asks for the official Excalidraw MCP or wants a prompt-to-diagram workflow.

## MCP Server

The plugin config exposes the official open-source Excalidraw MCP App as:

```json
{
  "name": "excalidraw_official",
  "type": "http",
  "url": "https://mcp.excalidraw.com/mcp"
}
```

## Routing

- Use `excalidraw_official` for official Excalidraw MCP App generation, quick diagrams, and interactive MCP App rendering.
- Use the local `excalidraw_mcp` server when the user needs the current project-local canvas state, selected elements, asset insertion, or image/video generation into this repository's persisted canvas.
- If a client does not support MCP Apps, explain that the official server may still connect as MCP but the interactive app rendering may be unavailable in that client.

## Prompting

Give the official MCP a concrete diagram goal, including:

- diagram type
- nodes or actors
- relationships or flow direction
- labels that must appear
- visual grouping requirements

Keep follow-up edits specific, such as "move the database below the API server" or "make the auth path a dashed arrow."
