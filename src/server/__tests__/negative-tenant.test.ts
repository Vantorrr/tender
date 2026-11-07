import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, ensureReady, readAppData, resetAppData } from "@/server/db";
import { dbPath } from "@/server/config";
import { assertOrgAccess, assertSection } from "@/server/acl";
import {
  getBootstrap,
  updateCalculation,
  updateDocument,
} from "@/server/repo";
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
});
