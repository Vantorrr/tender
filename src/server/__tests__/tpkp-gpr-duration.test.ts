import { beforeEach, describe, expect, it } from "vitest";
import { closeDb, ensureReady, mutateAppData, readAppData } from "@/server/db";
import {
  createManualProcurement,
  createProcurementSchedule,
  makeOfficialCalculationAndSchedule,
  sendProcurementToCalculation,
  updateCalculation,
} from "@/server/repo";
import "./setup";

const DRILLING_HOURS = 2648.0544;

describe("p-tpkp GPR duration from estimate hours", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("gives Messoyakha drilling, ORCH demolition and piles a real 2×11 duration and rewrites zero dates", () => {
    makeOfficialCalculationAndSchedule("u-ruk", "p-tpkp");
    const schedule = readAppData().schedules.find((item) => item.procurementId === "p-tpkp");
    expect(schedule).toBeTruthy();
    const stages = schedule!.stages;
    expect(stages).toHaveLength(36);
    expect(schedule!.calendar).toMatchObject({
      weekendDays: [],
      hoursPerShift: 11,
      shiftsPerDay: 2,
    });

    const withDuration = stages.filter((stage) => (stage.durationDays ?? 0) > 0);
    expect(withDuration).toHaveLength(33);

    const drilling = stages.filter((stage) => /бурение скважин/iu.test(`${stage.sectionName ?? ""} ${stage.name}`));
    expect(drilling.length).toBeGreaterThanOrEqual(4);
    expect(drilling.every((stage) => (stage.durationDays ?? 0) >= 1 && stage.start < stage.end)).toBe(true);
    const firstBore = drilling.find((stage) => /450 мм/.test(stage.name) && /п-12р/iu.test(stage.sectionName ?? ""));
    expect(firstBore?.durationDays).toBeCloseTo(DRILLING_HOURS / (11 * 2), 4);
    expect(firstBore?.benchmarkSource).toMatch(/Нормативные часы сметы/);
    expect(firstBore?.durationShifts).toBe(2);

    const demolition = stages.filter((stage) => /демонтаж опорно-ригельной/iu.test(stage.sectionName ?? ""));
    expect(demolition.length).toBeGreaterThan(0);
    expect(demolition.every((stage) => (stage.durationDays ?? 0) >= 1)).toBe(true);
    expect(demolition.some((stage) => stage.start < stage.end)).toBe(true);

    const piles = stages.filter((stage) => /установка свай|оголовков свай/iu.test(stage.sectionName ?? ""));
    expect(piles.length).toBeGreaterThan(0);
    expect(piles.every((stage) => (stage.durationDays ?? 0) >= 1)).toBe(true);
    expect(new Set(piles.map((stage) => stage.start)).size).toBeGreaterThan(1);

    const starts = new Set(withDuration.map((stage) => `${stage.start}..${stage.end}`));
    expect(starts.size).toBeGreaterThan(1);
    const today = new Date().toISOString().slice(0, 10);
    expect(withDuration.every((stage) => stage.start === today && stage.end === today)).toBe(false);

    const withoutNorm = stages.filter((stage) => stage.durationBasis === "unconfirmed");
    expect(withoutNorm.length).toBeGreaterThan(0);
    expect(withoutNorm.every((stage) => !((stage.durationDays ?? 0) > 0))).toBe(true);

    mutateAppData((data) => {
      const stored = data.schedules.find((item) => item.procurementId === "p-tpkp")!;
      stored.stages = stored.stages.map((stage) => ({
        ...stage,
        durationDays: 0,
        durationBasis: "unconfirmed",
        start: today,
        end: today,
      }));
      return data;
    });
    makeOfficialCalculationAndSchedule("u-ruk", "p-tpkp");
    const rebuilt = readAppData().schedules.find((item) => item.procurementId === "p-tpkp")!;
    const restored = rebuilt.stages.filter((stage) => (stage.durationDays ?? 0) > 0);
    expect(rebuilt.stages).toHaveLength(36);
    expect(restored.length).toBe(withDuration.length);
    expect(rebuilt.stages.some((stage) => /бурение скважин/iu.test(stage.name) && stage.start < stage.end)).toBe(true);
    expect(rebuilt.calendar).toMatchObject({ weekendDays: [], hoursPerShift: 11, shiftsPerDay: 2 });
  });

  it("keeps a one-day schedule and the real hour total when the button runs again", () => {
    const created = createManualProcurement("u-ruk", { title: "Один день", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    updateCalculation("u-ruk", draft.id, {
      positions: [
        { id: "w", code: "ФЕР-1", name: "Резка", unit: "рез", quantity: 1, rate: 0, isWorkItem: true, sourceSectionName: "Раздел 1", sourceWorkName: "Резка" },
        { id: "crew", code: "БР", name: "Бригада", unit: "чел", quantity: 12, rate: 0, resourceKind: "labor", sourceSectionName: "Раздел 1", sourceWorkName: "Резка" },
        { id: "h", code: "ЗТ", name: "Затраты труда рабочих", unit: "чел.-ч", quantity: 3.5, rate: 0, resourceKind: "labor", sourceSectionName: "Раздел 1", sourceWorkName: "Резка" },
      ],
    });
    createProcurementSchedule("u-ruk", created.id);
    const schedule = readAppData().schedules.find((item) => item.procurementId === created.id)!;
    expect(schedule.stages).toHaveLength(1);
    expect(schedule.stages[0]).toMatchObject({ durationDays: 1 });
    expect(schedule.stages[0]?.formulaVolume).toBeCloseTo(3.5, 5);
    expect(schedule.stages[0]?.start).toBe(schedule.stages[0]?.end);
    mutateAppData((data) => {
      const stored = data.schedules.find((item) => item.id === schedule.id)!;
      stored.stages[0] = { ...stored.stages[0]!, crewSize: 9 };
      return data;
    });
    createProcurementSchedule("u-ruk", created.id, { replaceUntagged: true });
    const kept = readAppData().schedules.find((item) => item.id === schedule.id)!;
    expect(kept.stages[0]?.crewSize).toBe(9);
    expect(kept.stages[0]?.formulaVolume).toBeCloseTo(3.5, 5);
    expect(kept.stages[0]?.durationDays).toBe(1);
  });
});
