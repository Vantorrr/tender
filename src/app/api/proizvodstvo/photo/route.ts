import { readAppData } from "@/server/db";
import { readUpload } from "@/server/uploads";
import { withAnySection, json } from "@/server/http";
import { NextResponse } from "next/server";

/** Serve a daily-fact photo by id (org-scoped). */
export async function GET(req: Request) {
  return withAnySection(
    req,
    ["proizvodstvo", "zakupki"],
    async (user) => {
      const url = new URL(req.url);
      const id = url.searchParams.get("id");
      const disposition =
        url.searchParams.get("disposition") === "attachment"
          ? "attachment"
          : "inline";
      if (!id) return json({ error: "Не указан id фото" }, 400);
      const data = readAppData();
      let found: {
        fileName: string;
        storedPath?: string;
        orgId: string;
      } | null = null;
      for (const pf of data.planFacts) {
        if (user.role !== "superadmin" && pf.orgId !== user.orgId) continue;
        for (const d of pf.dailyFacts ?? []) {
          const ph = d.photos?.find((p) => p.id === id);
          if (ph) {
            found = {
              fileName: ph.fileName,
              storedPath: ph.storedPath,
              orgId: pf.orgId,
            };
            break;
          }
        }
        if (found) break;
      }
      if (!found) return json({ error: "Фото не найдено" }, 404);
      if (user.role !== "superadmin" && found.orgId !== user.orgId) {
        return json({ error: "Нет доступа" }, 403);
      }
      if (!found.storedPath) {
        return json({ error: "Файл не сохранён на диск" }, 404);
      }
      const buf = readUpload(found.storedPath);
      if (!buf) return json({ error: "Файл не найден на диске" }, 404);
      const lower = found.fileName.toLowerCase();
      const type = lower.endsWith(".png")
        ? "image/png"
        : lower.endsWith(".jpg") || lower.endsWith(".jpeg")
          ? "image/jpeg"
          : lower.endsWith(".webp")
            ? "image/webp"
            : lower.endsWith(".pdf")
              ? "application/pdf"
              : "application/octet-stream";
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: {
          "Content-Type": type,
          "Content-Disposition": `${disposition}; filename="${found.fileName}"`,
          "Cache-Control": "no-store",
        },
      });
    }
  );
}
