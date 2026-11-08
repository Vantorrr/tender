"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMoney, formatNumber } from "@/lib/format";
import {
  buildHierarchicalEstimate,
  estimateBudgetCards,
  type EstimateLeaf,
} from "@/lib/hierarchical-estimate";
import type { CalcPosition, GprStage } from "@/lib/types";

type Props = {
  stages: GprStage[];
  positions: CalcPosition[];
  locked?: boolean;
  /** Full estimate (позиции × коэф. сценария) — separate basis from tree qty×rate. */
  estimateTotal?: number | null;
  costIncomplete?: boolean;
  onPatchLeaf: (leaf: EstimateLeaf, patch: { quantity?: number; rate?: number | null }) => void;
  onExport?: () => void;
  onAddClick?: () => void;
};

export function HierarchicalEstimatePanel({
  stages,
  positions,
  locked,
  estimateTotal,
  costIncomplete,
  onPatchLeaf,
  onExport,
  onAddClick,
}: Props) {
  const [search, setSearch] = useState("");
  // PDF cue: stages collapsed by default; one stage expanded for overview+detail
  const [expandAll, setExpandAll] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [seededOpen, setSeededOpen] = useState(false);

  const nodes = useMemo(
    () => buildHierarchicalEstimate({ stages, positions, search }),
    [stages, positions, search]
  );
  const cards = useMemo(() => estimateBudgetCards(nodes), [nodes]);

  useEffect(() => {
    if (seededOpen || nodes.length === 0) return;
    const first = nodes.find((n) => n.id !== "_unbound") ?? nodes[0];
    setSeededOpen(true);
    setOpen({ [first.id]: true });
  }, [nodes, seededOpen]);

  function isOpen(id: string) {
    if (open[id] != null) return open[id];
    return expandAll;
  }

  return (
    <div data-testid="hierarchical-estimate">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-[family-name:var(--font-display)] text-lg">
          Расчёт стоимости и оценка ресурсов
        </h2>
        <div className="flex flex-wrap gap-2">
          {onExport ? (
            <Button variant="outline" data-testid="estimate-export" onClick={onExport}>
              Экспорт
            </Button>
          ) : null}
          {onAddClick && !locked ? (
            <Button data-testid="estimate-add" onClick={onAddClick}>
              + Добавить позицию
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div
          className="rounded-2xl border border-[var(--tk-line)] bg-white/90 p-4"
          data-testid="budget-card-estimate-total"
        >
          <p className="text-xs text-[var(--tk-muted)]">
            Итого сметы (позиции × коэф.)
          </p>
          <p className="mt-1 font-[family-name:var(--font-display)] text-2xl">
            {estimateTotal != null ? formatMoney(estimateTotal) : "нет данных"}
          </p>
          <p className="mt-1 text-[11px] text-[var(--tk-muted)]">
            та же база, что сводка / cost-engine / экспорт
          </p>
        </div>
        <div
          className="rounded-2xl border border-[var(--tk-line)] bg-white/90 p-4"
          data-testid="budget-card-total"
        >
          <p className="text-xs text-[var(--tk-muted)]">
            Дерево ресурсов (qty×rate, известное)
          </p>
          <p className="mt-1 font-[family-name:var(--font-display)] text-2xl">
            {cards.totalKnown != null
              ? formatMoney(cards.totalKnown)
              : "нет данных"}
          </p>
          {(costIncomplete || cards.incomplete) && (
            <p className="mt-1 text-xs text-amber-800">дерево неполно</p>
          )}
        </div>
        <div
          className="rounded-2xl border border-[var(--tk-line)] bg-white/90 p-4"
          data-testid="budget-card-labor"
        >
          <p className="text-xs text-[var(--tk-muted)]">Дерево · люди</p>
          <p className="mt-1 text-xl font-semibold">
            {cards.labor == null ? "нет данных" : formatMoney(cards.labor)}
          </p>
        </div>
        <div
          className="rounded-2xl border border-[var(--tk-line)] bg-white/90 p-4"
          data-testid="budget-card-equipment"
        >
          <p className="text-xs text-[var(--tk-muted)]">Дерево · техника</p>
          <p className="mt-1 text-xl font-semibold">
            {cards.equipment == null ? "нет данных" : formatMoney(cards.equipment)}
          </p>
          {cards.materials != null ? (
            <p className="mt-1 text-xs text-[var(--tk-muted)]">
              Материалы: {formatMoney(cards.materials)}
            </p>
          ) : (
            <p className="mt-1 text-xs text-amber-800">Материалы: нет данных</p>
          )}
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          className="max-w-sm"
          placeholder="Поиск по этапам и ресурсам…"
          value={search}
          data-testid="estimate-search"
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button
          variant="outline"
          size="sm"
          data-testid="estimate-expand-all"
          onClick={() => {
            setExpandAll((v) => !v);
            setOpen({});
          }}
        >
          {expandAll ? "Свернуть всё" : "Развернуть всё"}
        </Button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-[var(--tk-line)] bg-white/90">
        <div className="grid grid-cols-[1fr_6rem_7rem_8rem] gap-2 border-b border-[var(--tk-line)] bg-stone-50 px-3 py-2 text-xs font-medium text-[var(--tk-muted)]">
          <div>Этап / ресурс</div>
          <div className="text-right">Кол-во</div>
          <div className="text-right">Ставка</div>
          <div className="text-right">Итого</div>
        </div>
        {nodes.length === 0 ? (
          <p className="p-4 text-sm text-[var(--tk-muted)]">
            Нет этапов/ресурсов для отображения. Добавьте ресурсы в ГПР или позиции в расчёт.
          </p>
        ) : (
          nodes.map((node) => (
            <div key={node.id} className="border-b border-[var(--tk-line)]/70">
              <button
                type="button"
                className="grid w-full grid-cols-[1fr_6rem_7rem_8rem] gap-2 px-3 py-2.5 text-left text-sm hover:bg-stone-50"
                data-testid={`estimate-stage-${node.id}`}
                onClick={() =>
                  setOpen((o) => ({ ...o, [node.id]: !isOpen(node.id) }))
                }
              >
                <div className="font-medium">
                  <span className="mr-2 text-[var(--tk-muted)]">
                    {isOpen(node.id) ? "▾" : "▸"}
                  </span>
                  {node.name}
                  {node.incomplete ? (
                    <span className="ml-2 text-xs font-normal text-amber-800">
                      неполно
                    </span>
                  ) : null}
                </div>
                <div />
                <div />
                <div className="text-right font-medium">
                  {node.subtotal == null ? "—" : formatMoney(node.subtotal)}
                </div>
              </button>
              {isOpen(node.id)
                ? node.groups.map((g) => (
                    <div key={`${node.id}-${g.kind}`} className="bg-stone-50/40">
                      <div className="px-3 py-1.5 pl-8 text-xs font-semibold uppercase tracking-wide text-[var(--tk-muted)]">
                        {g.label}
                      </div>
                      {g.leaves.map((leaf) => (
                        <div
                          key={leaf.id}
                          className="grid grid-cols-[1fr_6rem_7rem_8rem] items-center gap-2 px-3 py-1.5 pl-10 text-sm"
                          data-testid={`estimate-leaf-${leaf.id}`}
                        >
                          <div className="min-w-0 truncate">{leaf.name}</div>
                          <div className="text-right">
                            {locked ? (
                              formatNumber(leaf.quantity)
                            ) : (
                              <Input
                                className="h-8 text-right"
                                type="number"
                                min={0}
                                step="any"
                                value={leaf.quantity}
                                data-testid={`estimate-qty-${leaf.id}`}
                                onChange={(e) => {
                                  const quantity = Number(e.target.value) || 0;
                                  onPatchLeaf(leaf, { quantity });
                                  toast.success("Количество обновлено");
                                }}
                              />
                            )}
                          </div>
                          <div className="text-right">
                            {locked ? (
                              leaf.rate == null ? (
                                <span className="text-amber-800">нет данных</span>
                              ) : (
                                formatNumber(leaf.rate)
                              )
                            ) : (
                              <Input
                                className="h-8 text-right"
                                type="number"
                                min={0}
                                step="any"
                                placeholder="нет данных"
                                value={leaf.rate == null ? "" : String(leaf.rate)}
                                data-testid={`estimate-rate-${leaf.id}`}
                                onChange={(e) => {
                                  const raw = e.target.value.trim();
                                  const rate =
                                    raw === "" ? null : Number(raw);
                                  onPatchLeaf(leaf, {
                                    rate:
                                      rate == null || Number.isNaN(rate)
                                        ? null
                                        : rate,
                                  });
                                }}
                              />
                            )}
                          </div>
                          <div className="text-right">
                            {leaf.amount == null
                              ? "нет данных"
                              : formatMoney(leaf.amount)}
                          </div>
                        </div>
                      ))}
                    </div>
                  ))
                : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
