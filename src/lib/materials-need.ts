/**
 * Material need list from calc positions + stage material resources.
 * Does not invent catalog rows — only surfaces missing rates for user input.
 */
import type { CalcPosition, GprStage } from "@/lib/types";

export type MaterialNeedRow = {
  source: "calc_position" | "stage_resource";
  key: string;
  name: string;
  unit: string;
  quantity: number;
  rate: number | null;
  amount: number | null;
  stageId?: string;
  stageName?: string;
  positionId?: string;
  missing: string[];
};

function isMaterialPosition(p: CalcPosition): boolean {
  const hay = `${p.code} ${p.name} ${p.unit}`.toLowerCase();
  return /матер|м²|м2|т\b|сэндвич|бетон|арматур|компл/.test(hay);
}

export function buildMaterialNeeds(opts: {
  positions: CalcPosition[];
  stages?: GprStage[];
}): MaterialNeedRow[] {
  const rows: MaterialNeedRow[] = [];

  for (const p of opts.positions) {
    if (!isMaterialPosition(p)) continue;
    const rate = Number.isFinite(p.rate) && p.rate > 0 ? p.rate : null;
    const missing: string[] = [];
    if (rate == null) missing.push("rate");
    if (!p.quantity) missing.push("quantity");
    rows.push({
      source: "calc_position",
      key: `pos:${p.id}`,
      name: p.name,
      unit: p.unit,
      quantity: p.quantity,
      rate,
      amount: rate == null ? null : Math.round(p.quantity * rate * 100) / 100,
      positionId: p.id,
      missing,
    });
  }

  for (const st of opts.stages ?? []) {
    for (const r of st.resources ?? []) {
      if (r.kind !== "material") continue;
      const rate = r.rate != null && Number.isFinite(r.rate) && r.rate > 0 ? r.rate : null;
      const missing: string[] = [];
      if (rate == null) missing.push("rate");
      rows.push({
        source: "stage_resource",
        key: `res:${r.id}`,
        name: r.name,
        unit: r.unit,
        quantity: r.quantity,
        rate,
        amount: rate == null ? null : Math.round(r.quantity * rate * 100) / 100,
        stageId: st.id,
        stageName: st.name,
        missing,
      });
    }
  }

  return rows;
}

export function materialNeedsIncomplete(rows: MaterialNeedRow[]): string[] {
  return rows.flatMap((r) =>
    r.missing.map((m) => `${m}:${r.name}`)
  );
}
