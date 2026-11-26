"use client";

import { QuantityCommitField } from "@/components/quantity-commit-field";
import { Button } from "@/components/ui/button";
import { volumeStatusLabel } from "@/lib/commercial-packages";
import { foldNormSearch } from "@/lib/client-norms";
import type { CalcPosition, GprStage } from "@/lib/types";

export function VorWorkplace({
  positions,
  stages,
  locked,
  onVolume,
  onStatus,
}: {
  positions: CalcPosition[];
  stages: GprStage[];
  locked: boolean;
  onVolume: (positionId: string, volume: number) => Promise<void> | void;
  onStatus: (positionId: string, status: "unconfirmed" | "confirmed") => Promise<void> | void;
}) {
  const rows = positions.filter((position) => position.code === "ВОР");
  return (
    <section className="mb-6 rounded-xl border border-[var(--tk-line)] bg-white/80 p-4" data-testid="vor-workplace">
      <h2 className="text-sm font-semibold">Рабочее место ВОР</h2>
      <p className="mt-1 text-sm text-[var(--tk-muted)]">
        Объём можно поправить вручную. Пока строка не подтверждена, статус — «не подтверждено». Новый объём пересчитывает длительность пакета и коммерческую цену.
      </p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--tk-muted)]" data-testid="vor-workplace-empty">В расчёте пока нет строк ведомости объёмов.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {rows.map((row) => {
            const key = foldNormSearch(row.name);
            const stage = stages.find((item) => item.durationBasis && foldNormSearch(item.workName ?? item.name) === key);
            const status = volumeStatusLabel(row.volumeStatus);
            return (
              <div key={row.id} className="grid gap-2 rounded-lg border border-[var(--tk-line)] p-3 md:grid-cols-[minmax(0,1.4fr)_6rem_9rem_auto]" data-testid={`vor-row-${row.id}`}>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{row.name}</div>
                  <div className="text-xs text-[var(--tk-muted)]">
                    {row.unit}
                    {stage?.durationDays != null ? ` · ${trimDays(stage.durationDays)} сут. по выработке` : ""}
                    {stage?.benchmarkSource ? ` · ${stage.benchmarkSource}` : ""}
                  </div>
                </div>
                <QuantityCommitField
                  label="Объём"
                  value={row.quantity}
                  ariaLabel={`Объём ${row.name}`}
                  testId={`vor-qty-${row.id}`}
                  onCommit={(volume) => onVolume(row.id, volume)}
                />
                <div className="flex items-center text-sm" data-testid={`vor-status-${row.id}`}>{status}</div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={locked || row.volumeStatus === "confirmed"}
                  onClick={() => { void onStatus(row.id, "confirmed"); }}
                >
                  Подтвердить
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function trimDays(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(rounded);
}
