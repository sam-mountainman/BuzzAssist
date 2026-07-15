import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

async function readDirectoryFileNames(directory) {
  if (!directory) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const historyEntry = entries.find((entry) => entry.isDirectory() && entry.name === ".history");
  if (historyEntry) {
    const historyNames = await readdir(join(directory, historyEntry.name), { withFileTypes: true })
      .then((items) => items.filter((entry) => entry.isFile()).map((entry) => entry.name))
      .catch((error) => {
        if (error?.code === "ENOENT") return [];
        throw error;
      });
    names.push(...historyNames);
  }
  return names;
}

function normalizedExtension(extension) {
  const raw = String(extension || "bin").replace(/^\.+/, "");
  return `.${raw || "bin"}`;
}

export async function nextNumberedGeneratedFileName({
  directory,
  prefix,
  extension,
  pattern,
  additionalNames = [],
  trashDirectory,
} = {}) {
  if (!directory) throw new Error("directory is required.");
  if (!prefix) throw new Error("prefix is required.");
  if (!(pattern instanceof RegExp)) throw new Error("pattern must be a RegExp.");

  const resolvedTrashDirectory = trashDirectory === undefined && basename(directory) === "assets"
    ? join(dirname(directory), "assets-trash")
    : trashDirectory;
  const names = [
    ...(await readDirectoryFileNames(directory)),
    ...(await readDirectoryFileNames(resolvedTrashDirectory)),
    ...additionalNames,
  ];
  let maxNumber = 0;
  for (const value of names) {
    const name = basename(String(value || ""));
    pattern.lastIndex = 0;
    const match = name.match(pattern);
    if (!match) continue;
    const number = Number.parseInt(match[1], 10);
    if (Number.isFinite(number) && number > maxNumber) maxNumber = number;
  }
  return `${prefix}${maxNumber + 1}${normalizedExtension(extension)}`;
}
