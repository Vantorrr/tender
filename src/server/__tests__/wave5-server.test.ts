import { beforeEach, describe, expect, it } from "vitest";
import { createSession } from "@/server/auth";
import { closeDb, ensureReady, mutateAppData, readAppData } from "@/server/db";
import {
  addMoneyPayment,
  deleteCustomerAnswer,
  deleteMoneyPayment,
  deletePlanFactEntry,
  deleteSupplyRequest,
  refreshProcurementAnalytics,
  saveCustomerAnswer,
  updatePlanFact,
  upsertSupplier,
  upsertSupplyRequest,
} from "@/server/repo";
import "./setup";

describe("wave 5 money, answers and supplies", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("does not create a second payment on a repeated click and deletes with an org check", () => {
    const plan = readAppData().moneyPlans[0];
    const payment = {
      type: "postuplenie" as const,
      title: "2 этап",
      amount: 12500,
      date: "2026-12-02",
      week: 49,
      month: 12,
    };
    const first = addMoneyPayment("u-smet", plan.id, payment);
    const second = addMoneyPayment("u-smet", plan.id, payment);
    const saved = readAppData().moneyPlans.find((item) => item.id === plan.id)!.payments;
    expect(first.created).toBe(true);
    expect(second).toEqual({ paymentId: first.paymentId, created: false });
    expect(saved.filter((item) => item.title === "2 этап" && item.amount === 12500)).toHaveLength(1);
    expect(() => deleteMoneyPayment("u-beta-tender", plan.id, first.paymentId)).toThrow(/организац/);
    deleteMoneyPayment("u-smet", plan.id, first.paymentId);
    expect(readAppData().moneyPlans.find((item) => item.id === plan.id)!.payments.some((item) => item.id === first.paymentId)).toBe(false);
  });

  it("rejects a money delete from a role without the money section", async () => {
    const { POST } = await import("@/app/api/dengi/route");
    const response = await POST(new Request("http://local/api/dengi", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createSession("u-tender")}`,
      },
      body: JSON.stringify({ action: "deletePayment", moneyId: "m-1", paymentId: "mp-1" }),
    }));
    expect(response.status).toBe(403);
    expect(readAppData().moneyPlans[0].payments.some((item) => item.id === "mp-1")).toBe(true);
  });

  it("stores who answered and when, and can remove the answer", () => {
    const procurement = readAppData().procurements[0];
    saveCustomerAnswer("u-smet", procurement.id, "Где площадка?", "На карте заказчика");
    const saved = readAppData().procurements.find((item) => item.id === procurement.id)!.customerAnswers!;
    expect(saved[0]).toMatchObject({
      question: "Где площадка?",
      answer: "На карте заказчика",
      authorId: "u-smet",
      authorName: "Сергей Сметчиков",
    });
    expect(saved[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    deleteCustomerAnswer("u-smet", procurement.id, "Где площадка?");
    expect(readAppData().procurements.find((item) => item.id === procurement.id)!.customerAnswers).toEqual([]);
  });

  it("keeps the note when a refresh has nothing new to say", () => {
    const procurement = readAppData().procurements.find((item) => item.id === "p-1")!;
    const summary = "Вердикт ИИ: 6 / 10 — записка остаётся\n\n1. Паспорт закупки и тайминг\nкак было";
    mutateAppData((data) => {
      const item = data.procurements.find((row) => row.id === procurement.id)!;
      item.analytics = {
        recommendation: "insufficient_data",
        summary,
        missingInputs: [],
        citationIds: [],
        citations: [],
        generatedAt: new Date().toISOString(),
        method: "разбор пакета по цитатам документов",
        disclaimer: "проверка",
      };
      return data;
    });
    refreshProcurementAnalytics("u-ruk", procurement.id);
    expect(readAppData().procurements.find((item) => item.id === procurement.id)!.analytics!.summary).toBe(summary);
    expect(refreshProcurementAnalytics("u-ruk", procurement.id).unchanged).toBe(true);
    expect(readAppData().procurements.find((item) => item.id === procurement.id)!.analytics!.summary).toBe(summary);
  });

  it("drops a just-created supply and ignores the repeated click", () => {
    const procurement = readAppData().procurements[0];
    upsertSupplyRequest("u-ruk", {
      procurementId: procurement.id,
      materialName: "Кабель повтор",
      unit: "м",
      qtyNeed: 4,
      needBy: "2026-12-01",
    });
    upsertSupplyRequest("u-ruk", {
      procurementId: procurement.id,
      materialName: "Кабель повтор",
      unit: "м",
      qtyNeed: 4,
      needBy: "2026-12-01",
    });
    const rows = (readAppData().supplyRequests ?? []).filter((item) => item.materialName === "Кабель повтор");
    expect(rows).toHaveLength(1);
    deleteSupplyRequest("u-ruk", rows[0].id);
    expect((readAppData().supplyRequests ?? []).some((item) => item.id === rows[0].id)).toBe(false);
    expect(() => deleteSupplyRequest("u-beta-tender", "missing")).toThrow(/не найдена|организац/);
  });

  it("undo of a contract work removes only that row from the current plan", () => {
    const plan = readAppData().planFacts[0];
    const kept = plan.entries.map((entry) => entry.id);
    updatePlanFact("u-ruk", plan.id, {
      entries: [
        ...plan.entries,
        { id: "pfe-a", workName: "Работа A", unit: "м", plan: 1, fact: 0 },
        { id: "pfe-b", workName: "Работа B", unit: "м", plan: 2, fact: 0 },
      ],
    });
    deletePlanFactEntry("u-ruk", plan.id, "pfe-a");
    const ids = readAppData().planFacts.find((item) => item.id === plan.id)!.entries.map((entry) => entry.id);
    expect(ids).not.toContain("pfe-a");
    expect(ids).toEqual([...kept, "pfe-b"]);
  });

  it("lets only the author or a manager delete a supply, supplier, answer and GPR stage", async () => {
    const supply = upsertSupplyRequest("u-ruk", {
      procurementId: "p-1",
      materialName: "Чужая труба",
      unit: "м",
      qtyNeed: 3,
      needBy: "2026-12-01",
    }).supplyRequests!.find((item) => item.materialName === "Чужая труба")!;
    const supplier = upsertSupplier("u-ruk", { name: "Чужой поставщик", email: "other@example.test", materialKeywords: ["труба"], regions: ["Москва"] });
    saveCustomerAnswer("u-tender", "p-1", "Кто автор ответа?", "Тендер");

    const { POST: supplyPost } = await import("@/app/api/supply/route");
    const { POST: zakupkiPost } = await import("@/app/api/zakupki/route");
    const { PATCH: gprPatch } = await import("@/app/api/gpr/route");
    const call = (route: (req: Request) => Promise<Response>, userId: string, body: unknown, path: string, method = "POST") =>
      route(new Request(`http://local${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${createSession(userId)}` },
        body: JSON.stringify(body),
      }));

    const tenderSupply = await call(supplyPost, "u-tender", { action: "deleteSupply", id: supply.id }, "/api/supply");
    expect(tenderSupply.status).toBe(403);
    expect(String((await tenderSupply.json()).error)).toMatch(/автор, руководитель или администратор/);
    expect((await call(supplyPost, "u-admin", { action: "deleteSupply", id: supply.id }, "/api/supply")).status).toBe(200);

    const tenderSupplier = await call(supplyPost, "u-tender", { action: "deleteSupplier", supplierId: supplier.id }, "/api/supply");
    expect(tenderSupplier.status).toBe(403);
    expect((await call(supplyPost, "u-ruk", { action: "deleteSupplier", supplierId: supplier.id }, "/api/supply")).status).toBe(200);

    const otherAnswer = await call(zakupkiPost, "u-obj", { action: "deleteCustomerAnswer", id: "p-1", question: "Кто автор ответа?" }, "/api/zakupki");
    expect(otherAnswer.status).toBe(403);
    expect(String((await otherAnswer.json()).error)).toMatch(/автор, руководитель или администратор/);
    expect((await call(zakupkiPost, "u-tender", { action: "deleteCustomerAnswer", id: "p-1", question: "Кто автор ответа?" }, "/api/zakupki")).status).toBe(200);

    const objectStage = await call(gprPatch, "u-obj", { id: "g-1", action: "deleteStage", stageId: "gs-2" }, "/api/gpr", "PATCH");
    expect(objectStage.status).toBe(403);
    expect(readAppData().schedules.find((item) => item.id === "g-1")!.stages.some((stage) => stage.id === "gs-2")).toBe(true);
    expect((await call(gprPatch, "u-admin", { id: "g-1", action: "deleteStage", stageId: "gs-2" }, "/api/gpr", "PATCH")).status).toBe(200);
  });
});
