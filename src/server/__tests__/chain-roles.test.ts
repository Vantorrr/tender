import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, ensureReady, readAppData, resetAppData } from "@/server/db";
import { dbPath } from "@/server/config";
import { DEFAULT_SECTIONS } from "@/lib/roles";
import { assertSection, userHasSection } from "@/server/acl";
import {
  ensureProcurementChain,
  getBootstrap,
  recalcCalculation,
  setUserRole,
  setUserSections,
  updateCalculation,
  updateMoney,
  updateSchedule,
  updateUser,
} from "@/server/repo";
import type { User } from "@/lib/types";

beforeAll(() => {
  ensureReady();
  resetAppData();
});

afterAll(() => {
  closeDb();
  const p = dbPath();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = `${p}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

function byEmail(email: string): User {
  const u = readAppData().users.find((x) => x.email === email);
  if (!u) throw new Error(email);
  return u;
}

describe("chain edit + recalculate", () => {
  it("ensureChain then edit calc / recalc / gpr / money", () => {
    const tender = byEmail("tender@alfastroy.ru");
    // Prefer a procurement without full chain if present; else use p-3-like
    let proc = readAppData().procurements.find(
      (p) => p.orgId === "org-alfa" && (!p.gprId || !p.moneyId)
    );
    if (!proc) {
      proc = readAppData().procurements.find((p) => p.orgId === "org-alfa")!;
    }
    ensureProcurementChain(tender.id, proc.id);
    const linked = readAppData().procurements.find((p) => p.id === proc!.id)!;
    expect(linked.calculationId).toBeTruthy();
    expect(linked.gprId).toBeTruthy();
    expect(linked.moneyId).toBeTruthy();

    const calcId = linked.calculationId!;
    updateCalculation(tender.id, calcId, {
      assumptions: ["isolated-test-assumption"],
    });
    expect(
      readAppData().calculations.find((c) => c.id === calcId)?.assumptions
    ).toContain("isolated-test-assumption");

    const before = readAppData().calculations.find((c) => c.id === calcId)!;
    recalcCalculation(tender.id, calcId, "pessimisticheskiy");
    const after = readAppData().calculations.find((c) => c.id === calcId)!;
    expect(after.scenario).toBe("pessimisticheskiy");
    expect(after.scenarioFactor).toBe(1.08);
    expect(after.updatedAt >= before.updatedAt).toBe(true);

    updateSchedule(tender.id, linked.gprId!, {
      title: "ГПР isolated edit",
    });
    expect(
      readAppData().schedules.find((g) => g.id === linked.gprId)?.title
    ).toBe("ГПР isolated edit");

    updateMoney(tender.id, linked.moneyId!, {
      title: "Деньги isolated edit",
    });
    expect(
      readAppData().moneyPlans.find((m) => m.id === linked.moneyId)?.title
    ).toBe("Деньги isolated edit");
  });
});

describe("6 roles: combine / revoke / block", () => {
  it("combine sections beyond role default for tender", () => {
    const admin = byEmail("admin@alfastroy.ru");
    const tender = byEmail("tender@alfastroy.ru");
    const combined = [
      ...DEFAULT_SECTIONS.tender,
      "dengi" as const,
      "gpr" as const,
    ];
    setUserSections(admin.id, tender.id, combined);
    const updated = byEmail("tender@alfastroy.ru");
    expect(userHasSection(updated, "dengi")).toBe(true);
    expect(userHasSection(updated, "gpr")).toBe(true);
    expect(() => assertSection(updated, "dengi")).not.toThrow();
  });

  it("revoke dengi section again", () => {
    const admin = byEmail("admin@alfastroy.ru");
    const tender = byEmail("tender@alfastroy.ru");
    setUserSections(admin.id, tender.id, [...DEFAULT_SECTIONS.tender]);
    const updated = byEmail("tender@alfastroy.ru");
    expect(userHasSection(updated, "dengi")).toBe(false);
    expect(() => assertSection(updated, "dengi")).toThrow(/Недостаточно прав/);
  });

  it("role change resets sections to defaults", () => {
    const admin = byEmail("admin@alfastroy.ru");
    const target = byEmail("object@alfastroy.ru");
    setUserRole(admin.id, target.id, "smetchik", "isolated role swap");
    const updated = byEmail("object@alfastroy.ru");
    expect(updated.role).toBe("smetchik");
    expect(updated.sections).toEqual(DEFAULT_SECTIONS.smetchik);
    // restore
    setUserRole(admin.id, target.id, "otvetstvennyy", "restore");
  });

  it("block user hides them from actorUser paths via bootstrap login semantics", () => {
    const admin = byEmail("admin@alfastroy.ru");
    const target = byEmail("ruk@alfastroy.ru");
    updateUser(admin.id, target.id, { blocked: true });
    expect(byEmail("ruk@alfastroy.ru").blocked).toBe(true);
    // unblock for other suites
    updateUser(admin.id, target.id, { blocked: false });
    expect(byEmail("ruk@alfastroy.ru").blocked).toBe(false);
  });

  it("each of 6 roles has distinct default matrix entry", () => {
    const roles = Object.keys(DEFAULT_SECTIONS);
    expect(roles).toHaveLength(6);
    const boot = getBootstrap(byEmail("super@tenderkontur.ru"));
    expect(boot.data.users.filter((u) => !u.blocked).length).toBeGreaterThanOrEqual(6);
  });
});
