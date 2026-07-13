import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

export function localFolderOpenCommand(folderPath, platform = process.platform) {
  const target = resolve(String(folderPath));
  if (platform === "darwin") return { command: "open", args: [target] };
  if (platform === "win32") return { command: "explorer.exe", args: [target] };
  return { command: "xdg-open", args: [target] };
}
export async function openLocalFolder(folderPath, options = {}) {
  const target = resolve(String(folderPath));
  await mkdir(target, { recursive: true });
  const { command, args } = localFolderOpenCommand(target, options.platform ?? process.platform);
  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
  child.unref?.();
  return { ok: true, path: target, command };
}
