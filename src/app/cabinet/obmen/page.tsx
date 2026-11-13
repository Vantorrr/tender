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
  const [pickedId, setPickedId] = useState("");
  if (!user) return null;
  const activeCalc = pickedId || calcs[0]?.id || "";

  return (
    <div>
      <PageHeader
        title="Обмен со сметным ПО"
        description="Обмен принимает XLSX. После импорта результат и расхождения появятся в истории; исходная смета и черновик не перезаписываются."
        actions={
          <>
            <Select
              value={activeCalc}
              onValueChange={(v) => {
                if (v) setPickedId(v);
              }}
            >
              <SelectTrigger className="w-full sm:w-[240px]">
                <SelectValue placeholder="Расчёт">
                  {(value) =>
                    calcs.find((c) => c.id === value)?.title ?? "Расчёт"
                  }
                </SelectValue>
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
              accept=".xlsx"
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
            Выберите расчёт «Объёмы ТП-КП-М-Д» или другой и экспортируйте ведомость в XLSX.
          </li>
          <li>
            В ГРАНД-Смета 2022.3 откройте локальную смету и выгрузите её в Excel по форме приказа № 421.
          </li>
          <li>
            Загрузите эту книгу через «Импорт XLSX». Сопоставление идёт по номеру сметы и шифру расценки.
          </li>
          <li>
            Сопоставьте позиции по коду, просмотрите расхождения, подтвердите
            актуальную версию.
          </li>
        </ol>
      </section>

      {data.smetaExchanges[0] ? (
        <section
          className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 p-5"
          data-testid="obmen-last-result"
        >
          <h2 className="font-[family-name:var(--font-display)] text-base">
            Последний результат обмена
          </h2>
          <p className="mt-2 text-sm">
            {data.smetaExchanges[0].name} · позиций{" "}
            {data.smetaExchanges[0].positionsMapped} · расхождений{" "}
            {data.smetaExchanges[0].discrepancies.length} ·{" "}
            {data.smetaExchanges[0].confirmed ? "подтверждено" : "черновик"} ·{" "}
            {formatDateTime(data.smetaExchanges[0].at)}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                document
                  .getElementById(`obmen-row-${data.smetaExchanges[0].id}`)
                  ?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
            >
              Открыть в истории
            </Button>
            {activeCalc ? (
              <a
                className="inline-flex h-8 items-center rounded-lg border px-3 text-sm"
                href={`/cabinet/raschety/${activeCalc}`}
              >
                Открыть расчёт
              </a>
            ) : null}
          </div>
        </section>
      ) : null}

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
                <TableRow key={sx.id} id={`obmen-row-${sx.id}`}>
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
