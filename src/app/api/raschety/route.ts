import {
  addCalcPositionFromDirectory,
  getBootstrap,
  recalcCalculation,
  recomputeCalculationCost,
  updateCalculation,
} from "@/server/repo";
import { withSection, json } from "@/server/http";
import type { Calculation } from "@/lib/types";
import { analyzeCalculationComparisonWithAI } from "@/server/calc-compare-ai";

export async function GET(req: Request) {
  return withSection(req, "raschety", (user) =>
    json({ items: getBootstrap(user).data.calculations })
  );
}

export async function PATCH(req: Request) {
  return withSection(req, "raschety", async (user) => {
    const body = (await req.json()) as {
      id?: string;
      patch?: Partial<Calculation>;
      recalcScenario?: Calculation["scenario"];
      recomputeCost?: boolean;
      costPatch?: Parameters<typeof recomputeCalculationCost>[2];
      addFromDirectory?: {
        type: "rascenki" | "ceny" | "park";
        code: string;
        quantity?: number;
        rateKey?: string;
      };
    };
    if (!body.id) return json({ error: "Не указан id" }, 400);
    try {
      if (body.recalcScenario) {
        recalcCalculation(user.id, body.id, body.recalcScenario);
      } else if (body.recomputeCost) {
        recomputeCalculationCost(user.id, body.id, body.costPatch);
      } else if (body.addFromDirectory) {
        addCalcPositionFromDirectory(user.id, body.id, body.addFromDirectory);
      } else if (body.patch) {
        updateCalculation(user.id, body.id, body.patch);
      } else {
        return json({ error: "Нет изменений" }, 400);
      }
    } catch (e) {
      return json(
        { error: e instanceof Error ? e.message : "Ошибка расчёта" },
        400
      );
    }
    return json(getBootstrap(user));
  });
}

export async function POST(req: Request) {
  return withSection(req, "raschety", async (user) => {
    const body = (await req.json()) as { action?: string; calculationId?: string };
    if (body.action !== "analyzeCompare" || !body.calculationId) {
      return json({ error: "Укажите действие и расчёт" }, 400);
    }
    const calculations = getBootstrap(user).data.calculations;
    const current = calculations.find((item) => item.id === body.calculationId);
    if (!current) return json({ error: "Расчёт не найден" }, 404);
    const paired = current.pairedCalculationId
      ? calculations.find((item) => item.id === current.pairedCalculationId)
      : calculations.find((item) =>
          item.procurementId === current.procurementId &&
          item.id !== current.id &&
          item.kind !== current.kind
        );
    if (!paired || paired.procurementId !== current.procurementId) {
      return json({ error: "Нужна исходная смета и черновик этого проекта" }, 400);
    }
    const original = current.kind === "customer_original" ? current : paired;
    const draft = current.kind === "resource_draft" ? current : paired;
    if (original.kind !== "customer_original" || draft.kind !== "resource_draft") {
      return json({ error: "Можно сравнить только смету заказчика и ресурсный черновик" }, 400);
    }
    try {
      return json({ report: await analyzeCalculationComparisonWithAI(original, draft) });
    } catch {
      return json({ error: "Не удалось получить AI-комментарий к сравнению" }, 502);
    }
  });
}
