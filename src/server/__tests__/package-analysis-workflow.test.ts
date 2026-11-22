import { beforeEach, describe, expect, it, vi } from "vitest";

const model = vi.hoisted(() => ({ analyze: vi.fn(), fallback: vi.fn() }));
vi.mock("@/server/project-analysis-ai", () => ({
  analyzeProjectPackageWithModel: model.analyze,
  buildProjectAnalysisFallback: model.fallback,
}));

import { documentSetHash } from "@/server/document-set-hash";
import { config } from "@/server/config";
import { closeDb, ensureReady, mutateAppData, readAppData } from "@/server/db";
import { analyzeProcurementPackageWithAI, createManualProcurement, packageAnalysisAlreadyCurrent, refreshProcurementAnalytics, sendProcurementToCalculation } from "@/server/repo";
import { refreshAndMaybeAnalyzePackage } from "@/server/upload-package-analysis";
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

  it("skips a second automatic package analysis until the document set changes, and a direct call still runs", async () => {
    config.openRouterOnUpload = true;
    model.analyze.mockImplementation(async (_procurement, _documents, deterministic) => ({
      ...deterministic,
      method: "разбор пакета по цитатам документов",
      summary: "Готовность к решению: данных недостаточно. проверка",
    }));
    try {
      await analyzeProcurementPackageWithAI("u-tender", "p-2");
      expect(packageAnalysisAlreadyCurrent("p-2")).toBe(true);
      expect(readAppData().procurements.find((item) => item.id === "p-2")?.analytics?.sourceDocumentHash).toMatch(/^[a-f0-9]{64}$/);
      model.analyze.mockClear();
      await refreshAndMaybeAnalyzePackage("u-tender", "p-2");
      expect(model.analyze).not.toHaveBeenCalled();
      await analyzeProcurementPackageWithAI("u-tender", "p-2");
      expect(model.analyze).toHaveBeenCalledOnce();
    } finally {
      config.openRouterOnUpload = false;
    }
  });

  it("keeps the AI memo when a calculation is formed", () => {
    const summary = "Готовность к решению: данных недостаточно. Эту записку нельзя стереть расчётом.";
    mutateAppData((data) => {
      const procurement = data.procurements.find((item) => item.id === "p-2")!;
      procurement.analytics = {
        recommendation: "insufficient_data",
        summary,
        missingInputs: ["Нет договора"],
        citationIds: ["c-kept"],
        citations: [{ id: "c-kept", text: "Срок 10 дней.", page: 1, sourceFile: "tz.pdf" }],
        findings: [{
          topic: "Сроки",
          importance: "high",
          text: "Срок 10 дней.",
          quote: "Срок 10 дней.",
          citationIds: ["c-kept"],
          sourceFiles: ["tz.pdf"],
        }],
        generatedAt: "2026-11-01T00:00:00.000Z",
        method: "разбор пакета по цитатам документов",
        disclaimer: "проверка",
        answeredByModel: "google/gemini-2.5-flash",
        memoSource: "model",
        sourceDocumentHash: documentSetHash(data.documents.filter((document) => document.procurementId === "p-2" && document.storedPath)),
        quality: {
          status: "needs_review",
          sourceDocuments: 2,
          requiredDocumentsFound: 2,
          citationCount: 4,
          acceptedClaims: 1,
          rejectedClaims: 0,
        },
      };
      return data;
    });
    refreshProcurementAnalytics("u-tender", "p-2");
    const refreshed = readAppData().procurements.find((item) => item.id === "p-2")!.analytics!;
    expect(refreshed.quality).toMatchObject({ status: "needs_review", acceptedClaims: 1, rejectedClaims: 0 });
    expect(refreshed.summary).toBe(summary);
    sendProcurementToCalculation("u-tender", "p-2");
    const analytics = readAppData().procurements.find((item) => item.id === "p-2")!.analytics!;
    expect(analytics.summary).toBe(summary);
    expect(analytics.answeredByModel).toBe("google/gemini-2.5-flash");
    expect(analytics.findings?.[0]?.text).toBe("Срок 10 дней.");
    expect(analytics.sourceDocumentHash).toBe(documentSetHash(readAppData().documents.filter((document) => document.procurementId === "p-2" && document.storedPath)));
    expect(analytics.method).toBe("разбор пакета по цитатам документов");
    expect(analytics.missingInputs).not.toEqual(["Нет договора"]);
    expect(analytics.quality).toMatchObject({ status: "needs_review", acceptedClaims: 1, rejectedClaims: 0 });
    expect(analytics.quality?.status).not.toBe("evidence_backed");
  });

  it("rebuilds a local readiness note when the documents change", () => {
    const created = createManualProcurement("u-ruk", { title: "Локальная сводка", region: "Ямал" });
    refreshProcurementAnalytics("u-ruk", created.id);
    const before = readAppData().procurements.find((item) => item.id === created.id)!.analytics!;
    expect(before.summary.startsWith("Готовность к решению")).toBe(true);
    expect(before.answeredByModel).toBeUndefined();
    expect(before.memoSource).not.toBe("model");
    mutateAppData((data) => {
      const procurement = data.procurements.find((item) => item.id === created.id)!;
      data.documents.push({
        id: "doc-local-change",
        orgId: procurement.orgId,
        procurementId: procurement.id,
        title: "Новая смета",
        fileName: "new-estimate.xlsx",
        fileType: "xlsx",
        category: "estimate",
        status: "gotovo",
        versions: [],
        analyticalNote: "",
        citations: [],
        highlights: [],
        uploadedBy: "u-tender",
        uploadedAt: "2026-11-22T00:00:00.000Z",
        storedPath: "uploads/new-estimate.xlsx",
        estimatePositions: [{ id: "e1", code: "ФЕР", name: "Бурение", unit: "м", quantity: 10, rate: 1 }],
      });
      return data;
    });
    refreshProcurementAnalytics("u-ruk", created.id);
    const after = readAppData().procurements.find((item) => item.id === created.id)!.analytics!;
    expect(after.summary).not.toBe(before.summary);
    expect(after.summary.startsWith("Готовность к решению")).toBe(true);
    expect(after.summary).toContain("распознано");
    expect(after.summary).not.toContain("Документы изменились, обновите разбор");
    expect(after.answeredByModel).toBeUndefined();
  });

  it("keeps a model memo while the document set is unchanged", () => {
    const summary = "Готовность к решению: данных недостаточно. Модельная записка того же набора.";
    mutateAppData((data) => {
      const procurement = data.procurements.find((item) => item.id === "p-2")!;
      procurement.analytics = {
        recommendation: "insufficient_data",
        summary,
        missingInputs: [],
        citationIds: [],
        citations: [],
        findings: [],
        generatedAt: "2026-11-01T00:00:00.000Z",
        method: "разбор пакета по цитатам документов",
        disclaimer: "проверка",
        memoSource: "model",
        answeredByModel: "google/gemini-2.5-flash",
        sourceDocumentHash: documentSetHash(data.documents.filter((document) => document.procurementId === "p-2" && document.storedPath)),
        quality: { status: "needs_review", sourceDocuments: 1, requiredDocumentsFound: 1, citationCount: 1, acceptedClaims: 1, rejectedClaims: 0 },
      };
      return data;
    });
    refreshProcurementAnalytics("u-tender", "p-2");
    const kept = readAppData().procurements.find((item) => item.id === "p-2")!.analytics!;
    expect(kept.summary).toBe(summary);
    expect(kept.answeredByModel).toBe("google/gemini-2.5-flash");
    expect(kept.memoSource).toBe("model");
    expect(kept.quality).toMatchObject({ acceptedClaims: 1, rejectedClaims: 0, status: "needs_review" });
  });

  it("does not present a model memo as current after the document set changes", () => {
    const summary = "Готовность к решению: данных недостаточно. Старая модельная записка.";
    mutateAppData((data) => {
      const procurement = data.procurements.find((item) => item.id === "p-2")!;
      procurement.analytics = {
        recommendation: "participate",
        summary,
        missingInputs: [],
        citationIds: [],
        citations: [],
        findings: [{
          topic: "Сроки",
          importance: "high",
          text: "Старый вывод модели.",
          quote: "цитата",
          citationIds: [],
          sourceFiles: [],
        }],
        generatedAt: "2026-11-01T00:00:00.000Z",
        method: "разбор пакета по цитатам документов",
        disclaimer: "проверка",
        memoSource: "model",
        answeredByModel: "google/gemini-2.5-flash",
        sourceDocumentHash: documentSetHash(data.documents.filter((document) => document.procurementId === "p-2" && document.storedPath)),
        quality: { status: "evidence_backed", sourceDocuments: 1, requiredDocumentsFound: 1, citationCount: 1, acceptedClaims: 1, rejectedClaims: 0 },
      };
      data.documents.push({
        id: "doc-model-stale",
        orgId: procurement.orgId,
        procurementId: procurement.id,
        title: "Ещё один файл",
        fileName: "extra.xlsx",
        fileType: "xlsx",
        category: "estimate",
        status: "gotovo",
        versions: [],
        analyticalNote: "",
        citations: [],
        highlights: [],
        uploadedBy: "u-tender",
        uploadedAt: "2026-11-22T01:00:00.000Z",
        storedPath: "uploads/extra.xlsx",
        estimatePositions: [{ id: "e2", code: "ФЕР", name: "Монтаж", unit: "м", quantity: 3, rate: 2 }],
      });
      return data;
    });
    refreshProcurementAnalytics("u-tender", "p-2");
    const stale = readAppData().procurements.find((item) => item.id === "p-2")!.analytics!;
    expect(stale.summary.startsWith("Документы изменились, обновите разбор")).toBe(true);
    expect(stale.summary).not.toBe(summary);
    expect(stale.summary).not.toContain("Старая модельная записка");
    expect(stale.answeredByModel).toBeUndefined();
    expect(stale.memoSource).toBe("local");
    expect(stale.memoStale).toBe(true);
    expect(stale.findings).toBeUndefined();
    refreshProcurementAnalytics("u-tender", "p-2");
    const still = readAppData().procurements.find((item) => item.id === "p-2")!.analytics!;
    expect(still.summary.startsWith("Документы изменились, обновите разбор")).toBe(true);
    expect(still.memoStale).toBe(true);
    expect(still.summary).not.toContain("Старая модельная записка");
  });

  it("keeps a legacy model memo and backfills its hash until the files change", async () => {
    const created = createManualProcurement("u-ruk", { title: "Старый разбор", region: "Ямал" });
    const summary = "Готовность к решению: данных недостаточно. Оплаченный разбор без хеша.";
    const finding = {
      topic: "Сроки",
      importance: "high" as const,
      text: "Старый вывод модели.",
      quote: "цитата",
      citationIds: [] as string[],
      sourceFiles: [] as string[],
    };
    mutateAppData((data) => {
      const procurement = data.procurements.find((item) => item.id === created.id)!;
      procurement.analytics = {
        recommendation: "participate",
        summary,
        missingInputs: [],
        citationIds: [],
        citations: [],
        findings: [finding],
        generatedAt: "2026-11-01T00:00:00.000Z",
        method: "разбор пакета по цитатам документов",
        disclaimer: "проверка",
      };
      return data;
    });
    const onUpload = config.openRouterOnUpload;
    config.openRouterOnUpload = true;
    try {
      await refreshAndMaybeAnalyzePackage("u-ruk", created.id);
    } finally {
      config.openRouterOnUpload = onUpload;
    }
    expect(model.analyze).not.toHaveBeenCalled();
    const refreshed = readAppData().procurements.find((item) => item.id === created.id)!.analytics!;
    const currentHash = documentSetHash(readAppData().documents.filter((document) => document.procurementId === created.id && document.storedPath));
    expect(refreshed.summary).toBe(summary);
    expect(refreshed.findings?.[0]?.text).toBe("Старый вывод модели.");
    expect(refreshed.memoSource).toBe("model");
    expect(refreshed.sourceDocumentHash).toBe(currentHash);
    expect(refreshed.answeredByModel).toBeUndefined();
    sendProcurementToCalculation("u-ruk", created.id);
    const sent = readAppData().procurements.find((item) => item.id === created.id)!.analytics!;
    expect(sent.summary).toBe(summary);
    expect(sent.findings?.[0]?.text).toBe("Старый вывод модели.");
    expect(sent.memoSource).toBe("model");

    mutateAppData((data) => {
      const procurement = data.procurements.find((item) => item.id === created.id)!;
      data.documents.push({
        id: "doc-legacy-change",
        orgId: procurement.orgId,
        procurementId: procurement.id,
        title: "Новый файл",
        fileName: "after-backfill.xlsx",
        fileType: "xlsx",
        category: "estimate",
        status: "gotovo",
        versions: [],
        analyticalNote: "",
        citations: [],
        highlights: [],
        uploadedBy: "u-ruk",
        uploadedAt: "2026-11-22T02:00:00.000Z",
        storedPath: "uploads/after-backfill.xlsx",
      });
      return data;
    });
    refreshProcurementAnalytics("u-ruk", created.id);
    refreshProcurementAnalytics("u-ruk", created.id);
    const stale = readAppData().procurements.find((item) => item.id === created.id)!.analytics!;
    expect(stale.summary.startsWith("Документы изменились, обновите разбор")).toBe(true);
    expect(stale.summary).not.toContain("Оплаченный разбор без хеша");
    expect(stale.memoStale).toBe(true);
    expect(stale.memoSource).toBe("local");
    expect(stale.findings).toBeUndefined();
  });

  it("keeps a legacy memo that has model findings but no method marker", () => {
    const created = createManualProcurement("u-ruk", { title: "Разбор по выводам", region: "Ямал" });
    const summary = "Выводы модели без поля method.";
    mutateAppData((data) => {
      const procurement = data.procurements.find((item) => item.id === created.id)!;
      procurement.analytics = {
        recommendation: "insufficient_data",
        summary,
        missingInputs: [],
        citationIds: [],
        citations: [],
        findings: [{
          topic: "Оплата",
          importance: "medium",
          text: "Аванс 30 процентов.",
          quote: "аванс 30%",
          citationIds: [],
          sourceFiles: [],
        }],
        generatedAt: "2026-11-01T00:00:00.000Z",
        method: "черновик карточки",
        disclaimer: "проверка",
      };
      return data;
    });
    refreshProcurementAnalytics("u-ruk", created.id);
    const kept = readAppData().procurements.find((item) => item.id === created.id)!.analytics!;
    expect(kept.summary).toBe(summary);
    expect(kept.findings?.[0]?.text).toBe("Аванс 30 процентов.");
    expect(kept.memoSource).toBe("model");
    expect(kept.sourceDocumentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps the five-block local note when a calculation is formed", () => {
    const created = createManualProcurement("u-ruk", { title: "Локальная сводка в расчёт", region: "Ямал" });
    refreshProcurementAnalytics("u-ruk", created.id);
    const note = readAppData().procurements.find((item) => item.id === created.id)!.analytics!;
    expect(note.summary.startsWith("Готовность к решению")).toBe(true);
    sendProcurementToCalculation("u-ruk", created.id);
    const sent = readAppData().procurements.find((item) => item.id === created.id)!.analytics!;
    expect(sent.summary.startsWith("Готовность к решению")).toBe(true);
    expect(sent.summary).toContain("1. Паспорт закупки и тайминг");
    expect(sent.summary).toContain("2. Условия участия и требования к заявке");
    expect(sent.summary).toContain("3. Сводная ведомость объёмов");
    expect(sent.summary).toContain("4. Расчёт себестоимости и экономика");
    expect(sent.summary).toContain("5. Риски и подводные камни");
    expect(sent.summary.startsWith("Проект «")).toBe(false);
    expect(sent.memoSource).toBe("local");
    expect(sent.memoStale).toBeUndefined();
  });

  it("rejects an unknown procurement before model invocation", async () => {
    await expect(analyzeProcurementPackageWithAI("u-tender", "missing-procurement")).rejects.toThrow("Закупка не найдена");
    expect(model.analyze).not.toHaveBeenCalled();
  });
});
