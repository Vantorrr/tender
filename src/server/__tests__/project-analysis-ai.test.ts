import { describe, expect, it } from "vitest";
import {
  gateModelRecommendation,
  parseProjectAnalysisResult,
  validateProjectEvidence,
  selectAnalysisCitations,
  economicMissingInputs,
  companyAnalysisMissingInputs,
  buildProjectAnalysisFallback,
} from "@/server/project-analysis-ai";
import type { ProjectAnalytics, Procurement } from "@/lib/types";

const citations: ProjectAnalytics["citations"] = [
  {
    id: "c-contract-1",
    text: "Заказчик оплачивает работы в течение 60 календарных дней после подписания акта.",
    page: 12,
    sourceFile: "Проект договора.pdf",
  },
];

describe("grounded project analysis", () => {
  it("keeps payment and penalty clauses after a long estimate table within the source budget", () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ id: `row-${index}`, text: `Сметная строка ${index}`, page: index + 1, sourceFile: "Пакет.pdf" }));
    const selected = selectAnalysisCitations([...rows,
      { id: "payment", text: "Оплата после подписания акта в течение 60 дней.", page: 101, sourceFile: "Пакет.pdf" },
      { id: "penalty", text: "Неустойка за каждый день просрочки исполнения обязательств.", page: 102, sourceFile: "Пакет.pdf" },
    ]);
    expect(selected).toHaveLength(40);
    expect(selected.map((item) => item.id)).toContain("payment");
    expect(selected.map((item) => item.id)).toContain("penalty");
    expect(new Set(selected.map((item) => item.id)).size).toBe(selected.length);
  });

  it("explains actual missing calculation inputs using resource names", () => {
    const missing = economicMissingInputs({ cost: null, priceWithVat: null, incomplete: true, missingRates: 2, missingRateNames: ["Автобус", "Бетон"], incompleteReasons: ["vat_percent", "north:camp:Проживание"] });
    expect(missing.join(" ")).toContain("Автобус; Бетон");
    expect(missing.join(" ")).toContain("НДС");
    expect(missing.join(" ")).toContain("Проживание");
    expect(economicMissingInputs({ cost: 100, priceExVat: 100, priceWithVat: 120, incomplete: false, missingRates: 0 })).toEqual([]);
  });

  it("calls out missing company service and availability registers rather than inventing fit", () => {
    expect(companyAnalysisMissingInputs({
      profileRows: [], laborRates: [], fleet: [], serviceCatalogPresent: false,
      resourceAvailabilityTracked: false, riskRemarks: [],
    })).toHaveLength(2);
  });

  it("keeps economics and a conservative recommendation when the model fails", () => {
    const procurement = {
      id: "p-1", orgId: "org-1", number: "T-1", title: "Ремонт", customer: "Заказчик",
      region: "ЯНАО", nmck: 2000, deadline: "", source: "test", status: "zagruzheno",
      reviewStatus: "novaya", syncStatus: "aktualno", syncAt: "", attachments: [],
      documentIds: [], tags: [], createdAt: "",
    } as unknown as Procurement;
    const deterministic: ProjectAnalytics = {
      recommendation: "participate", summary: "Покрытие документов проверено.", missingInputs: [],
      citationIds: [], citations, generatedAt: "", method: "test", disclaimer: "",
      quality: { status: "evidence_backed", sourceDocuments: 2, requiredDocumentsFound: 2, citationCount: 1 },
    };
    const fallback = buildProjectAnalysisFallback(procurement, deterministic, {
      cost: 1000, priceExVat: 1200, priceWithVat: 1440, profit: 200,
      profitabilityPercent: 20, revenueMarginPercent: 16.67, incomplete: false, missingRates: 0,
    }, {
      profileRows: [{ okpd: "41.20" }], laborRates: [], fleet: [{ name: "Экскаватор", quantity: 1 }],
      serviceCatalogPresent: true, resourceAvailabilityTracked: false, riskRemarks: [],
    }, "пустой ответ");

    expect(fallback.recommendation).toBe("insufficient_data");
    expect(fallback.economics).toMatchObject({ cost: 1000, profit: 200, profitabilityPercent: 20, complete: true });
    expect(fallback.summary).toContain("ИИ-анализ не завершился");
    expect(fallback.missingInputs.join(" ")).toContain("календарь занятости");
  });

  it("accepts only a paraphrase with an exact quote, valid source, and matching numbers", () => {
    const result = parseProjectAnalysisResult(JSON.stringify({
      recommendation: "participate",
      missingInputs: [],
      evidence: [
        {
          topic: "payment",
          importance: "high",
          text: "Срок оплаты составляет 60 дней.",
          quote: "Заказчик оплачивает работы в течение 60 календарных дней",
          citationIds: ["c-contract-1"],
        },
        {
          text: "Штраф составляет 5 млн рублей.",
          quote: "Заказчик оплачивает работы в течение 60 календарных дней",
          citationIds: ["c-contract-1"],
        },
        {
          text: "Срок оплаты составляет 60 дней.",
          quote: "Заказчик оплачивает работы в течение 60 календарных дней",
          citationIds: ["invented-id"],
        },
      ],
    }));

    const checked = validateProjectEvidence(result, citations, new Set(["c-contract-1"]));
    expect(checked.accepted.map((item) => item.text)).toEqual(["Срок оплаты составляет 60 дней."]);
    expect(checked.accepted[0]).toMatchObject({ topic: "payment", importance: "high" });
    expect(checked.rejected).toBe(2);
  });

  it("normalizes percent words and decimal commas without weakening source matching", () => {
    const source = [{
      id: "penalty-1",
      text: "Штраф: 0,1 процента за каждый день просрочки.",
      page: 4,
      sourceFile: "Договор.pdf",
    }];
    const result = parseProjectAnalysisResult(JSON.stringify({
      recommendation: "insufficient_data",
      missingInputs: [],
      evidence: [{
        topic: "liability",
        importance: "high",
        text: "За каждый день просрочки начисляется штраф 0.1%.",
        quote: "Штраф: 0,1 процента за каждый день просрочки.",
        citationIds: ["penalty-1"],
      }],
    }));
    const checked = validateProjectEvidence(result, source);
    expect(checked.accepted).toHaveLength(1);
    expect(checked.rejected).toBe(0);
  });

  it("never lets the model upgrade an incomplete local analysis", () => {
    expect(gateModelRecommendation("insufficient_data", "participate", false)).toBe("insufficient_data");
    expect(gateModelRecommendation("participate", "do_not_participate", false)).toBe("participate");
    expect(gateModelRecommendation("participate", "do_not_participate", true)).toBe("do_not_participate");
    expect(gateModelRecommendation("participate", "insufficient_data", false)).toBe("insufficient_data");
  });
});
