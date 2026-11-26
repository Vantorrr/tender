/**
 * Nested archive walk shared by the first upload and a later re-extract.
 * Depth, size, file count, path traversal and archive cycles stay bounded.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  createDocument,
  reanalyzeDocument,
  updateDocument,
} from "@/server/repo";
import { assertOrgAccess } from "@/server/acl";
import { archiveResultStatus } from "@/server/upload-package-analysis";
import { analyzeUpload } from "@/server/grand-smeta";
import {
  archiveExtractDir,
  extractArchiveSafely,
  extractRarArchiveSafely,
  MAX_ARCHIVE_DEPTH,
  nestedArchiveDepthAllowed,
  type ArchiveExtractResult,
} from "@/server/safe-archive";
import { saveUpload } from "@/server/uploads";
import { readAppData } from "@/server/db";
import type { DocumentCategory, DocumentItem } from "@/lib/types";
import { isLegacyXlsName } from "@/server/xls-workbook";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp"]);
const TREE_FILE_CAP = 200;
const TREE_BYTE_CAP = 256 * 1024 * 1024;
const STALE_EXTRACT = /глубин|формат пока нельзя|формат не анализируется|не анализируется автоматически/i;

type ExtractedFile = ArchiveExtractResult["files"][number];

export type ArchiveIngestSummary = {
  analyzedFiles: Array<{ name: string; documentId: string; status: string }>;
  errors: string[];
};

type IngestBudget = { files: number; bytes: number };

function extensionOf(name: string): string {
  const base = name.split("/").pop() ?? name;
  return base.split(".").pop()?.toLowerCase() ?? "";
}

function isNestedArchiveName(name: string): boolean {
  return /\.(zip|rar|7z|tar|gz|tgz)$/i.test(name) || /\.tar\.gz$/i.test(name);
}

function inferCategory(raw: string | null, fileName: string): DocumentCategory {
  if (raw === "estimate" || raw === "contract" || raw === "tz" || raw === "archive" || raw === "other" || raw === "general") {
    return raw;
  }
  if (/smeta|смет/i.test(fileName)) return "estimate";
  if (/dogovor|договор|контракт/i.test(fileName)) return "contract";
  if (/tz|тз|извещ|техническ.{0,12}задан/i.test(fileName)) return "tz";
  if (isNestedArchiveName(fileName)) return "archive";
  return "general";
}

function documentFileType(fileName: string): DocumentItem["fileType"] {
  const ext = extensionOf(fileName);
  if (ext === "pdf" || ext === "doc" || ext === "docx" || ext === "xlsx" || ext === "xls" || ext === "zip") return ext;
  return "other";
}

function canAnalyze(fileName: string): boolean {
  const ext = extensionOf(fileName);
  return ext === "pdf" || ext === "doc" || ext === "docx" || ext === "xlsx" || ext === "xls" || ext === "xlsm" || IMAGE_EXTENSIONS.has(ext) || isLegacyXlsName(fileName);
}

function isStaleExtract(document: DocumentItem): boolean {
  return (document.extractionErrors ?? []).some((message) => STALE_EXTRACT.test(message))
    || STALE_EXTRACT.test(document.analyticalNote ?? "");
}

function existingMember(procurementId: string, fileName: string, size: number): DocumentItem | undefined {
  return readAppData().documents.find((document) =>
    document.procurementId === procurementId
    && document.fileName === fileName
    && (document.fileSize == null || document.fileSize === size)
  );
}

async function openArchive(name: string, bytes: Buffer, dir: string): Promise<ArchiveExtractResult> {
  const ext = extensionOf(name);
  if (ext === "rar") return extractRarArchiveSafely(name, bytes, dir);
  return extractArchiveSafely(name, bytes, dir);
}

export async function ingestArchiveMembers(input: {
  userId: string;
  orgId: string;
  procurementId: string;
  files: ExtractedFile[];
  useLlm: boolean;
  depth: number;
  seenHashes: Set<string>;
  budget: IngestBudget;
  reuse: boolean;
}): Promise<ArchiveIngestSummary> {
  const analyzedFiles: ArchiveIngestSummary["analyzedFiles"] = [];
  const errors: string[] = [];
  for (const extractedFile of input.files) {
    const childBytes = fs.readFileSync(extractedFile.absolutePath);
    const childId = `d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const prior = input.reuse
      ? existingMember(input.procurementId, extractedFile.name, childBytes.length)
      : undefined;
    if (prior && input.reuse && !isStaleExtract(prior)) {
      analyzedFiles.push({ name: extractedFile.relativePath, documentId: prior.id, status: "already_indexed" });
      continue;
    }
    if (isNestedArchiveName(extractedFile.name)) {
      const hash = createHash("sha256").update(childBytes).digest("hex");
      const overBudget = input.budget.files >= TREE_FILE_CAP || input.budget.bytes + childBytes.length > TREE_BYTE_CAP;
      let childExtracted: ArchiveExtractResult;
      if (input.seenHashes.has(hash)) {
        childExtracted = {
          ok: false,
          format: "unsupported",
          files: [],
          errors: ["Циклическая ссылка архива отклонена"],
          skipped: [],
        };
      } else if (!nestedArchiveDepthAllowed(input.depth)) {
        childExtracted = {
          ok: false,
          format: "unsupported",
          files: [],
          errors: [`Превышена максимальная глубина вложенных архивов (${MAX_ARCHIVE_DEPTH})`],
          skipped: [],
        };
      } else if (overBudget) {
        childExtracted = {
          ok: false,
          format: "unsupported",
          files: [],
          errors: ["Превышен общий лимит распаковки вложенных архивов"],
          skipped: [],
        };
      } else {
        childExtracted = await openArchive(extractedFile.name, childBytes, archiveExtractDir(prior?.id ?? childId));
        input.budget.files += childExtracted.files.length;
        input.budget.bytes += childExtracted.files.reduce((sum, file) => sum + file.size, 0);
      }
      const stored = prior?.storedPath
        ? { storedPath: prior.storedPath, fileSize: prior.fileSize ?? childBytes.length }
        : await saveUpload(childId, extractedFile.name, childBytes);
      const archiveId = prior?.id ?? createDocument(input.userId, {
        orgId: input.orgId,
        procurementId: input.procurementId,
        title: extractedFile.name,
        fileName: extractedFile.name,
        fileType: extensionOf(extractedFile.name) === "zip" ? "zip" : "other",
        category: "archive",
        storedPath: stored.storedPath,
        fileSize: stored.fileSize,
        extractionErrors: childExtracted.errors,
        extractedFiles: childExtracted.files.map((file) => ({
          name: file.name,
          size: file.size,
          relativePath: file.relativePath,
        })),
      }).documentId;
      analyzedFiles.push({
        name: extractedFile.relativePath,
        documentId: archiveId,
        status: childExtracted.ok ? "archive_extracted" : "archive_partial",
      });
      let nestedErrors: string[] = [];
      if (childExtracted.files.length) {
        const nextSeen = new Set(input.seenHashes);
        nextSeen.add(hash);
        const nested = await ingestArchiveMembers({
          ...input,
          files: childExtracted.files,
          depth: input.depth + 1,
          seenHashes: nextSeen,
        });
        analyzedFiles.push(...nested.analyzedFiles);
        nestedErrors = nested.errors;
        errors.push(...nested.errors);
      }
      const archiveErrors = [
        ...childExtracted.errors.map((message) => `${extractedFile.relativePath}: ${message}`),
        ...nestedErrors,
      ];
      errors.push(...childExtracted.errors.map((message) => `${extractedFile.relativePath}: ${message}`));
      updateDocument(input.userId, archiveId, {
        extractionErrors: archiveErrors,
        extractedFiles: childExtracted.files.map((file) => ({
          name: file.name,
          size: file.size,
          relativePath: file.relativePath,
        })),
        status: archiveResultStatus(childExtracted.ok, archiveErrors),
        category: "archive",
      });
      continue;
    }

    if (!canAnalyze(extractedFile.name)) {
      const stored = prior?.storedPath
        ? { storedPath: prior.storedPath, fileSize: prior.fileSize ?? childBytes.length }
        : await saveUpload(childId, extractedFile.name, childBytes);
      const reason = "Файл сохранён из архива; формат пока нельзя автоматически разобрать";
      const documentId = prior?.id ?? createDocument(input.userId, {
        orgId: input.orgId,
        procurementId: input.procurementId,
        title: extractedFile.name,
        fileName: extractedFile.name,
        fileType: "other",
        category: "general",
        storedPath: stored.storedPath,
        fileSize: stored.fileSize,
        extractionErrors: [reason],
      }).documentId;
      if (prior) {
        updateDocument(input.userId, documentId, { extractionErrors: [reason], status: "oshibka" });
      }
      errors.push(`${extractedFile.relativePath}: формат не анализируется автоматически`);
      analyzedFiles.push({ name: extractedFile.relativePath, documentId, status: "saved_without_analysis" });
      continue;
    }

    try {
      const ext = extensionOf(extractedFile.name);
      const prepared = await analyzeUpload(
        extractedFile.name,
        IMAGE_EXTENSIONS.has(ext) ? "other" : ext === "xlsm" ? "xlsx" : ext,
        childBytes,
        { useLlm: input.useLlm },
      );
      const stored = prior?.storedPath
        ? { storedPath: prior.storedPath, fileSize: prior.fileSize ?? childBytes.length }
        : await saveUpload(childId, extractedFile.name, childBytes);
      const fileType = documentFileType(extractedFile.name);
      if (prior) {
        reanalyzeDocument(input.userId, prior.id, prepared);
        updateDocument(input.userId, prior.id, {
          extractionErrors: [],
          status: prepared.status,
          fileType: IMAGE_EXTENSIONS.has(ext) ? "other" : fileType,
        });
        analyzedFiles.push({ name: extractedFile.relativePath, documentId: prior.id, status: "analyzed" });
      } else {
        const child = createDocument(input.userId, {
          orgId: input.orgId,
          procurementId: input.procurementId,
          title: prepared.title,
          fileName: extractedFile.name,
          fileType: IMAGE_EXTENSIONS.has(ext) ? "other" : fileType,
          category: inferCategory(null, extractedFile.name),
          storedPath: stored.storedPath,
          fileSize: stored.fileSize,
          prepared,
        });
        analyzedFiles.push({ name: extractedFile.relativePath, documentId: child.documentId, status: "analyzed" });
      }
      input.budget.files += 1;
      input.budget.bytes += childBytes.length;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 160) : "ошибка анализа";
      errors.push(`${extractedFile.relativePath}: ${message}`);
      if (!prior) {
        createDocument(input.userId, {
          orgId: input.orgId,
          procurementId: input.procurementId,
          title: extractedFile.name,
          fileName: extractedFile.name,
          fileType: documentFileType(extractedFile.name),
          category: inferCategory(null, extractedFile.name),
          extractionErrors: [message],
        });
      }
    }
  }
  return { analyzedFiles, errors };
}

/** Open an archive that is already stored and index members that the old depth cap skipped. */
export async function reextractStoredArchive(actorId: string, documentId: string): Promise<ArchiveIngestSummary> {
  const data = readAppData();
  const actor = data.users.find((user) => user.id === actorId);
  const document = data.documents.find((item) => item.id === documentId);
  if (!actor || actor.blocked) throw new Error("Пользователь не найден");
  if (!document) throw new Error("Документ не найден");
  assertOrgAccess(actor, document.orgId, "документа");
  if (!document.storedPath) throw new Error("Оригинальный файл недоступен");
  const { readUpload } = await import("@/server/uploads");
  const bytes = readUpload(document.storedPath);
  if (!bytes?.length) throw new Error("Файл не найден на диске");
  const { detectArchiveFormat } = await import("@/server/safe-archive");
  const format = detectArchiveFormat(document.fileName, bytes);
  if (format === "none") {
    return { analyzedFiles: [], errors: [] };
  }
  const extracted = await openArchive(document.fileName, bytes, archiveExtractDir(document.id));
  const seen = new Set<string>([createHash("sha256").update(bytes).digest("hex")]);
  const budget: IngestBudget = {
    files: extracted.files.length,
    bytes: extracted.files.reduce((sum, file) => sum + file.size, 0),
  };
  const nested = await ingestArchiveMembers({
    userId: actorId,
    orgId: document.orgId,
    procurementId: document.procurementId,
    files: extracted.files,
    useLlm: false,
    depth: 0,
    seenHashes: seen,
    budget,
    reuse: true,
  });
  const archiveErrors = [...extracted.errors, ...nested.errors];
  updateDocument(actorId, document.id, {
    extractionErrors: archiveErrors,
    extractedFiles: extracted.files.map((file) => ({
      name: file.name,
      size: file.size,
      relativePath: file.relativePath,
    })),
    status: archiveResultStatus(extracted.ok, archiveErrors),
    category: "archive",
  });
  return { analyzedFiles: nested.analyzedFiles, errors: archiveErrors };
}
