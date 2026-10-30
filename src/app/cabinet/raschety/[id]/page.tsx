"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { ErrorState } from "@/components/empty-state";
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
    addCalcFromDirectory,
  } = useStore();
  const [dirType, setDirType] = useState<"rascenki" | "ceny" | "park">(
    "rascenki"
  );
  const [code, setCode] = useState("");
  const [qty, setQty] = useState("1");
  const [rateKey, setRateKey] = useState<string>("price");
  const [filter, setFilter] = useState("");

  const calc = user
    ? data.calculations.find(
        (c) => c.id === params.id && c.orgId === user.orgId
      )
    : undefined;
  const dir = calc
    ? data.directories.find((d) => d.id === calc.directoryVersionId)
    : undefined;
  const currentDir = data.directories.find(
    (d) => d.type === dirType && d.current
  );
  const pickerRows = useMemo(() => {
    const rows = currentDir?.rows ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return rows.slice(0, 40);
    return rows
      .filter((r) =>
        [r.code, r.sku, r.name, r.work, r.category]
          .filter(Boolean)
          .some((x) => String(x).toLowerCase().includes(q))
      )
      .slice(0, 40);
  }, [currentDir, filter]);

  if (!user) return null;
  if (!calc) {
    return <ErrorState title="Расчёт не найден" />;
  }

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

  async function addSelected(rowCode: string) {
    try {
      await addCalcFromDirectory(calc!.id, {
        type: dirType,
        code: rowCode,
        quantity: Number(qty) || 1,
        rateKey:
          dirType === "ceny" && rateKey !== "price" ? rateKey : undefined,
      });
      setCode(rowCode);
      toast.success(`Добавлено: ${rowCode}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось добавить");
    }
  }

  return (
    <div>
      <PageHeader
        title={calc.title}
        description={`Справочник: ${dir?.name ?? "—"} v${dir?.version ?? "?"} · закупка ${calc.procurementId}`}
        actions={
          <>
            <StatusBadge status={calc.status} />
            <Button
              variant="secondary"
              onClick={async () => {
                await recalcCalculation(calc.id, calc.scenario);
                toast.success("Ставки обновлены из текущих справочников");
              }}
            >
              Обновить из справочников
            </Button>
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
          Добавить из справочника
        </h2>
        <p className="mt-1 text-sm text-[var(--tk-muted)]">
          Текущая версия: {currentDir?.name ?? "—"} · строк{" "}
          {currentDir?.rows.length ?? 0}
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <p className="mb-1 text-xs text-[var(--tk-muted)]">Тип</p>
            <Select
              value={dirType}
              onValueChange={(v) => {
                if (!v) return;
                setDirType(v as "rascenki" | "ceny" | "park");
                setCode("");
              }}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="rascenki">Нормо-час</SelectItem>
                <SelectItem value="ceny">Тарифы АТС/ДСМ</SelectItem>
                <SelectItem value="park">Парк техники</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {dirType === "ceny" ? (
            <div>
              <p className="mb-1 text-xs text-[var(--tk-muted)]">Колонка ставки</p>
              <Select value={rateKey} onValueChange={(v) => v && setRateKey(v)}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="price">1 смена КПИ 0,85</SelectItem>
                  <SelectItem value="rate_2s_kpi085">2 смены КПИ 0,85</SelectItem>
                  <SelectItem value="rate_1s_kpi10">1 смена КПИ 1,0</SelectItem>
                  <SelectItem value="rate_2s_kpi10">2 смены КПИ 1,0</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div>
            <p className="mb-1 text-xs text-[var(--tk-muted)]">Кол-во</p>
            <Input
              className="w-[100px]"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </div>
          <div className="min-w-[220px] flex-1">
            <p className="mb-1 text-xs text-[var(--tk-muted)]">Поиск</p>
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="JCB, дорожный, ПАЗ…"
            />
          </div>
          <Button
            disabled={!code}
            onClick={() => code && addSelected(code)}
          >
            Добавить код {code || "…"}
          </Button>
        </div>
        <div className="mt-4 max-h-64 overflow-auto rounded-lg border border-[var(--tk-line)]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Код</TableHead>
                <TableHead>Наименование</TableHead>
                <TableHead className="text-right">Ставка</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {pickerRows.map((r) => {
                const rowCode = String(r.code ?? r.sku ?? "");
                const label = String(r.name ?? r.work ?? "");
                const rate =
                  dirType === "ceny"
                    ? Number(r[rateKey] ?? r.price ?? 0)
                    : Number(r.rate ?? r.price ?? 0);
                return (
                  <TableRow
                    key={rowCode + label}
                    className={code === rowCode ? "bg-[var(--tk-steel)]/5" : undefined}
                  >
                    <TableCell className="font-mono text-xs">{rowCode}</TableCell>
                    <TableCell>
                      <div>{label}</div>
                      {r.category ? (
                        <div className="text-xs text-[var(--tk-muted)]">
                          {String(r.category)}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatMoney(rate)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => addSelected(rowCode)}
                      >
                        В расчёт
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </section>

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
