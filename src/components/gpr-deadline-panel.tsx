"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { deadlineView, shiftsForDeadline, type AccelerationLever } from "@/lib/commercial-packages";
import type { GprSchedule } from "@/lib/types";

export function GprDeadlinePanel({
  schedule,
  onApply,
}: {
  schedule: GprSchedule;
  onApply: (lever: AccelerationLever) => Promise<void> | void;
}) {
  const [busy, setBusy] = useState<AccelerationLever | null>(null);
  const view = deadlineView({
    stages: schedule.stages,
    deadline: schedule.deadline ?? null,
    shiftsPerDay: shiftsForDeadline(schedule.stages, schedule.calendar?.shiftsPerDay),
  });
  if (!view.applicable) return null;
  const tagged = schedule.stages.filter((stage) => stage.durationBasis);
  return (
    <section className="mb-4 rounded-xl border border-[var(--tk-line)] bg-white/90 p-4" data-testid="gpr-deadline">
      <h2 className="text-sm font-semibold">Срок ТЗ и выработка</h2>
      <p className="mt-1 text-sm" data-testid="gpr-deadline-message">{view.message}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!view.shiftAvailable || busy != null}
          title={view.shiftAvailable ? "Добавить смену до двух и пересчитать" : "Уже 2 смены в сутки"}
          data-testid="gpr-lever-shift"
          onClick={() => { void run("shift"); }}
        >
          {busy === "shift" ? "Считаю…" : "Ещё смена"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!view.mechanismAvailable || busy != null}
          title="Добавить механизм или звено и пересчитать"
          data-testid="gpr-lever-mechanism"
          onClick={() => { void run("mechanism"); }}
        >
          {busy === "mechanism" ? "Считаю…" : "Ещё механизм"}
        </Button>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-xs" data-testid="gpr-output-hint">
          <thead>
            <tr className="text-[var(--tk-muted)]">
              <th className="py-1 pr-2 font-medium">Работа</th>
              <th className="py-1 pr-2 font-medium">Длительность</th>
              <th className="py-1 pr-2 font-medium">Подсказка ГЭСН, ч</th>
              <th className="py-1 font-medium">Источник</th>
            </tr>
          </thead>
          <tbody>
            {tagged.map((stage) => (
              <tr key={stage.id} className="border-t border-[var(--tk-line)]" data-testid={`gpr-output-row-${stage.id}`}>
                <td className="py-1 pr-2 align-top">{stage.workName ?? stage.name}</td>
                <td className="py-1 pr-2 align-top">{stage.durationDays != null && stage.durationDays > 0 ? `${trimDays(stage.durationDays)} сут.` : "не по выработке"}</td>
                <td className="py-1 pr-2 align-top">{stage.gesnHoursHint != null ? trimDays(stage.gesnHoursHint) : "—"}</td>
                <td className="py-1 align-top">
                  {stage.benchmarkSource ?? "—"}
                  {stage.benchmarkCrew?.length ? (
                    <div className="text-[var(--tk-muted)]">
                      {stage.benchmarkCrew.map((line) => `${line.role.trim()} ${line.count}`).join(", ")}
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );

  async function run(lever: AccelerationLever) {
    setBusy(lever);
    try {
      await onApply(lever);
    } finally {
      setBusy(null);
    }
  }
}

function trimDays(value: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(Math.round(value * 100) / 100);
}
