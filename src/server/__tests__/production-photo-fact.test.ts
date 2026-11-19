import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/config", async () => {
  const actual = await vi.importActual<typeof import("@/server/config")>("@/server/config");
  return {
    ...actual,
    config: { ...actual.config, maxUploadBytes: 32 },
  };
});

import { createSession } from "@/server/auth";
import { closeDb, ensureReady, readAppData } from "@/server/db";
import { addDailyProductionFact } from "@/server/repo";
import "./setup";

describe("production fact with photo", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  async function postPhoto(quantity: string, bytes: number[], factId: string) {
    const form = new FormData();
    form.append("planFactId", "pf-1");
    form.append("date", "2026-11-19");
    form.append("workName", "Демонтаж перегородок");
    form.append("unit", "ед");
    form.append("quantity", quantity);
    form.append("factId", factId);
    form.append("photo", new File([Uint8Array.from(bytes)], "факт.png", { type: "image/png" }));
    const { POST } = await import("@/app/api/proizvodstvo/route");
    return POST(new Request("http://local/api/proizvodstvo", {
      method: "POST",
      headers: { authorization: `Bearer ${createSession("u-obj")}` },
      body: form,
    }));
  }

  it("saves a new daily row when the volume uses a comma and a photo is attached", async () => {
    const response = await postPhoto("1,5", [137, 80, 78, 71], "df-photo-comma");
    expect(response.status).toBe(200);
    const fact = readAppData().planFacts.find((item) => item.id === "pf-1")
      ?.dailyFacts?.find((item) => item.id === "df-photo-comma");
    expect(fact?.quantity).toBe(1.5);
    expect(fact?.photos[0]?.fileName).toBe("факт.png");
    expect(fact?.photos[0]?.storedPath).toBeTruthy();
  });

  it("keeps the photo after the page is reopened and the fact is edited again", async () => {
    const response = await postPhoto("3", [137, 80, 78, 71], "df-photo-keep");
    expect(response.status).toBe(200);
    closeDb();
    ensureReady();
    addDailyProductionFact("u-obj", "pf-1", {
      factId: "df-photo-keep",
      date: "2026-11-19",
      workName: "Демонтаж перегородок",
      unit: "ед",
      quantity: 4,
    });
    closeDb();
    ensureReady();
    const fact = readAppData().planFacts.find((item) => item.id === "pf-1")
      ?.dailyFacts?.find((item) => item.id === "df-photo-keep");
    expect(fact?.quantity).toBe(4);
    expect(fact?.photos).toHaveLength(1);
    expect(fact?.photos[0]?.fileName).toBe("факт.png");
    expect(fact?.photos[0]?.storedPath).toBeTruthy();
  });

  it("rejects an oversized photo with a Russian limit error and does not replace the saved row", async () => {
    const first = await postPhoto("2", [1, 2, 3, 4], "df-photo-size");
    expect(first.status).toBe(200);
    const response = await postPhoto("9", Array.from({ length: 40 }, () => 1), "df-photo-size");
    expect(response.status).toBe(413);
    expect((await response.json()).error).toMatch(/Файл слишком большой/);
    const fact = readAppData().planFacts.find((item) => item.id === "pf-1")
      ?.dailyFacts?.find((item) => item.id === "df-photo-size");
    expect(fact?.quantity).toBe(2);
    expect(fact?.photos).toHaveLength(1);
  });
});
