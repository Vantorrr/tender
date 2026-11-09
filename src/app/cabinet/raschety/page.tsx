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
  const drafts = items.filter(
    (c) => c.kind !== "customer_original" && !c.immutable
  );
  const originals = items.filter(
    (c) => c.kind === "customer_original" || c.immutable
  );

  return (
    <div>
      <PageHeader
        title="Расчёты"
        description="Список рассчитанных тендеров. Черновик редактируем; оригинал сметы заказчика неизменяем. Без обещания точности."
      />
      {items.length === 0 ? (
        <EmptyState
          title="Расчётов нет"
          description="Нажмите «Отправить в расчёт» в карточке закупки."
        />
      ) : (
        <div className="space-y-8">
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--tk-muted)]">
              Ресурсные черновики
            </h2>
            <div className="grid gap-4 md:grid-cols-2">
              {drafts.map((c) => {
                const total = calculationTotals(c).total;
                const proc = data.procurements.find(
                  (p) => p.id === c.procurementId
                );
                return (
                  <EntityCard
                    key={c.id}
                    href={`/cabinet/raschety/${c.id}`}
                    title={c.title}
                    subtitle={`v${c.version} · ${SCENARIO_LABELS[c.scenario]}${
                      proc ? ` · ${proc.number}` : ""
                    }`}
                    status={c.status}
                    meta={
                      <div className="space-y-1">
                        <div>Позиций: {c.positions.length}</div>
                        <div className="font-semibold text-[var(--tk-ink)]">
                          Итого {formatMoney(total)}
                        </div>
                        <div className="text-xs text-emerald-800">
                          Редактируемый черновик
                        </div>
                        {(c.dataFlags ?? []).includes("requires_manual_check") ? (
                          <div className="text-xs text-amber-800">
                            Требует ручной проверки
                          </div>
                        ) : null}
                      </div>
                    }
                  />
                );
              })}
            </div>
          </section>
          {originals.length ? (
            <section>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--tk-muted)]">
                Оригиналы смет заказчика (immutable)
              </h2>
              <div className="grid gap-4 md:grid-cols-2">
                {originals.map((c) => {
                  const total = calculationTotals(c).total;
                  return (
                    <EntityCard
                      key={c.id}
                      href={`/cabinet/raschety/${c.id}`}
                      title={c.title}
                      subtitle={`Только просмотр · v${c.version}`}
                      status={c.status}
                      meta={
                        <div className="space-y-1">
                          <div className="font-semibold">
                            {formatMoney(total)}
                          </div>
                          <div className="text-xs text-stone-600">
                            Собственные ресурсы сюда не добавляются
                          </div>
                        </div>
                      }
                    />
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
