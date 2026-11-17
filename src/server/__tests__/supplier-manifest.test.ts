import { beforeEach, describe, expect, it } from "vitest";
import { closeDb, ensureReady, mutateAppData, readAppData } from "@/server/db";
import { generateProcurementMaterialManifest, upsertSupplier, upsertSupplyRequest } from "@/server/repo";
import { createSession } from "@/server/auth";
import { resetMailTransport, setMailTransport, type MailMessage } from "@/server/mail";
import "./setup";

describe("procurement material manifest and supplier matching", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("builds an idempotent material list from GPR and parsed estimates, then matches suppliers", () => {
    mutateAppData((data) => {
      const schedule = data.schedules.find((item) => item.id === "g-1")!;
      schedule.stages[0].resources = [{
        id: "fixture-pipe", kind: "material", name: "Труба стальная 57 мм",
        quantity: 10, unit: "м",
      }];
      const estimate = data.documents.find((item) => item.procurementId === "p-1")!;
      estimate.estimatePositions = [
        { id: "fixture-pipe-row", code: "MAT-1", name: "Труба стальная 57 мм", unit: "м", quantity: 10, rate: 0, resourceKind: "material", workName: schedule.stages[0].name },
        { id: "fixture-cable-row", code: "MAT-2", name: "Кабель ВВГнг", unit: "м", quantity: 20, rate: 0, resourceKind: "material", workName: schedule.stages[0].name },
      ];
      return data;
    });

    upsertSupplier("u-super", {
      name: "СеверСнаб", email: "sales@example.test",
      materialKeywords: ["труба стальная", "кабель ввгнг"], regions: ["Москва"],
    });

    expect(generateProcurementMaterialManifest("u-super", "p-1")).toEqual({ created: 2 });
    const rows = readAppData().supplyRequests!.filter((item) => item.procurementId === "p-1");
    expect(rows).toHaveLength(2);
    expect(rows.find((item) => item.materialName === "Труба стальная 57 мм")).toMatchObject({
      qtyNeed: 10, unit: "м", source: "gpr", supplierIds: [expect.stringMatching(/^supplier-/)],
    });
    expect(rows.find((item) => item.materialName === "Кабель ВВГнг")).toMatchObject({
      qtyNeed: 20, unit: "м", source: "estimate", supplierIds: [expect.stringMatching(/^supplier-/)],
    });
    expect(generateProcurementMaterialManifest("u-super", "p-1")).toEqual({ created: 0 });
  });

  it("sends an explicitly confirmed RFQ only to a matched supplier with the company card attached", async () => {
    const oldEnv = Object.fromEntries(["MAIL_TRANSPORT", "SMTP_HOST", "SMTP_FROM", "SMTP_USER", "SMTP_PASS"].map((key) => [key, process.env[key]]));
    process.env.MAIL_TRANSPORT = "smtp";
    process.env.SMTP_HOST = "mail.test";
    process.env.SMTP_FROM = "procurement@example.test";
    process.env.SMTP_USER = "procurement@example.test";
    process.env.SMTP_PASS = "test-only";
    let captured: Omit<MailMessage, "at" | "id"> | undefined;
    setMailTransport({ id: "smtp", async send(message) { captured = message; return { ok: true, transport: "smtp", id: "smtp-test-1" }; } });
    try {
      const supplier = upsertSupplier("u-super", { name: "СеверСнаб", email: "sales@example.test", materialKeywords: ["труба стальная"], regions: ["Москва"] });
      const supply = upsertSupplyRequest("u-super", { procurementId: "p-1", materialName: "Труба стальная 57 мм", unit: "м", qtyNeed: 12, needBy: "2026-12-20", workName: "Монтаж труб" }).supplyRequests!.find((item) => item.procurementId === "p-1" && item.materialName === "Труба стальная 57 мм")!;
      const form = new FormData();
      form.set("action", "companyCard");
      form.set("file", new File(["company card"], "company-card.pdf", { type: "application/pdf" }));
      const { POST } = await import("@/app/api/supply/route");
      const uploaded = await POST(new Request("http://local/api/supply", { method: "POST", headers: { authorization: `Bearer ${createSession("u-super")}` }, body: form }));
      expect(uploaded.status).toBe(200);

      const sent = await POST(new Request("http://local/api/supply", {
        method: "POST",
        headers: { authorization: `Bearer ${createSession("u-super")}`, "content-type": "application/json" },
        body: JSON.stringify({ action: "sendRfq", id: supply.id, supplierId: supplier.id, confirmed: true }),
      }));
      expect(sent.status).toBe(200);
      expect(captured?.to).toBe("sales@example.test");
      expect(captured?.attachments?.[0]).toMatchObject({ filename: "company-card.pdf" });
      expect(Buffer.from(captured!.attachments![0].contentBase64, "base64").toString()).toBe("company card");
      expect(readAppData().supplyRequests!.find((item) => item.id === supply.id)?.sentToSupplierIds).toContain(supplier.id);
    } finally {
      resetMailTransport();
      for (const [key, value] of Object.entries(oldEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
