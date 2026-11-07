/**
 * OCR boundary: prefer local free Tesseract (+ poppler for PDF) when installed.
 * Mock only when engine is truly absent or OCR_PROVIDER=mock|none.
 * Never calls paid cloud OCR APIs.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type OcrStatus = "not_configured" | "unavailable" | "ok" | "empty";

export type OcrResult = {
  status: OcrStatus;
  text: string | null;
  pageCount: number | null;
  reason: string;
  provider: string | null;
};

export interface OcrProvider {
  readonly id: string;
  extractText(input: {
    fileName: string;
    buffer: Buffer;
    mimeHint?: string;
  }): Promise<OcrResult>;
}

export class NotConfiguredOcrProvider implements OcrProvider {
  readonly id = "none";

  async extractText(input: {
    fileName: string;
    buffer: Buffer;
    mimeHint?: string;
  }): Promise<OcrResult> {
    void input.buffer;
    return {
      status: "not_configured",
      text: null,
      pageCount: null,
      provider: null,
      reason:
        "OCR не сконфигурирован (tesseract не найден). Для PDF без текстового слоя разбор вручную или OCR_PROVIDER=tesseract после установки tesseract-ocr + poppler-utils.",
    };
  }
}

/** Test double — use only when engine is absent or OCR_PROVIDER=mock. */
export class MockOcrProvider implements OcrProvider {
  readonly id = "mock";
  constructor(
    private readonly text: string | null,
    private readonly pages = 1
  ) {}

  async extractText(): Promise<OcrResult> {
    if (!this.text) {
      return {
        status: "empty",
        text: null,
        pageCount: this.pages,
        provider: this.id,
        reason: "Mock OCR: пустой результат",
      };
    }
    return {
      status: "ok",
      text: this.text,
      pageCount: this.pages,
      provider: this.id,
      reason: "Mock OCR",
    };
  }
}

function which(bin: string): string | null {
  const result = spawnSync("which", [bin], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const p = result.stdout.trim();
  return p || null;
}

export function detectLocalOcrTools(): {
  tesseract: string | null;
  pdftoppm: string | null;
  pdftotext: string | null;
} {
  return {
    tesseract: which("tesseract"),
    pdftoppm: which("pdftoppm"),
    pdftotext: which("pdftotext"),
  };
}

function run(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Local free OCR via tesseract CLI (+ pdftoppm for rasterizing PDF pages). */
export class TesseractOcrProvider implements OcrProvider {
  readonly id = "tesseract";
  private readonly langs: string;

  constructor(langs = process.env.OCR_LANGS || "eng+rus") {
    this.langs = langs;
  }

  async extractText(input: {
    fileName: string;
    buffer: Buffer;
    mimeHint?: string;
  }): Promise<OcrResult> {
    const tools = detectLocalOcrTools();
    if (!tools.tesseract) {
      return {
        status: "unavailable",
        text: null,
        pageCount: null,
        provider: this.id,
        reason: "Бинарник tesseract не найден в PATH",
      };
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tk-ocr-"));
    try {
      const lower = input.fileName.toLowerCase();
      const isPdf =
        input.mimeHint?.includes("pdf") ||
        lower.endsWith(".pdf") ||
        input.buffer.subarray(0, 4).toString("utf8") === "%PDF";

      if (isPdf) {
        // Prefer embedded text layer first (free, local).
        if (tools.pdftotext) {
          const pdfPath = path.join(tmp, "doc.pdf");
          fs.writeFileSync(pdfPath, input.buffer);
          const textLayer = run(tools.pdftotext, ["-layout", pdfPath, "-"]);
          const layered = textLayer.stdout.replace(/\s+/g, " ").trim();
          if (textLayer.ok && layered.length >= 24) {
            return {
              status: "ok",
              text: layered.slice(0, 8000),
              pageCount: null,
              provider: this.id,
              reason: "pdftotext (текстовый слой PDF)",
            };
          }
        }
        if (!tools.pdftoppm) {
          return {
            status: "unavailable",
            text: null,
            pageCount: null,
            provider: this.id,
            reason:
              "PDF без текстового слоя: нужен pdftoppm (poppler-utils) для растрирования перед tesseract",
          };
        }
        const pdfPath = path.join(tmp, "doc.pdf");
        fs.writeFileSync(pdfPath, input.buffer);
        const prefix = path.join(tmp, "page");
        const raster = run(tools.pdftoppm, [
          "-png",
          "-r",
          "200",
          "-f",
          "1",
          "-l",
          "2",
          pdfPath,
          prefix,
        ]);
        if (!raster.ok) {
          return {
            status: "unavailable",
            text: null,
            pageCount: null,
            provider: this.id,
            reason: `pdftoppm failed: ${raster.stderr.slice(0, 160)}`,
          };
        }
        const pages = fs
          .readdirSync(tmp)
          .filter((f) => f.startsWith("page") && f.endsWith(".png"))
          .sort();
        if (!pages.length) {
          return {
            status: "empty",
            text: null,
            pageCount: 0,
            provider: this.id,
            reason: "pdftoppm не создал страницы",
          };
        }
        const chunks: string[] = [];
        for (const page of pages) {
          const ocr = run(tools.tesseract, [
            path.join(tmp, page),
            "stdout",
            "-l",
            this.langs,
            "--psm",
            "6",
          ]);
          if (ocr.ok && ocr.stdout.trim()) chunks.push(ocr.stdout.trim());
        }
        const text = chunks.join("\n").replace(/\s+/g, " ").trim();
        if (!text) {
          return {
            status: "empty",
            text: null,
            pageCount: pages.length,
            provider: this.id,
            reason: "Tesseract не распознал текст на скане",
          };
        }
        return {
          status: "ok",
          text: text.slice(0, 8000),
          pageCount: pages.length,
          provider: this.id,
          reason: "tesseract+pdftoppm (локальный OCR)",
        };
      }

      const ext = path.extname(lower) || ".png";
      const imgPath = path.join(tmp, `img${ext}`);
      fs.writeFileSync(imgPath, input.buffer);
      const ocr = run(tools.tesseract, [
        imgPath,
        "stdout",
        "-l",
        this.langs,
        "--psm",
        "6",
      ]);
      if (!ocr.ok) {
        return {
          status: "unavailable",
          text: null,
          pageCount: 1,
          provider: this.id,
          reason: `tesseract failed: ${ocr.stderr.slice(0, 160)}`,
        };
      }
      const text = ocr.stdout.replace(/\s+/g, " ").trim();
      if (!text) {
        return {
          status: "empty",
          text: null,
          pageCount: 1,
          provider: this.id,
          reason: "Tesseract вернул пустой текст",
        };
      }
      return {
        status: "ok",
        text: text.slice(0, 8000),
        pageCount: 1,
        provider: this.id,
        reason: "tesseract (локальный OCR)",
      };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

export function resolveDefaultOcrProvider(): OcrProvider {
  const mode = (process.env.OCR_PROVIDER ?? "auto").toLowerCase();
  if (mode === "none" || mode === "off") return new NotConfiguredOcrProvider();
  if (mode === "mock") return new MockOcrProvider("mock-ocr-text");
  if (mode === "tesseract" || mode === "auto" || mode === "") {
    const tools = detectLocalOcrTools();
    if (tools.tesseract) return new TesseractOcrProvider();
    if (mode === "tesseract") {
      return new NotConfiguredOcrProvider();
    }
    return new NotConfiguredOcrProvider();
  }
  return new NotConfiguredOcrProvider();
}

let provider: OcrProvider = resolveDefaultOcrProvider();

export function getOcrProvider(): OcrProvider {
  return provider;
}

export function setOcrProvider(next: OcrProvider): void {
  provider = next;
}

export function resetOcrProvider(): void {
  provider = resolveDefaultOcrProvider();
}

export function ocrConfigured(): boolean {
  return provider.id !== "none";
}

export async function extractDocumentText(input: {
  fileName: string;
  buffer: Buffer;
  mimeHint?: string;
}): Promise<OcrResult> {
  return getOcrProvider().extractText(input);
}
