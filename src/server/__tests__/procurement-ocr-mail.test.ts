import { afterEach, describe, expect, it } from "vitest";
import {
  MockProcurementSource,
  StubProcurementSource,
  getProcurementSource,
  resetProcurementSource,
  setProcurementSource,
} from "@/server/procurement-source";
import {
  MockOcrProvider,
  NotConfiguredOcrProvider,
  extractDocumentText,
  ocrConfigured,
  resetOcrProvider,
  setOcrProvider,
} from "@/server/ocr";
import {
  MemoryMailTransport,
  clearMailInbox,
  getMailInbox,
  resetMailTransport,
  sendMail,
  setMailTransport,
} from "@/server/mail";
import { parseContractRisks } from "@/server/contract-risk";
import { modelConfigured } from "@/server/openrouter";
import { refineNote } from "@/server/model-note";
import type { DocumentAnalysis, Highlight } from "@/lib/types";

afterEach(() => {
  resetProcurementSource();
  resetOcrProvider();
  resetMailTransport();
  clearMailInbox();
});

describe("procurement adapter", () => {
  it("defaults to stub source (no vendor API)", async () => {
    const source = getProcurementSource();
    expect(source).toBeInstanceOf(StubProcurementSource);
    const feed = await source.fetchNotices("org-alfa");
    expect(feed.stub).toBe(true);
    expect(feed.notices.length).toBe(1);
    expect(feed.notices[0].number).toMatch(/-AUTO$/);
  });

  it("accepts mock notices in tests only", async () => {
    setProcurementSource(
      new MockProcurementSource([
        {
          number: "TEST-001",
          title: "Mock notice",
          customer: "Test",
          region: "Тест",
          nmck: 1,
          deadline: new Date().toISOString(),
          source: "mock",
        },
      ])
    );
    const feed = await getProcurementSource().fetchNotices("org-beta");
    expect(feed.notices[0].number).toBe("TEST-001");
  });
});

describe("OCR boundary", () => {
  it("returns not_configured without a provider", async () => {
    expect(ocrConfigured()).toBe(false);
    const result = await extractDocumentText({
      fileName: "drawing.pdf",
      buffer: Buffer.from("%PDF"),
    });
    expect(result.status).toBe("not_configured");
    expect(result.text).toBeNull();
    expect(result.reason).toMatch(/OCR не сконфигурирован/);
  });

  it("mock provider returns text without paid calls", async () => {
    setOcrProvider(new MockOcrProvider("опора №12", 2));
    expect(ocrConfigured()).toBe(true);
    const result = await extractDocumentText({
      fileName: "drawing.pdf",
      buffer: Buffer.from("%PDF"),
    });
    expect(result.status).toBe("ok");
    expect(result.text).toBe("опора №12");
    setOcrProvider(new NotConfiguredOcrProvider());
  });
});

describe("mail transport", () => {
  it("captures recovery mail in memory inbox", async () => {
    setMailTransport(new MemoryMailTransport());
    await sendMail({
      to: "tender@test.local",
      subject: "recover",
      text: "Код восстановления: abc123",
    });
    const inbox = getMailInbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0].to).toBe("tender@test.local");
    expect(inbox[0].text).toContain("abc123");
  });
});

describe("contract risk helper", () => {
  it("extracts remarks with source excerpts from contract text", () => {
    const text = `
      Договор подряда. Обеспечение исполнения контракта составляет 10% от НМЦК.
      При нарушении сроков подрядчик уплачивает штраф 0,1% в сутки.
      Гарантийный срок на работы — 60 месяцев.
    `;
    const remarks = parseContractRisks(text);
    expect(remarks.length).toBeGreaterThanOrEqual(2);
    expect(remarks.some((r) => /штраф|санкц/i.test(r.text))).toBe(true);
    expect(remarks.every((r) => r.sourceExcerpt.length > 0)).toBe(true);
  });

  it("falls back to baseline remarks for empty text", () => {
    expect(parseContractRisks("")).toHaveLength(3);
  });
});

describe("LLM fail-safe", () => {
  it("does not call paid model when key is absent", async () => {
    expect(modelConfigured()).toBe(false);
    const highlights: Highlight[] = [
      {
        id: "h1",
        text: "зона 5",
        reason: "из файла",
        severity: "info",
        page: 1,
      },
    ];
    const analysis: {
      analyticalNote: string;
      highlights: Highlight[];
      citations: { id: string; text: string; page: number; sourceFile: string }[];
      analysis: DocumentAnalysis;
      noteByModel?: boolean;
    } = {
      analyticalNote: "базовый разбор из ячеек",
      highlights,
      citations: [
        { id: "c1", text: "зона 5", page: 1, sourceFile: "smeta.xlsx" },
      ],
      analysis: {
        vendor: "test",
        region: "ЯНАО",
        zone: "5",
        estimateNumber: "1",
        workName: "снег",
        basis: "x",
        priceLevel: "2024",
        costThousand: 1,
        positionCount: 1,
        profileMatch: true,
      },
    };
    const refined = await refineNote(analysis, { fileName: "smeta.xlsx" }, [
      "зона 5",
    ]);
    expect(refined.noteByModel).toBeFalsy();
    expect(refined.analyticalNote).toBe("базовый разбор из ячеек");
    expect(refined.citations?.[0].sourceFile).toBe("smeta.xlsx");
  });
});
