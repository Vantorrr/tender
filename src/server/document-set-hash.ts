import { createHash } from "node:crypto";

export type DocumentSetMember = {
  id: string;
  fileName: string;
  fileSize?: number | null;
  storedPath?: string | null;
  uploadedAt?: string | null;
};

/** Stable identity of the files attached to a procurement. Content text is not hashed. */
export function documentSetHash(documents: readonly DocumentSetMember[]): string {
  const lines = documents
    .map((document) => [document.id, document.fileName, document.fileSize ?? "", document.storedPath ?? "", document.uploadedAt ?? ""].join("\u001f"))
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}
