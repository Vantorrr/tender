import { getBootstrap, setProcurementReview, updateProcurement } from "@/server/repo";
import { withUser, json } from "@/server/http";
import type { ReviewStatus } from "@/lib/types";

export async function GET(req: Request) {
  return withUser(req, (user) =>
    json({ items: getBootstrap(user).data.procurements })
  );
}

export async function PATCH(req: Request) {
  return withUser(req, async (user) => {
    const body = (await req.json()) as {
      id?: string;
      reviewStatus?: ReviewStatus;
      patch?: Record<string, unknown>;
    };
    if (!body.id) return json({ error: "Не указан id" }, 400);
    if (body.reviewStatus) {
      setProcurementReview(user.id, body.id, body.reviewStatus);
    } else if (body.patch) {
      updateProcurement(user.id, body.id, body.patch);
    } else {
      return json({ error: "Нет изменений" }, 400);
    }
    return json(getBootstrap(user));
  });
}
