import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, ensureReady, readAppData, resetAppData } from "@/server/db";
import { dbPath } from "@/server/config";
import {
  assertOrgAccess,
  ensureProcurementChain,
  getBootstrap,
  injectRiskParse,
  updateDocument,
} from "@/server/repo";
import { normalizeProcurementNumber, runProcurementSync } from "@/server/jobs";
import {
  MockProcurementSource,
  setProcurementSource,
  resetProcurementSource,
} from "@/server/procurement-source";
import type { User } from "@/lib/types";

beforeAll(() => {
  ensureReady();
  resetAppData();
});

afterAll(() => {
  resetProcurementSource();
  closeDb();
  const p = dbPath();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = `${p}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

function userByEmail(email: string): User {
  const u = readAppData().users.find((x) => x.email === email);
  if (!u) throw new Error(`no user ${email}`);
  return u;
}

describe("org isolation (negative tenant)", () => {
  it("bootstrap for beta does not include alfa procurement ids", () => {
    const alfa = getBootstrap(userByEmail("tender@alfastroy.ru"));
    const beta = getBootstrap(userByEmail("tender@betain.ru"));
    const alfaIds = new Set(alfa.data.procurements.map((p) => p.id));
    const betaIds = new Set(beta.data.procurements.map((p) => p.id));
    for (const id of betaIds) expect(alfaIds.has(id)).toBe(false);
    expect([...alfaIds].some((id) => id.startsWith("p-"))).toBe(true);
  });

  it("assertOrgAccess rejects direct foreign org id", () => {
    const beta = userByEmail("tender@betain.ru");
    expect(() => assertOrgAccess(beta, "org-alfa", "закупки")).toThrow(
      /другой организации/
    );
  });

  it("mutating alfa document as beta throws", () => {
    const beta = userByEmail("tender@betain.ru");
    const alfaDoc = readAppData().documents.find((d) => d.orgId === "org-alfa");
    expect(alfaDoc).toBeTruthy();
    expect(() =>
      updateDocument(beta.id, alfaDoc!.id, { title: "leak" })
    ).toThrow(/другой организации/);
  });

  it("ensureChain is org-scoped", () => {
    const beta = userByEmail("tender@betain.ru");
    const alfaProc = readAppData().procurements.find((p) => p.orgId === "org-alfa");
    expect(alfaProc).toBeTruthy();
    expect(() => ensureProcurementChain(beta.id, alfaProc!.id)).toThrow(
      /другой организации/
    );
  });
});

describe("procurement sync + dedup via adapter", () => {
  it("normalizes AUTO/DUP suffixes", () => {
    expect(normalizeProcurementNumber("123-AUTO")).toBe("123");
    expect(normalizeProcurementNumber("123-DUP")).toBe("123");
  });

  it("imports mock notices and marks duplicates", async () => {
    const actor = userByEmail("tender@alfastroy.ru");
    setProcurementSource(
      new MockProcurementSource([
        {
          number: "DUP-TEST-001-AUTO",
          title: "Первая",
          customer: "А",
          region: "Москва",
          nmck: 10,
          deadline: new Date().toISOString(),
          source: "mock",
        },
        {
          number: "DUP-TEST-001",
          title: "Дубль",
          customer: "А",
          region: "Москва",
          nmck: 10,
          deadline: new Date().toISOString(),
          source: "mock",
        },
      ])
    );
    const result = await runProcurementSync(actor.id);
    expect(result.jobId).toMatch(/^job-sync-/);
    const orgProcs = result.data.procurements.filter(
      (p) => p.orgId === actor.orgId
    );
    const dups = orgProcs.filter((p) => p.number.includes("DUP-TEST-001"));
    expect(dups.length).toBeGreaterThanOrEqual(1);
    expect(orgProcs.some((p) => p.reviewStatus === "dublirovana")).toBe(true);
  });
});

describe("contract risk inject", () => {
  it("parses provided contract text into remarks", () => {
    const actor = userByEmail("tender@alfastroy.ru");
    const risk = readAppData().risks.find((r) => r.orgId === actor.orgId);
    expect(risk).toBeTruthy();
    const before = risk!.remarks.length;
    injectRiskParse(
      actor.id,
      risk!.id,
      "Обеспечение исполнения контракта 5%. Штраф за срыв сроков 0,2% в сутки."
    );
    const after = readAppData().risks.find((r) => r.id === risk!.id)!;
    expect(after.contractParsed).toBe(true);
    expect(after.remarks.length).toBeGreaterThan(before);
  });
});

describe("backup helpers path", () => {
  it("isolated db path uses test file under data/", () => {
    const p = dbPath();
    expect(p.includes(`${path.sep}data${path.sep}`)).toBe(true);
    expect(path.basename(p).startsWith("test-tma361-")).toBe(true);
  });
});
