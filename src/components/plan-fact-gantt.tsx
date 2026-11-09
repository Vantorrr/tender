"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { diffDays } from "@/lib/cost-engine";
import { formatDate, formatDateRangeShort } from "@/lib/format";
import { entryDisplayFact } from "@/lib/plan-fact-agg";
import type { DailyFact, GprStage, PlanFactEntry } from "@/lib/types";

function daysBetween(a: string, b: string) {
  return Math.max(1, Math.abs(diffDays(a, b)) || 1);
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function entryForStage(stage: GprStage, entries: PlanFactEntry[]) {
  const explicitName = stage.workName?.trim();
  if (explicitName) {
    const explicit = entries.find((entry) => entry.workName === explicitName);
    if (explicit) return explicit;
  }
  const exact = entries.find((entry) => entry.workName === stage.name);
  if (exact) return exact;
  const matches = entries.filter(
    (entry) =>
      stage.name.includes(entry.workName) || entry.workName.includes(stage.name)
  );
  if (matches.length === 1) return matches[0];
  return entries.length === 1 ? entries[0] : undefined;
}

type Props = {
  stages: GprStage[];
  entries?: PlanFactEntry[];
  dailyFacts?: DailyFact[];
  planFactId?: string;
  onShift: (
    stageId: string,
    deltaDays: number,
    resizeDays?: number | null
  ) => void;
};

export function PlanFactGantt({
  stages,
  entries = [],
  dailyFacts = [],
  planFactId,
  onShift,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{
    stageId: string;
    startX: number;
  } | null>(null);
  const [resourceFilter, setResourceFilter] = useState<string>("all");

  const sorted = useMemo(
    () => stages.slice().sort((a, b) => a.sequence - b.sequence),
    [stages]
  );

  const resourceKinds = useMemo(() => {
    const set = new Set<string>();
    for (const s of stages) {
      for (const r of s.resources ?? []) set.add(r.kind);
    }
    return [...set];
  }, [stages]);

  const visible = useMemo(() => {
    if (resourceFilter === "all") return sorted;
    return sorted.filter((s) =>
      (s.resources ?? []).some((r) => r.kind === resourceFilter)
    );
  }, [sorted, resourceFilter]);

  const minStart =
    visible.reduce((m, s) => (s.start < m ? s.start : m), visible[0]?.start) ??
    "";
  const maxEnd =
    visible.reduce((m, s) => (s.end > m ? s.end : m), visible[0]?.end) ?? "";
  const totalDays = daysBetween(minStart, maxEnd) || 1;
  const today = new Date().toISOString().slice(0, 10);
  const todayOffset = Math.max(
    0,
    Math.min(totalDays, diffDays(minStart, today))
  );
  const showToday = today >= minStart && today <= maxEnd;

  // Month ticks
  const ticks: { label: string; leftPct: number }[] = [];
  if (minStart) {
    const start = new Date(minStart + "T12:00:00Z");
    const end = new Date(maxEnd + "T12:00:00Z");
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    while (cursor <= end) {
      const iso = cursor.toISOString().slice(0, 10);
      if (iso >= minStart) {
        ticks.push({
          label: cursor.toLocaleDateString("ru-RU", {
            month: "short",
            year: "2-digit",
            timeZone: "UTC",
          }),
          leftPct: (diffDays(minStart, iso) / totalDays) * 100,
        });
      }
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }

  function progressFor(stage: GprStage): number {
    const entry = entryForStage(stage, entries);
    if (entry && entry.plan > 0) {
      return clamp01(entryDisplayFact(entry, dailyFacts) / entry.plan);
    }
    // Time-based soft progress only as display of calendar elapsed — not invented money
    if (today < stage.start) return 0;
    if (today > stage.end) return 1;
    const len = daysBetween(stage.start, stage.end);
    return clamp01(diffDays(stage.start, today) / len);
  }

  const KIND_RU: Record<string, string> = {
    labor: "Люди",
    material: "Материалы",
    equipment: "Техника",
    bus: "Автобусы",
    other: "Прочее",
  };

  return (
    <div data-testid="plan-fact-gantt">
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <p className="mb-1 text-xs text-[var(--tk-muted)]">Фильтр ресурсов</p>
          <select
            className="flex h-8 w-[200px] rounded-lg border border-input bg-transparent px-2.5 text-sm"
            data-testid="gantt-resource-filter"
            value={resourceFilter}
            onChange={(e) => setResourceFilter(e.target.value)}
          >
            <option value="all">Все ресурсы</option>
            {resourceKinds.map((k) => (
              <option key={k} value={k}>
                {KIND_RU[k] ?? k}
              </option>
            ))}
          </select>
        </div>
        <p className="text-xs text-[var(--tk-muted)]">
          План (серый) / факт-прогресс (синий) · красная линия — текущий день
        </p>
      </div>

      <div
        className="overflow-x-auto rounded-2xl border border-[var(--tk-line)] bg-white/90 p-4"
        ref={trackRef}
      >
        <div className="relative mb-2 h-6 border-b border-[var(--tk-line)]">
          {ticks.map((t) => (
            <span
              key={t.label + t.leftPct}
              className="absolute top-0 text-[10px] text-[var(--tk-muted)]"
              style={{ left: `${t.leftPct}%` }}
            >
              {t.label}
            </span>
          ))}
        </div>

        <div
          className="space-y-4"
          data-testid="gantt-rows"
          data-row-count={visible.length}
          data-resource-filter={resourceFilter}
        >
          {visible.map((stage) => {
            const offset = Math.max(0, diffDays(minStart, stage.start));
            const width = daysBetween(stage.start, stage.end);
            const pct = progressFor(stage);
            const factWidth = Math.max(width * pct, pct > 0 ? 0.3 : 0);
            const dayEntry = entryForStage(stage, entries);
            const dayHref =
              planFactId != null && dayEntry
                ? `/cabinet/proizvodstvo/day?planFactId=${encodeURIComponent(planFactId)}&date=${encodeURIComponent(stage.start)}&work=${encodeURIComponent(dayEntry.workName)}`
                : null;
            return (
              <div
                key={stage.id}
                className="grid items-center gap-2 sm:grid-cols-[minmax(160px,200px)_1fr]"
              >
                <div className="min-w-0 text-sm">
                  <div className="font-medium leading-snug break-words">
                    {stage.name}
                  </div>
                  <div className="text-xs text-[var(--tk-muted)]">
                    {formatDate(stage.start)} — {formatDate(stage.end)}
                  </div>
                  <div className="text-xs font-medium text-teal-800">
                    Прогресс {Math.round(pct * 100)}%
                  </div>
                  {dayHref ? (
                    <Link
                      href={dayHref}
                      className="text-xs text-sky-800 underline"
                      data-testid={`gantt-day-link-${stage.id}`}
                    >
                      Детали дня →
                    </Link>
                  ) : null}
                </div>
                <div className="relative h-14 rounded-md bg-stone-100">
                  {showToday ? (
                    <div
                      className="absolute top-0 z-10 h-full w-0.5 bg-rose-600"
                      style={{ left: `${(todayOffset / totalDays) * 100}%` }}
                      title={`Сегодня ${formatDate(today)}`}
                      data-testid="gantt-today-marker"
                    />
                  ) : null}
                  {/* Plan bar */}
                  <div
                    className="absolute top-2 h-4 rounded-sm bg-stone-300/90"
                    style={{
                      left: `${(offset / totalDays) * 100}%`,
                      width: `${Math.max((width / totalDays) * 100, 4)}%`,
                    }}
                    title={`План ${formatDateRangeShort(stage.start, stage.end)}`}
                  />
                  {/* Fact/progress bar */}
                  <div
                    role="slider"
                    aria-label={`Факт ${stage.name}`}
                    data-testid={`gantt-bar-${stage.id}`}
                    tabIndex={0}
                    draggable
                    onDragStart={(e) => {
                      setDrag({ stageId: stage.id, startX: e.clientX });
                    }}
                    onDragEnd={(e) => {
                      if (!drag || drag.stageId !== stage.id) return;
                      const w = trackRef.current?.clientWidth || 600;
                      const pxPerDay = w / totalDays;
                      const deltaDays = Math.round(
                        (e.clientX - drag.startX) / pxPerDay
                      );
                      setDrag(null);
                      if (deltaDays !== 0) onShift(stage.id, deltaDays);
                    }}
                    className="absolute top-7 flex h-5 cursor-grab items-center rounded-sm bg-teal-700 px-1 text-[10px] text-white active:cursor-grabbing"
                    style={{
                      left: `${(offset / totalDays) * 100}%`,
                      width: `${Math.max((factWidth / totalDays) * 100, pct > 0 ? 3 : 0)}%`,
                      minWidth: pct > 0 ? 24 : 0,
                    }}
                  >
                    {pct > 0.15 ? `${Math.round(pct * 100)}%` : ""}
                  </div>
                  <div className="absolute bottom-0 left-0 flex gap-1 p-0.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 px-1 text-[10px]"
                      data-testid={`gantt-shift-left-${stage.id}`}
                      onClick={() => onShift(stage.id, -1)}
                    >
                      ←
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 px-1 text-[10px]"
                      data-testid={`gantt-shift-right-${stage.id}`}
                      onClick={() => onShift(stage.id, 1)}
                    >
                      →
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
