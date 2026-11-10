import {
  getBootstrap,
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
