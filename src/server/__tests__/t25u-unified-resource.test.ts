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
import { classifyDirectCostBucket, bucketsFromPositions } from "@/lib/cost-engine";
import {
  EXCEL_RESOURCE_SCHEDULE_DEFAULTS,
  machineHourFullTariffCost,
  rollupResourceSchedule,
  type ResourceScheduleParams,
} from "@/lib/resource-schedule-model";
import {
  T25U_TEST,
  ensureT25uTestFixture,
  isT25uTestFixtureOptIn,
} from "@/lib/t25u-test-fixture";
import {
  isResourceLinkedDraft,
  stagesToResourceLines,
} from "@/lib/unified-resource-sync";
import type { CalcPosition, GprStage } from "@/lib/types";
import {
  closeDb,
  ensureReady,
  mutateAppData,
  readAppData,
  resetAppData,
} from "@/server/db";
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

function resetT25uDb() {
  closeDb();
  ensureReady();
  resetAppData();
  mutateAppData((d) => ensureT25uTestFixture(d));
}

/** Non-default N/O — must flow into tree/sync/export when no per-resource override. */
const NON_DEFAULT_PARAMS: ResourceScheduleParams = {
  ...EXCEL_RESOURCE_SCHEDULE_DEFAULTS,
  hoursPerShift: 10,
  personnelShiftsPerDay: 1,
  equipmentShiftsPerDay: 1,
};

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

function expectPdfAmount(text: string, label: string, amount: number) {
  const compact = text.replace(/\s/g, "");
  const formatted = (Math.round(amount * 100) / 100)
    .toLocaleString("ru-RU", { maximumFractionDigits: 2 })
    .replace(/\s/g, "");
  expect(compact).toContain(`${label.replace(/\s/g, "")}${formatted}`);
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
    resetT25uDb();
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

  it("GPR workbook exports a nested work → resource groups → materials sheet", async () => {
    const buf = await buildGprXlsx(T25U_TEST.scheduleId);
    const wb = await loadXlsx(buf);
    const tree = wb.getWorksheet("Ресурсный график")!;
    const rows: Array<{ row: ExcelJS.Row; name: string }> = [];
    tree.eachRow((row) => rows.push({ row, name: String(row.getCell(1).value ?? "") }));

    const stageIndex = rows.findIndex((entry) => entry.name === "Мобилизация [TEST]");
    expect(stageIndex).toBeGreaterThanOrEqual(0);
    expect(rows[stageIndex + 1].name).toBe("↳ Люди");
    expect(rows[stageIndex + 2].name).toBe("Дорожный рабочий");
    expect(rows[stageIndex + 2].row.outlineLevel).toBe(2);

    const materialGroup = rows.findIndex((entry) => entry.name === "↳ Материалы");
    expect(materialGroup).toBeGreaterThan(stageIndex);
    expect(rows[materialGroup + 1].name).toBe("Материалы мобилизации");
    expect(rows[materialGroup + 1].row.outlineLevel).toBe(2);
    expect(tree.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  });

  it("exports the client A:Z resource grid with nested material rows", async () => {
    const buf = await buildGprXlsx(T25U_TEST.scheduleId);
    const wb = await loadXlsx(buf);
    const sheet = wb.getWorksheet("Клиентский ресурсный график")!;
    expect(sheet.getRow(12).getCell(1).value).toBe("№");
    expect(sheet.getRow(12).getCell(26).value).toBe("Итого Z");
    expect(sheet.getRow(12).getCell(28).value).toBe(1);
    const rows: ExcelJS.Row[] = [];
    sheet.eachRow((row) => rows.push(row));
    const work = rows.findIndex((row) => String(row.getCell(3).value) === "Мобилизация [TEST]");
    expect(work).toBeGreaterThanOrEqual(0);
    expect(String(rows[work].getCell(9).value)).toMatch(/^РАБОТА/);
    expect(rows[work + 1].getCell(9).value).toBe("ГРУППА");
    expect(rows[work + 1].getCell(10).value).toBe("Люди");
    expect(rows[work].getCell(28).value).toBe("■");
    expect(rows[work + 2].getCell(28).value).toBe(4);
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 12 });
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

  it("PARTIAL known 10000 asserts all derivatives W/X/Y/Z", () => {
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
    // Known V from OK only: 1×10×1×1×1000
    const V = 10000;
    expect(build.knownDirect).toBe(V);
    const rollup = rollupResourceSchedule({
      params: EXCEL_RESOURCE_SCHEDULE_DEFAULTS,
      lines: build.lines,
      materialsTotal: build.materialsTotal,
    });
    // Independent hand derivatives on known V (PARTIAL — missing rate excluded)
    const W = roundMoney(V * 0.43); // 4300
    const X = roundMoney(V + W); // 14300
    const Y = roundMoney(X * 0.4); // 5720
    const Z = roundMoney(X + Y); // 20020
    expect(W).toBe(4300);
    expect(X).toBe(14300);
    expect(Y).toBe(5720);
    expect(Z).toBe(20020);
    expect(rollup.direct).toBe(V);
    expect(rollup.overhead).toBe(W);
    expect(rollup.costWithOh).toBe(X);
    expect(rollup.profit).toBe(Y);
    expect(rollup.total).toBe(Z);
    expect(rollup.incomplete.some((i) => i.includes("miss"))).toBe(true);
  });

  it("non-default params: tree/model/GPR/xlsx/pdf share independent expecteds", async () => {
    // No per-resource N/O/P — must read NON_DEFAULT_PARAMS (not silent 11×2 defaults)
    const stages: GprStage[] = [
      {
        id: "nd-1",
        name: "Non-default pack",
        start: "2026-01-01",
        end: "2026-01-03", // 3 calendar days
        sequence: 1,
        resources: [
          {
            id: "nd-lab",
            kind: "labor",
            name: "Crew ND",
            quantity: 2,
            unit: "чел",
            rate: 1400,
            quantityBasis: "count_per_shift",
          },
          {
            id: "nd-bus",
            kind: "bus",
            name: "Bus ND",
            quantity: 2,
            unit: "ед",
            rate: 2650,
            quantityBasis: "count_per_shift",
          },
          {
            id: "nd-mat",
            kind: "material",
            name: "Sand ND",
            quantity: 10,
            unit: "т",
            rate: 500,
            quantityBasis: "material_qty",
          },
        ],
      },
    ];
    // Hand: Q_lab=2×10×1×3=60 R=84000; Q_bus=60 R=159000; S=5000
    const V = 84000 + 159000 + 5000; // 248000
    const W = roundMoney(V * 0.43); // 106640
    const X = roundMoney(V + W); // 354640
    const Y = roundMoney(X * 0.4); // 141856
    const Z = roundMoney(X + Y); // 496496
    expect({ V, W, X, Y, Z }).toEqual({
      V: 248000,
      W: 106640,
      X: 354640,
      Y: 141856,
      Z: 496496,
    });

    // Defaults would give labor Q=2×11×2×3=132 — tree must NOT use that
    const treeDefault = buildHierarchicalEstimate({ stages });
    const labDefault = treeDefault
      .flatMap((n) => n.groups.flatMap((g) => g.leaves))
      .find((l) => l.id === "nd-lab")!;
    expect(labDefault.hoursQ).toBe(132);

    const tree = buildHierarchicalEstimate({
      stages,
      params: NON_DEFAULT_PARAMS,
    });
    const lab = tree
      .flatMap((n) => n.groups.flatMap((g) => g.leaves))
      .find((l) => l.id === "nd-lab")!;
    const bus = tree
      .flatMap((n) => n.groups.flatMap((g) => g.leaves))
      .find((l) => l.id === "nd-bus")!;
    expect(lab.hoursQ).toBe(60);
    expect(lab.amount).toBe(84000);
    expect(bus.hoursQ).toBe(60);
    expect(bus.amount).toBe(159000);

    const build = stagesToResourceLines(stages, NON_DEFAULT_PARAMS);
    expect(build.knownDirect).toBe(V);
    const rollup = rollupResourceSchedule({
      params: NON_DEFAULT_PARAMS,
      lines: build.lines,
      materialsTotal: build.materialsTotal,
    });
    expect(rollup.direct).toBe(V);
    expect(rollup.overhead).toBe(W);
    expect(rollup.costWithOh).toBe(X);
    expect(rollup.profit).toBe(Y);
    expect(rollup.total).toBe(Z);

    // Persist via repo only (no hand writeAppData)
    updateSchedule("u-smet", T25U_TEST.scheduleId, { stages });
    recomputeCalculationCost("u-smet", T25U_TEST.calculationId, {
      useResourceScheduleEconomics: true,
      resourceScheduleParams: NON_DEFAULT_PARAMS,
    });

    const after = readAppData();
    const slices = after.calculations.find(
      (c) => c.id === T25U_TEST.calculationId
    )!.costSummary!.resourceSlices!;
    expect(slices.direct).toBe(V);
    expect(slices.overhead).toBe(W);
    expect(slices.costWithOh).toBe(X);
    expect(slices.profit).toBe(Y);
    expect(slices.total).toBe(Z);

    const treeLive = buildHierarchicalEstimate({
      stages: after.schedules.find((s) => s.id === T25U_TEST.scheduleId)!.stages,
      params:
        after.calculations.find((c) => c.id === T25U_TEST.calculationId)!
          .resourceScheduleParams,
    });
    expect(
      treeLive.flatMap((n) => n.groups.flatMap((g) => g.leaves)).find((l) => l.id === "nd-lab")!
        .amount
    ).toBe(84000);

    const xlsx = await buildCalculationXlsx(T25U_TEST.calculationId);
    const wb = await loadXlsx(xlsx);
    const ws = wb.getWorksheet("Расчёт")!;
    const cell = (code: string) => {
      let v = 0;
      ws.eachRow((row) => {
        if (String(row.getCell(1).value) === code) v = Number(row.getCell(6).value);
      });
      return v;
    };
    expect(cell("V_direct")).toBe(V);
    expect(cell("W_oh43")).toBe(W);
    expect(cell("X_cost_oh")).toBe(X);
    expect(cell("Y_markup40")).toBe(Y);
    expect(cell("Z_total")).toBe(Z);

    const pdfText = pdfExtractText(await buildCalculationPdf(T25U_TEST.calculationId));
    expectPdfAmount(pdfText, "Прямые затраты V:", V);
    expectPdfAmount(pdfText, "Накладные W:", W);
    expectPdfAmount(pdfText, "Себестоимость с накладными X:", X);
    expectPdfAmount(pdfText, "Прибыль Y:", Y);
    expectPdfAmount(pdfText, "Итого ресурсного черновика Z:", Z);

    const gpr = await loadXlsx(await buildGprXlsx(T25U_TEST.scheduleId));
    const res = gpr.getWorksheet("Ресурсы")!;
    let labR: number | null = null;
    let busR: number | null = null;
    res.eachRow((row) => {
      const name = String(row.getCell(3).value ?? "");
      if (name === "Crew ND") labR = Number(row.getCell(12).value);
      if (name === "Bus ND") busR = Number(row.getCell(12).value);
    });
    expect(labR).toBe(84000);
    expect(busR).toBe(159000);
  });

  it("shared classify: MAT- code → materials; bare containers → other visible", () => {
    expect(
      classifyDirectCostBucket({
        code: "MAT-1",
        name: "Контейнеры под бой",
        unit: "шт",
      })
    ).toBe("materials");
    expect(
      classifyDirectCostBucket({
        code: "X-9",
        name: "Контейнеры под бой",
        unit: "шт",
      })
    ).toBe("other");
    const positions: CalcPosition[] = [
      {
        id: "p-mat",
        code: "MAT-1",
        name: "Контейнеры под бой",
        unit: "шт",
        quantity: 8,
        rate: 4500,
      },
      {
        id: "p-oth",
        code: "MISC",
        name: "Прочая услуга",
        unit: "усл",
        quantity: 1,
        rate: 1000,
      },
    ];
    const b = bucketsFromPositions(positions);
    expect(b.materials).toBe(36000);
    expect(b.other).toBe(1000);
    expect(b.labor + b.materials + b.equipment + b.other).toBe(37000);
  });
});

describe("t25u export PARTIAL + numerics (P1 #3 + evidence)", () => {
  beforeEach(() => {
    resetT25uDb();
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
    expectPdfAmount(text, "Прямые затраты V:", slices.direct);
    expectPdfAmount(text, "Накладные W:", slices.overhead);
    expectPdfAmount(text, "Себестоимость с накладными X:", slices.costWithOh);
    expectPdfAmount(text, "Прибыль Y:", slices.profit);
    expectPdfAmount(text, "Итого ресурсного черновика Z:", slices.total);
    expect(text).toMatch(/неполный расчёт/i);
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

  it("genuine bus qty+rate mutate → close/reopen → tree/xlsx/pdf/GPR full V–Z", async () => {
    // Baseline golden bus on TEST fixture: 2×11×1×3×2650 = 174900
    const before = readAppData();
    const bus0 = before.schedules
      .find((s) => s.id === T25U_TEST.scheduleId)!
      .stages.flatMap((s) => s.resources ?? [])
      .find((r) => r.id === "rst-2-bus")!;
    expect(bus0.quantity).toBe(2);
    expect(bus0.rate).toBe(2650);

    // REAL repo/API path used by UI store (`action: patchResource`): BOTH qty + rate
    patchScheduleResourceAndSync("u-smet", T25U_TEST.scheduleId, {
      resourceId: "rst-2-bus",
      stageId: "gst-2",
      quantity: 3,
      rate: 2700,
    });

    // Independent hand constants (NOT from costSummary under test):
    // Bus Q=3×11×1×3=99 R=99×2700=267300
    // Other known: labor/eq/mat/bus1 from fixture arithmetic → V=10171048
    const expectedQ = 99;
    const expectedR = 267300;
    const V = 10171048;
    const W = roundMoney(V * 0.43); // 4373550.64
    const X = roundMoney(V + W); // 14544598.64
    const Y = roundMoney(X * 0.4); // 5817839.46
    const Z = roundMoney(X + Y); // 20362438.1
    expect({ expectedQ, expectedR, V, W, X, Y, Z }).toEqual({
      expectedQ: 99,
      expectedR: 267300,
      V: 10171048,
      W: 4373550.64,
      X: 14544598.64,
      Y: 5817839.46,
      Z: 20362438.1,
    });

    const mid = readAppData();
    const bus1 = mid.schedules
      .find((s) => s.id === T25U_TEST.scheduleId)!
      .stages.flatMap((s) => s.resources ?? [])
      .find((r) => r.id === "rst-2-bus")!;
    expect(bus1.quantity).toBe(3);
    expect(bus1.rate).toBe(2700);

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

    const params =
      after.calculations.find((c) => c.id === T25U_TEST.calculationId)!
        .resourceScheduleParams ?? EXCEL_RESOURCE_SCHEDULE_DEFAULTS;
    const tree = buildHierarchicalEstimate({
      stages: after.schedules.find((s) => s.id === T25U_TEST.scheduleId)!.stages,
      params,
    });
    const leaf = tree
      .flatMap((n) => n.groups.flatMap((g) => g.leaves))
      .find((l) => l.id === "rst-2-bus")!;
    expect(leaf.hoursQ).toBe(expectedQ);
    expect(leaf.amount).toBe(expectedR);

    const draft = after.calculations.find((c) => c.id === T25U_TEST.calculationId)!;
    expect(draft.costSummary!.resourceSlices!.direct).toBe(V);
    expect(draft.costSummary!.resourceSlices!.overhead).toBe(W);
    expect(draft.costSummary!.resourceSlices!.costWithOh).toBe(X);
    expect(draft.costSummary!.resourceSlices!.profit).toBe(Y);
    expect(draft.costSummary!.resourceSlices!.total).toBe(Z);

    const xlsx = await buildCalculationXlsx(T25U_TEST.calculationId);
    const wb = await loadXlsx(xlsx);
    const ws = wb.getWorksheet("Расчёт")!;
    const cell = (code: string) => {
      let v = 0;
      ws.eachRow((row) => {
        if (String(row.getCell(1).value) === code) v = Number(row.getCell(6).value);
      });
      return v;
    };
    expect(cell("V_direct")).toBe(V);
    expect(cell("W_oh43")).toBe(W);
    expect(cell("X_cost_oh")).toBe(X);
    expect(cell("Y_markup40")).toBe(Y);
    expect(cell("Z_total")).toBe(Z);

    const pdfText = pdfExtractText(
      await buildCalculationPdf(T25U_TEST.calculationId)
    );
    expectPdfAmount(pdfText, "Прямые затраты V:", V);
    expectPdfAmount(pdfText, "Накладные W:", W);
    expectPdfAmount(pdfText, "Себестоимость с накладными X:", X);
    expectPdfAmount(pdfText, "Прибыль Y:", Y);
    expectPdfAmount(pdfText, "Итого ресурсного черновика Z:", Z);

    const gpr = await loadXlsx(await buildGprXlsx(T25U_TEST.scheduleId));
    const res = gpr.getWorksheet("Ресурсы")!;
    let gprR: number | null = null;
    res.eachRow((row) => {
      if (String(row.getCell(3).value) === "Автобус доставки") {
        gprR = Number(row.getCell(12).value);
      }
    });
    expect(gprR).toBe(expectedR);

    // Full V–Z on GPR summary / params sheets (not only resource R)
    const rs = gpr.getWorksheet("Ресурсный_параметры")!;
    const byLabel = new Map<string, number>();
    rs.eachRow((row) => {
      const label = String(row.getCell(1).value ?? "");
      const val = Number(row.getCell(2).value);
      if (Number.isFinite(val)) byLabel.set(label, val);
    });
    const findVal = (re: RegExp) => {
      for (const [k, v] of byLabel) if (re.test(k)) return v;
      return null;
    };
    expect(findVal(/Прямые V/)).toBe(V);
    expect(findVal(/НР W/)).toBe(W);
    expect(findVal(/С\/с с НР X|с НР X/)).toBe(X);
    expect(findVal(/Прибыль Y/)).toBe(Y);
    expect(findVal(/Итого Z/)).toBe(Z);
  });
});

describe("t25u school non-destructive + custom line", () => {
  beforeEach(() => {
    resetT25uDb();
  });

  it("manual resource row added in the spreadsheet resyncs draft positions and cost slices", () => {
    const before = readAppData();
    const schedule = before.schedules.find((item) => item.id === T25U_TEST.scheduleId)!;
    const calculation = before.calculations.find((item) => item.id === T25U_TEST.calculationId)!;
    const materialsBefore = calculation.costSummary?.resourceSlices?.materials ?? 0;
    const stages = structuredClone(schedule.stages);
    stages[0].resources = [
      ...(stages[0].resources ?? []),
      {
        id: "manual-sheet-material",
        kind: "material",
        name: "[TEST] Ручной материал из таблицы",
        unit: "м³",
        quantity: 12,
        rate: 250,
        quantityBasis: "material_qty",
      },
    ];
    updateSchedule("u-smet", schedule.id, { stages });
    const after = readAppData();
    const updatedCalculation = after.calculations.find((item) => item.id === calculation.id)!;
    expect(updatedCalculation.positions.some((position) =>
      position.sourceResourceId === "manual-sheet-material" &&
      position.name === "[TEST] Ручной материал из таблицы" &&
      position.quantity === 12 &&
      position.rate === 250
    )).toBe(true);
    expect(updatedCalculation.costSummary?.resourceSlices?.materials).toBe(materialsBefore + 3000);
    expect(updatedCalculation.costSummary?.resourceSlices?.total).toBeGreaterThan(
      calculation.costSummary?.resourceSlices?.total ?? 0
    );
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
