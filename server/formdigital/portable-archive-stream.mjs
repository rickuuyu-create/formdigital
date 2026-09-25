import crypto from "node:crypto";
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
  const maxArchiveBytes = options.maxArchiveBytes ?? PORTABLE_STREAM_LIMITS.archiveBytes;
  const output = createWriteStream(outputPath, { flags: "wx" });
  let outputError = null;
  let pendingDrain = null;
  let archiveBytes = 0;
  let finalSeen = false;
  let resolveZip;
  let rejectZip;
  const zipDone = new Promise((resolve, reject) => {
    resolveZip = resolve;
    rejectZip = reject;
  });
  const outputDone = new Promise((resolve, reject) => {
    output.once("finish", resolve);
    output.once("error", reject);
  });
  void zipDone.catch(() => {});
  void outputDone.catch(() => {});
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      outputError = error;
      output.destroy(error);
      rejectZip(error);
      return;
    }
    if (chunk?.byteLength) {
      archiveBytes += chunk.byteLength;
      if (archiveBytes > maxArchiveBytes) {
        outputError = new PortableArchiveStreamError("PORTABLE_ARCHIVE_TOO_LARGE");
        output.destroy(outputError);
        rejectZip(outputError);
        zip.terminate();
        return;
      }
      if (!output.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
        pendingDrain = once(output, "drain").finally(() => {
          pendingDrain = null;
        });
    }
    if (final && !finalSeen) {
      finalSeen = true;
      output.end();
      resolveZip();
    }
  });
  const waitForOutput = async () => {
    if (pendingDrain) await pendingDrain;
    if (outputError) throw outputError;
  };

  try {
    const writtenNames = new Set();
    for await (const entry of entries) {
      if (
        !entry ||
        typeof entry.archivePath !== "string" ||
        !isCanonicalPortableEntryName(entry.archivePath) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0
      )
        fail("PORTABLE_SOURCE_INVALID");
      if (writtenNames.has(entry.archivePath))
        fail("PORTABLE_ENTRY_DUPLICATE");
      writtenNames.add(entry.archivePath);
      if (writtenNames.size > PORTABLE_STREAM_LIMITS.entryCount)
        fail("PORTABLE_ENTRY_LIMIT_EXCEEDED");
      const source = portableEntrySource(entry);
      if (source.size !== entry.size) fail("PORTABLE_SOURCE_CHANGED");
      const zipEntry = new ZipPassThrough(entry.archivePath);
      zip.add(zipEntry);
      let readBytes = 0;
      for await (const chunk of source.chunks) {
        readBytes += chunk.byteLength;
        if (readBytes > entry.size) fail("PORTABLE_SOURCE_CHANGED");
        zipEntry.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), false);
        await waitForOutput();
      }
      if (readBytes !== entry.size) fail("PORTABLE_SOURCE_CHANGED");
      zipEntry.push(new Uint8Array(0), true);
      await waitForOutput();
    }
    zip.end();
    await zipDone;
    await outputDone;
    return Object.freeze({ archiveBytes });
  } catch (error) {
    zip.terminate();
    output.destroy();
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
