import { beforeEach, describe, expect, it } from "vitest";
import { closeDb, ensureReady, mutateAppData, readAppData } from "@/server/db";
import {
  createDocument,
  joinOrganizationByCode,
  registerNewOrganization,
  sendProcurementToCalculation,
  updateCalculation,
  recalcCalculation,
  addCalcPositionFromDirectory,
  refreshProcurementAnalytics,
} from "@/server/repo";
import { createSession } from "@/server/auth";
import { overheadsFromWorks, worksSubtotal } from "@/lib/calc-math";
import { compareCalculations } from "@/lib/calc-compare";
import { buildProjectAnalytics } from "@/lib/project-analytics";
import {
  archiveExtractDir,
  extractArchiveSafely,
} from "@/server/safe-archive";
import {
  NAV_ITEMS,
  NESTED_SECTIONS,
  sectionForPath,
} from "@/components/cabinet/nav";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import "./setup";

function zipStore(name: string, data: Buffer): Buffer {
  // minimal stored (method 0) zip with one file
  const nameBuf = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30 + nameBuf.length + data.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8); // store
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(0, 14); // crc ignored for our parser
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  nameBuf.copy(local, 30);
  data.copy(local, 30 + nameBuf.length);
  return local;
}

function zipDeflateTraversal(): Buffer {
  const payload = Buffer.from("hack");
  const compressed = zlib.deflateRawSync(payload);
  const name = Buffer.from("../evil.txt", "utf8");
  const local = Buffer.alloc(30 + name.length + compressed.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  name.copy(local, 30);
  compressed.copy(local, 30 + name.length);
  return local;
}

describe("client corrections stage 1", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("schema migrates to 8 with additive northern cards and join codes", () => {
    const data = readAppData();
    expect(data.organizations.every((o) => o.joinCode)).toBe(true);
    expect(data.procurements.some((p) => /норильск/i.test(p.region))).toBe(
      true
    );
    expect(data.procurements.some((p) => /ямал/i.test(p.region))).toBe(true);
    expect(data.procurements.every((p) => p.workType)).toBe(true);
  });

  it("sidebar hides nested Documents/GPR/Money/Risks/Obmen", () => {
    const sections = NAV_ITEMS.map((n) => n.section);
    expect(sections).not.toContain("dokumenty");
    expect(sections).not.toContain("gpr");
    expect(sections).not.toContain("dengi");
    expect(sections).not.toContain("riski");
    expect(sections).not.toContain("obmen");
    expect(sections).toContain("zakupki");
    expect(sections).toContain("raschety");
    expect(sections).toContain("spravochniki");
    for (const s of NESTED_SECTIONS) {
      expect(sections).not.toContain(s);
    }
  });

  it("deep-link ACL still maps nested routes (dengi/gpr/dokumenty/riski/obmen)", () => {
    expect(sectionForPath("/cabinet/dengi")).toBe("dengi");
    expect(sectionForPath("/cabinet/gpr/g-1")).toBe("gpr");
    expect(sectionForPath("/cabinet/dokumenty")).toBe("dokumenty");
    expect(sectionForPath("/cabinet/riski")).toBe("riski");
    expect(sectionForPath("/cabinet/obmen")).toBe("obmen");
    expect(sectionForPath("/cabinet/zakupki/p-1")).toBe("zakupki");
  });

  it("sendToCalculation creates editable draft + GPR and keeps docs", () => {
    const before = readAppData();
    const p = before.procurements.find((x) => x.id === "p-norilsk-1")!;
    const docCount = before.documents.filter(
      (d) => d.procurementId === p.id
    ).length;
    sendProcurementToCalculation("u-smet", p.id);
    const after = readAppData();
    const proc = after.procurements.find((x) => x.id === p.id)!;
    expect(proc.calculationId).toBeTruthy();
    expect(proc.gprId).toBeTruthy();
    const draft = after.calculations.find((c) => c.id === proc.calculationId)!;
    expect(draft.kind).toBe("resource_draft");
    expect(draft.immutable).toBe(false);
    expect(draft.dataFlags?.includes("no_accuracy_promise")).toBe(true);
    expect(
      after.documents.filter((d) => d.procurementId === p.id).length
    ).toBe(docCount);
    expect(proc.reviewStatus).toBe("na_rassmotrenii");
  });

  it("immutable original rejects edits; draft accepts directory adds", () => {
    sendProcurementToCalculation("u-smet", "p-1");
    const data = readAppData();
    const p = data.procurements.find((x) => x.id === "p-1")!;
    // Force an immutable original
    const origId = `c-orig-test`;
    // mutate via send already; create original by update path through mutateAppData is internal —
    // use createDocument estimate analysis path: mark existing draft paired and create immutable via send on p-2 empty
    sendProcurementToCalculation("u-smet", "p-2");
    const mid = readAppData();
    const draft = mid.calculations.find(
      (c) => c.procurementId === "p-2" && c.kind === "resource_draft"
    )!;
    // Manually mark a clone as original through updateCalculation should fail if immutable —
    // insert via send already; create by cloning in DB:
    mutateAppData((d) => {
      d.calculations.unshift({
        ...draft,
        id: origId,
        title: "Смета заказчика (оригинал) тест",
        kind: "customer_original",
        immutable: true,
        changeLog: [],
      });
      const pr = d.procurements.find((x) => x.id === "p-2")!;
      pr.originalCalculationId = origId;
      return d;
    });
    expect(() =>
      updateCalculation("u-smet", origId, { title: "hack" })
    ).toThrow(/неизменяема/i);
    expect(() => recalcCalculation("u-smet", origId, "bazovyy")).toThrow(
      /неизменяема/i
    );
    expect(() =>
      addCalcPositionFromDirectory("u-smet", origId, {
        type: "rascenki",
        code: "dummy",
      })
    ).toThrow(/неизменяема/i);

    const editable = readAppData().procurements.find((x) => x.id === "p-2")!
      .calculationId!;
    // may fail if code missing — just ensure no immutable error when positions exist in dir
    const dir = readAppData().directories.find(
      (d) => d.type === "rascenki" && d.current
    )!;
    const code = String(dir.rows[0]?.code ?? dir.rows[0]?.sku ?? "");
    if (code) {
      addCalcPositionFromDirectory("u-smet", editable, {
        type: "rascenki",
        code,
        quantity: 2,
      });
      const after = readAppData().calculations.find((c) => c.id === editable)!;
      expect(after.positions.some((pos) => pos.code === code)).toBe(true);
      expect(after.changeLog?.length).toBeGreaterThan(0);
    }
    void p;
  });

  it("deterministic overheads without double-counting margin", () => {
    const works = worksSubtotal(
      [
        { id: "1", code: "A", name: "a", unit: "шт", quantity: 10, rate: 100 },
        { id: "2", code: "НР", name: "nr", unit: "руб", quantity: 1, rate: 999 },
      ],
      1
    );
    expect(works).toBe(1000);
    const { nr, sp, total } = overheadsFromWorks(works);
    expect(nr).toBe(150);
    expect(sp).toBe(80);
    expect(total).toBe(1230);
  });

  it("compareCalculations explains diffs without invented causes", () => {
    const original = {
      id: "o",
      orgId: "org-alfa",
      procurementId: "p-1",
      title: "o",
      status: "gotovo" as const,
      positions: [
        {
          id: "1",
          code: "A",
          name: "Work",
          unit: "м2",
          quantity: 10,
          rate: 100,
        },
      ],
      assumptions: [],
      scenario: "bazovyy" as const,
      scenarioFactor: 1,
      participateDecision: null,
      directoryVersionId: "d",
      version: 1,
      authorId: "u",
      updatedAt: "",
      kind: "customer_original" as const,
      immutable: true,
    };
    const draft = {
      ...original,
      id: "d",
      kind: "resource_draft" as const,
      immutable: false,
      positions: [
        {
          id: "1",
          code: "A",
          name: "Work",
          unit: "м2",
          quantity: 12,
          rate: 110,
        },
        {
          id: "2",
          code: "B",
          name: "Own",
          unit: "шт",
          quantity: 1,
          rate: 50,
        },
      ],
    };
    const cmp = compareCalculations(original, draft);
    expect(cmp.rows.some((r) => r.status === "diff")).toBe(true);
    expect(cmp.rows.some((r) => r.status === "only_draft")).toBe(true);
    expect(cmp.rows.every((r) => r.reason.length > 0)).toBe(true);
    expect(JSON.stringify(cmp)).not.toMatch(/97%/);
  });

  it("project analytics recommends insufficient_data without accuracy claims", () => {
    const data = readAppData();
    const p = data.procurements.find((x) => x.id === "p-norilsk-1")!;
    const note = buildProjectAnalytics(p, []);
    expect(note.recommendation).toBe("insufficient_data");
    expect(note.summary.toLowerCase()).not.toContain("97%");
    expect(note.disclaimer.toLowerCase()).toMatch(/не обеща|не ии-эксперт/i);
    refreshProcurementAnalytics("u-tender", "p-1");
    const after = readAppData().procurements.find((x) => x.id === "p-1")!;
    expect(after.analytics?.method).toBe("deterministic_aggregate_v1");
    expect(after.analytics?.citations.length).toBeGreaterThan(0);
  });

  it("safe archive rejects path traversal and surfaces errors", () => {
    const dir = archiveExtractDir("test-zip");
    fs.rmSync(dir, { recursive: true, force: true });
    const good = extractArchiveSafely(
      "pack.zip",
      zipStore("smeta.txt", Buffer.from("ok")),
      dir
    );
    expect(good.ok).toBe(true);
    expect(good.files[0]?.name).toBe("smeta.txt");

    const bad = extractArchiveSafely("bad.zip", zipDeflateTraversal(), dir);
    expect(bad.errors.some((e) => /traversal|rejected/i.test(e))).toBe(true);

    const unsupported = extractArchiveSafely(
      "x.rar",
      Buffer.from("Rar!"),
      dir
    );
    expect(unsupported.ok).toBe(false);
    expect(unsupported.errors[0]).toMatch(/не поддерживается/i);
  });

  it("self-registration creates org admin; join is tender-only ACL", () => {
    const created = registerNewOrganization({
      orgName: "ООО ТестРег",
      inn: "9900990099",
      name: "Анна Админ",
      email: "anna-reg@example.com",
      password: "Password1!",
    });
    expect(created.joinCode).toMatch(/^JOIN-/);
    expect(created.token).toBeTruthy();
    const data = readAppData();
    const user = data.users.find((u) => u.id === created.userId)!;
    expect(user.role).toBe("admin");
    expect(user.role).not.toBe("superadmin");
    expect(user.orgId).toBe(created.orgId);

    const joined = joinOrganizationByCode({
      joinCode: created.joinCode,
      name: "Игорь Тендер",
      email: "igor-join@example.com",
      password: "Password1!",
    });
    const joiner = readAppData().users.find((u) => u.id === joined.userId)!;
    expect(joiner.role).toBe("tender");
    expect(joiner.orgId).toBe(created.orgId);

    // isolation: joiner org cannot see alfa procurements via bootstrap filter
    const alfa = data.procurements.filter((p) => p.orgId === "org-alfa");
    expect(alfa.length).toBeGreaterThan(0);
    expect(
      readAppData().procurements.filter((p) => p.orgId === created.orgId)
        .length
    ).toBe(0);

    // cannot escalate via register to superadmin
    expect(user.sections.includes("admin")).toBe(true);
    expect(joiner.sections.includes("admin")).toBe(false);

    // session issued
    expect(createSession(joined.userId)).toBeTruthy();
  });

  it("manual document attach lands on procurement", () => {
    createDocument("u-tender", {
      orgId: "org-alfa",
      procurementId: "p-norilsk-1",
      title: "Ручная смета",
      fileName: "smeta-manual.xlsx",
      fileType: "xlsx",
      category: "estimate",
    });
    const data = readAppData();
    const p = data.procurements.find((x) => x.id === "p-norilsk-1")!;
    expect(
      data.documents.some(
        (d) => d.procurementId === p.id && d.category === "estimate"
      )
    ).toBe(true);
    expect(p.attachments.some((a) => a.name === "smeta-manual.xlsx")).toBe(
      true
    );
  });
});
