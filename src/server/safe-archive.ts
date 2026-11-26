/**
 * Safe archive unpacking for procurement uploads.
 * Blocks path traversal, symlinks, nested bombs via limits.
 * Visible errors — never silent success.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createExtractorFromData } from "node-unrar-js";
import { config } from "@/server/config";

export type ArchiveExtractResult = {
  ok: boolean;
  format: "zip" | "rar" | "tar" | "gz" | "7z" | "unsupported" | "none";
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

/**
 * How many archive containers may be opened in one chain.
 * Level 1 is the uploaded archive. `zip → 7z → 7z` is level 3.
 */
export const MAX_ARCHIVE_DEPTH = 5;

/** `depth` is 0 for the first archive inside the upload. */
export function nestedArchiveDepthAllowed(depth: number): boolean {
  return depth >= 0 && depth < MAX_ARCHIVE_DEPTH - 1;
}
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
  return /\.(zip|rar|7z|tar|gz|tgz)$/i.test(name);
}

function is7z(buf: Buffer): boolean {
  return buf.length >= 6 && buf[0] === 0x37 && buf[1] === 0x7a && buf[2] === 0xbc && buf[3] === 0xaf;
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
  if (/\.tar\.gz$/i.test(lower) || lower.endsWith(".tgz") || lower.endsWith(".tar")) return "tar";
  if (lower.endsWith(".gz") || (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)) return "gz";
  if (lower.endsWith(".7z") || is7z(bytes)) return "7z";
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
  if (format === "rar") {
    return {
      ok: false,
      format,
      files: [],
      errors: [`Формат RAR «${fileName}» не поддерживается ZIP-распаковщиком; вызовите RAR-распаковщик.`],
      skipped: [],
    };
  }
  if (format === "tar" || format === "gz" || format === "7z") {
    return writeArchiveEntries(fileName, bytes, targetDir, format);
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

type MemoryEntry = { name: string; data: Buffer } | { name: string; error: string };

function parseTarEntries(buf: Buffer): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  let offset = 0;
  let total = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const nameRaw = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/u, "");
    const name = prefix ? `${prefix.replace(/\/$/u, "")}/${nameRaw}` : nameRaw;
    const size = Number.parseInt(header.subarray(124, 136).toString("utf8").replace(/\0/g, "").trim() || "0", 8);
    const type = header[156];
    offset += 512;
    if (!Number.isFinite(size) || size < 0) {
      entries.push({ name: name || "?", error: "битый заголовок tar" });
      break;
    }
    const data = Buffer.from(buf.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
    if (type === 53 || name.endsWith("/")) continue;
    if (type !== 0 && type !== 48) continue;
    const unsafe = unsafeName(name);
    if (unsafe) {
      entries.push({ name, error: unsafe });
      continue;
    }
    if (entries.length >= MAX_FILES) {
      entries.push({ name, error: `file limit ${MAX_FILES} exceeded` });
      break;
    }
    const singleLimit = isNestedArchive(name) ? MAX_SINGLE_ARCHIVE : MAX_SINGLE;
    if (data.length > singleLimit || total + data.length > MAX_UNCOMPRESSED) {
      entries.push({ name, error: "archive uncompressed size limit exceeded" });
      break;
    }
    total += data.length;
    entries.push({ name, data });
  }
  return entries;
}

function gunzipEntries(fileName: string, bytes: Buffer): MemoryEntry[] {
  let inflated: Buffer;
  try {
    inflated = zlib.gunzipSync(bytes, { maxOutputLength: MAX_UNCOMPRESSED });
  } catch {
    return [{ name: fileName, error: "архив gz повреждён" }];
  }
  const ustar = inflated.length > 262 && inflated.subarray(257, 262).toString("utf8") === "ustar";
  if (ustar) return parseTarEntries(inflated);
  const inner = fileName.replace(/\.gz$/i, "") || "file";
  const unsafe = unsafeName(inner);
  if (unsafe) return [{ name: inner, error: unsafe }];
  return [{ name: path.basename(inner), data: inflated }];
}

function sevenZipBin(): string | null {
  for (const bin of ["7z", "7zz", "7za"]) {
    const found = spawnSync(/*turbopackIgnore: true*/ "which", [bin], { encoding: "utf8" });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  return null;
}

type Listed7z = { name: string; size: number; symlink: boolean };

function parse7zList(stdout: string): Listed7z[] {
  const listed: Listed7z[] = [];
  let block: Record<string, string> | null = null;
  const flush = () => {
    if (!block?.Path || block.Type) {
      block = null;
      return;
    }
    if (block.Folder === "+") {
      block = null;
      return;
    }
    const attributes = block.Attributes ?? "";
    listed.push({
      name: block.Path,
      size: Number(block.Size ?? "0"),
      symlink: Boolean(block["Symbolic Link"]) || /^\s*l/i.test(attributes) || attributes.includes(" l") || /symlink/i.test(attributes),
    });
    block = null;
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const match = /^([^=]+?) = (.*)$/.exec(line);
    if (!match) continue;
    block ??= {};
    block[match[1].trim()] = match[2];
  }
  flush();
  return listed;
}

function pathInside(root: string, candidate: string): boolean {
  const resolvedRoot = fs.realpathSync(root);
  const resolved = fs.realpathSync(candidate);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

function extract7zEntries(bytes: Buffer): MemoryEntry[] {
  const bin = sevenZipBin();
  if (!bin) {
    return [{ name: "archive.7z", error: "Архив 7z не разобран: на сервере нет программы распаковки" }];
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tk-7z-"));
  try {
    const archivePath = path.join(tmp, "archive.7z");
    fs.writeFileSync(archivePath, bytes);
    const listed = spawnSync(/*turbopackIgnore: true*/ bin, ["l", "-slt", "-bd", archivePath], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (listed.status !== 0) {
      return [{ name: "archive.7z", error: "Не удалось прочитать состав архива 7z" }];
    }
    const members = parse7zList(listed.stdout ?? "");
    const rejected: MemoryEntry[] = [];
    let total = 0;
    let files = 0;
    for (const member of members) {
      if (member.symlink) {
        rejected.push({ name: member.name, error: "symlink rejected" });
        continue;
      }
      const unsafe = unsafeName(member.name);
      if (unsafe) {
        rejected.push({ name: member.name, error: unsafe });
        continue;
      }
      files += 1;
      const singleLimit = isNestedArchive(member.name) ? MAX_SINGLE_ARCHIVE : MAX_SINGLE;
      if (!Number.isFinite(member.size) || member.size < 0 || member.size > singleLimit || total + member.size > MAX_UNCOMPRESSED || files > MAX_FILES) {
        rejected.push({ name: member.name, error: files > MAX_FILES ? `file limit ${MAX_FILES} exceeded` : "archive uncompressed size limit exceeded" });
        continue;
      }
      total += member.size;
    }
    if (rejected.length) return rejected;

    const outDir = path.join(tmp, "out");
    fs.mkdirSync(outDir);
    const extracted = spawnSync(/*turbopackIgnore: true*/ bin, ["x", "-y", "-bd", `-o${outDir}`, archivePath], { encoding: "utf8" });
    if (extracted.status !== 0) {
      return [{ name: "archive.7z", error: "Не удалось распаковать архив 7z" }];
    }
    const entries: MemoryEntry[] = [];
    let readTotal = 0;
    const walk = (dir: string, prefix: string): boolean => {
      for (const entry of fs.readdirSync(dir)) {
        const rel = prefix ? `${prefix}/${entry}` : entry;
        const abs = path.join(dir, entry);
        const stat = fs.lstatSync(abs);
        if (stat.isSymbolicLink() || !pathInside(outDir, abs)) {
          entries.length = 0;
          entries.push({ name: rel, error: stat.isSymbolicLink() ? "symlink rejected" : "path traversal rejected" });
          return false;
        }
        if (stat.isDirectory()) {
          if (!walk(abs, rel)) return false;
          continue;
        }
        if (!stat.isFile()) {
          entries.length = 0;
          entries.push({ name: rel, error: "symlink rejected" });
          return false;
        }
        const unsafe = unsafeName(rel);
        if (unsafe || stat.size > MAX_SINGLE_ARCHIVE || readTotal + stat.size > MAX_UNCOMPRESSED) {
          entries.length = 0;
          entries.push({ name: rel, error: unsafe ?? "archive uncompressed size limit exceeded" });
          return false;
        }
        readTotal += stat.size;
        entries.push({ name: rel, data: fs.readFileSync(abs) });
      }
      return true;
    };
    walk(outDir, "");
    return entries;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function memoryEntries(fileName: string, bytes: Buffer, format: ArchiveExtractResult["format"]): MemoryEntry[] {
  if (format === "zip" || isZip(bytes)) return extractZipEntries(bytes);
  if (format === "tar") {
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return gunzipEntries(fileName, bytes);
    return parseTarEntries(bytes);
  }
  if (format === "gz") return gunzipEntries(fileName, bytes);
  if (format === "7z") return extract7zEntries(bytes);
  return [{ name: fileName, error: "формат архива не поддерживается" }];
}

function writeArchiveEntries(
  fileName: string,
  bytes: Buffer,
  targetDir: string,
  format: "tar" | "gz" | "7z",
): ArchiveExtractResult {
  fs.mkdirSync(targetDir, { recursive: true });
  const entries = memoryEntries(fileName, bytes, format);
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
    const abs = path.resolve(targetDir, rel);
    const root = path.resolve(targetDir);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      errors.push(`${rel}: escaped extract root`);
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, entry.data);
    files.push({ name: path.basename(rel), size: entry.data.length, relativePath: rel, absolutePath: abs });
  }
  return { ok: errors.length === 0, format, files, errors, skipped };
}

/** Read one file from an archive. Rejects paths that leave the archive. */
export function readArchiveMember(
  fileName: string,
  bytes: Buffer,
  memberPath: string,
): { ok: true; name: string; data: Buffer } | { ok: false; error: string } {
  const rel = memberPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const unsafe = unsafeName(rel);
  if (unsafe) return { ok: false, error: "Недопустимый путь внутри архива" };
  const format = detectArchiveFormat(fileName, bytes);
  if (format === "none" || format === "unsupported" || format === "rar") {
    return { ok: false, error: "Этот архив нельзя открыть для скачивания отдельного файла" };
  }
  const entries = memoryEntries(fileName, bytes, format);
  const hit = entries.find((entry) => !("error" in entry) && entry.name.replace(/\\/g, "/") === rel);
  if (!hit || "error" in hit) return { ok: false, error: "Файл в архиве не найден" };
  return { ok: true, name: path.basename(rel), data: hit.data };
}
