import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDb,
  ensureReady,
  mutateAppData,
  readAppData,
  resetAppData,
} from "@/server/db";
import { dbPath } from "@/server/config";
import { assertOrgAccess, assertSection } from "@/server/acl";
import {
  attachCustomerEstimate,
  getBootstrap,
  updateCalculation,
  updateDocument,
  updateProcurement,
} from "@/server/repo";
import { runReanalyzePipeline } from "@/server/jobs";
import { saveUpload } from "@/server/uploads";
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

describe("negative tenant / id / file / export ACL", () => {
  it("direct foreign orgId is forbidden", () => {
    const beta = byEmail("tender@betain.ru");
    expect(() => assertOrgAccess(beta, "org-alfa", "закупки")).toThrow(
      /другой организации/
    );
  });

  it("beta cannot patch alfa calculation by id", () => {
    const beta = byEmail("tender@betain.ru");
    const alfaCalc = readAppData().calculations.find((c) => c.orgId === "org-alfa");
    expect(alfaCalc).toBeTruthy();
    expect(() =>
      updateCalculation(beta.id, alfaCalc!.id, { title: "leak" })
    ).toThrow(/другой организации/);
  });

  it("beta bootstrap export candidates never include alfa calc ids", () => {
    const beta = getBootstrap(byEmail("tender@betain.ru"));
    const alfa = getBootstrap(byEmail("tender@alfastroy.ru"));
    const alfaCalcIds = new Set(alfa.data.calculations.map((c) => c.id));
    for (const c of beta.data.calculations) {
      expect(alfaCalcIds.has(c.id)).toBe(false);
    }
    for (const d of beta.data.documents) {
      expect(d.orgId).toBe("org-beta");
    }
  });

  it("smetchik section matrix blocks zakupki assert", () => {
    const smeta = byEmail("smeta@alfastroy.ru");
    expect(() => assertSection(smeta, "zakupki")).toThrow(/Недостаточно прав/);
    expect(() => assertSection(smeta, "raschety")).not.toThrow();
  });

  it("uploaded file path stays under data/uploads for isolated DB", async () => {
    const stored = await saveUpload(
      "d-neg-test",
      "note.txt",
      Buffer.from("isolated upload")
    );
    expect(stored.storedPath.startsWith(`uploads${path.sep}`) || stored.storedPath.startsWith("uploads/")).toBe(
      true
    );
    const absolute = path.join(process.cwd(), "data", stored.storedPath);
    expect(fs.existsSync(absolute)).toBe(true);
  });

  it("document update still org-scoped after upload metadata", () => {
    const beta = byEmail("tender@betain.ru");
    const alfaDoc = readAppData().documents.find((d) => d.orgId === "org-alfa");
    expect(alfaDoc).toBeTruthy();
    expect(() =>
      updateDocument(beta.id, alfaDoc!.id, { title: "nope" })
    ).toThrow(/другой организации/);
  });

  it("beta reanalyze of alfa doc fails ACL before analyze/useLlm", async () => {
    const beta = byEmail("tender@betain.ru");
    const alfaDoc = readAppData().documents.find((d) => d.orgId === "org-alfa");
    expect(alfaDoc).toBeTruthy();
    await expect(
      runReanalyzePipeline(beta.id, alfaDoc!.id, { useLlm: true })
    ).rejects.toThrow(/другой организации/);
  });

  it("updateProcurement strips foreign originalCalculationId; attach cannot overwrite other tenant original", () => {
    const beta = byEmail("tender@betain.ru");
    const data = readAppData();
    const betaProc = data.procurements.find((p) => p.orgId === "org-beta");
    expect(betaProc).toBeTruthy();

    let alfaOriginal = data.calculations.find(
      (c) => c.orgId === "org-alfa" && c.kind === "customer_original"
    );
    if (!alfaOriginal) {
      const now = new Date().toISOString();
      const alfaProcId = data.procurements.find((p) => p.orgId === "org-alfa")!.id;
      const created = {
        id: `c-alfa-orig-neg-${Date.now()}`,
        orgId: "org-alfa" as const,
        procurementId: alfaProcId,
        title: "Alfa victim original",
        status: "gotovo" as const,
        positions: [
          {
            id: "alfa-vic-1",
            code: "A1",
            name: "Victim row",
            unit: "м2",
            quantity: 10,
            rate: 500,
          },
        ],
        assumptions: ["victim"],
        scenario: "bazovyy" as const,
        scenarioFactor: 1,
        participateDecision: null,
        directoryVersionId: "dir-rascenki-1",
        version: 1,
        authorId: "u-alfa",
        updatedAt: now,
        kind: "customer_original" as const,
        immutable: true,
        changeLog: [],
        dataFlags: ["immutable_original"],
      };
      mutateAppData((live) => {
        live.calculations.unshift(created);
        return live;
      });
      alfaOriginal = created;
    }
    const victimId = alfaOriginal.id;
    const victimSnapshot = JSON.stringify(alfaOriginal.positions);

    updateProcurement(beta.id, betaProc!.id, {
      originalCalculationId: victimId,
      title: betaProc!.title,
    });
    const afterPatch = readAppData().procurements.find((p) => p.id === betaProc!.id)!;
    expect(afterPatch.originalCalculationId).not.toBe(victimId);

    // Even if the pointer were poisoned in storage, attach must not write across tenants.
    mutateAppData((live) => {
      const poisoned = live.procurements.find((p) => p.id === betaProc!.id)!;
      poisoned.originalCalculationId = victimId;
      live.documents.unshift({
        id: `d-neg-est-${Date.now()}`,
        orgId: "org-beta",
        procurementId: betaProc!.id,
        title: "Смета beta",
        fileName: "smeta-beta.xlsx",
        fileType: "xlsx",
        category: "estimate",
        status: "gotovo",
        versions: [],
        analyticalNote: "",
        citations: [],
        highlights: [],
        uploadedBy: beta.id,
        uploadedAt: new Date().toISOString(),
        storedPath: "uploads/neg-smeta.xlsx",
        estimatePositions: [
          {
            id: "neg-pos-1",
            code: "NEG-1",
            name: "Позиция beta",
            unit: "м2",
            quantity: 3,
            rate: 100,
          },
        ],
        analysis: { positionCount: 1, costThousand: 0.3, workName: "beta" },
      } as (typeof live.documents)[number]);
      return live;
    });

    attachCustomerEstimate(beta.id, betaProc!.id, { fileName: "smeta-beta.xlsx" });
    const alfaAfter = readAppData().calculations.find((c) => c.id === victimId)!;
    expect(JSON.stringify(alfaAfter.positions)).toBe(victimSnapshot);
    expect(alfaAfter.orgId).toBe("org-alfa");
  });
});
