import { describe, expect, it } from "vitest";
import type { CalcPosition, SupplyRequest, User } from "@/lib/types";
import {
  averageQuoteHint,
  BDDS_WAITING_STATUS,
  buildBddsFrame,
  buildNmckCostGap,
  displayedCalculationOwner,
  positionWithoutStaleQuote,
  quoteRateMatches,
  quoteUnitPriceError,
  resolveCalculationOwner,
  suitableQuotesForPosition,
} from "@/lib/wave5-client";

function supply(quotes: SupplyRequest["quotes"], patch: Partial<SupplyRequest> = {}): SupplyRequest {
  return {
    id: "sup-1",
    orgId: "org-alfa",
    procurementId: "p-1",
    materialName: "Труба",
    unit: "м",
    qtyNeed: 10,
    qtyOrdered: 0,
    qtyDelivered: 0,
    needBy: "2026-12-01",
    status: "quoted_draft",
    quotes,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    ...patch,
  };
}

const pipe: CalcPosition = {
  id: "pipe",
  costRole: "commercial",
  code: "MAT-PIPE",
  name: "Труба",
  unit: "м",
  quantity: 10,
  rate: 100,
};

describe("wave 5 quote hint", () => {
  it("shows the average as a hint and does not pick the cheapest quote", () => {
    const offers = suitableQuotesForPosition(pipe, [
      supply([
        { id: "q-cheap", supplierName: "Якорь", unitPrice: 100, receivedAt: "2026-11-01T00:00:00Z" },
        { id: "q-dear", supplierName: "Альфа", unitPrice: 400, receivedAt: "2026-11-02T00:00:00Z" },
      ]),
      supply([{ id: "q-gone", supplierName: "Снятый", unitPrice: 1, receivedAt: "2026-11-01T00:00:00Z" }], { status: "cancelled", id: "sup-2" }),
      supply([{ id: "q-other", supplierName: "Чужой", unitPrice: 5, receivedAt: "2026-11-01T00:00:00Z" }], { materialName: "Кабель", id: "sup-3" }),
    ], "p-1");
    expect(offers.map((offer) => offer.quoteId)).toEqual(["q-dear", "q-cheap"]);
    const hint = averageQuoteHint(offers.map((offer) => offer.unitPrice));
    expect(hint).toMatchObject({
      count: 2,
      average: 250,
      min: 100,
      max: 400,
      label: "Средняя цена по 2 КП — подсказка",
    });
    expect(hint.spreadLabel).toMatch(/100,00/);
    expect(hint.spreadLabel).toMatch(/400,00/);
    expect(hint).not.toHaveProperty("selectedQuoteId");
    expect(hint.average).not.toBe(hint.min);
    expect(quoteRateMatches(1800, 1800)).toBe(true);
    expect(quoteRateMatches(1800.004, 1800)).toBe(true);
    expect(quoteRateMatches(777, 1800)).toBe(false);
    const quoted = { ...pipe, rate: 1800, priceSource: "quote" as const, selectedQuoteId: "q-1", quoteSupplierName: "Альфа", baseRate: 100 };
    expect(positionWithoutStaleQuote(quoted, { ...quoted, rate: 777 }).priceSource).toBe("manual");
    expect(positionWithoutStaleQuote(quoted, { ...quoted, rate: 777 })).toMatchObject({ rate: 777, baseRate: 777 });
    expect(positionWithoutStaleQuote(quoted, { ...quoted, rate: 777 }).selectedQuoteId).toBeUndefined();
    expect(positionWithoutStaleQuote(quoted, quoted).selectedQuoteId).toBe("q-1");
    expect(quoteUnitPriceError(-1)).toMatch(/отрицательн/);
    expect(quoteUnitPriceError(Number.POSITIVE_INFINITY)).toMatch(/числом/);
    expect(quoteUnitPriceError(1_000_000_001)).toMatch(/слишком больш/);
  });
});

describe("wave 5 director gap", () => {
  it("explains an NMCK at or below full cost and does not refuse by itself", () => {
    const lines: CalcPosition[] = [
      { ...pipe, id: "cable", name: "Кабель", quantity: 5, rate: 4000 },
      { ...pipe, id: "pipe", name: "Труба", quantity: 10, rate: 1000 },
      { ...pipe, id: "sand", name: "Песок", quantity: 2, rate: 3000 },
      { ...pipe, id: "clip", name: "Скоба", quantity: 1, rate: 100 },
    ];
    const gap = buildNmckCostGap({
      nmck: 1000,
      direct: 36100,
      overhead: 15523,
      contingency: 5162.3,
      fullCost: 56785.3,
      officialPrice: 79499.42,
      lines,
    });
    expect(gap.triggered).toBe(true);
    expect(gap.headline).toBe("Почему не проходим");
    expect(gap.deficitRub).toBeCloseTo(55785.3, 2);
    expect(gap.deficitPercentOfNmck).toBeCloseTo(5578.53, 2);
    expect(gap.topDrivers.map((driver) => driver.name)).toEqual(["Кабель", "Труба", "Песок"]);
    expect(gap).not.toHaveProperty("autoDecline");
    expect(buildNmckCostGap({ nmck: 100, fullCost: 90, direct: 1, overhead: 1, contingency: 1, officialPrice: 2, lines: [] }).triggered).toBe(false);
  });
});

describe("wave 5 owner and cash frame", () => {
  const users: User[] = [
    { id: "u-ruk", email: "a@a.ru", name: "Павел", role: "rukovoditel", orgId: "org-alfa", blocked: false, sections: [], createdAt: "2026-09-02T00:00:00Z" },
    { id: "u-tender", email: "b@a.ru", name: "Анна", role: "tender", orgId: "org-alfa", blocked: false, sections: [], createdAt: "2026-09-03T00:00:00Z" },
    { id: "u-late", email: "c@a.ru", name: "Поздний", role: "tender", orgId: "org-alfa", blocked: false, sections: [], createdAt: "2026-10-01T00:00:00Z" },
    { id: "u-blocked", email: "d@a.ru", name: "Виктор", role: "tender", orgId: "org-alfa", blocked: true, sections: [], createdAt: "2026-08-01T00:00:00Z" },
    { id: "u-beta", email: "e@b.ru", name: "Мария", role: "tender", orgId: "org-beta", blocked: false, sections: [], createdAt: "2026-09-01T00:00:00Z" },
  ];

  it("defaults the owner to the earliest active tender engineer", () => {
    expect(resolveCalculationOwner(users, "org-alfa", "u-ruk")).toMatchObject({ userId: "u-tender", role: "tender" });
    const withoutEngineer = users.map((user) => user.role === "tender" && user.orgId === "org-alfa" ? { ...user, blocked: true } : user);
    expect(resolveCalculationOwner(withoutEngineer, "org-alfa", "u-ruk")).toMatchObject({ userId: "u-ruk", role: "rukovoditel" });
    expect(displayedCalculationOwner({
      orgId: "org-alfa",
      authorId: "u-ruk",
      ownerUserId: "u-smet-missing",
    }, users)?.userId).toBe("u-tender");
  });

  it("does not invent a cash gap, an advance or a payment chart", () => {
    const frame = buildBddsFrame({ officialCostReady: true, gprDatesReady: true, workPackagesReady: false });
    expect(frame.statusText).toBe(BDDS_WAITING_STATUS);
    expect(frame.cashGaps).toBeNull();
    expect(frame.paymentSchedule).toBeNull();
    expect(frame.figures).toBeNull();
    expect(frame.readyInputs).toEqual([
      "Официальная себестоимость уже есть в расчёте",
      "Сроки ГПР уже заданы",
      "Пакеты работ ещё не собраны",
    ]);
    expect(JSON.stringify(frame)).not.toMatch(/\d/);
    expect(JSON.stringify(frame)).not.toMatch(/999999|кассовый разрыв \d/iu);
  });
});
