import { NextResponse } from "next/server";
import { withSection, json } from "@/server/http";
import { getBootstrap } from "@/server/repo";
import { config } from "@/server/config";

export const runtime = "nodejs";

const KONTUR_DOCUMENT_HOSTS = [
  "kontur.ru", "zakupki.gov.ru", "roseltorg.ru", "rts-tender.ru",
  "sberbank-ast.ru", "etp-ets.ru", "zakazrf.ru", "tektorg.ru",
  "fabrikant.ru", "lot-online.ru", "gz.lot-online.ru", "rosneft.ru",
];

function allowedKonturDocumentHost(hostname: string) {
  const configured = (process.env.KONTUR_DOCUMENT_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const allowed = [...KONTUR_DOCUMENT_HOSTS, ...configured];
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** Fetch a linked public source document for the signed-in user's procurement. */
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
    const nornickelSource =
      (source.hostname === "nornickel.ru" && source.pathname.startsWith("/upload/")) ||
      (source.hostname === "nornik-upload.storage.yandexcloud.net" && source.pathname.startsWith("/iblock/"));
    const konturSource = procurement?.source === "Контур.Закупки API" &&
      Boolean(procurement.externalId) &&
      procurement.attachments.some((item) => item.id === attachment.id) &&
      allowedKonturDocumentHost(source.hostname);
    const allowedSource = source.protocol === "https:" && !source.port && !source.username && !source.password &&
      (nornickelSource || konturSource);
    if (!allowedSource) {
      return json({ error: "Для этой закупки скачивание с домена источника не разрешено" }, 400);
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
      if (!response.body) return json({ error: "Источник вернул пустой файл" }, 502);
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const part = Buffer.from(value);
          totalBytes += part.length;
          if (totalBytes > config.maxUploadBytes) {
            await reader.cancel();
            return json({ error: "Файл превышает лимит загрузки приложения" }, 413);
          }
          chunks.push(part);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = Buffer.concat(chunks, totalBytes);
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
