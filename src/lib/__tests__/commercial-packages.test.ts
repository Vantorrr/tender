import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GPR_DURATION_FROM_OUTPUT,
  MAX_SCHEDULE_DAYS,
  applyLeverToStored,
  deadlineView,
  durationDaysFromOutput,
  endAfterWorkingDays,
  formulaAfterVolumeChange,
  gesnHoursHint,
  matchSiteWorkKind,
  placeByDuration,
  planCommercialStage,
  shiftsForDeadline,
  stageTracksVolumeRow,
  volumeStatusLabel,
  type ShiftOutputCandidate,
} from "@/lib/commercial-packages";
import { buildStagesFromEstimatePositions } from "@/lib/estimate-stages";
import type { CalcPosition } from "@/lib/types";

const excavator: ShiftOutputCandidate = {
  catalog: "output",
  workName: "Разработка грунта экскаватором в отвал",
  unit: "1000 м3",
  outputPerShift11h: 10,
  mechanism: "Экскаватор Komatsu 220",
  soilName: "Песок",
  material: null,
  size: null,
  source: "Нормы выработки земля/дороги, смена 11 ч, Экскаватор Komatsu 220",
};

describe("commercial package duration", () => {
  it("divides volume by an 11-hour shift, two shifts and the mechanisms, and does not slice the TZ", () => {
    expect(durationDaysFromOutput({ volume: 200, outputPerShift11h: 10, shiftsPerDay: 2, mechanisms: 1 })).toBe(10);
    expect(durationDaysFromOutput({ volume: 200, outputPerShift11h: 10, shiftsPerDay: 1, mechanisms: 1 })).toBe(20);
    expect(endAfterWorkingDays("2026-12-01", 10, [])).toBe("2026-12-10");
    const positions: CalcPosition[] = [
      {
        id: "work",
        code: "ФЕР-1",
        name: "Разработка грунта экскаватором в отвал, Экскаватор Komatsu 220",
        unit: "1000 м3",
        quantity: 200,
        rate: 0,
        isWorkItem: true,
        sourceSectionName: "Земляные работы",
        sourceWorkName: "Разработка грунта экскаватором в отвал, Экскаватор Komatsu 220",
      },
      {
        id: "gesn",
        code: "ГЭСН 01-01-001",
        name: "Машинист",
        unit: "маш.-ч",
        quantity: 88,
        rate: 0,
        rateMissing: true,
        resourceKind: "equipment",
        sourceSectionName: "Земляные работы",
        sourceWorkName: "Разработка грунта экскаватором в отвал, Экскаватор Komatsu 220",
      },
      {
        id: "other",
        code: "ФЕР-2",
        name: "Штукатурка стен",
        unit: "м2",
        quantity: 50,
        rate: 0,
        isWorkItem: true,
        sourceSectionName: "Отделка",
        sourceWorkName: "Штукатурка стен",
      },
    ];
    const deadline = { start: "2026-12-01", end: "2026-12-30" };
    const stages = buildStagesFromEstimatePositions(positions, "2026-12-01T00:00:00.000Z", deadline, {
      weekendDays: [],
      shiftsPerDay: 2,
      lookups: [excavator],
    });
    const earth = stages.find((stage) => stage.name.includes("отвал"))!;
    const plaster = stages.find((stage) => stage.name.includes("Штукатурка"))!;
    expect(earth.durationBasis).toBe("output_shift");
    expect(earth.durationDays).toBe(10);
    expect(earth.durationShifts).toBe(2);
    expect(earth.start).toBe("2026-12-01");
    expect(earth.end).toBe("2026-12-10");
    expect(earth.gesnHoursHint).toBe(88);
    expect(earth.end).not.toBe("2026-12-15");
    expect(inclusive(earth.start, earth.end)).not.toBe(88);
    expect(inclusive(earth.start, earth.end)).not.toBe(Math.round(88 / 11));
    expect(plaster.durationBasis).toBe("unconfirmed");
    expect(plaster.durationDays).toBeUndefined();
    expect(plaster.start).toBe(plaster.end);
    expect(plaster.end).not.toBe(deadline.end);
    expect(GPR_DURATION_FROM_OUTPUT).toMatch(/не делится поровну/);
    const view = deadlineView({ stages, deadline, shiftsPerDay: 2 });
    expect(view.incomplete).toBe(true);
    expect(view.pathDays).toBe(10);
    expect(view.overrunDays).toBe(0);
  });

  it("staffs ОРЧ, pipe and drilling from file 4 and names the source", () => {
    const file = JSON.parse(fs.readFileSync(path.join(process.cwd(), "fixtures/client-norms/04-foto-rabochego-dnya-i-potrebnost-uchastkov.json"), "utf8")) as {
      dailyNormsAndCrewBenchmarks: {
        orchMountedPerDay_fromTimeStudy: number;
        pipeline: { fourWeldersMetersPerDay: number; note: string };
      };
    };
    expect(file.dailyNormsAndCrewBenchmarks.orchMountedPerDay_fromTimeStudy).toBe(4);
    expect(file.dailyNormsAndCrewBenchmarks.pipeline.fourWeldersMetersPerDay).toBe(120);
    expect(matchSiteWorkKind("Монтаж трубы")).toBe("pipe");
    expect(matchSiteWorkKind("Бурение скважин")).toBe("drilling");
    expect(matchSiteWorkKind("Монтаж ОРЧ")).toBe("orch");
    expect(matchSiteWorkKind("Штукатурка стен")).toBeNull();

    const pipe = planCommercialStage({
      workName: "Монтаж трубы",
      unit: "м",
      volume: 240,
      shiftsPerDay: 2,
      lookups: [],
      gesnHoursHint: null,
    });
    expect(pipe.durationBasis).toBe("site_daily");
    expect(pipe.durationDays).toBe(2);
    expect(pipe.benchmarkSource).toContain("120 м");
    expect(pipe.benchmarkSource).toContain("0-68");
    expect(pipe.benchmarkCrew.find((line) => line.role.startsWith("Сварщики"))).toMatchObject({ count: 4, kind: "labor" });
    expect(pipe.benchmarkCrew.find((line) => line.role === "Трубоукладчик")).toMatchObject({ count: 1, kind: "equipment" });
    expect(pipe.note).toMatch(/не умножается/i);

    const drilling = planCommercialStage({
      workName: "Бурение скважин",
      unit: "шт",
      volume: 100,
      shiftsPerDay: 2,
      lookups: [],
      gesnHoursHint: 40,
    });
    expect(drilling.durationBasis).toBe("unconfirmed");
    expect(drilling.durationDays).toBeNull();
    expect(drilling.benchmarkSource).toContain("88-127");
    expect(drilling.benchmarkCrew.some((line) => line.role === "Экскаватор")).toBe(true);
    expect(drilling.gesnHoursHint).toBe(40);

    const orch = planCommercialStage({
      workName: "Монтаж ОРЧ",
      unit: "шт",
      volume: 8,
      shiftsPerDay: 2,
      lookups: [],
      gesnHoursHint: null,
    });
    expect(orch.durationDays).toBe(2);
    expect(orch.benchmarkSource).toContain("4 смонтированных ОРЧ");
    expect(orch.benchmarkCrew.find((line) => line.role.startsWith("Монтажники"))?.count).toBe(12);
  });

  it("offers another shift only below two and another mechanism when the path overruns the TZ", () => {
    const stage = {
      start: "2026-12-01",
      end: "2026-12-10",
      durationBasis: "output_shift" as const,
      durationDays: 10,
      formulaVolume: 100,
      outputPerShift11h: 10,
      statedLinks: 1,
      statedShifts: 1,
      mechanismCount: 1,
      durationShifts: 1,
      gesnHoursHint: 88,
    };
    const overrun = deadlineView({
      stages: [stage],
      deadline: { start: "2026-12-01", end: "2026-12-05" },
      shiftsPerDay: 1,
    });
    expect(overrun.overrunDays).toBe(5);
    expect(overrun.shiftAvailable).toBe(true);
    expect(overrun.mechanismAvailable).toBe(true);
    expect(overrun.message).toMatch(/Превышение 5/);
    const shifted = applyLeverToStored(stage, "shift");
    expect(shifted.durationShifts).toBe(2);
    expect(shifted.durationDays).toBe(5);
    expect(shifted.gesnHoursHint).toBe(88);
    const placed = placeByDuration("2026-12-01", [], [shifted.durationDays ?? null]);
    expect(placed[0]).toEqual({ start: "2026-12-01", end: "2026-12-05" });
    const fitted = deadlineView({
      stages: [{ ...stage, ...shifted, ...placed[0] }],
      deadline: { start: "2026-12-01", end: "2026-12-05" },
      shiftsPerDay: 2,
    });
    expect(fitted.overrunDays).toBe(0);
    expect(fitted.shiftAvailable).toBe(false);
    const withMachine = applyLeverToStored({ ...stage, durationShifts: 2, durationDays: 5 }, "mechanism");
    expect(withMachine.mechanismCount).toBe(2);
    expect(withMachine.durationDays).toBe(2.5);
  });

  it("rejects a stage measured in millions of days without walking them", () => {
    expect(endAfterWorkingDays("2026-12-01", 10, [])).toBe("2026-12-10");
    expect(endAfterWorkingDays("2026-12-01", 10, [0, 6])).toBe("2026-12-14");
    expect(endAfterWorkingDays("2026-12-01", MAX_SCHEDULE_DAYS, []).startsWith("20")).toBe(true);
    expect(() => endAfterWorkingDays("2026-12-01", MAX_SCHEDULE_DAYS + 1, [])).toThrow(/слишком большой/);
    expect(() => endAfterWorkingDays("2026-12-01", 1e15, [])).toThrow(/слишком большой/);
    expect(() => endAfterWorkingDays("2026-12-01", 2, [0, 1, 2, 3, 4, 5, 6])).toThrow(/рабочих дней/);
  });

  it("does not offer another shift when the stages already use two", () => {
    const stage = {
      start: "2026-12-01",
      end: "2026-12-10",
      durationBasis: "output_shift" as const,
      durationDays: 10,
      durationShifts: 2,
    };
    expect(shiftsForDeadline([stage], undefined)).toBe(2);
    expect(shiftsForDeadline([stage], 1)).toBe(2);
    expect(shiftsForDeadline([], undefined)).toBe(2);
    expect(shiftsForDeadline([], 1)).toBe(1);
    const view = deadlineView({
      stages: [stage],
      deadline: { start: "2026-12-01", end: "2026-12-05" },
      shiftsPerDay: 1,
    });
    expect(view.overrunDays).toBe(5);
    expect(view.shiftAvailable).toBe(false);
    expect(view.mechanismAvailable).toBe(true);
  });

  it("keeps a VOR edit inside its section and restores duration after zero", () => {
    const norm = {
      durationBasis: "output_shift" as const,
      outputPerShift11h: 1,
      statedLinks: 1,
      statedShifts: 1,
      mechanismCount: 1,
      durationShifts: 2,
      formulaVolume: 10,
      planVolume: 10,
      formulaPerPhysical: 1,
    };
    expect(stageTracksVolumeRow(
      { name: "Земля", workName: "Земля", sectionName: "Раздел 2", volumeRowIds: ["vor-b"], volumeSource: "vor" },
      { id: "vor-a", name: "Земля", sourceSectionName: "Раздел 1" },
    )).toBe(false);
    expect(stageTracksVolumeRow(
      { name: "Земля", workName: "Земля", sectionName: "Раздел 1", volumeSource: "estimate" },
      { id: "vor-a", name: "Земля", sourceSectionName: "Раздел 1" },
    )).toBe(false);
    expect(stageTracksVolumeRow(
      { name: "Земля", workName: "Земля", sectionName: "Раздел 1", volumeRowIds: ["vor-a"], volumeSource: "vor" },
      { id: "vor-a", name: "Земля", sourceSectionName: "Раздел 1" },
    )).toBe(true);
    expect(formulaAfterVolumeChange(norm, 0)).toMatchObject({ formulaVolume: 0, durationDays: 0, formulaPerPhysical: 1, planVolume: 0 });
    expect(formulaAfterVolumeChange({ ...norm, formulaVolume: 0, planVolume: 0, formulaPerPhysical: 1 }, 20)).toMatchObject({
      formulaVolume: 20,
      durationDays: 10,
      planVolume: 20,
    });
  });

  it("turns estimate labor hours into days on a 2×11 calendar and does not slice the TZ", () => {
    const drilling = planCommercialStage({
      workName: "Бурение скважин диаметром 450 мм",
      unit: "м",
      volume: 716,
      shiftsPerDay: 2,
      hoursPerShift: 11,
      normHours: 2648.0544,
      lookups: [],
      gesnHoursHint: 40,
    });
    expect(drilling.durationBasis).toBe("output_shift");
    expect(drilling.durationDays).toBeCloseTo(2648.0544 / 22, 5);
    expect(drilling.durationDays ?? 0).toBeGreaterThanOrEqual(1);
    expect(drilling.benchmarkSource).toMatch(/Нормативные часы сметы/);
    expect(drilling.note).toMatch(/не делится/);
    expect(drilling.benchmarkCrew.some((line) => line.role === "Экскаватор")).toBe(true);

    const short = planCommercialStage({
      workName: "Заполнение раствором пустот между стенкой скважины и телом сваи",
      unit: "м3",
      volume: 1.53,
      shiftsPerDay: 2,
      hoursPerShift: 11,
      normHours: 3.519,
      lookups: [],
      gesnHoursHint: null,
    });
    expect(short.durationDays).toBe(1);
    expect(short.durationBasis).toBe("output_shift");

    const untouched = planCommercialStage({
      workName: "Бурение скважин",
      unit: "шт",
      volume: 100,
      shiftsPerDay: 2,
      lookups: [],
      gesnHoursHint: 40,
    });
    expect(untouched.durationDays).toBeNull();
    expect(untouched.durationBasis).toBe("unconfirmed");

    const catalogWins = planCommercialStage({
      workName: "Разработка грунта экскаватором в отвал, Экскаватор Komatsu 220",
      unit: "1000 м3",
      volume: 200,
      shiftsPerDay: 2,
      normHours: 88,
      lookups: [excavator],
      gesnHoursHint: 88,
    });
    expect(catalogWins.durationDays).toBe(10);
    expect(catalogWins.benchmarkSource).not.toMatch(/Нормативные часы/);

    const pipe = planCommercialStage({
      workName: "Монтаж трубы",
      unit: "м",
      volume: 240,
      shiftsPerDay: 2,
      normHours: 999,
      lookups: [],
      gesnHoursHint: null,
    });
    expect(pipe.durationDays).toBe(2);
    expect(pipe.durationBasis).toBe("site_daily");

    const deadline = { start: "2026-12-01", end: "2026-12-30" };
    const stages = buildStagesFromEstimatePositions([
      {
        id: "drill",
        code: "ФЕР05-01-055-05",
        name: "Бурение скважин диаметром 450 мм",
        unit: "м",
        quantity: 716,
        rate: 0,
        isWorkItem: true,
        sourceSectionName: "Раздел 1. Бурение скважин",
        sourceWorkName: "Бурение скважин диаметром 450 мм",
      },
      {
        id: "idle",
        code: "ФЕР-9",
        name: "Погрузка",
        unit: "т",
        quantity: 1,
        rate: 0,
        isWorkItem: true,
        sourceSectionName: "Раздел 9. Погрузка без нормы",
        sourceWorkName: "Погрузка",
      },
    ], "2026-11-26T00:00:00.000Z", deadline, {
      weekendDays: [],
      shiftsPerDay: 2,
      hoursPerShift: 11,
      lookups: [],
      normHours: [{
        sectionName: "Раздел 1. Бурение скважин",
        workName: "Бурение скважин диаметром 450 мм",
        laborHours: 2648.0544,
        machineHours: 0,
      }],
    });
    const bore = stages.find((stage) => stage.name.includes("Бурение"))!;
    const idle = stages.find((stage) => stage.name === "Погрузка")!;
    expect(bore.durationDays).toBeCloseTo(2648.0544 / 22, 5);
    expect(bore.start).toBe("2026-12-01");
    expect(bore.end > bore.start).toBe(true);
    expect(bore.end).not.toBe(deadline.end);
    expect(idle.durationBasis).toBe("unconfirmed");
    expect(idle.durationDays).toBeUndefined();
    expect(idle.start).toBe(idle.end);
    expect(idle.end).not.toBe(deadline.end);
  });

  it("keeps a volume row unconfirmed until someone confirms it", () => {
    expect(volumeStatusLabel(undefined)).toBe("не подтверждено");
    expect(volumeStatusLabel("unconfirmed")).toBe("не подтверждено");
    expect(volumeStatusLabel("confirmed")).toBe("подтверждено");
    expect(gesnHoursHint([{ quantity: 88, unit: "чел.-ч", quantityBasis: "total_hours" }])).toBe(88);
    expect(gesnHoursHint([{ quantity: 10, unit: "м3", quantityBasis: "material_qty" }])).toBeNull();
  });
});

function inclusive(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
}
