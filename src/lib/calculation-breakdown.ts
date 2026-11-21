import { positionLineSum } from "@/lib/calc-math";
import { plainPositionName } from "@/lib/format";
import type { CalcPosition, Citation, DocumentItem } from "@/lib/types";

export type CalculationBreakdownRow = {
  /** Plain article name. Estimate codes stay out of this column. */
  what: string;
  /** Kopeck sum already stored on the line. Null when the rate is missing. */
  amount: number | null;
  fileName: string;
  place: string;
  href?: string;
};

type SourceDocument = Pick<DocumentItem, "id" | "fileName" | "title"> & {
  citations?: Citation[];
};

function hasReadableName(value: string): boolean {
  return /[а-яё]{3,}/iu.test(value);
}

/** Article title for the breakdown. Codes and internal ids are not the name. */
export function calculationArticleName(position: Pick<CalcPosition, "name" | "code" | "sourceSectionName" | "sourceWorkName">): string {
  const name = plainPositionName(position.name ?? "").trim();
  if (hasReadableName(name) && name !== position.code.trim()) return name;
  const work = position.sourceWorkName?.trim() ?? "";
  if (hasReadableName(work)) return work;
  const section = position.sourceSectionName?.trim() ?? "";
  if (hasReadableName(section)) return section;
  return "Позиция без названия";
}

function sheetFor(document: SourceDocument | undefined, position: Pick<CalcPosition, "name" | "sourceSectionName">): string {
  const citations = document?.citations ?? [];
  const named = citations.find((citation) => {
    if (!citation.sheet) return false;
    const text = citation.text ?? "";
    return (position.name && text.includes(position.name))
      || (position.sourceSectionName && text.includes(position.sourceSectionName));
  });
  return named?.sheet?.trim() || "";
}

/**
 * One row per priced line. Amounts use the same line formula as the calculation
 * table, so the breakdown does not invent a second total.
 */
export function calculationBreakdownRows(
  positions: CalcPosition[],
  documents: SourceDocument[],
  factor = 1,
): CalculationBreakdownRow[] {
  return positions.filter((position) => !position.isWorkItem).map((position) => {
    const document = position.sourceDocumentId
      ? documents.find((item) => item.id === position.sourceDocumentId)
      : undefined;
    const sheet = sheetFor(document, position);
    const section = position.sourceSectionName?.trim() ?? "";
    const fileName = document?.fileName?.trim() || document?.title?.trim() || "";
    const place = [sheet ? `лист ${sheet}` : "", section ? `раздел ${section}` : ""].filter(Boolean).join(" · ");
    const href = document
      ? `/cabinet/dokumenty/${document.id}${sheet ? `?sheet=${encodeURIComponent(sheet)}` : ""}`
      : undefined;
    return {
      what: calculationArticleName(position),
      amount: position.rateMissing ? null : positionLineSum(position, factor),
      fileName: fileName || "Файл не указан",
      place,
      href,
    };
  });
}
