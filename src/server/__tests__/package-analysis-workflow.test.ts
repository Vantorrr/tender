import { beforeEach, describe, expect, it, vi } from "vitest";

const model = vi.hoisted(() => ({ analyze: vi.fn(), fallback: vi.fn() }));
vi.mock("@/server/project-analysis-ai", () => ({
  analyzeProjectPackageWithModel: model.analyze,
  buildProjectAnalysisFallback: model.fallback,
}));

import { closeDb, ensureReady, mutateAppData, readAppData } from "@/server/db";
import { analyzeProcurementPackageWithAI } from "@/server/repo";
import "./setup";

describe("package analysis workflow", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
    model.analyze.mockReset();
    model.fallback.mockReset();
    model.analyze.mockImplementation(async (_procurement, _documents, deterministic) => deterministic);
    model.fallback.mockImplementation((_procurement, deterministic, _economics, _company, failure) => ({
      ...deterministic,
      summary: `Локальная сводка после сбоя модели: ${failure}`,
      method: "deterministic_fallback_after_model_failure",
    }));
  });

  it("does not create a calculation or move the procurement when analyzing the package", async () => {
    mutateAppData((data) => {
      const procurement = data.procurements.find((item) => item.id === "p-2")!;
      procurement.calculationId = undefined;
      procurement.gprId = undefined;
      procurement.originalCalculationId = undefined;
      procurement.reviewStatus = "novaya";
      procurement.status = "zagruzheno";
      data.documents = data.documents.filter((item) => item.procurementId !== procurement.id);
      data.calculations = data.calculations.filter((item) => item.procurementId !== procurement.id);
      data.schedules = data.schedules.filter((item) => item.procurementId !== procurement.id);
      return data;
    });
    const result = await analyzeProcurementPackageWithAI("u-tender", "p-2");
    const data = readAppData();
    const procurement = data.procurements.find((item) => item.id === "p-2")!;
    expect(procurement.calculationId).toBeUndefined();
    expect(procurement.gprId).toBeUndefined();
    expect(procurement.reviewStatus).toBe("novaya");
    expect(procurement.status).toBe("zagruzheno");
    expect(data.calculations.some((item) => item.procurementId === "p-2")).toBe(false);
    expect(data.schedules.some((item) => item.procurementId === "p-2")).toBe(false);
    expect(model.analyze).toHaveBeenCalledOnce();
    expect(model.analyze.mock.calls[0][3]).toBeUndefined();
    expect(procurement.analytics?.recommendation).toBe("insufficient_data");
    expect(result.usedAi).toBe(true);
  });

  it("persists an actionable fallback instead of surfacing an empty-model error", async () => {
    mutateAppData((data) => {
      const procurement = data.procurements.find((item) => item.id === "p-2")!;
      procurement.analytics = undefined;
      return data;
    });
    model.analyze.mockRejectedValueOnce(new Error("Модель вернула пустой ответ после 3 попыток"));
    const result = await analyzeProcurementPackageWithAI("u-tender", "p-2");
    const procurement = readAppData().procurements.find((item) => item.id === "p-2")!;

    expect(result.usedAi).toBe(false);
    expect(result.warning).toContain("не вернула полный ответ");
    expect(model.fallback).toHaveBeenCalledOnce();
    expect(procurement.analytics?.method).toBe("deterministic_fallback_after_model_failure");
    expect(procurement.analytics?.summary).toContain("пустой ответ");
  });

  it("keeps a written note when the model fails", async () => {
    const kept = "Вердикт ИИ: 8 / 10 — эту записку нельзя заменить заглушкой";
    mutateAppData((data) => {
      const procurement = data.procurements.find((item) => item.id === "p-2")!;
      procurement.analytics = {
        recommendation: "participate",
        summary: kept,
        missingInputs: [],
        citationIds: [],
        citations: [],
        generatedAt: "2026-11-01T00:00:00Z",
        method: "разбор пакета по цитатам документов",
        disclaimer: "проверка",
      };
      return data;
    });
    model.analyze.mockRejectedValueOnce(new Error("Модель вернула пустой ответ после 3 попыток"));
    const result = await analyzeProcurementPackageWithAI("u-tender", "p-2");
    const procurement = readAppData().procurements.find((item) => item.id === "p-2")!;
    expect(result.usedAi).toBe(false);
    expect(result.warning).toBe("Разбор не удался, записка не менялась — попробуйте позже");
    expect(procurement.analytics?.summary).toBe(kept);
    expect(model.fallback).not.toHaveBeenCalled();
  });

  it("rejects an unknown procurement before model invocation", async () => {
    await expect(analyzeProcurementPackageWithAI("u-tender", "missing-procurement")).rejects.toThrow("Закупка не найдена");
    expect(model.analyze).not.toHaveBeenCalled();
  });
});
