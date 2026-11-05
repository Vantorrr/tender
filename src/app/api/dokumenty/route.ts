import {
  createDocument,
  getBootstrap,
  updateDocument,
} from "@/server/repo";
import { analyzeUpload } from "@/server/grand-smeta";
import { saveUpload } from "@/server/uploads";
import { withUser, json } from "@/server/http";
import type { DocumentItem } from "@/lib/types";

export async function GET(req: Request) {
  return withUser(req, (user) =>
    json({ items: getBootstrap(user).data.documents })
  );
}

export async function POST(req: Request) {
  return withUser(req, async (user) => {
    const contentType = req.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      const procurementId = String(form.get("procurementId") ?? "");
      if (!procurementId) {
        return json({ error: "Укажите закупку" }, 400);
      }
      if (!(file instanceof File)) {
        return json({ error: "Файл не передан" }, 400);
      }
      const ext = file.name.split(".").pop()?.toLowerCase();
      const fileType =
        ext === "docx" || ext === "xlsx" || ext === "pdf" ? ext : "pdf";
      const buf = Buffer.from(await file.arrayBuffer());
      const prepared = await analyzeUpload(file.name, fileType, buf);
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
        storedPath: stored.storedPath,
        fileSize: stored.fileSize,
        prepared,
      });
      return json(getBootstrap(user));
    }

    const body = (await req.json()) as {
      procurementId?: string;
      title?: string;
      fileName?: string;
      fileType?: "pdf" | "docx" | "xlsx";
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
    });
    return json(getBootstrap(user));
  });
}

export async function PATCH(req: Request) {
  return withUser(req, async (user) => {
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
