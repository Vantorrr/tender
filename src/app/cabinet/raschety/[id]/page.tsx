"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
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
import type { Calculation, GprStageResource, ResourceQuantityBasis } from "@/lib/types";
import type { EstimateLeaf } from "@/lib/hierarchical-estimate";
import type { ResourceScheduleParams } from "@/lib/resource-schedule-model";
import { useStore } from "@/lib/store";
import {
  calculationTotals,
  positionLineSum,
} from "@/lib/calc-math";
import { compareCalculations } from "@/lib/calc-compare";
import type { NorthernInputs } from "@/lib/cost-engine";
import type { CalcCompareAiReport } from "@/server/calc-compare-ai";
import { ProjectAiChat } from "@/components/project-ai-chat";
import { userHasSection } from "@/lib/acl";

function NorthernCostEditor({
  calculationId,
  value,
  onSaved,
}: {
  calculationId: string;
  value?: NorthernInputs;
  onSaved: () => Promise<void>;
}) {
  const [applicable, setApplicable] = useState(value?.applicable ?? true);
  const [items, setItems] = useState<NorthernInputs["confirmedItems"]>(
    value?.confirmedItems ?? []
  );
  const [saving, setSaving] = useState(false);

  function patchItem(
    id: string,
    patch: Partial<NorthernInputs["confirmedItems"][number]>
  ) {
    setItems((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  async function save() {
    setSaving(true);
    try {
      await api("/api/raschety", {
        method: "PATCH",
        body: JSON.stringify({
          id: calculationId,
          recomputeCost: true,
          costPatch: {
            northern: { applicable, confirmedItems: items, notes: [] },
            useResourceScheduleEconomics: true,
          },
        }),
      });
      await onSaved();
      toast.success("Северные затраты сохранены, расчёт обновлён");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось сохранить затраты");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 space-y-3">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={applicable} onChange={(event) => setApplicable(event.target.checked)} />
        Для проекта применимы северные/вахтовые затраты
      </label>
      {items.length ? (
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.id} className="grid gap-2 rounded-lg border border-[var(--tk-line)] p-3 sm:grid-cols-2 xl:grid-cols-[1.2fr_0.7fr_0.9fr_1.2fr_auto]">
              <Input aria-label="Статья северных затрат" placeholder="Например, проживание вахты" value={item.name} onChange={(event) => patchItem(item.id, { name: event.target.value })} />
              <Select value={item.status} onValueChange={(status) => status && patchItem(item.id, { status: status as NorthernInputs["confirmedItems"][number]["status"] })}>
                <SelectTrigger aria-label={`Статус · ${item.name}`}>
                  <SelectValue>{(status) => status === "known" ? "Подтверждено" : status === "clarify" ? "Уточнить" : "Сценарий"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="known">Подтверждено</SelectItem>
                  <SelectItem value="clarify">Уточнить</SelectItem>
                  <SelectItem value="scenario">Сценарий</SelectItem>
                </SelectContent>
              </Select>
              <Input aria-label={`Сумма · ${item.name}`} type="number" min={0} step="0.01" placeholder="Сумма, ₽" value={item.amount ?? ""} onChange={(event) => {
                const raw = event.target.value.trim();
                const amount = raw ? Number(raw.replace(",", ".")) : null;
                patchItem(item.id, { amount: amount != null && Number.isFinite(amount) && amount >= 0 ? amount : null });
              }} />
              <Input aria-label={`Основание · ${item.name}`} placeholder="Основание: КП, ШР, документ" value={item.basis} onChange={(event) => patchItem(item.id, { basis: event.target.value })} />
              <Button variant="ghost" size="sm" aria-label={`Удалить · ${item.name}`} onClick={() => setItems((current) => current.filter((row) => row.id !== item.id))}>Удалить</Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-[var(--tk-muted)]">Подтверждённые северные затраты не добавлены. Автоматический коэффициент не применяется.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setItems((current) => [...current, { id: `north-${Date.now()}`, name: "", status: "clarify", amount: null, basis: "" }])}>Добавить статью</Button>
        <Button size="sm" disabled={saving} onClick={() => void save()}>{saving ? "Пересчёт…" : "Сохранить и пересчитать"}</Button>
      </div>
      <p className="text-xs text-[var(--tk-muted)]">В итог включаются только строки «Подтверждено» с заполненной суммой. Строки «Уточнить» помечают расчёт как неполный; сценарные суммы хранятся отдельно и не включаются.</p>
    </div>
  );
}

export default function RaschetDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const {
    data,
    user,
    updateCalculation,
    updateSchedule,
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
  const [aiCompare, setAiCompare] = useState<{
    signature: string;
    report: CalcCompareAiReport;
  } | null>(null);
  const [aiCompareLoading, setAiCompareLoading] = useState(false);

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
  const compareSignature = JSON.stringify(compare);
  const compareAiBatches = Math.ceil(compare.rows.length / 80);

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
    patch: {
      name?: string;
      unit?: string;
      quantity?: number;
      rate?: number | null;
      hoursPerShift?: number | null;
      shiftsPerDay?: number | null;
      days?: number | null;
      kind?: GprStageResource["kind"];
      quantityBasis?: ResourceQuantityBasis | null;
    }
  ) {
    try {
      if (leaf.source === "stage_resource" && linkedSchedule) {
        await patchScheduleResource(linkedSchedule.id, {
          resourceId: leaf.id,
          stageId: leaf.stageId,
          ...patch,
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

  const directorySubtitle = dir
    ? `Справочник: ${dir.name} · версия ${dir.version}`
    : "версия справочника не указана";
  const procurementSubtitle = procurement
    ? [procurement.number, procurement.title].filter(Boolean).join(" — ")
    : "закупка не указана";
  const calcKindSubtitle = locked
    ? "оригинал сметы заказчика"
    : "ресурсный черновик";

  return (
    <div>
      <PageHeader
        title={calc.title}
        description={`${directorySubtitle} · ${procurementSubtitle} · ${calcKindSubtitle}`}
        actions={
          <>
            {procurement && user && userHasSection(user, "raschety") ? (
              <ProjectAiChat procurementId={calc.procurementId} projectTitle={procurement.title} screen="calculation" />
            ) : null}
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
                        "Пересчёт: накладные от прямых + наценка на себестоимость (НДС — нет данных)"
                      );
                    } catch (e) {
                      toast.error(
                        e instanceof Error ? e.message : "Ошибка пересчёта"
                      );
                    }
                  }}
                >
                  Пересчитать итоги
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
          Черновик можно редактировать. Суммы пересчитываются автоматически по
          формулам сметы.
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
              ? "Оригинал сметы заказчика"
              : draftSlices
                ? `Черновик · итого${
                    calc.costSummary?.totalsIncomplete || draftSlices.partial
                      ? " · расчёт неполный"
                      : ""
                  }`
                : calc.costSummary?.totalsIncomplete
                  ? "Итого черновика · расчёт неполный"
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
                расчёт неполный
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
              ? "Этот документ — оригинал сметы заказчика"
              : "Оригинал сметы заказчика"
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
            return patchEstimateLeaf(leaf, patch);
          }}
          onAddManualResources={async (stageId, resources) => {
            if (!linkedSchedule || locked) return;
            await updateSchedule(linkedSchedule.id, {
              stages: linkedSchedule.stages.map((stage) =>
                stage.id === stageId
                  ? {
                      ...stage,
                      resources: [
                        ...(stage.resources ?? []),
                        ...resources.map((resource) => ({
                          ...resource,
                          id: `gprr-${crypto.randomUUID()}`,
                        })),
                      ],
                    }
                  : stage
              ),
            });
          }}
          onOpenSchedule={linkedSchedule ? () => router.push(`/cabinet/gpr/${linkedSchedule.id}`) : undefined}
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
            Вносите только подтверждённые расходы и указывайте источник суммы. Универсальный «северный коэффициент» не применяется. Прибыль — наценка XOR маржа.
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
          <NorthernCostEditor
            key={`${calc.id}:${calc.updatedAt}:${JSON.stringify(calc.northern ?? null)}`}
            calculationId={calc.id}
            value={calc.northern}
            onSaved={refresh}
          />
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
            Сводка расчёта
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
            Метод {calc.costSummary.method}. Северные надбавки — только по
            подтверждённым статьям.
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
        <p className="mt-2 text-xs text-[var(--tk-muted)]">
          Строк: {compare.rows.length} · требуют проверки: {compare.rows.filter((row) => row.status === "diff" || row.status === "only_original" || row.status === "only_draft").length} · неполные данные: {compare.rows.filter((row) => row.status === "incomplete").length}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            disabled={!paired || compare.rows.length === 0 || aiCompareLoading}
            title={`Отправляет строки сравнения в платную модель: ${compareAiBatches} запрос(а/ов), до 80 строк в каждом блоке. Расчётные суммы модель не меняет.`}
            onClick={async () => {
              setAiCompareLoading(true);
              try {
                const response = await api<{ report: CalcCompareAiReport }>(
                  "/api/raschety",
                  {
                    method: "POST",
                    body: JSON.stringify({ action: "analyzeCompare", calculationId: calc!.id }),
                  }
                );
                setAiCompare({ signature: compareSignature, report: response.report });
              } catch (error) {
                toast.error(error instanceof Error ? error.message : "Не удалось проанализировать сравнение");
              } finally {
                setAiCompareLoading(false);
              }
            }}
          >
            {aiCompareLoading ? "ИИ проверяет расхождения…" : "Получить комментарий ИИ"}
          </Button>
          <span className="text-xs text-[var(--tk-muted)]">
            Платный пакетный анализ: {compareAiBatches} запрос(а/ов) по всем {compare.rows.length} строкам сравнения; суммы считает система.
          </span>
        </div>
        {aiCompare?.signature === compareSignature ? (
          <div className="mt-4 rounded-lg border border-[var(--tk-line)] bg-stone-50 p-4" data-testid="calc-compare-ai">
            <div className="font-medium">
              {aiCompare.report.overall === "no_material_differences"
                ? "Существенных различий по имеющимся полям нет"
                : aiCompare.report.overall === "insufficient_data"
                  ? "Недостаточно данных для вывода"
                  : "Требуется проверка расхождений"}
            </div>
            <p className="mt-1 text-sm">{aiCompare.report.summary}</p>
            <p className="mt-1 text-xs text-[var(--tk-muted)]" data-testid="calc-compare-ai-coverage">
              AI охватил {aiCompare.report.rowsAnalyzed} из {aiCompare.report.rowsTotal} строк · платных запросов: {aiCompare.report.batches}
            </p>
            {aiCompare.report.findings.length ? (
              <ul className="mt-3 space-y-2 text-sm">
                {aiCompare.report.findings.map((finding) => {
                  const rowIndex = Number(finding.rowId.replace("row-", "")) - 1;
                  const row = compare.rows[rowIndex];
                  return (
                    <li key={finding.rowId}>
                      <span className="font-medium">{row?.code} · {row?.name}: </span>
                      {finding.text}
                      <span className="mt-1 block text-xs text-[var(--tk-muted)]">
                        Основание: «{finding.sourceExcerpt}»
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-[var(--tk-muted)]">
                Нет замечаний с проверяемой цитатой из строк сравнения.
              </p>
            )}
            <p className="mt-3 text-xs text-[var(--tk-muted)]">
              {aiCompare.report.disclaimer}
            </p>
          </div>
        ) : null}
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
              {compare.rows.map((r, index) => (
                <TableRow key={`compare-row-${index}`}>
                  <TableCell className="font-mono text-xs">{r.code}</TableCell>
                  <TableCell>{
                    r.status === "matched" ? "Совпадает" :
                      r.status === "diff" ? "Отклонение" :
                        r.status === "incomplete" ? "Неполные данные" :
                          r.status === "only_original" ? "Только у заказчика" : "Только в черновике"
                  }</TableCell>
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
