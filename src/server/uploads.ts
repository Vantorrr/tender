import fs from "node:fs";
import path from "node:path";
import { config } from "@/server/config";

export function uploadsDir() {
  const dir = path.join(
    /*turbopackIgnore: true*/ config.dataDir,
    "uploads"
  );
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function safeFileName(name: string) {
  return name.replace(/[^\w.\-а-яА-ЯёЁ]+/gi, "_").slice(0, 120) || "file.bin";
}

export async function saveUpload(
  docId: string,
  fileName: string,
  bytes: Buffer
): Promise<{ storedPath: string; fileSize: number }> {
  const safe = safeFileName(fileName);
  const relative = path.join("uploads", `${docId}-${safe}`);
  const absolute = path.join(
    /*turbopackIgnore: true*/ config.dataDir,
    relative
  );
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, bytes);
  return { storedPath: relative, fileSize: bytes.length };
}

/** Only a file inside data/uploads. Absolute paths and `..` never resolve. */
export function resolveUploadPath(storedPath: string): string | null {
  if (!storedPath || storedPath.includes("\0") || storedPath.includes("..")) return null;
  if (path.isAbsolute(storedPath)) return null;
  const normalized = path.normalize(storedPath).replace(/\\/g, "/");
  if (!normalized.startsWith("uploads/") || normalized.endsWith("/")) return null;
  const root = path.resolve(uploadsDir());
  const absolute = path.resolve(/*turbopackIgnore: true*/ config.dataDir, normalized);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!absolute.startsWith(rootPrefix)) return null;
  return absolute;
}

/** Relative `uploads/...` path after the same checks as `resolveUploadPath`. Aliases collapse to one key. */
export function canonicalUploadPath(storedPath: string): string | null {
  const absolute = resolveUploadPath(storedPath);
  if (!absolute) return null;
  const relative = path.relative(path.resolve(/*turbopackIgnore: true*/ config.dataDir), absolute).split(path.sep).join("/");
  if (!relative.startsWith("uploads/") || relative.endsWith("/") || relative.includes("..")) return null;
  return relative;
}

export function deleteUpload(storedPath: string) {
  const absolute = resolveUploadPath(storedPath);
  if (!absolute || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return;
  fs.unlinkSync(absolute);
}

export function readUpload(storedPath: string): Buffer | null {
  const absolute = resolveUploadPath(storedPath);
  if (!absolute || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return null;
  return fs.readFileSync(absolute);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}
