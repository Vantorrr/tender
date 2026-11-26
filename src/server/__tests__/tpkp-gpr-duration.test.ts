import { beforeEach, describe, expect, it } from "vitest";
import { closeDb, ensureReady, mutateAppData, readAppData } from "@/server/db";
import { makeOfficialCalculationAndSchedule } from "@/server/repo";
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
});
