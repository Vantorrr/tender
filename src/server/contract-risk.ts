/**
 * Heuristic contract risk parser (no external NLP).
 * Scans plain text for typical tender/contract risk phrases and returns
 * remarks with source excerpts for the risk registry.
 */

import type { RiskRemark } from "@/lib/types";

export type ParsedRiskRemark = Omit<RiskRemark, "id">;

type Rule = {
  id: string;
  pattern: RegExp;
  text: string;
  severity: RiskRemark["severity"];
  excerptWindow?: number;
};

const RULES: Rule[] = [
  {
    id: "penalty-delay",
    pattern: /штраф[^.\n]{0,80}(срок|сутк|дн)/i,
    text: "Штрафные санкции за нарушение сроков",
    severity: "high",
  },
  {
    id: "penalty-pct",
    pattern: /(?:0[.,]\d+\s*%|\d+\s*%\s*в\s*сут)/i,
    text: "Штраф/пеня с процентной ставкой в сутки",
    severity: "high",
  },
  {
    id: "security",
    pattern: /обеспечени[ея]\s+исполнени[яи]\s+(контракта|договора)/i,
    text: "Требование обеспечения исполнения контракта",
    severity: "medium",
  },
  {
    id: "warranty",
    pattern: /гарантийн(ый|ого)\s+срок/i,
    text: "Гарантийные обязательства по сроку",
    severity: "low",
  },
  {
    id: "unilateral",
    pattern: /односторонн(ий|его)\s+отказ/i,
    text: "Право одностороннего отказа заказчика",
    severity: "high",
  },
  {
    id: "retention",
    pattern: /удержани[ея]\s+\d+\s*%/i,
    text: "Удержание процента от суммы работ",
    severity: "medium",
  },
  {
    id: "force-majeure",
    pattern: /обстоятельств[а]\s+непреодолимой\s+силы|форс[- ]?мажор/i,
    text: "Оговорка о форс-мажоре",
    severity: "low",
  },
];

function excerptAround(text: string, index: number, len: number, window = 90): string {
  const start = Math.max(0, index - 20);
  const end = Math.min(text.length, index + len + window);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/** Parse contract body; empty/short text falls back to baseline demo remarks. */
export function parseContractRisks(contractText: string | null | undefined): ParsedRiskRemark[] {
  const text = (contractText ?? "").trim();
  if (text.length < 40) {
    return baselineRemarks();
  }

  const found: ParsedRiskRemark[] = [];
  const seen = new Set<string>();
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    if (seen.has(rule.id)) continue;
    seen.add(rule.id);
    found.push({
      text: rule.text,
      sourceExcerpt: excerptAround(text, match.index, match[0].length, rule.excerptWindow),
      status: "otkryto",
      severity: rule.severity,
    });
  }

  return found.length > 0 ? found : baselineRemarks();
}

function baselineRemarks(): ParsedRiskRemark[] {
  return [
    {
      text: "Штраф за срыв сроков свыше 0,1% в сутки",
      sourceExcerpt: "п. 8.3 договора подряда",
      status: "otkryto",
      severity: "high",
    },
    {
      text: "Обеспечение исполнения контракта 10%",
      sourceExcerpt: "п. 5.1",
      status: "otkryto",
      severity: "medium",
    },
    {
      text: "Гарантийный срок 60 месяцев",
      sourceExcerpt: "п. 12.2",
      status: "otkryto",
      severity: "low",
    },
  ];
}
