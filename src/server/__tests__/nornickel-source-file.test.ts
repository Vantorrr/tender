import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@/server/auth";
import { closeDb, ensureReady } from "@/server/db";
import { NornickelLocalProcurementSource } from "@/server/procurement-source";
import { createManualProcurement, updateProcurement } from "@/server/repo";
import "./setup";

describe("Nornickel source files", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps documentation links for № and lot titles and drops foreign hosts", async () => {
    const future = Math.floor(Date.now() / 1000) + 86_400;
    const past = Math.floor(Date.now() / 1000) - 86_400;
    const html = `<html><script>{"local-tenders":{"items":[
      {"name":"№ 174942 «Услуги».","activeTo":${future},"customer":{"value":"АО НТЭК"},"address":"Норильск","documentation":{"link":"/upload/iblock/b65/174942.rar","origName":"174942.rar","type":"rar","size":"10 КБ"}},
      {"name":"Поставка смеси, лот 188/26","activeTo":${future},"documentation":{"link":"/upload/iblock/ce9/lot.rar","origName":"lot.rar","type":"rar","size":"1 КБ"}},
      {"name":"20061320/2: Капитальный ремонт пути","activeTo":${future},"documentation":{"link":"https://nornik-upload.storage.yandexcloud.net/iblock/aa/doc.rar","origName":"doc.rar","type":"rar","size":"1 КБ"}},
      {"name":"174700 Чужой файл","activeTo":${future},"documentation":{"link":"https://evil.example/upload/x.rar","origName":"x.rar"}},
      {"name":"Без номера и без файла","activeTo":${future}},
      {"name":"№ 9 Просрочено","activeTo":${past},"documentation":{"link":"/upload/iblock/old/old.rar","origName":"old.rar"}}
    ],"nav":{"total":1}}}</script></html>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(html)));

    const result = await new NornickelLocalProcurementSource().fetchNotices();
    const byNumber = Object.fromEntries(result.notices.map((notice) => [notice.number, notice]));

    expect(result.ok).toBe(true);
    expect(byNumber["174942"]?.attachmentUrl).toBe("https://nornickel.ru/upload/iblock/b65/174942.rar");
    expect(byNumber["188/26"]?.attachmentUrl).toBe("https://nornickel.ru/upload/iblock/ce9/lot.rar");
    expect(byNumber["20061320/2"]?.attachmentUrl).toBe("https://nornik-upload.storage.yandexcloud.net/iblock/aa/doc.rar");
    expect(byNumber["174700"]?.attachmentUrl).toBeUndefined();
    expect(result.notices.some((notice) => /Просрочено|Без номера/.test(notice.title))).toBe(false);
  });

  it("downloads a relative Nornickel path and a stale attachment id when one source file remains", async () => {
    const procurement = createManualProcurement("u-tender", {
      title: "Услуги Норникеля",
      region: "Норильск",
    });
    updateProcurement("u-tender", procurement.id, {
      source: "Публичная страница закупок «Норникеля»",
      attachments: [{
        id: "a-src-174942",
        name: "174942.rar",
        type: "rar",
        size: "10 КБ",
        sourceUrl: "/upload/iblock/b65/174942.rar",
      }],
    });
    const bytes = new Uint8Array([82, 97, 114, 33]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytes, {
      headers: { "content-type": "application/x-rar-compressed" },
    })));
    const { POST } = await import("@/app/api/zakupki/source-file/route");
    const response = await POST(new Request("http://local/api/zakupki/source-file", {
      method: "POST",
      headers: { authorization: `Bearer ${createSession("u-tender")}`, "content-type": "application/json" },
      body: JSON.stringify({ procurementId: procurement.id, attachmentId: "a-auto-stale" }),
    }));

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    const called = vi.mocked(fetch).mock.calls[0];
    expect(String(called[0])).toBe("https://nornickel.ru/upload/iblock/b65/174942.rar");
    expect(called[1]).toEqual(expect.objectContaining({
      redirect: "manual",
      headers: expect.objectContaining({ "user-agent": "TMA361 procurement feed/1.0" }),
    }));
  });

  it("follows a redirect only onto an allowed Nornickel file host", async () => {
    const procurement = createManualProcurement("u-tender", {
      title: "Ремонт пути",
      region: "Норильск",
    });
    updateProcurement("u-tender", procurement.id, {
      attachments: [{
        id: "a-src-1",
        name: "doc.rar",
        type: "rar",
        size: "1 КБ",
        sourceUrl: "https://nornickel.ru/upload/iblock/aa/doc.rar",
      }],
    });
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", {
        status: 302,
        headers: { location: "https://nornik-upload.storage.yandexcloud.net/iblock/aa/doc.rar" },
      }))
      .mockResolvedValueOnce(new Response(bytes));
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("@/app/api/zakupki/source-file/route");
    const response = await POST(new Request("http://local/api/zakupki/source-file", {
      method: "POST",
      headers: { authorization: `Bearer ${createSession("u-tender")}`, "content-type": "application/json" },
      body: JSON.stringify({ procurementId: procurement.id, attachmentId: "a-src-1" }),
    }));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://nornik-upload.storage.yandexcloud.net/iblock/aa/doc.rar");
  });
});
