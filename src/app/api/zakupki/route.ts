import { getBootstrap, setProcurementReview, updateProcurement } from "@/server/repo";
import { json, requireUser } from "@/server/http";
import type { ReviewStatus } from "@/lib/types";

export async function GET() {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  return json({ items: getBootstrap(auth.user).data.procurements });
}

export async function PATCH(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const body = (await req.json()) as {
    id: string;
    reviewStatus?: ReviewStatus;
    patch?: Record<string, unknown>;
  };
  if (body.reviewStatus) {
    setProcurementReview(auth.user.id, body.id, body.reviewStatus);
  } else if (body.patch) {
    updateProcurement(auth.user.id, body.id, body.patch);
  }
  return json(getBootstrap(auth.user));
}
