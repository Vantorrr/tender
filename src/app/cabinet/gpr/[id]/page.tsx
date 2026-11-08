"use client";

import { useParams } from "next/navigation";
import { toast } from "sonner";
import { ErrorState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { DateInputRu } from "@/components/date-input-ru";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, downloadUrl } from "@/lib/api";
import { PlanFactGantt } from "@/components/plan-fact-gantt";
import { collectCalendarWarnings } from "@/lib/calendar-availability";
import { bucketsFromPositions, diffDays } from "@/lib/cost-engine";
import { formatDate, formatMoney } from "@/lib/format";
import { buildMaterialNeeds } from "@/lib/materials-need";
import { isT25uTestId, isT25uTestTitle } from "@/lib/t25u-test-fixture";
import { useStore } from "@/lib/store";

const KIND_RU: Record<string, string> = {
  labor: "Люди",
  material: "Материалы",
  equipment: "Техника",
  bus: "Автобусы",
  other: "Прочее",
};

export default function GprDetailPage() {
  const params = useParams<{ id: string }>();
  const { data, user, updateSchedule, updateCalculation, refresh } = useStore();

  if (!user) return null;
  const schedule = data.schedules.find(
    (s) => s.id === params.id && s.orgId === user.orgId
  );
  if (!schedule) return <ErrorState title="ГПР не найден" />;

  const cal = schedule.calendar;
  const calc = data.calculations.find((c) => c.id === schedule.calculationId);
  const buckets = calc
    ? bucketsFromPositions(calc.positions, calc.scenarioFactor || 1)
    : null;
  const cost = calc?.costSummary;
  const supplies = (data.supplyRequests ?? []).filter(
    (s) => s.procurementId === schedule.procurementId
  );
  const calWarnings = collectCalendarWarnings(schedule.stages, supplies);
  const matNeeds = calc
    ? buildMaterialNeeds({
        positions: calc.positions,
        stages: schedule.stages,
      })
    : [];
  const planFact = data.planFacts.find(
    (p) => p.procurementId === schedule.procurementId
  );

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

      {isT25uTestId(schedule.id) || isT25uTestTitle(schedule.title) ? (
        <div
          className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950"
          data-testid="t25u-test-banner"
        >
          <span className="font-semibold">TEST</span> — изолированный ГПР
          приёмки t25u (школа №12 не изменена).
        </div>
      ) : null}

      {(schedule.conflicts?.length ?? 0) > 0 ? (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-950">
          Конфликты зависимостей: {schedule.conflicts!.join("; ")}
        </div>
      ) : null}

      <div className="mb-6" data-testid="gantt-track">
        <h2 className="mb-2 font-[family-name:var(--font-display)] text-base">
          План / факт · Гант
        </h2>
        <p className="mb-3 text-xs text-[var(--tk-muted)]">
          Приоритет — шкала дат и полосы план/факт (не таблица распределения
          слева). Drag синей полосы = сдвиг; ←/→ = ±1 день.
        </p>
        <PlanFactGantt
          stages={schedule.stages}
          entries={planFact?.entries}
          dailyFacts={planFact?.dailyFacts}
          planFactId={planFact?.id}
          onShift={(id, d, resize) => void shiftStage(id, d, resize)}
        />
      </div>

      <div
        className="mb-6 rounded-xl border border-[var(--tk-line)] bg-white/80 p-5"
        data-testid="gpr-cost-summary"
      >
        <h2 className="mb-2 font-[family-name:var(--font-display)] text-base">
          Сводка ГПР / себестоимость (без двойного счёта)
        </h2>
        {cost && buckets ? (
          <>
            {(cost.totalsIncomplete || (cost.incomplete?.length ?? 0) > 0) && (
              <Alert className="mb-3" data-testid="gpr-incomplete-banner">
                <AlertTitle>Итоги неполны</AlertTitle>
                <AlertDescription>
                  C0 / цена не считаются подтверждёнными:{" "}
                  {(cost.incomplete ?? []).slice(0, 8).join("; ") ||
                    "есть незаполненные ставки/позиции"}
                </AlertDescription>
              </Alert>
            )}
            <dl className="grid gap-2 text-sm sm:grid-cols-3">
              {cost.resourceSlices ? (
                <>
                  <div data-testid="gpr-slice-v">
                    V прямые: {formatMoney(cost.resourceSlices.direct)}
                  </div>
                  <div data-testid="gpr-slice-w">
                    W НР 43%: {formatMoney(cost.resourceSlices.overhead)}
                  </div>
                  <div data-testid="gpr-slice-x">
                    X с/с с НР: {formatMoney(cost.resourceSlices.costWithOh)}
                  </div>
                  <div data-testid="gpr-slice-y">
                    Y наценка 40%: {formatMoney(cost.resourceSlices.profit)}
                  </div>
                  <div data-testid="gpr-slice-z">
                    Z итого: {formatMoney(cost.resourceSlices.total)}
                    {cost.totalsIncomplete ? " · неполно" : ""}
                  </div>
                  <div data-testid="gpr-materials-cost">
                    S материалы:{" "}
                    {cost.resourceSlices.materials > 0
                      ? formatMoney(cost.resourceSlices.materials)
                      : "нет данных"}
                  </div>
                </>
              ) : (
                <>
                  <div>Прямые · труд: {formatMoney(buckets.labor)}</div>
                  <div data-testid="gpr-materials-cost">
                    Прямые · материалы:{" "}
                    {buckets.materialsUnpriced
                      ? "нет данных"
                      : formatMoney(buckets.materials)}
                  </div>
                  <div>Прямые · техника: {formatMoney(buckets.equipment)}</div>
                  <div>
                    C0 (без резерва): {formatMoney(cost.C0)}
                    {cost.totalsIncomplete ? " · неполно" : ""}
                  </div>
                  <div>Резерв: {formatMoney(cost.reserve)}</div>
                  <div>C (с резервом): {formatMoney(cost.C)}</div>
                  <div>Прибыль: {formatMoney(cost.profit)}</div>
                  <div>Цена без НДС: {formatMoney(cost.priceExVat)}</div>
                </>
              )}
              <div>
                НДС:{" "}
                {cost.vatAmount == null
                  ? "нет данных"
                  : formatMoney(cost.vatAmount)}
              </div>
            </dl>
          </>
        ) : (
          <p className="text-sm text-[var(--tk-muted)]">
            Сводка появится после пересчёта cost-engine в связанном черновике
            расчёта. Здесь нет угаданных Excel-формул.
          </p>
        )}
        <p className="mt-2 text-xs text-[var(--tk-muted)]">
          Материалы/труд/техника — из позиций расчёта. Строка ресурсов этапа без
          подтверждённой ставки не становится 0 ₽ в цене. НР/СП не дублируются в
          прямых. После сдвига дат автобусные дни и сводка пересчитываются.
        </p>
      </div>

      {calWarnings.length > 0 ? (
        <div
          className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm"
          data-testid="gpr-calendar-warnings"
        >
          <h2 className="mb-2 font-medium">Календарь · доступность</h2>
          <ul className="space-y-1 text-amber-950">
            {calWarnings.map((w, i) => (
              <li key={`${w.kind}-${i}`}>
                [{w.severity}] {w.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div
        className="mb-6 rounded-xl border border-[var(--tk-line)] bg-white/80 p-5"
        data-testid="gpr-material-needs"
      >
        <h2 className="mb-2 font-[family-name:var(--font-display)] text-base">
          Потребность в материалах (из расчёта и ресурсов этапов)
        </h2>
        {matNeeds.length === 0 ? (
          <p className="text-sm text-[var(--tk-muted)]">
            Нет материальных позиций/ресурсов — укажите в расчёте или ставках
            ресурсов. Каталог не угадывается.
          </p>
        ) : (
          <ul className="space-y-2 text-sm" data-testid="gpr-material-needs-list">
            {matNeeds.map((m) => (
              <li
                key={m.key}
                className="flex flex-wrap items-center gap-2 border-b border-[var(--tk-line)]/50 py-1"
              >
                <span className="min-w-[180px] font-medium">{m.name}</span>
                <span className="text-xs text-[var(--tk-muted)]">
                  {m.source === "calc_position" ? "расчёт" : m.stageName}
                </span>
                <Input
                  className="h-8 w-24"
                  type="number"
                  min={0}
                  step="any"
                  title="Количество"
                  data-testid={`mat-need-qty-${m.key}`}
                  value={m.quantity}
                  onChange={(e) => {
                    const q = Number(e.target.value) || 0;
                    if (m.source === "stage_resource" && m.stageId) {
                      const rid = m.key.replace(/^res:/, "");
                      updateSchedule(schedule.id, {
                        stages: schedule.stages.map((s) =>
                          s.id === m.stageId
                            ? {
                                ...s,
                                resources: (s.resources ?? []).map((x) =>
                                  x.id === rid ? { ...x, quantity: q } : x
                                ),
                              }
                            : s
                        ),
                      });
                    } else if (
                      m.source === "calc_position" &&
                      calc &&
                      m.positionId
                    ) {
                      updateCalculation(calc.id, {
                        positions: calc.positions.map((p) =>
                          p.id === m.positionId ? { ...p, quantity: q } : p
                        ),
                      });
                    }
                  }}
                />
                <span>{m.unit}</span>
                <Input
                  className="h-8 w-28"
                  type="number"
                  min={0}
                  step="any"
                  title="Ставка"
                  placeholder="нет данных"
                  data-testid={`mat-need-rate-${m.key}`}
                  value={m.rate == null ? "" : String(m.rate)}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    const rate = raw === "" ? null : Number(raw);
                    const nextRate =
                      rate == null || Number.isNaN(rate) ? null : rate;
                    if (m.source === "stage_resource" && m.stageId) {
                      const rid = m.key.replace(/^res:/, "");
                      updateSchedule(schedule.id, {
                        stages: schedule.stages.map((s) =>
                          s.id === m.stageId
                            ? {
                                ...s,
                                resources: (s.resources ?? []).map((x) =>
                                  x.id === rid ? { ...x, rate: nextRate } : x
                                ),
                              }
                            : s
                        ),
                      });
                    } else if (
                      m.source === "calc_position" &&
                      calc &&
                      m.positionId
                    ) {
                      updateCalculation(calc.id, {
                        positions: calc.positions.map((p) =>
                          p.id === m.positionId
                            ? { ...p, rate: nextRate ?? 0 }
                            : p
                        ),
                      });
                    }
                  }}
                />
                <span>
                  {m.amount == null
                    ? "сумма: нет данных"
                    : formatMoney(m.amount)}
                </span>
                {m.missing.length ? (
                  <span className="text-amber-800">
                    ввод: {m.missing.join(", ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
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
              <th className="py-1 pr-2">Ед.</th>
              <th className="py-1">Ставка</th>
            </tr>
          </thead>
          <tbody>
            {schedule.stages.flatMap((stage) =>
              (stage.resources ?? []).map((r) => (
                <tr
                  key={`${stage.id}-${r.id}`}
                  className="border-b border-[var(--tk-line)]/60"
                >
                  <td className="py-1 pr-2">{stage.name}</td>
                  <td className="py-1 pr-2">
                    {KIND_RU[r.kind] ?? r.kind}
                  </td>
                  <td className="py-1 pr-2">{r.name}</td>
                  <td className="py-1 pr-2">
                    <Input
                      className="h-8 w-20"
                      type="number"
                      min={0}
                      step="any"
                      value={r.quantity}
                      data-testid={`res-qty-${r.id}`}
                      onChange={(e) => {
                        const q = Number(e.target.value) || 0;
                        updateSchedule(schedule.id, {
                          stages: schedule.stages.map((s) =>
                            s.id === stage.id
                              ? {
                                  ...s,
                                  resources: (s.resources ?? []).map((x) =>
                                    x.id === r.id ? { ...x, quantity: q } : x
                                  ),
                                }
                              : s
                          ),
                        });
                      }}
                    />
                  </td>
                  <td className="py-1 pr-2">{r.unit ?? "—"}</td>
                  <td className="py-1">
                    <Input
                      className="h-8 w-28"
                      type="number"
                      min={0}
                      step="any"
                      placeholder="нет данных"
                      value={r.rate == null ? "" : String(r.rate)}
                      data-testid={`res-rate-${r.id}`}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        const rate =
                          raw === "" ? null : Number(raw);
                        updateSchedule(schedule.id, {
                          stages: schedule.stages.map((s) =>
                            s.id === stage.id
                              ? {
                                  ...s,
                                  resources: (s.resources ?? []).map((x) =>
                                    x.id === r.id
                                      ? {
                                          ...x,
                                          rate:
                                            rate == null ||
                                            Number.isNaN(rate)
                                              ? null
                                              : rate,
                                        }
                                      : x
                                  ),
                                }
                              : s
                          ),
                        });
                      }}
                    />
                  </td>
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
              className="grid gap-2 rounded-xl border border-[var(--tk-line)] bg-white/80 p-3 sm:grid-cols-7"
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
              <div>
                <DateInputRu
                  value={stage.start}
                  onChange={(iso) => {
                    const delta = diffDays(stage.start, iso);
                    void shiftStage(stage.id, delta);
                  }}
                />
              </div>
              <div>
                <DateInputRu
                  value={stage.end}
                  onChange={(iso) => {
                    const len = Math.max(1, diffDays(stage.start, iso));
                    void shiftStage(stage.id, 0, len);
                  }}
                />
              </div>
              <Input
                type="number"
                min={1}
                value={stage.crewSize ?? 4}
                title="Численность"
                onChange={(e) => {
                  const crew = Number(e.target.value) || 1;
                  updateSchedule(schedule.id, {
                    stages: schedule.stages.map((s) => {
                      if (s.id !== stage.id) return s;
                      const next = { ...s, crewSize: crew };
                      return {
                        ...next,
                        resources: (next.resources ?? []).map((r) => {
                          if (r.kind === "labor" && /бригада/i.test(r.name)) {
                            return { ...r, quantity: crew };
                          }
                          if (r.kind === "bus" && /автобус/i.test(r.name)) {
                            return {
                              ...r,
                              quantity: Math.max(1, Math.ceil(crew / 20)),
                            };
                          }
                          return r;
                        }),
                      };
                    }),
                  });
                }}
              />
              <Input
                type="number"
                min={0}
                step="any"
                placeholder="объём этапа"
                title="План объёма этапа (физ.)"
                data-testid={`stage-plan-volume-${stage.id}`}
                value={
                  stage.planVolume == null ? "" : String(stage.planVolume)
                }
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  updateSchedule(schedule.id, {
                    stages: schedule.stages.map((s) =>
                      s.id === stage.id
                        ? {
                            ...s,
                            planVolume:
                              raw === ""
                                ? null
                                : Number(raw) || 0,
                          }
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
