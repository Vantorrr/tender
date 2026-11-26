import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/spravochniki/client-norms/route";
import { DEFAULT_CONTINGENCY_RATE } from "@/lib/client-economics";
import { foldNormSearch } from "@/lib/client-norms";
import { EXCEL_RESOURCE_SCHEDULE_DEFAULTS } from "@/lib/resource-schedule-model";
import { DEFAULT_TENDER_LOGIC_SETTINGS } from "@/lib/tender-logic-settings";
import { createSession } from "@/server/auth";
import {
  clientNormTableCounts,
  ensureClientNormCatalogs,
  listClientNormCatalogs,
  queryClientNormCatalog,
} from "@/server/client-norms";
import { closeDb, ensureReady, getDb, healthSnapshot, mutateAppData, readAppData } from "@/server/db";
import { parseGrandBuffer } from "@/server/grand-smeta";
import {
  createManualProcurement,
  recomputeCalculationCost,
  sendProcurementToCalculation,
} from "@/server/repo";
import { saveUpload } from "@/server/uploads";
import "./setup";

const BURENIE_C0 = 280939759.9;
const BURENIE_PRICE = 393315663.86;

describe("wave 3 client reference catalogs", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("folds Chetra without changing the letters that are stored", () => {
    expect(foldNormSearch("ЧЕТРА")).toBe(foldNormSearch("Четра"));
    expect(foldNormSearch("ЧЕТРА")).toBe("четра");
  });

  it("imports 14/86/547, 5/201, 27 hauls and both site codes once, then again", () => {
    const db = getDb();
    const first = ensureClientNormCatalogs(db);
    const counts = clientNormTableCounts(db);
    expect(counts).toEqual({ output: 547, labor: 201, tkm: 27, sites: counts.sites });
    expect(counts.sites).toBeGreaterThan(0);
    const second = ensureClientNormCatalogs(db);
    expect(second.imported).toEqual([]);
    expect(second.unchanged).toEqual(["output", "labor", "tkm", "sites"]);
    expect(clientNormTableCounts(db)).toEqual(counts);
    ensureClientNormCatalogs(db, { force: true });
    ensureClientNormCatalogs(db, { force: true });
    expect(clientNormTableCounts(db)).toEqual(counts);
    expect(first.counts.output).toBe(547);

    const catalogs = listClientNormCatalogs(db);
    const output = catalogs.find((item) => item.kind === "output")!;
    const labor = catalogs.find((item) => item.kind === "labor")!;
    const tkm = catalogs.find((item) => item.kind === "tkm")!;
    const sites = catalogs.find((item) => item.kind === "sites")!;
    expect(output.counts).toMatchObject({ sections: 14, works: 86, rows: 547, shiftHours: 11 });
    expect(labor.counts).toMatchObject({ operations: 5, rows: 201, shiftHours: 11 });
    expect(tkm.counts).toMatchObject({ hauls: 27, shiftHours: 11 });
    expect(sites.counts.projects).toBe(2);
    expect(output.participatesInOfficialCost).toBe(false);
    expect(output.shiftHours).toBe(11);
    expect(labor.shiftHours).toBe(11);
    expect(tkm.shiftHours).toBe(11);
    expect(sites.shiftHours).toBeNull();
  });

  it("keeps units, the 11-hour shift and both Chetra spellings", () => {
    const db = getDb();
    const rubka = queryClientNormCatalog(db, { catalog: "output", work: "Рубка кустарников", limit: 5 });
    expect(rubka.rows[0]).toMatchObject({ unit: "1 га", shiftHours: 11, workName: "Рубка кустарников" });
    const output = queryClientNormCatalog(db, { catalog: "output", limit: 1000 });
    expect(output.total).toBe(547);
    expect(output.rows).toHaveLength(547);
    for (const row of output.rows) {
      if (!("productivityPerHour" in row)) continue;
      expect(row.shiftHours).toBe(11);
      expect(row.unit === null || typeof row.unit === "string").toBe(true);
      expect(Math.abs((row.productivityPerShift11h ?? 0) - (row.productivityPerHour ?? 0) * 11)).toBeLessThan(1e-6);
    }
    const lower = queryClientNormCatalog(db, { catalog: "output", mechanism: "Четра", limit: 100 });
    const upper = queryClientNormCatalog(db, { catalog: "output", mechanism: "ЧЕТРА", limit: 100 });
    expect(lower.total).toBe(50);
    expect(upper.total).toBe(50);
    const names = new Set(lower.rows.map((row) => ("mechanism" in row ? row.mechanism : "")));
    expect(names.has("Бульдозер Четра Т-9")).toBe(true);
    expect(names.has("Бульдозер ЧЕТРА Т-9")).toBe(true);
    expect(lower.rows.map((row) => ("excelRow" in row ? row.excelRow : 0)).sort((a, b) => a - b)).toEqual(
      upper.rows.map((row) => ("excelRow" in row ? row.excelRow : 0)).sort((a, b) => a - b),
    );
  });

  it("keeps metal-work scan defects and does not invent helper hours", () => {
    const db = getDb();
    const labor = listClientNormCatalogs(db).find((item) => item.kind === "labor")!;
    const note2 = labor.warnings.find((warning) => warning.code === "note2_truncated");
    expect(note2?.text).toContain("в зависимости");
    expect(note2?.text).toContain("не добавлены");
    const header = queryClientNormCatalog(db, { catalog: "labor", operation: 2, work: "Лист", limit: 20 }).catalog.header as {
      notes: Array<{ number: number; text: string; complete: boolean }>;
    };
    expect(header.notes.find((note) => note.number === 2)?.text.endsWith("в зависимости")).toBe(true);
    expect(header.notes.find((note) => note.number === 2)?.complete).toBe(false);
    const paint = queryClientNormCatalog(db, { catalog: "labor", operation: 2, work: "Лист", limit: 20 });
    const sheet = paint.rows.find((row) => "normPerShift11h" in row && row.normPerShift11h === 235.2);
    expect(sheet && "timeHoursPerUnit" in sheet ? sheet.timeHoursPerUnit : null).toBe(0.13);
    expect(sheet && "sourceAnomaly" in sheet ? sheet.sourceAnomaly : "").toContain("235,2");
    const angle = queryClientNormCatalog(db, { catalog: "labor", operation: 3, size: "63×63", limit: 20 });
    const broken = angle.rows.find((row) => "normPerShift11h" in row && row.normPerShift11h === 40);
    expect(broken && "timeHoursPerUnit" in broken ? broken.timeHoursPerUnit : null).toBe(0.07);
    expect(broken && "unit" in broken ? broken.unit : null).toBe("1 рез.");
    const beam = queryClientNormCatalog(db, { catalog: "labor", operation: 3, size: "№45", limit: 20 });
    const plasma = beam.rows.find((row) => "normPerShift11h" in row && row.normPerShift11h === 1.4);
    expect(plasma && "timeHoursPerUnit" in plasma ? plasma.timeHoursPerUnit : null).toBe(0.59);
    const weld = queryClientNormCatalog(db, { catalog: "labor", operation: 5, limit: 5 });
    expect(weld.rows[0]).toMatchObject({ unit: "м.п.", normPerShift11h: 15, shiftHours: 11 });
    expect(clientNormTableCounts(db).labor).toBe(201);
  });

  it("keeps the haul formula bug and does not adopt the sheet's 40/20 rates", () => {
    const db = getDb();
    const haul = queryClientNormCatalog(db, { catalog: "tkm", limit: 100 });
    expect(haul.total).toBe(27);
    expect(haul.rows.map((row) => ("shoulderKm" in row ? row.shoulderKm : 0))).toEqual(
      Array.from({ length: 27 }, (_, index) => index + 1),
    );
    expect(haul.rows.every((row) => "shiftHours" in row && row.shiftHours === 11)).toBe(true);
    const first = haul.rows[0];
    expect(first && "costPerTonneKm" in first ? first.costPerTonneKm : 0).toBeCloseTo(52.13, 2);
    const header = haul.catalog.header as {
      equipmentHourCost: { overheadRateInFile: number; profitRateInFile: number; hoursPerShift: number; totalFormula: string };
      formulaIssue: { writtenFormula: string; cell: string };
    };
    expect(header.formulaIssue).toMatchObject({
      cell: "F5",
      writtenFormula: "=C5+C5*D5+(C5+D5)*E5",
    });
    expect(header.equipmentHourCost.totalFormula).toBe("=C5+C5*D5+(C5+D5)*E5");
    expect(header.equipmentHourCost.overheadRateInFile).toBe(0.4);
    expect(header.equipmentHourCost.profitRateInFile).toBe(0.2);
    expect(header.equipmentHourCost.hoursPerShift).toBe(11);
    expect(haul.catalog.warnings.some((warning) => warning.code === "formula_f5" && warning.text.includes("(C5+D5)*E5"))).toBe(true);
    expect(EXCEL_RESOURCE_SCHEDULE_DEFAULTS.overheadRate).toBe(0.43);
    expect(EXCEL_RESOURCE_SCHEDULE_DEFAULTS.profitMarkupOnCostWithOh).toBe(0.4);
    expect(DEFAULT_CONTINGENCY_RATE).toBe(0.1);
    expect(DEFAULT_TENDER_LOGIC_SETTINGS.shiftProfile).toBe("client_2x11_no_weekends");
  });

  it("keeps site benchmarks, drilling on 88-127 and the 118-minute typo", () => {
    const db = getDb();
    const left = queryClientNormCatalog(db, { catalog: "sites", site: "0-68", limit: 1000 });
    const right = queryClientNormCatalog(db, { catalog: "sites", site: "88-127", limit: 1000 });
    expect(left.total).toBeGreaterThan(0);
    expect(right.total).toBeGreaterThan(0);
    expect(left.rows.every((row) => "siteCode" in row && row.siteCode === "0-68")).toBe(true);
    expect(right.rows.every((row) => "siteCode" in row && row.siteCode === "88-127")).toBe(true);
    const pipe = queryClientNormCatalog(db, { catalog: "sites", site: "0-68", q: "стыка", limit: 20 });
    expect(pipe.rows.some((row) => "note" in row && String(row.note).includes("3 стыка= 30 м"))).toBe(true);
    const drilling = queryClientNormCatalog(db, { catalog: "sites", site: "88-127", work: "Бурение", limit: 20 });
    expect(drilling.rows.map((row) => ("name" in row ? row.name : ""))).toEqual(
      expect.arrayContaining(["Бурение ГПР", "Бурение факт"]),
    );
    const typo = queryClientNormCatalog(db, { catalog: "sites", q: "118", limit: 20 });
    const cell = typo.rows.find((row) => "kind" in row && row.kind === "typo");
    expect(cell).toMatchObject({ fact: "118", siteCode: "0-68" });
    const on68 = queryClientNormCatalog(db, { catalog: "sites", site: "0-68", q: "C55", limit: 20 });
    expect(on68.rows.some((row) => "kind" in row && row.kind === "typo" && row.siteCode === "0-68")).toBe(true);
    const on88 = queryClientNormCatalog(db, { catalog: "sites", site: "88-127", q: "C55", limit: 50 });
    expect(on88.rows.filter((row) => "kind" in row && row.kind === "typo")).toEqual([]);
    expect(cell && "note" in cell ? cell.note : "").toContain("118 минут");
    expect(cell && "shiftHint" in cell ? cell.shiftHint : "").toContain("118 минут");
    const dayNight = queryClientNormCatalog(db, { catalog: "sites", site: "0-68", q: "ночь", limit: 20 });
    expect(dayNight.total).toBeGreaterThan(0);
    const header = left.catalog.header as { typo118: { valueInCell: number } };
    expect(header.typo118.valueInCell).toBe(118);
    expect(left.catalog.warnings.some((warning) => warning.code === "c55_minutes")).toBe(true);
    expect(left.catalog.warnings.some((warning) => warning.code === "not_price_list")).toBe(true);
  });

  it("serves search and idempotent reimport without writing the official cost", async () => {
    const created = createManualProcurement("u-ruk", { title: "Справочник не в цене", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    mutateAppData((data) => {
      const calc = data.calculations.find((item) => item.id === draft.id)!;
      calc.costSummary = {
        C0: 12345.67,
        C: 13000,
        reserve: 654.33,
        profit: 4000,
        priceExVat: 17000,
        vatAmount: null,
        priceIncVat: null,
        method: "sentinel-not-from-norms",
        incomplete: [],
        totalsIncomplete: false,
        at: "2026-11-26T00:00:00.000Z",
      };
      return data;
    });
    const beforeDirectories = JSON.stringify(readAppData().directories.map((item) => [item.id, item.type, item.rows.length, item.current]));
    const token = createSession("u-ruk");
    const found = await GET(new Request("http://local/api/spravochniki/client-norms?catalog=output&mechanism=Четра&limit=100", {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(found.status).toBe(200);
    const body = await found.json() as { total: number; participatesInOfficialCost: boolean; rows: Array<{ mechanism: string }> };
    expect(body.total).toBe(50);
    expect(body.participatesInOfficialCost).toBe(false);
    expect(body.rows.some((row) => row.mechanism === "Бульдозер ЧЕТРА Т-9")).toBe(true);
    const denied = await GET(new Request("http://local/api/spravochniki/client-norms", {
      headers: { authorization: `Bearer ${createSession("u-obj")}` },
    }));
    expect(denied.status).toBe(403);
    const again = await POST(new Request("http://local/api/spravochniki/client-norms", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "reimport" }),
    }));
    expect(again.status).toBe(200);
    const report = await again.json() as { unchanged: string[]; counts: { output: number; labor: number; tkm: number } };
    expect(report.unchanged).toEqual(["output", "labor", "tkm", "sites"]);
    expect(report.counts).toMatchObject({ output: 547, labor: 201, tkm: 27 });
    const forced = await POST(new Request("http://local/api/spravochniki/client-norms", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "reimport", force: true }),
    }));
    expect(forced.status).toBe(200);
    expect(clientNormTableCounts(getDb())).toMatchObject({ output: 547, labor: 201, tkm: 27 });
    const kept = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(kept.costSummary).toMatchObject({ C0: 12345.67, priceExVat: 17000, method: "sentinel-not-from-norms" });
    expect(JSON.stringify(readAppData().directories.map((item) => [item.id, item.type, item.rows.length, item.current]))).toBe(beforeDirectories);
    expect(healthSnapshot().schemaVersion).toBe("22");
  });

  it("keeps a saved total when the schema moves from 21 to 22", () => {
    const created = createManualProcurement("u-ruk", { title: "Схема 21", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    mutateAppData((data) => {
      const calc = data.calculations.find((item) => item.id === draft.id)!;
      calc.costSummary = {
        C0: 999.01,
        C: 999.01,
        reserve: 0,
        profit: 0,
        priceExVat: 999.01,
        vatAmount: null,
        priceIncVat: null,
        method: "saved-before-v22",
        incomplete: [],
        totalsIncomplete: false,
        at: "2020-01-01T00:00:00.000Z",
      };
      calc.participateDecision = "uchastvovat";
      calc.resourceScheduleParams = {
        ...EXCEL_RESOURCE_SCHEDULE_DEFAULTS,
        personnelShiftsPerDay: 2,
        equipmentShiftsPerDay: 2,
        hoursPerShift: 11,
      };
      return data;
    });
    getDb().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '21')").run();
    closeDb();
    ensureReady();
    const migrated = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(healthSnapshot().schemaVersion).toBe("22");
    expect(migrated.costSummary?.C0).toBe(999.01);
    expect(migrated.costSummary?.priceExVat).toBe(999.01);
    expect(migrated.participateDecision).toBe("uchastvovat");
    expect(migrated.resourceScheduleParams).toMatchObject({
      hoursPerShift: 11,
      equipmentShiftsPerDay: 2,
      personnelShiftsPerDay: 2,
      overheadRate: 0.43,
      profitMarkupOnCostWithOh: 0.4,
    });
  });

  it("still prices the drilling reference file at the locked totals", async () => {
    const filePath = path.join(process.cwd(), "fixtures/grand-smeta/ls-02-02-01-burenie.xlsx");
    const parsed = await parseGrandBuffer(fs.readFileSync(filePath));
    const created = createManualProcurement("u-ruk", { title: "Бурение после справочников", region: "Ямал", nmck: 10 });
    const procurement = readAppData().procurements.find((item) => item.id === created.id)!;
    mutateAppData((data) => {
      const org = data.organizations.find((item) => item.id === procurement.orgId)!;
      org.tenderLogic = { ...(org.tenderLogic ?? {}), shiftProfile: "client_2x11_no_weekends" };
      return data;
    });
    const uploaded = await saveUpload("wave3-burenie", "ls-02-02-01-burenie.xlsx", fs.readFileSync(filePath));
    mutateAppData((data) => {
      data.documents.unshift({
        id: "doc-wave3-burenie",
        orgId: procurement.orgId,
        procurementId: created.id,
        title: "ЛС бурение",
        fileName: "ls-02-02-01-burenie.xlsx",
        fileType: "xlsx",
        category: "estimate",
        status: "gotovo",
        versions: [],
        analyticalNote: "",
        citations: [],
        highlights: [],
        uploadedBy: "u-ruk",
        uploadedAt: new Date().toISOString(),
        storedPath: uploaded.storedPath,
        estimatePositions: (parsed?.positions ?? []).map((position, index) => ({
          id: `bur3-${index + 1}`,
          code: position.code,
          name: position.name,
          unit: position.unit,
          quantity: position.quantity,
          rate: position.rate,
          ...(position.rateMissing ? { rateMissing: true } : {}),
          ...(position.isWorkItem ? { isWorkItem: true } : {}),
          ...(position.resourceKind ? { resourceKind: position.resourceKind } : {}),
          ...(position.sectionName ? { sectionName: position.sectionName } : {}),
          ...(position.workName ? { workName: position.workName } : {}),
        })),
      });
      return data;
    });
    sendProcurementToCalculation("u-ruk", created.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === created.id && item.kind === "resource_draft")!;
    const savedParams = { ...draft.resourceScheduleParams! };
    recomputeCalculationCost("u-ruk", draft.id, { resourceScheduleParams: savedParams, useResourceScheduleEconomics: true });
    const priced = readAppData().calculations.find((item) => item.id === draft.id)!;
    expect(priced.referenceReprice?.C0).toBeCloseTo(BURENIE_C0, 2);
    expect(priced.referenceReprice?.priceExVat).toBeCloseTo(BURENIE_PRICE, 2);
    expect(priced.resourceScheduleParams?.hoursPerShift).toBe(11);
    expect(priced.resourceScheduleParams?.equipmentShiftsPerDay).toBe(2);
    expect(clientNormTableCounts(getDb()).output).toBe(547);
  });
});
