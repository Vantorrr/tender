import {
  getBootstrap,
  importDirectoryRows,
  setDirectoryCurrent,
} from "@/server/repo";
import { withUser, json } from "@/server/http";
import type { AppData } from "@/lib/types";

export async function GET(req: Request) {
  return withUser(req, (user) =>
    json({ items: getBootstrap(user).data.directories })
  );
}

export async function POST(req: Request) {
  return withUser(req, async (user) => {
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
