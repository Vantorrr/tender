"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMoney, formatNumber } from "@/lib/format";
import { diffDays } from "@/lib/cost-engine";
import type { EstimateLeaf, EstimateStageNode } from "@/lib/hierarchical-estimate";
import { resolveResourceDimensions } from "@/lib/resource-dimensions";
import { rollupResourceSchedule } from "@/lib/resource-schedule-model";
import { stagesToResourceLines } from "@/lib/unified-resource-sync";
import type { GprStage, GprStageResource, ResourceQuantityBasis } from "@/lib/types";
import type { ResourceScheduleParams } from "@/lib/resource-schedule-model";

type ManualResource = Omit<GprStageResource, "id">;

type Props = {
  stages: GprStage[];
  nodes: EstimateStageNode[];
  params: ResourceScheduleParams;
  locked?: boolean;
  onPatchLeaf: (leaf: EstimateLeaf, patch: {
    name?: string;
    unit?: string;
    quantity?: number;
    rate?: number | null;
    hoursPerShift?: number | null;
    shiftsPerDay?: number | null;
    days?: number | null;
    kind?: GprStageResource["kind"];
    quantityBasis?: ResourceQuantityBasis | null;
  }) => Promise<void> | void;
  onAddResources?: (stageId: string, resources: ManualResource[]) => Promise<void>;
  onAddFromDirectory?: () => void;
  onOpenSchedule?: () => void;
};

const KIND_LABEL: Record<GprStageResource["kind"], string> = {
  labor: "Люди",
  equipment: "Техника",
  material: "Материалы",
  bus: "Автобус",
  other: "Прочее",
};

const BASIS_LABEL: Record<ResourceQuantityBasis, string> = {
  count_per_shift: "Кол-во × смены",
  total_hours: "Готовые часы",
  material_qty: "Материал × ставка",
  uncertain: "Уточнить единицу",
};

function cellString(value: string | number | null | undefined) {
  return value == null ? "" : String(value);
}

function GridInput({
  value,
  label,
  type = "text",
  step,
  min,
  placeholder,
  title,
  readOnly,
  onCommit,
}: {
  value: string | number | null | undefined;
  label: string;
  type?: "text" | "number" | "date";
  step?: string;
  min?: number;
  placeholder?: string;
  title?: string;
  readOnly?: boolean;
  onCommit: (value: string) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState(cellString(value));
  const [saving, setSaving] = useState(false);

  return (
    <input
      className="h-8 w-full min-w-[5.25rem] rounded-md border border-transparent bg-transparent px-2 text-right text-sm tabular-nums outline-none transition-colors hover:border-[var(--tk-line)] focus:border-[var(--tk-copper)] focus:bg-white focus:ring-2 focus:ring-[var(--tk-copper)]/15 disabled:text-[var(--tk-muted)]"
      aria-label={label}
      type={type}
      step={step}
      min={min}
      placeholder={placeholder}
      title={title}
      value={draft}
      readOnly={readOnly}
      disabled={saving}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={async () => {
        if (readOnly || draft === cellString(value)) return;
        setSaving(true);
        try {
          await onCommit(draft);
        } catch (error) {
          setDraft(cellString(value));
          toast.error(error instanceof Error ? error.message : "Не удалось сохранить ячейку");
        } finally {
          setSaving(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(cellString(value));
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function toNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value.trim().replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseKind(value: string): GprStageResource["kind"] | null {
  const v = value.trim().toLowerCase();
  if (/^(люди|персонал|труд|labor|people)$/.test(v)) return "labor";
  if (/^(материал|материалы|мтр|material|materials)$/.test(v)) return "material";
  if (/^(автобус|вахтовка|bus)$/.test(v)) return "bus";
  if (/^(техника|оборудование|equipment|машины)$/.test(v)) return "equipment";
  return null;
}

function parseScheduleKind(value: string): GprStageResource["kind"] | null {
  const v = value.trim().toLowerCase().replace(/^↳\s*/, "");
  if (/люди|персонал|труд|labor/.test(v)) return "labor";
  if (/материал|мтр|material/.test(v)) return "material";
  if (/автобус|вахтов|bus/.test(v)) return "bus";
  if (/техник|оборудован|машин|equipment/.test(v)) return "equipment";
  return null;
}

export function parseResourcePaste(raw: string): { rows: ManualResource[]; errors: string[] } {
  const errors: string[] = [];
  const lines = raw.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  const rows: ManualResource[] = [];
  lines.forEach((line, index) => {
    const cols = line.includes("\t") ? line.split("\t") : line.split(";");
    const trimmed = cols.map((x) => x.trim());
    if (trimmed.length >= 16) {
      // Accept copied resource rows from Egor's A:Z sheet as well as the compact paste format below.
      if (/наименование работ|категория/i.test(trimmed[2] ?? "") || /тип строки/i.test(trimmed[8] ?? "")) return;
      if (!/ресурс/i.test(trimmed[8] ?? "")) return;
      const name = (trimmed[2] ?? "").replace(/^↳\s*/, "").trim();
      const kind = parseScheduleKind(trimmed[9] ?? "");
      const rawUnit = trimmed[3] ?? "";
      const rawQty = trimmed[11] ?? "";
      const rawRate = trimmed[12] ?? "";
      const rawHours = trimmed[13] ?? "";
      const rawShifts = trimmed[14] ?? "";
      const rawDays = trimmed[15] ?? "";
      const quantity = toNumber(rawQty);
      const rate = rawRate ? toNumber(rawRate) : null;
      const hours = rawHours ? toNumber(rawHours) : null;
      const shifts = rawShifts ? toNumber(rawShifts) : null;
      const days = rawDays ? toNumber(rawDays) : null;
      const lineNo = index + 1;
      const unit = rawUnit || (kind === "labor" ? "чел" : kind === "bus" ? "маш" : "ед.");
      if (!name || !kind || quantity == null || quantity < 0) {
        errors.push(`Строка ${lineNo}: не удалось прочитать ресурс из колонок A–Z.`);
        return;
      }
      if ((rawRate && rate == null) || (rawHours && hours == null) || (rawShifts && shifts == null) || (rawDays && days == null)) {
        errors.push(`Строка ${lineNo}: проверьте числовые поля ресурса.`);
        return;
      }
      const inferredBasis: ResourceQuantityBasis = kind === "material"
        ? "material_qty"
          : /(?:маш|чел|н)\s*[.·\-]*\s*ч|час/i.test(unit)
          ? "total_hours"
          : "count_per_shift";
      rows.push({
        kind,
        name,
        unit,
        quantity,
        rate,
        quantityBasis: inferredBasis,
        ...(hours != null ? { hoursPerShift: hours } : {}),
        ...(shifts != null ? { shiftsPerDay: shifts } : {}),
        ...(days != null ? { days } : {}),
      });
      return;
    }
    if (index === 0 && /^(наименование|название)(?:\b|\s|$)/i.test(trimmed[0] ?? "")) return;
    const [name, rawKind, unit, rawQty, rawRate, rawHours, rawShifts, rawDays] = trimmed;
    const kind = parseKind(rawKind ?? "");
    const quantity = toNumber(rawQty ?? "");
    const rate = rawRate ? toNumber(rawRate) : null;
    const hours = rawHours ? toNumber(rawHours) : null;
    const shifts = rawShifts ? toNumber(rawShifts) : null;
    const days = rawDays ? toNumber(rawDays) : null;
    const lineNo = index + 1;
    if (!name || !kind || !unit || quantity == null || quantity < 0) {
      errors.push(`Строка ${lineNo}: нужны название, вид, единица и количество.`);
      return;
    }
    if ((rawRate && rate == null) || (rawHours && hours == null) || (rawShifts && shifts == null) || (rawDays && days == null)) {
      errors.push(`Строка ${lineNo}: проверьте числовые поля.`);
      return;
    }
    const inferredBasis: ResourceQuantityBasis = kind === "material"
      ? "material_qty"
      : /(?:маш|чел|н)\s*[.·\-]*\s*ч|час/i.test(unit)
        ? "total_hours"
        : /^(чел|ед|маш|шт|авт|компл)/i.test(unit)
          ? "count_per_shift"
          : "uncertain";
    rows.push({
      kind,
      name,
      unit,
      quantity,
      rate,
      quantityBasis: inferredBasis,
      ...(hours != null ? { hoursPerShift: hours } : {}),
      ...(shifts != null ? { shiftsPerDay: shifts } : {}),
      ...(days != null ? { days } : {}),
    });
  });
  return { rows, errors };
}

function StageTotals({ stage, params }: { stage: GprStage; params: ResourceScheduleParams }) {
  const built = stagesToResourceLines([stage], params);
  const rollup = rollupResourceSchedule({
    params,
    lines: built.lines,
    materialsTotal: built.materialsTotal,
  });
  const total = rollup.byWork[0];
  const hasKnownMaterials = (stage.resources ?? []).some((resource) =>
    resource.kind === "material" && resolveResourceDimensions(resource, stage, params).amount != null
  );
  const partial = built.incomplete.length > 0 || rollup.incomplete.length > 0 || !hasKnownMaterials;
  const values = [
    ["Материалы", hasKnownMaterials ? total?.materials ?? 0 : null],
    ["Люди", total?.labor ?? 0],
    ["Техника", total?.equipment ?? 0],
    ["Прямые", total?.direct ?? 0],
    ["Накладные", total?.overhead ?? 0],
    ["Себестоимость", total?.costWithOh ?? 0],
    ["Прибыль", total?.profit ?? 0],
    ["Итого", total?.total ?? 0],
  ] as const;
  return <>{values.map(([label, amount]) => <td key={label} className="min-w-[8.5rem] border-l border-[var(--tk-line)]/70 px-2 py-2 text-right tabular-nums"><div className="text-[10px] text-[var(--tk-muted)]">{label}{partial ? " · частично" : ""}</div><div className="font-medium" title={amount == null ? "нет данных" : undefined}>{amount == null ? "—" : formatMoney(amount)}</div></td>)}</>;
}

function ResourceCostCells({ leaf, params }: { leaf: EstimateLeaf; params: ResourceScheduleParams }) {
  const amount = leaf.amount;
  const partial = amount == null || leaf.incomplete.length > 0;
  const materials = leaf.kind === "material" ? amount : 0;
  const labor = leaf.kind === "labor" ? amount : 0;
  const equipment = leaf.kind === "equipment" || leaf.kind === "bus" ? amount : 0;
  const supported = leaf.kind === "material" || leaf.kind === "labor" || leaf.kind === "equipment" || leaf.kind === "bus";
  const direct = !supported || [materials, labor, equipment].some((value) => value == null)
    ? null
    : (materials ?? 0) + (labor ?? 0) + (equipment ?? 0);
  const overhead = direct == null ? null : direct * params.overheadRate;
  const cost = direct == null ? null : direct + (overhead ?? 0);
  const profit = cost == null ? null : cost * params.profitMarkupOnCostWithOh;
  const total = cost == null ? null : cost + (profit ?? 0);
  const values = [materials, labor, equipment, direct, overhead, cost, profit, total];
  return <>{values.map((value, index) => <td key={index} className="border-b border-r border-[var(--tk-line)]/70 px-2 py-1 text-right text-[var(--tk-muted)]" title={value == null && partial ? "нет данных" : undefined}>{value == null ? "—" : formatMoney(value)}</td>)}</>;
}

export function SpreadsheetEstimateGrid({
  stages,
  nodes,
  params,
  locked,
  onPatchLeaf,
  onAddResources,
  onAddFromDirectory,
  onOpenSchedule,
}: Props) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showManual, setShowManual] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteErrors, setPasteErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [stageId, setStageId] = useState(stages[0]?.id ?? "");
  const [manual, setManual] = useState({
    name: "",
    kind: "equipment" as GprStageResource["kind"],
    unit: "ед.",
    quantity: "1",
    rate: "",
    basis: "count_per_shift" as ResourceQuantityBasis,
  });

  const selectedStageId = stages.some((stage) => stage.id === stageId)
    ? stageId
    : stages[0]?.id ?? "";

  const visibleNodes = useMemo(() => {
    const query = search.trim().toLowerCase();
    return nodes.filter((node) => {
      if (!query) return true;
      return node.name.toLowerCase().includes(query) || node.groups.some((group) =>
        group.label.toLowerCase().includes(query) || group.leaves.some((leaf) => leaf.name.toLowerCase().includes(query))
      );
    });
  }, [nodes, search]);

  async function addRows(rows: ManualResource[]) {
    if (!selectedStageId || !onAddResources || rows.length === 0) return;
    setSaving(true);
    try {
      await onAddResources(selectedStageId, rows);
      toast.success(`Добавлено строк: ${rows.length}`);
      setManual((current) => ({ ...current, name: "" }));
      setPasteText("");
      setPasteErrors([]);
      setShowPaste(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось добавить строки");
    } finally {
      setSaving(false);
    }
  }

  const tableInput = (leaf: EstimateLeaf, key: "name" | "unit" | "quantity" | "rate" | "hoursPerShift" | "shiftsPerDay" | "days") => {
    const stageResource = leaf.source === "stage_resource";
    const rawValue = key === "name" ? leaf.name
      : key === "unit" ? leaf.unit
      : key === "quantity" ? leaf.quantity
      : key === "rate" ? leaf.rate
      : key === "hoursPerShift" ? leaf.hoursPerShift
      : key === "shiftsPerDay" ? leaf.shiftsPerDay
      : leaf.days;
    return <GridInput
      key={`${leaf.id}-${key}-${cellString(rawValue)}`}
      value={rawValue}
      label={`${key} · ${leaf.name}`}
      type={key === "name" || key === "unit" ? "text" : "number"}
      step={key === "quantity" || key === "rate" ? "any" : "1"}
      min={0}
      placeholder={key === "rate" ? "—" : undefined}
      title={key === "rate" && rawValue == null ? "нет данных" : undefined}
      readOnly={locked || (!stageResource && key !== "quantity" && key !== "rate")}
      onCommit={async (raw) => {
        if (key === "name" || key === "unit") {
          if (!stageResource) return;
          await onPatchLeaf(leaf, { [key]: raw.trim() } as Parameters<typeof onPatchLeaf>[1]);
          return;
        }
        const parsed = raw.trim() ? toNumber(raw) : null;
        if (raw.trim() && parsed == null) throw new Error("Введите число");
        if (key === "rate") await onPatchLeaf(leaf, { rate: parsed });
        else if (key === "quantity") await onPatchLeaf(leaf, { quantity: parsed ?? 0 });
        else if (stageResource) await onPatchLeaf(leaf, { [key]: parsed } as Parameters<typeof onPatchLeaf>[1]);
      }}
    />;
  };

  return (
    <section className="mb-5" data-testid="resource-spreadsheet">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-medium">Ресурсный черновик · таблица</h3>
          <p className="mt-1 text-xs text-[var(--tk-muted)]">Редактирование как в привычной таблице. Формулы и суммы пересчитываются после выхода из ячейки.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {onOpenSchedule ? <Button size="sm" variant="outline" onClick={onOpenSchedule}>Открыть календарь ГПР</Button> : null}
          {!locked && onAddResources ? <Button size="sm" variant="outline" onClick={() => setShowManual((v) => !v)}>+ Строка</Button> : null}
          {!locked && onAddResources ? <Button size="sm" variant="outline" onClick={() => setShowPaste((v) => !v)}>Вставить из таблицы</Button> : null}
          {!locked && onAddFromDirectory ? <Button size="sm" onClick={onAddFromDirectory}>Добавить из справочника</Button> : null}
        </div>
      </div>

      {showManual && !locked ? (
        <div className="mb-3 grid gap-2 rounded-xl border border-[var(--tk-line)] bg-white p-3 sm:grid-cols-4 lg:grid-cols-8" data-testid="manual-resource-form">
          <label className="text-xs text-[var(--tk-muted)] sm:col-span-2">Этап<select className="mt-1 h-9 w-full rounded-md border bg-white px-2 text-sm text-[var(--tk-ink)]" value={selectedStageId} onChange={(e) => setStageId(e.target.value)}>{stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label>
          <label className="text-xs text-[var(--tk-muted)] sm:col-span-2">Наименование<Input className="mt-1 h-9 text-sm" value={manual.name} onChange={(e) => setManual((v) => ({ ...v, name: e.target.value }))} /></label>
          <label className="text-xs text-[var(--tk-muted)]">Вид<select className="mt-1 h-9 w-full rounded-md border bg-white px-2 text-sm text-[var(--tk-ink)]" value={manual.kind} onChange={(e) => { const kind = e.target.value as GprStageResource["kind"]; setManual((v) => ({ ...v, kind, basis: kind === "material" ? "material_qty" : v.basis === "material_qty" ? "count_per_shift" : v.basis })); }}>{Object.entries(KIND_LABEL).filter(([value]) => value !== "other").map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="text-xs text-[var(--tk-muted)]">Ед.<Input className="mt-1 h-9 text-sm" value={manual.unit} onChange={(e) => setManual((v) => ({ ...v, unit: e.target.value }))} /></label>
          <label className="text-xs text-[var(--tk-muted)]">Количество<Input className="mt-1 h-9 text-sm" type="number" min={0} step="any" value={manual.quantity} onChange={(e) => setManual((v) => ({ ...v, quantity: e.target.value }))} /></label>
          <label className="text-xs text-[var(--tk-muted)]">Ставка, ₽<Input className="mt-1 h-9 text-sm" type="number" min={0} step="any" placeholder="—" title="нет данных" value={manual.rate} onChange={(e) => setManual((v) => ({ ...v, rate: e.target.value }))} /></label>
          <label className="text-xs text-[var(--tk-muted)] sm:col-span-2">Формула количества<select className="mt-1 h-9 w-full rounded-md border bg-white px-2 text-sm text-[var(--tk-ink)]" value={manual.basis} onChange={(e) => setManual((v) => ({ ...v, basis: e.target.value as ResourceQuantityBasis }))}>{Object.entries(BASIS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <div className="flex items-end"><Button disabled={saving || !manual.name.trim() || !selectedStageId} onClick={() => { const quantity = toNumber(manual.quantity); const rate = toNumber(manual.rate); if (quantity == null || quantity < 0 || (manual.rate.trim() && rate == null)) { toast.error("Проверьте количество и ставку"); return; } const stage = stages.find((x) => x.id === selectedStageId); const inferredDays = stage ? Math.max(1, diffDays(stage.start, stage.end) + 1) : 1; void addRows([{ kind: manual.kind, name: manual.name.trim(), unit: manual.unit.trim() || "ед.", quantity, rate, quantityBasis: manual.basis, hoursPerShift: params.hoursPerShift, shiftsPerDay: manual.kind === "labor" ? params.personnelShiftsPerDay : params.equipmentShiftsPerDay, days: inferredDays }]); }}>Добавить</Button></div>
        </div>
      ) : null}

      {showPaste && !locked ? (
        <div className="mb-3 rounded-xl border border-[var(--tk-line)] bg-white p-3" data-testid="resource-paste-panel">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <label className="text-sm font-medium" htmlFor="resource-paste">Вставьте строки без заголовка или с заголовком</label>
            <label className="text-xs text-[var(--tk-muted)]">Этап для вставки<select className="ml-2 h-8 rounded-md border bg-white px-2 text-sm text-[var(--tk-ink)]" value={selectedStageId} onChange={(e) => setStageId(e.target.value)}>{stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label>
          </div>
          <p className="mb-2 text-xs text-[var(--tk-muted)]">Можно вставить строки из листа Егора A–Z целиком (ресурсные строки подхватятся автоматически) или компактный формат: Наименование · Вид · Ед. · Количество · Ставка · Часов/смена · Смен/сутки · Дней. Разделитель — табуляция.</p>
          <textarea id="resource-paste" className="min-h-28 w-full rounded-lg border border-[var(--tk-line)] bg-white p-3 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-[var(--tk-copper)]/30" value={pasteText} onChange={(e) => { setPasteText(e.target.value); setPasteErrors([]); }} placeholder={'Дорожная смесь\tМатериалы\tт\t12\t8500\t\t\t\nВахтовый автобус\tАвтобус\tмаш\t2\t2650\t11\t1\t20'} />
          {pasteErrors.length ? <ul className="mt-2 text-xs text-red-700">{pasteErrors.map((error) => <li key={error}>{error}</li>)}</ul> : null}
          <div className="mt-2 flex gap-2"><Button disabled={saving || !pasteText.trim() || !selectedStageId} onClick={() => { const parsed = parseResourcePaste(pasteText); setPasteErrors(parsed.errors); if (parsed.rows.length && !parsed.errors.length) void addRows(parsed.rows); }}>{saving ? "Добавление…" : "Добавить строки"}</Button><Button variant="outline" onClick={() => { setShowPaste(false); setPasteErrors([]); }}>Закрыть</Button></div>
        </div>
      ) : null}

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <Input className="h-9 max-w-sm" placeholder="Поиск по работам и ресурсам" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="text-xs text-[var(--tk-muted)]">L–P — ввод · Q–Z — расчёт. Enter сохраняет ячейку.</span>
      </div>

      <div className="overflow-auto rounded-xl border border-[var(--tk-line)] bg-white" data-testid="resource-grid-scroll">
        <table className="min-w-[2400px] border-separate border-spacing-0 text-xs tabular-nums">
          <thead className="sticky top-0 z-20 bg-stone-100 text-[var(--tk-ink)]">
            <tr>
              {["№", "Раздел", "Работа / ресурс", "Ед.", "Объём", "Дл., дн.", "Начало", "Окончание", "Тип", "Категория", "Основание", "Кол-во", "Ставка, ₽", "ч/смена", "смен/сутки", "дни", "часы", "Сумма, ₽", "Материалы", "Люди", "Техника", "Прямые", "Накладные", "Себестоимость", "Прибыль", "Итого"].map((heading, index) => <th key={heading} style={index < 3 ? { left: [0, 72, 264][index] } : undefined} className={`sticky top-0 border-b border-r border-[var(--tk-line)] px-2 py-2 text-left font-medium ${index < 3 ? "z-30 bg-stone-100" : "z-20"} ${index === 0 ? "w-[72px] min-w-[72px]" : index === 1 ? "w-48 min-w-48" : index === 2 ? "w-64 min-w-64" : "min-w-[7rem]"}`}>{heading}</th>)}
            </tr>
          </thead>
          <tbody>
            {visibleNodes.flatMap((node, workIndex) => {
              const stage = stages.find((item) => item.id === node.id);
              const isUnbound = node.id === "_unbound";
              const isCollapsed = Boolean(collapsed[node.id]);
              const query = search.trim().toLowerCase();
              const leaves = node.groups.flatMap((group) => group.leaves.map((leaf) => ({ leaf, label: group.label })));
              const filteredLeaves = query ? leaves.filter(({ leaf, label }) => `${node.name} ${leaf.name} ${label}`.toLowerCase().includes(query)) : leaves;
              const plannedDays = stage ? Math.max(1, diffDays(stage.start, stage.end) + 1) : null;
              const workLeaves = filteredLeaves.map(({ leaf, label }) => {
                const resolved = stage && leaf.source === "stage_resource" ? resolveResourceDimensions(stage.resources?.find((r) => r.id === leaf.id) ?? ({ id: leaf.id, kind: "other", name: leaf.name, unit: leaf.unit, quantity: leaf.quantity, rate: leaf.rate } as GprStageResource), stage, params) : null;
                const row = <tr key={leaf.id} className="group bg-white hover:bg-amber-50/40" data-testid={`resource-grid-row-${leaf.id}`}>
                  <td style={{ left: 0 }} className="sticky z-10 w-[72px] min-w-[72px] border-b border-r border-[var(--tk-line)]/70 bg-white px-2 py-1 text-[var(--tk-muted)]">↳</td>
                  <td style={{ left: 72 }} className="sticky z-10 w-48 min-w-48 border-b border-r border-[var(--tk-line)]/70 bg-white px-2 py-1">{node.name}</td>
                  <td style={{ left: 264 }} className="sticky z-10 w-64 min-w-64 border-b border-r border-[var(--tk-line)]/70 bg-white px-1 py-1">{tableInput(leaf, "name")}</td>
                  <td className="border-b border-r border-[var(--tk-line)]/70 px-1 py-1">{tableInput(leaf, "unit")}</td>
                  <td className="border-b border-r border-[var(--tk-line)]/70 px-1 py-1 text-right">{formatNumber(leaf.quantity)}</td>
                  <td className="border-b border-r border-[var(--tk-line)]/70 px-2 py-1 text-right">{plannedDays ?? "—"}</td>
                  <td className="border-b border-r border-[var(--tk-line)]/70 px-2 py-1">{stage?.start ?? "—"}</td>
                  <td className="border-b border-r border-[var(--tk-line)]/70 px-2 py-1">{stage?.end ?? "—"}</td>
                  <td className="border-b border-r border-[var(--tk-line)]/70 px-2 py-1">РЕСУРС</td>
                  <td className="border-b border-r border-[var(--tk-line)]/70 px-1 py-1">{stage && leaf.source === "stage_resource" && !locked ? <select aria-label={`Категория · ${leaf.name}`} className="h-8 min-w-[7.5rem] rounded-md border border-transparent bg-transparent px-1 hover:border-[var(--tk-line)] focus:border-[var(--tk-copper)]" value={stage.resources?.find((r) => r.id === leaf.id)?.kind ?? leaf.kind} onChange={(e) => { const kind = e.target.value as GprStageResource["kind"]; void onPatchLeaf(leaf, { kind, quantityBasis: kind === "material" ? "material_qty" : null }); }}>{Object.entries(KIND_LABEL).filter(([kind]) => kind !== "other").map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select> : label}</td>
                  <td className="border-b border-r border-[var(--tk-line)]/70 px-1 py-1">{stage && leaf.source === "stage_resource" && !locked ? <select aria-label={`Основание количества · ${leaf.name}`} className="h-8 min-w-[9rem] rounded-md border border-transparent bg-transparent px-1 hover:border-[var(--tk-line)] focus:border-[var(--tk-copper)]" value={resolved?.basis ?? "uncertain"} onChange={(e) => { const quantityBasis = e.target.value as ResourceQuantityBasis; void onPatchLeaf(leaf, { quantityBasis }); }}>{Object.entries(BASIS_LABEL).map(([basis, label]) => <option key={basis} value={basis}>{label}</option>)}</select> : resolved ? BASIS_LABEL[resolved.basis] : "—"}</td>
                  <td className="border-b border-r border-[var(--tk-line)]/70 px-1 py-1">{tableInput(leaf, "quantity")}</td>
                  <td className="border-b border-r border-[var(--tk-line)]/70 px-1 py-1">{tableInput(leaf, "rate")}</td>
                  <td className="border-b border-r border-[var(--tk-line)]/70 px-1 py-1">{stage && leaf.source === "stage_resource" ? tableInput(leaf, "hoursPerShift") : "—"}</td>
                  <td className="border-b border-r border-[var(--tk-line)]/70 px-1 py-1">{stage && leaf.source === "stage_resource" ? tableInput(leaf, "shiftsPerDay") : "—"}</td>
                  <td className="border-b border-r border-[var(--tk-line)]/70 px-1 py-1">{stage && leaf.source === "stage_resource" ? tableInput(leaf, "days") : "—"}</td>
                  <td className="border-b border-r border-[var(--tk-line)]/70 px-2 py-1 text-right">{leaf.hoursQ == null ? "—" : formatNumber(leaf.hoursQ)}</td>
                  <td className={`border-b border-r border-[var(--tk-line)]/70 px-2 py-1 text-right font-medium ${leaf.amount == null ? "text-amber-800" : ""}`} title={leaf.amount == null ? "нет данных" : undefined}>{leaf.amount == null ? "—" : formatMoney(leaf.amount)}</td>
                  <ResourceCostCells leaf={leaf} params={params} />
                </tr>;
                return row;
              });
              const workRow = <tr key={`work-${node.id}`} className="bg-stone-50 font-medium" data-testid={`resource-grid-work-${node.id}`}>
                <td style={{ left: 0 }} className="sticky z-10 w-[72px] min-w-[72px] border-b border-r border-[var(--tk-line)] bg-stone-50 px-2 py-2 text-[var(--tk-muted)]">{workIndex + 1}</td>
                <td style={{ left: 72 }} className="sticky z-10 w-48 min-w-48 border-b border-r border-[var(--tk-line)] bg-stone-50 px-2 py-2"><button type="button" className="text-left hover:underline" onClick={() => setCollapsed((current) => ({ ...current, [node.id]: !current[node.id] }))}>{isCollapsed ? "▸" : "▾"} {node.name}</button></td>
                <td style={{ left: 264 }} className="sticky z-10 w-64 min-w-64 border-b border-r border-[var(--tk-line)] bg-stone-50 px-2 py-2">{stage?.workName || (isUnbound ? "Позиции расчёта" : node.name)}</td>
                <td className="border-b border-r border-[var(--tk-line)] px-2 py-2 text-[var(--tk-muted)]">—</td>
                <td className="border-b border-r border-[var(--tk-line)] px-2 py-2 text-right" title={stage?.planVolume == null ? "нет данных" : undefined}>{stage?.planVolume == null ? "—" : formatNumber(stage.planVolume)}</td>
                <td className="border-b border-r border-[var(--tk-line)] px-2 py-2 text-right">{plannedDays ?? "—"}</td>
                <td className="border-b border-r border-[var(--tk-line)] px-2 py-2">{stage?.start ?? "—"}</td>
                <td className="border-b border-r border-[var(--tk-line)] px-2 py-2">{stage?.end ?? "—"}</td>
                <td className="border-b border-r border-[var(--tk-line)] px-2 py-2">РАБОТА</td>
                <td className="border-b border-r border-[var(--tk-line)] px-2 py-2">{node.incomplete ? "Частично" : ""}</td>
                <td className="border-b border-r border-[var(--tk-line)] px-2 py-2">{filteredLeaves.length} ресурсов</td>
                <td colSpan={7} className="border-b border-r border-[var(--tk-line)] px-2 py-2 text-right text-[var(--tk-muted)]">Q–R строки · S–Z расчёт</td>
                {stage ? <StageTotals stage={stage} params={params} /> : Array.from({ length: 8 }, (_, i) => <td key={i} className="border-b border-r border-[var(--tk-line)] px-2 py-2">—</td>)}
              </tr>;
              return isCollapsed ? [workRow] : [workRow, ...workLeaves];
            })}
            {visibleNodes.length === 0 ? <tr><td className="p-6 text-sm text-[var(--tk-muted)]" colSpan={26}>Ничего не найдено.</td></tr> : null}
            <tr className="sticky bottom-0 z-10 bg-stone-100 font-semibold"><td colSpan={18} className="border-t border-[var(--tk-line)] px-3 py-3">ИТОГО ПО РЕСУРСНОМУ ЧЕРНОВИКУ · см. сводку над таблицей</td><td colSpan={8} className="border-t border-[var(--tk-line)] px-3 py-3 text-right">Итоги считаются общим модулем из тех же строк. Неподтверждённые ставки помечены.</td></tr>
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-[var(--tk-muted)]">Ставки, количество, часы, смены и дни редактируются в строке. Даты этапа двигайте в календаре ГПР: зависимости сдвинутся вместе с этапом, а ресурсная стоимость обновится автоматически.</p>
    </section>
  );
}
