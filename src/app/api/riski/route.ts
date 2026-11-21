import { getBootstrap, saveContractReview, updateRisk } from "@/server/repo";
import { readAppData } from "@/server/db";
import { reviewContractText } from "@/server/contract-risk";
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
      const data = readAppData();
      const risk = data.risks.find((item) => item.id === body.id);
      if (!risk) return json({ error: "Реестр рисков не найден" }, 404);
      const fromDocuments = data.documents
        .filter((document) => document.procurementId === risk.procurementId && (
          document.category === "contract" || /договор|контракт/iu.test(`${document.fileName} ${document.title}`)
        ))
        .map((document) => [document.analyticalNote, ...document.citations.map((citation) => citation.text)].filter(Boolean).join("\n"))
        .join("\n")
        .trim();
      const contractText = body.contractText?.trim() || fromDocuments;
      try {
        const review = await reviewContractText(contractText);
        saveContractReview(user.id, body.id, review);
        return json({ ...getBootstrap(user), reviewLabel: review.label, reviewMode: review.mode });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Разбор договора не выполнен" }, 400);
      }
    }
    if (!body.patch) return json({ error: "Нужны id и patch" }, 400);
    updateRisk(user.id, body.id, body.patch);
    return json(getBootstrap(user));
  });
}
