"use client";

import { EmptyState } from "@/components/empty-state";
import { EntityCard } from "@/components/entity-card";
import { PageHeader } from "@/components/page-header";
import { formatDate } from "@/lib/format";
import { useStore } from "@/lib/store";

export default function GprPage() {
  const { data, user } = useStore();
  if (!user) return null;
  const items = data.schedules.filter((s) => s.orgId === user.orgId);

  return (
    <div>
      <PageHeader
        title="ГПР"
        description="Раздел убран из сайдбара — график ведётся внутри карточки закупки/расчёта. Drag Ганта — этап 2."
      />
      {items.length === 0 ? (
        <EmptyState
          title="Графиков нет"
          description="Сформируйте ГПР из расчёта по закупке."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {items.map((s) => (
            <EntityCard
              key={s.id}
              href={`/cabinet/gpr/${s.id}`}
              title={s.title}
              subtitle={`Версия ${s.version} · этапов ${s.stages.length}`}
              status={s.status}
              meta={
                <div>
                  {s.stages[0]
                    ? `${formatDate(s.stages[0].start)} — ${formatDate(
                        s.stages[s.stages.length - 1].end
                      )}`
                    : "Нет этапов"}
                </div>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
