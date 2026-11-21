import { beforeEach, describe, expect, it } from "vitest";
import { createSession } from "@/server/auth";
import { closeDb, ensureReady, mutateAppData, readAppData } from "@/server/db";
import {
  addMoneyPayment,
  deleteCustomerAnswer,
  deleteMoneyPayment,
  deleteSupplyRequest,
  refreshProcurementAnalytics,
  saveCustomerAnswer,
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
});
