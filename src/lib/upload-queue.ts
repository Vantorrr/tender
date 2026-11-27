export type UploadQueueNote = { name: string; message: string };

export type UploadQueueResult = {
  uploaded: number;
  errors: UploadQueueNote[];
  /** Saved files whose local parse was incomplete. */
  warnings: UploadQueueNote[];
  /** Never uploaded: empty or junk names. */
  skipped: UploadQueueNote[];
};

export function uploadBatchLabel(result: UploadQueueResult, prefix = ""): { tone: "success" | "warning"; text: string } {
  const selected = result.uploaded + result.errors.length + result.skipped.length;
  const head = `${prefix}Загружено ${result.uploaded} из ${selected}.`.trim();
  const parts = [head];
  if (result.errors.length) parts.push(`Ошибок: ${result.errors.length}.`);
  if (result.skipped.length) parts.push(`Пропущено пустых и служебных: ${result.skipped.length}.`);
  if (result.warnings.length) parts.push(`${result.warnings.length} файл(ов) сохранены, но не разобраны.`);
  return {
    tone: result.errors.length || result.skipped.length || result.warnings.length ? "warning" : "success",
    text: parts.join(" "),
  };
}

/**
 * Upload many files without putting every body in one request.
 * A few run at once; each file still hits the existing per-file limit.
 * A returned warning means the file was saved. Only a thrown error is a failed upload.
 */
const DEFAULT_FILE_TIMEOUT_MS = 90_000;

function skippedReason(file: File): string | null {
  const base = file.name.split("/").pop() ?? file.name;
  if (!file.size) return "Пустой файл пропущен";
  if (base.startsWith(".") || base.toLowerCase() === "thumbs.db" || base.toLowerCase() === "desktop.ini") {
    return "Служебный файл пропущен";
  }
  return null;
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Таймаут загрузки «${label}»`)), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function runUploadQueue(
  files: File[],
  upload: (file: File) => Promise<void | { warning?: string }>,
  opts?: { concurrency?: number; timeoutMs?: number; onProgress?: (done: number, total: number) => void },
): Promise<UploadQueueResult> {
  const total = files.length;
  const errors: UploadQueueNote[] = [];
  const warnings: UploadQueueNote[] = [];
  const skipped: UploadQueueNote[] = [];
  const list = files.filter((file) => {
    const reason = skippedReason(file);
    if (!reason) return true;
    skipped.push({ name: file.name, message: reason });
    return false;
  });
  let cursor = 0;
  let done = total - list.length;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_FILE_TIMEOUT_MS;
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 4, 5, Math.max(list.length, 1)));
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      const file = list[index]!;
      try {
        const outcome = await withTimeout(upload(file), timeoutMs, file.name);
        if (outcome?.warning) warnings.push({ name: file.name, message: outcome.warning });
      } catch (error) {
        errors.push({
          name: file.name,
          message: error instanceof Error ? error.message : "Ошибка загрузки",
        });
      } finally {
        done += 1;
        opts?.onProgress?.(done, total);
      }
    }
  }
  opts?.onProgress?.(done, total);
  if (list.length === 0) return { uploaded: 0, errors, warnings, skipped };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { uploaded: list.length - errors.length, errors, warnings, skipped };
}
