import { getBootstrap, updatePlanFact } from "@/server/repo";
import { withUser, json } from "@/server/http";
import type { PlanFact } from "@/lib/types";

export async function GET(req: Request) {
  return withUser(req, (user) =>
    json({ items: getBootstrap(user).data.planFacts })
  );
}

export async function PATCH(req: Request) {
  return withUser(req, async (user) => {
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
