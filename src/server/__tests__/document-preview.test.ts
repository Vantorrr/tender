import { beforeEach, describe, expect, it } from "vitest";
import { createSession } from "@/server/auth";
import { closeDb, ensureReady, readAppData } from "@/server/db";
import { createDocument } from "@/server/repo";
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
});
