import { confirmSmetaExchange, getBootstrap, importSmetaExchange } from "@/server/repo";
import { parseSmetaXlsx } from "@/server/export";
import { json, requireUser } from "@/server/http";
import { readAppData } from "@/server/db";

export async function GET() {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  return json({ items: getBootstrap(auth.user).data.smetaExchanges });
}

export async function POST(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;

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
    const ours =
      calc?.positions.map((p) => ({ code: p.code, quantity: p.quantity })) ?? [];
    importSmetaExchange(
      auth.user.id,
      `Импорт ${file.name}`,
      mapped,
      ours
    );
    return json(getBootstrap(auth.user));
  }

  const body = (await req.json()) as {
    action?: "confirm";
    id?: string;
  };
  if (body.action === "confirm" && body.id) {
    confirmSmetaExchange(auth.user.id, body.id);
  }
  return json(getBootstrap(auth.user));
}
