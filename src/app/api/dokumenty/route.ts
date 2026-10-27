import { createDocument, getBootstrap, updateDocument } from "@/server/repo";
import { withUser, json } from "@/server/http";
import type { DocumentItem } from "@/lib/types";

export async function GET(req: Request) {
  return withUser(req, (user) =>
    json({ items: getBootstrap(user).data.documents })
  );
}

export async function POST(req: Request) {
  return withUser(req, async (user) => {
    const body = (await req.json()) as {
      procurementId?: string;
      title?: string;
      fileName?: string;
      fileType?: "pdf" | "docx" | "xlsx";
    };
    if (!body.fileName) return json({ error: "Укажите имя файла" }, 400);
    createDocument(user.id, {
      orgId: user.orgId,
      procurementId: body.procurementId || "p-1",
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
