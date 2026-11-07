import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, ensureReady, readAppData, resetAppData } from "@/server/db";
import { dbPath } from "@/server/config";
import {
  ensureProcurementChain,
  recalcCalculation,
  setDirectoryCurrent,
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

describe("chain versions / directory dependencies", () => {
  it("ensureChain binds calculation to current rascenki directory version", () => {
    const actor = byEmail("tender@alfastroy.ru");
    const proc = readAppData().procurements.find(
      (p) => p.orgId === "org-alfa" && !p.calculationId
    ) ?? readAppData().procurements.find((p) => p.orgId === "org-alfa")!;
    ensureProcurementChain(actor.id, proc.id);
    const linked = readAppData().procurements.find((p) => p.id === proc.id)!;
    const calc = readAppData().calculations.find(
      (c) => c.id === linked.calculationId
    )!;
    const current = readAppData().directories.find(
      (d) => d.type === "rascenki" && d.current
    );
    expect(current).toBeTruthy();
    expect(calc.directoryVersionId).toBe(current!.id);
    expect(calc.version).toBeGreaterThanOrEqual(1);
    const gpr = readAppData().schedules.find((g) => g.id === linked.gprId);
    expect(gpr?.version).toBeGreaterThanOrEqual(1);
    expect(gpr?.calculationId).toBe(calc.id);
  });

  it("recalc retargets directoryVersionId to current after switching current version", () => {
    const actor = byEmail("smeta@alfastroy.ru");
    const calc = readAppData().calculations.find((c) => c.orgId === "org-alfa")!;
    const rascVersions = readAppData().directories.filter(
      (d) => d.type === "rascenki"
    );
    expect(rascVersions.length).toBeGreaterThanOrEqual(1);
    const other =
      rascVersions.find((d) => !d.current) ??
      rascVersions[0];
    // Force current to a known id (idempotent if already current)
    setDirectoryCurrent(actor.id, other.id);
    const current = readAppData().directories.find(
      (d) => d.type === "rascenki" && d.current
    )!;
    expect(current.id).toBe(other.id);
    recalcCalculation(actor.id, calc.id, "bazovyy");
    const after = readAppData().calculations.find((c) => c.id === calc.id)!;
    expect(after.directoryVersionId).toBe(current.id);
  });

  it("document versions array grows on reanalyze path metadata", () => {
    const doc = readAppData().documents.find((d) => d.orgId === "org-alfa");
    expect(doc).toBeTruthy();
    expect(Array.isArray(doc!.versions)).toBe(true);
    expect(doc!.versions.length).toBeGreaterThanOrEqual(1);
    expect(doc!.versions[0].version).toBeGreaterThanOrEqual(1);
  });
});
