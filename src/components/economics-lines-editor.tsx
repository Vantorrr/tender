"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { EconomicsLineKey, EconomicsLineOverride, EconomicsManual } from "@/lib/client-economics";
import { formatMoney } from "@/lib/format";
import type { CostSummarySnapshot } from "@/lib/types";

const LINES: Array<{
  key: EconomicsLineKey;
  title: string;
  formula: string;
}> = [
  { key: "overhead", title: "Накладные расходы", formula: "43% от прямых" },
  { key: "reserve", title: "Непредвиденные", formula: "10% от прямых с накладными" },
  { key: "profit", title: "Прибыль", formula: "40% от прямых с накладными, без резерва" },
];

function percentText(part: number | null | undefined, base: number | null | undefined): string {
  if (part == null || base == null || !(base > 0)) return "";
  return String(Math.round((part / base) * 10000) / 100);
}

export function EconomicsLinesEditor({
  calculationId,
  summary,
  manual,
  locked,
  onSaved,
}: {
  calculationId: string;
  summary?: CostSummarySnapshot | null;
  manual?: EconomicsManual | null;
  locked?: boolean;
  onSaved: () => Promise<void>;
}) {
  const direct = summary?.direct ?? summary?.resourceSlices?.direct ?? null;
  const overhead = summary?.overhead ?? summary?.resourceSlices?.overhead ?? null;
  const amounts: Record<EconomicsLineKey, number | null> = {
    overhead,
    reserve: summary?.reserve ?? null,
    profit: summary?.profit ?? null,
  };
  const bases: Record<EconomicsLineKey, number | null> = {
    overhead: direct,
    reserve: summary?.C0 ?? null,
    profit: summary?.C0 ?? null,
  };
  const [draft, setDraft] = useState<Record<EconomicsLineKey, { percent: string; amount: string; mode: "rate" | "amount" }>>(() => {
    const initial = {} as Record<EconomicsLineKey, { percent: string; amount: string; mode: "rate" | "amount" }>;
    for (const line of LINES) {
      const saved = manual?.[line.key];
      initial[line.key] = {
        mode: saved?.mode ?? "rate",
        percent: saved?.mode === "rate"
          ? String(Math.round(saved.value * 10000) / 100)
          : percentText(amounts[line.key], bases[line.key]),
        amount: saved?.mode === "amount"
          ? String(saved.value)
          : amounts[line.key] == null ? "" : String(amounts[line.key]),
      };
    }
    return initial;
  });
  const [dirty, setDirty] = useState<Set<EconomicsLineKey>>(new Set());
  const [saving, setSaving] = useState(false);

  async function send(patch: {
    overhead?: EconomicsLineOverride | null;
    reserve?: EconomicsLineOverride | null;
    profit?: EconomicsLineOverride | null;
  }, success: string) {
    setSaving(true);
    try {
      await api("/api/raschety", {
        method: "PATCH",
        body: JSON.stringify({
          id: calculationId,
          recomputeCost: true,
          costPatch: { useResourceScheduleEconomics: true, economicsManual: patch },
        }),
      });
      await onSaved();
      toast.success(success);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось сохранить правку");
    } finally {
      setSaving(false);
    }
  }

  function edit(key: EconomicsLineKey, mode: "rate" | "amount", value: string) {
    setDraft((current) => ({
      ...current,
      [key]: { ...current[key], mode, ...(mode === "rate" ? { percent: value } : { amount: value }) },
    }));
    setDirty((current) => new Set(current).add(key));
  }

  return (
    <div className="grid gap-3 lg:grid-cols-3" data-testid="economics-lines">
      {LINES.map((line) => {
        const manualLine = Boolean(summary?.manualLines?.includes(line.key) || manual?.[line.key]);
        const row = draft[line.key];
        return (
          <div key={line.key} className="rounded-xl border border-[var(--tk-line)] bg-white/80 px-3 py-3" data-testid={`economics-${line.key}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs text-[var(--tk-muted)]">{line.title}</div>
              {manualLine ? (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-950" data-testid={`economics-${line.key}-manual`}>
                  Ручная правка
                </span>
              ) : (
                <span className="text-[10px] text-[var(--tk-muted)]">По формуле</span>
              )}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="text-xs text-[var(--tk-muted)]">
                Процент
                <Input
                  className="mt-1"
                  inputMode="decimal"
                  disabled={locked || saving}
                  aria-label={`${line.title}, процент`}
                  value={row.percent}
                  onChange={(event) => edit(line.key, "rate", event.target.value)}
                />
              </label>
              <label className="text-xs text-[var(--tk-muted)]">
                Сумма, ₽
                <Input
                  className="mt-1"
                  inputMode="decimal"
                  disabled={locked || saving}
                  aria-label={`${line.title}, сумма`}
                  value={row.amount}
                  onChange={(event) => edit(line.key, "amount", event.target.value)}
                />
              </label>
            </div>
            <p className="mt-2 text-xs text-[var(--tk-muted)]">
              {manualLine
                ? "Эту величину задал пользователь. Пересчёт её не затирает, пока правку не сбросить."
                : `Сейчас считает смета: ${line.formula}.`}
              {amounts[line.key] != null ? ` Сейчас ${formatMoney(amounts[line.key] ?? 0)}.` : ""}
            </p>
            {locked ? null : (
              <Button
                className="mt-2"
                size="sm"
                variant="ghost"
                disabled={saving || !manualLine}
                onClick={() => void send({ [line.key]: null }, "Строка снова считается по формуле")}
              >
                Сбросить к формуле
              </Button>
            )}
          </div>
        );
      })}
      {locked ? null : (
        <div className="lg:col-span-3">
          <Button
            size="sm"
            disabled={saving || dirty.size === 0}
            data-testid="economics-save-manual"
            onClick={() => {
              const patch: {
                overhead?: EconomicsLineOverride | null;
                reserve?: EconomicsLineOverride | null;
                profit?: EconomicsLineOverride | null;
              } = {};
              for (const key of dirty) {
                const row = draft[key];
                const parsed = Number(String(row.mode === "rate" ? row.percent : row.amount).replace(/\s/g, "").replace(",", "."));
                if (!Number.isFinite(parsed) || parsed < 0) {
                  toast.error("Введите неотрицательное число");
                  return;
                }
                patch[key] = { mode: row.mode, value: row.mode === "rate" ? parsed / 100 : parsed };
              }
              void send(patch, "Ручная правка сохранена и не смешается с формулой сметы");
            }}
          >
            {saving ? "Пересчёт…" : "Сохранить ручную правку"}
          </Button>
        </div>
      )}
    </div>
  );
}
