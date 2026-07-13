import { existsSync, watch as watchDirectory } from "node:fs";
import { dirname, resolve } from "node:path";

export function createCanvasFileWatcher() {
  const targets = new Set();
  const directoryWatchers = new Map();
  const listeners = new Map([
    ["add", new Set()],
    ["change", new Set()],
    ["error", new Set()],
  ]);

  const emit = (event, value) => {
    for (const listener of listeners.get(event) ?? []) {
      try {
        listener(value);
      } catch (error) {
        for (const errorListener of listeners.get("error") ?? []) errorListener(error);
      }
    }
  };

  const emitTargetChange = (target, eventType) => {
    if (!targets.has(target)) return;
    const event = eventType === "rename" && existsSync(target) ? "add" : "change";
    emit(event, target);
  };

  const ensureDirectoryWatcher = (directory) => {
    if (directoryWatchers.has(directory)) return;
    const watcher = watchDirectory(directory, { persistent: true }, (eventType, fileName) => {
      if (fileName == null) {
        for (const target of targets) {
          if (dirname(target) === directory) emitTargetChange(target, eventType);
        }
        return;
      }
      emitTargetChange(resolve(directory, String(fileName)), eventType);
    });
    watcher.on("error", (error) => emit("error", error));
    directoryWatchers.set(directory, watcher);
  };

  return {
    add(paths) {
      for (const input of Array.isArray(paths) ? paths : [paths]) {
        if (!input) continue;
        const target = resolve(String(input));
        targets.add(target);
        ensureDirectoryWatcher(dirname(target));
      }
      return this;
    },
    on(event, listener) {
      if (typeof listener === "function") {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(listener);
      }
      return this;
    },
    close() {
      for (const watcher of directoryWatchers.values()) watcher.close();
      directoryWatchers.clear();
      targets.clear();
      for (const eventListeners of listeners.values()) eventListeners.clear();
    },
  };
}
