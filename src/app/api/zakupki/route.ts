import {
  ensureProcurementChain,
  getBootstrap,
  setProcurementReview,
  updateProcurement,
} from "@/server/repo";
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
      duplicateOf?: string;
      patch?: Record<string, unknown>;
    };
    if (!body.id) return json({ error: "Не указан id" }, 400);
    if (body.reviewStatus) {
      setProcurementReview(
        user.id,
        body.id,
        body.reviewStatus,
        body.duplicateOf
      );
    } else if (body.patch) {
      updateProcurement(user.id, body.id, body.patch);
    } else {
      return json({ error: "Нет изменений" }, 400);
    }
    return json(getBootstrap(user));
  });
}

export async function POST(req: Request) {
  return withUser(req, async (user) => {
    const body = (await req.json()) as {
      action?: "ensureChain";
      id?: string;
    };
    if (body.action === "ensureChain" && body.id) {
      ensureProcurementChain(user.id, body.id);
      return json(getBootstrap(user));
    }
    return json({ error: "Некорректный запрос" }, 400);
  });
}
