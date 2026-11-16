import { describe, expect, it } from "vitest";
import { citationTextForDisplay, readableCitations, regionFromCitations, submissionDeadlineFromCitations } from "@/lib/citation-display";
import type { Citation } from "@/lib/types";

const citation = (text: string, confidence: Citation["confidence"] = "confirmed"): Citation => ({
  id: text.slice(0, 12), text, page: 1, sourceFile: "Приглашение.docx", confidence,
});

describe("readable source citations", () => {
  it("hides empty placeholders and keeps a real region from a mixed field", () => {
    expect(citationTextForDisplay(citation("зона: нет данных", "unconfirmed"))).toBeNull();
    expect(citationTextForDisplay(citation("Срок подачи предложения", "heuristic"))).toBeNull();
    const mixed = citation("Регион в смете: Ямало-Ненецкий автономный округ; зона сметного района: не указана в файле", "unconfirmed");
    expect(citationTextForDisplay(mixed)).toBe("Регион в смете: Ямало-Ненецкий автономный округ");
    expect(regionFromCitations([mixed])).toBe("Ямало-Ненецкий автономный округ");
  });

  it("extracts the submission deadline only from a submission clause", () => {
    const citations = [
      citation("Срок выполнения работ до 31.03.2027", "heuristic"),
      citation("Срок подачи предложения 20.11.2026 в 14:30", "heuristic"),
    ];
    expect(submissionDeadlineFromCitations(citations)).toBe("20.11.2026, 14:30");
    expect(submissionDeadlineFromCitations([citation("Срок подачи предложения")])).toBeNull();
  });

  it("strips estimate shifres in the short view and preserves a readable item", () => {
    const item = citation("ФЕРм-08-02-369 Монтаж кабеля — 120 м");
    expect(citationTextForDisplay(item)).toBe("Монтаж кабеля — 120 м");
    expect(readableCitations([citation("зона: нет данных", "unconfirmed"), item])).toHaveLength(1);
  });
});
