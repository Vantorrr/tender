import {
  createDocument,
  getBootstrap,
  refreshProcurementAnalytics,
  updateDocument,
} from "@/server/repo";
import { analyzeUpload } from "@/server/grand-smeta";
import { config } from "@/server/config";
import {
  archiveExtractDir,
  detectArchiveFormat,
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
  if (/tz|тз|извещ/i.test(fileName)) return "tz";
  if (/\.zip$/i.test(fileName)) return "archive";
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
        const extracted = extractArchiveSafely(
          file.name,
          buf,
          archiveExtractDir(tempId)
        );
        createDocument(user.id, {
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
        refreshProcurementAnalytics(user.id, procurementId);
        return json({
          ...getBootstrap(user),
          archive: {
            ok: extracted.ok,
            format: extracted.format,
            errors: extracted.errors,
            files: extracted.files.map((f) => f.name),
          },
        });
      }

      const fileType =
        ext === "docx" || ext === "xlsx" || ext === "pdf" ? ext : "pdf";
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
        const timedOut = /таймаут/i.test(message);
        return json({ error: message }, timedOut ? 504 : 422);
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
      refreshProcurementAnalytics(user.id, procurementId);
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
