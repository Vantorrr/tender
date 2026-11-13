/**
 * Safe archive unpacking for procurement uploads.
 * Blocks path traversal, symlinks, nested bombs via limits.
 * Visible errors — never silent success.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import zlib from "node:zlib";
import { createExtractorFromData } from "node-unrar-js";
import { config } from "@/server/config";

export type ArchiveExtractResult = {
  ok: boolean;
  format: "zip" | "rar" | "unsupported" | "none";
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
const MAX_UNCOMPRESSED = 64 * 1024 * 1024;
const MAX_SINGLE = 32 * 1024 * 1024;
const MAX_SINGLE_ARCHIVE = 60 * 1024 * 1024;
const MAX_NESTING_NAME = 180;
const nodeRequire = createRequire(path.join(process.cwd(), "package.json"));
let unrarWasm: ArrayBuffer | undefined;

function loadUnrarWasm(): ArrayBuffer {
  if (!unrarWasm) {
    const wasmPath = nodeRequire.resolve("node-unrar-js/dist/js/unrar.wasm");
    const buffer = fs.readFileSync(wasmPath);
    unrarWasm = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    ) as ArrayBuffer;
  }
  return unrarWasm;
}

function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b;
}

function decodeZipName(rawName: Buffer, flags: number, extra: Buffer): string {
  if (flags & 0x800) return rawName.toString("utf8");
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const tag = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    const end = cursor + 4 + size;
    if (end > extra.length) break;
    if (tag === 0x7075 && size >= 5 && extra[cursor + 4] === 1) {
      const unicodeName = extra.slice(cursor + 9, end).toString("utf8");
      if (unicodeName && !unicodeName.includes("\uFFFD")) return unicodeName;
    }
    cursor = end;
  }
  const utf8Name = rawName.toString("utf8");
  if (!utf8Name.includes("\uFFFD")) return utf8Name;
  // Legacy Russian ZIP tools commonly write DOS code page 866 without the UTF-8 flag.
  return new TextDecoder("ibm866").decode(rawName);
}

function isNestedArchive(name: string): boolean {
  return /\.(zip|rar)$/i.test(name);
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
  // Most desktop ZIP writers set general-purpose bit 3 and place sizes in the
  // central directory (with a data descriptor after the payload). Read that
  // directory first; the local-header fallback below remains for tiny legacy
  // archives that omit an EOCD record.
  const eocdMin = Math.max(0, buf.length - 22 - 65_535);
  let eocd = -1;
  for (let i = buf.length - 22; i >= eocdMin; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      const commentLength = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLength === buf.length) {
        eocd = i;
        break;
      }
    }
  }
  if (eocd >= 0) {
    const disk = buf.readUInt16LE(eocd + 4);
    const centralDisk = buf.readUInt16LE(eocd + 6);
    const diskEntries = buf.readUInt16LE(eocd + 8);
    const totalEntries = buf.readUInt16LE(eocd + 10);
    const centralSize = buf.readUInt32LE(eocd + 12);
    const centralOffset = buf.readUInt32LE(eocd + 16);
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
      return [{ name: "?", error: "multi-disk ZIP is not supported" }];
    }
    if (
      totalEntries === 0xffff ||
      centralSize === 0xffffffff ||
      centralOffset === 0xffffffff
    ) {
      return [{ name: "?", error: "ZIP64 archive is not supported" }];
    }
    if (centralOffset + centralSize > eocd || centralOffset > buf.length) {
      return [{ name: "?", error: "invalid central directory bounds" }];
    }

    const entries: Array<{ name: string; data: Buffer } | { name: string; error: string }> = [];
    let cursor = centralOffset;
    let totalUncompressed = 0;
    for (let index = 0; index < totalEntries; index += 1) {
      if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== 0x02014b50) {
        entries.push({ name: "?", error: "invalid central directory entry" });
        break;
      }
      const flags = buf.readUInt16LE(cursor + 8);
      const method = buf.readUInt16LE(cursor + 10);
      const compSize = buf.readUInt32LE(cursor + 20);
      const uncompSize = buf.readUInt32LE(cursor + 24);
      const nameLen = buf.readUInt16LE(cursor + 28);
      const extraLen = buf.readUInt16LE(cursor + 30);
      const commentLen = buf.readUInt16LE(cursor + 32);
      const localOffset = buf.readUInt32LE(cursor + 42);
      const entryEnd = cursor + 46 + nameLen + extraLen + commentLen;
      if (entryEnd > buf.length || localOffset + 30 > buf.length) {
        entries.push({ name: "?", error: "truncated central directory entry" });
        break;
      }
      const rawName = buf.slice(cursor + 46, cursor + 46 + nameLen);
      const extra = buf.slice(cursor + 46 + nameLen, cursor + 46 + nameLen + extraLen);
      const name = decodeZipName(rawName, flags, extra);
      cursor = entryEnd;
      if (name.endsWith("/")) continue;
      if (entries.length >= MAX_FILES) {
        entries.push({ name, error: `file limit ${MAX_FILES} exceeded` });
        break;
      }
      if (flags & 0x1) {
        entries.push({ name, error: "encrypted zip entry rejected" });
        continue;
      }
      if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
        entries.push({ name, error: "ZIP64 entry is not supported" });
        continue;
      }
      const singleLimit = isNestedArchive(name) ? MAX_SINGLE_ARCHIVE : MAX_SINGLE;
      if (uncompSize > singleLimit) {
        entries.push({ name, error: `single file > ${singleLimit} bytes` });
        continue;
      }
      if (totalUncompressed + uncompSize > MAX_UNCOMPRESSED) {
        entries.push({ name, error: "archive uncompressed size limit exceeded" });
        break;
      }
      const unsafe = unsafeName(name);
      if (unsafe) {
        entries.push({ name, error: unsafe });
        continue;
      }
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
        entries.push({ name, error: "invalid local file header" });
        continue;
      }
      const localNameLen = buf.readUInt16LE(localOffset + 26);
      const localExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const dataEnd = dataStart + compSize;
      if (dataEnd > buf.length) {
        entries.push({ name, error: "truncated compressed data" });
        continue;
      }
      try {
        const compressed = buf.slice(dataStart, dataEnd);
        const data = method === 0
          ? compressed
          : method === 8
            ? zlib.inflateRawSync(compressed, { maxOutputLength: singleLimit })
            : null;
        if (!data) {
          entries.push({ name, error: `unsupported compression method ${method}` });
          continue;
        }
        if (data.length !== uncompSize || data.length > singleLimit) {
          entries.push({ name, error: "inflated size does not match archive metadata" });
          continue;
        }
        totalUncompressed += data.length;
        entries.push({ name, data });
      } catch (error) {
        entries.push({ name, error: error instanceof Error ? error.message : "inflate failed" });
      }
    }
    return entries;
  }

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
    const rawName = buf.slice(nameStart, nameEnd);
    const extra = buf.slice(nameEnd, nameEnd + extraLen);
    const name = decodeZipName(rawName, flags, extra);
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
    const singleLimit = isNestedArchive(name) ? MAX_SINGLE_ARCHIVE : MAX_SINGLE;
    if (uncompSize > singleLimit) {
      out.push({ name, error: `single file > ${singleLimit} bytes` });
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
          maxOutputLength: singleLimit,
        });
      } else {
        out.push({ name, error: `unsupported compression method ${method}` });
        offset = dataEnd;
        continue;
      }
      if (data.length > singleLimit) {
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
  // XLSX/DOCX and OpenDocument files are ZIP containers internally, but they
  // must go through their document parsers instead of archive extraction.
  if (/\.(xlsx|xlsm|xlsb|docx|docm|dotx|dotm|pptx|pptm|ppsx|ppsm|potx|potm|ods|odt|odp)$/i.test(lower)) {
    return "none";
  }
  if (isZip(bytes) || lower.endsWith(".zip")) return "zip";
  if (/\.rar$/i.test(lower)) return "rar";
  if (/\.(7z|tar|gz|tgz)$/i.test(lower)) return "unsupported";
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
  if (format === "unsupported" || format === "rar") {
    return {
      ok: false,
      format,
      files: [],
      errors: [
        format === "rar"
          ? `Формат RAR «${fileName}» не поддерживается ZIP-распаковщиком; вызовите RAR-распаковщик.`
          : `Формат архива «${fileName}» не поддерживается безопасным извлечением (ZIP/RAR).`,
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

/** RAR extraction in memory with the same path/count/size limits as ZIP. */
export async function extractRarArchiveSafely(
  fileName: string,
  bytes: Buffer,
  targetDir: string
): Promise<ArchiveExtractResult> {
  const files: ArchiveExtractResult["files"] = [];
  const errors: string[] = [];
  const skipped: string[] = [];
  try {
    const archiveBytes = Uint8Array.from(bytes).buffer;
    const extractor = await createExtractorFromData({
      data: archiveBytes,
      wasmBinary: loadUnrarWasm(),
    });
    const listing = extractor.getFileList();
    const headers = [...listing.fileHeaders];
    if (listing.arcHeader.flags.volume) {
      return {
        ok: false,
        format: "rar",
        files,
        errors: ["Многотомные RAR-архивы не поддерживаются"],
        skipped,
      };
    }

    let totalUncompressed = 0;
    const allowedNames: string[] = [];
    for (const header of headers) {
      const unsafe = unsafeName(header.name);
      if (header.flags.directory) continue;
      if (unsafe) {
        errors.push(`${header.name}: ${unsafe}`);
        skipped.push(header.name);
        continue;
      }
      if (header.flags.encrypted) {
        errors.push(`${header.name}: зашифрованный файл не разобран`);
        skipped.push(header.name);
        continue;
      }
      const singleLimit = isNestedArchive(header.name) ? MAX_SINGLE_ARCHIVE : MAX_SINGLE;
      if (header.unpSize > singleLimit) {
        errors.push(`${header.name}: файл больше лимита ${singleLimit} байт`);
        skipped.push(header.name);
        continue;
      }
      if (totalUncompressed + header.unpSize > MAX_UNCOMPRESSED) {
        errors.push(`${header.name}: превышен общий лимит распаковки`);
        skipped.push(header.name);
        continue;
      }
      if (allowedNames.length >= MAX_FILES) {
        errors.push(`${header.name}: превышен лимит ${MAX_FILES} файлов`);
        skipped.push(header.name);
        continue;
      }
      totalUncompressed += header.unpSize;
      allowedNames.push(header.name);
    }
    if (allowedNames.length === 0) {
      return { ok: errors.length === 0, format: "rar", files, errors, skipped };
    }
    const extracted = extractor.extract({ files: allowedNames });
    fs.mkdirSync(targetDir, { recursive: true });
    for (const entry of extracted.files) {
      const rel = entry.fileHeader.name.replace(/\\/g, "/");
      const data = entry.extraction;
      if (!data) {
        errors.push(`${rel}: содержимое не извлечено`);
        skipped.push(rel);
        continue;
      }
      const singleLimit = isNestedArchive(rel) ? MAX_SINGLE_ARCHIVE : MAX_SINGLE;
      if (data.length > singleLimit || data.length !== entry.fileHeader.unpSize) {
        errors.push(`${rel}: размер результата не совпадает с безопасным лимитом`);
        skipped.push(rel);
        continue;
      }
      const abs = path.resolve(targetDir, rel);
      const resolvedRoot = path.resolve(targetDir);
      if (!abs.startsWith(resolvedRoot + path.sep)) {
        errors.push(`${rel}: выход за каталог распаковки`);
        skipped.push(rel);
        continue;
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, Buffer.from(data));
      files.push({
        name: path.basename(rel),
        size: data.length,
        relativePath: rel,
        absolutePath: abs,
      });
    }
    return { ok: errors.length === 0, format: "rar", files, errors, skipped };
  } catch (error) {
    return {
      ok: false,
      format: "rar",
      files,
      errors: [error instanceof Error ? error.message.slice(0, 180) : "RAR не удалось распаковать"],
      skipped,
    };
  }
}

export function archiveExtractDir(docId: string): string {
  return path.join(config.dataDir, "uploads", "extracted", docId);
}
