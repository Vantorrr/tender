"use client";

import { useParams } from "next/navigation";
import { toast } from "sonner";
import { ErrorState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
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
import { formatMoney, formatNumber } from "@/lib/format";
import type { Calculation } from "@/lib/types";
import { useStore } from "@/lib/store";

export default function RaschetDetailPage() {
  const params = useParams<{ id: string }>();
  const {
    data,
    user,
    updateCalculation,
    recalcCalculation,
  } = useStore();
  if (!user) return null;

  const calc = data.calculations.find(
    (c) => c.id === params.id && c.orgId === user.orgId
  );
  if (!calc) {
    return <ErrorState title="Расчёт не найден" />;
  }

  const dir = data.directories.find((d) => d.id === calc.directoryVersionId);
  const base = calc.positions.reduce((s, p) => s + p.quantity * p.rate, 0);
  const total = base * calc.scenarioFactor;

  function exportExcelLike() {
    downloadUrl(`/api/export?kind=calc-xlsx&id=${calc!.id}`);
    toast.success("Скачивание XLSX…");
  }

  function exportPdfLike() {
    downloadUrl(`/api/export?kind=calc-pdf&id=${calc!.id}`);
    toast.success("Скачивание PDF…");
  }

  return (
    <div>
      <PageHeader
        title={calc.title}
        description={`Справочник: ${dir?.name ?? "—"} v${dir?.version ?? "?"} · закупка ${calc.procurementId}`}
        actions={
          <>
            <StatusBadge status={calc.status} />
            <Button variant="outline" onClick={exportExcelLike}>
              Excel
            </Button>
            <Button variant="outline" onClick={exportPdfLike}>
              PDF
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <p className="mb-1 text-xs text-[var(--tk-muted)]">Сценарий</p>
          <Select
            value={calc.scenario}
            onValueChange={(v) => {
              if (!v) return;
              recalcCalculation(calc.id, v as Calculation["scenario"]);
              toast.success("Пересчёт выполнен");
            }}
          >
            <SelectTrigger className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bazovyy">Базовый</SelectItem>
              <SelectItem value="optimisticheskiy">Оптимистичный ×0,95</SelectItem>
              <SelectItem value="pessimisticheskiy">
                Пессимистичный ×1,08
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <p className="mb-1 text-xs text-[var(--tk-muted)]">Участие</p>
          <Select
            value={calc.participateDecision ?? "none"}
            onValueChange={(v) => {
              if (!v) return;
              updateCalculation(calc.id, {
                participateDecision:
                  v === "none"
                    ? null
                    : (v as Calculation["participateDecision"]),
              });
              toast.success("Решение сохранено");
            }}
          >
            <SelectTrigger className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Не принято</SelectItem>
              <SelectItem value="uchastvovat">Участвовать</SelectItem>
              <SelectItem value="otkaz">Отказ</SelectItem>
              <SelectItem value="na_rassmotrenii">На рассмотрении</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="rounded-xl border border-[var(--tk-line)] bg-white px-4 py-2">
          <div className="text-xs text-[var(--tk-muted)]">Итого с коэффициентом</div>
          <div className="font-[family-name:var(--font-display)] text-xl">
            {formatMoney(total)}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-[var(--tk-line)] bg-white/80">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Код</TableHead>
              <TableHead>Наименование</TableHead>
              <TableHead>Ед.</TableHead>
              <TableHead className="text-right">Кол-во</TableHead>
              <TableHead className="text-right">Расценка</TableHead>
              <TableHead className="text-right">Сумма</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {calc.positions.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-mono text-xs">{p.code}</TableCell>
                <TableCell>{p.name}</TableCell>
                <TableCell>{p.unit}</TableCell>
                <TableCell className="text-right">
                  {formatNumber(p.quantity)}
                </TableCell>
                <TableCell className="text-right">
                  {formatMoney(p.rate)}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {formatMoney(p.quantity * p.rate * calc.scenarioFactor)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <section className="mt-6 rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
        <h2 className="font-[family-name:var(--font-display)] text-base">
          Допущения
        </h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-[var(--tk-ink-soft)]">
          {calc.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
