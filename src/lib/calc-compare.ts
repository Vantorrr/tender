/**
 * Compare customer original estimate vs own resource draft.
 * Causes are only from measurable diffs — never invented LLM prose.
 */

import { calculationTotals, roundMoney } from "@/lib/calc-math";
import type { CalcPosition, Calculation, CalcCompareRow } from "@/lib/types";

function keyOf(p: CalcPosition): string {
  return `${normalize(p.code)}||${normalize(p.unit)}`;
}

function normalize(value: string): string {
  return value.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, "");
}

function nameKeyOf(position: CalcPosition): string {
  return `${normalize(position.name)}||${normalize(position.unit)}`;
}

export function compareCalculations(
  original: Calculation | null | undefined,
  draft: Calculation | null | undefined
): {
  rows: CalcCompareRow[];
  totals: {
    originalWorks: number | null;
    draftWorks: number | null;
    originalTotal: number | null;
    draftTotal: number | null;
    deltaTotal: number | null;
  };
  notes: string[];
} {
  const notes: string[] = [];
  if (!original && !draft) {
    return {
      rows: [],
      totals: {
        originalWorks: null,
        draftWorks: null,
        originalTotal: null,
        draftTotal: null,
        deltaTotal: null,
      },
      notes: ["Нет исходной сметы и черновика для сравнения"],
    };
  }
  if (!original) notes.push("Исходная смета заказчика отсутствует");
  if (!draft) notes.push("Собственный черновик отсутствует");

  const originalPositions = (original?.positions ?? []).filter((p) => p.code !== "НР" && p.code !== "СП");
  const draftPositions = (draft?.positions ?? []).filter((p) => p.code !== "НР" && p.code !== "СП");
  const usedOriginal = new Set<number>();
  const usedDraft = new Set<number>();
  const pairs: Array<{ original?: CalcPosition; draft?: CalcPosition; method?: "code" | "name" }> = [];

  // Prefer stable estimate codes only when the key is unique on both sides.
  const originalByCode = new Map<string, number[]>();
  const draftByCode = new Map<string, number[]>();
  originalPositions.forEach((position, index) => {
    if (!normalize(position.code)) return;
    const key = keyOf(position);
    originalByCode.set(key, [...(originalByCode.get(key) ?? []), index]);
  });
  draftPositions.forEach((position, index) => {
    if (!normalize(position.code)) return;
    const key = keyOf(position);
    draftByCode.set(key, [...(draftByCode.get(key) ?? []), index]);
  });
  for (const [key, originalIndexes] of originalByCode) {
    const draftIndexes = draftByCode.get(key) ?? [];
    if (originalIndexes.length !== 1 || draftIndexes.length !== 1) continue;
    const originalIndex = originalIndexes[0];
    const draftIndex = draftIndexes[0];
    usedOriginal.add(originalIndex);
    usedDraft.add(draftIndex);
    pairs.push({ original: originalPositions[originalIndex], draft: draftPositions[draftIndex], method: "code" });
  }

  // Resource draft codes are often local IDs. Match by exact normalized name+unit
  // only when that key is unique on both remaining sides; ambiguous names stay
  // explicitly unmatched instead of being paired by array order.
  const unmatchedOriginalByName = new Map<string, number[]>();
  const unmatchedDraftByName = new Map<string, number[]>();
  originalPositions.forEach((position, index) => {
    if (usedOriginal.has(index)) return;
    const key = nameKeyOf(position);
    unmatchedOriginalByName.set(key, [...(unmatchedOriginalByName.get(key) ?? []), index]);
  });
  draftPositions.forEach((position, index) => {
    if (usedDraft.has(index)) return;
    const key = nameKeyOf(position);
    unmatchedDraftByName.set(key, [...(unmatchedDraftByName.get(key) ?? []), index]);
  });
  for (const [key, originalIndexes] of unmatchedOriginalByName) {
    const draftIndexes = unmatchedDraftByName.get(key) ?? [];
    if (originalIndexes.length !== 1 || draftIndexes.length !== 1) continue;
    const originalIndex = originalIndexes[0];
    const draftIndex = draftIndexes[0];
    const position = originalPositions[originalIndex];
    if (!normalize(position.name)) continue;
    usedOriginal.add(originalIndex);
    usedDraft.add(draftIndex);
    pairs.push({ original: position, draft: draftPositions[draftIndex], method: "name" });
  }
  originalPositions.forEach((position, index) => {
    if (!usedOriginal.has(index)) pairs.push({ original: position });
  });
  draftPositions.forEach((position, index) => {
    if (!usedDraft.has(index)) pairs.push({ draft: position });
  });

  const rows: CalcCompareRow[] = [];

  for (const pair of pairs) {
    const o = pair.original;
    const d = pair.draft;
    const code = o?.code ?? d?.code ?? "";
    const name = o?.name ?? d?.name ?? code;
    const unit = o?.unit ?? d?.unit ?? "";
    const oQty = o?.quantity ?? null;
    const dQty = d?.quantity ?? null;
    const oRate = o && !o.rateMissing ? o.rate : null;
    const dRate = d && !d.rateMissing ? d.rate : null;
    const oSum =
      oQty != null && oRate != null ? roundMoney(oQty * oRate) : null;
    const dSum =
      dQty != null && dRate != null
        ? roundMoney(dQty * dRate * (draft?.scenarioFactor || 1))
        : null;

    let status: CalcCompareRow["status"] = "matched";
    const reasons: string[] = [];
    if (!o && d) {
      status = "only_draft";
      reasons.push("Позиция есть только в собственном черновике");
    } else if (o && !d) {
      status = "only_original";
      reasons.push("Позиция есть только в смете заказчика");
    } else {
      if (oQty != null && dQty != null && oQty !== dQty) {
        status = "diff";
        reasons.push(
          `Объём: заказчик ${oQty} vs черновик ${dQty} (${unit || "ед."})`
        );
      }
      if (oRate != null && dRate != null && oRate !== dRate) {
        status = "diff";
        reasons.push(`Ставка: заказчик ${oRate} vs черновик ${dRate}`);
      }
      if (oRate == null || dRate == null) {
        if (status !== "diff") status = "incomplete";
        reasons.push(`Стоимость не сравнить: ставка ${oRate == null ? "заказчика" : "черновика"} не подтверждена`);
      }
      if (!reasons.length) {
        reasons.push(
          pair.method === "name"
            ? "Сопоставлено по точному наименованию и единице; отклонений по доступным полям нет"
            : "Совпадение по коду и единице в пределах доступных полей"
        );
      }
    }

    rows.push({
      code,
      name,
      unit,
      originalQty: oQty,
      draftQty: dQty,
      originalRate: oRate,
      draftRate: dRate,
      originalSum: oSum,
      draftSum: dSum,
      deltaSum:
        oSum != null && dSum != null ? roundMoney(dSum - oSum) : null,
      status,
      reason: reasons.join("; "),
      source:
        status === "only_draft"
          ? "resource_draft"
        : status === "only_original"
            ? "customer_original"
            : "both",
    });
  }

  const originalHasMissingRates = Boolean(original?.positions.some((position) => position.rateMissing));
  const draftHasMissingRates = Boolean(draft?.positions.some((position) => position.rateMissing));
  const oTot = original && !originalHasMissingRates ? calculationTotals(original) : null;
  const dTot = draft && !draftHasMissingRates ? calculationTotals(draft) : null;
  if (originalHasMissingRates || draftHasMissingRates) {
    notes.push("Итоги не рассчитаны: в одной из смет есть неподтверждённые ставки");
  }
  return {
    rows: rows.sort((a, b) => a.code.localeCompare(b.code, "ru")),
    totals: {
      originalWorks: oTot?.works ?? null,
      draftWorks: dTot?.works ?? null,
      originalTotal: oTot?.total ?? null,
      draftTotal: dTot?.total ?? null,
      deltaTotal:
        oTot && dTot ? roundMoney(dTot.total - oTot.total) : null,
    },
    notes,
  };
}
