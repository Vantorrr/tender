import { readAppData } from "@/server/db";
import { readUpload } from "@/server/uploads";
import { withAnySection, json } from "@/server/http";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  return withAnySection(req, ["dokumenty", "zakupki", "riski"], async (user) => {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    const disposition =
      url.searchParams.get("disposition") === "inline" ? "inline" : "attachment";
    if (!id) return json({ error: "Не указан id" }, 400);
    const data = readAppData();
    const doc = data.documents.find((d) => d.id === id);
    if (!doc) return json({ error: "Документ не найден" }, 404);
    if (user.role !== "superadmin" && doc.orgId !== user.orgId) {
      return json({ error: "Нет доступа к данным другой организации" }, 403);
    }
    if (!doc.storedPath) {
      const stub = Buffer.from(
        `истройка\nДокумент: ${doc.title}\nФайл: ${doc.fileName}\nОригинал файла будет доступен после загрузки новой версии.\n`,
        "utf8"
      );
      return new NextResponse(stub, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `${disposition}; filename="${doc.fileName}.txt"`,
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
          : doc.fileType === "docx"
            ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            : doc.fileType === "zip"
              ? "application/zip"
              : "application/octet-stream";
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": type,
        "Content-Disposition": `${disposition}; filename="${doc.fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  });
}
