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
import { bucketsFromPositions, classifyDirectCostBucket } from "@/lib/cost-engine";
import { formatMoney, formatNumber } from "@/lib/format";
import type { Calculation, GprStageResource, ResourceQuantityBasis } from "@/lib/types";
import type { EstimateLeaf } from "@/lib/hierarchical-estimate";
import type { ResourceScheduleParams } from "@/lib/resource-schedule-model";
import { useStore } from "@/lib/store";
import {
  calculationTotals,
  positionLineSum,
  sourceEstimateTotals,
} from "@/lib/calc-math";
import { compareCalculations } from "@/lib/calc-compare";
import type { NorthernInputs } from "@/lib/cost-engine";
import type { CalcCompareAiReport } from "@/server/calc-compare-ai";
import { ProjectAiChat } from "@/components/project-ai-chat";
import { userHasSection } from "@/lib/acl";

function VatRateEditor({
  calculationId,
  value,
  onSaved,
}: {
  calculationId: string;
  value: number | null;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  const [saving, setSaving] = useState(false);

  async function save() {
    const rate = draft.trim() ? Number(draft.replace(",", ".")) : null;
    if (rate != null && (!Number.isFinite(rate) || rate < 0 || rate > 100)) {
      toast.error("Укажите ставку НДС от 0 до 100% или оставьте поле пустым");
      return;
    }
    setSaving(true);
    try {
      await api("/api/raschety", {
        method: "PATCH",
        body: JSON.stringify({
          id: calculationId,
          recomputeCost: true,
          costPatch: { vatPercent: rate, useResourceScheduleEconomics: true },
        }),
      });
      await onSaved();
      toast.success("НДС учтён, расчёт и сравнение с НМЦК обновлены");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось пересчитать НДС");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg bg-stone-50 p-3" data-testid="vat-rate-editor">
      <label className="text-xs text-[var(--tk-muted)]">
        Ставка НДС для сравнения с НМЦК, %
        <Input className="mt-1 w-36" type="number" min="0" max="100" step="0.1" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Нет данных" />
      </label>
      <Button size="sm" variant="outline" disabled={saving} onClick={() => void save()}>
        {saving ? "Пересчёт…" : "Сохранить и пересчитать"}
      </Button>
      <p className="basis-full text-xs text-[var(--tk-muted)]">Ставка не подставляется автоматически. Укажите налоговый режим проекта, чтобы сравнить итоговую цену с НМЦК на одной базе.</p>
    </div>
  );
}

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

const CALCULATION_FLAG_INFO: Record<string, { title: string; effect: string; action?: string; severity: "info" | "review" }> = {
  requires_manual_check: {
    title: "Итог требует проверки",
    effect: "Есть неподтверждённые объёмы, ставки или ресурсы; итог может быть неполным.",
    action: "Откройте строки с пометкой «нет данных» и подтвердите исходные значения.",
    severity: "review",
  },
  no_accuracy_promise: {
    title: "Точность зависит от исходных документов",
    effect: "Это пояснение не меняет сумму и не является оценкой точности в процентах.",
    severity: "info",
  },
  seeded_from_customer_estimate: {
    title: "Позиции перенесены из сметы заказчика",
    effect: "Перенесённые объёмы участвуют в черновом расчёте; ставки и состав ресурсов проверяйте отдельно.",
    severity: "info",
  },
  awaiting_estimate_rows: {
    title: "В расчёте нет распознанных строк сметы",
    effect: "Без позиций нельзя получить полный ресурсный итог.",
    action: "Загрузите смету заказчика или внесите позиции вручную.",
    severity: "review",
  },
  unified_resource_tree: {
    title: "Итог рассчитан по ресурсам",
    effect: "Сумма собрана из строк ресурсов в дереве расчёта.",
    severity: "info",
  },
  synced_from_gpr_stages: {
    title: "Ресурсы связаны с этапами ГПР",
    effect: "Позиции синхронизируются с этапами; изменения ресурсов в ГПР обновляют расчёт.",
    severity: "info",
  },
  resource_schedule_excel_economics: {
    title: "Применена ресурсная модель",
    effect: "Итог учитывает параметры ресурсного расчёта, включая накладные и прибыль.",
    severity: "info",
  },
  gpr_dates_shifted: {
    title: "Пересчитано расписание ГПР",
    effect: "После сдвига дат обновлены график и связанные с ним показатели.",
    severity: "info",
  },
  bus_missing_full_tariff: {
    title: "Не задан полный тариф автобуса",
    effect: "Стоимость автобусного ресурса не подтверждена и может быть исключена из полного итога.",
    action: "Укажите тариф с учётом применимых затрат на перевозку.",
    severity: "review",
  },
  full_machine_hour_tariff: {
    title: "Используется тариф за машино-час",
    effect: "Сумма техники считается по ставке за машино-час.",
    severity: "info",
  },
  no_extra_fuel_or_driver_on_top: {
    title: "Топливо и водитель отдельно не добавляются",
    effect: "Они считаются включёнными в полный тариф техники, чтобы не посчитать их дважды.",
    severity: "info",
  },
  fuel_basis_liters_per_hour_not_per_100km: {
    title: "Топливо рассчитано по часам работы",
    effect: "Норма топлива трактуется как литры в час, а не на 100 км.",
    severity: "info",
  },
  fuel_liters_per_hour: {
    title: "Применена часовая норма топлива",
    effect: "Затраты на топливо зависят от литров в час и времени работы техники.",
    severity: "info",
  },
  driver_included_in_tariff: {
    title: "Водитель включён в тариф",
    effect: "Отдельная зарплата водителя сверх тарифа не начисляется.",
    severity: "info",
  },
  check_rent_tariff_does_not_already_include_driver: {
    title: "Проверьте состав тарифа аренды",
    effect: "Если водитель уже входит в аренду, отдельная строка может задвоить затраты.",
    action: "Сверьте ставку аренды с договором и справочником.",
    severity: "review",
  },
  own_mode_uses_ownership_cost_not_full_rent: {
    title: "Для собственной техники учтена стоимость владения",
    effect: "Полная арендная ставка собственной технике не назначается.",
    severity: "info",
  },
  check_full_tariff_may_already_include_fuel: {
    title: "Проверьте, включено ли топливо в тариф",
    effect: "Повторное добавление топлива может задвоить затраты.",
    action: "Сверьте тариф с источником цены.",
    severity: "review",
  },
  northern_not_applicable: {
    title: "Северные затраты отключены",
    effect: "Северные и вахтовые расходы не включены в итог.",
    action: "Проверьте настройку применимости для этого проекта.",
    severity: "review",
  },
  northern_marked_not_applicable_but_amounts_present: {
    title: "Есть северные суммы, но затраты отключены",
    effect: "Суммы не войдут в расчёт, пока статья не подтверждена.",
    action: "Проверьте северные затраты в параметрах расчёта.",
    severity: "review",
  },
  no_dual_markup_and_margin: {
    title: "Наценка не дублируется с маржой",
    effect: "Используется один выбранный способ расчёта прибыли.",
    severity: "info",
  },
};

const HIDDEN_TECHNICAL_CALC_FLAGS = new Set([
  "cost_engine_v1",
  "immutable_original",
  "from_estimate_doc",
  "user_attached",
  "auto_chain",
  "migrated_schema_8",
  "seed_resource_draft",
  "t25u_test_fixture",
]);

function assumptionScope(text: string): { label: string; className: string } {
  if (/ставк|объем|объём|коэф|индекс|наклад|прибыл|регион|уровень цен|нр\b|сп\b|расцен/iu.test(text)) {
    return { label: "Влияет на сумму", className: "border-amber-200 bg-amber-50 text-amber-900" };
  }
  if (/срок|дата|календар|гпр/iu.test(text)) {
    return { label: "Влияет на график", className: "border-sky-200 bg-sky-50 text-sky-900" };
  }
  return { label: "Источник / пояснение", className: "border-border bg-muted text-muted-foreground" };
}

function calculationFlagInfo(flag: string) {
  if (HIDDEN_TECHNICAL_CALC_FLAGS.has(flag) || /^migrated_schema_/u.test(flag) || /^cost_/u.test(flag)) return null;
  const known = CALCULATION_FLAG_INFO[flag];
  if (known) return known;
  if (flag.startsWith("profit_method:")) {
    return { title: "Способ расчёта прибыли", effect: `В расчёте выбран метод «${flag.slice("profit_method:".length)}».`, severity: "info" as const };
  }
  if (flag.startsWith("tariff_basis:")) {
    return { title: "Основание тарифа техники", effect: "В расчёт передан выбранный тип тарифа из справочника.", severity: "info" as const };
  }
  if (flag.startsWith("north_scenario:")) {
    return { title: "Сценарная северная статья не включена в итог", effect: "Сценарная сумма хранится отдельно до подтверждения.", severity: "review" as const };
  }
  return null;
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
  const [attachEstimateLoading, setAttachEstimateLoading] = useState(false);

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
  const pairedKind = calc.kind === "customer_original" ? "resource_draft" : "customer_original";
  const linkedPair = calc.pairedCalculationId
    ? data.calculations.find(
        (candidate) =>
          candidate.id === calc.pairedCalculationId &&
          candidate.procurementId === calc.procurementId &&
          candidate.kind === pairedKind,
      )
    : undefined;
  const procurementOriginal = procurement?.originalCalculationId
    ? data.calculations.find(
        (candidate) =>
          candidate.id === procurement.originalCalculationId &&
          candidate.procurementId === calc.procurementId &&
          candidate.kind === "customer_original",
      )
    : undefined;
  const paired = linkedPair ??
    (calc.kind === "customer_original"
      ? data.calculations.find(
          (candidate) =>
            candidate.procurementId === calc.procurementId &&
            candidate.id !== calc.id &&
            candidate.kind === "resource_draft",
        )
      : procurementOriginal ?? data.calculations.find(
          (candidate) =>
            candidate.procurementId === calc.procurementId &&
            candidate.id !== calc.id &&
            candidate.kind === "customer_original",
        ));
  const compare =
    calc.kind === "resource_draft"
      ? compareCalculations(paired, calc)
      : compareCalculations(calc, paired);
  const compareSignature = JSON.stringify(compare);
  const compareAiBatches = Math.ceil(compare.rows.length / 80);

  const totals = calc.kind === "customer_original"
    ? sourceEstimateTotals(calc.positions)
    : calculationTotals(calc);
  const originalTotals = paired
    ? paired.kind === "customer_original"
      ? sourceEstimateTotals(paired.positions)
      : calculationTotals(paired)
    : null;
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
  const billablePositions = calc.positions.filter(
    (position) => position.code !== "НР" && position.code !== "СП" && !position.isWorkItem,
  );
  const missingRateCount = billablePositions.filter((position) => position.rateMissing).length;
  const noPricedPositions = billablePositions.length > 0 && missingRateCount === billablePositions.length;
  const bucketStats = billablePositions.reduce(
    (stats, position) => {
      const bucket = classifyDirectCostBucket(position);
      stats[bucket].count += 1;
      if (position.rateMissing) stats[bucket].missing += 1;
      return stats;
    },
    {
      labor: { count: 0, missing: 0 },
      materials: { count: 0, missing: 0 },
      equipment: { count: 0, missing: 0 },
      other: { count: 0, missing: 0 },
    },
  );
  const displayBucket = (key: keyof typeof bucketStats, amount: number) => {
    const stats = bucketStats[key];
    if (!stats.count) return "нет данных";
    if (stats.missing) return `неполно · нет ставок для ${stats.missing} из ${stats.count}`;
    return formatMoney(amount);
  };
  const materials = calc.positions.filter((p) => {
    if (p.isWorkItem || p.code === "НР" || p.code === "СП") return false;
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
    { label: "Производство", href: procurement?.planFactId ? `/cabinet/proizvodstvo?planFactId=${encodeURIComponent(procurement.planFactId)}` : "/cabinet/proizvodstvo" },
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
                            vatPercent: calc.vatPercent ?? null,
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
          href={`/cabinet/zakupki/${calc.procurementId}?tab=risks`}
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
          href={`/cabinet/zakupki/${calc.procurementId}?tab=money`}
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

      {!locked && calc.positions.length === 0 ? (
        <section className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950" role="status" data-testid="empty-calculation-guidance">
          <h2 className="font-semibold">В расчёте пока нет строк</h2>
          <p className="mt-1">
            Документы и ИИ-сводка сами по себе не превращаются в сметные позиции. Загрузите смету с распознаваемыми строками или добавьте работы и ресурсы из справочников — без этого стоимость считать не из чего.
          </p>
          <Link
            href={`/cabinet/zakupki/${calc.procurementId}`}
            className="mt-2 inline-flex text-[var(--tk-copper-deep)] underline"
          >
            Вернуться в карточку закупки и загрузить смету
          </Link>
        </section>
      ) : null}

      {!locked && calc.dataFlags?.includes("seeded_from_customer_estimate") ? (
        <section className="mb-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950" role="status" data-testid="estimate-seeded-guidance">
          <h2 className="font-semibold">Черновик сформирован из распознанной сметы</h2>
          <p className="mt-1">
            Исходные количества и строки заказчика перенесены для проверки. Исходная смета остаётся неизменной; её цены в наш черновик не копировались. Ставки сопоставлены только по точному коду и совместимой единице.
          </p>
          {calc.positions.some((position) => position.rateMissing && !position.isWorkItem) ? (
            <p className="mt-1 font-medium">
              Нужны ставки для {calc.positions.filter((position) => position.rateMissing && !position.isWorkItem).length} строк. Они исключены из стоимости, пока не подтверждены. Нулевые цены не подставляются.
            </p>
          ) : null}
        </section>
      ) : null}

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
                : noPricedPositions
                  ? "Итого черновика · нужны ставки"
                  : calc.costSummary?.totalsIncomplete
                  ? "Итого черновика · расчёт неполный"
                  : "Итого черновика"}
          </div>
          <div className="font-[family-name:var(--font-display)] text-xl">
            {noPricedPositions ? "Не рассчитано" : formatMoney(total)}
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
                  vatPercent: calc.vatPercent ?? null,
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
            Труд: {displayBucket("labor", buckets.labor)}
          </div>
          <div className="rounded-xl border bg-white/80 p-3">
            Материалы: {displayBucket("materials", buckets.materials)}
          </div>
          <div className="rounded-xl border bg-white/80 p-3">
            Техника: {displayBucket("equipment", buckets.equipment)}
          </div>
          <div className="rounded-xl border bg-white/80 p-3">
            Прочее прямые: {displayBucket("other", buckets.other)}
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
                    {p.isWorkItem && calc.kind !== "customer_original" ? (
                      <span className="text-xs text-[var(--tk-muted)]">не применяется к объёму работы</span>
                    ) : locked ? (
                      formatMoney(p.rate)
                    ) : (
                      <Input
                        className="ml-auto w-32 text-right"
                        data-testid={`pos-rate-${p.id}`}
                        placeholder={p.rateMissing ? "нет ставки" : undefined}
                        value={p.rateMissing ? "" : String(p.rate)}
                        onChange={(e) => {
                          const raw = e.target.value.trim();
                          const rateMissing = raw === "";
                          const v = rateMissing ? 0 : Number(raw);
                          if (!rateMissing && (!Number.isFinite(v) || v < 0)) return;
                          updateCalculation(calc.id, {
                            positions: calc.positions.map((x) =>
                              x.id === p.id ? { ...x, rate: v, rateMissing } : x
                            ),
                          });
                        }}
                      />
                    )}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {p.isWorkItem && calc.kind !== "customer_original"
                      ? "—"
                      : p.rateMissing
                        ? "—"
                        : formatMoney(positionLineSum(p, calc.scenarioFactor || 1))}
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
            <div>Цена с НДС: {formatMoney(calc.costSummary.priceIncVat)}</div>
            <div>
              Запас до НМЦК:{" "}
              {procurement?.nmck != null && calc.costSummary.priceIncVat != null
                ? `${formatMoney(procurement.nmck - calc.costSummary.priceIncVat)} (${formatNumber(((procurement.nmck - calc.costSummary.priceIncVat) / Math.max(1, procurement.nmck)) * 100)}%)`
                : "не рассчитан: укажите НДС и проверьте НМЦК"}
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
          {!locked && calc.kind === "resource_draft" ? (
            <VatRateEditor
              key={`${calc.id}:${calc.vatPercent ?? "unknown"}`}
              calculationId={calc.id}
              value={calc.vatPercent ?? null}
              onSaved={refresh}
            />
          ) : null}
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
        {calc.kind === "resource_draft" && !paired && procurement ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm" role="status" data-testid="customer-estimate-link-guidance">
            <span>Исходная смета ещё не подключена к сравнению.</span>
            {userHasSection(user, "zakupki") && projectDocuments.some((document) =>
              document.category === "estimate" ||
              Boolean(document.estimatePositions?.length) ||
              (document.analysis?.positionCount ?? 0) > 0
            ) ? (
              <Button
                size="sm"
                variant="outline"
                disabled={attachEstimateLoading}
                data-testid="attach-existing-customer-estimate"
                onClick={async () => {
                  setAttachEstimateLoading(true);
                  try {
                    await api("/api/zakupki", {
                      method: "POST",
                      body: JSON.stringify({
                        action: "attachCustomerEstimate",
                        id: procurement.id,
                      }),
                    });
                    await refresh();
                    toast.success("Загруженная смета подключена к сравнению");
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : "Не удалось подключить смету");
                  } finally {
                    setAttachEstimateLoading(false);
                  }
                }}
              >
                {attachEstimateLoading ? "Подключаю…" : "Подключить загруженную смету"}
              </Button>
            ) : userHasSection(user, "zakupki") ? (
              <Link href={`/cabinet/zakupki/${procurement.id}`} className="text-[var(--tk-copper-deep)] underline">
                Открыть заявку и загрузить смету
              </Link>
            ) : null}
          </div>
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

      <section className="mt-6 rounded-xl border border-[var(--tk-line)] bg-white/80 p-5" data-testid="calculation-assumptions">
        <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold">
          Из чего сложился расчёт
        </h2>
        <p className="mt-1 max-w-4xl text-sm text-[var(--tk-ink-soft)]">
          Здесь указаны исходные данные и правила расчёта. Объёмы, ставки, коэффициенты,
          региональные условия и накладные отражаются в суммах выше. Пояснения к источникам
          описывают происхождение данных, а технические отметки системы здесь не показываются.
        </p>

        {calc.assumptions.length > 0 && (
          <div className="mt-5">
            <h3 className="text-sm font-semibold text-[var(--tk-ink)]">Исходные данные и правила</h3>
            <div className="mt-2 space-y-2">
              {calc.assumptions.map((assumption, index) => {
                const scope = assumptionScope(assumption);
                return (
                  <div key={`${index}:${assumption}`} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-[var(--tk-line)] bg-white px-3 py-2.5">
                    <p className="min-w-0 flex-1 text-sm text-[var(--tk-ink-soft)]">{assumption}</p>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${scope.className}`}>
                      {scope.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {(() => {
          const flags = [...new Set(calc.dataFlags ?? [])]
            .map((flag) => ({ flag, info: calculationFlagInfo(flag) }))
            .filter((item): item is { flag: string; info: NonNullable<ReturnType<typeof calculationFlagInfo>> } => item.info != null);
          if (flags.length === 0) return null;
          return (
            <div className="mt-5">
              <h3 className="text-sm font-semibold text-[var(--tk-ink)]">Что требует внимания</h3>
              <div className="mt-2 grid gap-2 lg:grid-cols-2">
                {flags.map(({ flag, info }) => (
                  <article
                    key={flag}
                    className={`rounded-lg border px-3 py-2.5 ${info.severity === "review" ? "border-amber-200 bg-amber-50/70" : "border-[var(--tk-line)] bg-white"}`}
                  >
                    <h4 className="text-sm font-semibold text-[var(--tk-ink)]">{info.title}</h4>
                    <p className="mt-1 text-sm text-[var(--tk-ink-soft)]">{info.effect}</p>
                    {info.action && <p className="mt-1 text-sm font-medium text-amber-900">Действие: {info.action}</p>}
                  </article>
                ))}
              </div>
            </div>
          );
        })()}

        {calc.assumptions.length === 0 && (calc.dataFlags ?? []).every((flag) => !calculationFlagInfo(flag)) && (
          <p className="mt-4 rounded-lg bg-muted px-3 py-2 text-sm text-[var(--tk-muted)]">
            Дополнительных исходных условий и проверок для этого расчёта нет.
          </p>
        )}
      </section>
    </div>
  );
}
