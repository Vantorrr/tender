/**
 * Hierarchical estimate tree for PDF-style UI (t25u).
 * Excel supplies qty×rate arithmetic; grouping is product UI, not Excel chrome.
 */
import { roundMoney } from "@/lib/calc-math";
import type { CalcPosition, GprStage, GprStageResource } from "@/lib/types";

export type EstimateKind = "labor" | "equipment" | "material" | "bus" | "other";

export type EstimateLeaf = {
  id: string;
  source: "stage_resource" | "calc_position";
  kind: EstimateKind;
  name: string;
  unit: string;
  quantity: number;
  rate: number | null;
  amount: number | null;
  stageId?: string;
  positionId?: string;
  incomplete: string[];
};

export type EstimateGroup = {
  kind: EstimateKind;
  label: string;
  leaves: EstimateLeaf[];
  subtotal: number | null;
  incomplete: boolean;
};

export type EstimateStageNode = {
  id: string;
  name: string;
  groups: EstimateGroup[];
  subtotal: number | null;
  incomplete: boolean;
};

const KIND_LABEL: Record<EstimateKind, string> = {
  labor: "Люди",
  equipment: "Техника",
  material: "Материалы",
  bus: "Автобусы",
  other: "Прочее",
};

const KIND_ORDER: EstimateKind[] = [
  "labor",
  "equipment",
  "bus",
  "material",
  "other",
];

function leafAmount(qty: number, rate: number | null): {
  amount: number | null;
  incomplete: string[];
} {
  if (rate == null || !Number.isFinite(rate) || rate < 0) {
    return { amount: null, incomplete: ["rate"] };
  }
  if (!Number.isFinite(qty)) {
    return { amount: null, incomplete: ["quantity"] };
  }
  return { amount: roundMoney(qty * rate), incomplete: [] };
}

function resourceKind(r: GprStageResource): EstimateKind {
  if (r.kind === "labor") return "labor";
  if (r.kind === "material") return "material";
  if (r.kind === "equipment") return "equipment";
  if (r.kind === "bus") return "bus";
  return "other";
}

function isMaterialPosition(p: CalcPosition): boolean {
  if (p.code === "НР" || p.code === "СП") return false;
  const hay = `${p.code} ${p.name} ${p.unit}`.toLowerCase();
  return /матер|м²|м2|т\b|сэндвич|бетон|арматур|компл/.test(hay);
}

function isLaborPosition(p: CalcPosition): boolean {
  if (p.code === "НР" || p.code === "СП") return false;
  const hay = `${p.code} ${p.name}`.toLowerCase();
  return /труд|чел|рабоч|монтажн|сварщ|бетонщ|арматурщ/.test(hay);
}

function isEquipmentPosition(p: CalcPosition): boolean {
  if (p.code === "НР" || p.code === "СП") return false;
  const hay = `${p.code} ${p.name}`.toLowerCase();
  return /техник|кран|экскаватор|каток|самосвал|машино|маш-ч/.test(hay);
}

function groupLeaves(leaves: EstimateLeaf[]): EstimateGroup[] {
  const byKind = new Map<EstimateKind, EstimateLeaf[]>();
  for (const leaf of leaves) {
    const list = byKind.get(leaf.kind) ?? [];
    list.push(leaf);
    byKind.set(leaf.kind, list);
  }
  return KIND_ORDER.filter((k) => byKind.has(k)).map((kind) => {
    const ls = byKind.get(kind)!;
    const incomplete = ls.some((l) => l.incomplete.length > 0 || l.amount == null);
    const known = ls.filter((l) => l.amount != null).map((l) => l.amount as number);
    const subtotal =
      known.length === 0
        ? null
        : roundMoney(known.reduce((s, n) => s + n, 0));
    return {
      kind,
      label: KIND_LABEL[kind],
      leaves: ls,
      subtotal: incomplete && known.length === 0 ? null : subtotal,
      incomplete,
    };
  });
}

function stageSubtotal(groups: EstimateGroup[]): {
  subtotal: number | null;
  incomplete: boolean;
} {
  const incomplete = groups.some((g) => g.incomplete);
  const vals = groups
    .map((g) => g.subtotal)
    .filter((n): n is number => n != null);
  if (vals.length === 0) return { subtotal: null, incomplete };
  return { subtotal: roundMoney(vals.reduce((s, n) => s + n, 0)), incomplete };
}

/** Build stage→kind→leaf tree from GPR resources (+ optional unbound calc materials). */
export function buildHierarchicalEstimate(opts: {
  stages: GprStage[];
  positions?: CalcPosition[];
  search?: string;
}): EstimateStageNode[] {
  const q = (opts.search ?? "").trim().toLowerCase();
  const match = (text: string) =>
    !q || text.toLowerCase().includes(q);

  const nodes: EstimateStageNode[] = [];

  for (const st of opts.stages.slice().sort((a, b) => a.sequence - b.sequence)) {
    const leaves: EstimateLeaf[] = [];
    for (const r of st.resources ?? []) {
      const { amount, incomplete } = leafAmount(r.quantity, r.rate ?? null);
      const leaf: EstimateLeaf = {
        id: r.id,
        source: "stage_resource",
        kind: resourceKind(r),
        name: r.name,
        unit: r.unit || (r.kind === "labor" ? "чел" : "ед."),
        quantity: r.quantity,
        rate: r.rate ?? null,
        amount,
        stageId: st.id,
        incomplete,
      };
      if (
        match(st.name) ||
        match(leaf.name) ||
        match(KIND_LABEL[leaf.kind])
      ) {
        leaves.push(leaf);
      }
    }
    if (leaves.length === 0 && q && !match(st.name)) continue;
    const groups = groupLeaves(leaves);
    const { subtotal, incomplete } = stageSubtotal(groups);
    nodes.push({
      id: st.id,
      name: st.name,
      groups,
      subtotal,
      incomplete,
    });
  }

  // Calc positions not already mirrored as stage materials — under «Без этапа»
  const unbound: EstimateLeaf[] = [];
  for (const p of opts.positions ?? []) {
    if (p.code === "НР" || p.code === "СП") continue;
    let kind: EstimateKind = "other";
    if (isMaterialPosition(p)) kind = "material";
    else if (isLaborPosition(p)) kind = "labor";
    else if (isEquipmentPosition(p)) kind = "equipment";
    else continue; // skip unclassified noise for tree clarity
    const rate = Number.isFinite(p.rate) && p.rate > 0 ? p.rate : null;
    const { amount, incomplete } = leafAmount(p.quantity, rate);
    const leaf: EstimateLeaf = {
      id: p.id,
      source: "calc_position",
      kind,
      name: p.name,
      unit: p.unit,
      quantity: p.quantity,
      rate,
      amount,
      positionId: p.id,
      incomplete,
    };
    if (match(leaf.name) || match(KIND_LABEL[kind])) unbound.push(leaf);
  }
  if (unbound.length) {
    const groups = groupLeaves(unbound);
    const { subtotal, incomplete } = stageSubtotal(groups);
    nodes.push({
      id: "_unbound",
      name: "Позиции расчёта (вне этапов ГПР)",
      groups,
      subtotal,
      incomplete,
    });
  }

  return nodes;
}

export function estimateBudgetCards(nodes: EstimateStageNode[]): {
  labor: number | null;
  equipment: number | null;
  materials: number | null;
  totalKnown: number | null;
  incomplete: boolean;
} {
  let labor = 0;
  let equipment = 0;
  let materials = 0;
  let anyLabor = false;
  let anyEq = false;
  let anyMat = false;
  let incomplete = false;
  for (const n of nodes) {
    if (n.incomplete) incomplete = true;
    for (const g of n.groups) {
      if (g.incomplete) incomplete = true;
      if (g.subtotal == null) continue;
      if (g.kind === "labor") {
        labor += g.subtotal;
        anyLabor = true;
      } else if (g.kind === "equipment" || g.kind === "bus") {
        equipment += g.subtotal;
        anyEq = true;
      } else if (g.kind === "material") {
        materials += g.subtotal;
        anyMat = true;
      }
    }
  }
  const parts = [
    anyLabor ? labor : null,
    anyEq ? equipment : null,
    anyMat ? materials : null,
  ].filter((n): n is number => n != null);
  return {
    labor: anyLabor ? roundMoney(labor) : null,
    equipment: anyEq ? roundMoney(equipment) : null,
    materials: anyMat ? roundMoney(materials) : null,
    totalKnown: parts.length ? roundMoney(parts.reduce((s, n) => s + n, 0)) : null,
    incomplete,
  };
}
