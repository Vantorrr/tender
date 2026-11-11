"use client";

import { useParams } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { ProjectAiChat } from "@/components/project-ai-chat";
import { userHasSection } from "@/lib/acl";

type MaterialsPreview = {
  file: File;
  rows: number;
  works: Array<{
    workName: string;
    matches: Array<{ id: string; name: string }>;
    selectedStageId: string;
  }>;
  stages: Array<{ id: string; name: string }>;
};

export default function GprDetailPage() {
  const params = useParams<{ id: string }>();
  const materialsFileRef = useRef<HTMLInputElement>(null);
  const [materialsPreview, setMaterialsPreview] = useState<MaterialsPreview | null>(null);
  const [materialsImportBusy, setMaterialsImportBusy] = useState(false);
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
  const calWarnings = collectCalendarWarnings(schedule.stages, supplies, 40, schedule.calendar);
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

  async function previewMaterialsFile(file: File) {
    const form = new FormData();
    form.set("scheduleId", schedule!.id);
    form.set("file", file);
    form.set("preview", "1");
    setMaterialsImportBusy(true);
    try {
      const result = await api<{
        rows: number;
        works: Array<{ workName: string; matches: Array<{ id: string; name: string }> }>;
        stages: Array<{ id: string; name: string }>;
      }>("/api/gpr/materials", { method: "POST", body: form });
      setMaterialsPreview({
        file,
        rows: result.rows,
        stages: result.stages,
        works: result.works.map((work) => ({
          ...work,
          selectedStageId: work.matches.length === 1 ? work.matches[0].id : "",
        })),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось прочитать лист «Материалы»");
    } finally {
      setMaterialsImportBusy(false);
    }
  }

  async function importPreviewedMaterials() {
    if (!materialsPreview) return;
    const stageMap = Object.fromEntries(materialsPreview.works.map((work) => [work.workName, work.selectedStageId]));
    const form = new FormData();
    form.set("scheduleId", schedule!.id);
    form.set("file", materialsPreview.file);
    form.set("stageMap", JSON.stringify(stageMap));
    setMaterialsImportBusy(true);
    try {
      const result = await api<{ imported: number; stages: number }>("/api/gpr/materials", { method: "POST", body: form });
      await refresh();
      setMaterialsPreview(null);
      toast.success(`Импортировано материалов: ${result.imported} · работ: ${result.stages}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось импортировать материалы");
    } finally {
      setMaterialsImportBusy(false);
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
            {userHasSection(user, "gpr") ? (
              <ProjectAiChat
                procurementId={schedule.procurementId}
                projectTitle={schedule.title}
                screen="gpr"
              />
            ) : null}
            <StatusBadge status={schedule.status} />
            <input
              ref={materialsFileRef}
              type="file"
              accept=".xlsx"
              className="hidden"
              aria-label="Загрузить материалы из Excel"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                await previewMaterialsFile(file);
              }}
            />
            <Button variant="outline" disabled={materialsImportBusy} onClick={() => materialsFileRef.current?.click()}>
              Загрузить материалы XLSX
            </Button>
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

      {materialsPreview ? (
        <section className="mb-6 rounded-xl border border-[var(--tk-line)] bg-white p-4" aria-label="Сопоставление материалов с работами ГПР">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold">Материалы из {materialsPreview.file.name}</h2>
              <p className="mt-1 text-sm text-[var(--tk-muted)]">Строк: {materialsPreview.rows}. Проверьте, к какой работе ГПР относится каждая группа. Повторный импорт заменит только ранее импортированные строки из клиентского листа.</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" disabled={materialsImportBusy} onClick={() => setMaterialsPreview(null)}>Отмена</Button>
              <Button disabled={materialsImportBusy || materialsPreview.works.some((work) => !work.selectedStageId)} onClick={() => void importPreviewedMaterials()}>
                {materialsImportBusy ? "Импорт…" : "Импортировать материалы"}
              </Button>
            </div>
          </div>
          <div className="mt-4 max-h-80 space-y-2 overflow-auto">
            {materialsPreview.works.map((work, index) => (
              <label key={work.workName} className="grid gap-2 text-sm md:grid-cols-[minmax(0,1fr)_minmax(16rem,24rem)] md:items-center">
                <span>{work.workName}{work.matches.length === 1 ? <span className="ml-2 text-xs text-emerald-700">совпадение найдено</span> : <span className="ml-2 text-xs text-amber-700">выберите вручную</span>}</span>
                <select
                  className="h-9 rounded-md border border-[var(--tk-line)] bg-white px-2"
                  aria-label={`Работа ГПР для ${work.workName}`}
                  value={work.selectedStageId}
                  onChange={(event) => setMaterialsPreview((current) => current ? ({ ...current, works: current.works.map((item, i) => i === index ? { ...item, selectedStageId: event.target.value } : item) }) : current)}
                >
                  <option value="">Выберите этап ГПР</option>
                  {materialsPreview.stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
                </select>
              </label>
            ))}
          </div>
        </section>
      ) : null}

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
              className="grid gap-2 rounded-xl border border-[var(--tk-line)] bg-white/80 p-3 sm:grid-cols-2 lg:grid-cols-6"
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
              <div className="rounded-lg border border-[var(--tk-line)] bg-white px-3 py-2" data-testid={`stage-work-link-${stage.id}`}>
                <div className="mb-2 text-xs font-medium text-[var(--tk-muted)]">Виды работ план-факта</div>
                <div className="max-h-28 space-y-1 overflow-y-auto">
                  {[...new Set([
                    ...(planFact?.entries ?? []).map((entry) => entry.workName.trim()).filter(Boolean),
                    ...(stage.workNames ?? (stage.workName ? [stage.workName] : [])),
                  ])].map((workName) => {
                    const selected = stage.workNames?.length ? stage.workNames : stage.workName ? [stage.workName] : [];
                    return (
                      <label key={workName} className="flex cursor-pointer items-center gap-2 text-xs">
                        <Checkbox
                          checked={selected.includes(workName)}
                          aria-label={`Связать ${stage.name} с работой ${workName}`}
                          onCheckedChange={(checked) => {
                            const nextNames = checked
                              ? [...new Set([...selected, workName])]
                              : selected.filter((name) => name !== workName);
                            updateSchedule(schedule.id, {
                              stages: schedule.stages.map((item) => item.id === stage.id
                                ? { ...item, workNames: nextNames, workName: nextNames[0] }
                                : item),
                            });
                          }}
                        />
                        <span>{workName}</span>
                      </label>
                    );
                  })}
                  {!planFact?.entries.length && !stage.workName && !stage.workNames?.length ? (
                    <div className="text-xs text-[var(--tk-muted)]">Сначала добавьте работы в план-факт</div>
                  ) : null}
                </div>
              </div>
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
