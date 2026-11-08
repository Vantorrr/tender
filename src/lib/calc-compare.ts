/**
 * Compare customer original estimate vs own resource draft.
 * Causes are only from measurable diffs — never invented LLM prose.
 */

import { calculationTotals, roundMoney } from "@/lib/calc-math";
import type { CalcPosition, Calculation, CalcCompareRow } from "@/lib/types";

function keyOf(p: CalcPosition): string {
  return `${p.code}||${p.unit}`.toLowerCase();
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

  const oMap = new Map(
    (original?.positions ?? [])
      .filter((p) => p.code !== "НР" && p.code !== "СП")
      .map((p) => [keyOf(p), p])
  );
  const dMap = new Map(
    (draft?.positions ?? [])
      .filter((p) => p.code !== "НР" && p.code !== "СП")
      .map((p) => [keyOf(p), p])
  );
  const keys = new Set([...oMap.keys(), ...dMap.keys()]);
  const rows: CalcCompareRow[] = [];

  for (const key of keys) {
    const o = oMap.get(key);
    const d = dMap.get(key);
    const code = o?.code ?? d?.code ?? key;
    const name = o?.name ?? d?.name ?? code;
    const unit = o?.unit ?? d?.unit ?? "";
    const oQty = o?.quantity ?? null;
    const dQty = d?.quantity ?? null;
    const oRate = o?.rate ?? null;
    const dRate = d?.rate ?? null;
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
      if (!reasons.length) {
        reasons.push("Совпадение по коду/единице в пределах доступных полей");
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

  const oTot = original ? calculationTotals(original) : null;
  const dTot = draft ? calculationTotals(draft) : null;
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
