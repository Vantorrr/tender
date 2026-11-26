import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { scheduleParamsWithNorthernDefaults } from "@/lib/wave23";
import type { CalcPosition } from "@/lib/types";
import { closeDb, ensureReady, readAppData } from "@/server/db";
import { parseGrandBuffer } from "@/server/grand-smeta";
import {
  createManualProcurement,
  createProcurementSchedule,
  recalcCalculation,
  sendProcurementToCalculation,
  updateCalculation,
} from "@/server/repo";
import { acceptVolumeDraft } from "@/server/volume-sheet";
import "./setup";

async function bureniePositions(): Promise<CalcPosition[]> {
  const parsed = await parseGrandBuffer(fs.readFileSync(path.join(process.cwd(), "fixtures/grand-smeta/ls-02-02-01-burenie.xlsx")));
  return (parsed?.positions ?? []).map((position, index) => ({
    id: `row-${index + 1}`,
    code: position.code,
    name: position.name,
    unit: position.unit,
    quantity: position.quantity,
    rate: 0,
    rateMissing: !position.isWorkItem,
    ...(position.isWorkItem ? { isWorkItem: true } : {}),
    ...(position.resourceKind ? { resourceKind: position.resourceKind } : {}),
    ...(position.sectionName ? { sourceSectionName: position.sectionName } : {}),
    ...(position.workName ? { sourceWorkName: position.workName } : {}),
  }));
}

const VOLUME = [{ work: "Кладовщик", unit: "чел.-ч", volume: 10, quote: "Кладовщик 10 чел.-ч", rate: null }];

describe("burenie volume after the schedule", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("keeps the isolated line count and price when volumes are accepted after the schedule", async () => {
    const positions = await bureniePositions();
    expect(positions).toHaveLength(24);
    const params = scheduleParamsWithNorthernDefaults();

    const isolated = createManualProcurement("u-ruk", { title: "Изолированная ВОР", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", isolated.id);
    const isolatedDraft = readAppData().calculations.find((item) => item.procurementId === isolated.id && item.kind === "resource_draft")!;
    updateCalculation("u-ruk", isolatedDraft.id, { positions, resourceScheduleParams: params });
    recalcCalculation("u-ruk", isolatedDraft.id, "bazovyy");
    acceptVolumeDraft("u-ruk", isolatedDraft.id, VOLUME);
    const alone = readAppData().calculations.find((item) => item.id === isolatedDraft.id)!;

    const packed = createManualProcurement("u-ruk", { title: "ГПР затем ВОР", region: "Ямал" });
    sendProcurementToCalculation("u-ruk", packed.id);
    const draft = readAppData().calculations.find((item) => item.procurementId === packed.id && item.kind === "resource_draft")!;
    updateCalculation("u-ruk", draft.id, { positions: positions.map((position) => ({ ...position })), resourceScheduleParams: params });
    recalcCalculation("u-ruk", draft.id, "bazovyy");
    createProcurementSchedule("u-ruk", packed.id);
    acceptVolumeDraft("u-ruk", draft.id, VOLUME);
    recalcCalculation("u-ruk", draft.id, "bazovyy");
    acceptVolumeDraft("u-ruk", draft.id, VOLUME);
    recalcCalculation("u-ruk", draft.id, "bazovyy");
    const after = readAppData().calculations.find((item) => item.id === draft.id)!;

    expect(alone.positions).toHaveLength(25);
    expect(after.positions).toHaveLength(alone.positions.length);
    expect(after.positions.filter((position) => position.name === "Кладовщик")).toEqual([
      expect.objectContaining({ quantity: 10, rate: 881 }),
    ]);
    expect(after.costSummary?.C0).toBeCloseTo(280972515.48, 2);
    expect(after.costSummary?.reserve).toBeCloseTo((after.costSummary?.C0 ?? 0) * 0.1, 2);
    expect(after.costSummary?.priceExVat).toBeCloseTo((after.costSummary?.C0 ?? 0) * 1.5, 2);
    expect(after.costSummary?.priceExVat).not.toBeCloseTo((after.costSummary?.C0 ?? 0) * 1.54, 0);
    expect(after.costSummary?.C0).toBeCloseTo(alone.costSummary?.C0 ?? 0, 2);
    expect(after.costSummary?.priceExVat).toBeCloseTo(alone.costSummary?.priceExVat ?? 0, 2);
  });
});
