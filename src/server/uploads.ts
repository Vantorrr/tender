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

export function readUpload(storedPath: string): Buffer | null {
  if (!storedPath || storedPath.includes("..")) return null;
  const absolute = path.join(
    /*turbopackIgnore: true*/ config.dataDir,
    storedPath
  );
  if (!fs.existsSync(absolute)) return null;
  return fs.readFileSync(absolute);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}
