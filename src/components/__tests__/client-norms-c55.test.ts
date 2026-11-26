import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SiteNormCards } from "@/components/client-norms-site-cards";
import { C55_CHRONOMETRY_SITE, siteShowsC55Warning } from "@/lib/client-norms";

const header = {
  daily: {
    orchMountedPerDay_fromTimeStudy: 4,
    supportsExtendedPerDay_fromTimeStudy: 4,
    extendingOneRigelHoursPerZveno: 2,
    pipeline: { note: "1 сварщик делает 3 стыка= 30 м" },
    project_0_68_resolution: {
      februaryPlanOrch: 678,
      currentOutputOrchPerDay: 16,
      planOrchPerDay: 23,
      shiftsMentioned: "2 дневные бригады и 1 ночная бригада",
    },
    project_88_127_resolution: {
      februaryPlanOrch: 386,
      currentOutputOrchPerDay: 13,
      planOrchPerDay: 13,
    },
  },
  typo118: { cell: "C55", valueInCell: 118, valueIfDividedBy60Hours: 1.9666666666666666 },
};

describe("C55 warning site", () => {
  it("attaches the 118-minute warning only to site 0-68", () => {
    expect(C55_CHRONOMETRY_SITE).toBe("0-68");
    expect(siteShowsC55Warning("0-68")).toBe(true);
    expect(siteShowsC55Warning("88-127")).toBe(false);

    const html = renderToStaticMarkup(React.createElement(SiteNormCards, { header }));
    const cards = html.split("<h2").slice(1);
    const card68 = cards.find((card) => card.includes("Шифр 0-68"));
    const card88 = cards.find((card) => card.includes("Шифр 88-127"));
    expect(card68).toContain('data-testid="client-norm-c55"');
    expect(card68).toContain("118");
    expect(card68).toContain("Хронометраж 0-68");
    expect(card88).toBeTruthy();
    expect(card88).not.toContain("client-norm-c55");
    expect(card88).not.toContain("C55");
    expect(card88).not.toContain(">118<");
  });
});
