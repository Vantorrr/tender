export type UploadQueueError = { name: string; message: string };

/**
 * Upload many files without putting every body in one request.
 * A few run at once; each file still hits the existing per-file limit.
 */
export async function runUploadQueue(
  files: File[],
  upload: (file: File) => Promise<void>,
  opts?: { concurrency?: number; onProgress?: (done: number, total: number) => void },
): Promise<{ uploaded: number; errors: UploadQueueError[] }> {
  const list = files.filter((file) => file.size > 0 && !file.name.startsWith("."));
  const total = list.length;
  const errors: UploadQueueError[] = [];
  let cursor = 0;
  let done = 0;
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 4, 5, Math.max(total, 1)));
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      const file = list[index]!;
      try {
        await upload(file);
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
  if (total === 0) {
    opts?.onProgress?.(0, 0);
    return { uploaded: 0, errors };
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { uploaded: total - errors.length, errors };
}
