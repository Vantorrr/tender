import {
  addDailyProductionFact,
  getBootstrap,
  transferProcurementToProduction,
  updateProductionSupplyReceipt,
  updatePlanFact,
} from "@/server/repo";
import { withAnySection, json } from "@/server/http";
import type { DailyResourceLine, PlanFact } from "@/lib/types";
import type { SupplyStatus } from "@/lib/types";
import { saveUpload } from "@/server/uploads";
import { analyzeProductionVarianceWithAI } from "@/server/production-variance-ai";
import { allocatePlanForSlice, stagesForWork, type PlanSliceMode } from "@/lib/plan-from-gpr";
import { entryDisplayFact, sumDailyQty } from "@/lib/plan-fact-agg";

const SECTIONS = ["proizvodstvo", "zakupki"] as const;

function parseResourceLines(raw: unknown): DailyResourceLine[] | undefined | null {
  if (raw == null || raw === "") return undefined;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  const lines: DailyResourceLine[] = [];
  const kinds = new Set(["labor", "material", "equipment", "bus", "other"]);
  for (const row of parsed) {
    if (!row || typeof row !== "object") return null;
    const r = row as Record<string, unknown>;
    const kind = String(r.kind ?? "other");
    const name = String(r.name ?? "").trim();
    const unit = String(r.unit ?? "").trim();
    const planQty = Number(r.planQty);
    const factQty = r.factQty == null || r.factQty === "" ? null : Number(r.factQty);
    const sourceResourceId = r.sourceResourceId == null || r.sourceResourceId === ""
      ? undefined
      : String(r.sourceResourceId);
    if (
      !kinds.has(kind) ||
      !name ||
      !unit ||
      !Number.isFinite(planQty) ||
      planQty < 0 ||
      (factQty != null && (!Number.isFinite(factQty) || factQty < 0))
    ) return null;
    lines.push({
      kind: kind as DailyResourceLine["kind"],
      sourceResourceId,
      name,
      unit,
      planQty,
      factQty,
    });
  }
  return lines;
}

export async function GET(req: Request) {
  return withAnySection(req, [...SECTIONS], (user) =>
    json({ items: getBootstrap(user).data.planFacts })
  );
}

export async function PATCH(req: Request) {
  return withAnySection(req, [...SECTIONS], async (user) => {
    const body = (await req.json()) as {
      id?: string;
      patch?: Partial<PlanFact>;
    };
    if (!body.id || !body.patch) {
      return json({ error: "Нужны id и patch" }, 400);
    }
    updatePlanFact(user.id, body.id, body.patch);
    return json(getBootstrap(user));
  });
}

export async function POST(req: Request) {
  return withAnySection(req, [...SECTIONS], async (user) => {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const planFactId = String(form.get("planFactId") ?? "");
      const date = String(form.get("date") ?? "");
      const workName = String(form.get("workName") ?? "");
      const unit = String(form.get("unit") ?? "ед");
      const quantity = Number(form.get("quantity") ?? 0);
      const factId = String(form.get("factId") ?? "") || undefined;
      if (!planFactId || !date || !workName) {
        return json({ error: "Нужны planFactId, date, workName" }, 400);
      }
      if (!Number.isFinite(quantity) || quantity < 0) {
        return json({ error: "Факт работы должен быть неотрицательным числом" }, 400);
      }
      const resourceLines = parseResourceLines(form.get("resourceLines"));
      if (resourceLines === null) {
        return json({ error: "Проверьте фактические количества ресурсов: значения должны быть неотрицательными числами" }, 400);
      }
      const photos: Array<{
        id: string;
        fileName: string;
        storedPath?: string;
        at: string;
        caption?: string;
      }> = [];
      const file = form.get("photo");
      if (file instanceof File && file.size > 0) {
        const buf = Buffer.from(await file.arrayBuffer());
        const id = `ph-${Date.now()}`;
        const stored = await saveUpload(id, file.name, buf);
        photos.push({
          id,
          fileName: file.name,
          storedPath: stored.storedPath,
          at: new Date().toISOString(),
          caption: String(form.get("caption") ?? "") || undefined,
        });
      }
      addDailyProductionFact(user.id, planFactId, {
        date,
        workName,
        unit,
        quantity,
        factId,
        people: form.get("people") ? Number(form.get("people")) : undefined,
        equipment: String(form.get("equipment") ?? "") || undefined,
        materialsNote: String(form.get("materialsNote") ?? "") || undefined,
        resourceLines,
        comment:
          String(form.get("comment") ?? form.get("caption") ?? "") ||
          undefined,
        photos,
      });
      return json(getBootstrap(user));
    }

    const body = (await req.json()) as {
      action?: "transferToProduction" | "dailyFact" | "analyzeVariance" | "updateSupplyReceipt";
      procurementId?: string;
      planFactId?: string;
      supplyId?: string;
      qtyDelivered?: number;
      supplyStatus?: SupplyStatus;
      period?: PlanSliceMode;
      date?: string;
      workName?: string;
      fact?: {
        date: string;
        workName: string;
        unit: string;
        quantity: number;
        people?: number;
        equipment?: string;
        materialsNote?: string;
        resourceLines?: DailyResourceLine[];
        comment?: string;
        factId?: string;
      };
    };
    if (body.action === "updateSupplyReceipt") {
      if (!user.sections.includes("proizvodstvo") && user.role !== "superadmin") {
        return json({ error: "Недостаточно прав для производства" }, 403);
      }
      if (!body.planFactId || !body.supplyId || body.qtyDelivered == null) {
        return json({ error: "Нужны план/факт, материал и количество поставки" }, 400);
      }
      const qtyDelivered = Number(body.qtyDelivered);
      if (!Number.isFinite(qtyDelivered) || qtyDelivered < 0) {
        return json({ error: "Количество поставки должно быть неотрицательным числом" }, 400);
      }
      const allowedStatuses: SupplyStatus[] = ["need", "quoted_draft", "ordered", "in_transit", "delivered", "accepted", "cancelled"];
      if (body.supplyStatus && !allowedStatuses.includes(body.supplyStatus)) {
        return json({ error: "Неизвестный статус поставки" }, 400);
      }
      updateProductionSupplyReceipt(user.id, {
        planFactId: body.planFactId,
        supplyId: body.supplyId,
        qtyDelivered,
        status: body.supplyStatus,
      });
      return json(getBootstrap(user));
    }
    if (body.action === "analyzeVariance") {
      if (!user.sections.includes("proizvodstvo")) {
        return json({ error: "Недостаточно прав для производства" }, 403);
      }
      if (!body.planFactId || !body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
        return json({ error: "Нужны план/факт и корректная дата" }, 400);
      }
      const data = getBootstrap(user).data;
      const plan = data.planFacts.find((item) => item.id === body.planFactId && item.orgId === user.orgId);
      if (!plan) return json({ error: "План/факт не найден" }, 404);
      if (!body.workName?.trim()) return json({ error: "Выберите вид работ для сверки с ГПР" }, 400);
      const matchingEntries = plan.entries.filter((entry) => entry.workName.trim() === body.workName!.trim());
      if (matchingEntries.length !== 1) {
        return json({ error: matchingEntries.length ? "Название работы повторяется; выберите однозначную позицию" : "Вид работ не найден в плане/факте" }, 422);
      }
      const entry = matchingEntries[0];
      const period: PlanSliceMode = ["day", "month", "period", "cum"].includes(body.period ?? "")
        ? body.period!
        : "day";
      const daily = plan.dailyFacts ?? [];
      const factsForPeriod = period === "day"
        ? daily.filter((fact) => fact.date === body.date)
        : period === "month"
          ? daily.filter((fact) => fact.date.startsWith(body.date!.slice(0, 7)))
          : period === "period"
            ? daily
            : daily.filter((fact) => fact.date <= body.date!);
      const gpr = data.schedules.find((schedule) => schedule.procurementId === plan.procurementId);
      const workStages = stagesForWork(plan.entries.map((item) => item.workName), gpr?.stages ?? [], entry.workName);
      if (!workStages.length) {
        return json({ error: "Для этой работы нет связанных этапов ГПР. Свяжите работу и этап в графике." }, 422);
      }
      const factQuantity = period === "cum"
        ? entryDisplayFact(entry, daily)
        : sumDailyQty(factsForPeriod, { workName: entry.workName });
      const periodPlan = allocatePlanForSlice(entry.plan, workStages, period, body.date);
      const report = await analyzeProductionVarianceWithAI({
        plan,
        supplies: (data.supplyRequests ?? []).filter((supply) =>
          supply.procurementId === plan.procurementId && (!supply.workName || supply.workName === entry.workName)
        ),
        asOfDate: body.date,
        periodLabel: period,
        planQuantity: periodPlan.plan,
        factQuantity,
        planSource: periodPlan.source,
        workName: entry.workName,
      });
      return json({ report });
    }
    if (body.action === "transferToProduction" && body.procurementId) {
      transferProcurementToProduction(user.id, body.procurementId);
      return json(getBootstrap(user));
    }
    if (body.action === "dailyFact" && body.planFactId && body.fact) {
      if (!Number.isFinite(body.fact.quantity) || body.fact.quantity < 0) {
        return json({ error: "Факт работы должен быть неотрицательным числом" }, 400);
      }
      const resourceLines = body.fact.resourceLines == null
        ? undefined
        : parseResourceLines(body.fact.resourceLines);
      if (resourceLines === null) {
        return json({ error: "Проверьте фактические количества ресурсов: значения должны быть неотрицательными числами" }, 400);
      }
      addDailyProductionFact(user.id, body.planFactId, {
        ...body.fact,
        resourceLines,
      });
      return json(getBootstrap(user));
    }
    return json({ error: "Некорректный запрос" }, 400);
  });
}
