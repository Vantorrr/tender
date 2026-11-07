"use client";

import { EmptyState } from "@/components/empty-state";
import { EntityCard } from "@/components/entity-card";
import { PageHeader } from "@/components/page-header";
import { calculationTotals } from "@/lib/calc-math";
import { formatMoney } from "@/lib/format";
import { SCENARIO_LABELS } from "@/lib/roles";
import { useStore } from "@/lib/store";

export default function RaschetyPage() {
  const { data, user } = useStore();
  if (!user) return null;
  const items = data.calculations.filter((c) => c.orgId === user.orgId);

  return (
    <div>
      <PageHeader
        title="Расчёты"
        description="Сметные расчёты на основе справочников: позиции, итоги, допущения и сценарии."
      />
      {items.length === 0 ? (
        <EmptyState
          title="Расчётов нет"
          description="Создайте расчёт из карточки закупки после разбора документов."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {items.map((c) => {
            const total = calculationTotals(c).total;
            return (
              <EntityCard
                key={c.id}
                href={`/cabinet/raschety/${c.id}`}
                title={c.title}
                subtitle={`Версия ${c.version} · сценарий ${SCENARIO_LABELS[c.scenario]}`}
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
