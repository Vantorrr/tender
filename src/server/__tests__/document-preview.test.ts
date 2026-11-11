import { beforeEach, describe, expect, it } from "vitest";
import { createSession } from "@/server/auth";
import { closeDb, ensureReady, readAppData } from "@/server/db";
import { createDocument } from "@/server/repo";
import { saveUpload } from "@/server/uploads";
import "./setup";

describe("document web preview", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("opens extracted RAR archive contents in the web preview", async () => {
    const procurement = readAppData().procurements.find((item) => item.id === "p-1")!;
    const { documentId } = createDocument("u-ruk", {
      orgId: procurement.orgId,
      procurementId: procurement.id,
      title: "Комплект документов",
      fileName: "Комплект.rar",
      fileType: "other",
      category: "archive",
      extractedFiles: [
        { name: "Техническое задание.pdf", size: 2048, relativePath: "Техническое задание.pdf" },
      ],
      extractionErrors: [],
    });
    const token = createSession("u-ruk");
    const { GET } = await import("@/app/api/dokumenty/preview/route");
    const response = await GET(
      new Request(`http://local/api/dokumenty/preview?id=${documentId}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      kind: "archive",
      files: [
        { name: "Техническое задание.pdf", size: 2048, relativePath: "Техническое задание.pdf" },
      ],
      errors: [],
    });
  });

  it("previews an uploaded scan image in the browser with an authenticated image response", async () => {
    const procurement = readAppData().procurements.find((item) => item.id === "p-1")!;
    const bytes = Buffer.from("test png bytes");
    const stored = await saveUpload("image-preview-test", "scan.png", bytes);
    const { documentId } = createDocument("u-ruk", {
      orgId: procurement.orgId,
      procurementId: procurement.id,
      title: "Скан приложения",
      fileName: "scan.png",
      fileType: "other",
      category: "general",
      storedPath: stored.storedPath,
      fileSize: stored.fileSize,
    });
    const token = createSession("u-ruk");
    const { GET: previewGet } = await import("@/app/api/dokumenty/preview/route");
    const preview = await previewGet(new Request(
      `http://local/api/dokumenty/preview?id=${documentId}`,
      { headers: { authorization: `Bearer ${token}` } }
    ));
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toEqual({ kind: "image" });

    const { GET: fileGet } = await import("@/app/api/dokumenty/file/route");
    const file = await fileGet(new Request(
      `http://local/api/dokumenty/file?id=${documentId}&disposition=inline`,
      { headers: { authorization: `Bearer ${token}` } }
    ));
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
  });
});
