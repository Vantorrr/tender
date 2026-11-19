export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function uploadTooLargeMessage(limitBytes = DEFAULT_MAX_UPLOAD_BYTES): string {
  return `Файл слишком большой (лимит ${Math.round(limitBytes / (1024 * 1024))} МБ)`;
}
