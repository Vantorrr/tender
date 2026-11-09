import { NextResponse } from "next/server";
import { withSection, json } from "@/server/http";
import { getBootstrap } from "@/server/repo";
import { config } from "@/server/config";

export const runtime = "nodejs";

/** Fetch a linked public Nornickel attachment for the signed-in user's card. */
export async function POST(req: Request) {
  return withSection(req, "zakupki", async (user) => {
    const body = (await req.json()) as {
      procurementId?: string;
      attachmentId?: string;
    };
    if (!body.procurementId || !body.attachmentId) {
      return json({ error: "Не указана закупка или файл" }, 400);
    }
    const procurement = getBootstrap(user).data.procurements.find(
      (item) => item.id === body.procurementId && item.orgId === user.orgId
    );
    const attachment = procurement?.attachments.find(
      (item) => item.id === body.attachmentId
    );
    if (!attachment?.sourceUrl) return json({ error: "Файл источника не найден" }, 404);

    let source: URL;
    try {
      source = new URL(attachment.sourceUrl);
    } catch {
      return json({ error: "Некорректная ссылка на файл источника" }, 400);
    }
    if (
      source.protocol !== "https:" ||
      source.hostname !== "nornickel.ru" ||
      !source.pathname.startsWith("/upload/")
    ) {
      return json({ error: "Разрешены только файлы с публичного сайта «Норникеля»" }, 400);
    }

    try {
      const response = await fetch(source, {
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok) return json({ error: `Источник вернул HTTP ${response.status}` }, 502);
      const declaredSize = Number(response.headers.get("content-length") ?? 0);
      if (declaredSize > config.maxUploadBytes) {
        return json({ error: "Файл превышает лимит загрузки приложения" }, 413);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > config.maxUploadBytes) {
        return json({ error: "Файл превышает лимит загрузки приложения" }, 413);
      }
      return new NextResponse(new Uint8Array(bytes), {
        headers: {
          "Content-Type": response.headers.get("content-type") ?? "application/octet-stream",
          "Cache-Control": "no-store",
        },
      });
    } catch (error) {
      return json({
        error: `Не удалось скачать файл: ${error instanceof Error ? error.message : "ошибка источника"}`,
      }, 502);
    }
  });
}
