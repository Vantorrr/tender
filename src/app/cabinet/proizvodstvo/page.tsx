"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DateInputRu } from "@/components/date-input-ru";
import { api, downloadUrl } from "@/lib/api";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";
import { userHasSection } from "@/lib/acl";
import {
  entryDisplayFact,
  entryDisplayRemain,
  sumDailyQty,
} from "@/lib/plan-fact-agg";
import { allocatePlanForSlice, stagesForWork } from "@/lib/plan-from-gpr";
import { economicsFromVolumes } from "@/lib/economics-from-rates";
import { forecastWorkCompletion } from "@/lib/production-forecast";
import { useStore } from "@/lib/store";
import type { ProductionVarianceReport } from "@/server/production-variance-ai";
import type { SupplyStatus } from "@/lib/types";

type PeriodMode = "day" | "month" | "period" | "cum";

const SUPPLY_STATUS_LABELS: Record<SupplyStatus, string> = {
  need: "Потребность",
  quoted_draft: "Запрос КП",
  ordered: "Заказано",
  in_transit: "В пути",
  delivered: "Поставлено",
  accepted: "Принято",
  cancelled: "Отменено",
};

function createDailyFactId() {
  return `df-${crypto.randomUUID()}`;
}

export default function ProizvodstvoPage() {
  const { data, user, updatePlanFact, refresh, orgProcurements } = useStore();
  const [pfId, setPfId] = useState("");
  const [requestedPlanId] = useState(() =>
    typeof window === "undefined"
      ? ""
      : new URLSearchParams(window.location.search).get("planFactId") ?? ""
  );
  const [period, setPeriod] = useState<PeriodMode>("cum");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [qty, setQty] = useState("1");
  const [newWorkName, setNewWorkName] = useState("");
  const [newWorkUnit, setNewWorkUnit] = useState("");
  const [newWorkPlan, setNewWorkPlan] = useState("");
  const [savingDaily, setSavingDaily] = useState(false);
  const [varianceLoading, setVarianceLoading] = useState(false);
  const [supplySavingId, setSupplySavingId] = useState<string | null>(null);
  const [varianceReport, setVarianceReport] = useState<{
    key: string;
    report: ProductionVarianceReport;
  } | null>(null);
  const savingDailyRef = useRef(false);
  const pendingFactIdRef = useRef<string | null>(null);
  const photoRef = useRef<HTMLInputElement>(null);

  const objects = useMemo(
    () => (user ? data.objects.filter((o) => o.orgId === user.orgId) : []),
    [data.objects, user]
  );
  const plans = useMemo(
    () => (user ? data.planFacts.filter((p) => p.orgId === user.orgId) : []),
    [data.planFacts, user]
  );
  const activeId = pfId || (plans.some((item) => item.id === requestedPlanId)
    ? requestedPlanId
    : plans[0]?.id || "");
  const plan = plans.find((p) => p.id === activeId);
  const object = objects.find((o) => o.id === plan?.objectId);
  const procurement = orgProcurements.find((p) => p.id === plan?.procurementId);
  const canViewMoney = user ? userHasSection(user, "dengi") : false;
  const canViewProcurement = user ? userHasSection(user, "zakupki") : false;
  const moneyPlan = procurement?.moneyId
    ? data.moneyPlans.find((m) => m.id === procurement.moneyId && m.orgId === user?.orgId)
    : undefined;
  const gpr = data.schedules.find(
    (s) => s.id === procurement?.gprId && s.orgId === user?.orgId
  );
  const projectSupplies = useMemo(
    () => (data.supplyRequests ?? [])
      .filter((item) => item.procurementId === plan?.procurementId && item.orgId === user?.orgId && item.status !== "cancelled")
      .slice()
      .sort((a, b) => a.needBy.localeCompare(b.needBy)),
    [data.supplyRequests, plan?.procurementId, user?.orgId]
  );

  const workOptions = plan?.entries.map((e) => e.workName) ?? [];
  const [workName, setWorkName] = useState("");
  const selectedWork = workName || workOptions[0] || "";
  const selectedEntry = plan?.entries.find((e) => e.workName === selectedWork);
  const selectedUnit = selectedEntry?.unit ?? "—";

  if (!user) return null;

  const daily = plan?.dailyFacts ?? [];
  const dayFacts = daily.filter((d) => d.date === date);
  const monthKey = date.slice(0, 7);
  const monthFacts = daily.filter((d) => d.date.startsWith(monthKey));
  const draftCalculation = data.calculations.find(
    (calculation) => calculation.id === procurement?.calculationId && calculation.kind !== "customer_original"
  ) ?? data.calculations.find(
    (calculation) => calculation.procurementId === plan?.procurementId && calculation.kind === "resource_draft"
  );
  const customerEstimate = data.calculations.find(
    (calculation) => calculation.id === procurement?.originalCalculationId && calculation.kind === "customer_original"
  ) ?? data.calculations.find(
    (calculation) => calculation.procurementId === plan?.procurementId && calculation.kind === "customer_original"
  );
  const productionEconomics = plan
    ? economicsFromVolumes({
        entries: plan.entries,
        daily,
        positions: draftCalculation?.positions ?? [],
        customerEstimatePositions: customerEstimate?.positions ?? null,
        directories: data.directories ?? [],
      })
    : null;
  const customerEstimateMissingSource = productionEconomics?.customerEstimateIncomplete.includes(
    "customer_estimate_missing"
  ) ?? false;

  function qtyForWork(name: string, list: typeof daily) {
    return sumDailyQty(list, { workName: name });
  }

  // Daily ledger is the display source of truth (same as server after save)
  const totals = plan
    ? plan.entries.reduce(
        (acc, e) => {
          const fact = entryDisplayFact(e, daily);
          acc.plan += e.plan;
          acc.fact += fact;
          acc.remain += entryDisplayRemain(e, daily);
          return acc;
        },
        { plan: 0, fact: 0, remain: 0 }
      )
    : { plan: 0, fact: 0, remain: 0 };
  const planUnits = [...new Set((plan?.entries ?? []).map((entry) => entry.unit.trim()).filter(Boolean))];
  const hasMixedPlanUnits = Boolean(plan?.entries.length) && (
    planUnits.length > 1 || plan!.entries.some((entry) => !entry.unit.trim())
  );

  const periodFact =
    period === "day"
      ? sumDailyQty(dayFacts)
      : period === "month"
        ? sumDailyQty(monthFacts)
        : period === "period"
          ? sumDailyQty(daily)
          : totals.fact;

  // Plan for selected slice: stage volumes when present, else uniform fallback
  const gprStages = gpr?.stages ?? [];
  const selectedWorkStages = plan
    ? stagesForWork(plan.entries.map((entry) => entry.workName), gprStages, selectedWork)
    : [];
  const planSlice = allocatePlanForSlice(
    totals.plan,
    gprStages,
    period,
    date,
    gpr?.calendar
  );
  const periodPlan = planSlice.plan;
  const sliceVariance = periodFact - periodPlan;
  const varianceKey = JSON.stringify({
    planId: plan?.id,
    period,
    date,
    selectedWork,
    periodPlan,
    periodFact,
    daily: daily.map((fact) => [fact.id, fact.date, fact.workName, fact.quantity, fact.comment]),
    supplies: (data.supplyRequests ?? [])
      .filter((supply) => supply.procurementId === plan?.procurementId)
      .map((supply) => [supply.id, supply.needBy, supply.status, supply.materialName, supply.workName]),
  });

  async function updateSupplyReceipt(
    supplyId: string,
    patch: { qtyDelivered?: number; status?: SupplyStatus }
  ) {
    if (!plan) return;
    const supply = projectSupplies.find((item) => item.id === supplyId);
    if (!supply) return;
    setSupplySavingId(supplyId);
    try {
      await api("/api/proizvodstvo", {
        method: "POST",
        body: JSON.stringify({
          action: "updateSupplyReceipt",
          planFactId: plan.id,
          supplyId,
          qtyDelivered: patch.qtyDelivered ?? supply.qtyDelivered,
          supplyStatus: patch.status ?? supply.status,
        }),
      });
      await refresh();
      toast.success("Факт поставки обновлён");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось обновить поставку");
    } finally {
      setSupplySavingId(null);
    }
  }

  async function submitDaily(withPhoto: boolean) {
    if (!plan || !selectedEntry || savingDailyRef.current) return;
    savingDailyRef.current = true;
    setSavingDaily(true);
    const factId = pendingFactIdRef.current ?? createDailyFactId();
    pendingFactIdRef.current = factId;
    try {
      if (withPhoto && photoRef.current?.files?.[0]) {
        const form = new FormData();
        form.append("factId", factId);
        form.append("planFactId", plan.id);
        form.append("date", date);
        form.append("workName", selectedWork);
        form.append("unit", selectedUnit);
        form.append("quantity", qty);
        form.append("photo", photoRef.current.files[0]);
        await api("/api/proizvodstvo", { method: "POST", body: form });
      } else {
        await api("/api/proizvodstvo", {
          method: "POST",
          body: JSON.stringify({
            action: "dailyFact",
            planFactId: plan.id,
            fact: {
              factId,
              date,
              workName: selectedWork,
              unit: selectedUnit,
              quantity: Number(qty) || 0,
            },
          }),
        });
      }
      await refresh();
      pendingFactIdRef.current = null;
      toast.success("Дневной факт сохранён (это не платёж)");
      if (photoRef.current) photoRef.current.value = "";
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Ошибка факта");
    } finally {
      savingDailyRef.current = false;
      setSavingDaily(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Производство · план/факт"
        description="День / месяц / период / накопительно. Фото и ручной факт. Финансовый результат отделён от кассы. Базовый план сохраняется при переводе в производство."
        actions={
          plan ? (
            <Button
              data-testid="planfact-export"
              onClick={() => {
                downloadUrl(`/api/export?kind=planfact-xlsx&id=${plan.id}`);
                toast.success("Скачивание XLSX…");
              }}
            >
              Экспорт
            </Button>
          ) : null
        }
      />

      <div className="mb-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950">
        Физический факт ≠ платёж. Нормативная стоимость выполненного и
        подтверждённые затраты ≠ поступления/списания кассы. Признанная выручка
        — отдельно («нет данных», пока не подтверждено).
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {objects.map((o) => (
          <div
            key={o.id}
            className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="font-semibold">{o.name}</h3>
                <p className="mt-1 text-sm text-[var(--tk-muted)]">
                  {o.address}
                </p>
              </div>
              <StatusBadge status={o.status} />
            </div>
          </div>
        ))}
      </div>

      {plans.length === 0 ? (
        <EmptyState
          title="План/факт не заведён"
          description="Переведите выигранную закупку в производство."
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <div>
              <p className="mb-1 text-xs text-[var(--tk-muted)]">Карточка</p>
              <Select value={activeId} onValueChange={(v) => v && setPfId(v)}>
                <SelectTrigger className="w-[280px]">
                  <SelectValue>{plan?.title ?? "План/факт"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {plans.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {procurement ? (
              <p className="text-sm text-[var(--tk-muted)]">
                Проект {procurement.number}
                {procurement.lifecycle === "production"
                  ? " · в производстве"
                  : ""}
                {plan?.baselineAt
                  ? ` · базовый план от ${formatDate(plan.baselineAt)}`
                  : ""}
              </p>
            ) : null}
            {plan ? (
              <Link
                href={`/cabinet/proizvodstvo/day?planFactId=${encodeURIComponent(plan.id)}&date=${encodeURIComponent(date)}&work=${encodeURIComponent(selectedWork)}`}
                className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-2.5 text-sm hover:bg-muted"
                data-testid="open-day-details"
              >
                Детали дня →
              </Link>
            ) : null}
            <div>
              <p className="mb-1 text-xs text-[var(--tk-muted)]">Срез</p>
              <Select
                value={period}
                onValueChange={(v) => v && setPeriod(v as PeriodMode)}
              >
                <SelectTrigger className="w-[180px]" data-testid="period-mode">
                  <SelectValue>
                    {
                      {
                        day: "День",
                        month: "Месяц",
                        period: "Период (все дни)",
                        cum: "Накоплено",
                      }[period]
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="day">День</SelectItem>
                  <SelectItem value="month">Месяц</SelectItem>
                  <SelectItem value="period">Период</SelectItem>
                  <SelectItem value="cum">Накоплено</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {plan ? (
            <>
              <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {hasMixedPlanUnits ? (
                  <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 sm:col-span-2 lg:col-span-3">
                    Общий объём не суммируется: в проекте разные единицы или часть единиц не указана ({planUnits.join(", ") || "не указаны"}).
                    Сверяйте план, факт и остаток в таблице по каждому виду работ отдельно.
                  </div>
                ) : <>
                  <div className="rounded-xl border bg-white/80 p-3 text-sm">
                    План договора (всего): {formatNumber(totals.plan)} {planUnits[0] ?? ""}
                  </div>
                  <div
                    className="rounded-xl border bg-white/80 p-3 text-sm"
                    data-testid="period-plan-from-gpr"
                  >
                    План (
                  {
                    {
                      day: "день",
                      month: "месяц",
                      period: "период",
                      cum: "накоплено",
                    }[period]
                    }{" "}
                    из ГПР): {formatNumber(periodPlan)} {planUnits[0] ?? ""}
                    <span className="mt-1 block text-[11px] text-[var(--tk-muted)]">
                      {planSlice.source === "stage_volumes"
                        ? "по объёмам этапов"
                        : planSlice.source === "uniform_fallback"
                          ? "равномерно (объёмы этапов не заданы)"
                          : "нет ГПР — срез ограничен"}
                    </span>
                  </div>
                  <div className="rounded-xl border bg-white/80 p-3 text-sm">
                    Факт (
                  {
                    {
                      day: "день",
                      month: "месяц",
                      period: "период",
                      cum: "накоплено",
                    }[period]
                    }
                    ): {formatNumber(periodFact)} {planUnits[0] ?? ""}
                  </div>
                  <div className="rounded-xl border bg-white/80 p-3 text-sm">
                    Отклонение среза (факт−план ГПР):{" "}
                    <span
                      className={
                        sliceVariance < 0
                          ? "text-rose-700"
                          : sliceVariance > 0
                            ? "text-emerald-700"
                            : ""
                      }
                    >
                      {formatNumber(sliceVariance)} {planUnits[0] ?? ""}
                    </span>
                  </div>
                  <div className="rounded-xl border bg-white/80 p-3 text-sm">
                    Остаток договора: {formatNumber(totals.remain)} {planUnits[0] ?? ""}
                  </div>
                  <div className="rounded-xl border bg-white/80 p-3 text-sm">
                    Индекс физ. объёма (не ₽):{" "}
                    {formatNumber(plan.pnl?.earnedValue ?? 0)} {planUnits[0] ?? ""}
                  </div>
                </>}
                <div className="rounded-xl border bg-white/80 p-3 text-sm">
                  Экономика авто (объём×ставки):{" "}
                  {productionEconomics == null || productionEconomics.incomplete.length > 0
                    ? "нет данных"
                    : formatMoney(productionEconomics.autoIncurred)}
                  {(productionEconomics?.incomplete.length ?? 0) > 0 ? (
                    <span className="mt-1 block text-[11px] text-amber-800">
                      не хватает: {(productionEconomics?.incomplete ?? []).slice(0, 4).join(", ")}
                    </span>
                  ) : null}
                </div>
                <div className="rounded-xl border bg-white/80 p-3 text-sm">
                  Оценка выполненного по исходной смете (₽, не выручка):{" "}
                  {productionEconomics?.customerEstimateValue == null
                    ? "нет данных"
                    : formatMoney(productionEconomics.customerEstimateValue)}
                  {(productionEconomics?.customerEstimateIncomplete.length ?? 0) > 0 ? (
                    <span className="mt-1 block text-[11px] text-amber-800">
                      {customerEstimateMissingSource
                        ? "Исходная смета заказчика не загружена"
                        : `нет точной ставки: ${productionEconomics?.customerEstimateIncomplete.slice(0, 3).join(", ")}`}
                    </span>
                  ) : null}
                </div>
                <div className="rounded-xl border bg-white/80 p-3 text-sm">
                  Оценка остатка по исходной смете (₽, не прогноз оплаты):{" "}
                  {productionEconomics?.customerEstimateRemainingValue == null
                    ? "нет данных"
                    : formatMoney(productionEconomics.customerEstimateRemainingValue)}
                </div>
              </div>

              <div className="mb-4 space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="outline"
                    disabled={varianceLoading || !selectedEntry || !selectedWorkStages.length}
                    onClick={async () => {
                      setVarianceLoading(true);
                      try {
                        const response = await api<{ report: ProductionVarianceReport }>(
                          "/api/proizvodstvo",
                          {
                            method: "POST",
                            body: JSON.stringify({
                              action: "analyzeVariance",
                              planFactId: plan.id,
                              period,
                              date,
                              workName: selectedWork,
                            }),
                          }
                        );
                        setVarianceReport({ key: varianceKey, report: response.report });
                      } catch (error) {
                        toast.error(error instanceof Error ? error.message : "Не удалось разобрать отклонение");
                      } finally {
                        setVarianceLoading(false);
                      }
                    }}
                  >
                    {varianceLoading ? "ИИ проверяет записи…" : "Разобрать отклонение с ИИ"}
                  </Button>
                  <span className="text-xs text-[var(--tk-muted)]">
                    {!selectedWorkStages.length
                      ? "Для выбранной работы нет связанных этапов ГПР. Свяжите работу и этап в графике."
                      : `Платный запрос в настроенную модель. Разбор относится к работе «${selectedWork}»; используются только её факт, график, комментарии и поставки.`}
                  </span>
                </div>
                {varianceReport?.key === varianceKey ? (
                  <div className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4" data-testid="production-variance-ai">
                    <h3 className="font-medium">
                      {varianceReport.report.status === "behind"
                        ? "Отставание от плана"
                        : varianceReport.report.status === "ahead"
                          ? "Опережение плана"
                          : varianceReport.report.status === "on_track"
                            ? "Отклонения по объёму нет"
                            : "Причина не установлена"}
                    </h3>
                    <p className="mt-1 text-sm">{varianceReport.report.summary}</p>
                    {varianceReport.report.observations.length ? (
                      <ul className="mt-3 space-y-2 text-sm">
                        {varianceReport.report.observations.map((observation) => (
                          <li key={observation.sourceId}>
                            <span className="font-medium">
                              {observation.kind === "documented_reason" ? "Записано в дневном отчёте: " : "Возможный фактор: "}
                            </span>
                            {observation.text}
                            <span className="mt-1 block text-xs text-[var(--tk-muted)]">
                              Основание: «{observation.sourceQuote}»
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <p className="mt-3 text-xs text-[var(--tk-muted)]">
                      {varianceReport.report.disclaimer}
                    </p>
                  </div>
                ) : null}
              </div>

              <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl border bg-white/80 p-3 text-sm">
                  <p className="mb-1 text-xs text-[var(--tk-muted)]">
                    Подтверждённые затраты (₽)
                    {plan.pnl?.incurredManual ? " · вручную" : ""}
                  </p>
                  <Input
                    data-testid="pnl-incurred"
                    value={String(plan.pnl?.incurredCosts ?? 0)}
                    onChange={(e) => {
                      const v = Number(e.target.value) || 0;
                      updatePlanFact(plan.id, {
                        pnl: {
                          earnedValue: plan.pnl?.earnedValue ?? 0,
                          economicsAuto: plan.pnl?.economicsAuto ?? null,
                          valueOfFactByCustomerEstimate: plan.pnl?.valueOfFactByCustomerEstimate ?? null,
                          remainingValueByCustomerEstimate: plan.pnl?.remainingValueByCustomerEstimate ?? null,
                          customerEstimateIncomplete: plan.pnl?.customerEstimateIncomplete,
                          incurredCosts: v,
                          incurredManual: true,
                          cashIn: plan.pnl?.cashIn ?? 0,
                          cashOut: plan.pnl?.cashOut ?? 0,
                          recognizedRevenue:
                            plan.pnl?.recognizedRevenue ?? null,
                          incomplete: plan.pnl?.incomplete,
                          notes: plan.pnl?.notes ?? [],
                        },
                      });
                    }}
                  />
                </div>
                <div className="rounded-xl border bg-white/80 p-3 text-sm">
                  <p className="mb-1 text-xs text-[var(--tk-muted)]">
                    Поступления касса (₽)
                  </p>
                  <Input
                    data-testid="pnl-cash-in"
                    value={String(plan.pnl?.cashIn ?? 0)}
                    onChange={(e) => {
                      const v = Number(e.target.value) || 0;
                      updatePlanFact(plan.id, {
                        pnl: {
                          ...plan.pnl!,
                          earnedValue: plan.pnl?.earnedValue ?? 0,
                          incurredCosts: plan.pnl?.incurredCosts ?? 0,
                          cashIn: v,
                          cashOut: plan.pnl?.cashOut ?? 0,
                          recognizedRevenue:
                            plan.pnl?.recognizedRevenue ?? null,
                          notes: plan.pnl?.notes ?? [],
                        },
                      });
                    }}
                  />
                </div>
                <div className="rounded-xl border bg-white/80 p-3 text-sm">
                  <p className="mb-1 text-xs text-[var(--tk-muted)]">
                    Списания касса (₽)
                  </p>
                  <Input
                    data-testid="pnl-cash-out"
                    value={String(plan.pnl?.cashOut ?? 0)}
                    onChange={(e) => {
                      const v = Number(e.target.value) || 0;
                      updatePlanFact(plan.id, {
                        pnl: {
                          ...plan.pnl!,
                          earnedValue: plan.pnl?.earnedValue ?? 0,
                          incurredCosts: plan.pnl?.incurredCosts ?? 0,
                          cashIn: plan.pnl?.cashIn ?? 0,
                          cashOut: v,
                          recognizedRevenue:
                            plan.pnl?.recognizedRevenue ?? null,
                          notes: plan.pnl?.notes ?? [],
                        },
                      });
                    }}
                  />
                </div>
                <div className="rounded-xl border bg-white/80 p-3 text-sm">
                  <p className="mb-1 text-xs text-[var(--tk-muted)]">
                    Признанная выручка (₽, пусто = нет данных)
                  </p>
                  <Input
                    data-testid="pnl-revenue"
                    placeholder="нет данных"
                    value={
                      plan.pnl?.recognizedRevenue == null
                        ? ""
                        : String(plan.pnl.recognizedRevenue)
                    }
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      updatePlanFact(plan.id, {
                        pnl: {
                          ...plan.pnl!,
                          earnedValue: plan.pnl?.earnedValue ?? 0,
                          incurredCosts: plan.pnl?.incurredCosts ?? 0,
                          cashIn: plan.pnl?.cashIn ?? 0,
                          cashOut: plan.pnl?.cashOut ?? 0,
                          recognizedRevenue:
                            raw === "" ? null : Number(raw) || 0,
                          notes: plan.pnl?.notes ?? [],
                        },
                      });
                    }}
                  />
                </div>
              </div>

              {gpr ? (
                <div className="mb-4 rounded-xl border border-[var(--tk-line)] bg-white/80 p-4 text-sm">
                  <h3 className="font-medium">Связь с ГПР</h3>
                  <p className="mt-1 text-[var(--tk-muted)]">
                    {gpr.title} · этапы: {gpr.stages.length} ·{" "}
                    {formatDate(gpr.stages[0]?.start ?? "")} —{" "}
                    {formatDate(
                      gpr.stages[gpr.stages.length - 1]?.end ?? ""
                    )}
                  </p>
                  <ul className="mt-2 space-y-1 text-xs text-[var(--tk-muted)]">
                    {gpr.stages.slice(0, 5).map((st) => (
                      <li key={st.id}>
                        {st.name}: {formatDate(st.start)}–{formatDate(st.end)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <section
                className="mb-4 rounded-xl border border-[var(--tk-line)] bg-white/80 p-4"
                aria-label="Материалы и поставки"
                data-testid="production-supplies"
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-medium">Материалы и поставки</h3>
                    <p className="mt-1 text-xs text-[var(--tk-muted)]">
                      Потребность, заказанное и полученное количество с привязкой к работе и сроку.
                    </p>
                  </div>
                  {canViewProcurement && procurement ? (
                    <Link
                      href={`/cabinet/zakupki/${procurement.id}`}
                      className="text-sm text-[var(--tk-copper-deep)] underline underline-offset-2"
                    >
                      Поставщики и запрос КП →
                    </Link>
                  ) : null}
                </div>
                {projectSupplies.length === 0 ? (
                  <p className="rounded-lg bg-stone-50 px-3 py-4 text-sm text-[var(--tk-muted)]">
                    Для этого проекта пока не добавлены материальные потребности.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {projectSupplies.map((supply) => {
                      const remaining = Math.max(0, supply.qtyNeed - supply.qtyDelivered);
                      const overdue = supply.needBy < date && remaining > 0;
                      return (
                        <div
                          key={supply.id}
                          className="grid gap-3 rounded-lg border border-[var(--tk-line)] p-3 lg:grid-cols-[minmax(180px,1.4fr)_minmax(140px,1fr)_minmax(150px,1fr)_130px_130px] lg:items-center"
                          data-testid={`production-supply-${supply.id}`}
                        >
                          <div>
                            <p className="font-medium">{supply.materialName}</p>
                            <p className="mt-1 text-xs text-[var(--tk-muted)]">
                              {supply.workName ? `Работа: ${supply.workName} · ` : ""}
                              {supply.supplierName ? `Поставщик: ${supply.supplierName}` : "Поставщик не указан"}
                            </p>
                          </div>
                          <div className="text-sm">
                            <p>Нужно: {formatNumber(supply.qtyNeed)} {supply.unit}</p>
                            <p className="text-xs text-[var(--tk-muted)]">Заказано: {formatNumber(supply.qtyOrdered)} {supply.unit}</p>
                          </div>
                          <div>
                            <label className="text-xs text-[var(--tk-muted)]" htmlFor={`supply-status-${supply.id}`}>
                              Статус · срок {formatDate(supply.needBy)}
                            </label>
                            <select
                              id={`supply-status-${supply.id}`}
                              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                              value={supply.status}
                              disabled={supplySavingId === supply.id}
                              onChange={(event) => void updateSupplyReceipt(supply.id, { status: event.currentTarget.value as SupplyStatus })}
                            >
                              {(Object.keys(SUPPLY_STATUS_LABELS) as SupplyStatus[]).map((status) => (
                                <option key={status} value={status}>{SUPPLY_STATUS_LABELS[status]}</option>
                              ))}
                            </select>
                            {overdue ? <p className="mt-1 text-xs font-medium text-rose-700">Срок просрочен на {formatDate(date)}</p> : null}
                          </div>
                          <label className="text-xs text-[var(--tk-muted)]">
                            Получено ({supply.unit})
                            <Input
                              className="mt-1 h-9"
                              type="number"
                              min="0"
                              step="any"
                              defaultValue={supply.qtyDelivered}
                              disabled={supplySavingId === supply.id}
                              aria-label={`Получено ${supply.materialName}`}
                              onBlur={(event) => {
                                const amount = Number(event.currentTarget.value);
                                if (Number.isFinite(amount) && amount >= 0 && amount !== supply.qtyDelivered) {
                                  void updateSupplyReceipt(supply.id, { qtyDelivered: amount });
                                }
                              }}
                            />
                          </label>
                          <div className={`text-sm ${remaining > 0 ? "text-amber-800" : "text-emerald-800"}`}>
                            Осталось: {formatNumber(remaining)} {supply.unit}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {canViewMoney && moneyPlan ? (
                <section
                  className="mb-4 rounded-xl border border-[var(--tk-line)] bg-white/80 p-4"
                  aria-label="Деньги проекта"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="font-medium">Деньги по контракту</h3>
                      <p className="mt-1 text-xs text-[var(--tk-muted)]">
                        План платежей связан с этой закупкой; фактические затраты и касса — выше.
                      </p>
                    </div>
                    <Link
                      href={`/cabinet/zakupki/${procurement!.id}`}
                      className="text-sm text-[var(--tk-copper-deep)] underline underline-offset-2"
                    >
                      Платежи и условия →
                    </Link>
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-3">
                    {([
                      ["Авансы", "avans"],
                      ["Поступления", "postuplenie"],
                      ["Ключевые платежи", "klyuchevoy"],
                    ] as const).map(([label, type]) => (
                      <div key={type} className="rounded-lg bg-stone-50 px-3 py-2 text-sm">
                        <span className="text-[var(--tk-muted)]">{label}</span>
                        <span className="ml-2 font-semibold">
                          {formatMoney(moneyPlan.payments
                            .filter((payment) => payment.type === type)
                            .reduce((sum, payment) => sum + payment.amount, 0))}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              <div className="mb-6 rounded-xl border bg-white/80 p-4">
                <h3 className="mb-2 font-medium">Виды работ плана договора</h3>
                {plan.entries.length === 0 ? (
                  <p className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                    В смете нет подтверждённых физических объёмов. Добавьте виды работ и плановые количества вручную, чтобы вести план/факт.
                  </p>
                ) : null}
                <div className="mb-5 flex flex-wrap items-end gap-2">
                  <label className="text-xs">Вид работ<Input aria-label="Новый вид работ" value={newWorkName} onChange={(e) => setNewWorkName(e.target.value)} className="mt-1 w-64" /></label>
                  <label className="text-xs">Ед. изм.<Input aria-label="Единица нового вида работ" value={newWorkUnit} onChange={(e) => setNewWorkUnit(e.target.value)} placeholder="м², м, шт" className="mt-1 w-24" /></label>
                  <label className="text-xs">Плановый объём<Input aria-label="Плановый объём нового вида работ" type="number" min="0" step="any" value={newWorkPlan} onChange={(e) => setNewWorkPlan(e.target.value)} className="mt-1 w-32" /></label>
                  <Button disabled={!plan || !newWorkName.trim() || !newWorkUnit.trim() || !Number.isFinite(Number(newWorkPlan)) || Number(newWorkPlan) <= 0} onClick={() => {
                    if (!plan) return;
                    const name = newWorkName.trim();
                    if (plan.entries.some((entry) => entry.workName.toLocaleLowerCase("ru-RU") === name.toLocaleLowerCase("ru-RU"))) {
                      toast.error("Такой вид работ уже есть в плане");
                      return;
                    }
                    const volume = Number(newWorkPlan);
                    updatePlanFact(plan.id, { entries: [...plan.entries, { id: `pfe-manual-${crypto.randomUUID()}`, workName: name, unit: newWorkUnit.trim(), plan: volume, fact: 0, contractRemaining: volume }] });
                    setWorkName(name);
                    setNewWorkName(""); setNewWorkUnit(""); setNewWorkPlan("");
                    toast.success("Вид работ добавлен в план договора");
                  }}>Добавить работу</Button>
                </div>
                <h3 className="mb-3 font-medium">Дневной факт + фото</h3>
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <p className="mb-1 text-xs text-[var(--tk-muted)]">
                      Дата (ДД.ММ.ГГГГ)
                    </p>
                    <DateInputRu
                      value={date}
                      onChange={setDate}
                      data-testid="daily-fact-date"
                      className="w-[140px]"
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-[var(--tk-muted)]">
                      Вид работ
                    </p>
                    <Select
                      value={selectedWork}
                      onValueChange={(v) => v && setWorkName(v)}
                    >
                      <SelectTrigger className="w-[220px]">
                        <SelectValue>{selectedWork}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {workOptions.map((w) => (
                          <SelectItem key={w} value={w}>
                            {w}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-[var(--tk-muted)]">
                      Объём ({selectedUnit})
                    </p>
                    <Input
                      value={qty}
                      onChange={(e) => setQty(e.target.value)}
                      className="w-24"
                      data-testid="daily-fact-qty"
                    />
                  </div>
                  <input
                    ref={photoRef}
                    type="file"
                    accept="image/*,.pdf"
                    className="text-sm"
                    data-testid="daily-fact-photo-input"
                  />
                  <Button
                    data-testid="daily-fact-save"
                    disabled={savingDaily || !selectedEntry}
                    onClick={() => submitDaily(false)}
                  >
                    {savingDaily ? "Сохранение…" : "Сохранить факт"}
                  </Button>
                  <Button
                    variant="outline"
                    data-testid="daily-fact-photo"
                    disabled={savingDaily || !selectedEntry}
                    onClick={() => submitDaily(true)}
                  >
                    Факт + фото
                  </Button>
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border bg-white/80">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Работа</TableHead>
                      <TableHead>Ед.</TableHead>
                      <TableHead className="text-right">План</TableHead>
                      <TableHead className="text-right">Факт</TableHead>
                      <TableHead className="text-right">За день</TableHead>
                      <TableHead className="text-right">За месяц</TableHead>
                      <TableHead className="text-right">Остаток</TableHead>
                      <TableHead className="text-right">План ГПР · срез</TableHead>
                      <TableHead className="text-right">Δ факт−ГПР</TableHead>
                      <TableHead title="Оценка по фактическому темпу, только после 3 дней с положительным фактом; выходные берутся из календаря ГПР, праздники не моделируются">Прогноз окончания</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {plan.entries.map((e) => {
                      const dayQ = qtyForWork(e.workName, dayFacts);
                      const monthQ = qtyForWork(e.workName, monthFacts);
                      const fact = entryDisplayFact(e, daily);
                      const remain = entryDisplayRemain(e, daily);
                      const workStages = stagesForWork(plan.entries.map((entry) => entry.workName), gprStages, e.workName);
                      const workPlanSlice = allocatePlanForSlice(e.plan, workStages, period, date, gpr?.calendar);
                      const workForecast = forecastWorkCompletion({
                        entry: e,
                        dailyFacts: daily,
                        asOfDate: date,
                        plannedFinish: workStages.length
                          ? workStages.map((stage) => stage.end).sort().at(-1)
                          : undefined,
                        weekendDays: gpr?.calendar?.weekendDays,
                      });
                      const workFactsInSlice = period === "day"
                        ? qtyForWork(e.workName, dayFacts)
                        : period === "month"
                          ? qtyForWork(e.workName, monthFacts)
                          : period === "period"
                            ? qtyForWork(e.workName, daily)
                            : fact;
                      const workVariance = workPlanSlice.source === "none"
                        ? null
                        : workFactsInSlice - workPlanSlice.plan;
                      return (
                        <TableRow key={e.id}>
                          <TableCell>{e.workName}</TableCell>
                          <TableCell>{e.unit}</TableCell>
                          <TableCell className="text-right">
                            <Input
                              className="ml-auto w-24 text-right"
                              value={String(e.plan)}
                              onChange={(ev) => {
                                const v = Number(ev.target.value) || 0;
                                updatePlanFact(plan.id, {
                                  entries: plan.entries.map((x) =>
                                    x.id === e.id
                                      ? {
                                          ...x,
                                          plan: v,
                                          contractRemaining: Math.max(
                                            0,
                                            v - entryDisplayFact(x, daily)
                                          ),
                                        }
                                      : x
                                  ),
                                });
                              }}
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            {formatNumber(fact)}
                          </TableCell>
                          <TableCell className="text-right">
                            {formatNumber(dayQ)}
                          </TableCell>
                          <TableCell className="text-right">
                            {formatNumber(monthQ)}
                          </TableCell>
                          <TableCell className="text-right">
                            {formatNumber(remain)}
                          </TableCell>
                          <TableCell className="text-right text-[var(--tk-muted)]">
                            {workPlanSlice.source === "none"
                              ? workStages.length ? "нет календарных дат" : "нет связи с ГПР"
                              : formatNumber(workPlanSlice.plan)}
                          </TableCell>
                          <TableCell
                            className={`text-right ${
                              workVariance != null && workVariance < 0
                                ? "text-rose-700"
                                : workVariance != null && workVariance > 0
                                  ? "text-emerald-700"
                                  : ""
                            }`}
                            title="Факт выбранного периода минус план этапов ГПР, только при явной связке работы и этапа"
                          >
                            {workVariance == null ? "—" : formatNumber(workVariance)}
                          </TableCell>
                          <TableCell className="min-w-44 text-xs">
                            {workForecast.status === "complete" ? (
                              <span className="font-medium text-emerald-800">Выполнено по факту</span>
                            ) : workForecast.status === "insufficient_data" ? (
                              <span className="text-[var(--tk-muted)]">
                                {workForecast.observedDays}/3 дней факта
                              </span>
                            ) : (
                              <>
                                <span className="font-medium">{formatDate(workForecast.projectedFinish ?? "")}</span>
                                {workForecast.varianceWorkdays != null ? (
                                  <span className={`ml-1 ${workForecast.varianceWorkdays > 0 ? "text-rose-700" : "text-emerald-700"}`}>
                                    {workForecast.varianceWorkdays > 0
                                      ? `+${workForecast.varianceWorkdays} раб. дн.`
                                      : workForecast.varianceWorkdays < 0
                                        ? `${workForecast.varianceWorkdays} раб. дн.`
                                        : "в срок"}
                                  </span>
                                ) : null}
                              </>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              <div className="mt-6">
                <h3 className="mb-2 font-medium">Дневные записи и фотоотчёт</h3>
                <ul className="space-y-2 text-sm">
                  {daily.length === 0 ? (
                    <li className="text-[var(--tk-muted)]">Пока нет фактов</li>
                  ) : (
                    daily
                      .slice()
                      .reverse()
                      .map((d) => (
                        <li
                          key={d.id}
                          className="rounded-lg border px-3 py-2"
                          data-testid={`daily-${d.id}`}
                        >
                          <div>
                            {formatDate(d.date)} · {d.workName}: {d.quantity}{" "}
                            {d.unit}
                            {d.comment ? ` · ${d.comment}` : ""}
                          </div>
                          {(d.photos?.length ?? 0) > 0 ? (
                            <div className="mt-1 flex flex-wrap gap-2">
                              {d.photos.map((ph) => (
                                <a
                                  key={ph.id}
                                  href={`/api/proizvodstvo/photo?id=${ph.id}&disposition=inline`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center rounded-md bg-stone-100 px-2 py-1 text-xs underline-offset-2 hover:underline"
                                  data-testid={`photo-${ph.id}`}
                                  title={`${d.date} · ${d.workName}`}
                                >
                                  📷 {ph.fileName}
                                  {ph.caption ? ` — ${ph.caption}` : ""}
                                  {ph.storedPath ? " · открыть" : ""}
                                </a>
                              ))}
                            </div>
                          ) : null}
                        </li>
                      ))
                  )}
                </ul>
              </div>

              {object ? (
                <p className="mt-4 text-xs text-[var(--tk-muted)]">
                  Объект: {object.name}
                </p>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
