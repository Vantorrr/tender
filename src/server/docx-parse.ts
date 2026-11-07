/**
 * DOCX paragraph extraction (Office Open XML) — no mammoth dependency.
 * Citations use 1-based paragraph indexes into the document body.
 */

import JSZip from "jszip";
import type {
  CardStatus,
  Citation,
  DocumentAnalysis,
  Highlight,
} from "@/lib/types";
import { parseDecimal } from "@/lib/calc-math";
import {
  parseContractRisksDetailed,
  RISK_HELPER_DISCLAIMER,
} from "@/server/contract-risk";

/** Same shape as grand-smeta UploadAnalysis — kept local to avoid import cycle. */
export type DocxUploadAnalysis = {
  title: string;
  analyticalNote: string;
  citations: Citation[];
  highlights: Highlight[];
  status: CardStatus;
  analysis: DocumentAnalysis;
  positions: [];
  noteByModel?: boolean;
};

export type DocxParagraph = {
  /** 1-based index among non-empty body paragraphs. */
  index: number;
  text: string;
};

export type DocxParse = {
  paragraphs: DocxParagraph[];
  plainText: string;
  sourceVersion: string;
};

function stripXml(raw: string): string {
  return raw
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract ordered non-empty paragraphs from a DOCX buffer. */
export async function parseDocxBuffer(buf: Buffer): Promise<DocxParse | null> {
  try {
    const zip = await JSZip.loadAsync(buf);
    const docFile = zip.file("word/document.xml");
    if (!docFile) return null;
    const xml = await docFile.async("string");
    const blocks = xml.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) ?? [];
    const paragraphs: DocxParagraph[] = [];
    for (const block of blocks) {
      const texts = [...block.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(
        (m) => stripXml(m[1] ?? "")
      );
      const text = texts.join("").trim();
      if (!text) continue;
      paragraphs.push({ index: paragraphs.length + 1, text });
    }
    return {
      paragraphs,
      plainText: paragraphs.map((p) => p.text).join("\n"),
      sourceVersion: "docx-body",
    };
  } catch {
    return null;
  }
}

function findParagraph(
  paragraphs: DocxParagraph[],
  pattern: RegExp
): DocxParagraph | undefined {
  return paragraphs.find((p) => pattern.test(p.text));
}

function cite(
  id: string,
  para: DocxParagraph | undefined,
  fallback: string,
  fileName: string,
  sourceVersion: string,
  confidence: Citation["confidence"]
): Citation {
  return {
    id,
    text: (para?.text ?? fallback).slice(0, 400),
    page: 1,
    sourceFile: fileName,
    paragraph: para?.index,
    sourceVersion,
    confidence: para ? confidence : "unconfirmed",
  };
}

/**
 * Build analysis from DOCX: facts only when located in a paragraph.
 * Unconfirmed / missing → «нет данных», never invent volumes/prices.
 */
export function analysisFromDocx(
  fileName: string,
  parsed: DocxParse
): DocxUploadAnalysis {
  const { paragraphs, plainText, sourceVersion } = parsed;
  const zonePara = findParagraph(paragraphs, /зон[аеы]\s*\d+/i);
  const volumePara = findParagraph(
    paragraphs,
    /объ[её]м|п\.?\s*м\.?|м²|м2|штук/i
  );
  const costPara = findParagraph(
    paragraphs,
    /стоимост|руб|нмцк|цена/i
  );
  const termPara = findParagraph(
    paragraphs,
    /срок|гарант|обеспечен|штраф/i
  );

  const zoneMatch = zonePara?.text.match(/зон[аеы]\s*(\d+)/i);
  const zone = zoneMatch?.[1] ?? "";
  const volumeMatch = volumePara?.text.match(
    /(\d[\d\s]*[,.]?\d*)\s*(п\.?\s*м\.?|м²|м2|шт\.?|штук)/i
  );
  const volume =
    volumeMatch != null
      ? `${volumeMatch[1].trim()} ${volumeMatch[2].replace(/\s+/g, "")}`
      : "";
  const costRaw = costPara?.text.match(
    /(\d[\d\s]*[,.]?\d*)\s*(?:руб|тыс)/i
  )?.[1];
  const cost = parseDecimal(costRaw);

  const citations: Citation[] = [
    cite(
      "c-docx-zone",
      zonePara,
      "зона: нет данных",
      fileName,
      sourceVersion,
      "confirmed"
    ),
    cite(
      "c-docx-volume",
      volumePara,
      "объём: нет данных",
      fileName,
      sourceVersion,
      "confirmed"
    ),
    cite(
      "c-docx-cost",
      costPara,
      "стоимость: нет данных",
      fileName,
      sourceVersion,
      "confirmed"
    ),
    cite(
      "c-docx-terms",
      termPara,
      "сроки/условия: нет данных",
      fileName,
      sourceVersion,
      "heuristic"
    ),
  ];

  const risks = parseContractRisksDetailed(plainText);
  const highlights: Highlight[] = [];
  if (!zone) {
    highlights.push({
      id: "h-docx-zone",
      text: "Зона не найдена",
      reason: "В абзацах нет «зона N» — не угадываем.",
      severity: "warning",
      page: 1,
    });
  }
  if (!volume) {
    highlights.push({
      id: "h-docx-vol",
      text: "Объём не найден",
      reason: "Нет явной величины с единицей измерения.",
      severity: "warning",
      page: 1,
    });
  }
  if (cost == null) {
    highlights.push({
      id: "h-docx-cost",
      text: "Стоимость не найдена",
      reason: "Нет числа с «руб»/«тыс» — пишем «нет данных».",
      severity: "warning",
      page: 1,
    });
  }
  for (const remark of risks.remarks.slice(0, 5)) {
    const para = paragraphs.find((p) =>
      p.text.includes(remark.sourceExcerpt.slice(0, 40))
    );
    highlights.push({
      id: `h-risk-${remark.text.slice(0, 12)}`,
      text: remark.text,
      reason: `${RISK_HELPER_DISCLAIMER} Источник: ${remark.sourceExcerpt.slice(0, 120)}`,
      severity: remark.severity === "high" ? "critical" : "warning",
      page: 1,
    });
    if (para) {
      citations.push({
        id: `c-risk-${citations.length}`,
        text: remark.sourceExcerpt.slice(0, 240),
        page: 1,
        sourceFile: fileName,
        paragraph: para.index,
        sourceVersion,
        confidence: "heuristic",
      });
    }
  }
  if (paragraphs.length === 0) {
    highlights.push({
      id: "h-docx-empty",
      text: "DOCX без абзацев",
      reason: "word/document.xml не содержит текста.",
      severity: "critical",
      page: 1,
    });
  }

  const analyticalNote = [
    `Разбор DOCX: ${paragraphs.length} абз. Источник версий: ${sourceVersion}.`,
    `Зона: ${zone || "нет данных"}.`,
    `Объём: ${volume || "нет данных"}.`,
    `Стоимость: ${cost != null ? `${cost} (из текста)` : "нет данных"}.`,
    termPara
      ? `Условия (абз. ${termPara.index}): ${termPara.text.slice(0, 200)}`
      : "Сроки/условия: нет данных.",
    risks.status === "ok"
      ? `Риски (эвристика, не юрэкспертиза): ${risks.remarks.map((r) => r.text).join("; ")}.`
      : "Риски по тексту: нет данных.",
    RISK_HELPER_DISCLAIMER,
  ].join("\n");

  return {
    title: fileName.replace(/\.[^.]+$/, "") || fileName,
    analyticalNote,
    citations,
    highlights,
    status: highlights.some((h) => h.severity === "critical")
      ? "trebuet_proverki"
      : zone && volume && cost != null
        ? "gotovo"
        : "trebuet_proverki",
    positions: [],
    analysis: {
      vendor: "",
      region: "",
      zone,
      estimateNumber: "",
      workName: volume || "",
      basis: "DOCX paragraphs",
      priceLevel: "",
      costThousand: cost != null && /тыс/i.test(costPara?.text ?? "")
        ? cost
        : cost != null
          ? Math.round((cost / 1000) * 100) / 100
          : null,
      positionCount: 0,
      profileMatch: false,
    },
  };
}

/** Reject citations that claim a paragraph index outside the source. */
export function citationParagraphValid(
  citation: Citation,
  paragraphCount: number
): boolean {
  if (citation.paragraph == null) return true;
  return (
    Number.isInteger(citation.paragraph) &&
    citation.paragraph >= 1 &&
    citation.paragraph <= paragraphCount
  );
}
