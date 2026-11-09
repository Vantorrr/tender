"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { ReviewBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDate, formatMoney } from "@/lib/format";
import {
  KANBAN_COLUMNS,
  REGION_PRESETS,
  WORK_TYPES,
  reviewToKanban,
  type KanbanColumnId,
} from "@/lib/pipeline";
import { kanbanToReview } from "@/lib/pipeline";
import type { Procurement } from "@/lib/types";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

export default function ZakupkiPage() {
  const { orgProcurements, runSyncJob, setProcurementReview } = useStore();
  const [q, setQ] = useState("");
  const [region, setRegion] = useState<string>("all");
  const [workType, setWorkType] = useState<string>("all");
  const [syncing, setSyncing] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const regions = useMemo(() => {
    const fromData = [...new Set(orgProcurements.map((p) => p.region))];
    return [...new Set([...REGION_PRESETS, ...fromData])];
  }, [orgProcurements]);

  const syncIssues = orgProcurements.filter((p) => p.syncStatus !== "aktualno");

  const filtered = orgProcurements.filter((p) => {
    if (region === "norilsk" && !/норильск/i.test(p.region)) return false;
    if (region === "yamal" && !/ямал/i.test(p.region)) return false;
    if (region !== "all" && region !== "norilsk" && region !== "yamal" && p.region !== region)
      return false;
    if (workType !== "all" && (p.workType ?? "") !== workType) return false;
    if (q) {
      const hay = `${p.title} ${p.number} ${p.customer} ${p.workType ?? ""}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  });

  const byColumn = useMemo(() => {
    const map: Record<KanbanColumnId, Procurement[]> = {
      novaya: [],
      v_rabote: [],
      uchastvuem: [],
      ne_uchastvuem: [],
      dublikat: [],
    };
    for (const p of filtered) {
      map[reviewToKanban(p.reviewStatus)].push(p);
    }
    return map;
  }, [filtered]);

  async function moveCard(id: string, column: KanbanColumnId) {
    try {
      await setProcurementReview(id, kanbanToReview(column));
      toast.success("Статус канбана обновлён");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Ошибка статуса");
    }
  }

  return (
    <div>
      <PageHeader
        title="Закупки"
        description="Цветной канбан рассмотрения. Документы, расчёт, ГПР, деньги и риски — внутри карточки проекта. Источник площадки не выдумываем."
        actions={
          <Button
            variant="outline"
            disabled={syncing}
            onClick={async () => {
              setSyncing(true);
              try {
                await runSyncJob();
                toast.success("Синхронизация выполнена");
              } catch (e) {
                toast.error(
                  e instanceof Error ? e.message : "Ошибка синхронизации"
                );
              } finally {
                setSyncing(false);
              }
            }}
          >
            <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Синхронизация…" : "Синхронизировать"}
          </Button>
        }
      />

      <Alert className="mb-4 border-sky-200 bg-sky-50 text-sky-950">
        <RefreshCw className="h-4 w-4" />
        <AlertTitle>Источник закупок</AlertTitle>
        <AlertDescription>
          Реальный API площадки не подключён (kickoff). Автосинхронизация не
          создаёт фиктивные заявки. Фильтры Норильск / Ямал / вид работ —
          по карточке.
        </AlertDescription>
      </Alert>

      {syncIssues.length > 0 ? (
        <Alert className="mb-6 border-amber-200 bg-amber-50 text-amber-950">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Статус синхронизации карточек</AlertTitle>
          <AlertDescription>
            {syncIssues.map((p) => (
              <span key={p.id} className="mr-3 inline-block text-sm">
                {p.number}:{" "}
                {p.syncStatus === "ustarelo"
                  ? "данные устарели"
                  : "ошибка синхронизации"}{" "}
                (обновлено {formatDate(p.syncAt)})
              </span>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input
          placeholder="Поиск по названию, номеру, заказчику"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="zakupki-search"
        />
        <Select value={region} onValueChange={(v) => setRegion(v ?? "all")}>
          <SelectTrigger className="w-full" data-testid="zakupki-region">
            <SelectValue placeholder="Регион">
              {(value) =>
                value === "all"
                  ? "Все регионы"
                  : value === "norilsk"
                    ? "Норильск"
                    : value === "yamal"
                      ? "Ямал"
                      : String(value)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все регионы</SelectItem>
            <SelectItem value="norilsk">Норильск</SelectItem>
            <SelectItem value="yamal">Ямал</SelectItem>
            {regions
              .filter((r) => !/норильск|ямал/i.test(r))
              .map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Select value={workType} onValueChange={(v) => setWorkType(v ?? "all")}>
          <SelectTrigger className="w-full" data-testid="zakupki-worktype">
            <SelectValue placeholder="Вид работ">
              {(value) =>
                value === "all" ? "Все виды работ" : String(value)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все виды работ</SelectItem>
            {WORK_TYPES.map((w) => (
              <SelectItem key={w} value={w}>
                {w}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="Нет закупок по фильтрам"
          description="Снимите фильтр Норильск/Ямал или вид работ."
        />
      ) : (
        <div
          className="flex gap-3 overflow-x-auto pb-4"
          data-testid="zakupki-kanban"
        >
          {KANBAN_COLUMNS.map((col) => (
            <div
              key={col.id}
              className="w-[260px] shrink-0"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/procurement-id") || draggingId;
                if (id) void moveCard(id, col.id);
                setDraggingId(null);
              }}
            >
              <div
                className={cn(
                  "mb-2 rounded-lg border px-3 py-2 text-sm font-semibold",
                  col.headerClass
                )}
              >
                {col.label}
                <span className="ml-2 text-xs font-normal opacity-70">
                  {byColumn[col.id].length}
                </span>
              </div>
              <div className="space-y-2 min-h-[120px]">
                {byColumn[col.id].map((p) => (
                  <div
                    key={p.id}
                    draggable
                    onDragStart={(e) => {
                      setDraggingId(p.id);
                      e.dataTransfer.setData("text/procurement-id", p.id);
                    }}
                    className={cn(
                      "rounded-xl border border-[var(--tk-line)] border-l-4 bg-white/90 p-3 shadow-sm",
                      col.cardClass
                    )}
                  >
                    <Link
                      href={`/cabinet/zakupki/${p.id}`}
                      className="font-medium text-sm leading-snug text-[var(--tk-ink)] hover:underline"
                    >
                      {p.title}
                    </Link>
                    <div className="mt-1 text-xs text-[var(--tk-muted)]">
                      {p.number}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <ReviewBadge status={p.reviewStatus} />
                      <span>{p.region}</span>
                      {p.workType ? (
                        <span className="rounded bg-stone-100 px-1.5 py-0.5">
                          {p.workType}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-2 text-sm font-semibold">
                      {formatMoney(p.nmck)}
                    </div>
                    <div className="mt-1 text-[11px] text-[var(--tk-muted)]">
                      до {formatDate(p.deadline)}
                      {p.calculationId ? " · есть расчёт" : ""}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
