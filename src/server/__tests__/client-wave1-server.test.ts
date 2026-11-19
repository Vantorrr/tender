import { beforeEach, describe, expect, it } from "vitest";
import { createSession } from "@/server/auth";
import { closeDb, ensureReady, mutateAppData, readAppData } from "@/server/db";
import {
  addCalcPositionFromDirectory,
  addMoneyPayment,
  deleteProcurement,
} from "@/server/repo";
import "./setup";

describe("client wave 1 server", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("adds equipment with a zero directory rate and marks the rate as missing", () => {
    mutateAppData((data) => {
      const park = data.directories.find((item) => item.type === "park" && item.current);
      if (!park) throw new Error("no park");
      park.rows.push({ code: "EQ-ZERO", name: "Буровая", unit: "маш.-ч", rate: 0 });
      return data;
    });
    const calc = readAppData().calculations.find((item) => item.kind === "resource_draft");
    expect(calc).toBeTruthy();
    addCalcPositionFromDirectory("u-smet", calc!.id, { type: "park", code: "EQ-ZERO", quantity: 1 });
    const added = readAppData().calculations.find((item) => item.id === calc!.id)!
      .positions.find((position) => position.code === "EQ-ZERO");
    expect(added?.rateMissing).toBe(true);
    expect(added?.rate).toBe(0);
  });

  it("stores a stage payment as a receipt", () => {
    const plan = readAppData().moneyPlans[0];
    addMoneyPayment("u-smet", plan.id, {
      type: "avans",
      title: "2 этап",
      amount: 300_000,
      date: "2026-12-01",
      week: 49,
      month: 12,
    });
    const saved = readAppData().moneyPlans.find((item) => item.id === plan.id)!
      .payments.find((payment) => payment.title === "2 этап");
    expect(saved?.type).toBe("postuplenie");
    expect(saved?.amount).toBe(300_000);
  });

  it("deletes a procurement only inside the caller's organization", () => {
    const before = readAppData();
    const own = before.procurements.find((item) => item.orgId === before.users.find((user) => user.id === "u-tender")!.orgId)!;
    deleteProcurement("u-tender", own.id);
    expect(readAppData().procurements.some((item) => item.id === own.id)).toBe(false);
    const other = before.procurements.find((item) => item.orgId !== before.users.find((user) => user.id === "u-tender")!.orgId);
    if (other) {
      expect(() => deleteProcurement("u-tender", other.id)).toThrow(/другой организации/);
      expect(readAppData().procurements.some((item) => item.id === other.id)).toBe(true);
    }
  });

  it("does not create a calculation when a document file is downloaded", async () => {
    mutateAppData((data) => {
      const procurement = data.procurements.find((item) => item.id === "p-2")!;
      procurement.calculationId = undefined;
      procurement.gprId = undefined;
      procurement.reviewStatus = "novaya";
      procurement.status = "zagruzheno";
      return data;
    });
    const document = readAppData().documents.find((item) => item.procurementId === "p-2");
    expect(document).toBeTruthy();
    const { GET } = await import("@/app/api/dokumenty/file/route");
    const response = await GET(new Request(`http://local/api/dokumenty/file?id=${document!.id}`, {
      headers: { authorization: `Bearer ${createSession("u-tender")}` },
    }));
    expect(response.status).toBe(200);
    const procurement = readAppData().procurements.find((item) => item.id === "p-2")!;
    expect(procurement.calculationId).toBeUndefined();
    expect(procurement.gprId).toBeUndefined();
    expect(procurement.reviewStatus).toBe("novaya");
    expect(procurement.status).toBe("zagruzheno");
  });
});
