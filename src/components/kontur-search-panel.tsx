"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { KonturSearchFilters } from "@/server/procurement-source";
import { SEARCH_INDUSTRIES, SEARCH_REGIONS, withIndustries } from "@/lib/search-catalog";

type Props = { busy: boolean; onSearch: (filters: KonturSearchFilters) => void };

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const splitValues = (value: string) => value.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean);
const utcStart = (value: string) => new Date(`${value}T00:00:00.000Z`).toISOString();
const utcEnd = (value: string) => new Date(`${value}T23:59:59.999Z`).toISOString();

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="block text-xs font-medium text-[var(--tk-ink)]">{label}{children}<span className="mt-1 block font-normal text-[var(--tk-muted)]">{hint}</span></label>;
}

function Lines({ label, value, onChange, placeholder, hint }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; hint?: string }) {
  return <Field label={label} hint={hint}><textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={2} className="mt-1 block w-full rounded-md border border-[var(--tk-line)] bg-white px-2 py-1.5 text-sm font-normal" /></Field>;
}

function OptionGroup({ label, options, selected, onChange }: { label: string; options: Array<[number, string]>; selected: number[]; onChange: (next: number[]) => void }) {
  return <fieldset className="rounded-lg border border-[var(--tk-line)] p-3"><legend className="px-1 text-xs font-medium">{label}</legend><div className="grid gap-2 sm:grid-cols-2">{options.map(([value, title]) => <label key={value} className="flex items-start gap-2 text-xs"><Checkbox checked={selected.includes(value)} onCheckedChange={(checked) => onChange(checked ? [...selected, value] : selected.filter((item) => item !== value))} /><span>{title}</span></label>)}</div></fieldset>;
}

export function KonturSearchPanel({ busy, onSearch }: Props) {
  const [text, setText] = useState("");
  const [exclude, setExclude] = useState("");
  const [includeInns, setIncludeInns] = useState("");
  const [excludeInns, setExcludeInns] = useState("");
  const [regionIds, setRegionIds] = useState<string[]>([]);
  const [platformIds, setPlatformIds] = useState("");
  const [industryIds, setIndustryIds] = useState<number[]>([]);
  const [participantInns, setParticipantInns] = useState("");
  const [publishedFrom, setPublishedFrom] = useState(daysAgo(1));
  const [publishedTo, setPublishedTo] = useState(today());
  const [deadlineFrom, setDeadlineFrom] = useState("");
  const [deadlineTo, setDeadlineTo] = useState("");
  const [priceFrom, setPriceFrom] = useState("");
  const [priceTo, setPriceTo] = useState("");
  const [laws, setLaws] = useState<number[]>([]);
  const [procedures, setProcedures] = useState<number[]>([]);
  const [statuses, setStatuses] = useState<number[]>([]);
  const [categories, setCategories] = useState<number[]>([]);
  const [smp, setSmp] = useState("0");
  const [participantState, setParticipantState] = useState("");
  const [strict, setStrict] = useState(false);
  const [attachments, setAttachments] = useState(false);
  const [noPrice, setNoPrice] = useState(false);
  const [advance44, setAdvance44] = useState(false);
  const [advance223, setAdvance223] = useState(false);
  const [nonAdvance, setNonAdvance] = useState(false);
  const [foreignCurrency, setForeignCurrency] = useState(false);
  const [participantsFromDocs, setParticipantsFromDocs] = useState(false);
  const optionalFlags = [
    { checked: strict, onChange: setStrict, label: "Точный поиск" },
    { checked: attachments, onChange: setAttachments, label: "Поиск по документам" },
    { checked: noPrice, onChange: setNoPrice, label: "Включать закупки без НМЦ" },
    { checked: advance44, onChange: setAdvance44, label: "Аванс по 44-ФЗ" },
    { checked: advance223, onChange: setAdvance223, label: "Аванс по 223-ФЗ" },
    { checked: nonAdvance, onChange: setNonAdvance, label: "Без аванса в других торгах" },
    { checked: foreignCurrency, onChange: setForeignCurrency, label: "Разрешить валютные закупки" },
    { checked: participantsFromDocs, onChange: setParticipantsFromDocs, label: "Искать участников в документах · тариф Поиск 2.0" },
  ];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!publishedFrom || !publishedTo) return;
    const numericIds = (value: string) => splitValues(value).map(Number).filter(Number.isInteger);
    const filters: KonturSearchFilters = {
      DateTimeFrom: utcStart(publishedFrom),
      DateTimeTo: utcEnd(publishedTo),
      PageNumber: 0,
      ...(splitValues(text).length ? { Text: splitValues(text) } : {}),
      ...(splitValues(exclude).length ? { Exclude: splitValues(exclude) } : {}),
      ...(splitValues(includeInns).length ? { IncludeInns: splitValues(includeInns) } : {}),
      ...(splitValues(excludeInns).length ? { ExcludeInns: splitValues(excludeInns) } : {}),
      ...(regionIds.length ? { RegionIds: regionIds } : {}),
      ...(splitValues(participantInns).length ? { ParticipantsInns: splitValues(participantInns) } : {}),
      ...(laws.length ? { Laws: laws } : {}),
      ...(procedures.length ? { Procedures: procedures } : {}),
      ...(statuses.length ? { PurchaseStatuses: statuses } : {}),
      ...(categories.length ? { Categories: categories } : {}),
      ...(numericIds(platformIds).length ? { ElectronicPlaces: numericIds(platformIds) } : {}),
      ...(priceFrom.trim() ? { MaxPriceFrom: Number(priceFrom) } : {}),
      ...(priceTo.trim() ? { MaxPriceTo: Number(priceTo) } : {}),
      ...(deadlineFrom ? { ApplicationDeadlineFrom: utcStart(deadlineFrom) } : {}),
      ...(deadlineTo ? { ApplicationDeadlineTo: utcEnd(deadlineTo) } : {}),
      ...(strict ? { StrictSearch: true } : {}),
      ...(attachments ? { Attachments: true } : {}),
      ...(noPrice ? { MaxPriceNone: true } : {}),
      ...(advance44 ? { Advance44: true } : {}),
      ...(advance223 ? { Advance223: true } : {}),
      ...(nonAdvance ? { NonAdvance: true } : {}),
      ...(foreignCurrency ? { AllowForeignCurrency: true } : {}),
      ...(Number(smp) !== 0 ? { Smp: Number(smp) as 1 | 2 } : {}),
      ...(participantState ? { ParticipantsState: Number(participantState) as 1 | 2 | 3 } : {}),
      ...(participantsFromDocs ? { EnableParticipantsFromDocuments: true } : {}),
    };
    onSearch(withIndustries(filters, industryIds));
  }

  return <section className="mb-5 rounded-xl border border-[var(--tk-line)] bg-white/90 p-4" data-testid="kontur-search-panel">
    <div><h2 className="font-semibold">Поиск закупок</h2><p className="mt-1 text-xs text-[var(--tk-muted)]">Ищет закупки и добавляет найденные карточки в канбан. Одна страница — один запрос; число страниц ограничено настройкой источника.</p></div>
    <form onSubmit={submit} className="mt-3 space-y-3">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Lines label="Ключевые слова" value={text} onChange={setText} placeholder="ремонт трубопровода, строительство" />
        <Field label="Опубликовано с"><Input required type="date" className="mt-1 h-9" value={publishedFrom} onChange={(e) => setPublishedFrom(e.target.value)} /></Field>
        <Field label="Опубликовано по"><Input required type="date" className="mt-1 h-9" value={publishedTo} onChange={(e) => setPublishedTo(e.target.value)} /></Field>
        <fieldset className="rounded-lg border border-[var(--tk-line)] p-3"><legend className="px-1 text-xs font-medium">Регион</legend><div className="grid gap-2">{SEARCH_REGIONS.map((region) => <label key={region.label} className="flex items-start gap-2 text-xs"><Checkbox checked={regionIds.includes(region.id)} onCheckedChange={(checked) => setRegionIds(checked ? [...regionIds, region.id] : regionIds.filter((item) => item !== region.id))} /><span>{region.label}</span></label>)}</div></fieldset>
      </div>
      <details className="rounded-lg border border-[var(--tk-line)] px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">Расширенные фильтры</summary>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <Lines label="Исключить слова" value={exclude} onChange={setExclude} placeholder="закупка отменена" />
          <Lines label="ИНН заказчика — включить" value={includeInns} onChange={setIncludeInns} placeholder="ИНН, по одному или через запятую" />
          <Lines label="ИНН заказчика — исключить" value={excludeInns} onChange={setExcludeInns} placeholder="ИНН, по одному или через запятую" />
          <Lines label="Площадки" value={platformIds} onChange={setPlatformIds} placeholder="номера площадок через запятую" />
          <fieldset className="rounded-lg border border-[var(--tk-line)] p-3"><legend className="px-1 text-xs font-medium">Отрасль</legend><div className="grid gap-2">{SEARCH_INDUSTRIES.map((industry) => <label key={industry.label} className="flex items-start gap-2 text-xs"><Checkbox checked={industryIds.includes(industry.id)} onCheckedChange={(checked) => setIndustryIds(checked ? [...industryIds, industry.id] : industryIds.filter((item) => item !== industry.id))} /><span>{industry.label}</span></label>)}</div></fieldset>
          <Lines label="Участники — ИНН" value={participantInns} onChange={setParticipantInns} placeholder="ИНН участника, поставщика или победителя" />
          <Field label="Срок подачи заявок с"><Input type="date" className="mt-1 h-9" value={deadlineFrom} onChange={(e) => setDeadlineFrom(e.target.value)} /></Field>
          <Field label="Срок подачи заявок по"><Input type="date" className="mt-1 h-9" value={deadlineTo} onChange={(e) => setDeadlineTo(e.target.value)} /></Field>
          <Field label="Начальная цена от"><Input type="number" min="0" step="1" className="mt-1 h-9" value={priceFrom} onChange={(e) => setPriceFrom(e.target.value)} /></Field>
          <Field label="Начальная цена до"><Input type="number" min="0" step="1" className="mt-1 h-9" value={priceTo} onChange={(e) => setPriceTo(e.target.value)} /></Field>
          <Field label="СМП"><select className="mt-1 h-9 w-full rounded-md border border-[var(--tk-line)] bg-white px-2 text-sm" value={smp} onChange={(e) => setSmp(e.target.value)}><option value="0">Не учитывать</option><option value="1">Только СМП</option><option value="2">Без СМП</option></select></Field>
          <Field label="Участник"><select className="mt-1 h-9 w-full rounded-md border border-[var(--tk-line)] bg-white px-2 text-sm" value={participantState} onChange={(e) => setParticipantState(e.target.value)}><option value="">Не фильтровать</option><option value="1">Победитель</option><option value="2">Поставщик</option><option value="3">Все участники</option></select></Field>
          <OptionGroup label="Тип торгов" selected={laws} onChange={setLaws} options={[[1,"44-ФЗ"],[2,"223-ФЗ"],[3,"Коммерческие и малые закупки"],[5,"615-ПП"],[8,"Коммерческие"],[9,"Малые закупки"]]} />
          <OptionGroup label="Способ отбора" selected={procedures} onChange={setProcedures} options={[[0,"Электронный аукцион"],[1,"Запрос котировок"],[2,"Единственный поставщик"],[3,"Конкурс"],[5,"Запрос / мониторинг цен"],[99,"Другой способ"]]} />
          <OptionGroup label="Этап закупки" selected={statuses} onChange={setStatuses} options={[[1,"Подача заявок"],[2,"Работа комиссии"],[3,"Завершена"],[4,"Планируется"],[5,"Отменена"],[6,"Есть несостоявшийся лот"]]} />
          <OptionGroup label="Категории" selected={categories} onChange={setCategories} options={[[20,"Строительные работы"],[21,"Проектирование"],[22,"Оборудование и материалы"],[68,"Строительство"],[17,"Ремонт и техобслуживание"],[40,"Обслуживание и ремонт"]]} />
          <fieldset className="rounded-lg border border-[var(--tk-line)] p-3"><legend className="px-1 text-xs font-medium">Дополнительные условия</legend><div className="grid gap-2 sm:grid-cols-2">
            {optionalFlags.map(({ checked, onChange, label }) => <label key={label} className="flex items-start gap-2 text-xs"><Checkbox checked={checked} onCheckedChange={(value) => onChange(value === true)} /><span>{label}</span></label>)}
          </div></fieldset>
        </div>
      </details>
      <div className="flex justify-end"><Button type="submit" disabled={busy || !publishedFrom || !publishedTo}><Search className="h-4 w-4" />{busy ? "Ищем…" : "Найти и добавить в закупки"}</Button></div>
    </form>
  </section>;
}
