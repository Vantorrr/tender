/**
 * Safe archive unpacking for procurement uploads.
 * Blocks path traversal, symlinks, nested bombs via limits.
 * Visible errors — never silent success.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { config } from "@/server/config";

export type ArchiveExtractResult = {
  ok: boolean;
  format: "zip" | "unsupported" | "none";
  files: Array<{
    name: string;
    size: number;
    relativePath: string;
    absolutePath: string;
  }>;
  errors: string[];
  skipped: string[];
};

const MAX_FILES = 40;
const MAX_UNCOMPRESSED = 40 * 1024 * 1024;
const MAX_SINGLE = 12 * 1024 * 1024;
const MAX_NESTING_NAME = 180;

function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b;
}

function unsafeName(name: string): string | null {
  const normalized = name.replace(/\\/g, "/");
  if (!normalized || normalized.endsWith("/")) return "directory entry skipped";
  if (normalized.startsWith("/") || normalized.includes(":/")) {
    return "absolute path rejected";
  }
  if (normalized.split("/").some((p) => p === ".." || p === "")) {
    return "path traversal rejected";
  }
  if (normalized.length > MAX_NESTING_NAME) return "path too long";
  return null;
}

/** Minimal ZIP local-file parser (store + deflate). No zip64 / encryption. */
function extractZipEntries(
  buf: Buffer
): Array<{ name: string; data: Buffer } | { name: string; error: string }> {
  const out: Array<
    { name: string; data: Buffer } | { name: string; error: string }
  > = [];
  let offset = 0;
  let totalUncompressed = 0;

  while (offset + 30 <= buf.length) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break;
    const flags = buf.readUInt16LE(offset + 6);
    const method = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const uncompSize = buf.readUInt32LE(offset + 22);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLen;
    if (nameEnd + extraLen > buf.length) {
      out.push({ name: "?", error: "truncated local header" });
      break;
    }
    const name = buf.slice(nameStart, nameEnd).toString("utf8");
    const dataStart = nameEnd + extraLen;
    // Data descriptor (bit 3) — sizes may be zero in header; refuse for safety.
    if (flags & 0x8) {
      out.push({
        name,
        error: "zip data descriptor / streaming entry not supported",
      });
      break;
    }
    if (flags & 0x1) {
      out.push({ name, error: "encrypted zip entry rejected" });
      offset = dataStart + compSize;
      continue;
    }
    const dataEnd = dataStart + compSize;
    if (dataEnd > buf.length) {
      out.push({ name, error: "truncated compressed data" });
      break;
    }
    const unsafe = unsafeName(name);
    if (unsafe) {
      out.push({ name, error: unsafe });
      offset = dataEnd;
      continue;
    }
    if (out.length >= MAX_FILES) {
      out.push({ name, error: `file limit ${MAX_FILES} exceeded` });
      break;
    }
    if (uncompSize > MAX_SINGLE) {
      out.push({ name, error: `single file > ${MAX_SINGLE} bytes` });
      offset = dataEnd;
      continue;
    }
    if (totalUncompressed + uncompSize > MAX_UNCOMPRESSED) {
      out.push({ name, error: "archive uncompressed size limit exceeded" });
      break;
    }
    const compressed = buf.slice(dataStart, dataEnd);
    try {
      let data: Buffer;
      if (method === 0) {
        data = compressed;
      } else if (method === 8) {
        data = zlib.inflateRawSync(compressed, {
          maxOutputLength: MAX_SINGLE,
        });
      } else {
        out.push({ name, error: `unsupported compression method ${method}` });
        offset = dataEnd;
        continue;
      }
      if (data.length > MAX_SINGLE) {
        out.push({ name, error: "inflated size over limit" });
        offset = dataEnd;
        continue;
      }
      totalUncompressed += data.length;
      out.push({ name, data });
    } catch (e) {
      out.push({
        name,
        error: e instanceof Error ? e.message : "inflate failed",
      });
    }
    offset = dataEnd;
  }
  return out;
}

export function detectArchiveFormat(
  fileName: string,
  bytes: Buffer
): ArchiveExtractResult["format"] {
  const lower = fileName.toLowerCase();
  if (isZip(bytes) || lower.endsWith(".zip")) return "zip";
  if (/\.(rar|7z|tar|gz|tgz)$/i.test(lower)) return "unsupported";
  return "none";
}

export function extractArchiveSafely(
  fileName: string,
  bytes: Buffer,
  targetDir: string
): ArchiveExtractResult {
  const format = detectArchiveFormat(fileName, bytes);
  if (format === "none") {
    return { ok: true, format, files: [], errors: [], skipped: [] };
  }
  if (format === "unsupported") {
    return {
      ok: false,
      format,
      files: [],
      errors: [
        `Формат архива «${fileName}» не поддерживается безопасным извлечением (только ZIP).`,
      ],
      skipped: [],
    };
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const entries = extractZipEntries(bytes);
  const files: ArchiveExtractResult["files"] = [];
  const errors: string[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    if ("error" in entry) {
      errors.push(`${entry.name}: ${entry.error}`);
      skipped.push(entry.name);
      continue;
    }
    const rel = entry.name.replace(/\\/g, "/");
    const abs = path.join(targetDir, rel);
    const resolvedRoot = path.resolve(targetDir);
    const resolvedFile = path.resolve(abs);
    if (
      resolvedFile !== resolvedRoot &&
      !resolvedFile.startsWith(resolvedRoot + path.sep)
    ) {
      errors.push(`${rel}: escaped extract root`);
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, entry.data);
    files.push({
      name: path.basename(rel),
      size: entry.data.length,
      relativePath: rel,
      absolutePath: abs,
    });
  }

  return {
    ok: errors.length === 0,
    format: "zip",
    files,
    errors,
    skipped,
  };
}

export function archiveExtractDir(docId: string): string {
  return path.join(config.dataDir, "uploads", "extracted", docId);
}
