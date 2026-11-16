import { beforeEach, describe, expect, it, vi } from "vitest";

const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock("@/server/project-analysis-ai", () => ({ analyzeProjectPackageWithModel: model.analyze }));

import { closeDb, ensureReady, mutateAppData, readAppData } from "@/server/db";
import { analyzeProcurementPackageWithAI } from "@/server/repo";
import "./setup";

describe("package analysis workflow", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
    model.analyze.mockReset();
    model.analyze.mockImplementation(async (_procurement, _documents, deterministic) => deterministic);
  });

  it("prepares a draft even when called directly by upload analysis and marks absent totals incomplete", async () => {
    mutateAppData((data) => {
      const procurement = data.procurements.find((item) => item.id === "p-2")!;
      procurement.calculationId = undefined;
      procurement.originalCalculationId = undefined;
      data.documents = data.documents.filter((item) => item.procurementId !== procurement.id);
      return data;
    });
    await analyzeProcurementPackageWithAI("u-tender", "p-2");
    const data = readAppData();
    const procurement = data.procurements.find((item) => item.id === "p-2")!;
    const draft = data.calculations.find((item) => item.id === procurement.calculationId)!;
    expect(draft.kind).toBe("resource_draft");
    expect(model.analyze).toHaveBeenCalledOnce();
    expect(model.analyze.mock.calls[0][3]).toMatchObject({ cost: null, priceWithVat: null, incomplete: true });
    expect(procurement.analytics?.recommendation).toBe("insufficient_data");
  });

  it("rejects an unknown procurement before model invocation", async () => {
    await expect(analyzeProcurementPackageWithAI("u-tender", "missing-procurement")).rejects.toThrow("Закупка не найдена");
    expect(model.analyze).not.toHaveBeenCalled();
  });
});
