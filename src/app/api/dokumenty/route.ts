import { createDocument, getBootstrap, updateDocument } from "@/server/repo";
import { json, requireUser } from "@/server/http";
import type { DocumentItem } from "@/lib/types";

export async function GET() {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  return json({ items: getBootstrap(auth.user).data.documents });
}

export async function POST(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const body = (await req.json()) as {
    procurementId: string;
    title: string;
    fileName: string;
    fileType: "pdf" | "docx" | "xlsx";
  };
  createDocument(auth.user.id, {
    orgId: auth.user.orgId,
    procurementId: body.procurementId || "p-1",
    title: body.title || body.fileName,
    fileName: body.fileName,
    fileType: body.fileType || "pdf",
  });
  return json(getBootstrap(auth.user));
}

export async function PATCH(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const body = (await req.json()) as { id: string; patch: Partial<DocumentItem> };
  updateDocument(auth.user.id, body.id, body.patch);
  return json(getBootstrap(auth.user));
}
