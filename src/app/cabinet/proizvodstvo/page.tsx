"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { ProjectAiChat } from "@/components/project-ai-chat";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { ProductionPlanFactChart } from "@/components/production-plan-fact-chart";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api, downloadUrl } from "@/lib/api";
import { parseDecimalRu } from "@/lib/decimal-ru";
import { DEFAULT_MAX_UPLOAD_BYTES, uploadTooLargeMessage } from "@/lib/upload-limit";
import { formatDate, formatMoney, formatNumber, todayIsoInTimeZone } from "@/lib/format";
import { userHasSection } from "@/lib/acl";
import { visibleProcurementNumber } from "@/lib/pipeline";
import { mergeQuantities, planWorksOnDate, splitEmbeddedUnit } from "@/lib/wave23";
import {
  entryDisplayFact,
  entryDisplayRemain,
  sumDailyQty,
} from "@/lib/plan-fact-agg";
import { allocatePlanForSlice, linkEstimateWorksToStages, stagesForWork } from "@/lib/plan-from-gpr";
import { economicsFromVolumes } from "@/lib/economics-from-rates";
import { forecastWorkCompletion } from "@/lib/production-forecast";
import { paymentBucket } from "@/lib/money-payments";
import { useStore } from "@/lib/store";
import type { ProductionVarianceReport } from "@/server/production-variance-ai";
import type { DailyFactPhoto, SupplyStatus } from "@/lib/types";

function QuietNumberInput({
  id,
  testId,
  value,
  emptyAsNull,
  onCommit,
}: {
  id?: string;
  testId?: string;
  value: number | null;
  emptyAsNull?: boolean;
  onCommit: (value: number | null) => void;
}) {
  const [text, setText] = useState(value == null ? "" : String(value));
  const [focused, setFocused] = useState(false);
  const latest = useRef(text);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function commit(raw: string) {
    if (timer.current) clearTimeout(timer.current);
    const trimmed = raw.trim();
    if (!trimmed) {
      onCommit(emptyAsNull ? null : 0);
      return;
    }
    const parsed = parseDecimalRu(trimmed);
    if (parsed == null) return;
    onCommit(parsed);
  }
  return (
    <Input
      id={id}
      data-testid={testId}
      value={focused ? text : value == null ? "" : String(value)}
      onFocus={() => {
        setFocused(true);
        setText(value == null ? "" : String(value));
      }}
      onChange={(event) => {
        const next = event.target.value;
        latest.current = next;
        setText(next);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => commit(next), 400);
      }}
      onBlur={() => {
        setFocused(false);
        commit(latest.current);
      }}
    />
  );
}

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
  const router = useRouter();
  const { data, user, updatePlanFact, refresh, orgProcurements } = useStore();
  const [pfId, setPfId] = useState("");
  const [requestedPlanId] = useState(() =>
    typeof window === "undefined"
      ? ""
      : new URLSearchParams(window.location.search).get("planFactId") ?? ""
  );
  const [period, setPeriod] = useState<PeriodMode>("day");
  const [date, setDate] = useState(todayIsoInTimeZone());
  const [qty, setQty] = useState("1");
  const [newWorkName, setNewWorkName] = useState("");
  const [newWorkUnit, setNewWorkUnit] = useState("");
  const [newWorkPlan, setNewWorkPlan] = useState("");
  const [savingDaily, setSavingDaily] = useState(false);
  const [varianceLoading, setVarianceLoading] = useState(false);
  const [supplySavingId, setSupplySavingId] = useState<string | null>(null);
  const [photoPreview, setPhotoPreview] = useState<{
    photo: DailyFactPhoto;
    date: string;
    workName: string;
  } | null>(null);
  const [photoPreviewFailed, setPhotoPreviewFailed] = useState(false);
  const [varianceReport, setVarianceReport] = useState<{
    key: string;
    report: ProductionVarianceReport;
  } | null>(null);
  const savingDailyRef = useRef(false);
  const pendingFactIdRef = useRef<string | null>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [factError, setFactError] = useState<string | null>(null);

  const plans = useMemo(
    () => (user ? data.planFacts.filter((p) => p.orgId === user.orgId) : []),
    [data.planFacts, user]
  );
  const activeId = pfId || (plans.some((item) => item.id === requestedPlanId)
    ? requestedPlanId
    : plans[0]?.id || "");
  const plan = plans.find((p) => p.id === activeId);
  const object = data.objects.find((o) => o.id === plan?.objectId && o.orgId === user?.orgId);
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
  const gprMaterialNeeds = useMemo(() => {
    const linked = new Set(projectSupplies.map((supply) =>
      `${supply.workName ?? ""}|${supply.materialName}`.toLocaleLowerCase("ru-RU")
    ));
    const rows = (gpr?.stages ?? []).flatMap((stage) =>
      (stage.resources ?? [])
        .filter((resource) => resource.kind === "material" && resource.quantity > 0)
        .filter((resource) => !linked.has(`${stage.name}|${resource.name}`.toLocaleLowerCase("ru-RU")))
        .map((resource) => ({
          key: `${stage.id}:${resource.id}`,
          name: resource.name,
          stageName: stage.name,
          materialName: resource.name,
          unit: resource.unit,
          quantity: resource.quantity,
          needBy: stage.end,
        }))
    );
    return mergeQuantities(rows);
  }, [gpr?.stages, projectSupplies]);

  const workOptions = plan?.entries.map((e) => e.workName) ?? [];
  const [workName, setWorkName] = useState("");
  const selectedWork = workOptions.includes(workName) ? workName : workOptions[0] || "";
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

  function qtyForWork(name: string, unit: string, list: typeof daily) {
    return sumDailyQty(list, { workName: name, unit });
  }

  // Plan for selected slice: stage volumes when present, else uniform fallback
  const gprStages = gpr
    ? linkEstimateWorksToStages(gpr.stages, draftCalculation?.positions ?? [])
    : [];
  const selectedWorkStages = plan
    ? stagesForWork(plan.entries.map((entry) => entry.workName), gprStages, selectedWork)
    : [];
  const planForEntries = (mode: PeriodMode, entries = plan?.entries ?? []) => {
    const slices = entries.map((entry) => allocatePlanForSlice(
      entry.plan,
      stagesForWork(entries.map((item) => item.workName), gprStages, entry.workName),
      mode, date, gpr?.calendar
    ));
    return {
      plan: slices.reduce((sum, slice) => sum + slice.plan, 0),
      source: slices.some((slice) => slice.source === "stage_volumes") ? "stage_volumes" : slices.some((slice) => slice.source === "uniform_fallback") ? "uniform_fallback" : "none",
    };
  };
  const unitGroups = (() => {
    const groups = new Map<string, NonNullable<typeof plan>["entries"]>();
    for (const entry of plan?.entries ?? []) {
      const unit = entry.unit.trim() || "ед. не указана";
      groups.set(unit, [...(groups.get(unit) ?? []), entry]);
    }
    return [...groups.entries()].map(([unit, entries]) => {
      const factsForEntries = (facts: typeof daily) => facts.filter((fact) =>
        entries.some((entry) => entry.workName === fact.workName && entry.unit === fact.unit)
      );
      const sliceFacts = period === "day"
        ? factsForEntries(dayFacts)
        : period === "month"
          ? factsForEntries(monthFacts)
          : period === "period"
            ? factsForEntries(daily)
            : [];
      const fact = entries.reduce((sum, entry) => sum + entryDisplayFact(entry, daily), 0);
      const periodFact = period === "cum" ? fact : sumDailyQty(sliceFacts);
      const periodPlan = planForEntries(period, entries).plan;
      return {
        unit,
        workCount: entries.length,
        plan: entries.reduce((sum, entry) => sum + entry.plan, 0),
        fact,
        remain: entries.reduce((sum, entry) => sum + entryDisplayRemain(entry, daily), 0),
        periodPlan,
        periodFact,
        variance: periodFact - periodPlan,
        monthFact: sumDailyQty(factsForEntries(monthFacts)),
        monthPlan: planForEntries("month", entries).plan,
      };
    });
  })();
  const selectedWorkFact = selectedEntry
    ? sumDailyQty(daily, { workName: selectedEntry.workName, unit: selectedEntry.unit })
    : 0;
  const selectedWorkPeriodFact = selectedEntry
    ? period === "day"
      ? sumDailyQty(dayFacts, { workName: selectedEntry.workName, unit: selectedEntry.unit })
      : period === "month"
        ? sumDailyQty(monthFacts, { workName: selectedEntry.workName, unit: selectedEntry.unit })
        : selectedWorkFact
    : 0;
  const selectedWorkPeriodPlan = selectedEntry
    ? allocatePlanForSlice(selectedEntry.plan, selectedWorkStages, period, date, gpr?.calendar).plan
    : 0;
  const planMonthDays = (() => {
    const [year, month] = monthKey.split("-").map(Number);
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  })();
  const chartPoints = selectedEntry
    ? Array.from({ length: planMonthDays }, (_, index) => {
        const dayDate = `${monthKey}-${String(index + 1).padStart(2, "0")}`;
        return {
          date: dayDate,
          plan: allocatePlanForSlice(selectedEntry.plan, selectedWorkStages, "day", dayDate, gpr?.calendar).plan,
          fact: sumDailyQty(daily, { workName: selectedEntry.workName, unit: selectedEntry.unit, date: dayDate }),
        };
      })
    : [];
  const dailyGprPlanRows = (plan?.entries ?? [])
    .map((entry) => {
      const workStages = stagesForWork(plan?.entries.map((item) => item.workName) ?? [], gprStages, entry.workName);
      const slice = allocatePlanForSlice(entry.plan, workStages, "day", date, gpr?.calendar);
      return { entry, plan: slice.plan, source: slice.source };
    })
    .filter((row) => row.plan > 0);
  const varianceKey = JSON.stringify({
    planId: plan?.id,
    period,
    date,
    selectedWork,
    selectedWorkPeriodPlan,
    selectedWorkPeriodFact,
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

  async function createSupplyFromGpr(need: (typeof gprMaterialNeeds)[number]) {
    if (!procurement) return;
    setSupplySavingId(need.key);
    try {
      await api("/api/supply", {
        method: "POST",
        body: JSON.stringify({
          procurementId: procurement.id,
          workName: need.stageName,
          materialName: need.materialName,
          unit: need.unit,
          qtyNeed: need.quantity,
          needBy: need.needBy,
        }),
      });
      await refresh();
      const matched = (data.suppliers ?? []).filter((supplier) =>
        (supplier.materialKeywords ?? []).some((keyword) => need.materialName.toLocaleLowerCase("ru-RU").includes(keyword.toLocaleLowerCase("ru-RU")))
      );
      toast.success(matched.length
        ? `Потребность создана: ${need.materialName}. В справочнике ${matched.length} поставщиков.`
        : `Потребность создана: ${need.materialName}. В справочнике подходящих поставщиков нет.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось создать потребность");
    } finally {
      setSupplySavingId(null);
    }
  }

  async function submitDaily(withPhoto: boolean) {
    if (!plan || !selectedEntry || savingDailyRef.current) return;
    const photo = photoFile ?? photoRef.current?.files?.[0] ?? null;
    if (withPhoto && !photo) {
      const message = "Сначала выберите фото";
      setFactError(message);
      toast.error(message);
      return;
    }
    const quantity = parseDecimalRu(qty);
    if (quantity == null) {
      const message = "Укажите объём числом, например 1,5";
      setFactError(message);
      toast.error(message);
      return;
    }
    const photoTooLarge = Boolean(withPhoto && photo && photo.size > DEFAULT_MAX_UPLOAD_BYTES);
    savingDailyRef.current = true;
    setSavingDaily(true);
    setFactError(null);
    const factId = pendingFactIdRef.current ?? createDailyFactId();
    pendingFactIdRef.current = factId;
    try {
      if (withPhoto && photo && !photoTooLarge) {
        const form = new FormData();
        form.append("factId", factId);
        form.append("planFactId", plan.id);
        form.append("date", date);
        form.append("workName", selectedWork);
        form.append("unit", selectedUnit);
        form.append("quantity", String(quantity));
        form.append("photo", photo);
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
              quantity,
            },
          }),
        });
      }
      await refresh();
      pendingFactIdRef.current = null;
      if (photoRef.current) photoRef.current.value = "";
      setPhotoFile(null);
      if (photoTooLarge) {
        const message = `${uploadTooLargeMessage()}. Строка факта сохранена без фото.`;
        setFactError(message);
        toast.error(message);
      } else {
        toast.success(withPhoto ? "Дневной факт и фото сохранены (это не платёж)" : "Дневной факт сохранён (это не платёж)");
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Ошибка факта";
      setFactError(message);
      toast.error(message);
      try {
        await refresh();
      } catch {
        /* The fact row may already be stored; keep the error on screen. */
      }
    } finally {
      savingDailyRef.current = false;
      setSavingDaily(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Производство · план/факт"
        description="Выберите проект и период, чтобы сверить выполнение работ с планом."
        actions={
          plan ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => router.push("/cabinet")}>Назад</Button>
              {procurement && user && userHasSection(user, "proizvodstvo") ? (
                <ProjectAiChat procurementId={procurement.id} projectTitle={procurement.title} screen="production" />
              ) : null}
              <Button
                data-testid="planfact-export"
                onClick={() => {
                  downloadUrl(`/api/export?kind=planfact-xlsx&id=${plan.id}`);
                  toast.success("Скачивание XLSX…");
                }}
              >
                Экспорт
              </Button>
            </div>
          ) : null
        }
      />

      {plans.length === 0 ? (
        <EmptyState
          title="План/факт не заведён"
          description="Переведите выигранную закупку в производство."
        />
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-end gap-4 rounded-2xl border border-border bg-card p-4 shadow-sm">
            <div className="min-w-[260px] flex-1">
              <label className="mb-1.5 block text-sm font-semibold" htmlFor="production-project">Проект</label>
              <Select value={activeId} onValueChange={(v) => v && setPfId(v)}>
                <SelectTrigger id="production-project" className="h-11 w-full bg-background text-sm font-medium">
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
              <p className="pb-2 text-sm text-muted-foreground">
                {visibleProcurementNumber(procurement) === "Ручная закупка"
                  ? "Ручная закупка"
                  : `Закупка № ${visibleProcurementNumber(procurement)}`}
                {procurement.lifecycle === "production" ? " · В производстве" : ""}
              </p>
            ) : null}
            {plan ? (
              <Link
                href={`/cabinet/proizvodstvo/day?planFactId=${encodeURIComponent(plan.id)}&date=${encodeURIComponent(date)}&work=${encodeURIComponent(selectedWork)}`}
                className="inline-flex h-10 items-center rounded-lg border border-border bg-background px-3 text-sm font-medium hover:bg-muted"
                data-testid="open-day-details"
              >
                Детали дня →
              </Link>
            ) : null}
            <div>
              <label className="mb-1.5 block text-sm font-semibold" htmlFor="production-period">Период</label>
              <Select
                value={period}
                onValueChange={(v) => v && setPeriod(v as PeriodMode)}
              >
                <SelectTrigger id="production-period" className="h-11 w-[180px] bg-background" data-testid="period-mode">
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

          <details className="mb-5 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium text-foreground">Как читать показатели</summary>
            <p className="mt-2 max-w-4xl leading-relaxed text-muted-foreground">
              Факт — выполненный физический объём. Деньги и касса учитываются отдельно: стоимость выполненного, подтверждённые затраты, поступления и списания — разные показатели. Базовый план сохраняется при переводе проекта в производство.
            </p>
          </details>

          {plan ? (
            <>
              <section className="mb-5" aria-label="Сводка выполнения" data-testid="prod-plan-vs-gpr">
                <h2 className="mb-3 text-lg font-semibold tracking-tight">Выполнение работ</h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {unitGroups.map((group) => (
                  <article key={group.unit} className="rounded-xl border bg-white/80 p-4 text-sm" data-testid={`prod-unit-${group.unit}`}>
                    <div className="flex items-baseline justify-between gap-3">
                      <h3 className="font-semibold">Объём · {group.unit}</h3>
                      <span className="text-xs text-muted-foreground">{group.workCount} видов работ</span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
                      <div><p className="text-xs text-muted-foreground">План за период</p><p className="mt-1 text-lg font-semibold">{formatNumber(group.periodPlan)}</p></div>
                      <div><p className="text-xs text-muted-foreground">Факт за период</p><p className="mt-1 text-lg font-semibold">{formatNumber(group.periodFact)}</p></div>
                      <div><p className="text-xs text-muted-foreground">Выполнено всего</p><p className="mt-1 font-medium">{formatNumber(group.fact)} <span className="font-normal text-muted-foreground">из {formatNumber(group.plan)}</span></p></div>
                      <div><p className="text-xs text-muted-foreground">Остаток</p><p className="mt-1 font-medium">{formatNumber(group.remain)}</p></div>
                      <div className="col-span-2 border-t pt-2"><p className="text-xs text-muted-foreground">За месяц · план / факт</p><p className="mt-1 font-medium">{formatNumber(group.monthPlan)} / {formatNumber(group.monthFact)}</p></div>
                    </div>
                    <p className={`mt-3 text-xs ${group.variance < 0 ? "text-rose-700" : group.variance > 0 ? "text-emerald-700" : "text-muted-foreground"}`}>
                      Отклонение за период: {group.variance > 0 ? "+" : ""}{formatNumber(group.variance)} {group.unit}
                    </p>
                  </article>
                ))}
              </div>
              </section>

              <section className="mb-5" aria-label="Экономика проекта">
                <h2 className="mb-3 text-lg font-semibold tracking-tight">Стоимость и смета</h2>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div className="rounded-xl border bg-white/80 p-4 text-sm" data-testid="prod-earned-rub">
                  <p className="text-sm font-medium text-muted-foreground">Стоимость выполненного</p>
                  <p className="mt-2 text-xl font-semibold tracking-tight" aria-readonly="true">
                    {productionEconomics == null || productionEconomics.incomplete.length > 0
                      ? "Расчёт неполный"
                      : formatMoney(productionEconomics.autoIncurred)}
                  </p>
                  {(productionEconomics?.incomplete.length ?? 0) > 0 ? (
                    <span className="mt-2 block text-xs text-amber-800">
                      Не хватает ставок по {productionEconomics?.incomplete.length} позициям
                    </span>
                  ) : null}
                </div>
                <div className="rounded-xl border bg-white/80 p-4 text-sm">
                  <p className="font-medium text-muted-foreground">Стоимость по смете заказчика</p>
                  <p className="mt-2 text-lg font-semibold tracking-tight">
                  {productionEconomics?.customerEstimateValue == null
                    ? "нет данных"
                    : formatMoney(productionEconomics.customerEstimateValue)}
                  </p>
                  {(productionEconomics?.customerEstimateIncomplete.length ?? 0) > 0 ? (
                    <span className="mt-2 block text-xs text-amber-800">
                      {customerEstimateMissingSource
                        ? "Исходная смета заказчика не загружена"
                        : `нет точной ставки: ${productionEconomics?.customerEstimateIncomplete.slice(0, 3).join(", ")}`}
                    </span>
                  ) : null}
                </div>
                <div className="rounded-xl border bg-white/80 p-4 text-sm">
                  <p className="font-medium text-muted-foreground">Остаток по смете</p>
                  <p className="mt-2 text-lg font-semibold tracking-tight">
                  {productionEconomics?.customerEstimateRemainingValue == null
                    ? "нет данных"
                    : formatMoney(productionEconomics.customerEstimateRemainingValue)}
                  </p>
                </div>
                </div>
              </section>

              <div className="mb-4 space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <Button
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
                  <details className="text-sm text-muted-foreground">
                    <summary className="cursor-pointer">Что проверит ИИ</summary>
                    <p className="mt-1 max-w-2xl leading-relaxed">
                      Сопоставит факт выбранной работы с этапами ГПР, комментариями и поставками. Анализ запускается отдельным платным запросом.
                    </p>
                  </details>
                </div>
                {!selectedWorkStages.length ? (
                  <p className="text-sm text-amber-800">Для этой работы не связаны этапы ГПР. Сначала свяжите их в графике.</p>
                ) : null}
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

              <section className="mb-5" aria-label="Финансовые показатели">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-lg font-semibold tracking-tight">Затраты и касса</h2>
                  <details className="text-sm text-muted-foreground">
                    <summary className="cursor-pointer">Что сюда вносить</summary>
                    <p className="mt-1 max-w-lg leading-relaxed">Факт выполненных работ не является платежом. Вносите подтверждённые затраты и реальные движения денег; неизвестную выручку оставляйте пустой.</p>
                  </details>
                </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl border bg-white/80 p-4 text-sm">
                  <label className="mb-2 block text-sm font-medium" htmlFor="pnl-incurred">
                    Подтверждённые затраты (₽)
                    {plan.pnl?.incurredManual ? " · вручную" : ""}
                  </label>
                  <QuietNumberInput
                    id="pnl-incurred"
                    testId="pnl-incurred"
                    value={plan.pnl?.incurredCosts ?? 0}
                    onCommit={(v) => {
                      updatePlanFact(plan.id, {
                        pnl: {
                          earnedValue: plan.pnl?.earnedValue ?? 0,
                          economicsAuto: plan.pnl?.economicsAuto ?? null,
                          valueOfFactByCustomerEstimate: plan.pnl?.valueOfFactByCustomerEstimate ?? null,
                          remainingValueByCustomerEstimate: plan.pnl?.remainingValueByCustomerEstimate ?? null,
                          customerEstimateIncomplete: plan.pnl?.customerEstimateIncomplete,
                          incurredCosts: v ?? 0,
                          incurredManual: true,
                          cashIn: plan.pnl?.cashIn ?? 0,
                          cashOut: plan.pnl?.cashOut ?? 0,
                          recognizedRevenue: plan.pnl?.recognizedRevenue ?? null,
                          incomplete: plan.pnl?.incomplete,
                          notes: plan.pnl?.notes ?? [],
                        },
                      });
                    }}
                  />
                </div>
                <div className="rounded-xl border bg-white/80 p-4 text-sm">
                  <label className="mb-2 block text-sm font-medium" htmlFor="pnl-cash-in">
                    Поступления, ₽
                  </label>
                  <QuietNumberInput
                    id="pnl-cash-in"
                    testId="pnl-cash-in"
                    value={plan.pnl?.cashIn ?? 0}
                    onCommit={(v) => {
                      updatePlanFact(plan.id, {
                        pnl: {
                          ...plan.pnl!,
                          earnedValue: plan.pnl?.earnedValue ?? 0,
                          incurredCosts: plan.pnl?.incurredCosts ?? 0,
                          cashIn: v ?? 0,
                          cashOut: plan.pnl?.cashOut ?? 0,
                          recognizedRevenue: plan.pnl?.recognizedRevenue ?? null,
                          notes: plan.pnl?.notes ?? [],
                        },
                      });
                    }}
                  />
                </div>
                <div className="rounded-xl border bg-white/80 p-4 text-sm">
                  <label className="mb-2 block text-sm font-medium" htmlFor="pnl-cash-out">
                    Списания, ₽
                  </label>
                  <QuietNumberInput
                    id="pnl-cash-out"
                    testId="pnl-cash-out"
                    value={plan.pnl?.cashOut ?? 0}
                    onCommit={(v) => {
                      updatePlanFact(plan.id, {
                        pnl: {
                          ...plan.pnl!,
                          earnedValue: plan.pnl?.earnedValue ?? 0,
                          incurredCosts: plan.pnl?.incurredCosts ?? 0,
                          cashIn: plan.pnl?.cashIn ?? 0,
                          cashOut: v ?? 0,
                          recognizedRevenue: plan.pnl?.recognizedRevenue ?? null,
                          notes: plan.pnl?.notes ?? [],
                        },
                      });
                    }}
                  />
                </div>
                <div className="rounded-xl border bg-white/80 p-4 text-sm">
                  <label className="mb-2 block text-sm font-medium" htmlFor="pnl-revenue">
                    Выручка, ₽
                  </label>
                  <QuietNumberInput
                    id="pnl-revenue"
                    testId="pnl-revenue"
                    emptyAsNull
                    value={plan.pnl?.recognizedRevenue ?? null}
                    onCommit={(v) => {
                      updatePlanFact(plan.id, {
                        pnl: {
                          ...plan.pnl!,
                          earnedValue: plan.pnl?.earnedValue ?? 0,
                          incurredCosts: plan.pnl?.incurredCosts ?? 0,
                          cashIn: plan.pnl?.cashIn ?? 0,
                          cashOut: plan.pnl?.cashOut ?? 0,
                          recognizedRevenue: v,
                          notes: plan.pnl?.notes ?? [],
                        },
                      });
                    }}
                  />
                </div>
              </div>
              </section>

              {gpr ? (
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
                  <div>
                    <p className="text-sm font-semibold">График производства работ</p>
                    <p className="mt-1 text-sm text-muted-foreground">{gpr.title} · {gpr.stages.length} этапов</p>
                  </div>
                  <Link href={`/cabinet/gpr/${gpr.id}`} className="text-sm font-medium text-primary underline underline-offset-4">Открыть ГПР →</Link>
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
                  </div>
                  {canViewProcurement && procurement ? (
                    <Link
                      href={`/cabinet/zakupki/${procurement.id}?tab=supply`}
                      className="text-sm text-[var(--tk-copper-deep)] underline underline-offset-2"
                    >
                      Поставщики и запрос КП →
                    </Link>
                  ) : null}
                </div>
                {projectSupplies.length === 0 && gprMaterialNeeds.length === 0 ? (
                  <p className="rounded-lg bg-stone-50 px-3 py-4 text-sm text-[var(--tk-muted)]">
                    В ГПР ещё не заданы материалы и потребности поставок.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {gprMaterialNeeds.map((need) => (
                      <div key={need.key} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-[var(--tk-line)] bg-stone-50/70 p-3" data-testid={`gpr-material-need-${need.key}`}>
                        <div>
                          <p className="font-medium">{need.materialName}</p>
                          <p className="mt-1 text-xs text-[var(--tk-muted)]">
                            Из ГПР · {need.stageName} · нужно {formatNumber(need.quantity)} {need.unit} · к {formatDate(need.needBy)}
                          </p>
                        </div>
                        {canViewProcurement ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={supplySavingId === need.key}
                            onClick={() => void createSupplyFromGpr(need)}
                          >
                            {supplySavingId === need.key ? "Добавляем…" : "Создать потребность"}
                          </Button>
                        ) : <span className="text-xs text-[var(--tk-muted)]">Нужно создать потребность в закупках</span>}
                      </div>
                    ))}
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
                            {overdue ? <p className="mt-1 text-xs font-medium text-rose-700">Поставка просрочена · требовалась к {formatDate(supply.needBy)}</p> : null}
                          </div>
                          <label className="text-xs text-[var(--tk-muted)]">
                            Получено ({supply.unit})
                            <Input
                              key={`qty-delivered-${supply.id}:${supply.qtyDelivered}`}
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
                    </div>
                    <Link
                      href={`/cabinet/zakupki/${procurement!.id}?tab=money`}
                      className="text-sm text-[var(--tk-copper-deep)] underline underline-offset-2"
                    >
                      Платежи и условия →
                    </Link>
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-3">
                    {([
                      ["Авансы", "avans"],
                      ["Поступления", "postuplenie"],
                      ["Списания", "spisanie"],
                      ["Ключевые", "klyuchevoy"],
                    ] as const).map(([label, type]) => (
                      <div key={type} className="rounded-lg bg-stone-50 px-3 py-2 text-sm">
                        <span className="text-[var(--tk-muted)]">{label}</span>
                        <span className="ml-2 font-semibold">
                          {formatMoney(moneyPlan.payments
                            .filter((payment) => paymentBucket(payment) === type)
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
                    const split = splitEmbeddedUnit(newWorkName, newWorkUnit);
                    const name = split.workName;
                    if (plan.entries.some((entry) => entry.workName.toLocaleLowerCase("ru-RU") === name.toLocaleLowerCase("ru-RU"))) {
                      toast.error("Такой вид работ уже есть в плане");
                      return;
                    }
                    const volume = Number(newWorkPlan);
                    updatePlanFact(plan.id, { entries: [...plan.entries, { id: `pfe-manual-${crypto.randomUUID()}`, workName: name, unit: split.unit, plan: volume, fact: 0, contractRemaining: volume }] });
                    setWorkName(name);
                    setNewWorkName(""); setNewWorkUnit(""); setNewWorkPlan("");
                    toast.success("Вид работ добавлен в план договора");
                  }}>Добавить работу</Button>
                </div>
                <section className="mb-4 rounded-lg border border-primary/20 bg-primary/[0.04] p-3" aria-label="План ГПР на выбранный день" data-testid="daily-gpr-plan">
                  <h4 className="font-medium">Работы на выбранную дату · {formatDate(date)}</h4>
                  <p className="sr-only">В графике на эту дату: {planWorksOnDate(gpr?.stages ?? [], date).map((stage) => `${stage.name} ${stage.planUnit ?? ""}`).join(", ") || "нет"}</p>
                  {dailyGprPlanRows.length ? (
                    <ul className="mt-2 space-y-1 text-sm">
                      {dailyGprPlanRows.map(({ entry, plan: planned }) => (
                        <li key={entry.id} className="flex flex-wrap justify-between gap-x-4">
                          <span>{entry.workName}</span>
                          <span className="font-semibold tabular-nums">{formatNumber(planned)} {entry.unit}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-sm text-muted-foreground">На выбранный день в ГПР работы не запланированы. Выберите дату внутри этапа или проверьте календарь ГПР.</p>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">Внесите выполненный объём ниже по каждому виду работ — отклонение от плана обновится автоматически.</p>
                </section>
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
                    onChange={(event) => {
                      setPhotoFile(event.target.files?.[0] ?? null);
                      setFactError(null);
                    }}
                  />
                  {photoFile ? (
                    <span className="pb-2 text-xs text-[var(--tk-muted)]" data-testid="daily-fact-photo-name">
                      {photoFile.name}
                    </span>
                  ) : null}
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
                {factError ? (
                  <Alert className="mt-3 border-rose-200 bg-rose-50 text-rose-950" data-testid="daily-fact-error">
                    <AlertTitle>Сохранение факта</AlertTitle>
                    <AlertDescription>{factError}</AlertDescription>
                  </Alert>
                ) : null}
              </div>

              <ProductionPlanFactChart
                workName={selectedWork}
                unit={selectedUnit}
                points={chartPoints}
                hasSchedule={selectedWorkStages.length > 0}
              />

              <div className="mt-5 overflow-x-auto rounded-xl border bg-white/80">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Вид работ</TableHead>
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
                      const dayQ = qtyForWork(e.workName, e.unit, dayFacts);
                      const monthQ = qtyForWork(e.workName, e.unit, monthFacts);
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
                        ? qtyForWork(e.workName, e.unit, dayFacts)
                        : period === "month"
                          ? qtyForWork(e.workName, e.unit, monthFacts)
                          : period === "period"
                            ? qtyForWork(e.workName, e.unit, daily)
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
                                <button
                                  key={ph.id}
                                  type="button"
                                  onClick={() => {
                                    setPhotoPreviewFailed(false);
                                    setPhotoPreview({ photo: ph, date: d.date, workName: d.workName });
                                  }}
                                  className="group flex max-w-64 items-center gap-2 rounded-lg border bg-white p-2 text-left text-xs hover:border-primary/50 hover:bg-muted/40"
                                  data-testid={`photo-${ph.id}`}
                                  title={`${d.date} · ${d.workName}`}
                                >
                                  {/\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(ph.fileName) && ph.storedPath ? (
                                    <Image
                                      src={`/api/proizvodstvo/photo?id=${ph.id}&disposition=inline`}
                                      alt={ph.caption || ph.fileName}
                                      width={320}
                                      height={224}
                                      unoptimized
                                      className="h-14 w-20 shrink-0 rounded object-cover"
                                      loading="lazy"
                                    />
                                  ) : (
                                    <span className="grid h-14 w-20 shrink-0 place-items-center rounded bg-muted text-lg" aria-hidden="true">
                                      {ph.fileName.toLowerCase().endsWith(".pdf") ? "PDF" : "Фото"}
                                    </span>
                                  )}
                                  <span className="min-w-0">
                                    <span className="block truncate font-medium">{ph.caption || ph.fileName}</span>
                                    <span className="mt-1 block text-muted-foreground">{ph.storedPath ? "Открыть просмотр" : "Файл недоступен"}</span>
                                  </span>
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </li>
                      ))
                  )}
                </ul>
              </div>

              <Dialog open={Boolean(photoPreview)} onOpenChange={(open) => { if (!open) setPhotoPreview(null); }}>
                <DialogContent className="max-w-5xl p-0" showCloseButton>
                  {photoPreview ? (
                    <>
                      <div className="border-b px-5 py-4 pr-12">
                        <DialogTitle>{photoPreview.photo.caption || photoPreview.photo.fileName}</DialogTitle>
                        <DialogDescription className="mt-1">{formatDate(photoPreview.date)} · {photoPreview.workName}</DialogDescription>
                      </div>
                      <div className="grid min-h-56 place-items-center bg-stone-950/5 p-4">
                        {/\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(photoPreview.photo.fileName) && !photoPreviewFailed ? (
                          <Image
                            src={`/api/proizvodstvo/photo?id=${photoPreview.photo.id}&disposition=inline`}
                            alt={photoPreview.photo.caption || photoPreview.photo.fileName}
                            width={1600}
                            height={1200}
                            unoptimized
                            className="max-h-[72vh] max-w-full rounded-lg object-contain"
                            onError={() => setPhotoPreviewFailed(true)}
                          />
                        ) : photoPreview.photo.fileName.toLowerCase().endsWith(".pdf") ? (
                          <iframe
                            title={photoPreview.photo.fileName}
                            src={`/api/proizvodstvo/photo?id=${photoPreview.photo.id}&disposition=inline`}
                            className="h-[72vh] w-full rounded-lg bg-white"
                          />
                        ) : (
                          <div className="text-center text-sm text-muted-foreground">
                            <p>{photoPreviewFailed ? "Не удалось загрузить изображение." : "Предпросмотр этого формата недоступен в браузере."}</p>
                            <a className="mt-2 inline-block underline underline-offset-2" href={`/api/proizvodstvo/photo?id=${photoPreview.photo.id}&disposition=attachment`}>Скачать файл</a>
                          </div>
                        )}
                      </div>
                    </>
                  ) : null}
                </DialogContent>
              </Dialog>

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
