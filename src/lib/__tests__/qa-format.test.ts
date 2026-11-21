import { describe, expect, it } from "vitest";
import { canOpenCabinetPath } from "@/components/cabinet/nav";
import {
  formatNumber,
  formatQuantity,
  needByPhrase,
  plainPositionName,
  positionHeading,
  roundQuantity,
  splitSignedQuantity,
} from "@/lib/format";
import { DEFAULT_SECTIONS } from "@/lib/roles";
import type { User } from "@/lib/types";
import { northernEconomicsApplied, northernStatusText } from "@/lib/wave23";

const tender = {
  role: "tender",
  sections: DEFAULT_SECTIONS.tender,
} as User;

describe("quantity formatting", () => {
  it("rounds binary float noise to a Russian decimal", () => {
    expect(roundQuantity(33.910799999999995)).toBe(33.91);
    expect(formatNumber(33.910799999999995)).toBe("33,91");
    expect(formatQuantity(33.910799999999995, "шт")).toBe("33,91 шт");
    expect(formatNumber(16.5396)).toBe("16,54");
    expect(formatQuantity(-164.68, "м3")).toBe("-164,68 м3");
  });

  it("does not glue a missing deadline to the preposition к", () => {
    expect(needByPhrase("")).toBe("срок не указан");
    expect(needByPhrase(null)).toBe("срок не указан");
    expect(needByPhrase("2026-12-01")).toBe("к 01.12.2026");
    expect(needByPhrase("")).not.toMatch(/^к /);
  });

  it("spells labour abbreviations and keeps a return as an absolute quantity plus a difference", () => {
    expect(plainPositionName("ЗТ")).toBe("Затраты труда");
    expect(plainPositionName("ЗТм")).toBe("Затраты труда машинистов");
    expect(positionHeading("ЗТ", "ЗТ")).toBe("Затраты труда");
    expect(positionHeading("ЗТм", "Машинисты")).toBe("Затраты труда машинистов · Машинисты");
    const cable = splitSignedQuantity(-7.16);
    expect(cable.quantity).toBe(7.16);
    expect(cable.difference).toBe(-7.16);
    expect(formatQuantity(cable.quantity, "м")).toBe("7,16 м");
    expect(formatNumber(cable.difference ?? 0)).toBe(formatNumber(-7.16));
  });
});

describe("northern wording and closed sections", () => {
  it("describes the coefficient that is actually folded into the total", () => {
    expect(northernEconomicsApplied({ districtCoefficient: 1.8 })).toBe(true);
    expect(northernStatusText({ districtCoefficient: 1.8, northernPayrollShare: 0.8 })).toMatch(/коэффициент 1,8/);
    expect(northernStatusText({ districtCoefficient: 1.8, northernPayrollShare: 0.8 })).toMatch(/80%/);
    expect(northernStatusText({ districtCoefficient: 1.8, northernPayrollShare: 0.8 })).not.toMatch(/не применяются/);
    expect(northernEconomicsApplied({ applicable: false, districtCoefficient: 1.8 })).toBe(false);
    expect(northernStatusText({ applicable: false, districtCoefficient: 1.8 })).toBe("Северные затраты не применяются.");
  });

  it("does not offer a tender specialist a link into ГПР or production", () => {
    expect(canOpenCabinetPath(tender, "/cabinet/gpr/g-1")).toBe(false);
    expect(canOpenCabinetPath(tender, "/cabinet/proizvodstvo?planFactId=p-1")).toBe(false);
    expect(canOpenCabinetPath(tender, "/cabinet/raschety/c-1")).toBe(true);
    expect(canOpenCabinetPath(tender, "/cabinet/zakupki/z-1")).toBe(true);
  });
});
