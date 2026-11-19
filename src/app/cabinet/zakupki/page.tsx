"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDate, formatMoney } from "@/lib/format";
import { api } from "@/lib/api";
import {
  KANBAN_COLUMNS,
  REGION_PRESETS,
  WORK_TYPES,
  displayedKanbanColumn,
  type KanbanColumnId,
} from "@/lib/pipeline";
import { kanbanToReview } from "@/lib/pipeline";
import type { Procurement } from "@/lib/types";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { plainUserMessage } from "@/lib/plain-user-message";

export default function ZakupkiPage() {
  const router = useRouter();
  const { orgProcurements, runSyncJob, refresh } = useStore();
  const [q, setQ] = useState("");
  const [region, setRegion] = useState<string>("all");
  const [workType, setWorkType] = useState<string>("all");
  const [syncing, setSyncing] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [moved, setMoved] = useState<Record<string, Partial<Procurement>>>({});
  const moveSeq = useRef<Record<string, number>>({});
  const [pendingDelete, setPendingDelete] = useState<Procurement | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [manualFormOpen, setManualFormOpen] = useState(false);
  const [manualCreating, setManualCreating] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [manualCustomer, setManualCustomer] = useState("");
  const [manualRegion, setManualRegion] = useState("");
  const [manualNmck, setManualNmck] = useState("");
  const [manualDeadline, setManualDeadline] = useState("");

  const regions = useMemo(() => {
    const fromData = [...new Set(orgProcurements.map((p) => p.region))];
    return [...new Set([...REGION_PRESETS, ...fromData])];
  }, [orgProcurements]);

  const syncIssues = orgProcurements.filter((p) => p.syncStatus !== "aktualno");

  const boardProcurements = useMemo(
    () => orgProcurements.map((item) => moved[item.id] ? { ...item, ...moved[item.id] } : item),
    [orgProcurements, moved],
  );
  const filtered = useMemo(() => boardProcurements.filter((p) => {
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
  }), [boardProcurements, region, workType, q]);

  const byColumn = useMemo(() => {
    const map: Record<KanbanColumnId, Procurement[]> = {
      novaya: [],
      v_rabote: [],
      uchastvuem: [],
      ne_uchastvuem: [],
      dublikat: [],
      in_production: [],
      realized: [],
      closed_not_realized: [],
    };
    for (const p of filtered) {
      map[displayedKanbanColumn(p)].push(p);
    }
    return map;
  }, [filtered]);

  function columnOf(card: Procurement): KanbanColumnId {
    return displayedKanbanColumn(card);
  }

  async function moveCard(id: string, column: KanbanColumnId) {
    const card = boardProcurements.find((item) => item.id === id);
    if (!card) {
      toast.error("Карточка закупки не найдена");
      return;
    }
    if (columnOf(card) === column) return;
    const next: Partial<Procurement> = column === "in_production"
      ? { lifecycle: "production" }
      : column === "realized" || column === "closed_not_realized"
        ? { lifecycle: "closed", lifecycleOutcome: column === "realized" ? "successful" : "not_realized", closedAt: new Date().toISOString() }
        : { reviewStatus: kanbanToReview(column), lifecycle: "procurement" };
    const seq = (moveSeq.current[id] ?? 0) + 1;
    moveSeq.current[id] = seq;
    setMoved((current) => ({ ...current, [id]: { ...current[id], ...next } }));
    const dropOverlay = () => {
      if (moveSeq.current[id] !== seq) return;
      setMoved((current) => {
        if (!(id in current)) return current;
        const copy = { ...current };
        delete copy[id];
        return copy;
      });
    };
    try {
      if (column === "in_production") {
        await api("/api/zakupki", {
          method: "POST",
          body: JSON.stringify({ action: "transferToProduction", id }),
        });
      } else if (column === "realized" || column === "closed_not_realized") {
        await api("/api/zakupki", {
          method: "PATCH",
          body: JSON.stringify({ id, patch: next }),
        });
      } else {
        await api("/api/zakupki", {
          method: "PATCH",
          body: JSON.stringify({ id, reviewStatus: kanbanToReview(column) }),
        });
        if (card.lifecycle === "production" || card.lifecycle === "closed") {
          await api("/api/zakupki", {
            method: "PATCH",
            body: JSON.stringify({ id, patch: { lifecycle: "procurement" } }),
          });
        }
      }
      await refresh();
      dropOverlay();
    } catch (e) {
      dropOverlay();
      toast.error(plainUserMessage(e instanceof Error ? e.message : "", "Не удалось обновить статус"));
    }
  }

  async function createManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setManualCreating(true);
    try {
      const result = await api<{ createdProcurementId: string }>("/api/zakupki", {
        method: "POST",
        body: JSON.stringify({
          action: "createManual",
          manual: {
            title: manualTitle,
            customer: manualCustomer,
            region: manualRegion,
            nmck: manualNmck.trim() ? Number(manualNmck.replace(",", ".")) : null,
            deadline: manualDeadline,
          },
        }),
      });
      await refresh();
      router.push(`/cabinet/zakupki/${result.createdProcurementId}`);
      toast.success("Закупка создана. Добавьте документы в карточку.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось создать закупку");
    } finally {
      setManualCreating(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Закупки"
        description="Выберите закупку, чтобы открыть документы, анализ и расчёт проекта."
        actions={
          <>
            <Button variant="outline" onClick={() => setManualFormOpen((open) => !open)}>
              {manualFormOpen ? "Закрыть форму" : "Создать вручную"}
            </Button>
            <Button
              variant="outline"
              disabled={syncing}
              onClick={async () => {
              setSyncing(true);
              try {
                await runSyncJob();
                toast.success("Синхронизация выполнена");
              } catch (e) {
                toast.error(plainUserMessage(e instanceof Error ? e.message : "", "Не удалось обновить список закупок. Повторите позже."));
              } finally {
                setSyncing(false);
              }
              }}
            >
              <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
              {syncing ? "Синхронизация…" : "Синхронизировать"}
            </Button>
          </>
        }
      />

      {manualFormOpen ? (
        <form onSubmit={(event) => void createManual(event)} className="mb-5 rounded-xl border border-[var(--tk-line)] bg-white p-4" data-testid="manual-procurement-form">
          <h2 className="font-semibold">Новая закупка</h2>
          <p className="mt-1 text-sm text-[var(--tk-muted)]">Создайте проект вручную, затем загрузите комплект документов в его карточку.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <Input required aria-label="Название закупки" placeholder="Название объекта / закупки" value={manualTitle} onChange={(event) => setManualTitle(event.target.value)} />
            <Input aria-label="Заказчик" placeholder="Заказчик" value={manualCustomer} onChange={(event) => setManualCustomer(event.target.value)} />
            <Input required aria-label="Регион закупки" placeholder="Регион / площадка" value={manualRegion} onChange={(event) => setManualRegion(event.target.value)} />
            <Input aria-label="НМЦК" type="number" min="0" step="0.01" placeholder="НМЦК, ₽" value={manualNmck} onChange={(event) => setManualNmck(event.target.value)} />
            <Input aria-label="Срок подачи заявки" type="date" value={manualDeadline} onChange={(event) => setManualDeadline(event.target.value)} />
          </div>
          <div className="mt-3 flex justify-end">
            <Button type="submit" disabled={manualCreating || !manualTitle.trim() || !manualRegion.trim()}>
              {manualCreating ? "Создаю…" : "Создать и открыть карточку"}
            </Button>
          </div>
        </form>
      ) : null}

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
        <Button
          type="button"
          variant={showArchive ? "default" : "outline"}
          aria-pressed={showArchive}
          data-testid="zakupki-archive-filter"
          onClick={() => setShowArchive((value) => !value)}
        >
          Архив
        </Button>
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
          {KANBAN_COLUMNS.filter((col) => {
            if (col.id === "ne_uchastvuem" || col.id === "dublikat") return false;
            if (col.lifecycle === "closed") return showArchive;
            return true;
          }).map((col) => (
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
                    <div className="flex items-start justify-between gap-2">
                    <Link
                      href={`/cabinet/zakupki/${p.id}`}
                      className="font-medium text-sm leading-snug text-[var(--tk-ink)] hover:underline"
                    >
                      {p.title}
                    </Link>
                    <details className="relative shrink-0">
                      <summary className="cursor-pointer list-none rounded-md px-1.5 text-lg leading-none text-[var(--tk-muted)] hover:bg-stone-100" aria-label={`Меню карточки ${p.title}`}>⋮</summary>
                      <button
                        type="button"
                        className="absolute right-0 z-20 mt-1 whitespace-nowrap rounded-md border border-[var(--tk-line)] bg-white px-3 py-1.5 text-sm text-rose-800 shadow-sm"
                        onClick={() => setPendingDelete(p)}
                      >
                        Удалить
                      </button>
                    </details>
                    </div>
                    <div className="mt-1 text-xs text-[var(--tk-muted)]">
                      {p.number}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
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
                      {p.deadline?.trim() ? `до ${formatDate(p.deadline)}` : "срок не указан"}
                      {p.calculationId ? " · есть расчёт" : ""}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      <Dialog open={pendingDelete != null} onOpenChange={(open) => { if (!open && !deleting) setPendingDelete(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Удалить закупку?</DialogTitle>
            <DialogDescription>
              Карточка «{pendingDelete?.title}» и связанные с ней документы, расчёт и график будут удалены. Это действие нельзя отменить.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={deleting} onClick={() => setPendingDelete(null)}>Отмена</Button>
            <Button
              disabled={deleting || !pendingDelete}
              onClick={() => {
                if (!pendingDelete || deleting) return;
                const target = pendingDelete;
                setDeleting(true);
                void api("/api/zakupki", {
                  method: "POST",
                  body: JSON.stringify({ action: "deleteProcurement", id: target.id }),
                }).then(() => refresh()).then(() => {
                  toast.success("Закупка удалена");
                  setPendingDelete(null);
                }).catch((error: unknown) => {
                  toast.error(plainUserMessage(error instanceof Error ? error.message : "", "Не удалось удалить закупку"));
                }).finally(() => setDeleting(false));
              }}
            >
              {deleting ? "Удаляю…" : "Удалить"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
