/**
 * OCR boundary: prefer local free Tesseract (+ poppler for PDF) when installed.
 * Mock only when engine is truly absent or OCR_PROVIDER=mock|none.
 * Never calls paid cloud OCR APIs.
 */

import { spawnSync } from "node:child_process";
import { ocrFailureMessage, ocrPageLimitMessage } from "@/lib/wave23";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_PDF_TEXT_CHARS = 200_000;
const PDF_PAGE_CHARS = 16_000;
const OCR_TEXT_CHARS = 80_000;
const OCR_PAGE_LIMIT = 30;

export type OcrStatus = "not_configured" | "unavailable" | "ok" | "empty";

export type OcrResult = {
  status: OcrStatus;
  text: string | null;
  /** Text kept separately by page so citations never invent locations. */
  pages?: string[];
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
    /** False on upload: text layer only, no page-by-page raster OCR. */
    heavyOcr?: boolean;
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

function countPdfPages(buffer: Buffer): number | null {
  const matches = buffer.toString("latin1").match(/\/Type\s*\/Page(?!s)/g);
  return matches?.length || null;
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
    heavyOcr?: boolean;
  }): Promise<OcrResult> {
    const tools = detectLocalOcrTools();
    const lower = input.fileName.toLowerCase();
    const isPdf =
      input.mimeHint?.includes("pdf") ||
      lower.endsWith(".pdf") ||
      input.buffer.subarray(0, 4).toString("utf8") === "%PDF";

    // A text-layer PDF does not need tesseract. Scans and images still do.
    if (!isPdf && !tools.tesseract) {
      return {
        status: "unavailable",
        text: null,
        pageCount: null,
        provider: this.id,
        reason: "Бинарник tesseract не найден в PATH",
      };
    }
    if (isPdf && !tools.pdftotext && !tools.tesseract) {
      return {
        status: "unavailable",
        text: null,
        pageCount: null,
        provider: this.id,
        reason: "Для PDF нужны pdftotext или tesseract",
      };
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tk-ocr-"));
    try {
      if (isPdf) {
        // Prefer embedded text layer first (free, local).
        if (tools.pdftotext) {
          const pdfPath = path.join(tmp, "doc.pdf");
          fs.writeFileSync(pdfPath, input.buffer);
          const textLayer = run(tools.pdftotext, ["-layout", pdfPath, "-"]);
          const pages = textLayer.stdout
            .split("\f")
            .map((page) => page
              .replace(/\r/g, "")
              .split("\n")
              .map((line) => line.replace(/[\t ]+/g, " ").trimEnd())
              .join("\n")
              .trim())
            .filter(Boolean);
          const layered = pages.join("\n").trim();
          if (textLayer.ok && layered.length >= 24) {
            return {
              status: "ok",
              text: layered.slice(0, MAX_PDF_TEXT_CHARS),
              pages: pages.map((page) => page.slice(0, PDF_PAGE_CHARS)),
              pageCount: pages.length,
              provider: this.id,
              reason: "pdftotext (текстовый слой PDF)",
            };
          }
        }
        if (input.heavyOcr === false) {
          return {
            status: "empty",
            text: null,
            pageCount: countPdfPages(input.buffer),
            provider: this.id,
            reason: "Текстовый слой пуст. Распознавание скана при загрузке не запускается.",
          };
        }
        if (!tools.tesseract) {
          return {
            status: "unavailable",
            text: null,
            pageCount: null,
            provider: this.id,
            reason: "Текстовый слой пуст, а бинарник tesseract не найден в PATH",
          };
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
          String(OCR_PAGE_LIMIT),
          pdfPath,
          prefix,
        ]);
        if (!raster.ok) {
          return {
            status: "unavailable",
            text: null,
            pageCount: null,
            provider: this.id,
            reason: ocrFailureMessage(raster.stderr.slice(0, 160) || "не удалось подготовить страницы скана"),
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
            reason: ocrFailureMessage("на страницах скана не найден текст"),
          };
        }
        const totalPages = countPdfPages(input.buffer);
        const truncated = totalPages != null && totalPages > pages.length;
        return {
          status: "ok",
          text: text.slice(0, OCR_TEXT_CHARS),
          pages: chunks.map((chunk) => chunk.replace(/\s+/g, " ").trim().slice(0, PDF_PAGE_CHARS)),
          pageCount: pages.length,
          provider: this.id,
          reason: truncated
            ? ocrPageLimitMessage(pages.length, totalPages)
            : "Скан распознан",
        };
      }

      if (input.heavyOcr === false) {
        return {
          status: "empty",
          text: null,
          pageCount: 1,
          provider: this.id,
          reason: "Распознавание изображения при загрузке не запускается.",
        };
      }
      if (!tools.tesseract) {
        return {
          status: "unavailable",
          text: null,
          pageCount: 1,
          provider: this.id,
          reason: "Бинарник tesseract не найден в PATH",
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
          reason: ocrFailureMessage(ocr.stderr.slice(0, 160) || "программа распознавания завершилась с ошибкой"),
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
        text: text.slice(0, OCR_TEXT_CHARS),
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
    if (tools.tesseract || tools.pdftotext) return new TesseractOcrProvider();
    if (mode === "tesseract") {
      return new NotConfiguredOcrProvider();
    }
    return new NotConfiguredOcrProvider();
  }
  return new NotConfiguredOcrProvider();
}

let provider: OcrProvider = resolveDefaultOcrProvider();
let providerWasExplicitlySet = false;

export function getOcrProvider(): OcrProvider {
  // Auto mode can recover at runtime if OCR tools are installed after server start.
  const mode = (process.env.OCR_PROVIDER ?? "auto").toLowerCase();
  if (!providerWasExplicitlySet && provider.id === "none" && (mode === "auto" || mode === "tesseract" || mode === "")) {
    const tools = detectLocalOcrTools();
    if (tools.tesseract || tools.pdftotext) provider = new TesseractOcrProvider();
  }
  return provider;
}

export function setOcrProvider(next: OcrProvider): void {
  provider = next;
  providerWasExplicitlySet = true;
}

export function resetOcrProvider(): void {
  provider = resolveDefaultOcrProvider();
  providerWasExplicitlySet = false;
}

export function ocrConfigured(): boolean {
  return getOcrProvider().id !== "none";
}

export async function extractDocumentText(input: {
  fileName: string;
  buffer: Buffer;
  mimeHint?: string;
  heavyOcr?: boolean;
}): Promise<OcrResult> {
  return getOcrProvider().extractText(input);
}
