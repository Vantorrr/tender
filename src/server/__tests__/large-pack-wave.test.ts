import { beforeEach, describe, expect, it } from "vitest";
import { closeDb, ensureReady, mutateAppData, readAppData } from "@/server/db";
import { createManualProcurement, makeOfficialCalculationAndSchedule } from "@/server/repo";
import { displayedEconomicsSummary } from "@/lib/tender-logic-settings";
import "./setup";

describe("large customer package calculation", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("prices a multi-file customer estimate with the company 43/10/40 rule when the directory has no match", () => {
    const created = createManualProcurement("u-ruk", { title: "Тест нескольких смет", region: "Ямал" });
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    mutateAppData((data) => {
      data.documents.unshift({
        id: "doc-customer-estimates",
        orgId: procurement.orgId,
        procurementId: created.id,
        title: "Смета заказчика",
        fileName: "smeta-1.xlsx",
        fileType: "xlsx",
        category: "estimate",
        status: "gotovo",
        versions: [],
        analyticalNote: "",
        citations: [],
        highlights: [],
        uploadedBy: "u-ruk",
        uploadedAt: new Date().toISOString(),
        storedPath: "uploads/smeta-1.xlsx",
        estimatePositions: [
          {
            id: "work-1",
            code: "ФЕР-КАБ",
            name: "Прокладка кабеля в траншее",
            unit: "м",
            quantity: 600,
            rate: 1000,
            isWorkItem: true,
            sectionName: "Сети",
            workName: "Прокладка кабеля в траншее",
          },
          {
            id: "work-2",
            code: "ФЕР-ЩЕБ",
            name: "Устройство щебеночного основания",
            unit: "м3",
            quantity: 1200,
            rate: 4000,
            isWorkItem: true,
            sectionName: "Основание",
            workName: "Устройство щебеночного основания",
          },
        ],
      });
      return data;
    });
    const made = makeOfficialCalculationAndSchedule("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.id === made.calculationId)!;
    const schedule = readAppData().schedules.find((item) => item.procurementId === created.id)!;
    expect(draft.positions.filter((position) => position.costRole === "customer_source")).toHaveLength(2);
    expect(made.shiftProfile).toMatchObject({
      personnelShiftsPerDay: 2,
      hoursPerShift: 11,
      overheadRate: 0.43,
      profitMarkupOnCostWithOh: 0.4,
    });
    const direct = 600 * 1000 + 1200 * 4000;
    const overhead = Math.round(direct * 0.43 * 100) / 100;
    expect(draft.referenceReprice?.direct).toBe(direct);
    expect(draft.referenceReprice?.overhead).toBe(overhead);
    expect(draft.referenceReprice?.reserve).toBe(Math.round((direct + overhead) * 0.1 * 100) / 100);
    expect(draft.referenceReprice?.profit).toBeGreaterThan(0);
    expect(draft.referenceReprice?.C0).toBe(direct + overhead);
    expect(draft.costSummary?.C0 ?? 0).not.toBeCloseTo(draft.referenceReprice!.C0, 0);
    expect(displayedEconomicsSummary(draft.costSummary, draft.referenceReprice)?.overhead).toBe(overhead);
    expect(schedule.stages.length).toBeGreaterThan(0);
    expect(schedule.stages.some((stage) => (stage.durationDays ?? 0) > 0)).toBe(true);
    expect(new Set(schedule.stages.map((stage) => stage.start)).size).toBeGreaterThan(1);
  });
});
