import {
  confirmSmetaExchange,
  getBootstrap,
  importSmetaExchange,
} from "@/server/repo";
import { parseSmetaXlsx } from "@/server/export";
import { withUser, json } from "@/server/http";
import { readAppData } from "@/server/db";

export async function GET(req: Request) {
  return withUser(req, (user) =>
    json({ items: getBootstrap(user).data.smetaExchanges })
  );
}

export async function POST(req: Request) {
  return withUser(req, async (user) => {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      const calcId = String(form.get("calcId") ?? "c-1");
      if (!(file instanceof File)) {
        return json({ error: "Файл не передан" }, 400);
      }
      const buf = Buffer.from(await file.arrayBuffer());
      const mapped = await parseSmetaXlsx(buf);
      const data = readAppData();
      const calc = data.calculations.find((c) => c.id === calcId);
      if (calc && user.role !== "superadmin" && calc.orgId !== user.orgId) {
        return json({ error: "Нет доступа к расчёту другой организации" }, 403);
      }
      const ours =
        calc?.positions.map((p) => ({ code: p.code, quantity: p.quantity })) ??
        [];
      importSmetaExchange(user.id, `Импорт ${file.name}`, mapped, ours);
      return json(getBootstrap(user));
    }

    const body = (await req.json()) as {
      action?: "confirm";
      id?: string;
    };
    if (body.action === "confirm" && body.id) {
      confirmSmetaExchange(user.id, body.id);
      return json(getBootstrap(user));
    }
    return json({ error: "Некорректный запрос обмена" }, 400);
  });
}
