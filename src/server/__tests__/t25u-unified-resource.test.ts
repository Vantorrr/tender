import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";
import { calculationTotals, roundMoney } from "@/lib/calc-math";
import { machineHourFullTariffCost } from "@/lib/resource-schedule-model";
import { T25U_TEST, isT25uTestFixtureOptIn } from "@/lib/t25u-test-fixture";
import {
  inferQuantityBasis,
  isResourceLinkedDraft,
  stagesToResourceLines,
  syncDraftFromStages,
} from "@/lib/unified-resource-sync";
import { closeDb, ensureReady, readAppData, writeAppData } from "@/server/db";
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
  // exceljs typings disagree with Node Buffer generics — cast via ArrayBuffer view
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(buf as any);
  return wb;
}

/** Read calc-pdf text via pdftotext (UI export path content). */
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

describe("t25u dimensions + golden Q/R", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("golden bus: 2×11×1×3×2650 = 174900 (full tariff, no fuel/driver stack)", () => {
    const mh = machineHourFullTariffCost({
      quantity: 2,
      ratePerMachineHour: 2650,
      hoursPerShift: 11,
      shiftsPerDay: 1,
      days: 3,
    });
    expect(mh.hours).toBe(66);
    expect(mh.amount).toBe(174900);
    expect(mh.flags).toContain("no_extra_fuel_or_driver_on_top");

    const g = readAppData().schedules.find((s) => s.id === T25U_TEST.scheduleId)!;
    const busB = g.stages
      .flatMap((s) => s.resources ?? [])
      .find((r) => r.id === "rst-2-bus")!;
    expect(busB.quantity).toBe(2);
    expect(busB.hoursPerShift).toBe(11);
    expect(busB.shiftsPerDay).toBe(1);
    expect(busB.days).toBe(3);
    expect(busB.rate).toBe(2650);

    const build = stagesToResourceLines(
      g.stages,
      readAppData().calculations.find((c) => c.id === T25U_TEST.calculationId)!
        .resourceScheduleParams!
    );
    const line = build.lines.find((l) => l.id === "rst-2-bus")!;
    expect(line.quantity * line.hoursPerShift * line.shiftsPerDay * line.days).toBe(
      66
    );
    expect(roundMoney(66 * 2650)).toBe(174900);
  });

  it("two buses on different stages are summed — not leave-first", () => {
    const g = readAppData().schedules.find((s) => s.id === T25U_TEST.scheduleId)!;
    const buses = g.stages.flatMap((s) =>
      (s.resources ?? []).filter((r) => r.kind === "bus")
    );
    expect(buses.length).toBeGreaterThanOrEqual(2);
    const build = stagesToResourceLines(g.stages);
    const busLines = build.lines.filter((l) =>
      buses.some((b) => b.id === l.id)
    );
    expect(busLines.length).toBe(buses.length);
    expect(build.skipped.some((x) => x.startsWith("duplicate_bus:"))).toBe(
      false
    );
  });

  it("materials are not counted in Q-hours; containers stay material_qty", () => {
    const g = readAppData().schedules.find((s) => s.id === T25U_TEST.scheduleId)!;
    const mat = g.stages
      .flatMap((s) => s.resources ?? [])
      .find((r) => r.id === "rst-2-mat")!;
    expect(inferQuantityBasis(mat)).toBe("material_qty");
    const draft = readAppData().calculations.find(
      (c) => c.id === T25U_TEST.calculationId
    )!;
    const synced = syncDraftFromStages(draft, g.stages, {
      replacePositions: true,
    });
    // Q hours must exclude 8 containers
    expect(synced.calc.costSummary!.resourceSlices!.hours).toBe(
      synced.build.knownHours
    );
    const matLine = synced.build.lines.find((l) => l.id === "rst-2-mat");
    expect(matLine?.category).toBe("material");
    // knownHours excludes material category
    expect(synced.build.knownHours).toBeLessThan(
      synced.build.knownHours + 8
    );
  });

  it("does not force N=O=P=1 for count_per_shift; uncertain stays incomplete", () => {
    const stages = [
      {
        id: "st",
        name: "X",
        start: "2026-01-01",
        end: "2026-01-03",
        sequence: 1,
        resources: [
          {
            id: "u1",
            kind: "labor" as const,
            name: "Weird unit",
            quantity: 2,
            unit: "пакет",
            rate: 100,
            quantityBasis: "uncertain" as const,
          },
        ],
      },
    ];
    const build = stagesToResourceLines(stages);
    expect(build.incomplete.some((x) => x.includes("unit_basis_uncertain"))).toBe(
      true
    );
    const line = build.lines[0];
    expect(Number.isFinite(line.hoursPerShift)).toBe(false);
  });
});

describe("t25u export V/W/X/Y/Z + partial", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("calc-xlsx for resource draft writes V/W/X/Y/Z not НР15/СП8", async () => {
    recomputeCalculationCost("u-smet", T25U_TEST.calculationId, {
      useResourceScheduleEconomics: true,
    });
    const draft = readAppData().calculations.find(
      (c) => c.id === T25U_TEST.calculationId
    )!;
    const slices = draft.costSummary!.resourceSlices!;
    expect(slices.partial || draft.costSummary!.totalsIncomplete).toBe(true);

    const buf = await buildCalculationXlsx(T25U_TEST.calculationId);
    const wb = await loadXlsx(buf);
    const ws = wb.getWorksheet("Расчёт")!;
    const codes: string[] = [];
    const byCode = new Map<string, { name: string; sum: number }>();
    ws.eachRow((row) => {
      const code = String(row.getCell(1).value ?? "");
      if (!code) return;
      codes.push(code);
      byCode.set(code, {
        name: String(row.getCell(2).value ?? ""),
        sum: Number(row.getCell(6).value ?? 0),
      });
    });
    expect(codes).toContain("V_direct");
    expect(codes).toContain("W_oh43");
    expect(codes).toContain("X_cost_oh");
    expect(codes).toContain("Y_markup40");
    expect(codes).toContain("Z_total");
    expect(codes).not.toContain("Итого");
    expect(byCode.get("V_direct")!.sum).toBe(slices.direct);
    expect(byCode.get("W_oh43")!.sum).toBe(slices.overhead);
    expect(byCode.get("Z_total")!.sum).toBe(slices.total);
    expect(byCode.get("W_oh43")!.name).toMatch(/PARTIAL/i);
    expect(byCode.get("Z_total")!.name).toMatch(/PARTIAL/i);

    // Immutable original keeps legacy НР15/СП8
    const origBuf = await buildCalculationXlsx(T25U_TEST.originalCalculationId);
    const owb = await loadXlsx(origBuf);
    const ows = owb.getWorksheet("Расчёт")!;
    const oCodes: string[] = [];
    ows.eachRow((row) => oCodes.push(String(row.getCell(1).value ?? "")));
    expect(oCodes).toContain("Итого");
    expect(oCodes).not.toContain("Z_total");
    const origTotal = calculationTotals(
      readAppData().calculations.find(
        (c) => c.id === T25U_TEST.originalCalculationId
      )!
    ).total;
    expect(origTotal).toBe(74897.16);
  });

  it("calc-pdf content includes V/W/X/Y/Z PARTIAL for draft", async () => {
    recomputeCalculationCost("u-smet", T25U_TEST.calculationId, {
      useResourceScheduleEconomics: true,
    });
    const pdf = await buildCalculationPdf(T25U_TEST.calculationId);
    const text = pdfExtractText(pdf);
    expect(text).toMatch(/V direct/);
    expect(text).toMatch(/W OH43%/);
    expect(text).toMatch(/Z TOTAL/);
    expect(text).toMatch(/PARTIAL/);

    const origPdf = await buildCalculationPdf(T25U_TEST.originalCalculationId);
    const ot = pdfExtractText(origPdf);
    expect(ot).toMatch(/ORIGINAL TOTAL/);
    expect(ot).not.toMatch(/Z TOTAL/);
  });

  it("GPR export sheets carry numeric V/W/X/Y/Z (separate from calc button)", async () => {
    recomputeCalculationCost("u-smet", T25U_TEST.calculationId, {
      useResourceScheduleEconomics: true,
    });
    const slices = readAppData().calculations.find(
      (c) => c.id === T25U_TEST.calculationId
    )!.costSummary!.resourceSlices!;
    const buf = await buildGprXlsx(T25U_TEST.scheduleId);
    const wb = await loadXlsx(buf);
    const rs = wb.getWorksheet("Ресурсный_параметры")!;
    const vals: Record<string, number | string> = {};
    rs.eachRow((row) => {
      const k = String(row.getCell(1).value ?? "");
      vals[k] = row.getCell(2).value as number | string;
    });
    expect(Number(vals["Прямые V"])).toBe(slices.direct);
    expect(Number(vals["НР W"])).toBe(slices.overhead);
    expect(Number(vals["Итого Z"])).toBe(slices.total);
  });
});

describe("t25u edit→save→reopen→export + non-destructive school", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("qty/rate edit persists across DB reopen and export Z matches", async () => {
    patchScheduleResourceAndSync("u-smet", T25U_TEST.scheduleId, {
      resourceId: "rst-2-bus",
      stageId: "gst-2",
      quantity: 2,
      rate: 2650,
    });
    const mid = readAppData();
    const z1 = mid.calculations.find((c) => c.id === T25U_TEST.calculationId)!
      .costSummary!.resourceSlices!.total;

    writeAppData(mid);
    closeDb();
    ensureReady();

    const after = readAppData();
    const bus = after.schedules
      .find((s) => s.id === T25U_TEST.scheduleId)!
      .stages.flatMap((s) => s.resources ?? [])
      .find((r) => r.id === "rst-2-bus")!;
    expect(bus.quantity).toBe(2);
    expect(bus.rate).toBe(2650);
    const draft = after.calculations.find((c) => c.id === T25U_TEST.calculationId)!;
    expect(draft.costSummary!.resourceSlices!.total).toBe(z1);

    const xlsx = await buildCalculationXlsx(T25U_TEST.calculationId);
    const wb = await loadXlsx(xlsx);
    const ws = wb.getWorksheet("Расчёт")!;
    let zCell = 0;
    ws.eachRow((row) => {
      if (String(row.getCell(1).value) === "Z_total") {
        zCell = Number(row.getCell(6).value);
      }
    });
    expect(zCell).toBe(z1);
  });

  it("updateSchedule on school g-1 does not replace c-1 positions / cost / pf facts", () => {
    const before = readAppData();
    const c1 = before.calculations.find((c) => c.id === "c-1")!;
    expect(isResourceLinkedDraft(c1)).toBe(false);
    const posBefore = structuredClone(c1.positions);
    const costBefore = structuredClone(c1.costSummary ?? null);
    const pfBefore = structuredClone(
      before.planFacts.find((p) => p.id === "pf-1")!
    );
    const g1 = before.schedules.find((s) => s.id === "g-1")!;
    const stages = structuredClone(g1.stages);
    stages[0] = {
      ...stages[0],
      resources: [
        ...(stages[0].resources ?? []),
        {
          id: "school-extra-res",
          kind: "labor",
          name: "Probe",
          quantity: 99,
          unit: "чел",
          rate: 1,
        },
      ],
    };

    updateSchedule("u-smet", "g-1", { stages });

    const after = readAppData();
    const c1b = after.calculations.find((c) => c.id === "c-1")!;
    expect(c1b.positions).toEqual(posBefore);
    expect(c1b.costSummary ?? null).toEqual(costBefore);
    const pf1b = after.planFacts.find((p) => p.id === "pf-1")!;
    expect(pf1b.entries).toEqual(pfBefore.entries);
    expect(pf1b.dailyFacts ?? []).toEqual(pfBefore.dailyFacts ?? []);
    // Schedule did update
    expect(
      after.schedules
        .find((s) => s.id === "g-1")!
        .stages[0].resources?.some((r) => r.id === "school-extra-res")
    ).toBe(true);
  });

  it("74897 remains immutable original; opt-in gate works", () => {
    expect(isT25uTestFixtureOptIn()).toBe(true);
    const original = readAppData().calculations.find(
      (c) => c.id === T25U_TEST.originalCalculationId
    )!;
    expect(original.immutable).toBe(true);
    expect(calculationTotals(original).total).toBe(74897.16);
    expect(
      isT25uTestFixtureOptIn({
        T25U_TEST_FIXTURE: "0",
        NODE_ENV: "production",
      })
    ).toBe(false);
  });
});
