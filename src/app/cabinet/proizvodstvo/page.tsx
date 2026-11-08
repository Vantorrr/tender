"use client";

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
import { api, downloadUrl } from "@/lib/api";
import { formatMoney, formatNumber } from "@/lib/format";
import { useStore } from "@/lib/store";

export default function ProizvodstvoPage() {
  const { data, user, updatePlanFact, refresh, orgProcurements } = useStore();
  const [pfId, setPfId] = useState("");
  const [workName, setWorkName] = useState("Общий объём");
  const [qty, setQty] = useState("1");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
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

  if (!user) return null;

  const totals = plan
    ? plan.entries.reduce(
        (acc, e) => {
          acc.plan += e.plan;
          acc.fact += e.fact;
          return acc;
        },
        { plan: 0, fact: 0 }
      )
    : { plan: 0, fact: 0 };

  async function submitDaily(withPhoto: boolean) {
    if (!plan) return;
    try {
      if (withPhoto && photoRef.current?.files?.[0]) {
        const form = new FormData();
        form.append("planFactId", plan.id);
        form.append("date", date);
        form.append("workName", workName);
        form.append("unit", "ед");
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
              date,
              workName,
              unit: "ед",
              quantity: Number(qty) || 0,
            },
          }),
        });
      }
      await refresh();
      toast.success("Дневной факт сохранён (не платёж)");
      if (photoRef.current) photoRef.current.value = "";
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Ошибка факта");
    }
  }

  return (
    <div>
      <PageHeader
        title="Производство · план/факт"
        description="День / месяц / период. Фото и ручной факт. PnL отделён от кассы. Базовый план сохраняется при переводе won→production."
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
        Физический факт ≠ платёж. earnedValue / incurredCosts ≠ cashIn / cashOut.
        recognizedRevenue = «нет данных», пока не подтверждено.
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        {orgProcurements
          .filter((p) => p.lifecycle !== "production")
          .slice(0, 6)
          .map((p) => (
            <Button
              key={p.id}
              size="sm"
              variant="outline"
              data-testid={`win-to-prod-${p.id}`}
              onClick={async () => {
                try {
                  await api("/api/zakupki", {
                    method: "POST",
                    body: JSON.stringify({
                      action: "transferToProduction",
                      id: p.id,
                    }),
                  });
                  await refresh();
                  toast.success("В производство без дубля проекта");
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Ошибка");
                }
              }}
            >
              Выигран → производство: {p.number}
            </Button>
          ))}
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
                  <SelectValue>
                    {plan?.title ?? "План/факт"}
                  </SelectValue>
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
                Проект {procurement.number} · lifecycle{" "}
                {procurement.lifecycle ?? "—"}
                {plan?.baselineAt
                  ? ` · baseline ${plan.baselineAt.slice(0, 10)}`
                  : ""}
              </p>
            ) : null}
          </div>

          {plan ? (
            <>
              <div className="mb-4 grid gap-3 sm:grid-cols-4">
                <div className="rounded-xl border bg-white/80 p-3 text-sm">
                  План: {formatNumber(totals.plan)}
                </div>
                <div className="rounded-xl border bg-white/80 p-3 text-sm">
                  Факт: {formatNumber(totals.fact)}
                </div>
                <div className="rounded-xl border bg-white/80 p-3 text-sm">
                  earnedValue: {formatNumber(plan.pnl?.earnedValue ?? 0)}
                </div>
                <div className="rounded-xl border bg-white/80 p-3 text-sm">
                  cashIn: {formatMoney(plan.pnl?.cashIn ?? 0)} / cashOut:{" "}
                  {formatMoney(plan.pnl?.cashOut ?? 0)}
                </div>
              </div>

              <div className="mb-6 rounded-xl border bg-white/80 p-4">
                <h3 className="mb-3 font-medium">Дневной факт + фото</h3>
                <div className="flex flex-wrap items-end gap-2">
                  <Input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                  <Input
                    value={workName}
                    onChange={(e) => setWorkName(e.target.value)}
                    placeholder="Вид работ"
                  />
                  <Input
                    value={qty}
                    onChange={(e) => setQty(e.target.value)}
                    className="w-24"
                  />
                  <input
                    ref={photoRef}
                    type="file"
                    accept="image/*,.pdf"
                    className="text-sm"
                  />
                  <Button
                    data-testid="daily-fact-save"
                    onClick={() => submitDaily(false)}
                  >
                    Сохранить факт
                  </Button>
                  <Button
                    variant="outline"
                    data-testid="daily-fact-photo"
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
                      <TableHead className="text-right">Остаток</TableHead>
                      <TableHead className="text-right">Baseline</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {plan.entries.map((e) => {
                      const base = plan.baselineEntries?.find(
                        (b) => b.id === e.id || b.workName === e.workName
                      );
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
                                    x.id === e.id ? { ...x, plan: v } : x
                                  ),
                                });
                              }}
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            {formatNumber(e.fact)}
                          </TableCell>
                          <TableCell className="text-right">
                            {formatNumber(
                              e.contractRemaining ?? Math.max(0, e.plan - e.fact)
                            )}
                          </TableCell>
                          <TableCell className="text-right text-[var(--tk-muted)]">
                            {base ? formatNumber(base.plan) : "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              <div className="mt-6">
                <h3 className="mb-2 font-medium">Дневные записи</h3>
                <ul className="space-y-2 text-sm">
                  {(plan.dailyFacts ?? []).length === 0 ? (
                    <li className="text-[var(--tk-muted)]">Пока нет фактов</li>
                  ) : (
                    (plan.dailyFacts ?? [])
                      .slice()
                      .reverse()
                      .map((d) => (
                        <li
                          key={d.id}
                          className="rounded-lg border px-3 py-2"
                          data-testid={`daily-${d.id}`}
                        >
                          {d.date} · {d.workName}: {d.quantity} {d.unit}
                          {d.photos?.length
                            ? ` · фото ${d.photos.map((p) => p.fileName).join(", ")}`
                            : ""}
                          {d.comment ? ` · ${d.comment}` : ""}
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
