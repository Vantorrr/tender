"use client";

import { useParams } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, downloadUrl } from "@/lib/api";
import { diffDays } from "@/lib/cost-engine";
import { formatDate } from "@/lib/format";
import { useStore } from "@/lib/store";

function daysBetween(a: string, b: string) {
  return Math.max(1, Math.abs(diffDays(a, b)) || 1);
}

export default function GprDetailPage() {
  const params = useParams<{ id: string }>();
  const { data, user, updateSchedule, refresh } = useStore();
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{
    stageId: string;
    startX: number;
    mode: "move" | "resize";
  } | null>(null);

  if (!user) return null;
  const schedule = data.schedules.find(
    (s) => s.id === params.id && s.orgId === user.orgId
  );
  if (!schedule) return <ErrorState title="ГПР не найден" />;

  const minStart = schedule.stages.reduce(
    (m, s) => (s.start < m ? s.start : m),
    schedule.stages[0]?.start ?? ""
  );
  const maxEnd = schedule.stages.reduce(
    (m, s) => (s.end > m ? s.end : m),
    schedule.stages[0]?.end ?? ""
  );
  const totalDays = daysBetween(minStart, maxEnd) || 1;
  const cal = schedule.calendar;

  async function shiftStage(
    stageId: string,
    deltaDays: number,
    resizeDays?: number | null
  ) {
    try {
      await api("/api/gpr", {
        method: "PATCH",
        body: JSON.stringify({
          id: schedule!.id,
          action: "shiftStage",
          stageId,
          deltaDays,
          cascade: true,
          resizeDays: resizeDays ?? null,
        }),
      });
      await refresh();
      toast.success(
        deltaDays === 0
          ? "Длительность обновлена"
          : `Сдвиг ${deltaDays > 0 ? "+" : ""}${deltaDays} дн.`
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Ошибка сдвига");
    }
  }

  return (
    <div>
      <PageHeader
        title={schedule.title}
        description={`Расчёт «${
          data.calculations.find((c) => c.id === schedule.calculationId)?.title ??
          "—"
        }» · v${schedule.version} · календарь ${cal?.hoursPerShift ?? 8}ч × ${
          cal?.shiftsPerDay ?? 1
        } смен`}
        actions={
          <>
            <StatusBadge status={schedule.status} />
            <Button
              variant="outline"
              onClick={() => {
                updateSchedule(schedule.id, {
                  version: schedule.version + 1,
                });
                toast.success("Создана новая версия ГПР");
              }}
            >
              Новая версия
            </Button>
            <Button
              onClick={() => {
                downloadUrl(`/api/export?kind=gpr-xlsx&id=${schedule.id}`);
                toast.success("Скачивание XLSX…");
              }}
            >
              Экспорт таблицы
            </Button>
          </>
        }
      />

      {(schedule.conflicts?.length ?? 0) > 0 ? (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-950">
          Конфликты зависимостей: {schedule.conflicts!.join("; ")}
        </div>
      ) : null}

      <div className="mb-6 overflow-x-auto rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
        <h2 className="mb-2 font-[family-name:var(--font-display)] text-base">
          Гант — перетаскивание полос
        </h2>
        <p className="mb-4 text-xs text-[var(--tk-muted)]">
          Drag полосы = сдвиг дат; правый край = изменение длительности. Каскад
          FS по зависимостям. Даты на полосах читаемы.
        </p>
        <div className="space-y-3" ref={trackRef} data-testid="gantt-track">
          {schedule.stages
            .slice()
            .sort((a, b) => a.sequence - b.sequence)
            .map((stage) => {
              const offset = Math.max(0, diffDays(minStart, stage.start));
              const width = daysBetween(stage.start, stage.end);
              return (
                <div
                  key={stage.id}
                  className="grid items-center gap-2 sm:grid-cols-[200px_1fr] sm:gap-3"
                >
                  <div className="text-sm">
                    <div className="font-medium">{stage.name}</div>
                    <div className="text-xs text-[var(--tk-muted)]">
                      {formatDate(stage.start)} — {formatDate(stage.end)}
                      {stage.crewSize
                        ? ` · ${stage.crewSize} чел`
                        : ""}
                    </div>
                    {(stage.resources?.length ?? 0) > 0 ? (
                      <div className="mt-1 text-[11px] text-[var(--tk-muted)]">
                        {stage.resources!.map((r) => (
                          <span key={r.id} className="mr-2">
                            {r.kind}:{r.name}×{r.quantity}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="relative h-10 rounded-md bg-stone-100">
                    <div
                      role="slider"
                      aria-label={`Полоса ${stage.name}`}
                      data-testid={`gantt-bar-${stage.id}`}
                      tabIndex={0}
                      draggable
                      onDragStart={(e) => {
                        setDrag({
                          stageId: stage.id,
                          startX: e.clientX,
                          mode: "move",
                        });
                      }}
                      onDragEnd={(e) => {
                        if (!drag || drag.stageId !== stage.id) return;
                        const track = trackRef.current?.querySelector(
                          `.gantt-row-${stage.id}`
                        ) as HTMLElement | null;
                        const w =
                          track?.clientWidth ||
                          trackRef.current?.clientWidth ||
                          600;
                        const pxPerDay = w / totalDays;
                        const deltaPx = e.clientX - drag.startX;
                        const deltaDays = Math.round(deltaPx / pxPerDay);
                        setDrag(null);
                        if (deltaDays !== 0) void shiftStage(stage.id, deltaDays);
                      }}
                      className={`gantt-row-${stage.id} absolute top-1 flex h-8 cursor-grab items-center justify-between rounded-md bg-teal-700/90 px-2 text-[11px] font-medium text-white active:cursor-grabbing`}
                      style={{
                        left: `${(offset / totalDays) * 100}%`,
                        width: `${(width / totalDays) * 100}%`,
                        minWidth: 48,
                      }}
                    >
                      <span className="truncate">
                        {stage.start.slice(5)}→{stage.end.slice(5)}
                      </span>
                      <span
                        className="ml-2 h-full w-2 shrink-0 cursor-ew-resize rounded-sm bg-white/50"
                        title="Изменить длительность"
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          const startX = e.clientX;
                          const startWidth = width;
                          const onMove = (ev: MouseEvent) => {
                            const trackW =
                              (
                                trackRef.current?.querySelector(
                                  `.gantt-row-${stage.id}`
                                ) as HTMLElement | null
                              )?.parentElement?.clientWidth || 600;
                            const pxPerDay = trackW / totalDays;
                            const d = Math.round(
                              (ev.clientX - startX) / pxPerDay
                            );
                            void d;
                            (e.target as HTMLElement).dataset.pending = String(
                              Math.max(1, startWidth + d)
                            );
                          };
                          const onUp = () => {
                            window.removeEventListener("mousemove", onMove);
                            window.removeEventListener("mouseup", onUp);
                            const pending = Number(
                              (e.target as HTMLElement).dataset.pending ??
                                startWidth
                            );
                            if (pending !== startWidth) {
                              void shiftStage(stage.id, 0, pending);
                            }
                          };
                          window.addEventListener("mousemove", onMove);
                          window.addEventListener("mouseup", onUp);
                        }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {schedule.stages.map((s) => (
            <div key={`btns-${s.id}`} className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                data-testid={`gantt-shift-left-${s.id}`}
                onClick={() => shiftStage(s.id, -1)}
              >
                ← {s.name.slice(0, 12)}
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-testid={`gantt-shift-right-${s.id}`}
                onClick={() => shiftStage(s.id, 1)}
              >
                {s.name.slice(0, 12)} →
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="mb-6 overflow-x-auto rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
        <h2 className="mb-2 font-[family-name:var(--font-display)] text-base">
          Сводка ресурсов (люди / материалы / техника / автобусы)
        </h2>
        <table className="w-full text-left text-sm" data-testid="gpr-resource-table">
          <thead>
            <tr className="border-b border-[var(--tk-line)] text-xs text-[var(--tk-muted)]">
              <th className="py-1 pr-2">Этап</th>
              <th className="py-1 pr-2">Вид</th>
              <th className="py-1 pr-2">Название</th>
              <th className="py-1 pr-2">Кол-во</th>
              <th className="py-1">Ед.</th>
            </tr>
          </thead>
          <tbody>
            {schedule.stages.flatMap((stage) =>
              (stage.resources ?? []).map((r) => (
                <tr key={`${stage.id}-${r.id}`} className="border-b border-[var(--tk-line)]/60">
                  <td className="py-1 pr-2">{stage.name}</td>
                  <td className="py-1 pr-2">{r.kind}</td>
                  <td className="py-1 pr-2">{r.name}</td>
                  <td className="py-1 pr-2">{r.quantity}</td>
                  <td className="py-1">{r.unit ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="space-y-3">
        <h2 className="font-[family-name:var(--font-display)] text-base">
          Этапы · мощность · зависимости
        </h2>
        {schedule.stages
          .slice()
          .sort((a, b) => a.sequence - b.sequence)
          .map((stage) => (
            <div
              key={stage.id}
              className="grid gap-2 rounded-xl border border-[var(--tk-line)] bg-white/80 p-3 sm:grid-cols-6"
            >
              <Input
                value={stage.name}
                onChange={(e) => {
                  updateSchedule(schedule.id, {
                    stages: schedule.stages.map((s) =>
                      s.id === stage.id ? { ...s, name: e.target.value } : s
                    ),
                  });
                }}
              />
              <Input
                type="date"
                value={stage.start}
                onChange={(e) => {
                  const delta = diffDays(stage.start, e.target.value);
                  void shiftStage(stage.id, delta);
                }}
              />
              <Input
                type="date"
                value={stage.end}
                onChange={(e) => {
                  const len = Math.max(1, diffDays(stage.start, e.target.value));
                  void shiftStage(stage.id, 0, len);
                }}
              />
              <Input
                type="number"
                min={1}
                value={stage.crewSize ?? 4}
                title="Численность"
                onChange={(e) => {
                  updateSchedule(schedule.id, {
                    stages: schedule.stages.map((s) =>
                      s.id === stage.id
                        ? { ...s, crewSize: Number(e.target.value) || 1 }
                        : s
                    ),
                  });
                }}
              />
              <Input
                type="number"
                min={1}
                value={stage.hoursPerShift ?? 8}
                title="Часов в смене"
                onChange={(e) => {
                  updateSchedule(schedule.id, {
                    stages: schedule.stages.map((s) =>
                      s.id === stage.id
                        ? {
                            ...s,
                            hoursPerShift: Number(e.target.value) || 8,
                          }
                        : s
                    ),
                  });
                }}
              />
              <div className="flex items-center text-xs text-[var(--tk-muted)]">
                {stage.dependencyType ?? "—"}
                {stage.dependsOn
                  ? ` ← ${
                      schedule.stages.find((s) => s.id === stage.dependsOn)
                        ?.name ?? stage.dependsOn
                    }`
                  : " без предка"}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
