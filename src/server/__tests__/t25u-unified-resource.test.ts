import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";
import { calculationTotals, roundMoney } from "@/lib/calc-math";
import { buildHierarchicalEstimate } from "@/lib/hierarchical-estimate";
import {
  inferQuantityBasis,
  resolveResourceDimensions,
} from "@/lib/resource-dimensions";
import {
  EXCEL_RESOURCE_SCHEDULE_DEFAULTS,
  machineHourFullTariffCost,
  rollupResourceSchedule,
} from "@/lib/resource-schedule-model";
import { T25U_TEST, isT25uTestFixtureOptIn } from "@/lib/t25u-test-fixture";
import {
  isResourceLinkedDraft,
  stagesToResourceLines,
  syncDraftFromStages,
} from "@/lib/unified-resource-sync";
import type { GprStage } from "@/lib/types";
import { closeDb, ensureReady, readAppData } from "@/server/db";
import {
  buildCalculationPdf,
  buildCalculationXlsx,
  buildGprXlsx,
} from "@/server/export";
import {
  patchScheduleResourceAndSync,
  recomputeCalculationCost,
  updateSchedule,
} from "@/server/repo";
import "./setup";

async function loadXlsx(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(buf as any);
  return wb;
}

function pdfExtractText(buf: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t25u-pdf-"));
  const pdfPath = path.join(dir, "out.pdf");
  fs.writeFileSync(pdfPath, buf);
  try {
    return execFileSync("pdftotext", ["-layout", pdfPath, "-"], {
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Hand-computed COMPLETE fixture: one labor + one bus, no missing rates. */
function completeFixtureStages(): GprStage[] {
  return [
    {
      id: "cf-1",
      name: "Complete pack",
      start: "2026-01-01",
      end: "2026-01-03",
      sequence: 1,
      resources: [
        {
          id: "cf-lab",
          kind: "labor",
          name: "Crew",
          quantity: 2,
          unit: "чел",
          rate: 1400,
          quantityBasis: "count_per_shift",
          hoursPerShift: 11,
          shiftsPerDay: 1,
          days: 3,
        },
        {
          id: "cf-bus",
          kind: "bus",
          name: "Bus",
          quantity: 2,
          unit: "ед",
          rate: 2650,
          quantityBasis: "count_per_shift",
          hoursPerShift: 11,
          shiftsPerDay: 1,
          days: 3,
        },
        {
          id: "cf-mat",
          kind: "material",
          name: "Sand",
          quantity: 10,
          unit: "т",
          rate: 500,
          quantityBasis: "material_qty",
        },
      ],
    },
  ];
}

describe("t25u shared dimensions (P1 #1)", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("total_hours for чел.-ч / маш.-ч without explicit basis (dot units)", () => {
    expect(
      inferQuantityBasis({
        kind: "labor",
        unit: "чел.-ч",
      })
    ).toBe("total_hours");
    expect(
      inferQuantityBasis({
        kind: "equipment",
        unit: "маш.-ч",
      })
    ).toBe("total_hours");
    expect(
      inferQuantityBasis({
        kind: "labor",
        unit: "чел · ч",
      })
    ).toBe("total_hours");
    expect(
      inferQuantityBasis({
        kind: "labor",
        unit: "н-ч",
      })
    ).toBe("total_hours");

    const st = {
      id: "s",
      start: "2026-01-01",
      end: "2026-01-10",
      hoursPerShift: 11,
      shiftsPerDay: 2,
    };
    const r = {
      id: "th",
      kind: "labor" as const,
      name: "Hours already",
      quantity: 66,
      unit: "чел.-ч",
      rate: 1400,
    };
    const dim = resolveResourceDimensions(r, st, EXCEL_RESOURCE_SCHEDULE_DEFAULTS);
    expect(dim.basis).toBe("total_hours");
    expect(dim.hours).toBe(66);
    // Must NOT re-multiply by stage days/shifts
    expect(dim.amount).toBe(roundMoney(66 * 1400));
  });

  it("explicit quantityBasis wins over unit inference", () => {
    const dim = resolveResourceDimensions(
      {
        id: "x",
        kind: "labor",
        name: "Forced",
        quantity: 2,
        unit: "чел.-ч", // looks like hours…
        rate: 100,
        quantityBasis: "count_per_shift", // …but explicit count wins
        hoursPerShift: 11,
        shiftsPerDay: 1,
        days: 3,
      },
      { id: "s", start: "2026-01-01", end: "2026-01-03" },
      EXCEL_RESOURCE_SCHEDULE_DEFAULTS
    );
    expect(dim.basis).toBe("count_per_shift");
    expect(dim.hours).toBe(66);
    expect(dim.amount).toBe(6600);
  });

  it("golden bus tree amount === resource model 174900", () => {
    const mh = machineHourFullTariffCost({
      quantity: 2,
      ratePerMachineHour: 2650,
      hoursPerShift: 11,
      shiftsPerDay: 1,
      days: 3,
    });
    expect(mh.amount).toBe(174900);

    const g = readAppData().schedules.find((s) => s.id === T25U_TEST.scheduleId)!;
    const bus = g.stages
      .flatMap((s) => (s.resources ?? []).map((r) => ({ s, r })))
      .find((x) => x.r.id === "rst-2-bus")!;
    const dim = resolveResourceDimensions(
      bus.r,
      bus.s,
      EXCEL_RESOURCE_SCHEDULE_DEFAULTS
    );
    expect(dim.hours).toBe(66);
    expect(dim.amount).toBe(174900);

    const nodes = buildHierarchicalEstimate({ stages: g.stages });
    const leaf = nodes
      .flatMap((n) => n.groups.flatMap((gr) => gr.leaves))
      .find((l) => l.id === "rst-2-bus")!;
    expect(leaf.hoursQ).toBe(66);
    expect(leaf.amount).toBe(174900);
    expect(leaf.quantity).toBe(2); // source L
  });

  it("GPR Resources sheet R for golden bus = 174900", async () => {
    recomputeCalculationCost("u-smet", T25U_TEST.calculationId, {
      useResourceScheduleEconomics: true,
    });
    const buf = await buildGprXlsx(T25U_TEST.scheduleId);
    const wb = await loadXlsx(buf);
    const ws = wb.getWorksheet("Ресурсы")!;
    let busR: number | null = null;
    ws.eachRow((row) => {
      if (String(row.getCell(3).value) === "Автобус доставки") {
        busR = Number(row.getCell(12).value);
      }
    });
    expect(busR).toBe(174900);
  });

  it("materials never enter Q-hours", () => {
    const stages = completeFixtureStages();
    const build = stagesToResourceLines(stages);
    const mat = build.lines.find((l) => l.id === "cf-mat")!;
    expect(mat.category).toBe("material");
    // knownHours = labor 66 + bus 66 = 132 (not +10)
    expect(build.knownHours).toBe(132);
    expect(build.materialsTotal).toBe(5000);
  });

  it("hand-computed COMPLETE V/W/X/Y/Z", () => {
    const stages = completeFixtureStages();
    const build = stagesToResourceLines(stages);
    // Labor Q=2*11*1*3=66 R=66*1400=92400
    // Bus Q=66 R=174900
    // Mat S=5000
    // V=92400+174900+5000=272300
    expect(build.knownDirect).toBe(272300);
    const rollup = rollupResourceSchedule({
      params: EXCEL_RESOURCE_SCHEDULE_DEFAULTS,
      lines: build.lines,
      materialsTotal: build.materialsTotal,
    });
    const V = 272300;
    const W = roundMoney(V * 0.43);
    const X = roundMoney(V + W);
    const Y = roundMoney(X * 0.4);
    const Z = roundMoney(X + Y);
    expect(rollup.direct).toBe(V);
    expect(rollup.overhead).toBe(W);
    expect(rollup.costWithOh).toBe(X);
    expect(rollup.profit).toBe(Y);
    expect(rollup.total).toBe(Z);
    expect(rollup.incomplete.filter((i) => i !== "materials_external_or_missing")).toEqual(
      []
    );
  });

  it("PARTIAL fixture marks incomplete amounts", () => {
    const stages: GprStage[] = [
      {
        id: "p1",
        name: "Partial",
        start: "2026-01-01",
        end: "2026-01-02",
        sequence: 1,
        resources: [
          {
            id: "ok",
            kind: "labor",
            name: "OK",
            quantity: 1,
            unit: "чел",
            rate: 1000,
            quantityBasis: "count_per_shift",
            hoursPerShift: 10,
            shiftsPerDay: 1,
            days: 1,
          },
          {
            id: "miss",
            kind: "equipment",
            name: "No rate",
            quantity: 1,
            unit: "маш",
            rate: null,
            quantityBasis: "count_per_shift",
            hoursPerShift: 10,
            shiftsPerDay: 1,
            days: 1,
          },
        ],
      },
    ];
    const build = stagesToResourceLines(stages);
    expect(build.incomplete.some((x) => x.includes("miss"))).toBe(true);
    expect(build.knownDirect).toBe(10000);
  });
});

describe("t25u export PARTIAL + numerics (P1 #3 + evidence)", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("calc-pdf asserts numeric V/W/X/Y/Z values", async () => {
    recomputeCalculationCost("u-smet", T25U_TEST.calculationId, {
      useResourceScheduleEconomics: true,
    });
    const slices = readAppData().calculations.find(
      (c) => c.id === T25U_TEST.calculationId
    )!.costSummary!.resourceSlices!;
    const pdf = await buildCalculationPdf(T25U_TEST.calculationId);
    const text = pdfExtractText(pdf);
    expect(text).toMatch(new RegExp(`V direct:\\s*${Math.round(slices.direct)}`));
    expect(text).toMatch(new RegExp(`W OH43%:\\s*${Math.round(slices.overhead)}`));
    expect(text).toMatch(
      new RegExp(`X cost\\+OH:\\s*${Math.round(slices.costWithOh)}`)
    );
    expect(text).toMatch(
      new RegExp(`Y markup40%:\\s*${Math.round(slices.profit)}`)
    );
    expect(text).toMatch(new RegExp(`Z TOTAL:\\s*${Math.round(slices.total)}`));
    expect(text).toMatch(/PARTIAL/);
  });

  it("GPR export marks PARTIAL on Итого Z and Цена без НДС rows", async () => {
    recomputeCalculationCost("u-smet", T25U_TEST.calculationId, {
      useResourceScheduleEconomics: true,
    });
    const buf = await buildGprXlsx(T25U_TEST.scheduleId);
    const wb = await loadXlsx(buf);
    const sum = wb.getWorksheet("Сводка")!;
    const rs = wb.getWorksheet("Ресурсный_параметры")!;
    const res = wb.getWorksheet("Ресурсы")!;
    const sumLabels: string[] = [];
    sum.eachRow((row) => sumLabels.push(String(row.getCell(1).value ?? "")));
    expect(sumLabels.some((l) => /Цена без НДС.*PARTIAL/i.test(l))).toBe(true);
    const rsLabels: string[] = [];
    rs.eachRow((row) => rsLabels.push(String(row.getCell(1).value ?? "")));
    expect(rsLabels.some((l) => /Итого Z.*PARTIAL/i.test(l))).toBe(true);
    expect(rsLabels.some((l) => /НР W.*PARTIAL/i.test(l))).toBe(true);
    let totalStatus = "";
    res.eachRow((row) => {
      const a = String(row.getCell(1).value ?? "");
      if (/Итого подтверждённых/i.test(a)) {
        totalStatus = String(row.getCell(13).value ?? "");
        expect(a).toMatch(/PARTIAL/i);
      }
    });
    expect(totalStatus).toMatch(/PARTIAL/i);
  });

  it("genuine qty/rate mutate → close/reopen DB → export+tree share constants", async () => {
    const before = readAppData();
    const bus0 = before.schedules
      .find((s) => s.id === T25U_TEST.scheduleId)!
      .stages.flatMap((s) => s.resources ?? [])
      .find((r) => r.id === "rst-2-bus")!;
    expect(bus0.quantity).toBe(2);

    // Genuine mutation: qty 2→3, rate 2650→2700
    patchScheduleResourceAndSync("u-smet", T25U_TEST.scheduleId, {
      resourceId: "rst-2-bus",
      stageId: "gst-2",
      quantity: 3,
      rate: 2700,
    });

    const mid = readAppData();
    const bus1 = mid.schedules
      .find((s) => s.id === T25U_TEST.scheduleId)!
      .stages.flatMap((s) => s.resources ?? [])
      .find((r) => r.id === "rst-2-bus")!;
    expect(bus1.quantity).toBe(3);
    expect(bus1.rate).toBe(2700);
    const expectedQ = 3 * 11 * 1 * 3; // 99
    const expectedR = roundMoney(expectedQ * 2700);
    const zAfter = mid.calculations.find((c) => c.id === T25U_TEST.calculationId)!
      .costSummary!.resourceSlices!.total;

    // Reopen DB WITHOUT writeAppData hand-save
    closeDb();
    ensureReady();
    const after = readAppData();
    const bus2 = after.schedules
      .find((s) => s.id === T25U_TEST.scheduleId)!
      .stages.flatMap((s) => s.resources ?? [])
      .find((r) => r.id === "rst-2-bus")!;
    expect(bus2.quantity).toBe(3);
    expect(bus2.rate).toBe(2700);

    const tree = buildHierarchicalEstimate({
      stages: after.schedules.find((s) => s.id === T25U_TEST.scheduleId)!.stages,
    });
    const leaf = tree
      .flatMap((n) => n.groups.flatMap((g) => g.leaves))
      .find((l) => l.id === "rst-2-bus")!;
    expect(leaf.hoursQ).toBe(expectedQ);
    expect(leaf.amount).toBe(expectedR);

    const draft = after.calculations.find((c) => c.id === T25U_TEST.calculationId)!;
    expect(draft.costSummary!.resourceSlices!.total).toBe(zAfter);

    const xlsx = await buildCalculationXlsx(T25U_TEST.calculationId);
    const wb = await loadXlsx(xlsx);
    const ws = wb.getWorksheet("Расчёт")!;
    let zCell = 0;
    ws.eachRow((row) => {
      if (String(row.getCell(1).value) === "Z_total") {
        zCell = Number(row.getCell(6).value);
      }
    });
    expect(zCell).toBe(zAfter);

    const pdfText = pdfExtractText(
      await buildCalculationPdf(T25U_TEST.calculationId)
    );
    expect(pdfText).toMatch(
      new RegExp(`Z TOTAL:\\s*${Math.round(zAfter)}`)
    );

    const gpr = await loadXlsx(await buildGprXlsx(T25U_TEST.scheduleId));
    const res = gpr.getWorksheet("Ресурсы")!;
    let gprR: number | null = null;
    res.eachRow((row) => {
      if (String(row.getCell(3).value) === "Автобус доставки") {
        gprR = Number(row.getCell(12).value);
      }
    });
    expect(gprR).toBe(expectedR);
  });
});

describe("t25u school non-destructive + custom line", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("updateSchedule with unrelated custom line preserves dates/rates/facts/photos/custom", () => {
    const before = readAppData();
    const c1 = before.calculations.find((c) => c.id === "c-1")!;
    expect(isResourceLinkedDraft(c1)).toBe(false);
    const posBefore = structuredClone(c1.positions);
    const costBefore = structuredClone(c1.costSummary ?? null);
    const pfBefore = structuredClone(
      before.planFacts.find((p) => p.id === "pf-1")!
    );
    const g1 = before.schedules.find((s) => s.id === "g-1")!;
    const dateFingerprint = g1.stages.map((s) => ({
      id: s.id,
      start: s.start,
      end: s.end,
    }));
    const stages = structuredClone(g1.stages);
    stages[0] = {
      ...stages[0],
      resources: [
        ...(stages[0].resources ?? []),
        {
          id: "school-custom-line",
          kind: "labor",
          name: "Custom unrelated",
          quantity: 7,
          unit: "чел",
          rate: 1234,
        },
      ],
    };

    updateSchedule("u-smet", "g-1", { stages });

    const after = readAppData();
    const c1b = after.calculations.find((c) => c.id === "c-1")!;
    expect(c1b.positions).toEqual(posBefore);
    expect(c1b.costSummary ?? null).toEqual(costBefore);
    const g1b = after.schedules.find((s) => s.id === "g-1")!;
    expect(
      g1b.stages.map((s) => ({ id: s.id, start: s.start, end: s.end }))
    ).toEqual(dateFingerprint);
    expect(
      g1b.stages[0].resources?.some((r) => r.id === "school-custom-line")
    ).toBe(true);
    expect(
      g1b.stages[0].resources?.find((r) => r.id === "school-custom-line")?.rate
    ).toBe(1234);
    const pf1b = after.planFacts.find((p) => p.id === "pf-1")!;
    expect(pf1b.entries).toEqual(pfBefore.entries);
    expect(pf1b.dailyFacts ?? []).toEqual(pfBefore.dailyFacts ?? []);
  });

  it("74897 original + opt-in gate", () => {
    expect(isT25uTestFixtureOptIn()).toBe(true);
    const original = readAppData().calculations.find(
      (c) => c.id === T25U_TEST.originalCalculationId
    )!;
    expect(calculationTotals(original).total).toBe(74897.16);
  });
});
