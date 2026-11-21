import {
  addCalcPositionFromDirectory,
  getBootstrap,
  recalcCalculation,
  recomputeCalculationCost,
  updateCalculation,
  updateLinkedResourcesFromCalculation,
} from "@/server/repo";
import { withSection, json } from "@/server/http";
import type { Calculation, GprStage } from "@/lib/types";
import { analyzeCalculationComparisonWithAI } from "@/server/calc-compare-ai";
import { acceptVolumeDraft, draftVolumeSheet } from "@/server/volume-sheet";
import type { VolumeDraftRow } from "@/lib/wave23";

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
      linkedResources?: { stages: GprStage[] };
    };
    if (!body.id) return json({ error: "Не указан id" }, 400);
    let directoryRefresh: { matched: number; changed: number } | undefined;
    try {
      if (body.recalcScenario) {
        directoryRefresh = recalcCalculation(user.id, body.id, body.recalcScenario);
      } else if (body.recomputeCost) {
        recomputeCalculationCost(user.id, body.id, body.costPatch);
      } else if (body.addFromDirectory) {
        addCalcPositionFromDirectory(user.id, body.id, body.addFromDirectory);
      } else if (body.linkedResources) {
        updateLinkedResourcesFromCalculation(user.id, body.id, body.linkedResources.stages);
      } else if (body.patch) {
        updateCalculation(user.id, body.id, body.patch);
      } else {
        return json({ error: "Нет изменений" }, 400);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Ошибка расчёта";
      if (message.includes("Недостаточно прав") || message.startsWith("Нет доступа") || message.includes("Удалять закупку")) throw e;
      return json({ error: message }, 400);
    }
    return json({ ...getBootstrap(user), ...(directoryRefresh ? { directoryRefresh } : {}) });
  });
}

export async function POST(req: Request) {
  return withSection(req, "raschety", async (user) => {
    const body = (await req.json()) as { action?: string; calculationId?: string; rows?: VolumeDraftRow[] };
    if (body.action === "draftVolumes") {
      if (!body.calculationId) return json({ error: "Укажите расчёт" }, 400);
      try {
        return json(await draftVolumeSheet(user.id, body.calculationId));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Не удалось выделить ведомость" }, 400);
      }
    }
    if (body.action === "acceptVolumes") {
      if (!body.calculationId || !body.rows?.length) return json({ error: "Нет строк ведомости" }, 400);
      try {
        acceptVolumeDraft(user.id, body.calculationId, body.rows);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Не удалось сохранить ведомость";
        if (message.includes("Недостаточно прав") || message.startsWith("Нет доступа")) throw error;
        return json({ error: message }, 400);
      }
      return json(getBootstrap(user));
    }
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
