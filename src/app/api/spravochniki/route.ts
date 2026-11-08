import {
  getBootstrap,
  importDirectoryRows,
  setDirectoryCurrent,
} from "@/server/repo";
import { parseDirectoryXlsx } from "@/server/export";
import {
  parseDirectoryCsv,
  validateDirectoryImport,
  type DirectoryType,
} from "@/lib/directory-import";
import { withSection, json } from "@/server/http";
import type { AppData } from "@/lib/types";

export async function GET(req: Request) {
  return withSection(req, "spravochniki", (user) =>
    json({ items: getBootstrap(user).data.directories })
  );
}

export async function POST(req: Request) {
  return withSection(req, "spravochniki", async (user) => {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      const type = String(
        form.get("type") ?? "normy"
      ) as AppData["directories"][0]["type"];
      if (!(file instanceof File)) {
        return json({ error: "Файл не передан" }, 400);
      }
      const name = file.name.toLowerCase();
      const buf = Buffer.from(await file.arrayBuffer());
      let rows: Record<string, string | number>[] = [];
      if (name.endsWith(".csv") || name.endsWith(".txt")) {
        rows = parseDirectoryCsv(buf.toString("utf8"));
      } else if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) {
        rows = await parseDirectoryXlsx(buf);
      } else if (name.endsWith(".xls")) {
        return json(
          {
            error:
              "Формат .xls не поддерживается. Сохраните как .xlsx или .csv",
          },
          400
        );
      } else {
        return json(
          {
            error:
              "Неподдерживаемый формат. Допустимы: .xlsx, .xlsm, .csv",
          },
          400
        );
      }
      if (rows.length === 0) {
        return json({ error: "В файле нет строк данных" }, 400);
      }
      const validation = validateDirectoryImport(type as DirectoryType, rows);
      if (!validation.ok) {
        return json(
          {
            error: validation.errors.join("; "),
            validation,
          },
          400
        );
      }
      importDirectoryRows(user.id, type, rows);
      const boot = getBootstrap(user);
      return json({
        ...boot,
        importResult: {
          type,
          rows: rows.length,
          warnings: validation.warnings,
          // Explicit: user file import — never silent CLIENT_BUNDLE fallback
          source: "user_file",
        },
      });
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
      const validation = validateDirectoryImport(
        body.type as DirectoryType,
        body.rows
      );
      if (!validation.ok) {
        return json({ error: validation.errors.join("; "), validation }, 400);
      }
      importDirectoryRows(user.id, body.type, body.rows);
      return json({
        ...getBootstrap(user),
        importResult: {
          type: body.type,
          rows: body.rows.length,
          warnings: validation.warnings,
          source: "json_rows",
        },
      });
    } else {
      return json({ error: "Некорректный запрос справочника" }, 400);
    }
    return json(getBootstrap(user));
  });
}
