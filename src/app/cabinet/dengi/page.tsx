"use client";

import { useMemo, useState } from "react";
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
import { downloadUrl } from "@/lib/api";
import { formatDate, formatMoney } from "@/lib/format";
import { PERIOD_LABELS } from "@/lib/roles";
import { useStore } from "@/lib/store";

const typeLabel = {
  avans: "Аванс",
  postuplenie: "Поступление",
  klyuchevoy: "Ключевой платёж",
};

export default function DengiPage() {
  const { data, user, updateMoney } = useStore();
  const [planId, setPlanId] = useState<string>("");
  const [period, setPeriod] = useState<"all" | "week" | "month">("all");

  const plans = useMemo(
    () => (user ? data.moneyPlans.filter((m) => m.orgId === user.orgId) : []),
    [data.moneyPlans, user]
  );

  const activeId = planId || plans[0]?.id || "";
  const plan = plans.find((p) => p.id === activeId);

  const payments = useMemo(() => {
    if (!plan) return [];
    if (period === "all") return plan.payments;
    if (period === "week") {
      const now = new Date();
      const currentWeek = Math.max(
        1,
        Math.ceil(
          (now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) /
            604800000
        )
      );
      const currentMonth = now.getMonth() + 1;
      return plan.payments.filter(
        (p) =>
          Math.abs(p.week - currentWeek) <= 6 ||
          Math.abs(p.month - currentMonth) <= 1
      );
    }
    return plan.payments.filter((p) => p.month === 12 || p.month <= 6);
  }, [plan, period]);

  const summary = payments.reduce(
    (acc, p) => {
      acc.total += p.amount;
      acc[p.type] += p.amount;
      return acc;
    },
    { total: 0, avans: 0, postuplenie: 0, klyuchevoy: 0 }
  );

  if (!user) return null;

  return (
    <div>
      <PageHeader
        title="Деньги"
        description="Убрано из сайдбара — денежный план в карточке проекта. Авансы/поступления; PnL производства — этап 3."
        actions={
          plan ? (
            <Button
              data-testid="money-export"
              onClick={() => {
                downloadUrl(`/api/export?kind=money-xlsx&id=${plan.id}`);
                toast.success("Скачивание XLSX…");
              }}
            >
              Экспорт Excel
            </Button>
          ) : null
        }
      />

      {plans.length === 0 ? (
        <EmptyState
          title="Денежных планов нет"
          description="План появится после решения об участии и формирования расчёта."
        />
      ) : (
        <>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <Select value={activeId} onValueChange={(v) => setPlanId(v ?? "")}>
              <SelectTrigger className="w-full sm:w-[280px]">
                <SelectValue placeholder="План">
                  {(value) =>
                    plans.find((p) => p.id === value)?.title ?? "План"
                  }
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
            <Select
              value={period}
              onValueChange={(v) =>
                setPeriod((v as "all" | "week" | "month") ?? "all")
              }
            >
              <SelectTrigger className="w-full sm:w-[180px]">
                <SelectValue>
                  {(value) =>
                    PERIOD_LABELS[value as keyof typeof PERIOD_LABELS] ??
                    "Период"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Весь период</SelectItem>
                <SelectItem value="week">По неделям</SelectItem>
                <SelectItem value="month">По месяцам</SelectItem>
              </SelectContent>
            </Select>
            {plan ? <StatusBadge status={plan.status} /> : null}
          </div>

          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Всего", summary.total],
              ["Авансы", summary.avans],
              ["Ключевые", summary.klyuchevoy],
              ["Поступления", summary.postuplenie],
            ].map(([label, value]) => (
              <div
                key={label as string}
                className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4"
              >
                <div className="text-xs text-[var(--tk-muted)]">{label}</div>
                <div className="mt-1 font-[family-name:var(--font-display)] text-xl">
                  {formatMoney(value as number)}
                </div>
              </div>
            ))}
          </div>

          {plan ? (
            <div className="overflow-x-auto rounded-xl border border-[var(--tk-line)] bg-white/80">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Тип</TableHead>
                    <TableHead>Название</TableHead>
                    <TableHead>Дата</TableHead>
                    <TableHead className="text-right">Сумма</TableHead>
                    <TableHead>Комментарий</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>{typeLabel[p.type]}</TableCell>
                      <TableCell>
                        <Input
                          value={p.title}
                          onChange={(e) => {
                            updateMoney(plan.id, {
                              payments: plan.payments.map((x) =>
                                x.id === p.id
                                  ? { ...x, title: e.target.value }
                                  : x
                              ),
                            });
                          }}
                        />
                      </TableCell>
                      <TableCell>{formatDate(p.date)}</TableCell>
                      <TableCell className="text-right font-medium">
                        {formatMoney(p.amount)}
                      </TableCell>
                      <TableCell className="text-sm text-[var(--tk-muted)]">
                        {p.note ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
