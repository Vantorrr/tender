/**
 * OCR service boundary. No OCR engine is bundled; callers get an explicit
 * not-configured result so drawings without a text layer stay manual.
 */

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
        "OCR не сконфигурирован. Для PDF без текстового слоя разбор выполняется вручную или после подключения OCR_PROVIDER.",
    };
  }
}

/** Test double that returns fixed text without calling a paid/cloud OCR API. */
export class MockOcrProvider implements OcrProvider {
  readonly id = "mock";
  constructor(private readonly text: string | null, private readonly pages = 1) {}

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

let provider: OcrProvider = new NotConfiguredOcrProvider();

export function getOcrProvider(): OcrProvider {
  return provider;
}

export function setOcrProvider(next: OcrProvider): void {
  provider = next;
}

export function resetOcrProvider(): void {
  provider = new NotConfiguredOcrProvider();
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
