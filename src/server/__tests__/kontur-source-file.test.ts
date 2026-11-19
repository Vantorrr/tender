import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@/server/auth";
import { closeDb, ensureReady } from "@/server/db";
import { createManualProcurement, updateProcurement } from "@/server/repo";
import "./setup";

describe("Kontur procurement attachments", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
    process.env.KONTUR_DOCUMENT_ALLOWED_HOSTS = "docs.example.test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.KONTUR_DOCUMENT_ALLOWED_HOSTS;
  });

  async function makeKonturProcurement(url: string) {
    const procurement = createManualProcurement("u-tender", {
      title: "Проверка загрузки файлов Контура",
      region: "ЯНАО",
    });
    updateProcurement("u-tender", procurement.id, {
      source: "Контур.Закупки API",
      externalId: "kontur-purchase-1",
      attachments: [{ id: "a-kontur-1", name: "Техническое задание.pdf", type: "Документ API", size: "—", sourceUrl: url }],
    });
    return procurement;
  }

  it("downloads an allowed HTTPS document for its owning procurement", async () => {
    const procurement = await makeKonturProcurement("https://docs.example.test/files/tz.pdf");
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 49]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytes, {
      headers: { "content-type": "application/pdf", "content-length": String(bytes.length) },
    })));
    const { POST } = await import("@/app/api/zakupki/source-file/route");
    const response = await POST(new Request("http://local/api/zakupki/source-file", {
      method: "POST",
      headers: { authorization: `Bearer ${createSession("u-tender")}`, "content-type": "application/json" },
      body: JSON.stringify({ procurementId: procurement.id, attachmentId: "a-kontur-1" }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      redirect: "manual",
      headers: expect.objectContaining({ "user-agent": "TMA361 procurement feed/1.0" }),
    }));
  });

  it("rejects a Kontur attachment hosted outside the configured source domains", async () => {
    const procurement = await makeKonturProcurement("https://127.0.0.1/private");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("@/app/api/zakupki/source-file/route");
    const response = await POST(new Request("http://local/api/zakupki/source-file", {
      method: "POST",
      headers: { authorization: `Bearer ${createSession("u-tender")}`, "content-type": "application/json" },
      body: JSON.stringify({ procurementId: procurement.id, attachmentId: "a-kontur-1" }),
    }));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
