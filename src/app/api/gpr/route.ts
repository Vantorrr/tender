import {
  getBootstrap,
  patchScheduleResourceAndSync,
  shiftGprStage,
  updateSchedule,
} from "@/server/repo";
import { withAnySection, json } from "@/server/http";
import type { GprSchedule } from "@/lib/types";
import type { GprStageResource, ResourceQuantityBasis } from "@/lib/types";

const SECTIONS = ["gpr", "zakupki", "raschety"] as const;

export async function GET(req: Request) {
  return withAnySection(req, [...SECTIONS], (user) =>
    json({ items: getBootstrap(user).data.schedules })
  );
}

export async function PATCH(req: Request) {
  return withAnySection(req, [...SECTIONS], async (user) => {
    const body = (await req.json()) as {
      id?: string;
      patch?: Partial<GprSchedule>;
      action?: "shiftStage" | "patchResource";
      stageId?: string;
      deltaDays?: number;
      cascade?: boolean;
      resizeDays?: number | null;
      resourceId?: string;
      name?: string;
      unit?: string;
      kind?: GprStageResource["kind"];
      quantity?: number;
      rate?: number | null;
      hoursPerShift?: number | null;
      shiftsPerDay?: number | null;
      days?: number | null;
      quantityBasis?: ResourceQuantityBasis | null;
    };
    if (!body.id) return json({ error: "Нужен id" }, 400);
    try {
      if (body.action === "shiftStage") {
        if (!body.stageId || body.deltaDays == null) {
          return json({ error: "Нужны stageId и deltaDays" }, 400);
        }
        shiftGprStage(user.id, body.id, body.stageId, body.deltaDays, {
          cascade: body.cascade,
          resizeDays: body.resizeDays,
        });
        return json(getBootstrap(user));
      }
      if (body.action === "patchResource") {
        if (!body.resourceId) {
          return json({ error: "Нужен resourceId" }, 400);
        }
        patchScheduleResourceAndSync(user.id, body.id, {
          resourceId: body.resourceId,
          stageId: body.stageId,
          name: body.name,
          unit: body.unit,
          kind: body.kind,
          quantity: body.quantity,
          rate: body.rate,
          hoursPerShift: body.hoursPerShift,
          shiftsPerDay: body.shiftsPerDay,
          days: body.days,
          quantityBasis: body.quantityBasis,
        });
        return json(getBootstrap(user));
      }
      if (!body.patch) return json({ error: "Нужны id и patch" }, 400);
      updateSchedule(user.id, body.id, body.patch);
      return json(getBootstrap(user));
    } catch (e) {
      return json(
        { error: e instanceof Error ? e.message : "Ошибка ГПР" },
        400
      );
    }
  });
}
