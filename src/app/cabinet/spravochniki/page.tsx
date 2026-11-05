"use client";

import { useMemo, useRef, useState } from "react";
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
import { downloadUrl } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { DirectoryVersion } from "@/lib/types";

const typeLabel: Record<DirectoryVersion["type"], string> = {
  normy: "Нормы",
  rascenki: "Нормо-час",
  ceny: "Тарифы АТС/ДСМ",
  park: "Парк техники",
  profil: "Профиль закупок",
};

const colLabel: Record<string, string> = {
  code: "Код",
  category: "Категория",
  name: "Наименование",
  work: "Должность / работа",
  department: "Подразделение",
  unit: "Ед.",
  rate: "Ставка",
  price: "Цена",
  qty: "Кол-во",
  labor: "Трудозатраты",
  sku: "SKU",
  region: "Регион",
  okpd: "ОКПД",
  maxNmck: "Макс. НМЦК",
  rate_1s_kpi085: "1 смена КПИ 0,85",
  rate_2s_kpi085: "2 смены КПИ 0,85",
  rate_1s_kpi10: "1 смена КПИ 1,0",
  rate_2s_kpi10: "2 смены КПИ 1,0",
};

const TAB_ORDER: DirectoryVersion["type"][] = [
  "rascenki",
  "ceny",
  "park",
  "profil",
  "normy",
];

export default function SpravochnikiPage() {
  const { data, setDirectoryCurrent, importDirectoryFile } = useStore();
  const [tab, setTab] = useState<DirectoryVersion["type"]>("rascenki");
  const [query, setQuery] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const items = useMemo(
    () => data.directories.filter((d) => d.type === tab),
    [data.directories, tab]
  );
  const current = items.find((d) => d.current) ?? items[0];
  const filteredRows = useMemo(() => {
    const rows = current?.rows ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      Object.values(row).some((v) => String(v).toLowerCase().includes(q))
    );
  }, [current, query]);

  async function downloadTemplate() {
    try {
      await downloadUrl(`/api/export?kind=dir-template&type=${tab}`);
      toast.success("Шаблон XLSX скачан");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Ошибка скачивания");
    }
  }

  return (
    <div>
      <PageHeader
        title="Справочники"
        description="Клиентские тарифы, нормо-час и парк — текущие версии участвуют в расчётах."
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  await importDirectoryFile(tab, file);
                  toast.success("Импорт Excel выполнен");
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : "Ошибка импорта"
                  );
                }
                e.target.value = "";
              }}
            />
            <Button variant="outline" onClick={downloadTemplate}>
              Скачать шаблон
            </Button>
            <Button variant="outline" onClick={() => fileRef.current?.click()}>
              Импорт Excel
            </Button>
          </>
        }
      />

      <Tabs
        value={tab}
        onValueChange={(v) => {
          setTab(v as DirectoryVersion["type"]);
          setQuery("");
        }}
      >
        <TabsList className="!h-auto w-full max-w-full flex-wrap justify-start gap-1 py-1">
          {TAB_ORDER.map((t) => (
            <TabsTrigger key={t} value={t} className="!h-auto flex-none px-2.5 py-1">
              {typeLabel[t]}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={tab} className="mt-4 space-y-4">
          <div className="flex flex-wrap gap-2">
            {items
              .slice()
              .sort((a, b) => b.version - a.version)
              .map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => {
                    setDirectoryCurrent(d.id);
                    toast.message(`Текущая версия: v${d.version}`);
                  }}
                  className={`rounded-lg border px-3 py-2 text-sm transition ${
                    d.current
                      ? "border-[var(--tk-steel)] bg-[var(--tk-steel)] text-white"
                      : "border-[var(--tk-line)] bg-white hover:border-[var(--tk-copper)]/50"
                  }`}
                >
                  v{d.version}
                  {d.current ? " · текущая" : ""}
                  {/клиент/i.test(d.name) ? " · клиент" : ""}
                </button>
              ))}
          </div>

          {current ? (
            <div className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h2 className="font-[family-name:var(--font-display)] text-base">
                  {current.name}
                </h2>
                <Badge variant="outline">v{current.version}</Badge>
                {current.current ? (
                  <Badge className="bg-emerald-600">для расчётов</Badge>
                ) : null}
                {/клиент/i.test(current.name) ? (
                  <Badge variant="secondary">приказ 2026</Badge>
                ) : null}
                <span className="text-xs text-[var(--tk-muted)]">
                  {formatDateTime(current.at)} · автор{" "}
                  {data.users.find((u) => u.id === current.authorId)?.name ??
                    current.authorId}
                </span>
              </div>
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <p className="text-xs text-[var(--tk-muted)]">
                  Строк: {filteredRows.length}
                  {filteredRows.length !== current.rows.length
                    ? ` из ${current.rows.length}`
                    : ""}
                  {filteredRows.length > 100 ? " (показаны первые 100)" : ""}
                </p>
                <Input
                  className="max-w-xs"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Поиск по справочнику…"
                />
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {Object.keys(current.rows[0] ?? {}).map((k) => (
                        <TableHead key={k}>{colLabel[k] ?? k}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredRows.slice(0, 100).map((row, idx) => (
                      <TableRow key={idx}>
                        {Object.values(row).map((v, i) => (
                          <TableCell key={i}>{String(v)}</TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : (
            <p className="text-sm text-[var(--tk-muted)]">
              Нет версий для этого типа. Импортируйте шаблон или клиентские XLSX
              в админке.
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
