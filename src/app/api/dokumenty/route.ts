import { createHash } from "node:crypto";
import {
  createDocument,
  getBootstrap,
  refreshProcurementAnalytics,
  updateDocument,
} from "@/server/repo";
import { archiveResultStatus, refreshAndMaybeAnalyzePackage } from "@/server/upload-package-analysis";
import { analyzeUpload } from "@/server/grand-smeta";
import { ingestArchiveMembers } from "@/server/archive-ingest";
import { config } from "@/server/config";
import {
  archiveExtractDir,
  detectArchiveFormat,
  extractRarArchiveSafely,
  extractArchiveSafely,
} from "@/server/safe-archive";
import { saveUpload } from "@/server/uploads";
import { withAnySection, json } from "@/server/http";
import type { DocumentCategory, DocumentItem } from "@/lib/types";

const DOC_SECTIONS = ["dokumenty", "zakupki", "riski"] as const;

function inferCategory(
  raw: string | null,
  fileName: string
): DocumentCategory {
  if (raw === "estimate" || raw === "contract" || raw === "tz" || raw === "archive" || raw === "other" || raw === "general") {
    return raw;
  }
  if (/smeta|смет/i.test(fileName)) return "estimate";
  if (/dogovor|договор|контракт/i.test(fileName)) return "contract";
  if (/tz|тз|извещ|техническ.{0,12}задан/i.test(fileName)) return "tz";
  if (/\.(zip|rar|7z|tar|gz|tgz)$/i.test(fileName) || /\.tar\.gz$/i.test(fileName)) return "archive";
  return "general";
}

export async function GET(req: Request) {
  return withAnySection(req, [...DOC_SECTIONS], (user) =>
    json({ items: getBootstrap(user).data.documents })
  );
}

export async function POST(req: Request) {
  return withAnySection(req, [...DOC_SECTIONS], async (user) => {
    const contentType = req.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      const procurementId = String(form.get("procurementId") ?? "");
      const category = inferCategory(
        String(form.get("category") ?? "") || null,
        file instanceof File ? file.name : ""
      );
      const wantLlm =
        String(form.get("useLlm") ?? "") === "1" ||
        String(form.get("useLlm") ?? "").toLowerCase() === "true";
      const useLlm = wantLlm && config.openRouterOnUpload;
      if (!procurementId) {
        return json({ error: "Укажите закупку" }, 400);
      }
      if (!(file instanceof File)) {
        return json({ error: "Файл не передан" }, 400);
      }
      if (file.size > config.maxUploadBytes) {
        return json(
          {
            error: `Файл слишком большой (лимит ${Math.round(config.maxUploadBytes / (1024 * 1024))} МБ)`,
          },
          413
        );
      }
      const ext = file.name.split(".").pop()?.toLowerCase();
      const buf = Buffer.from(await file.arrayBuffer());
      const archiveFormat = detectArchiveFormat(file.name, buf);

      if (archiveFormat !== "none") {
        const tempId = `d-${Date.now()}`;
        const stored = await saveUpload(tempId, file.name, buf);
        const extracted = archiveFormat === "rar"
          ? await extractRarArchiveSafely(file.name, buf, archiveExtractDir(tempId))
          : extractArchiveSafely(file.name, buf, archiveExtractDir(tempId));
        const archiveDoc = createDocument(user.id, {
          orgId: user.orgId,
          procurementId,
          title: String(form.get("title") ?? "").trim() || file.name,
          fileName: file.name,
          fileType: archiveFormat === "zip" ? "zip" : "other",
          category: "archive",
          storedPath: stored.storedPath,
          fileSize: stored.fileSize,
          extractionErrors: extracted.errors,
          extractedFiles: extracted.files.map((f) => ({
            name: f.name,
            size: f.size,
            relativePath: f.relativePath,
          })),
        });

        const { analyzedFiles, errors: childErrors } = await ingestArchiveMembers({
          userId: user.id,
          orgId: user.orgId,
          procurementId,
          files: extracted.files,
          useLlm,
          depth: 0,
          seenHashes: new Set([createHash("sha256").update(buf).digest("hex")]),
          budget: {
            files: extracted.files.length,
            bytes: extracted.files.reduce((sum, file) => sum + file.size, 0),
          },
          reuse: false,
        });
        const archiveErrors = [...extracted.errors, ...childErrors];
        updateDocument(user.id, archiveDoc.documentId, {
          extractionErrors: archiveErrors,
          status: archiveResultStatus(extracted.ok, archiveErrors),
        });
        await refreshAndMaybeAnalyzePackage(user.id, procurementId);
        return json({
          ...getBootstrap(user),
          archive: {
            ok: extracted.ok && childErrors.length === 0,
            format: extracted.format,
            errors: [...extracted.errors, ...childErrors],
            files: extracted.files.map((f) => f.name),
            analyzedFiles,
            documentId: archiveDoc.documentId,
          },
        });
      }

      const fileType =
        ext === "doc" || ext === "docx" || ext === "xlsx" || ext === "xls" || ext === "pdf" ? ext : "other";
      let prepared;
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Таймаут разбора документа")),
            config.analysisTimeoutMs
          );
        });
        try {
          prepared = await Promise.race([
            analyzeUpload(file.name, fileType, buf, { useLlm }),
            timeout,
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } catch (e) {
        const message =
          e instanceof Error ? e.message.slice(0, 200) : "ошибка разбора";
        // Preserve the user's original file even when extraction/OCR fails.
        // A parser outage should mark the document for review, not look like
        // the upload itself was rejected and discard the bytes.
        const tempId = `d-${Date.now()}`;
        const stored = await saveUpload(tempId, file.name, buf);
        createDocument(user.id, {
          orgId: user.orgId,
          procurementId,
          title: String(form.get("title") ?? "").trim() || file.name,
          fileName: file.name,
          fileType,
          category,
          storedPath: stored.storedPath,
          fileSize: stored.fileSize,
          extractionErrors: [message],
        });
        await refreshAndMaybeAnalyzePackage(user.id, procurementId);
        return json({
          ...getBootstrap(user),
          uploadWarning: `Файл сохранён, но не разобран: ${message}`,
        });
      }
      const title =
        String(form.get("title") ?? "").trim() || prepared.title;
      const tempId = `d-${Date.now()}`;
      const stored = await saveUpload(tempId, file.name, buf);
      createDocument(user.id, {
        orgId: user.orgId,
        procurementId,
        title,
        fileName: file.name,
        fileType,
        category,
        storedPath: stored.storedPath,
        fileSize: stored.fileSize,
        prepared,
      });
      await refreshAndMaybeAnalyzePackage(user.id, procurementId);
      return json(getBootstrap(user));
    }

    const body = (await req.json()) as {
      procurementId?: string;
      title?: string;
      fileName?: string;
      fileType?: DocumentItem["fileType"];
      category?: DocumentCategory;
    };
    if (!body.procurementId) {
      return json({ error: "Укажите закупку" }, 400);
    }
    if (!body.fileName) return json({ error: "Укажите имя файла" }, 400);
    createDocument(user.id, {
      orgId: user.orgId,
      procurementId: body.procurementId,
      title: body.title || body.fileName,
      fileName: body.fileName,
      fileType: body.fileType || "pdf",
      category: body.category ?? inferCategory(null, body.fileName),
    });
    refreshProcurementAnalytics(user.id, body.procurementId);
    return json(getBootstrap(user));
  });
}

export async function PATCH(req: Request) {
  return withAnySection(req, [...DOC_SECTIONS], async (user) => {
    const body = (await req.json()) as {
      id?: string;
      patch?: Partial<DocumentItem>;
    };
    if (!body.id || !body.patch) {
      return json({ error: "Нужны id и patch" }, 400);
    }
    updateDocument(user.id, body.id, body.patch);
    return json(getBootstrap(user));
  });
}
