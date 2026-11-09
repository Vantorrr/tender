"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
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
import { api, downloadUrl } from "@/lib/api";
import { HierarchicalEstimatePanel } from "@/components/hierarchical-estimate-panel";
import { isT25uTestId, isT25uTestTitle } from "@/lib/t25u-test-fixture";
import { bucketsFromPositions } from "@/lib/cost-engine";
import { formatMoney, formatNumber } from "@/lib/format";
import type { Calculation } from "@/lib/types";
import type { EstimateLeaf } from "@/lib/hierarchical-estimate";
import type { ResourceScheduleParams } from "@/lib/resource-schedule-model";
import { useStore } from "@/lib/store";
import {
  calculationTotals,
  positionLineSum,
} from "@/lib/calc-math";
import { compareCalculations } from "@/lib/calc-compare";

export default function RaschetDetailPage() {
  const params = useParams<{ id: string }>();
  const {
    data,
    user,
    updateCalculation,
    patchScheduleResource,
    recalcCalculation,
    addCalcFromDirectory,
    refresh,
  } = useStore();
  const [dirType, setDirType] = useState<"rascenki" | "ceny" | "park">(
    "rascenki"
  );
  const [code, setCode] = useState("");
  const [qty, setQty] = useState("1");
  const [rateKey, setRateKey] = useState<string>("price");
  const [filter, setFilter] = useState("");
  const [showDirAdd, setShowDirAdd] = useState(false);

  const calc = user
    ? data.calculations.find(
        (c) => c.id === params.id && c.orgId === user.orgId
      )
    : undefined;
  const procurement = calc
    ? data.procurements.find(
        (item) => item.id === calc.procurementId && item.orgId === user?.orgId
      )
    : undefined;
  const projectDocuments = calc
    ? data.documents.filter((item) => item.procurementId === calc.procurementId)
    : [];
  const projectRisk = calc
    ? data.risks.find((item) => item.procurementId === calc.procurementId)
    : undefined;
  const projectMoney = calc
    ? data.moneyPlans.find((item) => item.procurementId === calc.procurementId)
    : undefined;
  const linkedSchedule = calc
    ? data.schedules.find(
        (item) =>
          item.procurementId === calc.procurementId &&
          item.calculationId === calc.id
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

  const locked = Boolean(calc.immutable || calc.kind === "customer_original");
  const paired = calc.pairedCalculationId
    ? data.calculations.find((c) => c.id === calc.pairedCalculationId)
    : data.calculations.find(
        (c) =>
          c.procurementId === calc.procurementId &&
          c.id !== calc.id &&
          (calc.kind === "resource_draft"
            ? c.kind === "customer_original"
            : c.kind === "resource_draft")
      );
  const compare =
    calc.kind === "resource_draft"
      ? compareCalculations(paired, calc)
      : compareCalculations(calc, paired);

  const totals = calculationTotals(calc);
  const originalTotals = paired ? calculationTotals(paired) : null;
  const draftSlices = calc.costSummary?.resourceSlices;
  /** Draft chip: unified Z when present; never pretend NR15/SP8 == resource Z. */
  const total =
    calc.kind === "resource_draft" && draftSlices
      ? draftSlices.total
      : calc.kind === "customer_original"
        ? totals.total
        : (calc.costSummary?.priceExVat ?? totals.total);
  const buckets = bucketsFromPositions(
    calc.positions,
    calc.scenarioFactor || 1
  );
  const materials = calc.positions.filter((p) => {
    if (p.code === "НР" || p.code === "СП") return false;
    const hay = `${p.code} ${p.name} ${p.unit}`.toLowerCase();
    return /матер|м²|м2|т\b|сэндвич|бетон|арматур|компл/.test(hay);
  });
  function exportExcelLike() {
    downloadUrl(`/api/export?kind=calc-xlsx&id=${calc!.id}`);
    toast.success("Скачивание XLSX…");
  }

  async function patchEstimateLeaf(
    leaf: EstimateLeaf,
    patch: { quantity?: number; rate?: number | null }
  ) {
    try {
      if (leaf.source === "stage_resource" && linkedSchedule) {
        await patchScheduleResource(linkedSchedule.id, {
          resourceId: leaf.id,
          stageId: leaf.stageId,
          quantity: patch.quantity,
          rate: patch.rate,
        });
        return;
      }
      if (leaf.source === "calc_position" && leaf.positionId) {
        const rateMissing = patch.rate == null;
        await updateCalculation(calc!.id, {
          positions: calc!.positions.map((p) =>
            p.id !== leaf.positionId
              ? p
              : {
                  ...p,
                  quantity: patch.quantity ?? p.quantity,
                  rate:
                    patch.rate === undefined
                      ? p.rate
                      : patch.rate == null
                        ? 0
                        : patch.rate,
                  rateMissing:
                    patch.rate === undefined
                      ? p.rateMissing
                      : rateMissing,
                }
          ),
        });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось обновить ресурс");
    }
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

  const isTest = isT25uTestId(calc.id) || isT25uTestTitle(calc.title);
  const pathSteps: Array<{ label: string; href: string; current?: boolean }> = [
    { label: "Заявка", href: `/cabinet/zakupki/${calc.procurementId}` },
    { label: "Расчёт", href: `/cabinet/raschety/${calc.id}`, current: true },
    ...(linkedSchedule
      ? [{ label: "ГПР", href: `/cabinet/gpr/${linkedSchedule.id}` }]
      : []),
    { label: "Производство", href: "/cabinet/proizvodstvo" },
  ];

  return (
    <div>
      <PageHeader
        title={calc.title}
        description={`Справочник: ${dir?.name ?? "—"} v${dir?.version ?? "?"} · закупка ${calc.procurementId} · ${
          locked ? "оригинал (immutable)" : "ресурсный черновик"
        }`}
        actions={
          <>
            <StatusBadge status={calc.status} />
            {!locked ? (
              <>
                {procurement &&
                procurement.lifecycle !== "production" &&
                user.sections.includes("zakupki") ? (
                  <Button
                    variant="outline"
                    data-testid="won-to-production"
                    onClick={async () => {
                      try {
                        await api("/api/zakupki", {
                          method: "POST",
                          body: JSON.stringify({
                            action: "transferToProduction",
                            id: procurement.id,
                          }),
                        });
                        await refresh();
                        toast.success("Тендер отмечен выигранным и передан в производство");
                      } catch (e) {
                        toast.error(
                          e instanceof Error ? e.message : "Не удалось передать проект"
                        );
                      }
                    }}
                  >
                    Выиграли → в производство
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  onClick={async () => {
                    try {
                      await recalcCalculation(calc.id, calc.scenario);
                      toast.success("Ставки обновлены из текущих справочников");
                    } catch (e) {
                      toast.error(
                        e instanceof Error ? e.message : "Ошибка пересчёта"
                      );
                    }
                  }}
                >
                  Обновить из справочников
                </Button>
                <Button
                  variant="outline"
                  data-testid="recompute-cost-engine"
                  onClick={async () => {
                    try {
                      const { api } = await import("@/lib/api");
                      await api("/api/raschety", {
                        method: "PATCH",
                        body: JSON.stringify({
                          id: calc.id,
                          recomputeCost: true,
                          costPatch: {
                            vatPercent: null,
                            profitMethod: "markup",
                            // Excel Ресурсный_график: НР 43% от прямых, прибыль = наценка 40% на с/с с НР
                            useResourceScheduleEconomics: true,
                            profitRate: 0.4,
                            resourceScheduleParams: calc.resourceScheduleParams ?? {
                              personHourRate: 1400,
                              personnelShiftsPerDay: 2,
                              hoursPerShift: 11,
                              equipmentShiftsPerDay: 1,
                              overheadRate: 0.43,
                              profitMarkupOnCostWithOh: 0.4,
                            },
                          },
                        }),
                      });
                      await refresh();
                      toast.success(
                        "Cost-engine: НР×прямые + наценка на с/с с НР (НДС — нет данных)"
                      );
                    } catch (e) {
                      toast.error(
                        e instanceof Error ? e.message : "Ошибка cost-engine"
                      );
                    }
                  }}
                >
                  Cost-engine
                </Button>
              </>
            ) : null}
            <Button
              variant="outline"
              data-testid="calc-export-xlsx"
              onClick={exportExcelLike}
            >
              Excel
            </Button>
            <Button
              variant="outline"
              data-testid="calc-export-pdf"
              onClick={exportPdfLike}
            >
              PDF
            </Button>
          </>
        }
      />

      {isTest ? (
        <div
          className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950"
          data-testid="t25u-test-banner"
        >
          <span className="font-semibold">TEST</span> — изолированный расчёт
          приёмки t25u (не смета школы №12).
        </div>
      ) : null}

      <nav
        aria-label="Путь проекта"
        className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--tk-line)] bg-white/80 px-3 py-2 text-sm"
        data-testid="project-matryoshka"
      >
        {pathSteps.map((step, index) => (
          <span key={step.label} className="inline-flex items-center gap-2">
            <Link
              href={step.href}
              aria-current={step.current ? "step" : undefined}
              className={
                step.current
                  ? "rounded-md bg-[var(--tk-ink)] px-2 py-1 font-medium text-white"
                  : "text-[var(--tk-ink)] underline decoration-[var(--tk-line)] underline-offset-2 hover:decoration-current"
              }
            >
              {step.label}
            </Link>
            {index < pathSteps.length - 1 ? (
              <span aria-hidden="true" className="text-[var(--tk-muted)]">›</span>
            ) : null}
          </span>
        ))}
        <span className="ml-auto text-xs text-[var(--tk-muted)]">
          {procurement?.number ?? `Заявка ${calc.procurementId}`}
        </span>
      </nav>

      <section
        aria-labelledby="calc-project-documents"
        className="mb-5 rounded-xl border border-[var(--tk-line)] bg-white/80 p-4"
        data-testid="calc-project-documents"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="calc-project-documents" className="font-medium">
            Документы заявки · {projectDocuments.length}
          </h2>
          <Link
            href={`/cabinet/zakupki/${calc.procurementId}`}
            className="text-sm text-[var(--tk-copper-deep)] underline"
          >
            Открыть карточку заявки
          </Link>
        </div>
        {projectDocuments.length ? (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {projectDocuments.map((document) => (
              <li key={document.id}>
                <a
                  href={`/api/dokumenty/file?id=${encodeURIComponent(document.id)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate rounded-lg border border-[var(--tk-line)] px-3 py-2 text-sm hover:bg-stone-50"
                  title={document.fileName}
                >
                  {document.fileName}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-[var(--tk-muted)]">
            Документы ещё не загружены. Загружайте их в карточку заявки — они будут доступны здесь для сравнения.
          </p>
        )}
      </section>

      <section
        aria-label="График, риски и деньги по проекту"
        className="mb-5 grid gap-3 lg:grid-cols-3"
        data-testid="calculation-project-workspace"
      >
        <Link
          href={linkedSchedule ? `/cabinet/gpr/${linkedSchedule.id}` : `/cabinet/zakupki/${calc.procurementId}`}
          className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4 hover:border-[var(--tk-copper)]"
        >
          <h2 className="font-medium">График работ</h2>
          <p className="mt-1 text-sm text-[var(--tk-muted)]">
            {linkedSchedule
              ? `${linkedSchedule.stages.length} этапов · ресурсный календарь и Гант`
              : "ГПР ещё не создан — вернитесь в карточку заявки"}
          </p>
        </Link>
        <Link
          href={`/cabinet/zakupki/${calc.procurementId}`}
          className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4 hover:border-[var(--tk-copper)]"
        >
          <h2 className="font-medium">Риски контракта</h2>
          {projectRisk ? (
            <>
              <p className="mt-1 text-sm text-[var(--tk-muted)]">
                Договор разобран: {projectRisk.contractParsed ? "да" : "нет"} · замечаний: {projectRisk.remarks.length}
              </p>
              {projectRisk.remarks.slice(0, 2).map((remark) => (
                <p key={remark.id} className="mt-2 line-clamp-2 text-xs">
                  <span className="font-medium">{remark.severity === "high" ? "Высокий риск · " : ""}</span>
                  {remark.text}
                </p>
              ))}
            </>
          ) : (
            <p className="mt-1 text-sm text-[var(--tk-muted)]">Реестр появится после загрузки договора в карточку заявки</p>
          )}
        </Link>
        <Link
          href={`/cabinet/zakupki/${calc.procurementId}`}
          className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4 hover:border-[var(--tk-copper)]"
        >
          <h2 className="font-medium">Денежный план</h2>
          {projectMoney ? (
            <>
              <p className="mt-1 text-sm text-[var(--tk-muted)]">
                {projectMoney.payments.length} событий оплаты · нужно проверить кассовый разрыв
              </p>
              {projectMoney.payments.slice(0, 2).map((payment) => (
                <p key={payment.id} className="mt-2 text-xs">
                  {payment.date} · {payment.title} · {formatMoney(payment.amount)}
                </p>
              ))}
            </>
          ) : (
            <p className="mt-1 text-sm text-[var(--tk-muted)]">Денежный план появится в карточке заявки после ввода условий оплаты</p>
          )}
        </Link>
      </section>

      {locked ? (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          Исходная смета заказчика неизменяема. Собственные ресурсы добавляйте
          только в ресурсный черновик.
        </div>
      ) : (
        <div className="mb-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950">
          Редактируемый черновик. Арифметика детерминированная; причины
          отклонений только из сравнения полей — без выдуманных LLM-причин. Не
          обещаем 97% точности.
        </div>
      )}

      <div className="mb-4 flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <div>
          <label
            htmlFor="calc-scenario"
            className="mb-1 block text-xs text-[var(--tk-muted)]"
          >
            Сценарий
          </label>
          {/* Native select: reliable for a11y + browser E2E (Base UI Select was flaky under automation). */}
          <select
            id="calc-scenario"
            data-testid="calc-scenario"
            aria-label="Сценарий расчёта"
            className="flex h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm sm:w-[220px]"
            value={calc.scenario}
            onChange={(e) => {
              const v = e.target.value as Calculation["scenario"];
              if (!v) return;
              void recalcCalculation(calc.id, v);
              toast.success("Пересчёт выполнен");
            }}
          >
            <option value="bazovyy">Базовый</option>
            <option value="optimisticheskiy">Оптимистичный ×0,95</option>
            <option value="pessimisticheskiy">Пессимистичный ×1,08</option>
          </select>
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
            <SelectTrigger className="w-full sm:w-[220px]">
              <SelectValue>
                {{
                  none: "Не принято",
                  uchastvovat: "Участвовать",
                  otkaz: "Отказ",
                  na_rassmotrenii: "На рассмотрении",
                }[calc.participateDecision ?? "none"] ?? "Не принято"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Не принято</SelectItem>
              <SelectItem value="uchastvovat">Участвовать</SelectItem>
              <SelectItem value="otkaz">Отказ</SelectItem>
              <SelectItem value="na_rassmotrenii">На рассмотрении</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="tk-glass rounded-3xl px-4 py-2" data-testid="calc-total-chip">
          <div className="text-xs text-[var(--tk-muted)]">
            {calc.kind === "customer_original"
              ? "Оригинал сметы (immutable)"
              : draftSlices
                ? `Черновик · Z (ресурсный)${
                    calc.costSummary?.totalsIncomplete || draftSlices.partial
                      ? " · PARTIAL"
                      : ""
                  }`
                : calc.costSummary?.totalsIncomplete
                  ? "Итого черновика · PARTIAL"
                  : "Итого черновика"}
          </div>
          <div className="font-[family-name:var(--font-display)] text-xl">
            {formatMoney(total)}
            {(calc.costSummary?.totalsIncomplete ||
              draftSlices?.partial ||
              (calc.costSummary?.incomplete?.length ?? 0) > 0) &&
            calc.kind !== "customer_original" ? (
              <span
                className="ml-2 text-sm font-normal text-amber-800"
                data-testid="calc-total-chip-partial"
              >
                PARTIAL
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mb-8">
        <HierarchicalEstimatePanel
          key={`${calc.id}:${JSON.stringify(calc.resourceScheduleParams ?? null)}:${calc.officeOverhead ?? 0}:${calc.costSummary?.reserve ?? 0}`}
          stages={linkedSchedule?.stages ?? []}
          positions={calc.positions}
          locked={locked}
          resourceScheduleParams={calc.resourceScheduleParams}
          originalTotal={
            calc.kind === "customer_original"
              ? totals.total
              : originalTotals?.total ?? null
          }
          originalLabel={
            calc.kind === "customer_original"
              ? "Этот документ — оригинал (immutable)"
              : "Оригинал сметы (immutable)"
          }
          costSummary={calc.costSummary}
          costIncomplete={Boolean(calc.costSummary?.totalsIncomplete)}
          officeOverhead={calc.officeOverhead}
          onSaveResourceScheduleParams={async ({
            params,
            officeOverhead,
            reserve,
          }: {
            params: ResourceScheduleParams;
            officeOverhead: number;
            reserve: number;
          }) => {
            await api("/api/raschety", {
              method: "PATCH",
              body: JSON.stringify({
                id: calc.id,
                recomputeCost: true,
                costPatch: {
                  vatPercent: null,
                  profitMethod: "markup",
                  profitRate: params.profitMarkupOnCostWithOh,
                  officeOverhead,
                  reserve,
                  useResourceScheduleEconomics: true,
                  resourceScheduleParams: params,
                },
              }),
            });
            await refresh();
          }}
          onPatchLeaf={(leaf, patch) => {
            void patchEstimateLeaf(leaf, patch);
          }}
          onExport={exportExcelLike}
          onAddClick={() => {
            setShowDirAdd(true);
            requestAnimationFrame(() => {
              document
                .getElementById("estimate-add-directory")
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
            });
          }}
        />
      </div>

      <details className="mb-6 rounded-xl border border-[var(--tk-line)] bg-white/80 p-4">
        <summary
          className="cursor-pointer text-sm font-medium"
          data-testid="flat-positions-toggle"
        >
          Плоская ведомость позиций (техническая; основная смета — дерево выше)
        </summary>
        <div className="mt-3 mb-3 grid gap-2 text-sm sm:grid-cols-4">
          <div className="rounded-xl border bg-white/80 p-3">
            Труд: {formatMoney(buckets.labor)}
          </div>
          <div className="rounded-xl border bg-white/80 p-3">
            Материалы:{" "}
            {buckets.materialsUnpriced
              ? "нет данных"
              : formatMoney(buckets.materials)}
          </div>
          <div className="rounded-xl border bg-white/80 p-3">
            Техника: {formatMoney(buckets.equipment)}
          </div>
          <div className="rounded-xl border bg-white/80 p-3">
            Прочее прямые: {formatMoney(buckets.other)}
          </div>
        </div>
        <div
          className="overflow-x-auto rounded-xl border border-[var(--tk-line)] bg-white/80"
          data-testid="calc-positions-table"
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Код</TableHead>
                <TableHead>Наименование</TableHead>
                <TableHead>Ед.</TableHead>
                <TableHead className="text-right">Кол-во / потребность</TableHead>
                <TableHead className="text-right">Расценка</TableHead>
                <TableHead className="text-right">Стоимость</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {calc.positions.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-mono text-xs">{p.code}</TableCell>
                  <TableCell className="min-w-[12rem]">{p.name}</TableCell>
                  <TableCell>{p.unit}</TableCell>
                  <TableCell className="text-right">
                    {locked ? (
                      formatNumber(p.quantity)
                    ) : (
                      <Input
                        className="ml-auto w-28 text-right"
                        data-testid={`pos-qty-${p.id}`}
                        value={String(p.quantity)}
                        onChange={(e) => {
                          const v = Number(e.target.value) || 0;
                          updateCalculation(calc.id, {
                            positions: calc.positions.map((x) =>
                              x.id === p.id ? { ...x, quantity: v } : x
                            ),
                          });
                        }}
                      />
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {locked ? (
                      formatMoney(p.rate)
                    ) : (
                      <Input
                        className="ml-auto w-32 text-right"
                        data-testid={`pos-rate-${p.id}`}
                        value={String(p.rate)}
                        onChange={(e) => {
                          const v = Number(e.target.value) || 0;
                          updateCalculation(calc.id, {
                            positions: calc.positions.map((x) =>
                              x.id === p.id ? { ...x, rate: v } : x
                            ),
                          });
                        }}
                      />
                    )}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {formatMoney(
                      positionLineSum(p, calc.scenarioFactor || 1)
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </details>

      <section className="mt-6 rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
        <h2 className="font-[family-name:var(--font-display)] text-base">
          Материалы — потребность и стоимость
        </h2>
        <p className="mt-1 text-sm text-[var(--tk-muted)]">
          Позиции, классифицированные как материалы. Полный каталог клиента —
          через справочники. Без выдуманных потерь сверх нормы.
        </p>
        {materials.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--tk-muted)]">
            Материальных позиций пока нет — добавьте из справочника или
            импорта.
          </p>
        ) : (
          <Table className="mt-3">
            <TableHeader>
              <TableRow>
                <TableHead>Код</TableHead>
                <TableHead>Материал</TableHead>
                <TableHead>Ед.</TableHead>
                <TableHead className="text-right">Потребность</TableHead>
                <TableHead className="text-right">Стоимость</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {materials.map((p) => (
                <TableRow key={`mat-${p.id}`}>
                  <TableCell className="font-mono text-xs">{p.code}</TableCell>
                  <TableCell>{p.name}</TableCell>
                  <TableCell>{p.unit}</TableCell>
                  <TableCell className="text-right">
                    {formatNumber(p.quantity)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatMoney(
                      positionLineSum(p, calc.scenarioFactor || 1)
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      {!locked ? (
        <section
          className="mt-6 rounded-xl border border-[var(--tk-line)] bg-white/80 p-5"
          data-testid="northern-inputs"
        >
          <h2 className="font-[family-name:var(--font-display)] text-base">
            Север / экономика — подтверждаемые входы
          </h2>
          <p className="mt-1 text-sm text-[var(--tk-muted)]">
            Значения ставок уточнит Егор. Здесь только структура входов: без
            универсального «северного коэффициента». Прибыль — наценка XOR
            маржа.
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-[var(--tk-muted)]">
            <li>
              Вахта / РК+СН / северные множители — из подтверждённых баз (ШР/ТС),
              не универсальный коэффициент
            </li>
            <li>
              Автобус: полная маш.-ч ставка уже с амортизацией/ГСМ/ФОТ/ТО — не
              добавлять водителя/ГСМ сверху; расход топлива в эталоне — л/час
            </li>
            <li>
              НР как % от прямых (эталон 43%); прибыль = наценка на с/с с НР
              (эталон 40%), не маржа выручки
            </li>
            <li>
              Резерв отпуска ≠ общий резерв непредвиденных (последний — только
              если подтверждён отдельно)
            </li>
            <li>НДС %, дата цен, валюта; 14 позиций без тарифа → 0 + «неполно»</li>
          </ul>
          <Button
            className="mt-3"
            variant="outline"
            data-testid="recompute-northern"
            onClick={async () => {
              try {
                await api("/api/raschety", {
                  method: "PATCH",
                  body: JSON.stringify({
                    id: calc.id,
                    recomputeCost: true,
                    costPatch: {
                      vatPercent: null,
                      profitMethod: "markup",
                      useResourceScheduleEconomics: true,
                      profitRate: 0.4,
                      northern: calc.northern ?? {
                        applicable: true,
                        confirmedItems: [],
                        notes: [
                          "север/вахта в эталоне есть; подтверждайте базу каждого коэффициента",
                        ],
                      },
                    },
                  }),
                });
                await refresh();
                toast.success("Пересчёт связанных статей (без выдуманных ставок)");
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Ошибка");
              }
            }}
          >
            Пересчитать связанные
          </Button>
        </section>
      ) : null}

      {!locked ? (
      <section
        id="estimate-add-directory"
        className={`mt-6 rounded-xl border border-[var(--tk-line)] bg-white/80 p-5 ${showDirAdd ? "ring-2 ring-sky-400" : ""}`}
      >
        <h2 className="font-[family-name:var(--font-display)] text-base">
          Добавить из справочника (только в черновик)
        </h2>
        <p className="mt-1 text-sm text-[var(--tk-muted)]">
          Текущая версия: {currentDir?.name ?? "—"} · строк{" "}
          {currentDir?.rows.length ?? 0}
        </p>
        <div className="mt-3 flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <div>
            <p className="mb-1 text-xs text-[var(--tk-muted)]">Тип</p>
            <Select
              value={dirType}
              onValueChange={(v) => {
                if (!v) return;
                setDirType(v as "rascenki" | "ceny" | "park");
                setCode("");
                setFilter("");
              }}
            >
              <SelectTrigger className="w-full sm:w-[200px]">
                <SelectValue>
                  {{
                    rascenki: "Нормо-час",
                    ceny: "Тарифы АТС/ДСМ",
                    park: "Парк техники",
                  }[dirType]}
                </SelectValue>
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
                <SelectTrigger className="w-full sm:w-[200px]">
                  <SelectValue>
                    {{
                      price: "1 смена КПИ 0,85",
                      rate_2s_kpi085: "2 смены КПИ 0,85",
                      rate_1s_kpi10: "1 смена КПИ 1,0",
                      rate_2s_kpi10: "2 смены КПИ 1,0",
                    }[rateKey] ?? rateKey}
                  </SelectValue>
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
              className="w-full sm:w-[100px]"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </div>
          <div className="w-full min-w-0 sm:min-w-[220px] sm:flex-1">
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
          {pickerRows.length === 0 ? (
            <p className="p-4 text-sm text-[var(--tk-muted)]">
              Ничего не найдено в «
              {dirType === "rascenki"
                ? "Нормо-час"
                : dirType === "ceny"
                  ? "Тарифы АТС/ДСМ"
                  : "Парк техники"}
              ». Смените тип справочника или очистите поиск.
            </p>
          ) : (
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
                      className={
                        code === rowCode ? "bg-[var(--tk-steel)]/5" : undefined
                      }
                    >
                      <TableCell className="font-mono text-xs">
                        {rowCode}
                      </TableCell>
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
          )}
        </div>
      </section>
      ) : null}

      {calc.costSummary ? (
        <section className="mb-6 rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
          <h2 className="font-[family-name:var(--font-display)] text-base">
            Сводка cost-engine
          </h2>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
            <div>C0 (без резерва): {formatMoney(calc.costSummary.C0)}</div>
            <div>C (с резервом): {formatMoney(calc.costSummary.C)}</div>
            <div>Прибыль: {formatMoney(calc.costSummary.profit)}</div>
            <div>Цена без НДС: {formatMoney(calc.costSummary.priceExVat)}</div>
            <div>
              НДС:{" "}
              {calc.costSummary.vatAmount == null
                ? "нет данных"
                : formatMoney(calc.costSummary.vatAmount)}
            </div>
            <div>
              Неполнота:{" "}
              {calc.costSummary.incomplete.length
                ? calc.costSummary.incomplete.join(", ")
                : "—"}
            </div>
          </dl>
          <p className="mt-2 text-xs text-[var(--tk-muted)]">
            Метод {calc.costSummary.method}. Без угадывания Excel и без обещания
            97%. Север — только подтверждённые статьи.
          </p>
        </section>
      ) : null}

      <section className="mt-6 rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
        <h2 className="font-[family-name:var(--font-display)] text-base">
          Сравнение со сметой заказчика
        </h2>
        <p className="mt-1 text-sm text-[var(--tk-muted)]">
          Отклонения только по измеримым полям. Если причина не установлена —
          так и пишем.
        </p>
        {compare.notes.length ? (
          <ul className="mt-2 list-disc pl-5 text-sm text-amber-900">
            {compare.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
        <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
          <div>
            Работы заказчика:{" "}
            {compare.totals.originalWorks != null
              ? formatMoney(compare.totals.originalWorks)
              : "нет данных"}
          </div>
          <div>
            Работы черновика:{" "}
            {compare.totals.draftWorks != null
              ? formatMoney(compare.totals.draftWorks)
              : "нет данных"}
          </div>
          <div>
            Δ итого:{" "}
            {compare.totals.deltaTotal != null
              ? formatMoney(compare.totals.deltaTotal)
              : "нет данных"}
          </div>
        </div>
        <div className="mt-4 max-h-72 overflow-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Код</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead>Причина</TableHead>
                <TableHead className="text-right">Δ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {compare.rows.slice(0, 40).map((r) => (
                <TableRow key={`${r.code}-${r.unit}-${r.status}`}>
                  <TableCell className="font-mono text-xs">{r.code}</TableCell>
                  <TableCell>{r.status}</TableCell>
                  <TableCell className="text-xs">{r.reason}</TableCell>
                  <TableCell className="text-right">
                    {r.deltaSum != null ? formatMoney(r.deltaSum) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="mt-6 rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
        <h2 className="font-[family-name:var(--font-display)] text-base">
          Допущения и флаги
        </h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-[var(--tk-ink-soft)]">
          {calc.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
          {(calc.dataFlags ?? []).map((f) => (
            <li key={f}>флаг: {f}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
