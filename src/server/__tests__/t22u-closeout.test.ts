import { beforeEach, describe, expect, it } from "vitest";
import { createSession } from "@/server/auth";
import {
  closeDb,
  ensureReady,
  mutateAppData,
  readAppData,
} from "@/server/db";
import { buildGprXlsx, buildPlanFactXlsx } from "@/server/export";
import {
  addDailyProductionFact,
  recomputeCalculationCost,
  transferProcurementToProduction,
} from "@/server/repo";
import { validateDirectoryImport } from "@/lib/directory-import";
import { allocatePlanForSlice } from "@/lib/plan-from-gpr";
import { economicsFromVolumes } from "@/lib/economics-from-rates";
import { collectCalendarWarnings } from "@/lib/calendar-availability";
import ExcelJS from "exceljs";
import "./setup";

describe("t22u closeout remediable", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("nested money ACL: ensureMoney requires dengi section", async () => {
    const { POST } = await import("@/app/api/zakupki/route");
    // tender has zakupki but not dengi by default
    const token = createSession("u-tender");
    const res = await POST(
      new Request("http://local/api/zakupki", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action: "ensureMoney", id: "p-1" }),
      })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(String(body.error ?? "")).toMatch(/dengi|прав/i);
  });

  it("nested money ACL: saveMoney deep-link API also requires dengi", async () => {
    const { POST } = await import("@/app/api/zakupki/route");
    const token = createSession("u-tender");
    const res = await POST(
      new Request("http://local/api/zakupki", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: "saveMoney",
          id: "p-1",
          moneyId: "m-1",
          patch: { title: "hack" },
        }),
      })
    );
    expect(res.status).toBe(403);
  });

  it("directory import rejects missing required columns (no silent success)", () => {
    const v = validateDirectoryImport("rascenki", [
      { foo: 1, bar: 2 },
    ]);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/обязательн/i);
  });

  it("stage volumes beat uniform allocation", () => {
    const stages = [
      {
        id: "1",
        name: "A",
        start: "2026-01-01",
        end: "2026-01-02",
        sequence: 1,
        planVolume: 90,
      },
      {
        id: "2",
        name: "B",
        start: "2026-01-03",
        end: "2026-01-04",
        sequence: 2,
        planVolume: 10,
      },
    ];
    const a = allocatePlanForSlice(0, stages, "day", "2026-01-01");
    const b = allocatePlanForSlice(0, stages, "day", "2026-01-03");
    expect(a.source).toBe("stage_volumes");
    expect(a.plan).toBe(45);
    expect(b.plan).toBe(5);
  });

  it("economics uses confirmed rates only; missing → incomplete not 0 money", () => {
    const eco = economicsFromVolumes({
      entries: [
        {
          id: "e1",
          workName: "Демонтаж перегородок",
          unit: "м²",
          plan: 10,
          fact: 2,
        },
      ],
      daily: [
        {
          id: "d1",
          date: "2026-11-08",
          workName: "Демонтаж перегородок",
          unit: "м²",
          quantity: 2,
          photos: [],
          authorId: "u",
          at: "",
        },
      ],
      positions: [
        {
          id: "p1",
          code: "1",
          name: "Демонтаж перегородок",
          unit: "м²",
          quantity: 10,
          rate: 500,
        },
      ],
      directories: [],
    });
    expect(eco.physicalIndex).toBe(2);
    expect(eco.autoIncurred).toBe(1000);
    expect(eco.incomplete).toEqual([]);

    const missing = economicsFromVolumes({
      entries: [
        {
          id: "e1",
          workName: "Неизвестная работа",
          unit: "м²",
          plan: 1,
          fact: 1,
        },
      ],
      positions: [],
      directories: [],
    });
    expect(missing.autoIncurred).toBe(0);
    expect(missing.incomplete.length).toBeGreaterThan(0);
  });

  it("calendar warnings surface crew peaks and supply timing", () => {
    const stages = [
      {
        id: "s1",
        name: "A",
        start: "2026-06-01",
        end: "2026-06-05",
        sequence: 1,
        crewSize: 30,
      },
      {
        id: "s2",
        name: "B",
        start: "2026-06-01",
        end: "2026-06-05",
        sequence: 2,
        crewSize: 25,
      },
    ];
    const w = collectCalendarWarnings(
      stages,
      [
        {
          id: "sup1",
          orgId: "org-alfa",
          procurementId: "p-1",
          materialName: "Арматура",
          unit: "т",
          qtyNeed: 1,
          qtyOrdered: 0,
          qtyDelivered: 0,
          needBy: "2027-01-01",
          status: "need",
          createdAt: "",
          updatedAt: "",
        },
      ],
      40
    );
    expect(w.some((x) => x.kind === "crew_peak")).toBe(true);
    expect(w.some((x) => x.kind === "supply_late")).toBe(true);
  });

  it("GPR and planfact xlsx reopen with formulas + incompleteness sheet", async () => {
    recomputeCalculationCost("u-smet", "c-1");
    const g = readAppData().schedules[0];
    const buf = await buildGprXlsx(g.id);
    expect(buf.byteLength).toBeGreaterThan(1000);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    expect(wb.getWorksheet("Сводка")).toBeTruthy();
    expect(wb.getWorksheet("Ресурсы")).toBeTruthy();
    expect(wb.getWorksheet("Ресурсный_параметры")).toBeTruthy();
    const res = wb.getWorksheet("Ресурсы")!;
    // Shared dimension columns: L / Q / R (no silent D*F); header present
    expect(String(res.getCell("D1").value)).toMatch(/L/i);
    expect(String(res.getCell("J1").value)).toMatch(/Q/i);
    expect(String(res.getCell("L1").value)).toMatch(/R/i);
    if (res.rowCount > 1) {
      // Row 2 is a resource or empty — status column exists
      expect(String(res.getCell("M1").value)).toMatch(/Статус/i);
    }

    transferProcurementToProduction("u-ruk", "p-1");
    const pfId = readAppData().procurements.find((p) => p.id === "p-1")!
      .planFactId!;
    addDailyProductionFact("u-obj", pfId, {
      date: "2026-12-01",
      workName: "Демонтаж перегородок",
      unit: "м²",
      quantity: 3,
      photos: [],
    });
    const pfBuf = await buildPlanFactXlsx(pfId);
    const pfWb = new ExcelJS.Workbook();
    await pfWb.xlsx.load(pfBuf as unknown as ExcelJS.Buffer);
    const pf = pfWb.getWorksheet("ПланФакт")!;
    const e2 = pf.getCell("E2").value as { formula?: string };
    expect(e2?.formula).toMatch(/D2-C2/);
  });

  it("costSummary marks totalsIncomplete when materials missing", () => {
    recomputeCalculationCost("u-smet", "c-1");
    const calc = readAppData().calculations.find((c) => c.id === "c-1")!;
    expect(calc.costSummary?.incomplete?.length).toBeGreaterThan(0);
    expect(calc.costSummary?.totalsIncomplete).toBe(true);
  });
});
