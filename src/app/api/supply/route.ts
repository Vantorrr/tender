import {
  deleteSupplier,
  deleteSupplyRequest,
  generateProcurementMaterialManifest,
  getBootstrap,
  markSupplyRequestSent,
  recordSupplierQuote,
  saveOrganizationCompanyCard,
  selectSupplierQuote,
  upsertSupplyRequest,
  upsertSupplier,
} from "@/server/repo";
import { withSection, json } from "@/server/http";
import type { SupplyStatus } from "@/lib/types";
import { saveUpload, readUpload } from "@/server/uploads";
import { config } from "@/server/config";
import { formatQuantity } from "@/lib/format";
import { quoteRequestOutcome } from "@/lib/wave23";
import { mailStatus, sendMail } from "@/server/mail";
import { discoverMaterialSuppliers } from "@/server/supplier-discovery";

export async function GET(req: Request) {
  return withSection(req, "zakupki", (user) => {
    const data = getBootstrap(user).data;
    const mail = mailStatus();
    return json({ items: data.supplyRequests ?? [], suppliers: data.suppliers ?? [], companyCard: data.companyCards?.[0] ?? null, mail: { live: mail.live, detail: mail.detail } });
  });
}

export async function POST(req: Request) {
  return withSection(req, "zakupki", async (user) => {
    if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (String(form.get("action") ?? "") !== "companyCard" || !(file instanceof File)) return json({ error: "Передайте файл карточки предприятия" }, 400);
      if (file.size > config.maxUploadBytes) return json({ error: "Файл превышает допустимый размер" }, 413);
      const ext = file.name.split(".").pop()?.toLowerCase();
      if (!ext || !["pdf", "doc", "docx", "jpg", "jpeg", "png"].includes(ext)) return json({ error: "Карточка предприятия должна быть PDF, DOC/DOCX или изображением" }, 415);
      const stored = await saveUpload(`company-${user.orgId}-${Date.now()}`, file.name, Buffer.from(await file.arrayBuffer()));
      saveOrganizationCompanyCard(user.id, { fileName: file.name, storedPath: stored.storedPath, fileSize: stored.fileSize });
      const data = getBootstrap(user).data;
      return json({ companyCard: data.companyCards?.[0] ?? null });
    }
    const body = (await req.json()) as {
      id?: string;
      action?: "recordQuote" | "selectQuote" | "upsertSupplier" | "deleteSupplier" | "deleteSupply" | "generateManifest" | "sendRfq" | "discoverSuppliers";
      quoteId?: string;
      supplierId?: string;
      confirmed?: boolean;
      supplier?: { id?: string; name?: string; email?: string; materialKeywords?: string[]; regions?: string[]; website?: string; note?: string };
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
      supplierIds?: string[];
      source?: "gpr" | "estimate" | "manual";
      sourceFiles?: string[];
      quantityNeedsReview?: boolean;
      status?: SupplyStatus;
      quoteDraftText?: string;
      supplierName?: string;
      supplierEmail?: string;
      supplierNote?: string;
      qtyOrdered?: number;
      qtyDelivered?: number;
      unitPrice?: number | null;
    };
    if (body.action === "upsertSupplier") {
      const supplier = body.supplier;
      if (!supplier?.name?.trim() || !supplier.email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supplier.email.trim()) || !Array.isArray(supplier.materialKeywords) || supplier.materialKeywords.length === 0) return json({ error: "Укажите название, корректный email и хотя бы один вид материала" }, 400);
      upsertSupplier(user.id, { id: supplier.id, name: supplier.name, email: supplier.email, materialKeywords: supplier.materialKeywords, regions: supplier.regions ?? [], website: supplier.website, note: supplier.note });
      return json(getBootstrap(user));
    }
    if (body.action === "deleteSupplier") {
      if (!body.supplierId) return json({ error: "Не указан поставщик" }, 400);
      deleteSupplier(user.id, body.supplierId);
      return json(getBootstrap(user));
    }
    if (body.action === "deleteSupply") {
      if (!body.id) return json({ error: "Не указана потребность" }, 400);
      deleteSupplyRequest(user.id, body.id);
      return json(getBootstrap(user));
    }
    if (body.action === "generateManifest") {
      if (!body.procurementId) return json({ error: "Не указана закупка" }, 400);
      const manifest = generateProcurementMaterialManifest(user.id, body.procurementId);
      return json({ ...getBootstrap(user), manifest });
    }
    if (body.action === "discoverSuppliers") {
      if (!body.id) return json({ error: "Не указана позиция материала" }, 400);
      const data = getBootstrap(user).data;
      const supply = (data.supplyRequests ?? []).find((item) => item.id === body.id);
      if (!supply) return json({ error: "Потребность не найдена" }, 404);
      const procurement = data.procurements.find((item) => item.id === supply.procurementId);
      if (!procurement) return json({ error: "Закупка не найдена" }, 404);
      try {
        const candidates = await discoverMaterialSuppliers({ material: supply.materialName, region: procurement.region, work: supply.workName });
        return json({ candidates, searchStatus: candidates.length ? "results" : "empty" });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Не удалось найти поставщиков" }, 502);
      }
    }
    if (body.action === "sendRfq") {
      if (!body.confirmed) return json({ error: "Подтвердите отправку запроса поставщику" }, 400);
      if (!body.id || !body.supplierId) return json({ error: "Не указаны позиция материала и поставщик" }, 400);
      const data = getBootstrap(user).data;
      const supply = (data.supplyRequests ?? []).find((item) => item.id === body.id);
      const supplier = (data.suppliers ?? []).find((item) => item.id === body.supplierId);
      const procurement = data.procurements.find((item) => item.id === supply?.procurementId);
      const card = data.companyCards?.find((item) => item.orgId === user.orgId);
      if (!supply || !supplier || !procurement) return json({ error: "Позиция, поставщик или закупка не найдены" }, 404);
      if (!(supply.supplierIds ?? []).includes(supplier.id)) return json({ error: "Этот поставщик не сопоставлен с материалом" }, 409);
      if ((supply.sentToSupplierIds ?? []).includes(supplier.id)) return json({ error: "Запрос этому поставщику уже отправлен" }, 409);
      const text = [`Здравствуйте, ${supplier.name}!`, "Просим направить коммерческое предложение по материалу:", `Объект: ${procurement.title}`, `Позиция: ${supply.materialName}`, `Количество: ${formatQuantity(supply.qtyNeed, supply.unit)}`, supply.workName ? `Вид работ: ${supply.workName}` : null, `Желаемый срок поставки: ${supply.needBy}`, "Просим указать цену, срок действия предложения, срок и условия доставки.", "Карточка предприятия приложена к письму."].filter(Boolean).join("\n");
      const readiness = mailStatus();
      if (!readiness.live) {
        const outcome = quoteRequestOutcome(false);
        return json({ ...outcome, fileName: "zapros-kp.txt", text: supply.quoteDraftText?.trim() || text });
      }
      if (!card) return json({ error: "Сначала загрузите карточку предприятия — она будет приложена к письму" }, 409);
      const bytes = readUpload(card.storedPath);
      if (!bytes) return json({ error: "Файл карточки предприятия недоступен. Загрузите его повторно." }, 409);
      const sent = await sendMail({ to: supplier.email, subject: `Запрос КП: ${supply.materialName} · ${procurement.title}`, text: supply.quoteDraftText?.trim() || text, attachments: [{ filename: card.fileName, contentBase64: bytes.toString("base64") }] });
      if (!sent.ok) return json({ error: "Почтовый сервер не принял письмо" }, 502);
      markSupplyRequestSent(user.id, supply.id, supplier.id);
      return json({ ...getBootstrap(user), sentTo: supplier.name });
    }
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
      supplierIds: body.supplierIds,
      source: body.source,
      sourceFiles: body.sourceFiles,
      quantityNeedsReview: body.quantityNeedsReview,
    });
    return json(getBootstrap(user));
  });
}
