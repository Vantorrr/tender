import { beforeEach, describe, expect, it } from "vitest";
import { calculationTotals, roundMoney } from "@/lib/calc-math";
import { T25U_TEST, isT25uTestFixtureOptIn } from "@/lib/t25u-test-fixture";
import {
  patchStageResource,
  stagesToResourceLines,
  syncDraftFromStages,
} from "@/lib/unified-resource-sync";
import { closeDb, ensureReady, readAppData, writeAppData } from "@/server/db";
import {
  patchScheduleResourceAndSync,
  recomputeCalculationCost,
} from "@/server/repo";
import { buildGprXlsx } from "@/server/export";
import "./setup";

describe("t25u unified resource model", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("opt-in gate is on in test env", () => {
    expect(isT25uTestFixtureOptIn()).toBe(true);
    expect(process.env.T25U_TEST_FIXTURE).toBe("1");
  });

  it("74897 is immutable original (NR15/SP8), not resource Z", () => {
    const data = readAppData();
    const original = data.calculations.find(
      (c) => c.id === T25U_TEST.originalCalculationId
    )!;
    expect(original.immutable).toBe(true);
    expect(original.kind).toBe("customer_original");
    const tot = calculationTotals(original);
    expect(tot.works).toBe(60892);
    expect(tot.total).toBe(74897.16);
  });

  it("TEST schedule has a single bus (no double bus/GSM/driver)", () => {
    const g = readAppData().schedules.find((s) => s.id === T25U_TEST.scheduleId)!;
    const buses = g.stages.flatMap((s) =>
      (s.resources ?? []).filter((r) => r.kind === "bus")
    );
    expect(buses).toHaveLength(1);
    const build = stagesToResourceLines(g.stages);
    expect(build.skipped.some((x) => x.startsWith("duplicate_bus:"))).toBe(
      false
    );
  });

  it("qty/rate edit → manual V/W/X/Y/Z, save→reload, export/сводка match", () => {
    const before = readAppData();
    const schedule = before.schedules.find((s) => s.id === T25U_TEST.scheduleId)!;
    const labor = schedule.stages
      .flatMap((s) => s.resources ?? [])
      .find((r) => r.id === "rst-2-labor")!;
    expect(labor.quantity).toBe(10);
    expect(labor.rate).toBe(1054);

    // Patch qty 10→12 and rate 1054→1100
    patchScheduleResourceAndSync("u-smet", T25U_TEST.scheduleId, {
      resourceId: "rst-2-labor",
      stageId: "gst-2",
      quantity: 12,
      rate: 1100,
    });

    const mid = readAppData();
    const g2 = mid.schedules.find((s) => s.id === T25U_TEST.scheduleId)!;
    const labor2 = g2.stages
      .flatMap((s) => s.resources ?? [])
      .find((r) => r.id === "rst-2-labor")!;
    expect(labor2.quantity).toBe(12);
    expect(labor2.rate).toBe(1100);

    const draft = mid.calculations.find((c) => c.id === T25U_TEST.calculationId)!;
    expect(draft.kind).toBe("resource_draft");
    const pos = draft.positions.find((p) => p.name === "Демонтажник")!;
    expect(pos.quantity).toBe(12);
    expect(pos.rate).toBe(1100);
    expect(pos.rateMissing).toBeFalsy();

    // Manual arithmetic on unified lines
    const synced = syncDraftFromStages(draft, g2.stages);
    const slices = synced.calc.costSummary!.resourceSlices!;
    const V = slices.direct;
    const W = roundMoney(V * 0.43);
    const X = roundMoney(V + W);
    const Y = roundMoney(X * 0.4);
    const Z = roundMoney(X + Y);
    expect(slices.overhead).toBe(W);
    expect(slices.costWithOh).toBe(X);
    expect(slices.profit).toBe(Y);
    expect(slices.total).toBe(Z);
    expect(draft.costSummary!.resourceSlices!.total).toBe(Z);
    expect(draft.costSummary!.totalsIncomplete).toBe(true); // missing rates remain

    // No duplicate bus in slices skip noise for this healed fixture
    expect(
      (draft.costSummary!.resourceSlices!.skipped ?? []).length
    ).toBe(0);

    // save→reload
    closeDb();
    ensureReady();
    const reloaded = readAppData();
    const labor3 = reloaded.schedules
      .find((s) => s.id === T25U_TEST.scheduleId)!
      .stages.flatMap((s) => s.resources ?? [])
      .find((r) => r.id === "rst-2-labor")!;
    expect(labor3.quantity).toBe(12);
    expect(labor3.rate).toBe(1100);
    const draft2 = reloaded.calculations.find(
      (c) => c.id === T25U_TEST.calculationId
    )!;
    expect(draft2.costSummary!.resourceSlices!.total).toBe(Z);

    // Original untouched
    const original = reloaded.calculations.find(
      (c) => c.id === T25U_TEST.originalCalculationId
    )!;
    expect(calculationTotals(original).total).toBe(74897.16);
    expect(original.positions.find((p) => p.name === "Демонтажник")!.quantity).toBe(
      10
    );
  });

  it("missing rate stays incomplete — not coerced to 0 confirmed total", () => {
    const data = readAppData();
    const g = data.schedules.find((s) => s.id === T25U_TEST.scheduleId)!;
    const stages = patchStageResource(g.stages, "rst-2-eq", { rate: null }, "gst-2");
    const draft = data.calculations.find((c) => c.id === T25U_TEST.calculationId)!;
    const synced = syncDraftFromStages(draft, stages);
    expect(synced.calc.costSummary!.totalsIncomplete).toBe(true);
    expect(
      synced.calc.costSummary!.incomplete.some((x) =>
        x.includes("rst-2-eq")
      )
    ).toBe(true);
    const pos = synced.calc.positions.find((p) => p.name === "JCB 5 CX")!;
    expect(pos.rateMissing).toBe(true);
    // Known lines still contribute
    expect(synced.calc.costSummary!.resourceSlices!.direct).toBeGreaterThan(0);
  });

  it("recomputeCost and GPR export expose the same Z", async () => {
    recomputeCalculationCost("u-smet", T25U_TEST.calculationId, {
      useResourceScheduleEconomics: true,
    });
    const data = readAppData();
    const draft = data.calculations.find((c) => c.id === T25U_TEST.calculationId)!;
    const Z = draft.costSummary!.resourceSlices!.total;
    expect(Z).toBe(draft.costSummary!.priceExVat);
    const buf = await buildGprXlsx(T25U_TEST.scheduleId);
    expect(buf.byteLength).toBeGreaterThan(500);
  });
});

describe("t25u school regression — resources/rates/facts/photos", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("existing school dates + resources + rates + facts survive migrate/reload", () => {
    const before = readAppData();
    const g1 = before.schedules.find((s) => s.id === "g-1")!;
    const gs2 = g1.stages.find((s) => s.id === "gs-2")!;
    expect(gs2.start).toBe("2026-12-21");
    expect(gs2.end).toBe("2027-01-25");

    // Fingerprint resources/rates after ensureStageResources enrichment
    const resFingerprint = g1.stages.map((s) => ({
      id: s.id,
      start: s.start,
      end: s.end,
      resources: (s.resources ?? []).map((r) => ({
        id: r.id,
        kind: r.kind,
        name: r.name,
        quantity: r.quantity,
        rate: r.rate ?? null,
      })),
    }));

    const pf1 = before.planFacts.find((p) => p.id === "pf-1")!;
    const factFingerprint = {
      entries: pf1.entries.map((e) => ({
        id: e.id,
        workName: e.workName,
        plan: e.plan,
        fact: e.fact,
      })),
      daily: (pf1.dailyFacts ?? []).map((d) => ({
        id: d.id,
        date: d.date,
        quantity: d.quantity,
        photos: (d.photos ?? []).map((p) => ({
          id: p.id,
          fileName: p.fileName,
        })),
      })),
    };

    const c1 = before.calculations.find((c) => c.id === "c-1")!;
    const c1Rates = c1.positions.map((p) => ({
      id: p.id,
      code: p.code,
      quantity: p.quantity,
      rate: p.rate,
    }));

    // Force migrate/reload path
    writeAppData(before);
    closeDb();
    ensureReady();
    const after = readAppData();

    const g1b = after.schedules.find((s) => s.id === "g-1")!;
    expect(
      g1b.stages.map((s) => ({
        id: s.id,
        start: s.start,
        end: s.end,
        resources: (s.resources ?? []).map((r) => ({
          id: r.id,
          kind: r.kind,
          name: r.name,
          quantity: r.quantity,
          rate: r.rate ?? null,
        })),
      }))
    ).toEqual(resFingerprint);

    const pf1b = after.planFacts.find((p) => p.id === "pf-1")!;
    expect({
      entries: pf1b.entries.map((e) => ({
        id: e.id,
        workName: e.workName,
        plan: e.plan,
        fact: e.fact,
      })),
      daily: (pf1b.dailyFacts ?? []).map((d) => ({
        id: d.id,
        date: d.date,
        quantity: d.quantity,
        photos: (d.photos ?? []).map((p) => ({
          id: p.id,
          fileName: p.fileName,
        })),
      })),
    }).toEqual(factFingerprint);

    const c1b = after.calculations.find((c) => c.id === "c-1")!;
    expect(
      c1b.positions.map((p) => ({
        id: p.id,
        code: p.code,
        quantity: p.quantity,
        rate: p.rate,
      }))
    ).toEqual(c1Rates);

    // School must not gain TEST banner ids
    expect(g1b.title).not.toMatch(/\[TEST\]/);
    expect(after.schedules.some((s) => s.id === T25U_TEST.scheduleId)).toBe(
      true
    ); // opt-in in test
  });

  it("prod-like migrate without opt-in does not inject TEST fixture", async () => {
    const { ensureT25uTestFixture } = await import("@/lib/t25u-test-fixture");
    expect(
      isT25uTestFixtureOptIn({
        T25U_TEST_FIXTURE: "0",
        NODE_ENV: "production",
      })
    ).toBe(false);
    expect(
      isT25uTestFixtureOptIn({
        NODE_ENV: "production",
      })
    ).toBe(false);
    const bare = {
      organizations: [{ id: "org-x", name: "X" }],
      objects: [],
      procurements: [],
      calculations: [],
      schedules: [],
      planFacts: [],
    } as unknown as import("@/lib/types").AppData;
    const prev = process.env.T25U_TEST_FIXTURE;
    process.env.T25U_TEST_FIXTURE = "0";
    try {
      ensureT25uTestFixture(bare);
      expect(bare.procurements.some((p) => p.id === T25U_TEST.procurementId)).toBe(
        false
      );
    } finally {
      process.env.T25U_TEST_FIXTURE = prev;
    }
  });
});
