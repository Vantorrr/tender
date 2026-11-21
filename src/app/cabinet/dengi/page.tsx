"use client";

import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { parseDecimalRu } from "@/lib/decimal-ru";
import { formatMoney } from "@/lib/format";
import { PAYMENT_AMOUNT_ERROR, PAYMENT_BUCKET_LABELS, paymentBucket, paymentTotals, type PaymentBucket } from "@/lib/money-payments";
import { PERIOD_LABELS } from "@/lib/roles";
import { useStore } from "@/lib/store";
import { DateInputRu } from "@/components/date-input-ru";

export default function DengiPage() {
  const { data, user, updateMoney, refresh } = useStore();
  const [planId, setPlanId] = useState<string>("");
  const [period, setPeriod] = useState<"all" | "week" | "month">("all");
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);
  const [payTitle, setPayTitle] = useState("");
  const [payType, setPayType] = useState<PaymentBucket>("postuplenie");
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [paySaving, setPaySaving] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const paySavingRef = useRef(false);

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

  const summary = paymentTotals(payments);

  function patchPayment(paymentId: string, patch: Partial<(typeof payments)[number]>) {
    if (!plan) return;
    updateMoney(plan.id, {
      payments: plan.payments.map((payment) => {
        if (payment.id !== paymentId) return payment;
        const next = { ...payment, ...patch };
        if (patch.date) {
          const date = new Date(`${patch.date}T00:00:00`);
          if (Number.isFinite(date.getTime())) {
            const start = new Date(date.getFullYear(), 0, 1);
            next.week = Math.max(1, Math.ceil((date.getTime() - start.getTime()) / 604800000));
            next.month = date.getMonth() + 1;
          }
        }
        return next;
      }),
    });
  }

  async function removePayment(paymentId: string) {
    if (!plan) return;
    await api("/api/dengi", {
      method: "POST",
      body: JSON.stringify({ action: "deletePayment", moneyId: plan.id, paymentId }),
    });
    await refresh();
  }

  async function addPayment() {
    if (!plan || paySavingRef.current) return;
    const amount = parseDecimalRu(payAmount);
    if (amount == null || amount <= 0) {
      setPayError(PAYMENT_AMOUNT_ERROR);
      return;
    }
    setPayError(null);
    paySavingRef.current = true;
    setPaySaving(true);
    try {
      const result = await api<{ paymentId?: string; created?: boolean }>("/api/dengi", {
        method: "POST",
        body: JSON.stringify({
          action: "addPayment",
          moneyId: plan.id,
          payment: {
            type: payType,
            title: payTitle.trim() || "Платёж",
            amount,
            date: payDate,
            week: 1,
            month: Number(payDate.slice(5, 7)) || 1,
          },
        }),
      });
      await refresh();
      setPayTitle("");
      setPayAmount("");
      if (result.created === false) {
        toast.message("Такой платёж уже есть");
        return;
      }
      const paymentId = result.paymentId;
      toast.success("Платёж добавлен", {
        id: paymentId ? `payment-undo-${paymentId}` : undefined,
        duration: 10_000,
        action: paymentId
          ? {
              label: "Отменить",
              onClick: () => {
                void removePayment(paymentId)
                  .then(() => toast.success("Платёж отменён"))
                  .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Не удалось отменить"));
              },
            }
          : undefined,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось добавить платёж");
    } finally {
      paySavingRef.current = false;
      setPaySaving(false);
    }
  }

  if (!user) return null;

  return (
    <div>
      <PageHeader
        title="Деньги"
        description="Авансы, поступления и списания по проекту."
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
              ["Поступления", summary.postuplenie],
              ["Списания", summary.spisanie],
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
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>{PAYMENT_BUCKET_LABELS[paymentBucket(p)]}</TableCell>
                      <TableCell className="min-w-48">
                        <Input
                          aria-label={`Название платежа ${p.title}`}
                          value={p.title}
                          onChange={(e) => patchPayment(p.id, { title: e.target.value })}
                        />
                      </TableCell>
                      <TableCell className="min-w-40">
                        <DateInputRu
                          value={p.date}
                          onChange={(date) => patchPayment(p.id, { date })}
                        />
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        <Input
                          aria-label={`Сумма платежа ${p.title}`}
                          className="ml-auto w-36 text-right"
                          inputMode="decimal"
                          key={`${p.id}:${p.amount}`}
                          defaultValue={String(p.amount)}
                          onBlur={(e) => {
                            const amount = parseDecimalRu(e.target.value);
                            if (amount == null || amount <= 0) {
                              toast.error(PAYMENT_AMOUNT_ERROR);
                              e.target.value = String(p.amount);
                              return;
                            }
                            if (amount !== p.amount) patchPayment(p.id, { amount });
                          }}
                        />
                      </TableCell>
                      <TableCell className="min-w-56 text-sm text-[var(--tk-muted)]">
                        <Input
                          aria-label={`Комментарий платежа ${p.title}`}
                          value={p.note ?? ""}
                          placeholder="Комментарий"
                          onChange={(e) => patchPayment(p.id, { note: e.target.value })}
                        />
                      </TableCell>
                      <TableCell>
                        <Button size="sm" variant="ghost" onClick={() => setPendingDelete({ id: p.id, title: p.title })}>
                          Удалить
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
          {plan ? (
            <div className="mt-4 flex flex-wrap items-end gap-2">
              <Input aria-label="Название платежа" placeholder="Название, например 2 этап" value={payTitle} onChange={(event) => setPayTitle(event.target.value)} />
              <select
                aria-label="Тип платежа"
                className="h-9 rounded-lg border border-[var(--tk-line)] bg-white px-2 text-sm"
                value={payType}
                onChange={(event) => setPayType(event.target.value as PaymentBucket)}
              >
                <option value="avans">Аванс</option>
                <option value="postuplenie">Поступление</option>
                <option value="spisanie">Списание</option>
              </select>
              <Input className="w-32" aria-label="Сумма нового платежа" inputMode="decimal" value={payAmount} onChange={(event) => { setPayAmount(event.target.value); setPayError(null); }} />
              {payError ? <p className="w-full text-sm text-rose-700" role="alert">{payError}</p> : null}
              <DateInputRu value={payDate} onChange={setPayDate} className="w-[140px]" />
              <Button data-testid="dengi-add-payment" disabled={paySaving} onClick={() => void addPayment()}>
                {paySaving ? "Сохраняю…" : "Добавить платёж"}
              </Button>
            </div>
          ) : null}
          <Dialog open={pendingDelete != null} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Удалить платёж?</DialogTitle>
                <DialogDescription>Платёж «{pendingDelete?.title}» будет удалён из плана.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setPendingDelete(null)}>Отмена</Button>
                <Button onClick={() => {
                  const target = pendingDelete;
                  setPendingDelete(null);
                  if (!target) return;
                  void removePayment(target.id)
                    .then(() => toast.success("Платёж удалён"))
                    .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Не удалось удалить платёж"));
                }}>Удалить</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
