import {
  addMoneyPayment,
  analyzeProcurementPackageWithAI,
  ensureMoneyPlan,
  ensureProcurementChain,
  getBootstrap,
  refreshProcurementAnalytics,
  sendProcurementToCalculation,
  setProcurementReview,
  transferProcurementToProduction,
  updateMoney,
  updateProcurement,
} from "@/server/repo";
import { assertSection } from "@/server/acl";
import { withSection, json } from "@/server/http";
import type { MoneyPayment, MoneyPlan, ReviewStatus } from "@/lib/types";

const MONEY_ACTIONS = new Set([
  "ensureMoney",
  "saveMoney",
  "addMoneyPayment",
]);

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
        | "analyzeProject"
        | "transferToProduction"
        | "ensureMoney"
        | "saveMoney"
        | "addMoneyPayment";
      id?: string;
      moneyId?: string;
      patch?: Partial<MoneyPlan>;
      payment?: Omit<MoneyPayment, "id">;
    };
    if (!body.id && body.action !== "saveMoney" && body.action !== "addMoneyPayment") {
      return json({ error: "Не указан id" }, 400);
    }
    if (body.action === "ensureChain") {
      ensureProcurementChain(user.id, body.id!);
      return json(getBootstrap(user));
    }
    if (body.action === "sendToCalculation") {
      sendProcurementToCalculation(user.id, body.id!);
      return json(getBootstrap(user));
    }
    if (body.action === "refreshAnalytics") {
      refreshProcurementAnalytics(user.id, body.id!);
      return json(getBootstrap(user));
    }
    if (body.action === "analyzeProject") {
      await analyzeProcurementPackageWithAI(user.id, body.id!);
      return json(getBootstrap(user));
    }
    if (body.action === "transferToProduction") {
      transferProcurementToProduction(user.id, body.id!);
      return json(getBootstrap(user));
    }
    // Nested matryoshka: money tab lives under zakupki URL but requires dengi ACL
    if (body.action && MONEY_ACTIONS.has(body.action)) {
      assertSection(user, "dengi");
    }
    if (body.action === "ensureMoney") {
      ensureMoneyPlan(user.id, body.id!);
      return json(getBootstrap(user));
    }
    if (body.action === "saveMoney") {
      if (!body.moneyId || !body.patch) {
        return json({ error: "Нужны moneyId и patch" }, 400);
      }
      updateMoney(user.id, body.moneyId, body.patch);
      return json(getBootstrap(user));
    }
    if (body.action === "addMoneyPayment") {
      if (!body.moneyId || !body.payment) {
        return json({ error: "Нужны moneyId и payment" }, 400);
      }
      addMoneyPayment(user.id, body.moneyId, body.payment);
      return json(getBootstrap(user));
    }
    return json({ error: "Некорректный запрос" }, 400);
  });
}
