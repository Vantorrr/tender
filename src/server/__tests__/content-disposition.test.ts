import { describe, expect, it } from "vitest";
import { contentDisposition } from "@/server/content-disposition";

describe("contentDisposition", () => {
  it("keeps a safe ASCII fallback and encodes a Russian filename", () => {
    const value = contentDisposition("attachment", "Реестр смет.xlsx");
    expect(value).toContain('attachment; filename="______ ____.xlsx"');
    expect(value).toContain("filename*=UTF-8''%D0%A0%D0%B5%D0%B5%D1%81%D1%82%D1%80%20%D1%81%D0%BC%D0%B5%D1%82.xlsx");
    expect(() => new Headers({ "Content-Disposition": value })).not.toThrow();
  });

  it("strips path separators and control characters", () => {
    const value = contentDisposition("inline", "../план\r\n.pdf");
    expect(value).not.toMatch(/[\r\n]/);
    expect(value).not.toContain("filename*=UTF-8''..%2F");
    expect(() => new Headers({ "Content-Disposition": value })).not.toThrow();
  });
});
