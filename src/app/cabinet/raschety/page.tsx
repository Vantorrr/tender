"use client";

import { EmptyState } from "@/components/empty-state";
import { EntityCard } from "@/components/entity-card";
import { PageHeader } from "@/components/page-header";
import { formatMoney } from "@/lib/format";
import { useStore } from "@/lib/store";

export default function RaschetyPage() {
  const { data, user } = useStore();
  if (!user) return null;
  const items = data.calculations.filter((c) => c.orgId === user.orgId);

  return (
    <div>
      <PageHeader
        title="Расчёты"
        description="Черновые сметные расчёты на основе справочников: позиции, итоги, допущения и сценарии."
      />
      {items.length === 0 ? (
        <EmptyState
          title="Расчётов нет"
          description="Создайте черновой расчёт из карточки закупки после разбора документов."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {items.map((c) => {
            const total =
              c.positions.reduce((s, p) => s + p.quantity * p.rate, 0) *
              c.scenarioFactor;
            return (
              <EntityCard
                key={c.id}
                href={`/cabinet/raschety/${c.id}`}
                title={c.title}
                subtitle={`Версия ${c.version} · сценарий ${c.scenario}`}
                status={c.status}
                meta={
                  <div className="space-y-1">
                    <div>Позиций: {c.positions.length}</div>
                    <div className="font-semibold text-[var(--tk-ink)]">
                      Итого {formatMoney(total)}
                    </div>
                    <div>
                      Решение:{" "}
                      {c.participateDecision === "uchastvovat"
                        ? "участвовать"
                        : c.participateDecision === "otkaz"
                          ? "отказ"
                          : c.participateDecision === "na_rassmotrenii"
                            ? "на рассмотрении"
                            : "не принято"}
                    </div>
                  </div>
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
