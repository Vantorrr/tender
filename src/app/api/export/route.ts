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
import { readAppData } from "@/server/db";
import { fileResponse, withUser, json } from "@/server/http";
import type { User } from "@/lib/types";

function assertExportOrg(user: User, orgId: string | undefined) {
  if (!orgId) return;
  if (user.role === "superadmin") return;
  if (orgId !== user.orgId) {
    throw new Error("Нет доступа к экспорту другой организации");
  }
}

export async function GET(req: Request) {
  return withUser(req, async (user) => {
    const { searchParams } = new URL(req.url);
    const kind = searchParams.get("kind");
    const id = searchParams.get("id") ?? "";
    const data = readAppData();

    if (kind === "calc-xlsx" || kind === "calc-pdf") {
      const calc = data.calculations.find((c) => c.id === id);
      if (!calc) return json({ error: "Расчёт не найден" }, 404);
      assertExportOrg(user, calc.orgId);
      if (kind === "calc-xlsx") {
        return fileResponse(
          await buildCalculationXlsx(id),
          `raschet-${id}.xlsx`,
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
      }
      return fileResponse(
        await buildCalculationPdf(id),
        `raschet-${id}.pdf`,
        "application/pdf"
      );
    }
    if (kind === "money-xlsx") {
      const plan = data.moneyPlans.find((m) => m.id === id);
      if (!plan) return json({ error: "План не найден" }, 404);
      assertExportOrg(user, plan.orgId);
      return fileResponse(
        await buildMoneyXlsx(id),
        `dengi-${id}.xlsx`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
    }
    if (kind === "gpr-xlsx") {
      const g = data.schedules.find((s) => s.id === id);
      if (!g) return json({ error: "ГПР не найден" }, 404);
      assertExportOrg(user, g.orgId);
      return fileResponse(
        await buildGprXlsx(id),
        `gpr-${id}.xlsx`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
    }
    if (kind === "risks-xlsx") {
      const r = data.risks.find((x) => x.id === id);
      if (!r) return json({ error: "Реестр не найден" }, 404);
      assertExportOrg(user, r.orgId);
      return fileResponse(
        await buildRisksXlsx(id),
        `riski-${id}.xlsx`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
    }
    if (kind === "planfact-xlsx") {
      const pf = data.planFacts.find((x) => x.id === id);
      if (!pf) return json({ error: "План/факт не найден" }, 404);
      assertExportOrg(user, pf.orgId);
      return fileResponse(
        await buildPlanFactXlsx(id),
        `plan-fact-${id}.xlsx`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
    }
    if (kind === "smeta-xlsx") {
      const calc = data.calculations.find((c) => c.id === (id || "c-1"));
      if (calc) assertExportOrg(user, calc.orgId);
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
    return json(
      {
        error: "Неизвестный kind",
        allowed: [
          "calc-xlsx",
          "calc-pdf",
          "money-xlsx",
          "gpr-xlsx",
          "risks-xlsx",
          "planfact-xlsx",
          "smeta-xlsx",
          "dir-template",
        ],
      },
      400
    );
  });
}
