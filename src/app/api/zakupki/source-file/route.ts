import { NextResponse } from "next/server";
import { withSection, json } from "@/server/http";
import { getBootstrap } from "@/server/repo";
import { config } from "@/server/config";
import { allowedNornickelFileUrl } from "@/server/procurement-source";

export const runtime = "nodejs";

const KONTUR_DOCUMENT_HOSTS = [
  "kontur.ru", "zakupki.gov.ru", "roseltorg.ru", "rts-tender.ru",
  "sberbank-ast.ru", "etp-ets.ru", "zakazrf.ru", "tektorg.ru",
  "fabrikant.ru", "lot-online.ru", "gz.lot-online.ru", "rosneft.ru",
];

function resolveAllowedSource(raw: string, kontur: boolean): URL | null {
  const nornickel = allowedNornickelFileUrl(raw);
  if (nornickel) return new URL(nornickel);
  try {
    const source = new URL(raw);
    if (
      kontur &&
      source.protocol === "https:" &&
      !source.port &&
      !source.username &&
      !source.password &&
      allowedKonturDocumentHost(source.hostname)
    ) return source;
  } catch {
    return null;
  }
  return null;
}

async function fetchAllowedSource(start: URL, kontur: boolean): Promise<Response> {
  let current = start;
  for (let hop = 0; hop < 3; hop += 1) {
    const response = await fetch(current, {
      signal: AbortSignal.timeout(30_000),
      redirect: "manual",
      cache: "no-store",
      headers: {
        "user-agent": "TMA361 procurement feed/1.0",
        accept: "*/*",
      },
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    const next = resolveAllowedSource(new URL(location, current).toString(), kontur);
    if (!next) throw new Error("Источник перенаправил на недоверенный адрес");
    current = next;
  }
  throw new Error("Слишком много перенаправлений источника");
}

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
    const found = procurement?.attachments.find((item) => item.id === body.attachmentId);
    const downloadable = procurement?.attachments.filter((item) => item.sourceUrl) ?? [];
    // A resync used to mint a new attachment id on every run, so an open card
    // posted a stale id and got 404 even though the file was still on the notice.
    const attachment = found?.sourceUrl
      ? found
      : !found && downloadable.length === 1
        ? downloadable[0]
        : found;
    if (!attachment?.sourceUrl) return json({ error: "Файл источника не найден" }, 404);

    const konturSource = procurement?.source === "Контур.Закупки API" &&
      Boolean(procurement.externalId) &&
      procurement.attachments.some((item) => item.id === attachment.id);
    const source = resolveAllowedSource(attachment.sourceUrl, Boolean(konturSource));
    if (!source) {
      return json({ error: attachment.sourceUrl.startsWith("http")
        ? "Для этой закупки скачивание с домена источника не разрешено"
        : "Некорректная ссылка на файл источника" }, 400);
    }

    try {
      const response = await fetchAllowedSource(source, Boolean(konturSource));
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
