"use client";

import { formatNumber } from "@/lib/format";

export type ProductionChartPoint = {
  date: string;
  plan: number;
  fact: number;
};

export function ProductionPlanFactChart({
  workName,
  unit,
  points,
  hasSchedule,
}: {
  workName: string;
  unit: string;
  points: ProductionChartPoint[];
  hasSchedule: boolean;
}) {
  const maxValue = Math.max(1, ...points.flatMap((point) => [point.plan, point.fact]));
  const hasValues = points.some((point) => point.plan > 0 || point.fact > 0);
  const width = Math.max(720, points.length * 24);
  const height = 250;
  const left = 48;
  const right = 12;
  const top = 18;
  const bottom = 32;
  const plotHeight = height - top - bottom;
  const plotWidth = width - left - right;
  const groupWidth = points.length ? plotWidth / points.length : plotWidth;
  const barWidth = Math.min(8, groupWidth * 0.32);

  return (
    <section className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4" aria-label="График плана и факта" data-testid="production-plan-fact-chart">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">План / факт по дням</h3>
          <p className="mt-1 max-w-3xl text-sm text-[var(--tk-muted)]">
            {workName ? `${workName} · ${unit || "единица не указана"}` : "Выберите вид работы для сравнения."}
          </p>
        </div>
        <div className="flex gap-4 text-xs text-[var(--tk-muted)]" aria-label="Легенда графика">
          <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-[var(--chart-1)]" />План ГПР</span>
          <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-[var(--chart-2)]" />Факт</span>
        </div>
      </div>

      {!points.length || !hasValues ? (
        <p className="mt-4 rounded-lg bg-stone-50 px-3 py-4 text-sm text-[var(--tk-muted)]">
          {workName ? "За выбранный месяц нет запланированных объёмов или внесённого факта по этой работе." : "Выберите вид работы для сравнения."}
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <svg
            className="min-w-[720px]"
            width="100%"
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`План и факт по дням: ${workName}, ${unit || "единица не указана"}`}
            data-testid="production-plan-fact-chart-svg"
          >
            {[0, 0.5, 1].map((fraction) => {
              const y = top + plotHeight * (1 - fraction);
              return (
                <g key={fraction}>
                  <line x1={left} x2={width - right} y1={y} y2={y} stroke="currentColor" className="text-stone-200" strokeWidth="1" />
                  <text x={left - 7} y={y + 4} textAnchor="end" className="fill-[var(--tk-muted)]" fontSize="10">{formatNumber(maxValue * fraction)}</text>
                </g>
              );
            })}
            {points.map((point, index) => {
              const x = left + groupWidth * index + groupWidth / 2;
              const planHeight = (point.plan / maxValue) * plotHeight;
              const factHeight = (point.fact / maxValue) * plotHeight;
              const day = point.date.slice(-2).replace(/^0/, "");
              return (
                <g key={point.date}>
                  <title>{`${point.date}: план ${formatNumber(point.plan)} ${unit}, факт ${formatNumber(point.fact)} ${unit}`}</title>
                  <rect x={x - barWidth - 1} y={top + plotHeight - planHeight} width={barWidth} height={Math.max(0, planHeight)} rx="2" fill="var(--chart-1)" />
                  <rect x={x + 1} y={top + plotHeight - factHeight} width={barWidth} height={Math.max(0, factHeight)} rx="2" fill="var(--chart-2)" />
                  {(index % 5 === 0 || index === points.length - 1) ? (
                    <text x={x} y={height - 10} textAnchor="middle" className="fill-[var(--tk-muted)]" fontSize="10">{day}</text>
                  ) : null}
                </g>
              );
            })}
          </svg>
        </div>
      )}
      {!hasSchedule && workName ? (
        <p className="mt-2 text-xs text-amber-800">Для этой работы не задана связь с этапом ГПР: график показывает внесённый факт, план ГПР равен нулю.</p>
      ) : null}
    </section>
  );
}
