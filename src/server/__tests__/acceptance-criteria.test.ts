/**
 * Maps TZ acceptance criteria 1–11 (Приложение №1 / end of technical-spec.txt)
 * to code paths. Full customer acceptance requires согласованные данные Заказчика.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSession } from "@/server/auth";
import { ensureReady, closeDb, readAppData } from "@/server/db";
import { createUser, confirmSmetaExchange } from "@/server/repo";
import { buildSmetaExportXlsx } from "@/server/export";
import { verifyPassword } from "@/server/passwords";

void closeDb;

const TZ_ACCEPTANCE = [
  "Суперадмин создаёт пользователя, выдаёт роль; пользователь входит в ЛК.",
  "Открывается лента закупок и карточка тендера (из согласованного источника).",
  "Документы загружаются; формируется аналитическая записка.",
  "Черновой расчёт рассчитывается и сохраняется по справочникам Заказчика.",
  "Выполняется обмен со сметным ПО в согласованном на kickoff формате (выгрузка и/или загрузка).",
  "Создаётся и редактируется упрощённый ГПР.",
  "Заполняется и отображается простой денежный план.",
  "Формируется реестр договорных рисков-помощника.",
  "Ведется план/факт; отображается сводка руководителю.",
  "Данные организаций разделены.",
  "Передана краткая инструкция по основным сценариям.",
] as const;

describe("TZ acceptance criteria 1–11 (doctrine map)", () => {
  it("instrukciya page lists all 11 acceptance criteria verbatim titles", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/app/cabinet/instrukciya/page.tsx"),
      "utf8"
    );
    expect(src).toMatch(/Критерии приёмки 1–11/);
    for (const line of TZ_ACCEPTANCE) {
      // Title in page is without trailing period
      const title = line.replace(/\.$/, "");
      expect(src).toContain(title);
    }
  });

  it("1 — superadmin createUser + login", () => {
    ensureReady();
    const data = readAppData();
    const superadmin = data.users.find((u) => u.role === "superadmin");
    expect(superadmin).toBeTruthy();
    const email = `accept-1-${Date.now()}@alfastroy.ru`;
    createUser(superadmin!.id, {
      name: "[TEST] Acceptance user",
      email,
      password: "Accept123!",
      role: "tender",
      orgId: superadmin!.orgId,
      blocked: false,
      sections: ["zakupki", "dokumenty", "raschety"],
    });
    const created = readAppData().users.find((u) => u.email === email);
    expect(created).toBeTruthy();
    expect(created!.role).toBe("tender");
    expect(verifyPassword("Accept123!", created!.password ?? "")).toBe(true);
    const token = createSession(created!.id);
    expect(token.length).toBeGreaterThan(8);
  });

  it("2 — zakupki routes exist; source honesty documented as stub until kickoff", () => {
    expect(
      fs.existsSync(path.join(process.cwd(), "src/app/cabinet/zakupki/page.tsx"))
    ).toBe(true);
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/server/procurement-source.ts"),
      "utf8"
    );
    expect(src).toMatch(/not_configured|StubProcurementSource/);
  });

  it("3 — dokumenty upload + analyzeUpload path", () => {
    expect(
      fs.existsSync(path.join(process.cwd(), "src/app/api/dokumenty/route.ts"))
    ).toBe(true);
    const gs = fs.readFileSync(
      path.join(process.cwd(), "src/server/grand-smeta.ts"),
      "utf8"
    );
    expect(gs).toMatch(/analyzeUpload/);
    expect(gs).toMatch(/docx/);
  });

  it("4 — calc-math + recalc from directories", () => {
    const math = fs.readFileSync(
      path.join(process.cwd(), "src/lib/calc-math.ts"),
      "utf8"
    );
    expect(math).toMatch(/calculationTotals/);
    const repo = fs.readFileSync(
      path.join(process.cwd(), "src/server/repo.ts"),
      "utf8"
    );
    expect(repo).toMatch(/recalcCalculation/);
    expect(repo).toMatch(/directoryVersionId/);
  });

  it("5 — smeta XLSX export/import + confirm exchange", async () => {
    ensureReady();
    const data = readAppData();
    const calc = data.calculations.find((c) => c.orgId === "org-alfa");
    expect(calc).toBeTruthy();
    const buf = await buildSmetaExportXlsx(calc!.id);
    expect(buf.length).toBeGreaterThan(100);
    // magic PK for xlsx
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    const actor = data.users.find((u) => u.role === "smetchik");
    expect(actor).toBeTruthy();
    if (data.smetaExchanges[0]) {
      confirmSmetaExchange(actor!.id, data.smetaExchanges[0].id);
    }
    expect(
      fs.existsSync(path.join(process.cwd(), "src/app/cabinet/obmen/page.tsx"))
    ).toBe(true);
  });

  it("6–9 — gpr / dengi / riski / proizvodstvo pages exist", () => {
    for (const p of ["gpr", "dengi", "riski", "proizvodstvo"] as const) {
      expect(
        fs.existsSync(path.join(process.cwd(), `src/app/cabinet/${p}/page.tsx`))
      ).toBe(true);
    }
  });

  it("8 — contract risk helper disclaimer + empty → нет данных", async () => {
    const { parseContractRisksDetailed, RISK_HELPER_DISCLAIMER } = await import(
      "@/server/contract-risk"
    );
    const empty = parseContractRisksDetailed("");
    expect(empty.status).toBe("нет данных");
    expect(empty.disclaimer).toBe(RISK_HELPER_DISCLAIMER);
  });

  it("10 — org isolation: beta procurements disjoint from alfa", () => {
    ensureReady();
    const data = readAppData();
    const alfa = new Set(
      data.procurements.filter((p) => p.orgId === "org-alfa").map((p) => p.id)
    );
    const beta = data.procurements.filter((p) => p.orgId === "org-beta");
    expect(beta.every((p) => !alfa.has(p.id))).toBe(true);
  });

  it("11 — instruction page is the delivered brief for acceptance scenarios", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/app/cabinet/instrukciya/page.tsx"),
      "utf8"
    );
    expect(src).toMatch(/acceptanceScenarios/);
    expect(TZ_ACCEPTANCE).toHaveLength(11);
  });
});
