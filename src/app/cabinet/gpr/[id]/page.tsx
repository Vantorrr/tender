"use client";

import { useParams } from "next/navigation";
import { toast } from "sonner";
import { ErrorState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, downloadUrl } from "@/lib/api";
import { PlanFactGantt } from "@/components/plan-fact-gantt";
import { GprResourceTree } from "@/components/gpr-resource-tree";
import { collectCalendarWarnings } from "@/lib/calendar-availability";
import { bucketsFromPositions } from "@/lib/cost-engine";
import { formatMoney } from "@/lib/format";
import { isT25uTestId, isT25uTestTitle } from "@/lib/t25u-test-fixture";
import { useStore } from "@/lib/store";
import type { CalcPosition, GprStageResource } from "@/lib/types";

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

  function patchResource(stageId: string, resourceId: string, patch: Partial<GprStageResource>) {
    updateSchedule(schedule!.id, {
      stages: schedule!.stages.map((stage) =>
        stage.id === stageId
          ? {
              ...stage,
              resources: (stage.resources ?? []).map((resource) =>
                resource.id === resourceId ? { ...resource, ...patch } : resource
              ),
            }
          : stage
      ),
    });
  }

  function patchPosition(positionId: string, patch: Partial<CalcPosition>) {
    if (!calc) return;
    updateCalculation(calc.id, {
      positions: calc.positions.map((position) =>
        position.id === positionId ? { ...position, ...patch } : position
      ),
    });
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

      {(schedule.assumptions?.length ?? 0) > 0 ? (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950" data-testid="gpr-assumptions">
          <p className="font-semibold">Черновик требует подтверждения</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">{schedule.assumptions!.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul>
        </div>
      ) : null}

      <div className="mb-6" data-testid="gantt-track">
        <h2 className="mb-2 font-[family-name:var(--font-display)] text-base">
          План / факт · Гант
        </h2>
        <p className="mb-3 text-xs text-[var(--tk-muted)]">
          Передвигайте серую полосу плана мышью или клавишами ←/→. Точные даты и
          длительность этапа можно изменить в календарных полях; зависимые этапы
          и ресурсный расчёт пересчитываются автоматически.
        </p>
        <PlanFactGantt
          stages={schedule.stages}
          entries={planFact?.entries}
          dailyFacts={planFact?.dailyFacts}
          planFactId={planFact?.id}
          filterScope={schedule.id}
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
                    V прямые
                    {cost.totalsIncomplete || cost.resourceSlices.partial
                      ? " · PARTIAL"
                      : ""}
                    : {formatMoney(cost.resourceSlices.direct)}
                  </div>
                  <div data-testid="gpr-slice-w">
                    W НР 43%
                    {cost.totalsIncomplete || cost.resourceSlices.partial
                      ? " · PARTIAL"
                      : ""}
                    : {formatMoney(cost.resourceSlices.overhead)}
                  </div>
                  <div data-testid="gpr-slice-x">
                    X с/с с НР
                    {cost.totalsIncomplete || cost.resourceSlices.partial
                      ? " · PARTIAL"
                      : ""}
                    : {formatMoney(cost.resourceSlices.costWithOh)}
                  </div>
                  <div data-testid="gpr-slice-y">
                    Y наценка 40%
                    {cost.totalsIncomplete || cost.resourceSlices.partial
                      ? " · PARTIAL"
                      : ""}
                    : {formatMoney(cost.resourceSlices.profit)}
                  </div>
                  <div data-testid="gpr-slice-z">
                    Z итого
                    {cost.totalsIncomplete || cost.resourceSlices.partial
                      ? " · PARTIAL"
                      : ""}
                    : {formatMoney(cost.resourceSlices.total)}
                  </div>
                  <div data-testid="gpr-materials-cost">
                    S материалы:{" "}
                    {cost.resourceSlices.materials > 0
                      ? formatMoney(cost.resourceSlices.materials)
                      : "нет данных"}
                  </div>
                  <div data-testid="gpr-labor-cost">
                    T люди: {formatMoney(cost.resourceSlices.labor)}
                  </div>
                  <div data-testid="gpr-equipment-cost">
                    U техника: {formatMoney(cost.resourceSlices.equipment)}
                  </div>
                  {buckets && buckets.other > 0 ? (
                    <div data-testid="gpr-other-cost">
                      Прочие: {formatMoney(buckets.other)}
                    </div>
                  ) : null}
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
                  {buckets.other > 0 ? (
                    <div data-testid="gpr-other-cost">
                      Прочие: {formatMoney(buckets.other)}
                    </div>
                  ) : null}
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

      <div className="mb-6 overflow-x-auto rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
        <h2 className="mb-2 font-[family-name:var(--font-display)] text-base">
          Ресурсный график · работа и вложенные ресурсы
        </h2>
        <GprResourceTree
          stages={schedule.stages}
          positions={calc?.positions ?? []}
          params={calc?.resourceScheduleParams}
          onPatchResource={patchResource}
          onPatchPosition={patchPosition}
        />
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
              className="grid gap-2 rounded-xl border border-[var(--tk-line)] bg-white/80 p-3 sm:grid-cols-5"
            >
              <Input
                value={stage.name}
                aria-label={`Название этапа ${stage.sequence}`}
                onChange={(e) => {
                  updateSchedule(schedule.id, {
                    stages: schedule.stages.map((s) =>
                      s.id === stage.id ? { ...s, name: e.target.value } : s
                    ),
                  });
                }}
              />
              <Input
                type="number"
                min={0}
                value={stage.crewSize ?? 0}
                title="Численность"
                aria-label={`Численность бригады · ${stage.name}`}
                onChange={(e) => {
                  const crew = Math.max(0, Number(e.target.value) || 0);
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
                aria-label={`План объёма этапа · ${stage.name}`}
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
                aria-label={`Часов в смене · ${stage.name}`}
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
