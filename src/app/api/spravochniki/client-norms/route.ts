import { getDb } from "@/server/db";
import {
  ensureClientNormCatalogs,
  listClientNormCatalogs,
  parseClientNormQuery,
  queryClientNormCatalog,
} from "@/server/client-norms";
import { json, withSection } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return withSection(req, "spravochniki", () => {
    const url = new URL(req.url);
    if (!url.searchParams.get("catalog")) {
      return json({
        catalogs: listClientNormCatalogs(getDb()),
        participatesInOfficialCost: false,
      });
    }
    let query;
    try {
      query = parseClientNormQuery(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Неизвестный справочник";
      return json({ error: message }, 400);
    }
    if (!query) return json({ error: "Не указан справочник" }, 400);
    try {
      return json(queryClientNormCatalog(getDb(), query));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Справочник не импортирован";
      const status = message.includes("не импортирован") ? 404 : 500;
      if (status === 500) throw error;
      return json({ error: message }, status);
    }
  });
}

export async function POST(req: Request) {
  return withSection(req, "spravochniki", async () => {
    const body = (await req.json().catch(() => null)) as { action?: string; force?: boolean } | null;
    if (!body || body.action !== "reimport") {
      return json({ error: "Укажите action: reimport" }, 400);
    }
    const report = ensureClientNormCatalogs(getDb(), { force: body.force === true });
    return json({
      ok: true,
      ...report,
      catalogs: listClientNormCatalogs(getDb()),
      participatesInOfficialCost: false,
    });
  });
}
