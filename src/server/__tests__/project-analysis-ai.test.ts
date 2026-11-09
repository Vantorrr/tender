import { describe, expect, it } from "vitest";
import {
  gateModelRecommendation,
  parseProjectAnalysisResult,
  validateProjectEvidence,
} from "@/server/project-analysis-ai";
import type { ProjectAnalytics } from "@/lib/types";

const citations: ProjectAnalytics["citations"] = [
  {
    id: "c-contract-1",
    text: "Заказчик оплачивает работы в течение 60 календарных дней после подписания акта.",
    page: 12,
    sourceFile: "Проект договора.pdf",
  },
];

describe("grounded project analysis", () => {
  it("accepts only a paraphrase with an exact quote, valid source, and matching numbers", () => {
    const result = parseProjectAnalysisResult(JSON.stringify({
      recommendation: "participate",
      missingInputs: [],
      evidence: [
        {
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
    expect(checked.rejected).toBe(2);
  });

  it("never lets the model upgrade an incomplete local analysis", () => {
    expect(gateModelRecommendation("insufficient_data", "participate", false)).toBe("insufficient_data");
    expect(gateModelRecommendation("participate", "do_not_participate", false)).toBe("participate");
    expect(gateModelRecommendation("participate", "do_not_participate", true)).toBe("do_not_participate");
    expect(gateModelRecommendation("participate", "insufficient_data", false)).toBe("insufficient_data");
  });
});
