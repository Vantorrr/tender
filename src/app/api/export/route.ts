import {
  buildCalculationPdf,
  buildCalculationXlsx,
  buildDirectoryTemplate,
  buildGprXlsx,
  buildMoneyXlsx,
  buildPlanFactXlsx,
  buildRisksXlsx,
  buildSmetaExportXlsx,
} from "@/server/export";
import { fileResponse, requireUser } from "@/server/http";
import { json } from "@/server/http";

export async function GET(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { searchParams } = new URL(req.url);
  const kind = searchParams.get("kind");
  const id = searchParams.get("id") ?? "";

  try {
    if (kind === "calc-xlsx") {
      return fileResponse(
        await buildCalculationXlsx(id),
        `raschet-${id}.xlsx`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
    }
    if (kind === "calc-pdf") {
      return fileResponse(
        await buildCalculationPdf(id),
        `raschet-${id}.pdf`,
        "application/pdf"
      );
    }
    if (kind === "money-xlsx") {
      return fileResponse(
        await buildMoneyXlsx(id),
        `dengi-${id}.xlsx`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
    }
    if (kind === "gpr-xlsx") {
      return fileResponse(
        await buildGprXlsx(id),
        `gpr-${id}.xlsx`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
    }
    if (kind === "risks-xlsx") {
      return fileResponse(
        await buildRisksXlsx(id),
        `riski-${id}.xlsx`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
    }
    if (kind === "planfact-xlsx") {
      return fileResponse(
        await buildPlanFactXlsx(id),
        `plan-fact-${id}.xlsx`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
    }
    if (kind === "smeta-xlsx") {
      return fileResponse(
        await buildSmetaExportXlsx(id || undefined),
        "export-smeta.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
    }
    if (kind === "dir-template") {
      const type = (searchParams.get("type") ?? "normy") as
        | "normy"
        | "rascenki"
        | "ceny"
        | "profil";
      return fileResponse(
        await buildDirectoryTemplate(type),
        `shablon-${type}.xlsx`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
    }
    return json({ error: "Неизвестный kind" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Ошибка экспорта" }, 400);
  }
}
