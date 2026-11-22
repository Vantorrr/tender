import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentItem, Procurement, ProjectAnalytics } from "@/lib/types";

const complete = vi.hoisted(() => vi.fn());

vi.mock("@/server/openrouter", () => ({
  completeJsonWithUsage: complete,
  modelConfigured: () => true,
}));

import { analyzeProjectPackageWithModel } from "@/server/project-analysis-ai";

const modelPayload = {
  recommendation: "insufficient_data",
  missingInputs: ["В пакете нет проекта договора."],
  customerQuestions: [],
  evidence: [
    {
      topic: "schedule",
      importance: "high",
      text: "Срок выполнения 10 дней.",
      quote: "Срок выполнения 10 дней.",
      citationIds: ["c1"],
      costImpact: "не указано в документах",
      scheduleImpact: "не указано в документах",
    },
  ],
};

const procurement = {
  id: "p-det",
  orgId: "org-1",
  number: "T-DET",
  title: "Ремонт резервуара",
  customer: "Заказчик",
  region: "ЯНАО",
  nmck: 500000,
  deadline: "2026-12-01T09:00:00.000Z",
  source: "manual",
  status: "zagruzheno",
  reviewStatus: "novaya",
  syncStatus: "aktualno",
  syncAt: "2026-11-01T00:00:00.000Z",
  attachments: [],
  documentIds: ["d1"],
  tags: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  workType: "общестрой",
} as unknown as Procurement;

const documents = [
  {
    id: "d1",
    orgId: "org-1",
    procurementId: "p-det",
    title: "ТЗ",
    fileName: "tz.pdf",
    fileType: "pdf",
    category: "tz",
    status: "gotovo",
    versions: [],
    analyticalNote: "Срок выполнения 10 дней.",
    citations: [{ id: "c1", text: "Срок выполнения 10 дней.", page: 2, sourceFile: "tz.pdf" }],
    highlights: [],
    uploadedBy: "u-1",
    uploadedAt: "2026-11-01T00:00:00.000Z",
    storedPath: "uploads/tz.pdf",
    fileSize: 1200,
    estimatePositions: [],
    extractionErrors: [],
  },
] as unknown as DocumentItem[];

const deterministic = {
  recommendation: "insufficient_data",
  summary: "Локальная сводка пакета.",
  missingInputs: ["Не найден проект договора или недоступен."],
  citationIds: ["c1"],
  citations: [{ id: "c1", text: "Срок выполнения 10 дней.", page: 2, sourceFile: "tz.pdf" }],
  generatedAt: "2026-11-01T00:00:00.000Z",
  method: "локально",
  disclaimer: "",
  quality: {
    status: "needs_review",
    sourceDocuments: 1,
    requiredDocumentsFound: 1,
    citationCount: 1,
  },
} as ProjectAnalytics;

const economics = {
  cost: 0,
  priceExVat: null,
  priceWithVat: null,
  profit: null,
  profitabilityPercent: null,
  revenueMarginPercent: null,
  incomplete: true,
  missingRates: 3,
  missingRateNames: ["Бетон"],
};

describe("package analysis determinism", () => {
  beforeEach(() => {
    complete.mockReset();
    complete.mockResolvedValue({
      content: JSON.stringify(modelPayload),
      model: "mock/deterministic",
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
      cost: null,
      elapsedMs: 5,
      sourceUrls: [],
    });
  });

  it("assembles the same memo from the same fixture and the same model reply", async () => {
    const first = await analyzeProjectPackageWithModel(procurement, documents, deterministic, economics);
    const second = await analyzeProjectPackageWithModel(procurement, documents, deterministic, economics);
    const rest = (analytics: ProjectAnalytics) => {
      const { generatedAt: _generatedAt, ...stable } = analytics;
      return stable;
    };
    expect(rest(first)).toEqual(rest(second));
    expect(first.summary).toBe(second.summary);
    expect(first.summary.startsWith("Готовность к решению: данных недостаточно.")).toBe(true);
    expect(first.summary).toContain("Себестоимость не рассчитана: нет ставок для 3 строк");
    expect(first.summary).not.toMatch(/Вердикт ИИ|не рассчитана%/);
    expect(first.summary).not.toMatch(/(^|[^\d])0 ₽/);
    expect(first.answeredByModel).toBe("mock/deterministic");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0][3]).toMatchObject({ purpose: "package-analysis" });
    expect(complete.mock.calls[0][3].temperature).toBeUndefined();
  });
});
