import { describe, expect, it } from "vitest";
import { supplyCalendarWarnings } from "@/lib/calendar-availability";
import { clientDirectoryVersions, matchCompanyDirectoryRate } from "@/lib/client-dirs";
import { calendarDurationDays, datesForStage, periodFromDocumentText, signedQuantityBySection } from "@/lib/estimate-stages";
import { sameRoundedQuantity } from "@/lib/format";
import { humanizeIssue } from "@/lib/issue-text";
import { mergeEstimateLeaves, mergeStageResources } from "@/lib/resource-merge";
import { resolveResourceDimensions } from "@/lib/resource-dimensions";
import { analyticalNoteStructure, citationHref, combineEstimateTotals, composeAnalyticalNote } from "@/lib/wave23";
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
    expect(calendarDurationDays("Договор: 90 календарных дней.")).toBe(90);
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
    const credited = resolveResourceDimensions(
      { id: "lab", kind: "labor", name: "Возврат: Плотник", unit: "чел", quantity: 2, rate: 100, quantityBasis: "count_per_shift", hoursPerShift: 11, shiftsPerDay: 1, days: 1 },
      { id: "s", start: "2026-12-01", end: "2026-12-01" },
    );
    expect(credited.hours).toBe(22);
    expect(credited.amount).toBe(-2200);
    expect(credited.incomplete.join(" ")).not.toMatch(/hours_inputs/);
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
    expect(note.startsWith("Вердикт ИИ: 6 / 10 — нужна проверка сроков")).toBe(true);
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
