import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { supplyCalendarWarnings } from "@/lib/calendar-availability";
import { clientDirectoryVersions, matchCompanyDirectoryRate } from "@/lib/client-dirs";
import { customerWorkRate } from "@/lib/economics-from-rates";
import { calendarDurationDays, datesForStage, periodFromDocumentText, signedQuantityBySection } from "@/lib/estimate-stages";
import { formatDateRangeShort, sameRoundedQuantity } from "@/lib/format";
import { visibleDayBounds } from "@/lib/gantt-range";
import { humanizeIssue } from "@/lib/issue-text";
import { mergeEstimateLeaves, mergeStageResources } from "@/lib/resource-merge";
import { resolveResourceDimensions } from "@/lib/resource-dimensions";
import { EXCEL_RESOURCE_SCHEDULE_DEFAULTS } from "@/lib/resource-schedule-model";
import { positionsFromStages } from "@/lib/unified-resource-sync";
import { analyticalNoteBlocks, analyticalNoteStructure, citationHref, combineEstimateTotals, composeAnalyticalNote, refreshRateAssumption } from "@/lib/wave23";
import type { SupplyRequest } from "@/lib/types";

const directories = clientDirectoryVersions();

describe("company directory rates", () => {
  it("prices labour by title, equipment by model, and leaves an unknown material without a rate", () => {
    const labor = matchCompanyDirectoryRate(directories, {
      code: "ЗТ",
      name: "Кладовщик",
      unit: "чел.-ч",
      resourceKind: "labor",
    });
    expect(labor).toMatchObject({ rate: 881, basis: "job_title" });
    expect(labor?.dirId).not.toMatch(/LAB-1|ATS-1/);
    const named = matchCompanyDirectoryRate(directories, {
      code: "ФЕР05-01-055-05",
      name: "Машинист компрессорных установок",
      unit: "н-ч",
      resourceKind: "labor",
    });
    expect(named?.rate).toBe(1456);
    const fer = matchCompanyDirectoryRate(directories, {
      code: "ФЕР05-01-055-05",
      name: "Бурение скважин",
      unit: "м",
    }, { personHourRate: 1400 });
    expect(fer).toBeNull();
    const generic = matchCompanyDirectoryRate(directories, {
      code: "ЗТ",
      name: "Затраты труда рабочих",
      unit: "чел.-ч",
      resourceKind: "labor",
    }, { personHourRate: 1400 });
    expect(generic).toMatchObject({ rate: 1400, basis: "person_hour" });
    const again = matchCompanyDirectoryRate(directories, {
      code: "ЗТ",
      name: "Затраты труда рабочих",
      unit: "чел.-ч",
      resourceKind: "labor",
    }, { personHourRate: 1400 });
    expect(again?.rate).toBe(generic?.rate);
    const drivers = matchCompanyDirectoryRate(directories, {
      code: "ЗТм",
      name: "Затраты труда машинистов",
      unit: "чел.-ч",
      resourceKind: "equipment",
    }, { personHourRate: 1400 });
    expect(drivers).toBeNull();
    const machine = matchCompanyDirectoryRate(directories, {
      code: "ФСЭМ-1",
      name: "Вахтовый автобус КАМАЗ 43118",
      unit: "маш.-ч",
      resourceKind: "equipment",
    });
    expect(machine).toMatchObject({ rate: 3890, basis: "equipment_model" });
    const material = matchCompanyDirectoryRate(directories, {
      code: "ФССЦ-01.7.03.01-0001",
      name: "Вода",
      unit: "м3",
      resourceKind: "material",
    });
    expect(material).toBeNull();
  });
});

describe("issue wording and quantity blur", () => {
  it("keeps a colon inside the work name and names the known gaps", () => {
    const name = "Бурение скважин группы: 5";
    expect(humanizeIssue(`customer_rate:${name}`)).toBe(`нет расценки заказчика для: ${name}`);
    expect(humanizeIssue("materials_positions")).toBe("Не учтены позиции материалов");
    expect(humanizeIssue("quantity:ЗТ")).toBe("Не указано количество: Затраты труда");
    expect(humanizeIssue("unknown_code_xyz")).toBe("Нужно проверить исходные данные");
    expect(humanizeIssue("materials_positions")).not.toBe("Нужно проверить исходные данные");
    expect(humanizeIssue("quantity:Кладовщик")).not.toBe("Нужно проверить исходные данные");
  });

  it("does not treat a rounded display as a new quantity", () => {
    expect(sameRoundedQuantity(1.23456789, "1.2346", 4)).toBe(true);
    expect(sameRoundedQuantity(1.23456789, "1,2346", 4)).toBe(true);
    expect(sameRoundedQuantity(1.23456789, "2", 4)).toBe(false);
  });
});

describe("calendar dates and returns", () => {
  it("does not call an empty or unusable need-by late", () => {
    const stage = { id: "s", name: "Бурение", start: "2026-11-01", end: "2026-11-30", sequence: 1 };
    const supply = (needBy: string, qtyDelivered = 0): SupplyRequest => ({
      id: "sup",
      orgId: "o",
      procurementId: "p",
      materialName: "Вода",
      unit: "м3",
      qtyNeed: 3,
      qtyOrdered: 0,
      qtyDelivered,
      needBy,
      status: "need",
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-01T00:00:00Z",
    });
    const late = (needBy: string, delivered = 0) => supplyCalendarWarnings([stage], [supply(needBy, delivered)])
      .some((warning) => warning.kind === "supply_late" && /срок прошёл/u.test(warning.message));
    expect(late("")).toBe(false);
    expect(late("не указан")).toBe(false);
    expect(late("не дата")).toBe(false);
    expect(late("2026-11-01", 3)).toBe(false);
    const past = supplyCalendarWarnings([stage], [supply("2020-01-01")]);
    expect(past.some((warning) => warning.kind === "supply_late" && /срок прошёл/u.test(warning.message))).toBe(true);
  });

  it("stores a return quantity as an absolute number and keeps the signed total", () => {
    const merged = mergeStageResources([
      { id: "a", kind: "material", name: "Вода", unit: "м3", quantity: -7.16 },
      { id: "b", kind: "material", name: "Труба", unit: "м", quantity: -164.68 },
    ]);
    expect(merged.every((row) => row.quantity > 0 && row.name.startsWith("Возврат:"))).toBe(true);
    const signed = signedQuantityBySection(merged.map((row) => ({ name: row.name, unit: row.unit, quantity: row.quantity })));
    expect(signed.get("|вода|м3")).toBeCloseTo(-7.16);
    expect(periodFromDocumentText("Начало работ 01.12.2026, окончание 20.12.2026.")).toEqual({ start: "2026-12-01", end: "2026-12-20" });
    expect(periodFromDocumentText("с 01.12.2026 г. по 20.12.2026 г.")).toEqual({ start: "2026-12-01", end: "2026-12-20" });
    expect(periodFromDocumentText("Начало работ 01.12.2026\nокончание 20.12.2026")).toEqual({ start: "2026-12-01", end: "2026-12-20" });
    expect(calendarDurationDays("Договор: 90 календарных дней.")).toBeNull();
    expect(calendarDurationDays("Срок выполнения работ — 90 календарных дней.")).toBe(90);
    expect(calendarDurationDays("Срок выполнения работ по настоящему договору составляет 90 календарных дней.")).toBe(90);
    expect(calendarDurationDays("Гарантийный срок — 60 календарных дней. Срок выполнения работ по настоящему договору составляет 90 календарных дней.")).toBe(90);
    expect(calendarDurationDays("Гарантийный срок выполнения работ составляет 60 календарных дней.")).toBeNull();
    expect(calendarDurationDays("Гарантийный срок выполнения работ составляет 60 календарных дней. Срок выполнения работ по настоящему договору составляет 90 календарных дней.")).toBe(90);
    expect(calendarDurationDays("Срок выполнения работ составляет 90 календарных дней, гарантийный срок 60 календарных дней.")).toBe(90);
    expect(calendarDurationDays("Аванс не предусмотрен, срок выполнения работ составляет 90 календарных дней.")).toBe(90);
    expect(calendarDurationDays("Работы ведутся в две степени, срок выполнения работ составляет 90 календарных дней.")).toBe(90);
    expect(calendarDurationDays("Срок выполнения работ при оплате в течение 60 календарных дней.")).toBeNull();
    expect(calendarDurationDays("Срок выполнения работ при предоплате в течение 60 календарных дней.")).toBeNull();
    expect(calendarDurationDays("Гарантийный срок на выполненные работы составляет 60 календарных дней.")).toBeNull();
    expect(calendarDurationDays("Аванс 30%, срок выполнения работ — 90 календарных дней.")).toBe(90);
    expect(calendarDurationDays("Оплата в течение 60 календарных дней после приемки.")).toBeNull();
    expect(calendarDurationDays("Гарантийный срок — 60 календарных дней.")).toBeNull();
    expect(calendarDurationDays("Гарантийный срок на работы — 60 месяцев.")).toBeNull();
    expect(periodFromDocumentText("Протокол от 01.01.2020. Срок подачи заявки 15.11.2026.")).toBeNull();
    expect(periodFromDocumentText("2026-01-01\n2026-12-31")).toBeNull();
    expect(datesForStage(1, 3, "2026-11-21", null)).toEqual({ start: "2026-11-22", end: "2026-11-22" });
    const mixed = mergeEstimateLeaves([
      { id: "use", kind: "material", name: "Вода", unit: "м3", quantity: 10, amount: 200, rate: 20, incomplete: [] },
      { id: "back", kind: "material", name: "Возврат: Вода", unit: "м3", quantity: 3, amount: -60, rate: 20, difference: -3, incomplete: [] },
    ]);
    expect(mixed).toHaveLength(1);
    expect(mixed[0]?.name.startsWith("Возврат:")).toBe(false);
    expect(mixed[0]?.quantity).toBeCloseTo(7);
    expect(mixed[0]?.amount).toBeCloseTo(140);
    const prefixed = mergeEstimateLeaves([
      { id: "use", kind: "material", name: "Вода", unit: "м3", quantity: 10, amount: 200, rate: 20, incomplete: [] },
      { id: "back", kind: "material", name: "Возврат: Вода", unit: "м3", quantity: 3, amount: -60, rate: 20, incomplete: [] },
    ]);
    expect(prefixed).toHaveLength(1);
    expect(prefixed[0]?.name).toBe("Вода");
    expect(prefixed[0]?.quantity).toBeCloseTo(7);
    expect(prefixed[0]?.amount).toBeCloseTo(140);
    const credited = resolveResourceDimensions(
      { id: "lab", kind: "labor", name: "Возврат: Плотник", unit: "чел", quantity: 2, rate: 100, quantityBasis: "count_per_shift", hoursPerShift: 11, shiftsPerDay: 1, days: 1 },
      { id: "s", start: "2026-12-01", end: "2026-12-01" },
    );
    expect(credited.hours).toBe(22);
    expect(credited.amount).toBe(-2200);
    expect(credited.incomplete.join(" ")).not.toMatch(/hours_inputs/);
    expect(customerWorkRate("Бурение", [
      { id: "work", code: "ФЕР-1", name: "Бурение", unit: "м", quantity: 10, rate: 500, isWorkItem: true },
      { id: "pipe", code: "М-1", name: "Труба", unit: "м", quantity: 4, rate: 9000, sourceWorkName: "Бурение", resourceKind: "material" },
    ])).toBe(500);
    expect(customerWorkRate("Бурение", [
      { id: "pipe", code: "М-1", name: "Труба", unit: "м", quantity: 4, rate: 9000, sourceWorkName: "Бурение", resourceKind: "material" },
    ])).toBeNull();
    expect(datesForStage(0, 2, "2026-11-21", { start: "2026-12-01", end: "2026-12-20" }).start).toBe("2026-12-01");
    expect(datesForStage(0, 1, "2026-11-21", null)).toEqual({ start: "2026-11-21", end: "2026-11-21" });
  });
});

describe("analytical note shape", () => {
  it("opens with the verdict and five named blocks", () => {
    const note = composeAnalyticalNote({
      verdict: 6,
      verdictText: "нужна проверка сроков",
      blocks: ["паспорт", "условия", "объёмы", "себестоимость", "риски"],
    });
    expect(note.startsWith("Готовность к решению: данных недостаточно. нужна проверка сроков")).toBe(true);
    expect(note).not.toMatch(/Вердикт ИИ|\d \/ 10/);
    expect(analyticalNoteBlocks(note).map((block) => block.body)).toEqual(["паспорт", "условия", "объёмы", "себестоимость", "риски"]);
    expect(refreshRateAssumption("Ставки взяты только из точного совпадения кода и единицы в справочниках; цена заказчика не копировалась."))
      .toContain("по должности");
    expect(refreshRateAssumption("Ставки взяты только из точного совпадения кода и единицы в справочниках"))
      .not.toContain("точного совпадения кода");
    expect(formatDateRangeShort("2026-12-01", "2026-12-20")).toBe("01.12–20.12.2026");
    expect(visibleDayBounds(0, 34 * 20 - 1, 34, 20)?.last).toBe(19);
    const contractXml = execFileSync("unzip", ["-p", path.join(process.cwd(), "fixtures/docx/contract-terms.docx"), "word/document.xml"], { encoding: "utf8" });
    const contractText = contractXml.replace(/<[^>]+>/g, " ");
    expect(contractText).toMatch(/60 месяцев/);
    expect(calendarDurationDays(contractText)).toBe(90);
    expect(calendarDurationDays(contractText.replace(/Срок\s+выполнения:\s*90\s+календарных\s+дней/iu, ""))).toBeNull();
    const adopted = positionsFromStages([
      { id: "s", name: "Работа", start: "2026-12-01", end: "2026-12-02", sequence: 1, resources: [{ id: "r1", kind: "labor", name: "Кладовщик", unit: "чел.-ч", quantity: 10, rate: 881, quantityBasis: "total_hours" }] },
    ], [
      { id: "vor-1", code: "ВОР", name: "Кладовщик", unit: "чел.-ч", quantity: 10, rate: 881 },
    ], EXCEL_RESOURCE_SCHEDULE_DEFAULTS);
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ code: "ВОР", sourceResourceId: "r1", name: "Кладовщик" });
    const folded = positionsFromStages([
      { id: "s2", name: "Работа", start: "2026-12-01", end: "2026-12-02", sequence: 1, resources: [{ id: "r2", kind: "labor", name: "Съёмщик", unit: "чел.-ч", quantity: 10, rate: 100, quantityBasis: "total_hours" }] },
    ], [
      { id: "vor-yo", code: "ВОР", name: "Съемщик", unit: "чел.-ч", quantity: 10, rate: 100 },
      { id: "vor-yo-2", code: "ВОР", name: "Съемщик", unit: "чел.-ч", quantity: 10, rate: 100 },
    ], EXCEL_RESOURCE_SCHEDULE_DEFAULTS);
    expect(folded.filter((position) => position.sourceResourceId === "r2")).toHaveLength(1);
    expect(analyticalNoteStructure(note).blocks).toEqual([
      "Паспорт закупки и тайминг",
      "Условия участия и требования к заявке",
      "Сводная ведомость объёмов",
      "Расчёт себестоимости и экономика",
      "Риски и подводные камни",
    ]);
    expect(citationHref("doc-9", { page: 4, sheet: "Ресурсы", cell: "C12", paragraph: 3 }))
      .toContain("page=4");
    const totals = combineEstimateTotals([
      { label: "Смета 1", total: 10 },
      { label: "Смета 2", total: 20 },
      { label: "Смета 1", total: 10 },
    ]);
    expect(totals.total).toBe(30);
    expect(totals.duplicates).toEqual(["Смета 1"]);
  });
});
