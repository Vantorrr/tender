import { readAppData } from "@/server/db";
import { readUpload } from "@/server/uploads";
import { withUser, json } from "@/server/http";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  return withUser(req, async (user) => {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return json({ error: "Не указан id" }, 400);
    const data = readAppData();
    const doc = data.documents.find((d) => d.id === id);
    if (!doc) return json({ error: "Документ не найден" }, 404);
    if (user.role !== "superadmin" && doc.orgId !== user.orgId) {
      return json({ error: "Нет доступа к данным другой организации" }, 403);
    }
    if (!doc.storedPath) {
      // seed docs without blob — отдаём текстовый stub
      const stub = Buffer.from(
        `истройка stub\nДокумент: ${doc.title}\nФайл: ${doc.fileName}\n(оригинал не хранился в демо-seed)\n`,
        "utf8"
      );
      return new NextResponse(stub, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="${doc.fileName}.txt"`,
          "Cache-Control": "no-store",
        },
      });
    }
    const buf = readUpload(doc.storedPath);
    if (!buf) return json({ error: "Файл не найден на диске" }, 404);
    const type =
      doc.fileType === "pdf"
        ? "application/pdf"
        : doc.fileType === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": type,
        "Content-Disposition": `attachment; filename="${doc.fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  });
}
