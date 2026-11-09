import {
  getBootstrap,
  shiftGprStage,
  updateSchedule,
} from "@/server/repo";
import { withAnySection, json } from "@/server/http";
import type { GprSchedule } from "@/lib/types";

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
      action?: "shiftStage";
      stageId?: string;
      deltaDays?: number;
      cascade?: boolean;
      resizeDays?: number | null;
    };
    if (!body.id) return json({ error: "Нужен id" }, 400);
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
    if (!body.patch) return json({ error: "Нужны id и patch" }, 400);
    updateSchedule(user.id, body.id, body.patch);
    return json(getBootstrap(user));
  });
}
