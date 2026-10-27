import { getBootstrap, recalcCalculation, updateCalculation } from "@/server/repo";
import { json, requireUser } from "@/server/http";
import type { Calculation } from "@/lib/types";

export async function GET() {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  return json({ items: getBootstrap(auth.user).data.calculations });
}

export async function PATCH(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const body = (await req.json()) as {
    id: string;
    patch?: Partial<Calculation>;
    recalcScenario?: Calculation["scenario"];
  };
  if (body.recalcScenario) {
    recalcCalculation(auth.user.id, body.id, body.recalcScenario);
  } else if (body.patch) {
    updateCalculation(auth.user.id, body.id, body.patch);
  }
  return json(getBootstrap(auth.user));
}
