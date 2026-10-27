"use client";

import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { downloadTextFile, formatDateTime, formatNumber, toCsv } from "@/lib/format";
import { useStore } from "@/lib/store";

export default function ObmenPage() {
  const { data, user, confirmSmetaExchange, addAudit } = useStore();
  if (!user) return null;

  return (
    <div>
      <PageHeader
        title="Обмен со сметным ПО"
        description="XLSX экспорт/импорт работ и объёмов, сопоставление позиций, версии и контроль расхождений."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => {
                const rows = [
                  ["code", "name", "unit", "quantity"],
                  ["ГЭСН 15-01-047-01", "Штукатурка стен", "м²", 2180],
                  ["ГЭСН 12-01-002-01", "Кровля металлочерепица", "м²", 960],
                ];
                downloadTextFile(
                  "export-smeta.xlsx.csv",
                  "\uFEFF" + toCsv(rows),
                  "text/csv;charset=utf-8"
                );
                addAudit(
                  "export",
                  "smeta",
                  "works",
                  "Экспорт работ/объёмов в сметное ПО"
                );
                toast.success("Экспорт работ/объёмов готов");
              }}
            >
              Экспорт XLSX
            </Button>
            <Button
              onClick={() => {
                addAudit(
                  "import",
                  "smeta",
                  "works",
                  "Импорт из сметного ПО (мок)"
                );
                toast.success("Импорт принят (мок). Проверьте расхождения ниже.");
              }}
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
            Экспортируйте ведомость работ и объёмов из ТендерКонтур в CSV/XLSX.
          </li>
          <li>
            Импортируйте файл в ваше сметное ПО (Гранд-Смета, Smeta.ru и т.п.),
            выполните расчёт локально.
          </li>
          <li>
            Выгрузите обратно файл с кодами позиций и объёмами, загрузите в
            раздел «Импорт XLSX».
          </li>
          <li>
            Сопоставьте позиции по коду, просмотрите расхождения, подтвердите
            актуальную версию.
          </li>
        </ol>
      </section>

      <div className="space-y-4">
        {data.smetaExchanges.map((sx) => (
          <div
            key={sx.id}
            className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-5"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">{sx.name}</h3>
                <p className="mt-1 text-sm text-[var(--tk-muted)]">
                  {formatDateTime(sx.at)} ·{" "}
                  {data.users.find((u) => u.id === sx.authorId)?.name} ·
                  сопоставлено позиций: {sx.positionsMapped}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={sx.confirmed ? "secondary" : "outline"}>
                  {sx.confirmed ? "Подтверждено" : "Ожидает подтверждения"}
                </Badge>
                {!sx.confirmed ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      confirmSmetaExchange(sx.id);
                      toast.success("Версия обмена подтверждена");
                    }}
                  >
                    Подтвердить
                  </Button>
                ) : null}
              </div>
            </div>

            {sx.discrepancies.length > 0 ? (
              <div className="mt-4 overflow-x-auto">
                <p className="mb-2 text-sm font-medium text-amber-900">
                  Контроль расхождений
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Код</TableHead>
                      <TableHead className="text-right">У нас</TableHead>
                      <TableHead className="text-right">В сметном ПО</TableHead>
                      <TableHead className="text-right">Δ</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sx.discrepancies.map((d) => (
                      <TableRow key={d.code}>
                        <TableCell className="font-mono text-xs">
                          {d.code}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatNumber(d.ours)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatNumber(d.theirs)}
                        </TableCell>
                        <TableCell className="text-right font-medium text-rose-700">
                          {formatNumber(d.theirs - d.ours)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="mt-3 text-sm text-emerald-800">
                Расхождений нет — позиции совпали.
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
