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
import type { GprStageResource, ResourceQuantityBasis } from "@/lib/types";
import { SpreadsheetEstimateGrid } from "@/components/spreadsheet-estimate-grid";

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
  onPatchLeaf: (leaf: EstimateLeaf, patch: {
    name?: string;
    unit?: string;
    quantity?: number;
    rate?: number | null;
    hoursPerShift?: number | null;
    shiftsPerDay?: number | null;
    days?: number | null;
    kind?: GprStageResource["kind"];
    quantityBasis?: ResourceQuantityBasis | null;
  }) => Promise<void> | void;
  onAddManualResources?: (stageId: string, resources: Array<Omit<GprStageResource, "id">>) => Promise<void>;
  onOpenSchedule?: () => void;
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
  onAddManualResources,
  onOpenSchedule,
  onExport,
  onAddClick,
}: Props) {
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"sheet" | "tree">("tree");
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
  const incompleteLabel = incomplete ? "Расчёт неполный" : null;

  const firstNodeId = (nodes.find((n) => n.id !== "_unbound") ?? nodes[0])?.id;

  const totalZ =
    slices?.total ??
    (costSummary?.priceExVat != null ? costSummary.priceExVat : null);
  const laborShown = slices?.labor ?? cards.labor;
  const equipmentShown = slices?.equipment ?? cards.equipment;
  const materialsShown =
    slices != null ? slices.materials : cards.materials;
  const reserveShown = costSummary?.reserve ?? 0;
  const byWorkTypes =
    laborShown != null || materialsShown != null
      ? (laborShown ?? 0) + (materialsShown ?? 0)
      : null;

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
        <div className="flex flex-wrap items-center gap-2">
          <div className="mr-2 flex rounded-lg border border-[var(--tk-line)] p-1" aria-label="Вид ресурсного черновика">
            <Button size="sm" variant={view === "sheet" ? "default" : "ghost"} aria-pressed={view === "sheet"} onClick={() => setView("sheet")}>Таблица</Button>
            <Button size="sm" variant={view === "tree" ? "default" : "ghost"} aria-pressed={view === "tree"} onClick={() => setView("tree")}>По этапам</Button>
          </div>
          {onExport ? (
            <Button variant="outline" data-testid="estimate-export" onClick={onExport}>
              Экспорт
            </Button>
          ) : null}
          {view === "tree" && onAddClick && !locked ? (
            <Button data-testid="estimate-add" onClick={onAddClick}>
              + Добавить позицию
            </Button>
          ) : null}
        </div>
      </div>

      {/* Main cards — plain Russian, mock layout: Итого / По видам / Техника / Резерв */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div
          className="rounded-2xl border border-[var(--tk-line)] bg-white/90 p-4"
          data-testid="budget-card-total-z"
        >
          <p className="text-xs text-[var(--tk-muted)]">Итого</p>
          <p className="mt-1 font-[family-name:var(--font-display)] text-2xl">
            {totalZ != null ? formatMoney(totalZ) : "нет данных"}
          </p>
          {incompleteLabel ? (
            <p className="mt-1 text-xs text-amber-800" data-testid="budget-incomplete">
              {incompleteLabel}
            </p>
          ) : (
            <p className="mt-1 text-[11px] text-[var(--tk-muted)]">
              Прямые + накладные + прибыль
            </p>
          )}
        </div>
        <div
          className="rounded-2xl border border-[var(--tk-line)] bg-white/90 p-4"
          data-testid="budget-card-labor"
        >
          <p className="text-xs text-[var(--tk-muted)]">По видам работ</p>
          <p className="mt-1 font-[family-name:var(--font-display)] text-2xl">
            {byWorkTypes != null ? formatMoney(byWorkTypes) : "нет данных"}
          </p>
          <p className="mt-1 text-[11px] text-[var(--tk-muted)]">
            Люди
            {laborShown != null ? ` ${formatMoney(laborShown)}` : ""}
            {materialsShown != null && materialsShown > 0
              ? ` · материалы ${formatMoney(materialsShown)}`
              : materialsShown === 0
                ? " · материалы нет данных"
                : ""}
          </p>
        </div>
        <div
          className="rounded-2xl border border-[var(--tk-line)] bg-white/90 p-4"
          data-testid="budget-card-equipment"
        >
          <p className="text-xs text-[var(--tk-muted)]">Техника</p>
          <p className="mt-1 font-[family-name:var(--font-display)] text-2xl">
            {equipmentShown != null ? formatMoney(equipmentShown) : "нет данных"}
          </p>
          {cards.other != null && cards.other > 0 ? (
            <p className="mt-1 text-[11px] text-[var(--tk-muted)]" data-testid="budget-card-other">
              Прочие: {formatMoney(cards.other)}
            </p>
          ) : null}
        </div>
        <div
          className="rounded-2xl border border-[var(--tk-line)] bg-white/90 p-4"
          data-testid="budget-card-reserve"
        >
          <p className="text-xs text-[var(--tk-muted)]">Резерв</p>
          <p className="mt-1 font-[family-name:var(--font-display)] text-2xl">
            {formatMoney(reserveShown)}
          </p>
          <p className="mt-1 text-[11px] text-[var(--tk-muted)]">
            Непредвиденные расходы
          </p>
        </div>
      </div>

      {/* Totals strip — Russian labels; testids kept for accept */}
      <div
        className="mb-4 grid gap-2 rounded-xl border border-[var(--tk-line)] bg-stone-50/80 p-3 text-sm sm:grid-cols-3 lg:grid-cols-6"
        data-testid="budget-totals-ru"
      >
        <div data-testid="budget-card-direct-v">
          <span className="text-xs text-[var(--tk-muted)]">Прямые затраты</span>
          <p className="text-xl font-semibold">
            {slices
              ? formatMoney(slices.direct)
              : cards.directKnown != null
                ? formatMoney(cards.directKnown)
                : "нет данных"}
          </p>
        </div>
        <div data-testid="budget-card-oh-w">
          <span className="text-xs text-[var(--tk-muted)]">Накладные</span>
          <p className="text-xl font-semibold">
            {slices ? formatMoney(slices.overhead) : "нет данных"}
          </p>
        </div>
        <div data-testid="budget-card-x">
          <span className="text-xs text-[var(--tk-muted)]">Себестоимость</span>
          <p className="text-xl font-semibold">
            {slices ? formatMoney(slices.costWithOh) : "нет данных"}
          </p>
        </div>
        <div data-testid="budget-card-materials">
          <span className="text-xs text-[var(--tk-muted)]">Материалы</span>
          <p className="text-xl font-semibold">
            {materialsShown != null && materialsShown > 0
              ? formatMoney(materialsShown)
              : "нет данных"}
          </p>
        </div>
        <div data-testid="budget-card-y">
          <span className="text-xs text-[var(--tk-muted)]">Прибыль</span>
          <p className="text-xl font-semibold">
            {slices ? formatMoney(slices.profit) : "нет данных"}
          </p>
        </div>
        <div>
          <span className="text-xs text-[var(--tk-muted)]">Резерв</span>
          <p className="text-xl font-semibold">{formatMoney(reserveShown)}</p>
        </div>
      </div>

      {originalTotal != null ? (
        <div
          className="mb-4 rounded-xl border border-[var(--tk-line)] bg-white/80 px-3 py-2 text-sm"
          data-testid="budget-card-original"
        >
          <span className="text-[var(--tk-muted)]">
            {originalLabel ?? "Исходная смета заказчика"}:{" "}
          </span>
          <span className="font-medium">{formatMoney(originalTotal)}</span>
          <span className="ml-2 text-xs text-[var(--tk-muted)]">
            не изменяется ресурсным расчётом
          </span>
        </div>
      ) : null}

      {officeOverhead > 0 ? (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-sm">
          Офисные накладные: {formatMoney(officeOverhead)}
          {costSummary ? (
            <span className="ml-3 font-semibold">
              Итог проекта с дополнительными расходами:{" "}
              {formatMoney(costSummary.priceExVat)}
            </span>
          ) : null}
        </div>
      ) : null}

      <details className="mb-4 rounded-xl border border-[var(--tk-line)] bg-white/80 p-4">
        <summary
          className="cursor-pointer text-sm font-medium"
          data-testid="estimate-calc-details"
        >
          Подробности расчёта
        </summary>
        <p className="mt-2 max-w-3xl text-xs leading-relaxed text-[var(--tk-muted)]">
          Формулы ресурсного шаблона: прямые = материалы + люди + техника;
          накладные = 43% от прямых; себестоимость = прямые + накладные;
          прибыль = 40% от себестоимости; итого = себестоимость + прибыль.
          Часы = количество × часы в смене × смены в день × дни; сумма = часы × ставка.
        </p>
        <div
          className="mt-3 grid gap-2 text-xs sm:grid-cols-4"
          data-testid="budget-slices-qr"
        >
          <div>
            Часы (изв.): {slices ? formatNumber(slices.hours) : "—"}
          </div>
          <div>
            Известная сумма:{" "}
            {slices ? formatMoney(slices.knownAmount) : "—"}
          </div>
          <div>
            Себестоимость с накладными:{" "}
            {slices ? formatMoney(slices.costWithOh) : "нет данных"}
          </div>
          <div>
            {incompleteLabel ? (
              <span className="text-amber-800">{incompleteLabel}</span>
            ) : (
              <span className="text-emerald-800">Расчёт полный</span>
            )}
          </div>
        </div>
        {!locked && onSaveResourceScheduleParams ? (
          <div className="mt-4 border-t border-[var(--tk-line)] pt-3">
            <p className="mb-2 text-xs text-[var(--tk-muted)]">
              Параметры шаблона для этого проекта
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
          </div>
        ) : null}
      </details>

      {view === "sheet" ? (
        <SpreadsheetEstimateGrid
          stages={stages}
          nodes={nodes}
          params={resourceScheduleParams ?? EXCEL_RESOURCE_SCHEDULE_DEFAULTS}
          locked={locked}
          onPatchLeaf={onPatchLeaf}
          onAddResources={onAddManualResources}
          onAddFromDirectory={onAddClick}
          onOpenSchedule={onOpenSchedule}
        />
      ) : (
      <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-sm font-medium">Смета и ресурсы</h3>
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
        <div className="min-w-[720px]">
        <div className="grid grid-cols-[minmax(12rem,1fr)_5.5rem_5.5rem_5.5rem_7rem] gap-2 border-b border-[var(--tk-line)] bg-stone-50 px-3 py-2 text-xs font-medium text-[var(--tk-muted)]">
          <div>Статья / ресурс</div>
          <div className="text-right">Кол-во</div>
          <div className="text-right">Часы</div>
          <div className="text-right">Ставка</div>
          <div className="sticky right-0 bg-stone-50 text-right shadow-[-6px_0_8px_-6px_rgba(0,0,0,0.12)]">
            Сумма
          </div>
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
                className="grid w-full grid-cols-[minmax(12rem,1fr)_5.5rem_5.5rem_5.5rem_7rem] gap-2 px-3 py-2.5 text-left text-sm hover:bg-stone-50"
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
                <div className="sticky right-0 bg-inherit text-right font-medium shadow-[-6px_0_8px_-6px_rgba(0,0,0,0.08)]">
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
                          className="grid grid-cols-[minmax(12rem,1fr)_5.5rem_5.5rem_5.5rem_7rem] items-center gap-2 px-3 py-1.5 pl-10 text-sm"
                          data-testid={`estimate-leaf-${leaf.id}`}
                        >
                          <div className="min-w-0 truncate">
                            {leaf.name}
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
                            className="sticky right-0 bg-inherit text-right shadow-[-6px_0_8px_-6px_rgba(0,0,0,0.08)]"
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
      </>
      )}
    </div>
  );
}
