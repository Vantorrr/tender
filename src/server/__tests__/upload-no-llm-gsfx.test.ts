import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runUploadQueue, uploadBatchLabel } from "@/lib/upload-queue";
import { createSession } from "@/server/auth";
import { config } from "@/server/config";
import { closeDb, ensureReady, readAppData } from "@/server/db";
import { analyzeUpload } from "@/server/grand-smeta";
import { createManualProcurement } from "@/server/repo";
import { detectArchiveFormat } from "@/server/safe-archive";
import "./setup";

async function zipBytes(entries: Array<{ name: string; data: Buffer | string }>): Promise<Buffer> {
  const zip = new JSZip();
  for (const entry of entries) zip.file(entry.name, entry.data);
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

async function postFile(procurementId: string, name: string, bytes: Buffer, fields?: Record<string, string>) {
  const form = new FormData();
  form.set("procurementId", procurementId);
  form.set("file", new File([new Uint8Array(bytes)], name));
  for (const [key, value] of Object.entries(fields ?? {})) form.set(key, value);
  const { POST } = await import("@/app/api/dokumenty/route");
  return POST(new Request("http://local/api/dokumenty", {
    method: "POST",
    headers: { authorization: `Bearer ${createSession("u-ruk")}` },
    body: form,
  }));
}

describe("upload does not call a model, and .gsfx stays one document", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("does not call the network while saving a file, even if upload AI is switched on", async () => {
    const previousKey = config.openRouterKey;
    const previousFlag = config.openRouterOnUpload;
    config.openRouterKey = "sk-test";
    config.openRouterOnUpload = true;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      const created = createManualProcurement("u-ruk", { title: "Без модели", region: "Ямал" });
      const response = await postFile(created.id, "пояснение.txt", Buffer.from("Срок выполнения работ 10 дней."), { useLlm: "1" });
      expect(response.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
      const packed = await zipBytes([{ name: "note.txt", data: "договор" }]);
      const archive = await postFile(created.id, "пакет.zip", packed, { useLlm: "true" });
      expect(archive.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      config.openRouterKey = previousKey;
      config.openRouterOnUpload = previousFlag;
    }
  });

  it("keeps a .gsfx container as one estimate and does not paint service files red", async () => {
    const gsfx = await zipBytes([
      { name: "Properties.txt", data: "Format=GrandSmeta" },
      { name: "Data.xml", data: "<Document><Item name=\"Бурение\"/></Document>" },
      { name: "Data.sign", data: "signed" },
    ]);
    expect(detectArchiveFormat("ЛС-02.gsfx", gsfx)).toBe("none");
    const direct = await analyzeUpload("ЛС-02.gsfx", "other", gsfx, { useLlm: false, heavyOcr: false });
    expect(direct.status).not.toBe("oshibka");
    expect(direct.analyticalNote).toMatch(/одним файлом/i);
    expect(direct.analyticalNote).not.toMatch(/Ошибки извлечения|формат пока нельзя/i);
    expect(direct.highlights.every((item) => item.severity !== "critical")).toBe(true);

    const created = createManualProcurement("u-ruk", { title: "Контейнер ГРАНД", region: "Ямал" });
    const response = await postFile(created.id, "ЛС-02.gsfx", gsfx);
    expect(response.status).toBe(200);
    const own = readAppData().documents.filter((document) => document.procurementId === created.id);
    expect(own.map((document) => document.fileName)).toEqual(["ЛС-02.gsfx"]);
    expect(own[0]?.status).not.toBe("oshibka");
    expect(own[0]?.extractionErrors ?? []).toEqual([]);
    expect(own[0]?.category).toBe("estimate");
    expect(own[0]?.analyticalNote ?? "").toMatch(/одним файлом/);
    expect(own[0]?.analyticalNote ?? "").not.toMatch(/Ошибки извлечения|формат пока нельзя/);

    const wrapped = await zipBytes([
      { name: "ЛС-02.gsfx", data: gsfx },
      { name: "Thumbs.db", data: "junk" },
      { name: "Data.sign", data: "signed" },
      { name: "__MACOSX/._ЛС-02.gsfx", data: "apple" },
    ]);
    const packed = createManualProcurement("u-ruk", { title: "Архив с контейнером", region: "Ямал" });
    const archived = await postFile(packed.id, "комплект.zip", wrapped);
    expect(archived.status).toBe(200);
    const docs = readAppData().documents.filter((document) => document.procurementId === packed.id);
    const names = docs.map((document) => document.fileName);
    expect(names).toContain("ЛС-02.gsfx");
    expect(names).toContain("Data.sign");
    expect(names.join(" ")).not.toMatch(/Thumbs|_ЛС-02/);
    const container = docs.find((document) => document.fileName === "ЛС-02.gsfx")!;
    const signature = docs.find((document) => document.fileName === "Data.sign")!;
    expect(container.status).not.toBe("oshibka");
    expect(container.extractionErrors ?? []).toEqual([]);
    expect(container.analyticalNote ?? "").toMatch(/одним файлом/i);
    expect(signature.status).not.toBe("oshibka");
    expect(signature.extractionErrors ?? []).toEqual([]);
    expect(signature.analyticalNote ?? "").not.toMatch(/формат пока нельзя|Ошибки извлечения/i);
    const parent = docs.find((document) => document.fileName === "комплект.zip")!;
    expect((parent.extractionErrors ?? []).join(" ")).not.toMatch(/Thumbs|Data\.sign|gsfx|формат пока нельзя/i);
  });

  it("isolates a hung file so the rest of the queue finishes", async () => {
    const started = Date.now();
    const result = await runUploadQueue(
      [
        new File(["a"], "a.pdf"),
        new File(["hang"], "slow.pdf"),
        new File([""], "empty.pdf"),
        new File(["b"], "b.docx"),
      ],
      (file) => file.name === "slow.pdf"
        ? new Promise(() => undefined)
        : Promise.resolve(),
      { concurrency: 2, timeoutMs: 40 },
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.uploaded).toBe(2);
    expect(result.errors.map((item) => item.name)).toEqual(["slow.pdf"]);
    expect(result.errors[0]?.message).toMatch(/Таймаут/);
    expect(result.skipped.map((item) => item.name)).toContain("empty.pdf");
    expect(result.warnings).toEqual([]);
    expect(uploadBatchLabel(result).text).toBe("Загружено 2 из 4. Ошибок: 1. Пропущено пустых и служебных: 1.");
  });

  it("keeps a zip member stored as ./file when the dot is only the current directory", async () => {
    const packed = await zipBytes([{ name: "./пояснение.txt", data: "договор поставки" }]);
    const created = createManualProcurement("u-ruk", { title: "Точка в пути", region: "Ямал" });
    const response = await postFile(created.id, "папка.zip", packed);
    expect(response.status).toBe(200);
    const docs = readAppData().documents.filter((document) => document.procurementId === created.id);
    expect(docs.some((document) => /пояснение\.txt$/u.test(document.fileName))).toBe(true);
  });
});
