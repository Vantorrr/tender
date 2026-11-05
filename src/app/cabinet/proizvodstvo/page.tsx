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
import { formatNumber } from "@/lib/format";
import { useStore } from "@/lib/store";

export default function ProizvodstvoPage() {
  const { data, user, updatePlanFact } = useStore();
  const [pfId, setPfId] = useState("");

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

  return (
    <div>
      <PageHeader
        title="Производство · план/факт"
        description="Объекты, план работ, ввод факта, отклонения и сводки."
        actions={
          plan ? (
            <Button
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
          description="Создайте карточку производства по объекту."
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Select value={activeId} onValueChange={(v) => setPfId(v ?? "")}>
              <SelectTrigger className="w-[300px]">
                <SelectValue>
                  {(value) =>
                    plans.find((p) => p.id === value)?.title ?? "План/факт"
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
            {plan ? <StatusBadge status={plan.status} /> : null}
            {object ? (
              <span className="text-sm text-[var(--tk-muted)]">
                Объект: {object.name}
              </span>
            ) : null}
          </div>

          {plan ? (
            <>
              <div className="mb-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4">
                  <div className="text-xs text-[var(--tk-muted)]">План (сумма ед.)</div>
                  <div className="font-[family-name:var(--font-display)] text-xl">
                    {formatNumber(totals.plan, 0)}
                  </div>
                </div>
                <div className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4">
                  <div className="text-xs text-[var(--tk-muted)]">Факт</div>
                  <div className="font-[family-name:var(--font-display)] text-xl">
                    {formatNumber(totals.fact, 0)}
                  </div>
                </div>
                <div className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4">
                  <div className="text-xs text-[var(--tk-muted)]">Отклонение</div>
                  <div className="font-[family-name:var(--font-display)] text-xl">
                    {formatNumber(totals.fact - totals.plan, 0)}
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-[var(--tk-line)] bg-white/80">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Работа</TableHead>
                      <TableHead>Ед.</TableHead>
                      <TableHead className="text-right">План</TableHead>
                      <TableHead className="text-right">Факт</TableHead>
                      <TableHead className="text-right">Отклонение</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {plan.entries.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell>{e.workName}</TableCell>
                        <TableCell>{e.unit}</TableCell>
                        <TableCell className="text-right">
                          {formatNumber(e.plan)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            className="ml-auto w-28 text-right"
                            type="number"
                            value={e.fact}
                            onChange={(ev) => {
                              const fact = Number(ev.target.value);
                              updatePlanFact(plan.id, {
                                entries: plan.entries.map((x) =>
                                  x.id === e.id ? { ...x, fact } : x
                                ),
                              });
                            }}
                          />
                        </TableCell>
                        <TableCell
                          className={`text-right font-medium ${
                            e.fact - e.plan < 0
                              ? "text-rose-700"
                              : e.fact - e.plan > 0
                                ? "text-emerald-700"
                                : ""
                          }`}
                        >
                          {formatNumber(e.fact - e.plan)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
