/**
 * Hierarchical estimate tree for PDF-style UI (t25u).
 * Amounts use shared resolveResourceDimensions (same Q/R as cost-engine / export).
 */
import { roundMoney } from "@/lib/calc-math";
import { classifyDirectCostBucket } from "@/lib/cost-engine";
import {
  resolveResourceDimensions,
  type ResolvedResourceDims,
} from "@/lib/resource-dimensions";
import {
  EXCEL_RESOURCE_SCHEDULE_DEFAULTS,
  type ResourceScheduleParams,
} from "@/lib/resource-schedule-model";
import type {
  CalcPosition,
  GprStage,
  GprStageResource,
  ResourceQuantityBasis,
} from "@/lib/types";

export type EstimateKind = "labor" | "equipment" | "material" | "bus" | "other";

export type EstimateLeaf = {
  id: string;
  source: "stage_resource" | "calc_position";
  kind: EstimateKind;
  name: string;
  unit: string;
  /** Editable source L (count / hours / material qty). */
  quantity: number;
  rate: number | null;
  amount: number | null;
  stageId?: string;
  positionId?: string;
  sourceDocumentId?: string;
  sourceCode?: string;
  /** Parsed estimate work row that owns this resource. */
  workName?: string;
  workKey?: string;
  incomplete: string[];
  basis?: ResourceQuantityBasis;
  /** Q hours when applicable (count_per_shift / total_hours). */
  hoursQ?: number | null;
  hoursPerShift?: number | null;
  shiftsPerDay?: number | null;
  days?: number | null;
};

export type EstimateGroup = {
  kind: EstimateKind;
  label: string;
  leaves: EstimateLeaf[];
  subtotal: number | null;
  incomplete: boolean;
};

export type EstimateWorkNode = {
  id: string;
  name: string;
  groups: EstimateGroup[];
  subtotal: number | null;
  incomplete: boolean;
  planVolume?: number;
  planUnit?: string;
};

export type EstimateStageNode = {
  id: string;
  name: string;
  groups: EstimateGroup[];
  works: EstimateWorkNode[];
  unassignedGroups: EstimateGroup[];
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

function leafFromResolved(
  r: GprStageResource,
  st: GprStage,
  resolved: ResolvedResourceDims,
  sourcePosition?: CalcPosition
): EstimateLeaf {
  const work = sourcePosition ? positionWork(sourcePosition, st) : undefined;
  return {
    id: r.id,
    source: "stage_resource",
    kind: resourceKind(r),
    name: r.name,
    unit: r.unit || (r.kind === "labor" ? "чел" : "ед."),
    quantity: resolved.sourceQty,
    rate: resolved.rate,
    amount: resolved.amount,
    stageId: st.id,
    sourceCode: r.sourceKey,
    ...(work ? { workName: work.name, workKey: work.key } : {}),
    incomplete: resolved.incomplete.length
      ? resolved.incomplete
      : resolved.amount == null
        ? ["incomplete"]
        : [],
    basis: resolved.basis,
    hoursQ: resolved.hours,
    hoursPerShift: resolved.hoursPerShift,
    shiftsPerDay: resolved.shiftsPerDay,
    days: resolved.days,
  };
}

function resourceKind(r: GprStageResource): EstimateKind {
  if (r.kind === "labor") return "labor";
  if (r.kind === "material") return "material";
  if (r.kind === "equipment") return "equipment";
  if (r.kind === "bus") return "bus";
  return "other";
}

function estimateKindFromPosition(p: CalcPosition): EstimateKind {
  if (p.resourceKind === "labor") return "labor";
  if (p.resourceKind === "equipment") return "equipment";
  if (p.resourceKind === "bus") return "bus";
  if (p.resourceKind === "material") return "material";
  const bucket = classifyDirectCostBucket(p);
  if (bucket === "labor") return "labor";
  if (bucket === "materials") return "material";
  if (bucket === "equipment") return "equipment";
  return "other";
}

function positionWork(position: CalcPosition, stage: GprStage): { key: string; name: string } | undefined {
  const work = position.sourceWorkName?.trim();
  const section = position.sourceSectionName?.trim();
  const sectionIsDistinct = section && section !== stage.name && section !== stage.sectionName;
  if (work && work !== stage.name) {
    return { key: `${sectionIsDistinct ? section : ""}\u0000${work}`, name: work };
  }
  if (sectionIsDistinct) return { key: `${section}\u0000${section}`, name: section };
  return undefined;
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
  /** Live calc.resourceScheduleParams — required for non-default N/O hours/shifts. */
  params?: ResourceScheduleParams;
}): EstimateStageNode[] {
  const params = opts.params ?? EXCEL_RESOURCE_SCHEDULE_DEFAULTS;
  const q = (opts.search ?? "").trim().toLowerCase();
  const match = (text: string) =>
    !q || text.toLowerCase().includes(q);
  const normalizeStageLabel = (value?: string) =>
    (value ?? "")
      .normalize("NFKC")
      .toLocaleLowerCase("ru-RU")
      .replace(/ё/g, "е")
      .replace(/[«»„“”"']/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const labelsMatch = (left: string, right: string) =>
    left === right ||
    (Math.min(left.length, right.length) >= 32 &&
      (left.startsWith(right) || right.startsWith(left)));

  const nodes: EstimateStageNode[] = [];
  const representedWorkPositionIds = new Set<string>();
  const representedSourcePositionIds = new Set<string>();
  const positionsById = new Map((opts.positions ?? []).map((position) => [position.id, position]));

  for (const st of opts.stages.slice().sort((a, b) => a.sequence - b.sequence)) {
    const leaves: EstimateLeaf[] = [];
    const workVolumes = new Map<string, { name: string; quantity: number; unit: string }>();
    const linkedSourceKeys = new Set<string>();
    const linkedResourceIds = new Set<string>();
    for (const r of st.resources ?? []) {
      const isEmptyTemplate = r.quantity === 0 && r.rate == null && !r.sourceKey &&
        (/^указать (?:материалы|технику|транспорт)/iu.test(r.name) || /^бригада\s*[·-]/iu.test(r.name));
      if (isEmptyTemplate) continue;
      const resolved = resolveResourceDimensions(r, st, params);
      const sourcePosition = r.sourceKey ? positionsById.get(r.sourceKey) : undefined;
      const leaf = leafFromResolved(r, st, resolved, sourcePosition);
      linkedResourceIds.add(r.id);
      if (r.sourceKey) {
        linkedSourceKeys.add(r.sourceKey);
        representedSourcePositionIds.add(r.sourceKey);
      }
      if (
        match(st.name) ||
        match(leaf.name) ||
        match(KIND_LABEL[leaf.kind])
      ) {
        leaves.push(leaf);
      }
    }
    for (const p of opts.positions ?? []) {
      const parentWorkCode = /^(?:ЕНИР|ФЕР|ТЕР|ГЭСН)(?:М)?/iu.test(p.code.trim());
      const positionLabels = [p.sourceStageName, p.sourceWorkName, p.sourceSectionName]
        .map(normalizeStageLabel)
        .filter(Boolean);
      const stageLabels = [st.name, st.workName, st.sectionName]
        .map(normalizeStageLabel)
        .filter(Boolean);
      const belongsToStage = positionLabels.some((positionLabel) =>
        stageLabels.some((stageLabel) => labelsMatch(positionLabel, stageLabel))
      );
      if (
        !belongsToStage ||
        (p.sourceResourceId != null && linkedResourceIds.has(p.sourceResourceId)) ||
        linkedSourceKeys.has(p.id)
      ) continue;
      if (p.isWorkItem) {
        const work = positionWork(p, st) ?? { key: `${p.name.trim()}`, name: p.name.trim() };
        const current = workVolumes.get(work.key);
        if (work.name && (!current || current.unit === p.unit)) {
          workVolumes.set(work.key, { name: work.name, quantity: (current?.quantity ?? 0) + p.quantity, unit: p.unit });
        }
        representedWorkPositionIds.add(p.id);
        continue;
      }
      if (parentWorkCode && p.name.trim() === (st.workName?.trim() || st.name)) {
        representedWorkPositionIds.add(p.id);
        continue;
      }
      const kind = estimateKindFromPosition(p);
      const rate = p.rateMissing || !(Number.isFinite(p.rate) && p.rate > 0) ? null : p.rate;
      const amount = rate == null ? null : roundMoney(p.quantity * rate);
      const work = positionWork(p, st);
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
        sourceDocumentId: p.sourceDocumentId,
        sourceCode: p.code,
        ...(work ? { workName: work.name, workKey: work.key } : {}),
        incomplete: rate == null ? ["rate"] : [],
        basis: kind === "material" ? "material_qty" : "uncertain",
        hoursQ: null,
      };
      if (match(st.name) || match(leaf.name) || match(KIND_LABEL[kind])) leaves.push(leaf);
      linkedSourceKeys.add(p.id);
    }
    if (leaves.length === 0 && q && !match(st.name)) continue;
    const groups = groupLeaves(leaves);
    const { subtotal, incomplete } = stageSubtotal(groups);
    const leavesByWork = new Map<string, EstimateLeaf[]>();
    for (const leaf of leaves) {
      if (!leaf.workKey) continue;
      leavesByWork.set(leaf.workKey, [...(leavesByWork.get(leaf.workKey) ?? []), leaf]);
    }
    const workKeys = [...new Set([...leavesByWork.keys(), ...workVolumes.keys()])];
    const unassignedGroups = groupLeaves(leaves.filter((leaf) => !leaf.workName));
    const works = workKeys.map((key) => {
      const workGroups = groupLeaves(leavesByWork.get(key) ?? []);
      const summary = stageSubtotal(workGroups);
      const volume = workVolumes.get(key);
      return {
        id: `${st.id}:work:${key}`,
        name: volume?.name ?? leavesByWork.get(key)?.[0]?.workName ?? key,
        groups: workGroups,
        subtotal: summary.subtotal,
        incomplete: summary.incomplete,
        ...(volume ? { planVolume: volume.quantity, planUnit: volume.unit } : {}),
      };
    });
    nodes.push({
      id: st.id,
      name: st.name,
      groups,
      works,
      unassignedGroups,
      subtotal,
      incomplete,
    });
  }

  const sectionedNames = new Set(
    nodes.flatMap((node) => node.groups.flatMap((group) => group.leaves
      .filter((leaf) => leaf.source === "calc_position")
      .map((leaf) => leaf.id)))
  );
  const unbound: EstimateLeaf[] = [];
  for (const p of opts.positions ?? []) {
    if (p.isWorkItem) continue;
    if (p.code === "НР" || p.code === "СП") continue;
    if (representedWorkPositionIds.has(p.id)) continue;
    if (representedSourcePositionIds.has(p.id)) continue;
    if (sectionedNames.has(p.id) || representedWorkPositionIds.has(p.id)) continue;
    const positionLabels = [p.sourceStageName, p.sourceWorkName, p.sourceSectionName]
      .map(normalizeStageLabel)
      .filter(Boolean);
    const isLinkedToAnyStage = opts.stages.some((stage) => {
      const labels = [stage.name, stage.workName, stage.sectionName]
        .map(normalizeStageLabel)
        .filter(Boolean);
      return positionLabels.some((positionLabel) => labels.some((label) => labelsMatch(positionLabel, label)));
    });
    if (isLinkedToAnyStage) continue;
    const kind = estimateKindFromPosition(p);
    const rate =
      p.rateMissing || !(Number.isFinite(p.rate) && p.rate > 0)
        ? null
        : p.rate;
    const amount =
      rate == null ? null : roundMoney(p.quantity * rate);
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
      sourceDocumentId: p.sourceDocumentId,
      sourceCode: p.code,
      workName: p.sourceWorkName?.trim() || p.sourceSectionName?.trim() || undefined,
      incomplete: rate == null ? ["rate"] : [],
      basis: kind === "material" ? "material_qty" : "total_hours",
      hoursQ: kind === "material" || kind === "other" ? null : p.quantity,
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
      works: [],
      unassignedGroups: groups,
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
  /** Прочие — never silently folded into materials. */
  other: number | null;
  totalKnown: number | null;
  /** V direct (S+T+U); excludes any separate "other" rows. */
  directKnown: number | null;
  incomplete: boolean;
} {
  let labor = 0;
  let equipment = 0;
  let materials = 0;
  let other = 0;
  let anyLabor = false;
  let anyEq = false;
  let anyMat = false;
  let anyOther = false;
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
      } else if (g.kind === "other") {
        other += g.subtotal;
        anyOther = true;
      }
    }
  }
  const parts = [
    anyLabor ? labor : null,
    anyEq ? equipment : null,
    anyMat ? materials : null,
    anyOther ? other : null,
  ].filter((n): n is number => n != null);
  const directParts = [
    anyLabor ? labor : null,
    anyEq ? equipment : null,
    anyMat ? materials : null,
  ].filter((n): n is number => n != null);
  return {
    labor: anyLabor ? roundMoney(labor) : null,
    equipment: anyEq ? roundMoney(equipment) : null,
    materials: anyMat ? roundMoney(materials) : null,
    other: anyOther ? roundMoney(other) : null,
    totalKnown: parts.length ? roundMoney(parts.reduce((s, n) => s + n, 0)) : null,
    directKnown:
      directParts.length > 0
        ? roundMoney(directParts.reduce((s, n) => s + n, 0))
        : null,
    incomplete,
  };
}
