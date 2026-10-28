"use client";

import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  rascenki: "Расценки",
  ceny: "Цены",
  profil: "Профиль закупок",
};

export default function SpravochnikiPage() {
  const { data, setDirectoryCurrent, importDirectoryRows, importDirectoryFile } =
    useStore();
  const [tab, setTab] = useState<DirectoryVersion["type"]>("normy");
  const fileRef = useRef<HTMLInputElement>(null);

  const items = useMemo(
    () => data.directories.filter((d) => d.type === tab),
    [data.directories, tab]
  );
  const current = items.find((d) => d.current) ?? items[0];

  async function downloadTemplate() {
    try {
      await downloadUrl(`/api/export?kind=dir-template&type=${tab}`);
      toast.success("Шаблон XLSX скачан");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Ошибка скачивания");
    }
  }

  async function mockImport() {
    const sample =
      tab === "normy"
        ? [{ code: "ГЭСН NEW", name: "Импортированная норма", unit: "м²", labor: 0.3 }]
        : tab === "rascenki"
          ? [{ code: "R-NEW", work: "Импорт", rate: 1000 }]
          : tab === "ceny"
            ? [{ sku: "MAT-NEW", name: "Материал импорт", unit: "шт", price: 500 }]
            : [{ region: "Рязань", okpd: "41.20", maxNmck: 50000000 }];
    await importDirectoryRows(tab, sample);
    toast.success("Демо-импорт выполнен, создана новая текущая версия");
  }

  return (
    <div>
      <PageHeader
        title="Справочники"
        description="Нормы, расценки, цены и профиль закупок. Расчёты используют текущую версию."
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
            <Button variant="secondary" onClick={mockImport}>
              Демо-строки
            </Button>
          </>
        }
      />

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as DirectoryVersion["type"])}
      >
        <TabsList>
          {(Object.keys(typeLabel) as DirectoryVersion["type"][]).map((t) => (
            <TabsTrigger key={t} value={t}>
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
                <span className="text-xs text-[var(--tk-muted)]">
                  {formatDateTime(current.at)} · автор{" "}
                  {data.users.find((u) => u.id === current.authorId)?.name ??
                    current.authorId}
                </span>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {Object.keys(current.rows[0] ?? {}).map((k) => (
                        <TableHead key={k}>{k}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {current.rows.map((row, idx) => (
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
              Нет версий для этого типа. Импортируйте шаблон.
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
