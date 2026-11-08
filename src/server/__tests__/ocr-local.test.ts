import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NotConfiguredOcrProvider,
  TesseractOcrProvider,
  detectLocalOcrTools,
  extractDocumentText,
  resetOcrProvider,
  setOcrProvider,
} from "@/server/ocr";

afterEach(() => {
  resetOcrProvider();
});

describe("local OCR (tesseract)", () => {
  const tools = detectLocalOcrTools();
  const fixturePng = path.join(
    process.cwd(),
    "fixtures/ocr/scan-fixture.png"
  );
  const fixturePdf = path.join(
    process.cwd(),
    "fixtures/ocr/scan-fixture.pdf"
  );

  it("requires local tesseract on the verification VM", () => {
    expect(
      tools.tesseract,
      "tesseract-ocr must be installed locally (apt); do not skip OCR acceptance"
    ).toBeTruthy();
    expect(fs.existsSync(fixturePng)).toBe(true);
    expect(fs.existsSync(fixturePdf)).toBe(true);
  });

  it("reads known text from scan-fixture.png via real tesseract", async () => {
    expect(tools.tesseract).toBeTruthy();
    setOcrProvider(new TesseractOcrProvider("eng"));
    const buf = fs.readFileSync(fixturePng);
    const result = await extractDocumentText({
      fileName: "scan-fixture.png",
      buffer: buf,
      mimeHint: "image/png",
    });
    expect(result.provider).toBe("tesseract");
    expect(result.status).toBe("ok");
    expect(result.text).toBeTruthy();
    const plain = (result.text ?? "").toUpperCase();
    expect(plain.includes("TMA361") || plain.includes("OCR")).toBe(true);
    expect(plain.includes("OPORA") || plain.includes("ZONA")).toBe(true);
  });

  it("OCRs scan-fixture.pdf (pdftoppm or text layer)", async () => {
    expect(tools.tesseract).toBeTruthy();
    setOcrProvider(new TesseractOcrProvider("eng"));
    const buf = fs.readFileSync(fixturePdf);
    const result = await extractDocumentText({
      fileName: "scan-fixture.pdf",
      buffer: buf,
      mimeHint: "application/pdf",
    });
    expect(result.provider).toBe("tesseract");
    expect(["ok", "empty", "unavailable"]).toContain(result.status);
    if (result.status === "ok") {
      expect(result.text?.toUpperCase()).toMatch(/TMA361|OCR|OPORA|ZONA/);
    }
  });

  it("NotConfiguredOcrProvider reports not_configured when forced", async () => {
    setOcrProvider(new NotConfiguredOcrProvider());
    const result = await extractDocumentText({
      fileName: "x.png",
      buffer: Buffer.from("x"),
    });
    expect(result.status).toBe("not_configured");
  });
});
