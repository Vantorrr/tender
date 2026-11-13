"use client";

import { Fragment, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { formatMoney, formatNumber } from "@/lib/format";
import {
  buildHierarchicalEstimate,
  type EstimateLeaf,
} from "@/lib/hierarchical-estimate";
import type {
  CalcPosition,
  GprStage,
  GprStageResource,
} from "@/lib/types";
import type { ResourceScheduleParams } from "@/lib/resource-schedule-model";

type Props = {
  stages: GprStage[];
  positions: CalcPosition[];
  params?: ResourceScheduleParams;
  onPatchResource: (
    stageId: string,
    resourceId: string,
    patch: Partial<GprStageResource>
  ) => void;
  onPatchPosition: (positionId: string, patch: Partial<CalcPosition>) => void;
};

type LeafPatch = {
  name?: string;
  unit?: string;
  quantity?: number;
  rate?: number | null;
};

export function GprResourceTree({
  stages,
  positions,
  params,
  onPatchResource,
  onPatchPosition,
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const nodes = useMemo(
    () => buildHierarchicalEstimate({ stages, positions, params }),
    [stages, positions, params]
  );
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));

  function patch(leaf: EstimateLeaf, values: LeafPatch) {
    if (leaf.source === "stage_resource" && leaf.stageId) {
      onPatchResource(leaf.stageId, leaf.id, values);
    } else if (leaf.positionId) {
      const { rate, ...rest } = values;
      onPatchPosition(leaf.positionId, {
        ...rest,
        ...(rate === undefined ? {} : { rate: rate ?? 0, rateMissing: rate === null }),
      });
    }
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--tk-line)] bg-white/80" data-testid="gpr-resource-tree">
      <table className="min-w-[760px] w-full text-left text-sm tabular-nums" data-testid="gpr-resource-table">
        <thead className="bg-stone-100 text-xs text-[var(--tk-muted)]">
          <tr>
            <th className="px-3 py-2">Работа / ресурс</th>
            <th className="px-3 py-2">Ед.</th>
            <th className="px-3 py-2 text-right">Количество</th>
            <th className="px-3 py-2 text-right">Цена за ед.</th>
            <th className="px-3 py-2 text-right">Сумма</th>
            <th className="px-3 py-2">Срок работы</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((node, index) => {
            const stage = stageById.get(node.id);
            const isCollapsed = collapsed[node.id] ?? false;
            return (
              <FragmentRows
                key={node.id}
                node={node}
                index={index}
                stage={stage}
                collapsed={isCollapsed}
                onToggle={() => setCollapsed((current) => ({ ...current, [node.id]: !isCollapsed }))}
                onPatch={patch}
              />
            );
          })}
          {nodes.length === 0 ? (
            <tr><td colSpan={6} className="px-3 py-6 text-sm text-[var(--tk-muted)]">Нет работ или ресурсов для показа.</td></tr>
          ) : null}
        </tbody>
      </table>
      <p className="border-t border-[var(--tk-line)] px-3 py-2 text-xs text-[var(--tk-muted)]">
        Материалы показаны внутри своей работы из тех же строк ГПР и ресурсного расчёта. Цена без подтверждённой ставки остаётся незаполненной.
      </p>
    </div>
  );
}

function FragmentRows({
  node,
  index,
  stage,
  collapsed,
  onToggle,
  onPatch,
}: {
  node: ReturnType<typeof buildHierarchicalEstimate>[number];
  index: number;
  stage?: GprStage;
  collapsed: boolean;
  onToggle: () => void;
  onPatch: (leaf: EstimateLeaf, values: LeafPatch) => void;
}) {
  const hasNestedRows = node.groups.some((group) => group.leaves.length > 0);
  return (
    <>
      <tr className="border-t border-[var(--tk-line)] bg-stone-50 font-medium" data-testid={`gpr-work-${node.id}`}>
        <td className="px-3 py-2">
          <button type="button" className="rounded-sm text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tk-copper)]" aria-expanded={!collapsed} onClick={onToggle}>
            {hasNestedRows ? (collapsed ? "▸" : "▾") : "·"} {index + 1}. {node.name}
          </button>
          {node.incomplete ? <span className="ml-2 text-xs font-normal text-amber-800">частично</span> : null}
        </td>
        <td className="px-3 py-2 text-[var(--tk-muted)]">—</td>
        <td className="px-3 py-2 text-right">{stage?.planVolume == null ? "—" : formatNumber(stage.planVolume)}</td>
        <td className="px-3 py-2 text-right text-[var(--tk-muted)]">—</td>
        <td className="px-3 py-2 text-right">{node.subtotal == null ? "неполно" : formatMoney(node.subtotal)}</td>
        <td className="px-3 py-2 text-xs text-[var(--tk-muted)]">{stage ? `${stage.start} — ${stage.end}` : "не распределено"}</td>
      </tr>
      {!collapsed ? node.groups.map((group) => (
        <Fragment key={`${node.id}-${group.kind}`}>
          <tr className="bg-stone-50/60 text-xs font-medium text-[var(--tk-muted)]" data-testid={`gpr-resource-group-${node.id}-${group.kind}`}>
            <td className="py-1 pl-8 pr-3">↳ {group.label}{group.incomplete ? " · частично" : ""}</td>
            <td colSpan={3} className="px-3 py-1">{group.leaves.length} поз.</td>
            <td className="px-3 py-1 text-right">{group.subtotal == null ? "неполно" : formatMoney(group.subtotal)}</td>
            <td />
          </tr>
          {group.leaves.map((leaf) => (
            <tr key={`${leaf.source}-${leaf.id}`} className="border-t border-[var(--tk-line)]/50 hover:bg-amber-50/40" data-testid={`gpr-resource-row-${leaf.id}`}>
              <td className="py-1.5 pl-12 pr-3">{leaf.name}</td>
              <td className="px-3 py-1.5">{leaf.unit || "—"}</td>
              <td className="px-3 py-1.5">
                <Input className="ml-auto h-8 w-28 text-right" type="number" min={0} step="any" aria-label={`Количество · ${leaf.name}`} data-testid={`res-qty-${leaf.id}`} value={String(leaf.quantity)} onChange={(event) => onPatch(leaf, { quantity: Number(event.target.value) || 0 })} />
              </td>
              <td className="px-3 py-1.5">
                <Input className="ml-auto h-8 w-32 text-right" type="number" min={0} step="any" aria-label={`Ставка · ${leaf.name}`} data-testid={`res-rate-${leaf.id}`} placeholder="—" title="нет данных" value={leaf.rate == null ? "" : String(leaf.rate)} onChange={(event) => {
                  const raw = event.target.value.trim();
                  const rate = raw === "" ? null : Number(raw);
                  onPatch(leaf, { rate: rate == null || !Number.isFinite(rate) ? null : rate });
                }} />
              </td>
              <td className={`px-3 py-1.5 text-right ${leaf.amount == null ? "text-amber-800" : ""}`} title={leaf.amount == null ? "нет данных" : undefined}>{leaf.amount == null ? "—" : formatMoney(leaf.amount)}</td>
              <td className="px-3 py-1.5 text-xs text-[var(--tk-muted)]">{stage ? `${stage.start} — ${stage.end}` : "—"}</td>
            </tr>
          ))}
        </Fragment>
      )) : null}
    </>
  );
}

