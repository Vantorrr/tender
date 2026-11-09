import {
  addCalcPositionFromDirectory,
  getBootstrap,
  recalcCalculation,
  recomputeCalculationCost,
  updateCalculation,
} from "@/server/repo";
import { withSection, json } from "@/server/http";
import type { Calculation } from "@/lib/types";

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
