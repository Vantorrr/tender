import {
  addMoneyPayment,
  ensureMoneyPlan,
  getBootstrap,
  updateMoney,
} from "@/server/repo";
import { withSection, json } from "@/server/http";
import type { MoneyPayment, MoneyPlan } from "@/lib/types";

export async function GET(req: Request) {
  return withSection(req, "dengi", (user) =>
    json({ items: getBootstrap(user).data.moneyPlans })
  );
}

export async function PATCH(req: Request) {
  return withSection(req, "dengi", async (user) => {
    const body = (await req.json()) as {
      id?: string;
      patch?: Partial<MoneyPlan>;
    };
    if (!body.id || !body.patch) {
      return json({ error: "Нужны id и patch" }, 400);
    }
    updateMoney(user.id, body.id, body.patch);
    return json(getBootstrap(user));
  });
}

export async function POST(req: Request) {
  return withSection(req, "dengi", async (user) => {
    const body = (await req.json()) as {
      action?: "ensure" | "addPayment";
      procurementId?: string;
      moneyId?: string;
      payment?: Omit<MoneyPayment, "id">;
    };
    if (body.action === "ensure" && body.procurementId) {
      ensureMoneyPlan(user.id, body.procurementId);
      return json(getBootstrap(user));
    }
    if (body.action === "addPayment" && body.moneyId && body.payment) {
      addMoneyPayment(user.id, body.moneyId, body.payment);
      return json(getBootstrap(user));
    }
    return json({ error: "Некорректный запрос" }, 400);
  });
}
