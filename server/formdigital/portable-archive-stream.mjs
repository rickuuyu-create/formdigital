import crypto from "node:crypto";
import { crc32 } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import {
  Unzip,
  UnzipInflate,
  UnzipPassThrough,
  Zip,
  ZipPassThrough,
} from "fflate";

export const PORTABLE_STREAM_LIMITS = Object.freeze({
  archiveBytes: 2 * 1024 * 1024 * 1024,
  expandedBytes: 2 * 1024 * 1024 * 1024,
  workspaceBytes: 64 * 1024 * 1024,
  workspaceV2Bytes: 2 * 1024 * 1024 * 1024,
  backupManifestBytes: 16 * 1024 * 1024,
  assetManifestBytes: 2 * 1024 * 1024,
  entryCount: 100_000,
});

export class PortableArchiveStreamError extends Error {
  constructor(code) {
    super(code);
    Object.defineProperty(this, "code", {
      value: code,
      enumerable: true,
      configurable: false,
      writable: false,
    });
    Object.defineProperty(this, "message", {
      value: code,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
}

const fail = code => {
  throw new PortableArchiveStreamError(code);
};

function isCanonicalPortableEntryName(name) {
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > 512 ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name)
  )
    return false;
  const parts = name.split("/");
  return parts.every(
    part => part.length > 0 && part !== "." && part !== "..",
  );
}

export async function hashPortableFile(filePath, maxBytes) {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat?.isFile()) fail("PORTABLE_SOURCE_INVALID");
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes)
    fail("PORTABLE_SOURCE_TOO_LARGE");
  const hash = crypto.createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath, { highWaterMark: 256 * 1024 })) {
    size += chunk.length;
    if (size > maxBytes) fail("PORTABLE_SOURCE_TOO_LARGE");
    hash.update(chunk);
  }
  if (size !== stat.size) fail("PORTABLE_SOURCE_CHANGED");
  return Object.freeze({ size, contentHash: hash.digest("hex") });
}

function portableEntrySource(entry) {
  if (entry?.bytes instanceof Uint8Array)
    return { size: entry.bytes.byteLength, chunks: [entry.bytes] };
  if (typeof entry?.sourcePath === "string")
    return {
      size: entry.size,
      chunks: createReadStream(entry.sourcePath, { highWaterMark: 256 * 1024 }),
    };
  fail("PORTABLE_SOURCE_INVALID");
}

export async function writePortableStoredZip(outputPath, entries, options = {}) {
  // Stored entries with unknown lengths are ambiguous when their bytes contain
  // another ZIP (DOCX is a ZIP). Write exact sizes in local headers so readers
  // never scan document content for a new entry or data descriptor.
  const maxArchiveBytes = options.maxArchiveBytes ?? PORTABLE_STREAM_LIMITS.archiveBytes;
  const output = await fs.open(outputPath, "wx");
  const central = [];
  const names = new Set();
  let offset = 0;
  const write = async bytes => {
    if (offset + bytes.length > maxArchiveBytes) fail("PORTABLE_ARCHIVE_TOO_LARGE");
    let written = 0;
    while (written < bytes.length) {
      const result = await output.write(bytes, written, bytes.length - written, offset + written);
      if (!result.bytesWritten) fail("PORTABLE_ARCHIVE_WRITE_FAILED");
      written += result.bytesWritten;
    }
    offset += bytes.length;
  };
  try {
    for await (const entry of entries) {
      if (!entry || !isCanonicalPortableEntryName(entry.archivePath) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 0xffffffff)
        fail("PORTABLE_SOURCE_INVALID");
      if (names.has(entry.archivePath)) fail("PORTABLE_ENTRY_DUPLICATE");
      names.add(entry.archivePath);
      if (names.size > Math.min(65535, PORTABLE_STREAM_LIMITS.entryCount)) fail("PORTABLE_ENTRY_LIMIT_EXCEEDED");
      const source = portableEntrySource(entry);
      if (source.size !== entry.size) fail("PORTABLE_SOURCE_CHANGED");
      const name = Buffer.from(entry.archivePath, "utf8");
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
      header.writeUInt16LE(33, 12); header.writeUInt32LE(entry.size, 18); header.writeUInt32LE(entry.size, 22); header.writeUInt16LE(name.length, 26);
      const localOffset = offset;
      await write(header); await write(name);
      let readBytes = 0, checksum = 0;
      for await (const chunk of source.chunks) {
        readBytes += chunk.byteLength;
        if (readBytes > entry.size) fail("PORTABLE_SOURCE_CHANGED");
        checksum = crc32(chunk, checksum);
        await write(chunk);
      }
      if (readBytes !== entry.size) fail("PORTABLE_SOURCE_CHANGED");
      const crc = Buffer.alloc(4); crc.writeUInt32LE(checksum);
      await output.write(crc, 0, 4, localOffset + 14);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
      record.writeUInt16LE(33, 14); record.writeUInt32LE(checksum, 16); record.writeUInt32LE(entry.size, 20); record.writeUInt32LE(entry.size, 24);
      record.writeUInt16LE(name.length, 28); record.writeUInt32LE(localOffset, 42);
      central.push(record, name);
    }
    const centralOffset = offset;
    for (const bytes of central) await write(bytes);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(names.size, 8); end.writeUInt16LE(names.size, 10);
    end.writeUInt32LE(offset - centralOffset, 12); end.writeUInt32LE(centralOffset, 16);
    await write(end); await output.sync(); await output.close();
    return Object.freeze({ archiveBytes: offset });
  } catch (error) {
    await output.close().catch(() => {});
    await fs.rm(outputPath, { force: true }).catch(() => {});
    if (error instanceof PortableArchiveStreamError) throw error;
    fail("PORTABLE_ARCHIVE_WRITE_FAILED");
  }
}

function defaultEntryLimit(name, limits) {
  if (name === "backup-manifest.json") return limits.backupManifestBytes;
  if (name === "account/workspace.json") return limits.workspaceBytes;
  if (name === "account/legacy-workspace.json") return limits.workspaceBytes;
  if (name === "account/workspace-v2.sqlite") return limits.workspaceV2Bytes;
  if (name.startsWith("manifests/")) return limits.assetManifestBytes;
  return limits.singleObjectBytes;
}

export async function extractPortableZip(archivePath, outputRoot, options = {}) {
  const limits = {
    ...PORTABLE_STREAM_LIMITS,
    singleObjectBytes: options.singleObjectBytes ?? 1024 * 1024 * 1024,
    ...(options.limits ?? {}),
  };
  const archiveStat = await fs.lstat(archivePath).catch(() => null);
  if (!archiveStat?.isFile()) fail("PORTABLE_ARCHIVE_INVALID");
  if (archiveStat.size < 1 || archiveStat.size > limits.archiveBytes)
    fail("PORTABLE_ARCHIVE_TOO_LARGE");
  await fs.mkdir(outputRoot, { recursive: false });
  await Promise.all(
    ["account", "manifests", "objects"].map(name =>
      fs.mkdir(path.join(outputRoot, name)),
    ),
  );

  const seen = new Set();
  const extracted = new Map();
  const fileCompletions = [];
  let fatal = null;
  let expandedBytes = 0;
  let compressedBytes = 0;
  const pendingDrains = new Set();
  const unzip = new Unzip(file => {
    try {
      const name = file.name;
      if (
        !isCanonicalPortableEntryName(name) ||
        typeof options.validateEntryName !== "function" ||
        !options.validateEntryName(name)
      )
        fail("PORTABLE_ENTRY_PATH_INVALID");
      if (seen.has(name)) fail("PORTABLE_ENTRY_DUPLICATE");
      seen.add(name);
      if (seen.size > limits.entryCount) fail("PORTABLE_ENTRY_LIMIT_EXCEEDED");
      if (file.compression !== 0 && file.compression !== 8)
        fail("PORTABLE_COMPRESSION_UNSUPPORTED");
      const entryLimit = defaultEntryLimit(name, limits);
      if (
        file.originalSize !== undefined &&
        (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0 || file.originalSize > entryLimit)
      )
        fail("PORTABLE_ENTRY_TOO_LARGE");
      if (
        file.compression === 8 &&
        (file.originalSize === undefined || file.size === undefined || file.size < 1 ||
          file.originalSize > file.size * 1_000)
      )
        fail("PORTABLE_COMPRESSION_REJECTED");

      const target = path.join(outputRoot, ...name.split("/"));
      const writer = createWriteStream(target, { flags: "wx" });
      const hash = crypto.createHash("sha256");
      let entryBytes = 0;
      let writerDrain = null;
      const waitForWriterCapacity = () => {
        if (writerDrain) return;
        let ready;
        let failed;
        const current = new Promise((resolve, reject) => {
          const cleanup = () => {
            writer.off("drain", ready);
            writer.off("finish", ready);
            writer.off("close", ready);
            writer.off("error", failed);
          };
          ready = () => {
            cleanup();
            resolve();
          };
          failed = error => {
            cleanup();
            reject(error);
          };
          writer.once("drain", ready);
          writer.once("finish", ready);
          writer.once("close", ready);
          writer.once("error", failed);
        });
        writerDrain = current;
        pendingDrains.add(current);
        current.then(
          () => {
            pendingDrains.delete(current);
            if (writerDrain === current) writerDrain = null;
          },
          () => {
            pendingDrains.delete(current);
            if (writerDrain === current) writerDrain = null;
          },
        );
      };
      const completion = new Promise((resolve, reject) => {
        writer.once("finish", () => {
          extracted.set(name, Object.freeze({
            path: target,
            size: entryBytes,
            contentHash: hash.digest("hex"),
            compression: file.compression,
          }));
          resolve();
        });
        writer.once("error", reject);
      });
      void completion.catch(() => {});
      fileCompletions.push(completion);
      file.ondata = (error, chunk, final) => {
        if (fatal) return;
        if (error) {
          fatal = error;
          writer.destroy(error);
          return;
        }
        if (chunk?.byteLength) {
          entryBytes += chunk.byteLength;
          expandedBytes += chunk.byteLength;
          if (entryBytes > entryLimit || expandedBytes > limits.expandedBytes) {
            fatal = new PortableArchiveStreamError(
              entryBytes > entryLimit ? "PORTABLE_ENTRY_TOO_LARGE" : "PORTABLE_EXPANDED_TOO_LARGE",
            );
            file.terminate();
            writer.destroy(fatal);
            return;
          }
          hash.update(chunk);
          if (!writer.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
            waitForWriterCapacity();
        }
        if (final) writer.end();
      };
      file.start();
    } catch (error) {
      fatal = error;
      file.terminate();
    }
  });
  unzip.register(UnzipPassThrough);
  unzip.register(UnzipInflate);

  try {
    for await (const chunk of createReadStream(archivePath, { highWaterMark: 64 * 1024 })) {
      compressedBytes += chunk.length;
      if (compressedBytes > limits.archiveBytes) fail("PORTABLE_ARCHIVE_TOO_LARGE");
      unzip.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), false);
      if (fatal) throw fatal;
      if (pendingDrains.size)
        await Promise.all([...pendingDrains]);
    }
    unzip.push(new Uint8Array(0), true);
    if (fatal) throw fatal;
    await Promise.all(fileCompletions);
    if (fatal) throw fatal;
    return Object.freeze({
      archiveBytes: compressedBytes,
      expandedBytes,
      entries: extracted,
    });
  } catch (error) {
    await fs.rm(outputRoot, { recursive: true, force: true }).catch(() => {});
    if (error instanceof PortableArchiveStreamError) throw error;
    fail("PORTABLE_ARCHIVE_INVALID");
  }
}
