"use client";

import Link from "next/link";
import { useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { DateInputRu } from "@/components/date-input-ru";
import { Button } from "@/components/ui/button";
import { diffDays } from "@/lib/cost-engine";
import { formatDate, formatDateRangeShort, formatMoney, formatNumber } from "@/lib/format";
import { entryDisplayFact } from "@/lib/plan-fact-agg";
import { gprCoveredDays } from "@/lib/plan-from-gpr";
import type { DailyFact, GprStage, PlanFactEntry } from "@/lib/types";

const GANTT_FILTER_EVENT = "tma361:gantt-filter-change";
const ganttFilterFallback = new Map<string, string>();
const DAY_MS = 86_400_000;
const LABEL_WIDTH = 360;

function stageResourceSummary(stage: GprStage) {
  const resources = stage.resources ?? [];
  const labor = resources
    .filter((r) => r.kind === "labor")
    .reduce((sum, r) => sum + (Number(r.quantity) || 0), 0);
  const equipment = resources
    .filter((r) => r.kind === "equipment" || r.kind === "bus")
    .reduce((sum, r) => sum + (Number(r.quantity) || 0), 0);
  let cost: number | null = 0;
  let incomplete = false;
  for (const r of resources) {
    if (r.rate == null || !Number.isFinite(r.rate)) {
      incomplete = true;
      continue;
    }
    cost += (Number(r.quantity) || 0) * r.rate;
  }
  if (resources.length === 0) {
    cost = null;
  } else if (incomplete && cost === 0) {
    cost = null;
  }
  return { labor, equipment, cost, incomplete };
}

type Scale = "day" | "week" | "month";
type DragMode = "move" | "resize";
type DragState = {
  pointerId: number;
  stageId: string;
  mode: DragMode;
  startX: number;
  duration: number;
  delta: number;
};

function subscribeGanttFilter(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(GANTT_FILTER_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(GANTT_FILTER_EVENT, onChange);
  };
}

function readGanttFilter(key: string, validKinds: string[]) {
  try {
    const saved = window.localStorage.getItem(key) ?? ganttFilterFallback.get(key) ?? "all";
    return saved === "all" || validKinds.includes(saved) ? saved : "all";
  } catch {
    const saved = ganttFilterFallback.get(key) ?? "all";
    return saved === "all" || validKinds.includes(saved) ? saved : "all";
  }
}

function saveGanttFilter(key: string, value: string) {
  ganttFilterFallback.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Keep the selection for this visit if browser storage is unavailable.
  }
  window.dispatchEvent(new Event(GANTT_FILTER_EVENT));
}

function daysBetween(a: string, b: string) {
  if (!a || !b) return 0;
  return Math.max(1, Math.abs(diffDays(a, b)) + 1);
}

function addDays(day: string, amount: number) {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() + amount * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function entryForStage(stage: GprStage, entries: PlanFactEntry[]) {
  const names = [
    ...(stage.workNames ?? []),
    ...(stage.workName ? [stage.workName] : []),
    stage.name,
  ].map((name) => name.trim()).filter(Boolean);
  for (const name of names) {
    const exact = entries.find((entry) => entry.workName.trim() === name);
    if (exact) return exact;
  }
  const matches = entries.filter((entry) =>
    names.some((name) => name.includes(entry.workName) || entry.workName.includes(name))
  );
  if (matches.length === 1) return matches[0];
  return undefined;
}

function tickLabel(day: string, scale: Scale) {
  const date = new Date(`${day}T12:00:00Z`);
  if (scale === "month") {
    return date.toLocaleDateString("ru-RU", { month: "short", year: "2-digit", timeZone: "UTC" });
  }
  if (scale === "week") {
    return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
  }
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
}

type Props = {
  stages: GprStage[];
  entries?: PlanFactEntry[];
  dailyFacts?: DailyFact[];
  planFactId?: string;
  filterScope?: string;
  weekendDays?: number[];
  onShift: (
    stageId: string,
    deltaDays: number,
    resizeDays?: number | null
  ) => void | Promise<void>;
};

export function PlanFactGantt({
  stages,
  entries = [],
  dailyFacts = [],
  planFactId,
  filterScope,
  weekendDays = [0, 6],
  onShift,
}: Props) {
  const [scale, setScale] = useState<Scale>("week");
  const [fitDayWidth, setFitDayWidth] = useState<number | null>(null);
  const [ephemeralFilter, setEphemeralFilter] = useState("all");
  const [savingStageId, setSavingStageId] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const filterStorageKey = `tma361:gantt-resource-filter:${filterScope ?? planFactId ?? "default"}`;

  const sorted = useMemo(
    () => stages.slice().sort((a, b) => a.sequence - b.sequence),
    [stages]
  );
  const stageById = useMemo(() => new Map(sorted.map((stage) => [stage.id, stage])), [sorted]);
  const resourceKinds = useMemo(() => {
    const set = new Set<string>();
    for (const stage of sorted) {
      for (const resource of stage.resources ?? []) set.add(resource.kind);
    }
    return [...set];
  }, [sorted]);
  const resourceFilter = useSyncExternalStore(
    subscribeGanttFilter,
    () => readGanttFilter(filterStorageKey, resourceKinds),
    () => ephemeralFilter
  );
  const visible = useMemo(() => {
    if (resourceFilter === "all") return sorted;
    return sorted.filter((stage) => (stage.resources ?? []).some((resource) => resource.kind === resourceFilter));
  }, [sorted, resourceFilter]);

  const minStart = sorted.reduce((min, stage) => (stage.start < min ? stage.start : min), sorted[0]?.start ?? "");
  const maxEnd = sorted.reduce((max, stage) => (stage.end > max ? stage.end : max), sorted[0]?.end ?? "");
  const totalDays = daysBetween(minStart, maxEnd);
  const dayWidth = fitDayWidth ?? (scale === "day" ? 34 : scale === "week" ? 18 : 7);
  const timelineWidth = Math.max(700, totalDays * dayWidth);
  const today = new Date().toISOString().slice(0, 10);
  const todayOffset = minStart ? diffDays(minStart, today) : -1;
  const showToday = todayOffset >= 0 && todayOffset < totalDays;
  const plannedCount = sorted.filter((stage) => stage.planVolume != null && stage.planVolume > 0).length;
  const totalWorkingDays = gprCoveredDays(sorted, { weekendDays }).length;
  const ticks = (() => {
    if (!minStart || !totalDays) return [];
    const result: Array<{ date: string; offset: number; label: string }> = [];
    if (scale === "day") {
      const stride = totalDays > 90 ? 7 : totalDays > 40 ? 2 : 1;
      for (let offset = 0; offset < totalDays; offset += stride) {
        const date = addDays(minStart, offset);
        result.push({ date, offset, label: tickLabel(date, scale) });
      }
    } else if (scale === "week") {
      for (let offset = 0; offset < totalDays; offset += 7) {
        const date = addDays(minStart, offset);
        result.push({ date, offset, label: tickLabel(date, scale) });
      }
    } else {
      const start = new Date(`${minStart}T12:00:00Z`);
      const end = new Date(`${maxEnd}T12:00:00Z`);
      result.push({ date: minStart, offset: 0, label: tickLabel(minStart, scale) });
      const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      while (cursor <= end) {
        const date = cursor.toISOString().slice(0, 10);
        result.push({ date, offset: diffDays(minStart, date), label: tickLabel(date, scale) });
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      }
    }
    return result;
  })();

  const weekends = (() => {
    if (!minStart || !totalDays) return [];
    const days: Array<{ offset: number; width: number }> = [];
    for (let offset = 0; offset < totalDays; offset += 1) {
      const weekday = new Date(`${addDays(minStart, offset)}T00:00:00Z`).getUTCDay();
      if (dayWidth >= 8 && weekendDays.includes(weekday)) days.push({ offset, width: dayWidth });
    }
    return days;
  })();

  async function commitShift(stageId: string, deltaDays: number, resizeDays?: number) {
    if (savingStageId || (deltaDays === 0 && resizeDays == null)) return;
    setSavingStageId(stageId);
    try {
      await onShift(stageId, deltaDays, resizeDays);
    } finally {
      setSavingStageId(null);
    }
  }

  function startDrag(
    event: ReactPointerEvent<HTMLElement>,
    stage: GprStage,
    mode: DragMode
  ) {
    if (event.button !== 0 || savingStageId) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.parentElement?.setPointerCapture(event.pointerId);
    const state: DragState = {
      pointerId: event.pointerId,
      stageId: stage.id,
      mode,
      startX: event.clientX,
      duration: daysBetween(stage.start, stage.end),
      delta: 0,
    };
    dragRef.current = state;
    setDragPreview(state);
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const delta = Math.round((event.clientX - current.startX) / dayWidth);
    const next = { ...current, delta };
    dragRef.current = next;
    setDragPreview(next);
  }

  function finishDrag(event: ReactPointerEvent<HTMLDivElement>, cancel = false) {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragPreview(null);
    if (cancel || current.delta === 0) return;
    if (current.mode === "move") {
      void commitShift(current.stageId, current.delta);
    } else {
      void commitShift(current.stageId, 0, Math.max(1, current.duration + current.delta));
    }
  }

  function setFilter(value: string) {
    setEphemeralFilter(value);
    saveGanttFilter(filterStorageKey, value);
  }

  function scrollToToday() {
    if (!scrollRef.current || todayOffset < 0) return;
    scrollRef.current.scrollTo({ left: Math.max(0, todayOffset * dayWidth - 160), behavior: "smooth" });
  }

  function fitSchedule() {
    setScale("month");
    if (scrollRef.current && totalDays > 0) {
      const availableWidth = Math.max(320, scrollRef.current.clientWidth - LABEL_WIDTH - 20);
      setFitDayWidth(availableWidth / totalDays);
      scrollRef.current.scrollTo({ left: 0, behavior: "smooth" });
    }
  }

  const kindLabels: Record<string, string> = {
    labor: "Люди",
    material: "Материалы",
    equipment: "Техника",
    bus: "Автобусы",
    other: "Прочее",
  };

  return (
    <div className="space-y-3" data-testid="plan-fact-gantt">
      <h3 className="font-[family-name:var(--font-display)] text-base" data-testid="gantt-title">
        График — план и факт
      </h3>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--tk-muted)]">
          <span className="rounded-md border border-[var(--tk-line)] bg-white px-2.5 py-1.5">
            <strong className="text-[var(--tk-ink)]">{sorted.length}</strong> этапов
          </span>
          {totalDays ? (
            <span className="rounded-md border border-[var(--tk-line)] bg-white px-2.5 py-1.5">
              <strong className="text-[var(--tk-ink)]">{totalDays}</strong> кал. дн. · работы по графику <strong className="text-[var(--tk-ink)]">{totalWorkingDays}</strong> раб. дн.
            </span>
          ) : null}
          <span className="rounded-md border border-[var(--tk-line)] bg-white px-2.5 py-1.5">
            План задан: <strong className="text-[var(--tk-ink)]">{plannedCount}/{sorted.length}</strong>
          </span>
          <span
            className="rounded-md border border-[var(--tk-line)] bg-white px-2.5 py-1.5"
            data-testid="gantt-daily-facts-count"
            data-daily-facts={dailyFacts.length}
          >
            Дневных фактов:{" "}
            <strong className="text-[var(--tk-ink)]">{dailyFacts.length}</strong>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-[var(--tk-muted)]">
            Ресурс
            <select
              className="h-8 rounded-lg border border-input bg-white px-2 text-sm text-[var(--tk-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="gantt-resource-filter"
              value={resourceFilter}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="all">Все ресурсы</option>
              {resourceKinds.map((kind) => (
                <option key={kind} value={kind}>{kindLabels[kind] ?? kind}</option>
              ))}
            </select>
          </label>
          <div className="inline-flex rounded-lg border border-[var(--tk-line)] bg-white p-0.5" role="group" aria-label="Масштаб календаря">
            {(["day", "week", "month"] as const).map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={scale === item}
                data-testid={`gantt-scale-${item}`}
                onClick={() => {
                  setFitDayWidth(null);
                  setScale(item);
                }}
                className={`shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${scale === item ? "bg-[var(--tk-brand)] text-white" : "text-[var(--tk-muted)] hover:bg-stone-100"}`}
              >
                {item === "day" ? "Дни" : item === "week" ? "Недели" : "Месяцы"}
              </button>
            ))}
          </div>
          <Button size="sm" variant="outline" className="h-8" onClick={scrollToToday} disabled={!minStart || todayOffset < 0}>
            Сегодня
          </Button>
          <Button size="sm" variant="outline" className="h-8" onClick={fitSchedule} disabled={!sorted.length}>
            Весь график
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--tk-line)] bg-stone-50 px-3 py-2 text-xs text-[var(--tk-muted)]">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1.5"><i className="h-3 w-5 rounded-full bg-stone-300" /> План</span>
          <span className="inline-flex items-center gap-1.5"><i className="h-3 w-5 rounded-full bg-[var(--tk-brand)]" /> Факт по объёму</span>
          <span className="inline-flex items-center gap-1.5"><i className="h-4 w-0.5 bg-rose-600" /> Сегодня</span>
          <span>Выходные подсвечены</span>
        </div>
        <span>Перетащите полосу — сдвинуть · потяните правый край — изменить длительность · зависимости и ресурсы обновятся автоматически</span>
      </div>

      <div
        ref={scrollRef}
        className="overflow-auto rounded-xl border border-[var(--tk-line)] bg-white shadow-sm"
        data-testid="gantt-scroll-container"
      >
        {!sorted.length ? (
          <div className="p-8 text-center text-sm text-[var(--tk-muted)]">Добавьте этапы, чтобы построить календарный график.</div>
        ) : (
          <div
            style={{ minWidth: LABEL_WIDTH + timelineWidth }}
            data-testid="gantt-rows"
            data-row-count={visible.length}
            data-resource-filter={resourceFilter}
          >
            <div className="sticky top-0 z-20 grid border-b border-[var(--tk-line)] bg-stone-50" style={{ gridTemplateColumns: `${LABEL_WIDTH}px ${timelineWidth}px` }}>
              <div className="sticky left-0 z-30 border-r border-[var(--tk-line)] bg-stone-50 px-3 py-3 text-[11px] font-semibold text-[var(--tk-muted)]">
                <div className="grid grid-cols-[1.4fr_0.55fr_0.55fr_0.7fr] gap-1">
                  <span>Работа</span>
                  <span className="text-right">Люди</span>
                  <span className="text-right">Техника</span>
                  <span className="text-right">Стоимость</span>
                </div>
              </div>
              <div className="relative h-11 overflow-hidden">
                {ticks.map((tick) => (
                  <div key={tick.date} className="absolute bottom-0 top-0 border-l border-[var(--tk-line)]/80 pl-1.5 pt-3 text-[11px] font-medium text-[var(--tk-muted)]" style={{ left: tick.offset * dayWidth }} title={formatDate(tick.date)}>
                    {tick.label}
                  </div>
                ))}
                {showToday ? <div className="absolute bottom-0 top-0 z-10 w-px bg-rose-500" style={{ left: todayOffset * dayWidth }} /> : null}
              </div>
            </div>

            {visible.map((stage, index) => {
              const baseOffset = Math.max(0, diffDays(minStart, stage.start));
              const duration = daysBetween(stage.start, stage.end);
              const preview = dragPreview?.stageId === stage.id ? dragPreview : null;
              const offset = baseOffset + (preview?.mode === "move" ? preview.delta : 0);
              const widthDays = preview?.mode === "resize" ? Math.max(1, duration + preview.delta) : duration;
              const left = offset * dayWidth;
              const width = Math.max(7, widthDays * dayWidth - 3);
              const entry = entryForStage(stage, entries);
              const factPct = entry && entry.plan > 0
                ? clamp01(entryDisplayFact(entry, dailyFacts) / entry.plan)
                : null;
              const predecessor = stage.dependsOn ? stageById.get(stage.dependsOn) : undefined;
              const isSaving = savingStageId === stage.id;
              const stageFact = entry ? entryDisplayFact(entry, dailyFacts) : null;
              const resSummary = stageResourceSummary(stage);
              const barTitle = `План ${formatDateRangeShort(stage.start, stage.end)}${factPct == null ? " · факт не привязан к этапу" : ` · факт ${Math.round(factPct * 100)}%`}`;
              return (
                <div
                  key={stage.id}
                  className={`grid border-b border-[var(--tk-line)] last:border-b-0 ${index % 2 ? "bg-stone-50/30" : "bg-white"}`}
                  style={{ gridTemplateColumns: `${LABEL_WIDTH}px ${timelineWidth}px` }}
                  onPointerMove={moveDrag}
                  onPointerUp={(event) => finishDrag(event)}
                  onPointerCancel={(event) => finishDrag(event, true)}
                  data-testid={`gantt-row-${stage.id}`}
                >
                  <div className="sticky left-0 z-10 border-r border-[var(--tk-line)] bg-inherit px-3 py-3">
                    <div className="grid grid-cols-[1.4fr_0.55fr_0.55fr_0.7fr] gap-1 text-xs">
                      <div className="min-w-0">
                        <div className="break-words text-sm font-semibold leading-snug text-[var(--tk-ink)]">
                          <span className="mr-1 text-[10px] text-[var(--tk-muted)]">{stage.sequence}.</span>
                          {stage.name}
                        </div>
                        <div className="mt-1 text-[11px] text-[var(--tk-muted)]">
                          {formatDate(stage.start)} – {formatDate(stage.end)}
                        </div>
                        {predecessor ? (
                          <div className="mt-1 truncate text-[11px] text-[var(--tk-muted)]" title={`Зависимость от ${predecessor.name}`}>
                            После: {predecessor.name}
                            {stage.lagDays ? ` · лаг ${stage.lagDays} дн.` : ""}
                          </div>
                        ) : null}
                      </div>
                      <div className="text-right tabular-nums">
                        {resSummary.labor ? formatNumber(resSummary.labor) : "—"}
                      </div>
                      <div className="text-right tabular-nums">
                        {resSummary.equipment ? formatNumber(resSummary.equipment) : "—"}
                      </div>
                      <div className="text-right tabular-nums">
                        {resSummary.cost == null
                          ? "нет данных"
                          : formatMoney(resSummary.cost)}
                        {resSummary.incomplete ? (
                          <span className="mt-0.5 block text-[10px] text-amber-800">неполно</span>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <label className="grid gap-1 text-[10px] font-medium text-[var(--tk-muted)]">
                        Начало
                        <DateInputRu
                          data-testid={`gantt-start-${stage.id}`}
                          className="h-8 text-xs"
                          value={stage.start}
                          disabled={isSaving}
                          onChange={(next) => {
                            if (next) void commitShift(stage.id, diffDays(stage.start, next));
                          }}
                        />
                      </label>
                      <label className="grid gap-1 text-[10px] font-medium text-[var(--tk-muted)]">
                        Окончание
                        <DateInputRu
                          data-testid={`gantt-end-${stage.id}`}
                          className="h-8 text-xs"
                          value={stage.end}
                          disabled={isSaving}
                          onChange={(next) => {
                            if (next && next >= stage.start) {
                              void commitShift(stage.id, 0, daysBetween(stage.start, next));
                            }
                          }}
                        />
                      </label>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-[11px]"
                        disabled={isSaving}
                        data-testid={`gantt-shift-left-${stage.id}`}
                        onClick={() => void commitShift(stage.id, -1)}
                      >
                        −1 дн.
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-[11px]"
                        disabled={isSaving}
                        data-testid={`gantt-shift-right-${stage.id}`}
                        onClick={() => void commitShift(stage.id, 1)}
                      >
                        +1 дн.
                      </Button>
                      <span className="text-[11px] font-medium text-[var(--tk-brand)]">
                        {factPct == null
                          ? "Факт не привязан"
                          : `Факт ${Math.round(factPct * 100)}%${stageFact != null ? ` · ${stageFact.toLocaleString("ru-RU")}` : ""}`}
                      </span>
                    </div>
                    {planFactId && entry ? (
                      <Link
                        href={`/cabinet/proizvodstvo/day?planFactId=${encodeURIComponent(planFactId)}&date=${encodeURIComponent(stage.start)}&work=${encodeURIComponent(entry.workName)}`}
                        className="mt-1 inline-flex text-xs text-sky-800 underline decoration-sky-300 underline-offset-2 hover:text-sky-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid={`gantt-day-link-${stage.id}`}
                      >
                        Детали дня и фото →
                      </Link>
                    ) : null}
                  </div>

                  <div
                    className="relative min-h-[108px] touch-pan-x"
                    style={{
                      width: timelineWidth,
                      backgroundImage: dayWidth < 8 ? "none" : `repeating-linear-gradient(to right, transparent 0, transparent ${dayWidth - 1}px, color-mix(in srgb, var(--tk-line) 65%, transparent) ${dayWidth - 1}px, color-mix(in srgb, var(--tk-line) 65%, transparent) ${dayWidth}px)`,
                    }}
                  >
                    {weekends.map((weekend) => (
                      <div key={weekend.offset} aria-hidden="true" className="pointer-events-none absolute inset-y-0 bg-stone-100/70" style={{ left: weekend.offset * dayWidth, width: weekend.width }} />
                    ))}
                    {ticks.map((tick) => (
                      <div key={`grid-${tick.date}`} aria-hidden="true" className="pointer-events-none absolute inset-y-0 border-l border-[var(--tk-line)]/70" style={{ left: tick.offset * dayWidth }} />
                    ))}
                    {showToday ? (
                      <div className="pointer-events-none absolute inset-y-0 z-[5] w-0.5 bg-rose-500" style={{ left: todayOffset * dayWidth }} title={`Сегодня ${formatDate(today)}`} data-testid="gantt-today-marker" />
                    ) : null}
                    <div
                      className={`absolute top-5 z-[6] h-7 rounded-full bg-stone-300 shadow-sm ring-1 ring-stone-400/50 ${isSaving ? "opacity-50" : ""}`}
                      style={{ left, width }}
                      title={barTitle}
                      data-testid={`gantt-plan-bar-${stage.id}`}
                    >
                      <div
                        className="absolute inset-y-0 left-0 right-2 cursor-grab rounded-l-full focus-visible:outline-none active:cursor-grabbing"
                        role="button"
                        aria-label={`Переместить этап ${stage.name}`}
                        aria-disabled={isSaving}
                        tabIndex={0}
                        onPointerDown={(event) => startDrag(event, stage, "move")}
                        onKeyDown={(event) => {
                          if (isSaving) return;
                          if (event.key === "ArrowLeft") {
                            event.preventDefault();
                            void commitShift(stage.id, -1);
                          } else if (event.key === "ArrowRight") {
                            event.preventDefault();
                            void commitShift(stage.id, 1);
                          }
                        }}
                        data-testid={`gantt-move-handle-${stage.id}`}
                      />
                      <button
                        type="button"
                        aria-label={`Изменить длительность этапа ${stage.name}`}
                        title="Потяните край, чтобы изменить длительность"
                        disabled={isSaving}
                        className="absolute inset-y-0 right-0 z-10 w-3 cursor-ew-resize rounded-r-full bg-stone-500/70 transition-colors hover:bg-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tk-sidebar-ring)] disabled:cursor-wait"
                        onPointerDown={(event) => startDrag(event, stage, "resize")}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                            event.preventDefault();
                            const next = Math.max(1, duration + (event.key === "ArrowRight" ? 1 : -1));
                            void commitShift(stage.id, 0, next);
                          }
                        }}
                        data-testid={`gantt-resize-handle-${stage.id}`}
                      />
                    </div>
                    <div
                      aria-label={factPct == null ? `Факт не привязан к этапу ${stage.name}` : `Факт ${stage.name}: ${Math.round(factPct * 100)}%`}
                      data-testid={`gantt-bar-${stage.id}`}
                      role="img"
                      className="absolute top-[62px] z-[6] h-3 rounded-full bg-[var(--tk-brand)] shadow-sm transition-[width]"
                      style={{ left, width: factPct == null || factPct === 0 ? 0 : Math.max(8, width * factPct) }}
                    />
                    {factPct != null ? (
                      <span className="absolute top-[58px] z-[7] text-[10px] font-semibold text-[var(--tk-brand-deep)]" style={{ left: Math.min(left + Math.max(8, width * factPct) + 5, timelineWidth - 42) }}>
                        {Math.round(factPct * 100)}%
                      </span>
                    ) : null}
                    {dragPreview?.stageId === stage.id ? (
                      <span className="absolute bottom-2 rounded bg-white/95 px-2 py-1 text-[10px] font-medium text-[var(--tk-ink)] shadow" style={{ left: Math.max(4, left) }}>
                        {preview?.mode === "resize" ? `${widthDays} дн.` : `${preview?.delta && preview.delta > 0 ? "+" : ""}${preview?.delta ?? 0} дн.`}
                      </span>
                    ) : null}
                    {isSaving ? <span className="absolute bottom-2 right-3 text-[10px] text-[var(--tk-muted)]">Сохраняю и пересчитываю…</span> : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
