import {
  ensureProcurementChain,
  getBootstrap,
  refreshProcurementAnalytics,
  sendProcurementToCalculation,
  setProcurementReview,
  transferProcurementToProduction,
  updateProcurement,
} from "@/server/repo";
import { withSection, json } from "@/server/http";
import type { ReviewStatus } from "@/lib/types";

export async function GET(req: Request) {
  return withSection(req, "zakupki", (user) =>
    json({ items: getBootstrap(user).data.procurements })
  );
}

export async function PATCH(req: Request) {
  return withSection(req, "zakupki", async (user) => {
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
  return withSection(req, "zakupki", async (user) => {
    const body = (await req.json()) as {
      action?:
        | "ensureChain"
        | "sendToCalculation"
        | "refreshAnalytics"
        | "transferToProduction";
      id?: string;
    };
    if (!body.id) return json({ error: "Не указан id" }, 400);
    if (body.action === "ensureChain") {
      ensureProcurementChain(user.id, body.id);
      return json(getBootstrap(user));
    }
    if (body.action === "sendToCalculation") {
      sendProcurementToCalculation(user.id, body.id);
      return json(getBootstrap(user));
    }
    if (body.action === "refreshAnalytics") {
      refreshProcurementAnalytics(user.id, body.id);
      return json(getBootstrap(user));
    }
    if (body.action === "transferToProduction") {
      transferProcurementToProduction(user.id, body.id);
      return json(getBootstrap(user));
    }
    return json({ error: "Некорректный запрос" }, 400);
  });
}
