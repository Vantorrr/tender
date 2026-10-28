"use client";

import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
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
import { formatDateTime, formatNumber } from "@/lib/format";
import { useStore } from "@/lib/store";

export default function ObmenPage() {
  const { data, user, confirmSmetaExchange, importSmetaFile } = useStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const calcs = useMemo(
    () =>
      user
        ? data.calculations.filter((c) => c.orgId === user.orgId)
        : [],
    [data.calculations, user]
  );
  const [calcId, setCalcId] = useState<string | undefined>(undefined);
  if (!user) return null;
  const activeCalc = calcId ?? calcs[0]?.id;

  return (
    <div>
      <PageHeader
        title="Обмен со сметным ПО"
        description="XLSX экспорт/импорт работ и объёмов, сопоставление позиций, версии и контроль расхождений."
        actions={
          <>
            <Select
              value={activeCalc}
              onValueChange={(v) => setCalcId(v ?? undefined)}
            >
              <SelectTrigger className="w-[240px]">
                <SelectValue placeholder="Расчёт" />
              </SelectTrigger>
              <SelectContent>
                {calcs.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.title.slice(0, 40)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (!activeCalc) {
                  toast.error("Выберите расчёт");
                  return;
                }
                try {
                  await importSmetaFile(file, activeCalc);
                  toast.success("Импорт XLSX выполнен. Проверьте расхождения.");
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : "Ошибка импорта"
                  );
                }
                e.target.value = "";
              }}
            />
            <Button
              variant="outline"
              disabled={!activeCalc}
              onClick={async () => {
                try {
                  await downloadUrl(
                    `/api/export?kind=smeta-xlsx&id=${activeCalc}`
                  );
                  toast.success("Экспорт XLSX скачан");
                } catch (e) {
                  toast.error(
                    e instanceof Error ? e.message : "Ошибка экспорта"
                  );
                }
              }}
            >
              Экспорт XLSX
            </Button>
            <Button
              disabled={!activeCalc}
              onClick={() => inputRef.current?.click()}
            >
              Импорт XLSX
            </Button>
          </>
        }
      />

      <section className="mb-6 rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
        <h2 className="font-[family-name:var(--font-display)] text-base">
          Краткая инструкция обмена
        </h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-relaxed text-[var(--tk-ink-soft)]">
          <li>
            Выберите расчёт и экспортируйте ведомость работ и объёмов в XLSX.
          </li>
          <li>
            Импортируйте файл в ваше сметное ПО, выполните расчёт локально.
          </li>
          <li>
            Выгрузите обратно файл с кодами позиций и объёмами, загрузите через
            «Импорт XLSX».
          </li>
          <li>
            Сопоставьте позиции по коду, просмотрите расхождения, подтвердите
            актуальную версию.
          </li>
        </ol>
      </section>

      <section className="overflow-x-auto rounded-xl border border-[var(--tk-line)] bg-white/80">
        <div className="border-b border-[var(--tk-line)] px-4 py-3 font-[family-name:var(--font-display)] text-base">
          История обменов
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Название</TableHead>
              <TableHead>Позиций</TableHead>
              <TableHead>Расхождения</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead>Когда</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.smetaExchanges.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-8 text-center text-sm text-[var(--tk-muted)]"
                >
                  Обменов пока нет — выполните импорт XLSX
                </TableCell>
              </TableRow>
            ) : (
              data.smetaExchanges.map((sx) => (
                <TableRow key={sx.id}>
                  <TableCell className="font-medium">{sx.name}</TableCell>
                  <TableCell>{sx.positionsMapped}</TableCell>
                  <TableCell>
                    {sx.discrepancies.length === 0 ? (
                      <span className="text-[var(--tk-muted)]">нет</span>
                    ) : (
                      <div className="space-y-1 text-xs">
                        {sx.discrepancies.slice(0, 3).map((d) => (
                          <div key={d.code}>
                            {d.code}: {formatNumber(d.ours)} →{" "}
                            {formatNumber(d.theirs)}
                          </div>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={sx.confirmed ? "secondary" : "outline"}>
                      {sx.confirmed ? "Подтверждено" : "Черновик"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {formatDateTime(sx.at)}
                  </TableCell>
                  <TableCell>
                    {!sx.confirmed ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          await confirmSmetaExchange(sx.id);
                          toast.success("Версия подтверждена");
                        }}
                      >
                        Подтвердить
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
