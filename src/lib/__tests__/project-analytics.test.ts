import { describe, expect, it } from "vitest";
import type { DocumentItem, Procurement } from "@/lib/types";
import { buildProjectAnalytics } from "@/lib/project-analytics";

const procurement = {
  id: "p-analytics",
  orgId: "org-test",
  number: "T-1",
  title: "Ремонт здания",
  customer: "Заказчик",
  region: "ЯНАО",
  nmck: 5_000_000,
  deadline: "2026-12-01",
  source: "test",
  status: "zagruzheno",
  reviewStatus: "novaya",
  syncStatus: "aktualno",
  syncAt: "2026-11-16T00:00:00Z",
  attachments: [],
  documentIds: [],
  tags: [],
  createdAt: "2026-11-16T00:00:00Z",
} satisfies Procurement;

function document(id: string, fileName: string, category: DocumentItem["category"]): DocumentItem {
  return {
    id,
    orgId: procurement.orgId,
    procurementId: procurement.id,
    title: fileName,
    fileName,
    fileType: "pdf",
    category,
    status: "trebuet_proverki",
    versions: [],
    analyticalNote: "Документ разобран, текстовые выдержки извлечены и пригодны для проверки.",
    citations: [{ id: `${id}-c1`, text: "Объем работ: ремонт здания. Оплата по контракту после приемки.", page: 1, sourceFile: fileName }],
    highlights: [],
    uploadedBy: "u-test",
    uploadedAt: "2026-11-16T00:00:00Z",
    storedPath: `uploads/${id}.pdf`,
  };
}

describe("procurement analytics coverage", () => {
  it("does not block a complete package only because the customer's estimate is absent", () => {
    const analytics = buildProjectAnalytics(procurement, [
      document("contract", "Проект договора.pdf", "contract"),
      document("tz", "Техническое задание.pdf", "tz"),
    ]);

    expect(analytics.recommendation).toBe("participate");
    expect(analytics.quality?.status).toBe("evidence_backed");
    expect(analytics.missingInputs.join(" ")).toContain("смета заказчика не приложена");
    expect(analytics.summary).not.toContain("Блокирует рекомендацию");
  });

  it("explains exactly which required source is missing", () => {
    const analytics = buildProjectAnalytics(procurement, [document("contract", "Проект договора.pdf", "contract")]);

    expect(analytics.recommendation).toBe("insufficient_data");
    expect(analytics.missingInputs).toContain("не найдено ТЗ / извещение — объём и границы работ не подтверждены");
    expect(analytics.summary).toContain("Блокирует рекомендацию");
  });
});
