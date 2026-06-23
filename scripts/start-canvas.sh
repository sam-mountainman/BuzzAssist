#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CALLER_DIR="$PWD"
PORT="${EXCALIDRAW_PORT:-43219}"
PROJECT_DIR="${EXCALIDRAW_PROJECT_DIR:-${1:-$CALLER_DIR}}"
CANVAS_DIR="${EXCALIDRAW_CANVAS_DIR:-$PROJECT_DIR/canvas}"

export EXCALIDRAW_PROJECT_DIR="$PROJECT_DIR"
export EXCALIDRAW_CANVAS_DIR="$CANVAS_DIR"

cd "$ROOT_DIR"

if [ ! -d node_modules ] || [ ! -x node_modules/.bin/vite ]; then
  npm install
fi

echo "Codex Excalidraw canvas: http://127.0.0.1:${PORT}"
echo "Codex Excalidraw data: ${CANVAS_DIR}/excalidraw-canvas.json"
echo "Codex Excalidraw assets: ${CANVAS_DIR}/assets -> http://127.0.0.1:${PORT}/excalidraw-assets/"
exec npm run dev -- --host 127.0.0.1 --port "$PORT"
