"use client";

import { useParams } from "next/navigation";
import { toast } from "sonner";
import { ErrorState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { downloadUrl } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useStore } from "@/lib/store";

function daysBetween(a: string, b: string) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.max(1, Math.round(ms / 86400000));
}

export default function GprDetailPage() {
  const params = useParams<{ id: string }>();
  const { data, user, updateSchedule } = useStore();
  if (!user) return null;
  const schedule = data.schedules.find(
    (s) => s.id === params.id && s.orgId === user.orgId
  );
  if (!schedule) return <ErrorState title="ГПР не найден" />;

  const minStart = schedule.stages.reduce(
    (m, s) => (s.start < m ? s.start : m),
    schedule.stages[0]?.start ?? ""
  );
  const maxEnd = schedule.stages.reduce(
    (m, s) => (s.end > m ? s.end : m),
    schedule.stages[0]?.end ?? ""
  );
  const totalDays = daysBetween(minStart, maxEnd) || 1;

  return (
    <div>
      <PageHeader
        title={schedule.title}
        description={`Расчёт «${
          data.calculations.find((c) => c.id === schedule.calculationId)?.title ??
          "—"
        }» · версия ${schedule.version}`}
        actions={
          <>
            <StatusBadge status={schedule.status} />
            <Button
              variant="outline"
              onClick={() => {
                updateSchedule(schedule.id, {
                  version: schedule.version + 1,
                });
                toast.success("Создана новая версия ГПР");
              }}
            >
              Новая версия
            </Button>
            <Button
              onClick={() => {
                downloadUrl(`/api/export?kind=gpr-xlsx&id=${schedule.id}`);
                toast.success("Скачивание XLSX…");
              }}
            >
              Экспорт
            </Button>
          </>
        }
      />

      <div className="mb-6 overflow-x-auto rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
        <h2 className="mb-4 font-[family-name:var(--font-display)] text-base">
          Календарь этапов
        </h2>
        <div className="min-w-[640px] space-y-3">
          {schedule.stages
            .slice()
            .sort((a, b) => a.sequence - b.sequence)
            .map((stage) => {
              const offset = daysBetween(minStart, stage.start) - 1;
              const width = daysBetween(stage.start, stage.end);
              return (
                <div key={stage.id} className="grid grid-cols-[180px_1fr] gap-3 items-center">
                  <div className="text-sm">
                    <div className="font-medium">{stage.name}</div>
                    <div className="text-xs text-[var(--tk-muted)]">
                      {formatDate(stage.start)} — {formatDate(stage.end)}
                    </div>
                  </div>
                  <div className="relative h-8 rounded-md bg-[var(--tk-steel-50)]">
                    <div
                      className="absolute top-1 h-6 rounded-md bg-[var(--tk-steel)]/85"
                      style={{
                        left: `${(offset / totalDays) * 100}%`,
                        width: `${(width / totalDays) * 100}%`,
                        minWidth: 8,
                      }}
                    />
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="font-[family-name:var(--font-display)] text-base">
          Редактирование этапов
        </h2>
        {schedule.stages
          .slice()
          .sort((a, b) => a.sequence - b.sequence)
          .map((stage) => (
            <div
              key={stage.id}
              className="grid gap-2 rounded-xl border border-[var(--tk-line)] bg-white/80 p-3 sm:grid-cols-4"
            >
              <Input
                value={stage.name}
                onChange={(e) => {
                  updateSchedule(schedule.id, {
                    stages: schedule.stages.map((s) =>
                      s.id === stage.id ? { ...s, name: e.target.value } : s
                    ),
                  });
                }}
              />
              <Input
                type="date"
                value={stage.start}
                onChange={(e) => {
                  updateSchedule(schedule.id, {
                    stages: schedule.stages.map((s) =>
                      s.id === stage.id ? { ...s, start: e.target.value } : s
                    ),
                  });
                }}
              />
              <Input
                type="date"
                value={stage.end}
                onChange={(e) => {
                  updateSchedule(schedule.id, {
                    stages: schedule.stages.map((s) =>
                      s.id === stage.id ? { ...s, end: e.target.value } : s
                    ),
                  });
                }}
              />
              <div className="flex items-center text-sm text-[var(--tk-muted)]">
                Порядок {stage.sequence}
                {stage.dependsOn
                  ? ` · после ${
                      schedule.stages.find((s) => s.id === stage.dependsOn)?.name ??
                      "предыдущего этапа"
                    }`
                  : ""}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
