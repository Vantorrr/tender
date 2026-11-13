import {
  getBootstrap,
  recordSupplierQuote,
  selectSupplierQuote,
  upsertSupplyRequest,
} from "@/server/repo";
import { withSection, json } from "@/server/http";
import type { SupplyStatus } from "@/lib/types";

export async function GET(req: Request) {
  return withSection(req, "zakupki", (user) => {
    const data = getBootstrap(user).data;
    return json({ items: data.supplyRequests ?? [] });
  });
}

export async function POST(req: Request) {
  return withSection(req, "zakupki", async (user) => {
    const body = (await req.json()) as {
      id?: string;
      action?: "recordQuote" | "selectQuote";
      quoteId?: string;
      quote?: {
        id?: string;
        supplierName?: string;
        supplierEmail?: string;
        unitPrice?: number;
        deliveryDays?: number | null;
        note?: string;
      };
      procurementId?: string;
      materialName?: string;
      unit?: string;
      qtyNeed?: number;
      needBy?: string;
      workName?: string;
      status?: SupplyStatus;
      quoteDraftText?: string;
      supplierName?: string;
      supplierEmail?: string;
      supplierNote?: string;
      qtyOrdered?: number;
      qtyDelivered?: number;
      unitPrice?: number | null;
    };
    if (body.action === "recordQuote") {
      const quote = body.quote;
      if (!body.id || !quote?.supplierName?.trim() || quote.unitPrice == null) {
        return json({ error: "Нужны потребность, поставщик и цена КП" }, 400);
      }
      if (!Number.isFinite(Number(quote.unitPrice)) || Number(quote.unitPrice) < 0) {
        return json({ error: "Цена КП должна быть неотрицательным числом" }, 400);
      }
      if (quote.deliveryDays != null && (!Number.isFinite(Number(quote.deliveryDays)) || Number(quote.deliveryDays) < 0)) {
        return json({ error: "Срок поставки должен быть неотрицательным числом" }, 400);
      }
      recordSupplierQuote(user.id, body.id, {
        id: quote.id,
        supplierName: quote.supplierName,
        supplierEmail: quote.supplierEmail,
        unitPrice: Number(quote.unitPrice),
        deliveryDays: quote.deliveryDays == null ? null : Number(quote.deliveryDays),
        note: quote.note,
      });
      return json(getBootstrap(user));
    }
    if (body.action === "selectQuote") {
      if (!body.id || !body.quoteId) return json({ error: "Нужны потребность и КП" }, 400);
      selectSupplierQuote(user.id, body.id, body.quoteId);
      return json(getBootstrap(user));
    }
    if (!body.procurementId || !body.materialName || !body.unit || !body.needBy) {
      return json(
        { error: "Нужны procurementId, materialName, unit, needBy" },
        400
      );
    }
    upsertSupplyRequest(user.id, {
      id: body.id,
      procurementId: body.procurementId,
      materialName: body.materialName,
      unit: body.unit,
      qtyNeed: Number(body.qtyNeed) || 0,
      needBy: body.needBy,
      workName: body.workName,
      status: body.status,
      quoteDraftText: body.quoteDraftText,
      supplierName: body.supplierName,
      supplierEmail: body.supplierEmail,
      supplierNote: body.supplierNote,
      qtyOrdered: body.qtyOrdered,
      qtyDelivered: body.qtyDelivered,
      unitPrice: body.unitPrice,
    });
    return json(getBootstrap(user));
  });
}
