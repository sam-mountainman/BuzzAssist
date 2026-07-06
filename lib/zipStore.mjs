// Minimal ZIP writer, STORE method only. Media assets are already compressed
// (PNG/JPEG/MP4), so archiving without re-compression keeps bulk downloads
// fast and dependency-free. 32-bit sizes: fine for < 4GB entries/archives.

import { createReadStream } from "node:fs";
// Runtime lookup, NOT `import { crc32 }`: zlib.crc32 only exists on Node
// 20.15+/22, and a named import of a missing builtin export is a module-load
// SyntaxError on older Node — it would kill the whole server at startup.
import zlib from "node:zlib";

const nativeCrc32 = typeof zlib.crc32 === "function" ? zlib.crc32 : null;

// Node 22.2+ ships a native (C) CRC-32. Looping bytes in JS over a 50MB video
// stalls the whole server for seconds per download; the native call is
// effectively instant. Falls back to a table implementation on older Node.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

// Incremental CRC-32: pass the running value in, get the updated value out.
export function crc32Update(chunk, previous = 0) {
  if (nativeCrc32) return nativeCrc32(chunk, previous) >>> 0;
  let crc = previous ^ 0xffffffff;
  for (let i = 0; i < chunk.length; i += 1) {
    crc = CRC_TABLE[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function crc32(buffer) {
  return crc32Update(buffer, 0);
}

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date(2020, 0, 1);
  const year = Math.max(1980, d.getFullYear());
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { dosTime, dosDate };
}

function sanitizeEntryName(name) {
  const cleaned = String(name || "asset.bin").replace(/[\\/]+/g, "_").replace(/^\.+/, "_");
  return cleaned || "asset.bin";
}

// entries: [{ name, data: Buffer, mtime?: Date }] → Buffer (complete .zip)
export function buildZipStore(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const usedNames = new Set();

  for (const entry of entries) {
    let name = sanitizeEntryName(entry.name);
    // ZIP readers ignore duplicate names — disambiguate instead of dropping.
    if (usedNames.has(name)) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let i = 2;
      while (usedNames.has(`${stem}-${i}${ext}`)) i += 1;
      name = `${stem}-${i}${ext}`;
    }
    usedNames.add(name);

    const nameBytes = Buffer.from(name, "utf8");
    const data = entry.data;
    const crc = crc32(data);
    const { dosTime, dosDate } = dosDateTime(entry.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // method: STORE
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      stream.off("drain", onDrain);
      reject(error);
    };
    const onDrain = () => {
      stream.off("error", onError);
      resolve();
    };
    if (stream.write(chunk)) {
      resolve();
      return;
    }
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

async function pipeFileWithCrc(filePath, output) {
  return new Promise((resolve, reject) => {
    let crc = 0;
    const input = createReadStream(filePath);
    input.on("data", (chunk) => {
      // Native CRC over the whole chunk — no per-byte JS loop.
      crc = crc32Update(chunk, crc);
      if (!output.write(chunk)) {
        input.pause();
        output.once("drain", () => input.resume());
      }
    });
    input.on("error", reject);
    output.on("error", reject);
    input.on("end", () => resolve(crc >>> 0));
  });
}

// Streams a STORE-method ZIP directly to an HTTP response-like writable.
// Uses data descriptors so the browser starts receiving bytes before the whole
// archive is assembled in memory.
export async function streamZipStore(entries, output) {
  const centralParts = [];
  const usedNames = new Set();
  let offset = 0;
  let count = 0;

  for (const entry of entries) {
    let name = sanitizeEntryName(entry.name);
    if (usedNames.has(name)) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let i = 2;
      while (usedNames.has(`${stem}-${i}${ext}`)) i += 1;
      name = `${stem}-${i}${ext}`;
    }
    usedNames.add(name);

    const size = Number(entry.size);
    if (!Number.isFinite(size) || size < 0 || size > 0xffffffff) {
      throw new Error(`Unsupported ZIP entry size: ${name}`);
    }

    const nameBytes = Buffer.from(name, "utf8");
    const { dosTime, dosDate } = dosDateTime(entry.mtime);
    const localOffset = offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6); // UTF-8 + data descriptor follows
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(0, 18);
    local.writeUInt32LE(0, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    await writeChunk(output, local);
    await writeChunk(output, nameBytes);

    const crc = await pipeFileWithCrc(entry.path, output);

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    await writeChunk(output, descriptor);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0808, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);

    offset += 30 + nameBytes.length + size + descriptor.length;
    count += 1;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  for (const part of centralParts) await writeChunk(output, part);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  await writeChunk(output, eocd);
  output.end();
}
