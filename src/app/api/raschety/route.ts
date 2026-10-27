import { getBootstrap, recalcCalculation, updateCalculation } from "@/server/repo";
import { withUser, json } from "@/server/http";
import type { Calculation } from "@/lib/types";

export async function GET(req: Request) {
  return withUser(req, (user) =>
    json({ items: getBootstrap(user).data.calculations })
  );
}

export async function PATCH(req: Request) {
  return withUser(req, async (user) => {
    const body = (await req.json()) as {
      id?: string;
      patch?: Partial<Calculation>;
      recalcScenario?: Calculation["scenario"];
    };
    if (!body.id) return json({ error: "Не указан id" }, 400);
    if (body.recalcScenario) {
      recalcCalculation(user.id, body.id, body.recalcScenario);
    } else if (body.patch) {
      updateCalculation(user.id, body.id, body.patch);
    } else {
      return json({ error: "Нет изменений" }, 400);
    }
    return json(getBootstrap(user));
  });
}
