"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import type { Calculation, GprStage, SupplyRequest, User } from "@/lib/types";
import {
  averageQuoteHint,
  bddsReadiness,
  buildBddsFrame,
  buildNmckCostGap,
  DIRECTOR_DECISION_OPTIONS,
  directorDecisionLabel,
  displayedCalculationOwner,
  isCommercialRateLine,
  ownerRoleLabel,
  quoteSelectionState,
  suitableQuotesForPosition,
  type DirectorDecisionChoice,
} from "@/lib/wave5-client";

async function postCalculation(body: Record<string, unknown>) {
  await api("/api/raschety", { method: "POST", body: JSON.stringify(body) });
}

export function CalculationOwnerBar({
  calculation,
  users,
  locked,
  onChanged,
}: {
  calculation: Calculation;
  users: User[];
  locked: boolean;
  onChanged: () => Promise<void>;
}) {
  const owner = displayedCalculationOwner(calculation, users);
  const [busy, setBusy] = useState(false);
  const candidates = users.filter((user) => user.orgId === calculation.orgId && !user.blocked);

  async function assign(ownerUserId: string) {
    if (!ownerUserId || ownerUserId === calculation.ownerUserId) return;
    setBusy(true);
    try {
      await postCalculation({ action: "assignOwner", calculationId: calculation.id, ownerUserId });
      await onChanged();
      toast.success("Ответственный за сбор сохранён");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось назначить ответственного");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-4 rounded-xl border border-[var(--tk-line)] bg-white/80 px-4 py-3" data-testid="calc-owner">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs text-[var(--tk-muted)]">Ответственный за сбор</div>
          <div className="mt-1 text-sm font-semibold">
            {owner ? `${owner.name} · ${ownerRoleLabel(owner.role)}` : "Не назначен"}
          </div>
          {calculation.lastEditorName ? (
            <p className="mt-1 text-xs text-[var(--tk-muted)]">
              Последний редактор: {calculation.lastEditorName}
              {calculation.lastEditedAt ? ` · ${new Date(calculation.lastEditedAt).toLocaleString("ru-RU")}` : ""}
            </p>
          ) : (
            <p className="mt-1 text-xs text-[var(--tk-muted)]">Остальные роли организации тоже могут править расчёт. Отдельное визирование каждого шага не требуется.</p>
          )}
        </div>
        {locked ? null : (
          <label className="text-xs text-[var(--tk-muted)]">
            Переназначить
            <select
              className="mt-1 block rounded-lg border border-[var(--tk-line)] bg-white px-2 py-1 text-sm text-[var(--tk-ink)]"
              data-testid="calc-owner-select"
              disabled={busy}
              value={calculation.ownerUserId ?? owner?.userId ?? ""}
              onChange={(event) => void assign(event.target.value)}
            >
              {candidates.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name} · {ownerRoleLabel(user.role)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </section>
  );
}

export function QuoteRatePicker({
  calculation,
  supplies,
  locked,
  onChanged,
}: {
  calculation: Calculation;
  supplies: SupplyRequest[];
  locked: boolean;
  onChanged: () => Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const lines = calculation.positions.filter((position) => isCommercialRateLine(position));

  async function apply(positionId: string, quoteId: string | null) {
    setBusyId(`${positionId}:${quoteId ?? "reset"}`);
    try {
      await postCalculation({
        action: "applyQuote",
        calculationId: calculation.id,
        positionId,
        quoteId,
      });
      await onChanged();
      toast.success(quoteId ? "Цена КП записана в ставку, итог пересчитан" : "Выбор КП сброшен, итог пересчитан");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось записать КП");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="mb-4 rounded-xl border border-[var(--tk-line)] bg-white/80 p-4" data-testid="quote-rate-picker">
      <h2 className="text-sm font-semibold">КП поставщиков</h2>
      <p className="mt-1 text-sm text-[var(--tk-muted)]">
        Система не выбирает самое дешёвое КП. Средняя цена — стартовая подсказка. В ставку коммерческой строки цена попадает только по кнопке «Применить КП в ставку», после чего официальный итог пересчитывается по формуле 43% / 10% / 40%.
      </p>
      {lines.length === 0 ? (
        <p className="mt-3 text-sm">Коммерческих строк пока нет. Добавьте строку, чтобы записать в неё цену из КП.</p>
      ) : (
        <div className="mt-3 grid gap-3">
          {lines.map((position) => {
            const offers = suitableQuotesForPosition(position, supplies, calculation.procurementId);
            const hint = averageQuoteHint(offers.map((offer) => offer.unitPrice));
            const appliedQuote = quoteSelectionState(position, supplies);
            return (
              <article key={position.id} className="rounded-lg border border-[var(--tk-line)] p-3" data-testid={`quote-line-${position.id}`}>
                <div className="text-sm font-medium">{position.name}</div>
                <p className="mt-1 text-xs text-[var(--tk-muted)]">
                  Ставка сейчас: {position.rateMissing || !(position.rate > 0) ? "нет ставки" : formatMoney(position.rate)}
                  {appliedQuote.applied && appliedQuote.supplierName ? ` · КП ${appliedQuote.supplierName}` : ""}
                  {appliedQuote.applied ? " · Выбрано в ставку" : ""}
                </p>
                <p className="mt-2 text-sm" data-testid={`quote-hint-${position.id}`}>{hint.label}</p>
                {hint.average != null ? <p className="text-sm font-semibold">{formatMoney(hint.average)}</p> : null}
                {hint.spreadLabel ? <p className="text-xs text-[var(--tk-muted)]">{hint.spreadLabel}</p> : null}
                {offers.length === 0 ? (
                  <p className="mt-2 text-xs text-[var(--tk-muted)]">Активных КП по этой позиции нет.</p>
                ) : (
                  <ul className="mt-2 grid gap-2">
                    {offers.map((offer) => {
                      const selected = appliedQuote.applied && appliedQuote.quoteId === offer.quoteId;
                      return (
                        <li key={offer.quoteId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                          <span>
                            {offer.supplierName} · {formatMoney(offer.unitPrice)}
                            {selected ? <span className="ml-2 text-emerald-800">Выбрано в ставку</span> : null}
                          </span>
                          {locked ? null : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busyId != null}
                              data-testid={`apply-quote-${offer.quoteId}`}
                              onClick={() => void apply(position.id, offer.quoteId)}
                            >
                              Применить КП в ставку
                            </Button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {!locked && appliedQuote.applied ? (
                  <Button
                    className="mt-2"
                    size="sm"
                    variant="outline"
                    disabled={busyId != null}
                    data-testid={`reset-quote-${position.id}`}
                    onClick={() => void apply(position.id, null)}
                  >
                    Сбросить выбор КП
                  </Button>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function DirectorCostGap({
  calculation,
  nmck,
  fullCost,
  locked,
  onChanged,
}: {
  calculation: Calculation;
  nmck: number | null | undefined;
  fullCost: number | null | undefined;
  locked: boolean;
  onChanged: () => Promise<void>;
}) {
  const gap = buildNmckCostGap({
    nmck,
    direct: calculation.costSummary?.direct,
    overhead: calculation.costSummary?.overhead,
    contingency: calculation.costSummary?.reserve,
    fullCost,
    officialPrice: calculation.costSummary?.priceExVat,
    lines: calculation.positions,
  });
  const [choice, setChoice] = useState<DirectorDecisionChoice>(calculation.directorDecision?.choice ?? "participate");
  const [comment, setComment] = useState(calculation.directorDecision?.comment ?? "");
  const [busy, setBusy] = useState(false);
  if (!gap.triggered) return null;

  const rows: Array<[string, string]> = [
    ["НМЦК", gap.nmck == null ? "нет данных" : formatMoney(gap.nmck)],
    ["Прямые затраты", gap.direct == null ? "нет данных" : formatMoney(gap.direct)],
    ["НР", gap.overhead == null ? "нет данных" : formatMoney(gap.overhead)],
    ["Непредвиденные (10%)", gap.contingency == null ? "нет данных" : formatMoney(gap.contingency)],
    ["Полная себестоимость", gap.fullCost == null ? "нет данных" : formatMoney(gap.fullCost)],
    ["Официальная цена с прибылью", gap.officialPrice == null ? "нет данных" : formatMoney(gap.officialPrice)],
  ];

  async function save() {
    setBusy(true);
    try {
      await postCalculation({
        action: "saveDirectorDecision",
        calculationId: calculation.id,
        choice,
        comment,
      });
      await onChanged();
      toast.success("Решение директора сохранено. Автоматического отказа нет.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось сохранить решение");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="lg:col-span-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950" data-testid="nmck-gap-analysis">
      <h2 className="font-semibold">{gap.headline}</h2>
      <p className="mt-1">НМЦК не покрывает полную себестоимость. Система не ставит отказ сама: решение принимает директор.</p>
      <dl className="mt-3 grid gap-2 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-amber-900/80">{label}</dt>
            <dd className="font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 font-medium" data-testid="nmck-deficit">
        Разрыв: {gap.deficitRub == null ? "нет данных" : formatMoney(gap.deficitRub)}
        {gap.deficitPercentOfNmck != null ? ` · ${gap.deficitPercentOfNmck.toLocaleString("ru-RU")}% к НМЦК` : ""}
      </p>
      {gap.topDrivers.length ? (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide">Что сильнее всего давит на себестоимость</p>
          <ol className="mt-1 list-decimal pl-5">
            {gap.topDrivers.map((driver) => (
              <li key={driver.id}>
                {driver.name} · {formatMoney(driver.amount)}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      <div className="mt-3 rounded-lg bg-white/70 p-3" data-testid="director-decision">
        <p className="text-xs font-semibold">Решение директора</p>
        <div className="mt-2 grid gap-1">
          {DIRECTOR_DECISION_OPTIONS.map((option) => (
            <label key={option.id} className="flex items-center gap-2">
              <input
                type="radio"
                name={`director-${calculation.id}`}
                value={option.id}
                checked={choice === option.id}
                disabled={locked || busy}
                onChange={() => setChoice(option.id)}
              />
              {option.label}
            </label>
          ))}
        </div>
        <Textarea
          className="mt-2 bg-white"
          value={comment}
          disabled={locked || busy}
          placeholder="Комментарий и обоснование"
          onChange={(event) => setComment(event.target.value)}
        />
        {locked ? null : (
          <Button className="mt-2" size="sm" disabled={busy} onClick={() => void save()}>
            Сохранить решение директора
          </Button>
        )}
        {calculation.directorDecision ? (
          <p className="mt-2 text-xs">
            Сохранено: {directorDecisionLabel(calculation.directorDecision.choice)} · {calculation.directorDecision.authorName} · {new Date(calculation.directorDecision.at).toLocaleString("ru-RU")}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function BddsFrameCard({
  calculation,
  stages,
}: {
  calculation: Calculation;
  stages: Array<Pick<GprStage, "name" | "start" | "end">>;
}) {
  const frame = buildBddsFrame(bddsReadiness({ calculation, stages }));
  return (
    <section className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4" data-testid="bdds-frame">
      <h2 className="text-sm font-semibold">БДДС</h2>
      <p className="mt-2 text-sm">{frame.statusText}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--tk-muted)]">Уже есть со стороны расчёта</p>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {frame.readyInputs.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--tk-muted)]">Правил оплаты ещё нет</p>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {frame.missingRules.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      </div>
      <p className="mt-3 text-xs text-[var(--tk-muted)]">Кассовый разрыв, авансы и график оплат здесь не считаются и не подставляются.</p>
    </section>
  );
}
