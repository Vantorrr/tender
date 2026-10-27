import { getBootstrap, updatePlanFact } from "@/server/repo";
import { json, requireUser } from "@/server/http";
import type { PlanFact } from "@/lib/types";

export async function GET() {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const boot = getBootstrap(auth.user);
  return json({ items: boot.data.planFacts, objects: boot.data.objects });
}

export async function PATCH(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const body = (await req.json()) as { id: string; patch: Partial<PlanFact> };
  updatePlanFact(auth.user.id, body.id, body.patch);
  return json(getBootstrap(auth.user));
}
