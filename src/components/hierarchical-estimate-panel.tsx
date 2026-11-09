"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMoney, formatNumber } from "@/lib/format";
import {
  buildHierarchicalEstimate,
  estimateBudgetCards,
  type EstimateLeaf,
} from "@/lib/hierarchical-estimate";
import {
  EXCEL_RESOURCE_SCHEDULE_DEFAULTS,
  type ResourceScheduleParams,
} from "@/lib/resource-schedule-model";
import type { CalcPosition, CostSummarySnapshot, GprStage } from "@/lib/types";

type Props = {
  stages: GprStage[];
  positions: CalcPosition[];
  locked?: boolean;
  /** Live calc.resourceScheduleParams — must match sync/export (no silent defaults). */
  resourceScheduleParams?: ResourceScheduleParams;
  /** Immutable customer original total (позиции × коэф. + НР15/СП8) — separate model. */
  originalTotal?: number | null;
  originalLabel?: string;
  costSummary?: CostSummarySnapshot | null;
  costIncomplete?: boolean;
  officeOverhead?: number;
  onSaveResourceScheduleParams?: (input: {
    params: ResourceScheduleParams;
    officeOverhead: number;
    reserve: number;
  }) => Promise<void>;
  onPatchLeaf: (leaf: EstimateLeaf, patch: { quantity?: number; rate?: number | null }) => void;
  onExport?: () => void;
  onAddClick?: () => void;
};

export function HierarchicalEstimatePanel({
  stages,
  positions,
  locked,
  resourceScheduleParams,
  originalTotal,
  originalLabel,
  costSummary,
  costIncomplete,
  officeOverhead = 0,
  onSaveResourceScheduleParams,
  onPatchLeaf,
  onExport,
  onAddClick,
}: Props) {
  const [search, setSearch] = useState("");
  // PDF cue: stages collapsed by default; one stage expanded for overview+detail
  const [expandAll, setExpandAll] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [paramsDraft, setParamsDraft] = useState<ResourceScheduleParams>(
    resourceScheduleParams ?? EXCEL_RESOURCE_SCHEDULE_DEFAULTS
  );
  const [savingParams, setSavingParams] = useState(false);
  const [officeDraft, setOfficeDraft] = useState(officeOverhead);
  const [reserveDraft, setReserveDraft] = useState(costSummary?.reserve ?? 0);

  const nodes = useMemo(
    () =>
      buildHierarchicalEstimate({
        stages,
        positions,
        search,
        params: resourceScheduleParams,
      }),
    [stages, positions, search, resourceScheduleParams]
  );
  const cards = useMemo(() => estimateBudgetCards(nodes), [nodes]);
  const slices = costSummary?.resourceSlices;
  const incomplete =
    costIncomplete ||
    cards.incomplete ||
    Boolean(costSummary?.totalsIncomplete) ||
    (costSummary?.incomplete?.length ?? 0) > 0;

  const firstNodeId = (nodes.find((n) => n.id !== "_unbound") ?? nodes[0])?.id;

  function isOpen(id: string) {
    if (open[id] != null) return open[id];
    return expandAll || id === firstNodeId;
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
          data-testid="budget-card-original"
        >
          <p className="text-xs text-[var(--tk-muted)]">
            {originalLabel ?? "Оригинал сметы (immutable)"}
          </p>
          <p className="mt-1 font-[family-name:var(--font-display)] text-2xl">
            {originalTotal != null ? formatMoney(originalTotal) : "нет данных"}
          </p>
          <p className="mt-1 text-[11px] text-[var(--tk-muted)]">
            позиции × коэф. + НР15/СП8 — не ресурсный Z
          </p>
        </div>
        <div
          className="rounded-2xl border border-[var(--tk-line)] bg-white/90 p-4"
          data-testid="budget-card-direct-v"
        >
          <p className="text-xs text-[var(--tk-muted)]">
            V · прямые (S+T+U)
            {incomplete ? " · PARTIAL" : ""}
          </p>
          <p className="mt-1 font-[family-name:var(--font-display)] text-2xl">
            {slices
              ? formatMoney(slices.direct)
              : cards.directKnown != null
                ? formatMoney(cards.directKnown)
                : "нет данных"}
          </p>
          {incomplete ? (
            <p className="mt-1 text-xs text-amber-800" data-testid="budget-incomplete">
              V неполный — W/X/Y/Z тоже partial
            </p>
          ) : null}
        </div>
        <div
          className="rounded-2xl border border-[var(--tk-line)] bg-white/90 p-4"
          data-testid="budget-card-oh-w"
        >
          <p className="text-xs text-[var(--tk-muted)]">
            W · НР 43% от прямых
            {incomplete ? " · PARTIAL" : ""}
          </p>
          <p className="mt-1 text-xl font-semibold">
            {slices ? formatMoney(slices.overhead) : "нет данных"}
          </p>
          <p
            className="mt-1 text-[11px] text-[var(--tk-muted)]"
            data-testid="budget-card-x"
          >
            X с/с с НР
            {incomplete ? " · PARTIAL" : ""}:{" "}
            {slices ? formatMoney(slices.costWithOh) : "—"}
          </p>
        </div>
        <div
          className="rounded-2xl border border-[var(--tk-line)] bg-white/90 p-4"
          data-testid="budget-card-total-z"
        >
          <p className="text-xs text-[var(--tk-muted)]">
            Z · итого (X + наценка 40%)
            {incomplete ? " · PARTIAL" : ""}
          </p>
          <p className="mt-1 font-[family-name:var(--font-display)] text-2xl">
            {slices
              ? formatMoney(slices.total)
              : costSummary?.priceExVat != null
                ? formatMoney(costSummary.priceExVat)
                : "нет данных"}
          </p>
          <p
            className="mt-1 text-[11px] text-[var(--tk-muted)]"
            data-testid="budget-card-y"
          >
            Y прибыль
            {incomplete ? " · PARTIAL" : ""}:{" "}
            {slices ? formatMoney(slices.profit) : "—"} · та же база сводка /
            cost-engine / экспорт сметы
          </p>
        </div>
      </div>

      {slices ? (
        <div
          className="mb-4 grid gap-2 rounded-xl border border-[var(--tk-line)] bg-stone-50/80 p-3 text-xs sm:grid-cols-4"
          data-testid="budget-slices-qr"
        >
          <div>
            Q часы (изв.): {formatNumber(slices.hours)}
          </div>
          <div>
            R известное: {formatMoney(slices.knownAmount)}
          </div>
          <div data-testid="budget-card-labor">
            T люди: {formatMoney(slices.labor)}
          </div>
          <div data-testid="budget-card-equipment">
            U техника: {formatMoney(slices.equipment)}
            {slices.materials > 0 ? (
              <span className="ml-2 text-[var(--tk-muted)]">
                S мат.: {formatMoney(slices.materials)}
              </span>
            ) : (
              <span className="ml-2 text-amber-800">S мат.: нет данных</span>
            )}
            {cards.other != null && cards.other > 0 ? (
              <span className="ml-2" data-testid="budget-card-other">
                Прочие: {formatMoney(cards.other)}
              </span>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
          </div>
          <div
            className="rounded-2xl border border-[var(--tk-line)] bg-white/90 p-4"
            data-testid="budget-card-materials"
          >
            <p className="text-xs text-[var(--tk-muted)]">Дерево · материалы</p>
            <p className="mt-1 text-xl font-semibold">
              {cards.materials == null ? "нет данных" : formatMoney(cards.materials)}
            </p>
          </div>
          {cards.other != null && cards.other > 0 ? (
            <div
              className="rounded-2xl border border-[var(--tk-line)] bg-white/90 p-4"
              data-testid="budget-card-other"
            >
              <p className="text-xs text-[var(--tk-muted)]">Дерево · прочие</p>
              <p className="mt-1 text-xl font-semibold">{formatMoney(cards.other)}</p>
            </div>
          ) : null}
        </div>
      )}

      {costSummary && (officeOverhead > 0 || costSummary.reserve > 0) ? (
        <div className="mb-4 grid gap-2 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-sm sm:grid-cols-3">
          <div>Офисные накладные: {formatMoney(officeOverhead)}</div>
          <div>Резерв непредвиденных: {formatMoney(costSummary.reserve)}</div>
          <div className="font-semibold">Итог проекта с дополнительными расходами: {formatMoney(costSummary.priceExVat)}</div>
          <p className="text-xs text-[var(--tk-muted)] sm:col-span-3">
            Excel Z показывает ресурсную модель. Офисные расходы и резерв вынесены отдельно, чтобы не менять формулы исходного шаблона.
          </p>
        </div>
      ) : null}

      {!locked && onSaveResourceScheduleParams ? (
        <details className="mb-4 rounded-xl border border-[var(--tk-line)] bg-white/80 p-4">
          <summary className="cursor-pointer text-sm font-medium">
            Параметры ресурсного шаблона · менять для этого проекта
          </summary>
          <p className="mt-2 max-w-3xl text-xs leading-relaxed text-[var(--tk-muted)]">
            Начальные значения взяты из загруженного примера Excel. Уточните их перед расчётом;
            после сохранения ресурсные суммы, сводка и экспорт пересчитываются по тем же формулам.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {([
              ["Чел.-час, ₽", "personHourRate", 0.01],
              ["Смен людей в день", "personnelShiftsPerDay", 1],
              ["Часов в смене", "hoursPerShift", 0.5],
              ["Смен техники в день", "equipmentShiftsPerDay", 1],
              ["Накладные, % от прямых", "overheadRate", 0.01],
              ["Наценка, % на с/с с НР", "profitMarkupOnCostWithOh", 0.01],
            ] as const).map(([label, key, step]) => (
              <label key={key} className="text-xs text-[var(--tk-muted)]">
                {label}
                <Input
                  className="mt-1 h-9 text-sm text-[var(--tk-ink)]"
                  type="number"
                  min={0}
                  step={step}
                  value={key === "overheadRate" || key === "profitMarkupOnCostWithOh"
                    ? String(Math.round(paramsDraft[key] * 10000) / 100)
                    : String(paramsDraft[key])}
                  onChange={(event) => {
                    const raw = Number(event.target.value);
                    const value = Number.isFinite(raw) ? Math.max(0, raw) : 0;
                    setParamsDraft((current) => ({
                      ...current,
                      [key]: key === "overheadRate" || key === "profitMarkupOnCostWithOh"
                        ? value / 100
                        : value,
                    }));
                  }}
                />
              </label>
            ))}
            {([
              ["Офисные накладные, ₽", officeDraft, setOfficeDraft],
              ["Непредвиденные расходы, ₽", reserveDraft, setReserveDraft],
            ] as const).map(([label, value, setValue]) => (
              <label key={label} className="text-xs text-[var(--tk-muted)]">
                {label}
                <Input
                  className="mt-1 h-9 text-sm text-[var(--tk-ink)]"
                  type="number"
                  min={0}
                  step="1000"
                  value={String(value)}
                  onChange={(event) => setValue(Math.max(0, Number(event.target.value) || 0))}
                />
              </label>
            ))}
          </div>
          <Button
            className="mt-3"
            disabled={savingParams}
            onClick={async () => {
              setSavingParams(true);
              try {
                await onSaveResourceScheduleParams({
                  params: paramsDraft,
                  officeOverhead: officeDraft,
                  reserve: reserveDraft,
                });
                toast.success("Параметры сохранены, расчёт обновлён");
              } catch (error) {
                toast.error(error instanceof Error ? error.message : "Не удалось пересчитать");
              } finally {
                setSavingParams(false);
              }
            }}
          >
            {savingParams ? "Пересчёт…" : "Сохранить и пересчитать"}
          </Button>
        </details>
      ) : null}

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

      <div className="overflow-x-auto rounded-2xl border border-[var(--tk-line)] bg-white/90">
        <div className="min-w-[820px]">
        <div className="grid grid-cols-[1fr_5rem_4.5rem_4.5rem_7rem_8rem] gap-2 border-b border-[var(--tk-line)] bg-stone-50 px-3 py-2 text-xs font-medium text-[var(--tk-muted)]">
          <div>Этап / ресурс</div>
          <div className="text-right">L кол-во</div>
          <div className="text-right">Q часы</div>
          <div className="text-right">N·O·P</div>
          <div className="text-right">Ставка</div>
          <div className="text-right">R итого</div>
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
                className="grid w-full grid-cols-[1fr_5rem_4.5rem_4.5rem_7rem_8rem] gap-2 px-3 py-2.5 text-left text-sm hover:bg-stone-50"
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
                          className="grid grid-cols-[1fr_5rem_4.5rem_4.5rem_7rem_8rem] items-center gap-2 px-3 py-1.5 pl-10 text-sm"
                          data-testid={`estimate-leaf-${leaf.id}`}
                        >
                          <div className="min-w-0 truncate">
                            {leaf.name}
                            {leaf.basis === "count_per_shift" ? (
                              <span className="ml-1 text-[10px] text-[var(--tk-muted)]">
                                L→Q
                              </span>
                            ) : null}
                          </div>
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
                          <div
                            className="text-right text-xs"
                            data-testid={`estimate-q-${leaf.id}`}
                          >
                            {leaf.basis === "material_qty"
                              ? "—"
                              : leaf.hoursQ == null
                                ? "нет данных"
                                : formatNumber(leaf.hoursQ)}
                          </div>
                          <div className="text-right text-[10px] text-[var(--tk-muted)]">
                            {leaf.basis === "count_per_shift"
                              ? `${leaf.hoursPerShift ?? "?"}×${leaf.shiftsPerDay ?? "?"}×${leaf.days ?? "?"}`
                              : leaf.basis === "total_hours"
                                ? "уже часы"
                                : leaf.basis === "material_qty"
                                  ? "мат."
                                  : "?"}
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
                          <div
                            className="text-right"
                            data-testid={`estimate-amount-${leaf.id}`}
                          >
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
    </div>
  );
}
