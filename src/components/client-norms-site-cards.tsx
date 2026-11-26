import { siteShowsC55Warning } from "@/lib/client-norms";

function showNum(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 4 }).format(value);
}

export interface SiteNormHeader {
  daily?: {
    orchMountedPerDay_fromTimeStudy?: number;
    supportsExtendedPerDay_fromTimeStudy?: number;
    extendingOneRigelHoursPerZveno?: number;
    pipeline?: { note?: string };
    project_0_68_resolution?: {
      februaryPlanOrch?: number;
      currentOutputOrchPerDay?: number;
      planOrchPerDay?: number;
      shiftsMentioned?: string;
    };
    project_88_127_resolution?: {
      februaryPlanOrch?: number;
      currentOutputOrchPerDay?: number;
      planOrchPerDay?: number;
    };
  };
  typo118?: {
    cell?: string;
    valueInCell?: number;
    valueIfDividedBy60Hours?: number;
  };
}

const SITE_CARDS = ["0-68", "88-127"] as const;

/** C55 is rendered only for the site the helper names. */
export function SiteNormCards({ header }: { header: SiteNormHeader | Record<string, unknown> }) {
  const daily = header.daily as SiteNormHeader["daily"];
  const typo = header.typo118 as SiteNormHeader["typo118"];
  if (!daily) return null;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {SITE_CARDS.map((siteCode) => (
        <div key={siteCode} className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4 text-sm">
          <h2 className="font-medium">Шифр {siteCode}</h2>
          {siteCode === "0-68" ? (
            <>
              <p className="mt-2">
                ОРЧ по хронометражу: {showNum(daily.orchMountedPerDay_fromTimeStudy)} шт/сутки.
                Нарощено опор: {showNum(daily.supportsExtendedPerDay_fromTimeStudy)} шт/сутки.
                Наращивание ригеля (C38): {showNum(daily.extendingOneRigelHoursPerZveno)} ч.
              </p>
              {siteShowsC55Warning(siteCode) ? (
                <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2" data-testid="client-norm-c55">
                  Хронометраж {siteCode}, ячейка {typo?.cell}: в ячейке {typo?.valueInCell}.
                  Подпись говорит «час», формула суммирует минуты. Если разделить на 60, было бы около {showNum(typo?.valueIfDividedBy60Hours)} ч — исходное значение {typo?.valueInCell} не заменено.
                  К шифру 88-127 эта ячейка не относится.
                </p>
              ) : null}
              <p className="mt-2">{daily.pipeline?.note}</p>
              <p className="mt-2">
                Резолюция: факт {showNum(daily.project_0_68_resolution?.currentOutputOrchPerDay)} шт/сутки,
                план {showNum(daily.project_0_68_resolution?.planOrchPerDay)},
                февраль {showNum(daily.project_0_68_resolution?.februaryPlanOrch)}. {daily.project_0_68_resolution?.shiftsMentioned}
              </p>
            </>
          ) : (
            <>
              <p className="mt-2">
                ОРЧ: факт {showNum(daily.project_88_127_resolution?.currentOutputOrchPerDay)} шт/сутки,
                план {showNum(daily.project_88_127_resolution?.planOrchPerDay)},
                февраль {showNum(daily.project_88_127_resolution?.februaryPlanOrch)}.
                Бурение — в строках плана, не в общем ценнике.
              </p>
              <p className="mt-2">День и ночь в резолюциях не перезаписывают профиль «2×11 без выходных».</p>
              {siteShowsC55Warning(siteCode) ? (
                <p data-testid="client-norm-c55">Опечатка C55</p>
              ) : null}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
