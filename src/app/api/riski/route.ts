import { getBootstrap, injectRiskParse, updateRisk } from "@/server/repo";
import { withSection, json } from "@/server/http";
import type { RiskRegistry } from "@/lib/types";

export async function GET(req: Request) {
  return withSection(req, "riski", (user) =>
    json({ items: getBootstrap(user).data.risks })
  );
}

export async function PATCH(req: Request) {
  return withSection(req, "riski", async (user) => {
    const body = (await req.json()) as {
      id?: string;
      patch?: Partial<RiskRegistry>;
      action?: "parse";
      contractText?: string;
    };
    if (!body.id) return json({ error: "Не указан id" }, 400);
    if (body.action === "parse") {
      injectRiskParse(user.id, body.id, body.contractText);
      return json(getBootstrap(user));
    }
    if (!body.patch) return json({ error: "Нужны id и patch" }, 400);
    updateRisk(user.id, body.id, body.patch);
    return json(getBootstrap(user));
  });
}
