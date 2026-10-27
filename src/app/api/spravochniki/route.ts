import {
  getBootstrap,
  importDirectoryRows,
  setDirectoryCurrent,
} from "@/server/repo";
import { json, requireUser } from "@/server/http";
import type { AppData } from "@/lib/types";

export async function GET() {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  return json({ items: getBootstrap(auth.user).data.directories });
}

export async function POST(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const body = (await req.json()) as {
    action: "setCurrent" | "import";
    id?: string;
    type?: AppData["directories"][0]["type"];
    rows?: Record<string, string | number>[];
  };
  if (body.action === "setCurrent" && body.id) {
    setDirectoryCurrent(auth.user.id, body.id);
  } else if (body.action === "import" && body.type && body.rows) {
    importDirectoryRows(auth.user.id, body.type, body.rows);
  }
  return json(getBootstrap(auth.user));
}
