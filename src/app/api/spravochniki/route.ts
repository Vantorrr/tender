import {
  getBootstrap,
  importDirectoryRows,
  setDirectoryCurrent,
} from "@/server/repo";
import { parseDirectoryXlsx } from "@/server/export";
import { withUser, json } from "@/server/http";
import type { AppData } from "@/lib/types";

export async function GET(req: Request) {
  return withUser(req, (user) =>
    json({ items: getBootstrap(user).data.directories })
  );
}

export async function POST(req: Request) {
  return withUser(req, async (user) => {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      const type = String(form.get("type") ?? "normy") as AppData["directories"][0]["type"];
      if (!(file instanceof File)) {
        return json({ error: "Файл не передан" }, 400);
      }
      const buf = Buffer.from(await file.arrayBuffer());
      const rows = await parseDirectoryXlsx(buf);
      if (rows.length === 0) {
        return json({ error: "В файле нет строк данных" }, 400);
      }
      importDirectoryRows(user.id, type, rows);
      return json(getBootstrap(user));
    }

    const body = (await req.json()) as {
      action?: "setCurrent" | "import";
      id?: string;
      type?: AppData["directories"][0]["type"];
      rows?: Record<string, string | number>[];
    };
    if (body.action === "setCurrent" && body.id) {
      setDirectoryCurrent(user.id, body.id);
    } else if (body.action === "import" && body.type && body.rows) {
      importDirectoryRows(user.id, body.type, body.rows);
    } else {
      return json({ error: "Некорректный запрос справочника" }, 400);
    }
    return json(getBootstrap(user));
  });
}
