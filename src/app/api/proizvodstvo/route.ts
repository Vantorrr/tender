import { getBootstrap, updatePlanFact } from "@/server/repo";
import { withSection, json } from "@/server/http";
import type { PlanFact } from "@/lib/types";

export async function GET(req: Request) {
  return withSection(req, "proizvodstvo", (user) =>
    json({ items: getBootstrap(user).data.planFacts })
  );
}

export async function PATCH(req: Request) {
  return withSection(req, "proizvodstvo", async (user) => {
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
