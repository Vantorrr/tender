import { getBootstrap, updateRisk } from "@/server/repo";
import { json, requireUser } from "@/server/http";
import type { RiskRegistry } from "@/lib/types";

export async function GET() {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  return json({ items: getBootstrap(auth.user).data.risks });
}

export async function PATCH(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const body = (await req.json()) as { id: string; patch: Partial<RiskRegistry> };
  updateRisk(auth.user.id, body.id, body.patch);
  return json(getBootstrap(auth.user));
}
