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
import { allocatePlanForSlice } from "@/lib/plan-from-gpr";
import { useStore } from "@/lib/store";

type PeriodMode = "day" | "month" | "period" | "cum";

function createDailyFactId() {
  return `df-${crypto.randomUUID()}`;
}

export default function ProizvodstvoPage() {
  const { data, user, updatePlanFact, refresh, orgProcurements } = useStore();
  const [pfId, setPfId] = useState("");
  const [period, setPeriod] = useState<PeriodMode>("cum");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [qty, setQty] = useState("1");
  const [savingDaily, setSavingDaily] = useState(false);
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
  const activeId = pfId || plans[0]?.id || "";
  const plan = plans.find((p) => p.id === activeId);
  const object = objects.find((o) => o.id === plan?.objectId);
  const procurement = orgProcurements.find((p) => p.id === plan?.procurementId);
  const canViewMoney = user ? userHasSection(user, "dengi") : false;
  const moneyPlan = procurement?.moneyId
    ? data.moneyPlans.find((m) => m.id === procurement.moneyId && m.orgId === user?.orgId)
    : undefined;
  const gpr = data.schedules.find(
    (s) => s.id === procurement?.gprId && s.orgId === user?.orgId
  );

  const workOptions = plan?.entries.map((e) => e.workName) ?? [];
  const [workName, setWorkName] = useState("");
  const selectedWork =
    workName || workOptions[0] || "Общий объём";
  const selectedEntry = plan?.entries.find((e) => e.workName === selectedWork);
  const selectedUnit = selectedEntry?.unit ?? "%";

  if (!user) return null;

  const daily = plan?.dailyFacts ?? [];
  const dayFacts = daily.filter((d) => d.date === date);
  const monthKey = date.slice(0, 7);
  const monthFacts = daily.filter((d) => d.date.startsWith(monthKey));

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
  const planSlice = allocatePlanForSlice(
    totals.plan,
    gprStages,
    period,
    date
  );
  const periodPlan = planSlice.plan;
  const sliceVariance = periodFact - periodPlan;

  async function submitDaily(withPhoto: boolean) {
    if (!plan || savingDailyRef.current) return;
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
                <div className="rounded-xl border bg-white/80 p-3 text-sm">
                  План договора (всего): {formatNumber(totals.plan)}
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
                  из ГПР): {formatNumber(periodPlan)}
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
                  ): {formatNumber(periodFact)}
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
                    {formatNumber(sliceVariance)}
                  </span>
                </div>
                <div className="rounded-xl border bg-white/80 p-3 text-sm">
                  Остаток договора: {formatNumber(totals.remain)}
                </div>
                <div className="rounded-xl border bg-white/80 p-3 text-sm">
                  Индекс физ. объёма (не ₽):{" "}
                  {formatNumber(plan.pnl?.earnedValue ?? 0)}
                </div>
                <div className="rounded-xl border bg-white/80 p-3 text-sm">
                  Экономика авто (объём×ставки):{" "}
                  {plan.pnl?.economicsAuto == null
                    ? "нет данных"
                    : formatNumber(plan.pnl.economicsAuto)}
                  {(plan.pnl?.incomplete?.length ?? 0) > 0 ? (
                    <span className="mt-1 block text-[11px] text-amber-800">
                      не хватает: {(plan.pnl?.incomplete ?? []).slice(0, 4).join(", ")}
                    </span>
                  ) : null}
                </div>
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
                    disabled={savingDaily}
                    onClick={() => submitDaily(false)}
                  >
                    {savingDaily ? "Сохранение…" : "Сохранить факт"}
                  </Button>
                  <Button
                    variant="outline"
                    data-testid="daily-fact-photo"
                    disabled={savingDaily}
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
                      <TableHead className="text-right">
                        Базовый план
                      </TableHead>
                      <TableHead className="text-right">Отклонение</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {plan.entries.map((e) => {
                      const base = plan.baselineEntries?.find(
                        (b) => b.id === e.id || b.workName === e.workName
                      );
                      const dayQ = qtyForWork(e.workName, dayFacts);
                      const monthQ = qtyForWork(e.workName, monthFacts);
                      const fact = entryDisplayFact(e, daily);
                      const remain = entryDisplayRemain(e, daily);
                      // Table variance vs baseline contract plan (not slice)
                      const variance = fact - (base?.plan ?? e.plan);
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
                            {base ? formatNumber(base.plan) : "—"}
                          </TableCell>
                          <TableCell
                            className={`text-right ${
                              variance < 0
                                ? "text-rose-700"
                                : variance > 0
                                  ? "text-emerald-700"
                                  : ""
                            }`}
                            title="Факт минус базовый план (доказательно по числам таблицы, без выдуманных причин)"
                          >
                            {formatNumber(variance)}
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
