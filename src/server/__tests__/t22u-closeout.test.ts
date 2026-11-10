import { beforeEach, describe, expect, it } from "vitest";
import { createSession } from "@/server/auth";
import {
  closeDb,
  ensureReady,
  readAppData,
} from "@/server/db";
import { buildGprXlsx, buildPlanFactXlsx } from "@/server/export";
import {
  addDailyProductionFact,
  recordSupplierQuote,
  recomputeCalculationCost,
  selectSupplierQuote,
  transferProcurementToProduction,
  upsertSupplyRequest,
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

    const ambiguous = economicsFromVolumes({
      entries: [
        {
          id: "e-ambiguous",
          workName: "Монтаж оборудования",
          unit: "шт",
          plan: 1,
          fact: 1,
        },
      ],
      positions: [
        { id: "p-a", code: "A", name: "Монтаж оборудования", unit: "шт", quantity: 1, rate: 100 },
        { id: "p-b", code: "B", name: "Монтаж оборудования", unit: "шт", quantity: 1, rate: 250 },
      ],
      directories: [],
    });
    expect(ambiguous.autoIncurred).toBe(0);
    expect(ambiguous.incomplete).toContain("rate:Монтаж оборудования");
  });

  it("calculates production cost from actual GPR resource quantities without double counting work rates", () => {
    const eco = economicsFromVolumes({
      entries: [{ id: "e1", workName: "Монтаж труб", unit: "м", plan: 10, fact: 2 }],
      daily: [{
        id: "d1", date: "2026-11-08", workName: "Монтаж труб", unit: "м",
        quantity: 2, photos: [], authorId: "u", at: "",
        resourceLines: [
          { kind: "labor", sourceResourceId: "labor-1", name: "Монтажник", unit: "чел.-ч", planQty: 4, factQty: 3 },
          { kind: "material", sourceResourceId: "mat-1", name: "Труба", unit: "м", planQty: 2, factQty: 2 },
        ],
      }],
      positions: [
        { id: "work", code: "W", name: "Монтаж труб", unit: "м", quantity: 10, rate: 1000 },
        { id: "labor-pos", sourceResourceId: "labor-1", code: "L", name: "Монтажник", unit: "чел.-ч", quantity: 40, rate: 500 },
        { id: "mat-pos", sourceResourceId: "mat-1", code: "M", name: "Труба", unit: "м", quantity: 20, rate: 200 },
      ],
      directories: [],
    });

    expect(eco.autoIncurred).toBe(1900);
    expect(eco.incomplete).toEqual([]);
    expect(eco.lines[0].amount).toBe(1900);
  });

  it("keeps resource-based production cost incomplete if a fact quantity or confirmed rate is missing", () => {
    const eco = economicsFromVolumes({
      entries: [{ id: "e1", workName: "Монтаж труб", unit: "м", plan: 10, fact: 2 }],
      daily: [{
        id: "d1", date: "2026-11-08", workName: "Монтаж труб", unit: "м",
        quantity: 2, photos: [], authorId: "u", at: "",
        resourceLines: [
          { kind: "material", sourceResourceId: "mat-1", name: "Труба", unit: "м", planQty: 2, factQty: null },
        ],
      }],
      positions: [{ id: "mat-pos", sourceResourceId: "mat-1", code: "M", name: "Труба", unit: "м", quantity: 20, rate: 0, rateMissing: true }],
      directories: [],
    });

    expect(eco.autoIncurred).toBe(0);
    expect(eco.incomplete).toContain("resource_facts:Монтаж труб");
    expect(eco.lines[0].amount).toBeNull();
  });

  it("values completed and remaining quantities from the customer estimate separately from revenue", () => {
    const input = {
      entries: [{ id: "e1", workName: "Монтаж труб", unit: "м", plan: 10, fact: 2 }],
      daily: [{
        id: "d1", date: "2026-11-08", workName: "Монтаж труб", unit: "м",
        quantity: 2, photos: [], authorId: "u", at: "",
      }],
      positions: [{ id: "cost", code: "C", name: "Монтаж труб", unit: "м", quantity: 10, rate: 500 }],
      customerEstimatePositions: [{ id: "customer", code: "O", name: "Монтаж труб", unit: "м", quantity: 10, rate: 800 }],
      directories: [],
    };
    const complete = economicsFromVolumes(input);
    expect(complete.autoIncurred).toBe(1000);
    expect(complete.customerEstimateValue).toBe(1600);
    expect(complete.customerEstimateRemainingValue).toBe(6400);
    expect(complete.customerEstimateIncomplete).toEqual([]);

    const incomplete = economicsFromVolumes({
      ...input,
      customerEstimatePositions: [
        input.customerEstimatePositions[0],
        { ...input.customerEstimatePositions[0], id: "customer-2", rate: 900 },
      ],
    });
    expect(incomplete.customerEstimateValue).toBeNull();
    expect(incomplete.customerEstimateRemainingValue).toBeNull();
    expect(incomplete.customerEstimateIncomplete).toContain("customer_rate:Монтаж труб");
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

  it("supply workflow persists vendor contact, RFQ draft, and unit price", () => {
    upsertSupplyRequest("u-ruk", {
      procurementId: "p-1",
      workName: "Монтаж трубопровода",
      materialName: "Труба стальная",
      unit: "м",
      qtyNeed: 120,
      needBy: "2026-12-15",
      status: "quoted_draft",
      quoteDraftText: "Просим направить КП на трубу 120 м",
      supplierName: "СеверСнаб",
      supplierEmail: "sales@example.test",
      unitPrice: 1250,
    });
    const created = readAppData().supplyRequests?.find(
      (item) => item.materialName === "Труба стальная"
    );
    expect(created).toMatchObject({
      workName: "Монтаж трубопровода",
      supplierName: "СеверСнаб",
      supplierEmail: "sales@example.test",
      quoteDraftText: "Просим направить КП на трубу 120 м",
      unitPrice: 1250,
    });

    upsertSupplyRequest("u-ruk", {
      id: created!.id,
      procurementId: "p-1",
      materialName: created!.materialName,
      unit: created!.unit,
      qtyNeed: created!.qtyNeed,
      needBy: created!.needBy,
      status: "ordered",
    });
    expect(readAppData().supplyRequests?.find((item) => item.id === created!.id)).toMatchObject({
      status: "ordered",
      supplierName: "СеверСнаб",
      supplierEmail: "sales@example.test",
      unitPrice: 1250,
    });
  });

  it("compares multiple supplier quotes and applies only the explicitly selected offer", () => {
    upsertSupplyRequest("u-ruk", {
      procurementId: "p-1",
      materialName: "Кабель для сравнения",
      unit: "м",
      qtyNeed: 100,
      needBy: "2026-12-20",
    });
    const supply = readAppData().supplyRequests!.find((item) => item.materialName === "Кабель для сравнения")!;
    recordSupplierQuote("u-ruk", supply.id, {
      supplierName: "СеверЭлектро",
      supplierEmail: "sales@sever.example",
      unitPrice: 245,
      deliveryDays: 8,
      note: "Доставка включена",
    });
    recordSupplierQuote("u-ruk", supply.id, {
      supplierName: "ПромКабель",
      unitPrice: 220,
      deliveryDays: 14,
      note: "Самовывоз",
    });
    const offers = readAppData().supplyRequests!.find((item) => item.id === supply.id)!;
    expect(offers.quotes).toHaveLength(2);
    expect(offers.unitPrice).toBeNull();

    const selected = offers.quotes!.find((quote) => quote.supplierName === "СеверЭлектро")!;
    selectSupplierQuote("u-ruk", supply.id, selected.id);
    const after = readAppData().supplyRequests!.find((item) => item.id === supply.id)!;
    expect(after).toMatchObject({
      selectedQuoteId: selected.id,
      supplierName: "СеверЭлектро",
      supplierEmail: "sales@sever.example",
      unitPrice: 245,
    });
    expect(() => selectSupplierQuote("u-ruk", supply.id, "quote-from-another-material")).toThrow(/КП/);
    expect(() => recordSupplierQuote("u-ruk", supply.id, { supplierName: "Ошибка", unitPrice: -1 })).toThrow(/неотрицательным/);
  });

  it("supplier quote API validates price and stores a selected offer on its material request", async () => {
    upsertSupplyRequest("u-ruk", {
      procurementId: "p-1",
      materialName: "КП через API",
      unit: "шт",
      qtyNeed: 5,
      needBy: "2026-12-22",
    });
    const supply = readAppData().supplyRequests!.find((item) => item.materialName === "КП через API")!;
    const { POST } = await import("@/app/api/supply/route");
    const post = (body: unknown) => POST(new Request("http://local/api/supply", {
      method: "POST",
      headers: {
        authorization: `Bearer ${createSession("u-ruk")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }));
    const invalid = await post({ action: "recordQuote", id: supply.id, quote: { supplierName: "Поставщик", unitPrice: -5 } });
    expect(invalid.status).toBe(400);

    const recorded = await post({ action: "recordQuote", id: supply.id, quote: { supplierName: "РесурсПоставка", unitPrice: 125, deliveryDays: 6 } });
    expect(recorded.status).toBe(200);
    const quote = readAppData().supplyRequests!.find((item) => item.id === supply.id)!.quotes![0];
    const selected = await post({ action: "selectQuote", id: supply.id, quoteId: quote.id });
    expect(selected.status).toBe(200);
    expect(readAppData().supplyRequests!.find((item) => item.id === supply.id)).toMatchObject({
      selectedQuoteId: quote.id,
      supplierName: "РесурсПоставка",
      unitPrice: 125,
    });
  });

  it("production can update receipt on its own linked supply, but procurement users cannot", async () => {
    const productionUser = readAppData().users.find((user) => user.role === "otvetstvennyy");
    expect(productionUser?.sections).toContain("proizvodstvo");
    const plan = readAppData().planFacts.find((item) => item.procurementId === "p-1");
    expect(plan).toBeTruthy();
    upsertSupplyRequest("u-ruk", {
      procurementId: "p-1",
      materialName: "Кабель силовой",
      unit: "м",
      qtyNeed: 100,
      needBy: "2026-12-15",
      status: "in_transit",
    });
    const supply = readAppData().supplyRequests!.find((item) => item.materialName === "Кабель силовой")!;

    const { POST } = await import("@/app/api/proizvodstvo/route");
    const request = (userId: string, qtyDelivered: number, supplyStatus: string) => POST(new Request("http://local/api/proizvodstvo", {
      method: "POST",
      headers: {
        authorization: `Bearer ${createSession(userId)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "updateSupplyReceipt",
        planFactId: plan!.id,
        supplyId: supply.id,
        qtyDelivered,
        supplyStatus,
      }),
    }));
    const allowed = await request(productionUser!.id, 35, "in_transit");
    expect(allowed.status).toBe(200);
    expect(readAppData().supplyRequests!.find((item) => item.id === supply.id)).toMatchObject({ qtyDelivered: 35, status: "in_transit" });

    const invalid = await request(productionUser!.id, -1, "delivered");
    expect(invalid.status).toBe(400);
    expect(readAppData().supplyRequests!.find((item) => item.id === supply.id)?.qtyDelivered).toBe(35);

    const response = await request("u-tender", 80, "delivered");
    expect(response.status).toBe(403);
    expect(readAppData().supplyRequests!.find((item) => item.id === supply.id)?.qtyDelivered).toBe(35);
  });

  it("daily production API preserves GPR resource links and rejects invalid fact quantities", async () => {
    const { POST } = await import("@/app/api/proizvodstvo/route");
    const postFact = (resourceLines: unknown[], quantity = 1) => POST(new Request("http://local/api/proizvodstvo", {
      method: "POST",
      headers: {
        authorization: `Bearer ${createSession("u-obj")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "dailyFact",
        planFactId: "pf-1",
        fact: {
          factId: "df-api-resource-link",
          date: "2026-11-10",
          workName: "Демонтаж перегородок",
          unit: "м²",
          quantity,
          resourceLines: [
            { kind: "material", sourceResourceId: "gpr-material-1", name: "Щебень", unit: "т", planQty: 2, factQty: 1 },
            ...resourceLines,
          ],
        },
      }),
    }));

    const accepted = await postFact([]);
    expect(accepted.status).toBe(200);
    const saved = readAppData().planFacts.find((item) => item.id === "pf-1")!
      .dailyFacts?.find((item) => item.id === "df-api-resource-link");
    expect(saved?.resourceLines?.[0]).toMatchObject({
      sourceResourceId: "gpr-material-1",
      kind: "material",
      factQty: 1,
    });

    const negativeWorkFact = await postFact([], -1);
    expect(negativeWorkFact.status).toBe(400);

    const rejected = await postFact([
      { kind: "material", sourceResourceId: "gpr-material-2", name: "Песок", unit: "т", planQty: 2, factQty: -1 },
    ]);
    expect(rejected.status).toBe(400);
    expect(readAppData().planFacts.find((item) => item.id === "pf-1")!
      .dailyFacts?.find((item) => item.id === "df-api-resource-link")?.resourceLines)
      .toEqual(saved?.resourceLines);
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
