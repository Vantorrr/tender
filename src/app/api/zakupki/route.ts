import {
  addMoneyPayment,
  analyzeProcurementPackageWithAI,
  attachCustomerEstimate,
  createManualProcurement,
  deleteProcurement,
  ensureMoneyPlan,
  ensureProcurementChain,
  getBootstrap,
  recomputeCalculationCost,
  refreshProcurementAnalytics,
  createProcurementSchedule,
  sendProcurementToCalculation,
  setProcurementReview,
  transferProcurementToProduction,
  updateMoney,
  updateProcurement,
} from "@/server/repo";
import { assertSection } from "@/server/acl";
import { withSection, json } from "@/server/http";
import type { MoneyPayment, MoneyPlan, ReviewStatus } from "@/lib/types";
import { procurementStatusSnapshot } from "@/server/db";
import { getProcurementSource, KonturProcurementSource } from "@/server/procurement-source";

const MONEY_ACTIONS = new Set([
  "ensureMoney",
  "saveMoney",
  "addMoneyPayment",
]);

export async function GET(req: Request) {
  return withSection(req, "zakupki", (user) =>
    json({ items: getBootstrap(user).data.procurements, source: procurementStatusSnapshot() })
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
        | "createManual"
        | "sendToCalculation"
        | "createGpr"
        | "attachCustomerEstimate"
        | "refreshAnalytics"
        | "analyzeProject"
        | "transferToProduction"
        | "ensureMoney"
        | "deleteProcurement"
        | "saveMoney"
        | "addMoneyPayment"
        | "refreshKonturDetails";
      id?: string;
      moneyId?: string;
      patch?: Partial<MoneyPlan>;
      payment?: Omit<MoneyPayment, "id">;
      fileName?: string;
      mappedCount?: number;
      manual?: { title?: string; customer?: string; region?: string; nmck?: number | null; deadline?: string };
    };
    if (body.action === "createManual") {
      const created = createManualProcurement(user.id, {
        title: body.manual?.title ?? "",
        customer: body.manual?.customer,
        region: body.manual?.region ?? "",
        nmck: body.manual?.nmck,
        deadline: body.manual?.deadline,
      });
      return json({ ...getBootstrap(user), createdProcurementId: created.id });
    }
    if (body.action === "refreshKonturDetails") {
      if (!body.id) return json({ error: "Не указана закупка" }, 400);
      if (!(getProcurementSource() instanceof KonturProcurementSource)) {
        return json({ error: "Источник Контур.Закупки не активен" }, 409);
      }
      const procurement = getBootstrap(user).data.procurements.find(
        (item) => item.id === body.id && item.orgId === user.orgId
      );
      if (!procurement || procurement.source !== "Контур.Закупки API" || !procurement.externalId) {
        return json({ error: "Для этой карточки нет подтверждённого ID закупки Контура" }, 404);
      }
      const result = await (getProcurementSource() as KonturProcurementSource).purchaseDetails(procurement.externalId);
      if (!result.ok || !result.purchase) return json({ error: result.detail }, result.status === "not_configured" ? 503 : 502);
      const details = result.purchase;
      updateProcurement(user.id, procurement.id, {
        number: details.number,
        externalId: details.externalId,
        title: details.title,
        customer: details.customer,
        nmck: details.nmck,
        deadline: details.deadline,
        ...(details.sourceUrl ? { sourceUrl: details.sourceUrl } : {}),
        attachments: details.attachments.map((attachment, index) => ({
          id: `a-kontur-${procurement.externalId}-${index}`,
          name: attachment.name,
          type: "Документ API",
          size: "—",
          sourceUrl: attachment.url,
        })),
      });
      return json({ ...getBootstrap(user), konturDetails: { detail: result.detail, attachmentCount: details.attachments.length } });
    }
    if (!body.id && body.action !== "saveMoney" && body.action !== "addMoneyPayment") {
      return json({ error: "Не указан id" }, 400);
    }
    if (body.action === "deleteProcurement") {
      const result = deleteProcurement(user.id, body.id!);
      if (!result.deleted) return json({ error: "Закупка не найдена" }, 404);
      return json(getBootstrap(user));
    }
    if (body.action === "ensureChain") {
      ensureProcurementChain(user.id, body.id!);
      return json(getBootstrap(user));
    }
    if (body.action === "createGpr") {
      createProcurementSchedule(user.id, body.id!);
      return json(getBootstrap(user));
    }
    if (body.action === "sendToCalculation") {
      sendProcurementToCalculation(user.id, body.id!);
      let boot = getBootstrap(user);
      const initialProcurement = boot.data.procurements.find((item) => item.id === body.id);
      const initialDraft = boot.data.calculations.find(
        (item) => item.id === initialProcurement?.calculationId
      );
      if (
        initialDraft?.resourceScheduleParams &&
        initialDraft.positions.some((position) => position.sourceDocumentId)
      ) {
        recomputeCalculationCost(user.id, initialDraft.id, {
          resourceScheduleParams: initialDraft.resourceScheduleParams,
          useResourceScheduleEconomics: true,
        });
        boot = getBootstrap(user);
      }
      const procurement = boot.data.procurements.find((item) => item.id === body.id);
      const draft = boot.data.calculations.find(
        (item) => item.id === procurement?.calculationId
      );
      const sourceRows = draft?.positions.filter((position) => position.sourceDocumentId) ?? [];
      const sourceDocument = sourceRows[0]
        ? boot.data.documents.find((document) => document.id === sourceRows[0].sourceDocumentId)
        : undefined;
      return json({
        ...boot,
        calculationSummary: {
          sourceFile: sourceDocument?.fileName ?? null,
          sourceRows: sourceRows.length,
          matchedRates: sourceRows.filter((position) => !position.rateMissing).length,
          missingRates: sourceRows.filter((position) => position.rateMissing).length,
        },
      });
    }
    if (body.action === "attachCustomerEstimate") {
      attachCustomerEstimate(user.id, body.id!, {
        fileName: body.fileName,
        mappedCount: body.mappedCount,
      });
      return json(getBootstrap(user));
    }
    if (body.action === "refreshAnalytics") {
      refreshProcurementAnalytics(user.id, body.id!);
      return json(getBootstrap(user));
    }
    if (body.action === "analyzeProject") {
      const result = await analyzeProcurementPackageWithAI(user.id, body.id!);
      return json({ ...getBootstrap(user), analysisWarning: result.warning });
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
