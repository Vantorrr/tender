/**
 * Resource + supply availability checks against GPR calendar (UX warnings, not a solver).
 */
import type { GprStage, SupplyRequest, WorkCalendar } from "@/lib/types";
import { stageDayList } from "@/lib/plan-from-gpr";

export type CalendarWarning = {
  kind: "resource_overlap" | "supply_late" | "supply_unscheduled" | "crew_peak";
  severity: "info" | "warn";
  message: string;
  stageIds?: string[];
  supplyId?: string;
};

/** Same calendar day: sum crew across stages; warn if peak exceeds capacity. */
export function crewPeakWarnings(
  stages: GprStage[],
  capacityPerDay = 40,
  calendar?: Pick<WorkCalendar, "weekendDays">
): CalendarWarning[] {
  const byDay = new Map<string, { crew: number; stages: string[] }>();
  for (const st of stages) {
    const crew = st.crewSize ?? 0;
    if (crew <= 0) continue;
    for (const d of stageDayList(st, calendar)) {
      const cur = byDay.get(d) ?? { crew: 0, stages: [] };
      cur.crew += crew;
      cur.stages.push(st.id);
      byDay.set(d, cur);
    }
  }
  const out: CalendarWarning[] = [];
  for (const [d, v] of byDay) {
    if (v.crew > capacityPerDay) {
      out.push({
        kind: "crew_peak",
        severity: "warn",
        message: `${d}: суммарная численность ${v.crew} чел. > доступности ${capacityPerDay}`,
        stageIds: [...new Set(v.stages)],
      });
    }
  }
  return out.slice(0, 12);
}

/** Material/equipment resource names overlapping many stages without rates. */
export function resourceOverlapWarnings(
  stages: GprStage[],
  calendar?: Pick<WorkCalendar, "weekendDays">
): CalendarWarning[] {
  const byDayKind = new Map<string, { qty: number; names: string[] }>();
  for (const st of stages) {
    for (const r of st.resources ?? []) {
      if (r.kind !== "equipment" && r.kind !== "bus") continue;
      for (const d of stageDayList(st, calendar)) {
        const key = `${d}|${r.kind}|${r.name}`;
        const cur = byDayKind.get(key) ?? { qty: 0, names: [] };
        cur.qty += r.quantity;
        cur.names.push(st.name);
        byDayKind.set(key, cur);
      }
    }
  }
  const out: CalendarWarning[] = [];
  for (const [key, v] of byDayKind) {
    if (v.qty <= 1) continue;
    const [d, kind] = key.split("|");
    out.push({
      kind: "resource_overlap",
      severity: "info",
      message: `${d}: ${kind} «${key.split("|")[2]}» занят на ${v.qty} ед. (${v.names.join(", ")})`,
    });
  }
  return out.slice(0, 12);
}

/** Supply needBy vs earliest related stage / overall GPR window. */
export function supplyCalendarWarnings(
  stages: GprStage[],
  supplies: SupplyRequest[]
): CalendarWarning[] {
  if (stages.length === 0) return [];
  const minStart = stages.reduce(
    (m, s) => (s.start < m ? s.start : m),
    stages[0].start
  );
  const maxEnd = stages.reduce(
    (m, s) => (s.end > m ? s.end : m),
    stages[0].end
  );
  const out: CalendarWarning[] = [];
  for (const s of supplies) {
    if (!s.needBy) {
      out.push({
        kind: "supply_unscheduled",
        severity: "info",
        message: `Поставка «${s.materialName}»: нет даты needBy`,
        supplyId: s.id,
      });
      continue;
    }
    if (s.needBy > maxEnd) {
      out.push({
        kind: "supply_late",
        severity: "warn",
        message: `Поставка «${s.materialName}» needBy ${s.needBy} позже окончания ГПР ${maxEnd}`,
        supplyId: s.id,
      });
    } else if (s.needBy < minStart) {
      out.push({
        kind: "supply_late",
        severity: "info",
        message: `Поставка «${s.materialName}» needBy ${s.needBy} до старта ГПР ${minStart}`,
        supplyId: s.id,
      });
    }
  }
  return out.slice(0, 20);
}

export function collectCalendarWarnings(
  stages: GprStage[],
  supplies: SupplyRequest[],
  capacityPerDay = 40,
  calendar?: Pick<WorkCalendar, "weekendDays">
): CalendarWarning[] {
  return [
    ...crewPeakWarnings(stages, capacityPerDay, calendar),
    ...resourceOverlapWarnings(stages, calendar),
    ...supplyCalendarWarnings(stages, supplies),
  ];
}
