"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import type {
  ClientNormCatalogSummary,
  ClientNormKind,
  ClientNormWarning,
  HaulLegRow,
  LaborNormRow,
  OutputNormRow,
  SiteBenchmarkRow,
} from "@/lib/client-norms";
import { formatMoney } from "@/lib/format";

const TAB_TITLE: Record<ClientNormKind, string> = {
  output: "Земля и дороги",
  labor: "Металлоконструкции",
  tkm: "т·км и час техники",
  sites: "Участки 0-68 и 88-127",
};

const KIND_LABEL: Record<SiteBenchmarkRow["kind"], string> = {
  plan: "План / факт",
  crew: "Люди и техника",
  operation: "Фото дня",
  resolution: "Резолюция",
  benchmark: "Ориентир за сутки",
  typo: "Опечатка исходника",
};

const EMPTY_FILTERS = {
  q: "",
  work: "",
  mechanism: "",
  section: "",
  size: "",
  operation: "",
  shoulder: "",
  site: "",
};

type Filters = typeof EMPTY_FILTERS;

interface QueryResponse {
  catalog: ClientNormCatalogSummary & { header: Record<string, unknown> };
  total: number;
  limit: number;
  offset: number;
  facets: {
    sections?: { name: string; count: number }[];
    operations?: { number: number; title: string; count: number }[];
    shoulders?: number[];
    sites?: { code: string; count: number }[];
  };
  rows: Array<OutputNormRow | LaborNormRow | HaulLegRow | SiteBenchmarkRow>;
  participatesInOfficialCost: false;
}

function showNum(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 4 }).format(value);
}

function Num({ value }: { value: number | null | undefined }) {
  if (value == null || !Number.isFinite(value)) return <>—</>;
  return <span title={String(value)}>{showNum(value)}</span>;
}

function countLabel(summary: ClientNormCatalogSummary | undefined, kind: ClientNormKind): string {
  if (!summary) return "";
  const counts = summary.counts;
  if (kind === "output") return `${counts.sections ?? 0} / ${counts.works ?? 0} / ${counts.rows ?? 0}`;
  if (kind === "labor") return `${counts.operations ?? 0} / ${counts.rows ?? 0}`;
  if (kind === "tkm") return `${counts.hauls ?? 0} плеч`;
  return "0-68 · 88-127";
}

export function ClientNormsPanel() {
  const [kind, setKind] = useState<ClientNormKind>("output");
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);
  const [catalogs, setCatalogs] = useState<ClientNormCatalogSummary[]>([]);
  const [payload, setPayload] = useState<QueryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reimporting, setReimporting] = useState(false);

  const draftKey = JSON.stringify(draft);

  useEffect(() => {
    const timer = setTimeout(() => setApplied(draft), 250);
    return () => clearTimeout(timer);
  }, [draft, draftKey]);

  useEffect(() => {
    setOffset(0);
  }, [draftKey, kind]);

  useEffect(() => {
    let cancel = false;
    api<{ catalogs: ClientNormCatalogSummary[] }>("/api/spravochniki/client-norms")
      .then((data) => {
        if (!cancel) setCatalogs(data.catalogs);
      })
      .catch(() => {
        /* the table request reports the same failure */
      });
    return () => {
      cancel = true;
    };
  }, [payload?.catalog.importedAt]);

  useEffect(() => {
    let cancel = false;
    const params = new URLSearchParams({
      catalog: kind,
      limit: kind === "sites" || kind === "tkm" ? "100" : "40",
      offset: String(offset),
    });
    for (const [key, value] of Object.entries(applied)) {
      if (value.trim()) params.set(key, value.trim());
    }
    api<QueryResponse>(`/api/spravochniki/client-norms?${params.toString()}`)
      .then((data) => {
        if (cancel) return;
        setPayload(data);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (cancel) return;
        setError(reason instanceof Error ? reason.message : "Не удалось открыть справочник");
      });
    return () => {
      cancel = true;
    };
  }, [kind, applied, offset]);

  async function reimport() {
    setReimporting(true);
    try {
      await api("/api/spravochniki/client-norms", {
        method: "POST",
        body: JSON.stringify({ action: "reimport" }),
      });
      setPayload(null);
      setApplied({ ...applied });
      toast.success("Справочники прочитаны из fixtures ещё раз, числа не дублировались");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Импорт не выполнен");
    } finally {
      setReimporting(false);
    }
  }

  const ready = payload?.catalog.kind === kind ? payload : null;
  const summary = catalogs.find((item) => item.kind === kind) ?? ready?.catalog;
  const warnings = ready?.catalog.warnings ?? [];
  const header = ready?.catalog.header ?? {};
  const from = ready && ready.total > 0 ? ready.offset + 1 : 0;
  const to = ready ? Math.min(ready.total, ready.offset + ready.rows.length) : 0;

  return (
    <div>
      <PageHeader
        title="Нормы выработки и справочники клиента"
        description="Четыре источника клиента. Это таблица справочников за смену 11 часов или эталон участка. В официальный расчёт себестоимости и в ГПР строки сами не записываются."
        actions={
          <>
            <Button
              variant="outline"
              data-testid="client-norm-reimport"
              disabled={reimporting}
              onClick={() => void reimport()}
            >
              {reimporting ? "Импорт…" : "Повторить импорт"}
            </Button>
            <Link
              href="/cabinet/spravochniki"
              className="inline-flex h-9 items-center rounded-lg bg-secondary px-3 text-sm font-medium"
            >
              К справочникам расчёта
            </Link>
          </>
        }
      />

      <Tabs
        value={kind}
        onValueChange={(value) => {
          setKind(value as ClientNormKind);
          setDraft(EMPTY_FILTERS);
          setApplied(EMPTY_FILTERS);
          setPayload(null);
        }}
      >
        <TabsList
          data-testid="client-norm-tabs"
          className="!h-auto w-full max-w-full flex-wrap justify-start gap-1 py-1"
        >
          {(Object.keys(TAB_TITLE) as ClientNormKind[]).map((item) => (
            <TabsTrigger key={item} value={item} className="!h-auto flex-none px-2.5 py-1">
              {TAB_TITLE[item]}
              <span className="ml-1 text-[10px] opacity-70">
                {countLabel(catalogs.find((catalog) => catalog.kind === item), item)}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={kind} className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge data-testid="client-norm-shift">
              {!summary ? "Загрузка…" : summary.shiftHours === 11 ? "Смена 11 ч" : "Эталон за сутки, не смена 11 ч"}
            </Badge>
            <Badge variant="outline">Не входит в себестоимость</Badge>
            {typeof header.sourceLine === "string" && header.sourceLine ? (
              <span className="text-xs text-[var(--tk-muted)]">{header.sourceLine}</span>
            ) : null}
          </div>

          <WarningList warnings={warnings} />
          {kind === "tkm" ? <TkmBanner header={header} /> : null}
          {kind === "labor" ? <LaborBanner header={header} /> : null}
          {kind === "sites" ? <SitesBanner header={header} /> : null}

          <div className="flex flex-wrap gap-2">
            <Input
              data-testid="client-norm-search"
              className="max-w-xs"
              value={draft.q}
              placeholder="Поиск"
              onChange={(event) => setDraft({ ...draft, q: event.target.value })}
            />
            {kind === "output" ? (
              <>
                <FilterSelect
                  value={draft.section}
                  onChange={(section) => setDraft({ ...draft, section })}
                  placeholder="Раздел"
                  options={(ready?.facets.sections ?? []).map((section) => ({
                    value: section.name,
                    label: section.name,
                  }))}
                />
                <Input
                  className="max-w-[220px]"
                  value={draft.work}
                  placeholder="Работа"
                  onChange={(event) => setDraft({ ...draft, work: event.target.value })}
                />
                <Input
                  className="max-w-[220px]"
                  value={draft.mechanism}
                  placeholder="Механизм"
                  onChange={(event) => setDraft({ ...draft, mechanism: event.target.value })}
                />
              </>
            ) : null}
            {kind === "labor" ? (
              <>
                <FilterSelect
                  value={draft.operation}
                  onChange={(operation) => setDraft({ ...draft, operation })}
                  placeholder="Операция"
                  options={(ready?.facets.operations ?? []).map((operation) => ({
                    value: String(operation.number),
                    label: `${operation.number}. ${operation.title}`,
                  }))}
                />
                <Input
                  className="max-w-[220px]"
                  value={draft.work}
                  placeholder="Материал"
                  onChange={(event) => setDraft({ ...draft, work: event.target.value })}
                />
                <Input
                  className="max-w-[180px]"
                  value={draft.size}
                  placeholder="Типоразмер"
                  onChange={(event) => setDraft({ ...draft, size: event.target.value })}
                />
              </>
            ) : null}
            {kind === "tkm" ? (
              <FilterSelect
                value={draft.shoulder}
                onChange={(shoulder) => setDraft({ ...draft, shoulder })}
                placeholder="Плечо, км"
                options={(ready?.facets.shoulders ?? []).map((km) => ({
                  value: String(km),
                  label: `${km} км`,
                }))}
              />
            ) : null}
            {kind === "sites" ? (
              <>
                <FilterSelect
                  value={draft.site}
                  onChange={(site) => setDraft({ ...draft, site })}
                  placeholder="Шифр участка"
                  options={(ready?.facets.sites ?? []).map((site) => ({
                    value: site.code,
                    label: site.code,
                  }))}
                />
                <Input
                  className="max-w-[240px]"
                  value={draft.work}
                  placeholder="Работа, роль, типоразмер"
                  onChange={(event) => setDraft({ ...draft, work: event.target.value })}
                />
              </>
            ) : null}
          </div>

          {error ? (
            <p className="text-sm text-red-700">{error}</p>
          ) : (
            <p className="text-xs text-[var(--tk-muted)]">
              {!ready
                ? "Загрузка справочника…"
                : `Строки ${from}–${to} из ${ready.total}`}
            </p>
          )}

          <div className="overflow-x-auto rounded-xl border border-[var(--tk-line)] bg-white/80">
            {kind === "output" ? <OutputTable rows={(ready?.rows ?? []) as OutputNormRow[]} /> : null}
            {kind === "labor" ? <LaborTable rows={(ready?.rows ?? []) as LaborNormRow[]} /> : null}
            {kind === "tkm" ? <HaulTable rows={(ready?.rows ?? []) as HaulLegRow[]} /> : null}
            {kind === "sites" ? <SitesTable rows={(ready?.rows ?? []) as SiteBenchmarkRow[]} /> : null}
          </div>

          {ready && ready.total > ready.limit ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={offset <= 0}
                onClick={() => setOffset(Math.max(0, offset - (ready?.limit ?? 40)))}
              >
                Назад
              </Button>
              <Button
                variant="outline"
                disabled={!ready || offset + ready.limit >= ready.total}
                onClick={() => setOffset(offset + (ready?.limit ?? 40))}
              >
                Дальше
              </Button>
            </div>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function FilterSelect({
  value,
  onChange,
  placeholder,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      className="h-9 max-w-full rounded-lg border border-[var(--tk-line)] bg-white px-2 text-sm"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function WarningList({ warnings }: { warnings: ClientNormWarning[] }) {
  const anomalies = warnings.filter((warning) => warning.code === "scan_anomaly");
  const shown = warnings.filter((warning) => warning.code !== "scan_anomaly");
  if (shown.length === 0 && anomalies.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="client-norm-warning">
      {shown.map((warning) => (
        <div
          key={`${warning.code}-${warning.text.slice(0, 80)}`}
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"
        >
          {warning.text}
        </div>
      ))}
      {anomalies.length > 0 ? (
        <details className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <summary>Дефекты скана, числа не исправлены ({anomalies.length})</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {anomalies.map((warning) => (
              <li key={warning.text}>{warning.text}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function TkmBanner({ header }: { header: Record<string, unknown> }) {
  const hour = header.equipmentHourCost as {
    tariff?: number;
    overheadRateInFile?: number;
    profitRateInFile?: number;
    totalFormula?: string;
    totalComputed?: number;
    hoursPerShift?: number;
  } | undefined;
  const issue = header.formulaIssue as {
    cell?: string;
    writtenFormula?: string;
    ifProfitOnTariffPlusOverhead?: number;
    problem?: string;
  } | undefined;
  const payload = header.payloadTonnes as { capacityTonnes?: number; loadFactor?: number; resultTonnes?: number } | undefined;
  if (!hour || !issue) return null;
  return (
    <div className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4 text-sm">
      <p>
        Груз {showNum(payload?.capacityTonnes)} т × {showNum(payload?.loadFactor)} = {showNum(payload?.resultTonnes)} т.
        Тариф часа {formatMoney(hour.tariff)}. В этом файле НР {showNum(hour.overheadRateInFile)} и прибыль {showNum(hour.profitRateInFile)}, смена {hour.hoursPerShift} ч.
        Итог часа по записанной формуле: {formatMoney(hour.totalComputed)}.
      </p>
      <p className="mt-2">
        Формула ячейки {issue.cell}: <code className="rounded bg-amber-100 px-1">{issue.writtenFormula}</code>
      </p>
      <p className="mt-2 text-[var(--tk-muted)]">
        {issue.problem} Если бы прибыль 20% бралась от тарифа с накладными, получилось бы {formatMoney(issue.ifProfitOnTariffPlusOverhead)} — в файле этого нет, число не подменено.
        Коэффициенты 40% и 20% этого листа не общефирменные. Формула расчёта пакета остаётся прежней: НР 43% от прямых, непредвиденные 10% от C0, прибыль 40% от C0.
      </p>
    </div>
  );
}

function LaborBanner({ header }: { header: Record<string, unknown> }) {
  const notes = Array.isArray(header.notes) ? header.notes as Array<{ number?: number; text?: string; complete?: boolean; note?: string | null }> : [];
  const note2 = notes.find((note) => note.number === 2);
  const cut = Array.isArray(header.operations)
    ? (header.operations as Array<{ explanationNote?: string | null }>).find((item) => item.explanationNote)?.explanationNote
    : null;
  return (
    <div className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4 text-sm">
      <p>Пять операций, нормы за смену 11 часов. Единицы — как в скане.</p>
      {note2 ? (
        <p className="mt-2">
          Примечание 2 обрывается: «{note2.text}». {note2.note} Подсобные часы не подставлены.
        </p>
      ) : null}
      {cut ? <p className="mt-2 text-[var(--tk-muted)]">{cut}</p> : null}
    </div>
  );
}

function SitesBanner({ header }: { header: Record<string, unknown> }) {
  const daily = header.daily as {
    orchMountedPerDay_fromTimeStudy?: number;
    supportsExtendedPerDay_fromTimeStudy?: number;
    extendingOneRigelHoursPerZveno?: number;
    pipeline?: {
      note?: string;
      oneWelderJointsPerDay?: number;
      oneWelderMetersPerDay?: number;
      fourWeldersJointsPerDay?: number;
      fourWeldersMetersPerDay?: number;
    };
    project_0_68_resolution?: { februaryPlanOrch?: number; currentOutputOrchPerDay?: number; planOrchPerDay?: number; shiftsMentioned?: string };
    project_88_127_resolution?: { februaryPlanOrch?: number; currentOutputOrchPerDay?: number; planOrchPerDay?: number };
  } | undefined;
  const typo = header.typo118 as { cell?: string; valueInCell?: number; valueIfDividedBy60Hours?: number; explanation?: string } | undefined;
  if (!daily) return null;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4 text-sm">
        <h2 className="font-medium">Шифр 0-68</h2>
        <p className="mt-2">ОРЧ по хронометражу: {showNum(daily.orchMountedPerDay_fromTimeStudy)} шт/сутки. Нарощено опор: {showNum(daily.supportsExtendedPerDay_fromTimeStudy)} шт/сутки. Наращивание ригеля (C38): {showNum(daily.extendingOneRigelHoursPerZveno)} ч.</p>
        <p className="mt-2">{daily.pipeline?.note}</p>
        <p className="mt-2">Резолюция: факт {showNum(daily.project_0_68_resolution?.currentOutputOrchPerDay)} шт/сутки, план {showNum(daily.project_0_68_resolution?.planOrchPerDay)}, февраль {showNum(daily.project_0_68_resolution?.februaryPlanOrch)}. {daily.project_0_68_resolution?.shiftsMentioned}</p>
      </div>
      <div className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4 text-sm">
        <h2 className="font-medium">Шифр 88-127</h2>
        <p className="mt-2">ОРЧ: факт {showNum(daily.project_88_127_resolution?.currentOutputOrchPerDay)} шт/сутки, план {showNum(daily.project_88_127_resolution?.planOrchPerDay)}, февраль {showNum(daily.project_88_127_resolution?.februaryPlanOrch)}. Бурение — в строках плана, не в общем ценнике.</p>
        <p className="mt-2">День и ночь в резолюциях не перезаписывают профиль «2×11 без выходных».</p>
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2" data-testid="client-norm-c55">
          {typo?.cell}: в ячейке {typo?.valueInCell}. Подпись говорит «час», формула суммирует минуты. Если разделить на 60, было бы около {showNum(typo?.valueIfDividedBy60Hours)} ч — исходное значение {typo?.valueInCell} не заменено.
        </p>
      </div>
    </div>
  );
}

function OutputTable({ rows }: { rows: OutputNormRow[] }) {
  return (
    <Table data-testid="client-norm-table">
      <TableHeader>
        <TableRow>
          <TableHead>Раздел</TableHead>
          <TableHead>Работа</TableHead>
          <TableHead>Ед.</TableHead>
          <TableHead>Грунт</TableHead>
          <TableHead>Механизм</TableHead>
          <TableHead>Норма маш.-ч</TableHead>
          <TableHead>Звено</TableHead>
          <TableHead>За 1 ч</TableHead>
          <TableHead>За смену 11 ч</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.excelRow}-${row.workName}`}>
            <TableCell>{row.section}</TableCell>
            <TableCell>{row.workName}</TableCell>
            <TableCell>{row.unit ?? "—"}</TableCell>
            <TableCell>{[row.soilName, row.soilGroup].filter(Boolean).join(" / ") || "—"}</TableCell>
            <TableCell>{row.mechanism ?? "—"}</TableCell>
            <TableCell><Num value={row.machineHoursNorm} /></TableCell>
            <TableCell>{row.crew ?? "—"}</TableCell>
            <TableCell><Num value={row.productivityPerHour} /></TableCell>
            <TableCell><Num value={row.productivityPerShift11h} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function LaborTable({ rows }: { rows: LaborNormRow[] }) {
  return (
    <Table data-testid="client-norm-table">
      <TableHeader>
        <TableRow>
          <TableHead>Операция</TableHead>
          <TableHead>Материал</TableHead>
          <TableHead>Типоразмер</TableHead>
          <TableHead>Ед.</TableHead>
          <TableHead>K</TableHead>
          <TableHead>За смену 11 ч</TableHead>
          <TableHead>Время, ч</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={`${row.operationNumber}-${row.material}-${row.size}-${index}`} className={row.sourceAnomaly ? "bg-amber-50" : undefined}>
            <TableCell>
              {row.operationNumber}. {row.subsection ?? row.operationTitle}
              {row.normOn ? <span className="block text-xs text-[var(--tk-muted)]">{row.normOn}</span> : null}
            </TableCell>
            <TableCell>{row.material ?? "—"}</TableCell>
            <TableCell>
              {row.size ?? "—"}
              {row.sizeLabel ? <span className="block text-xs text-[var(--tk-muted)]">{row.sizeLabel}</span> : null}
            </TableCell>
            <TableCell>{row.unit ?? "—"}</TableCell>
            <TableCell><Num value={row.k} /></TableCell>
            <TableCell>
              <Num value={row.normPerShift11h} />
              {row.sourceAnomaly ? <span className="mt-1 block text-xs text-amber-900" title={row.sourceAnomaly}>Как в скане, без правки</span> : null}
            </TableCell>
            <TableCell><Num value={row.timeHoursPerUnit} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function HaulTable({ rows }: { rows: HaulLegRow[] }) {
  return (
    <Table data-testid="client-norm-table">
      <TableHeader>
        <TableRow>
          <TableHead>Плечо, км</TableHead>
          <TableHead>Рейсов за смену 11 ч</TableHead>
          <TableHead>Скорость, км/ч</TableHead>
          <TableHead>Погрузка, мин</TableHead>
          <TableHead>Разгрузка, мин</TableHead>
          <TableHead>Тонн за смену</TableHead>
          <TableHead>Стоимость т·км</TableHead>
          <TableHead>Формула т·км</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.shoulderKm}>
            <TableCell>{row.shoulderKm}</TableCell>
            <TableCell title={row.tripsFormula ?? undefined}><Num value={row.tripsPerShift} /></TableCell>
            <TableCell><Num value={row.avgSpeedKmh} /></TableCell>
            <TableCell><Num value={row.loadMinutes} /></TableCell>
            <TableCell><Num value={row.unloadMinutes} /></TableCell>
            <TableCell title={row.tonnesFormula ?? undefined}><Num value={row.tonnesPerShift} /></TableCell>
            <TableCell><Num value={row.costPerTonneKm} /></TableCell>
            <TableCell className="max-w-[240px] text-xs">{row.costFormula ?? "—"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SitesTable({ rows }: { rows: SiteBenchmarkRow[] }) {
  return (
    <Table data-testid="client-norm-table">
      <TableHeader>
        <TableRow>
          <TableHead>Шифр</TableHead>
          <TableHead>Запись</TableHead>
          <TableHead>Наименование</TableHead>
          <TableHead>Ед.</TableHead>
          <TableHead>Факт</TableHead>
          <TableHead>Потребность</TableHead>
          <TableHead>Примечание</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={`${row.siteCode}-${row.kind}-${row.name}-${index}`} className={row.kind === "typo" ? "bg-amber-50" : undefined}>
            <TableCell>{row.siteCode}</TableCell>
            <TableCell>{KIND_LABEL[row.kind]}</TableCell>
            <TableCell>{row.name}</TableCell>
            <TableCell>{row.unit ?? "—"}</TableCell>
            <TableCell>{row.fact ?? "—"}</TableCell>
            <TableCell>{row.need ?? "—"}</TableCell>
            <TableCell className="max-w-md whitespace-pre-wrap text-xs">
              {row.shiftHint ? <span className="mb-1 block text-amber-900">{row.shiftHint}</span> : null}
              {row.note ?? "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
