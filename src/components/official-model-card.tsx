"use client";

import type { ResourceScheduleParams } from "@/lib/resource-schedule-model";
import type { GprStage } from "@/lib/types";

export function OfficialModelCard({
  params,
  stages,
}: {
  params?: ResourceScheduleParams | null;
  stages?: GprStage[] | null;
}) {
  const equipmentShifts = params?.equipmentShiftsPerDay ?? 2;
  const equipmentLabel = equipmentShifts === 1 ? "смена" : "смены";
  const shifts = params
    ? `${params.personnelShiftsPerDay}×${params.hoursPerShift}, техника ${equipmentShifts} ${equipmentLabel}`
    : "2×11, техника 2 смены";
  const officialShifts = !params
    || (params.personnelShiftsPerDay === 2 && params.hoursPerShift === 11 && params.equipmentShiftsPerDay === 2);
  const tagged = (stages ?? []).filter((stage) => stage.durationBasis);
  const fromOutput = tagged.filter((stage) => stage.durationBasis === "output_shift" || stage.durationBasis === "site_daily");
  return (
    <section className="mb-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950" data-testid="official-model-card">
      <h2 className="font-semibold">Официальная модель расчёта</h2>
      <p className="mt-1">
        Накладные 43% от прямых, непредвиденные 10% от себестоимости с накладными, прибыль 40% от себестоимости с накладными. Цена без НДС = себестоимость с накладными × 1,50.
      </p>
      <p className="mt-1">
        Профиль смен: {shifts}{officialShifts ? ", без выходных" : ""}.
        {params ? ` НР ${Math.round(params.overheadRate * 100)}%, прибыль ${Math.round(params.profitMarkupOnCostWithOh * 100)}%.` : " Новый расчёт создаётся сразу с этим профилем."}
      </p>
      <p className="mt-1">
        ГПР строится от выработки (ОРЧ, труба, бурение и нормы смены 11 ч, где тип работы совпал). Срок ТЗ по строкам сметы не делится.
        {tagged.length ? ` Этапов с длительностью: ${fromOutput.length} из ${tagged.length}.` : ""}
      </p>
    </section>
  );
}
