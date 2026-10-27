"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { EntityCard } from "@/components/entity-card";
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
import { REVIEW_LABELS, STATUS_LABELS } from "@/lib/roles";
import type { CardStatus, ReviewStatus } from "@/lib/types";
import { useStore } from "@/lib/store";

export default function ZakupkiPage() {
  const { orgProcurements, runSyncJob } = useStore();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [review, setReview] = useState<string>("all");
  const [region, setRegion] = useState<string>("all");

  const regions = useMemo(
    () => [...new Set(orgProcurements.map((p) => p.region))],
    [orgProcurements]
  );

  const syncIssues = orgProcurements.filter(
    (p) => p.syncStatus !== "aktualno"
  );

  const filtered = orgProcurements.filter((p) => {
    if (status !== "all" && p.status !== status) return false;
    if (review !== "all" && p.reviewStatus !== review) return false;
    if (region !== "all" && p.region !== region) return false;
    if (q) {
      const hay = `${p.title} ${p.number} ${p.customer}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  });

  return (
    <div>
      <PageHeader
        title="Закупки"
        description="Лента из согласованного источника с фильтрами, дедупликацией и статусами рассмотрения."
        actions={
          <Button
            variant="outline"
            onClick={async () => {
              await runSyncJob();
            }}
          >
            <RefreshCw className="h-4 w-4" />
            Синхронизировать
          </Button>
        }
      />

      {syncIssues.length > 0 ? (
        <Alert className="mb-6 border-amber-200 bg-amber-50 text-amber-950">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Статус синхронизации источника</AlertTitle>
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
      ) : (
        <Alert className="mb-6 border-emerald-200 bg-emerald-50 text-emerald-950">
          <RefreshCw className="h-4 w-4" />
          <AlertTitle>Источник актуален</AlertTitle>
          <AlertDescription>
            Согласованный источник (мок) синхронизирован. Последнее обновление —
            сегодня.
          </AlertDescription>
        </Alert>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input
          placeholder="Поиск по названию, номеру, заказчику"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Select value={status} onValueChange={(v) => setStatus(v ?? "all")}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Статус карточки" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все статусы</SelectItem>
            {(
              [
                "zagruzheno",
                "v_rabote",
                "gotovo",
                "trebuet_proverki",
                "oshibka",
              ] as CardStatus[]
            ).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={review} onValueChange={(v) => setReview(v ?? "all")}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Рассмотрение" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все рассмотрения</SelectItem>
            {(
              [
                "novaya",
                "na_rassmotrenii",
                "odobrena",
                "otklonena",
                "dublirovana",
              ] as ReviewStatus[]
            ).map((s) => (
              <SelectItem key={s} value={s}>
                {REVIEW_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={region} onValueChange={(v) => setRegion(v ?? "all")}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Регион" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все регионы</SelectItem>
            {regions.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="Закупки не найдены"
          description="Измените фильтры или дождитесь следующей синхронизации источника."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((p) => (
            <EntityCard
              key={p.id}
              href={`/cabinet/zakupki/${p.id}`}
              title={p.title}
              subtitle={p.number}
              status={p.status}
              meta={
                <div className="space-y-1">
                  <div>{p.customer}</div>
                  <div className="flex flex-wrap gap-x-3">
                    <span>{formatMoney(p.nmck)}</span>
                    <span>до {formatDate(p.deadline)}</span>
                    <span>{p.region}</span>
                  </div>
                  {p.duplicateOf ? (
                    <div className="text-amber-800">
                      Дубликат закупки {p.duplicateOf}
                    </div>
                  ) : null}
                </div>
              }
              footer={
                <div className="flex items-center justify-between gap-2">
                  <ReviewBadge status={p.reviewStatus} />
                  <span className="text-xs text-[var(--tk-muted)]">
                    вложений: {p.attachments.length}
                  </span>
                </div>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
