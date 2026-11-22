import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  completeJsonWithUsage: vi.fn(),
  modelConfigured: vi.fn(() => true),
}));

vi.mock("@/server/openrouter", () => ({
  completeJsonWithUsage: mocks.completeJsonWithUsage,
  modelConfigured: mocks.modelConfigured,
}));
vi.mock("@/server/config", () => ({
  config: { openRouterModel: "google/gemini-4-carbon" },
}));

import { refineNote } from "@/server/model-note";

const analysis: {
  analyticalNote: string;
  highlights: [];
  citations: [];
  noteByModel?: boolean;
  aiFailure?: string;
  analysis: {
    vendor: string;
    region: string;
    zone: string;
    estimateNumber: string;
    workName: string;
    basis: string;
    priceLevel: string;
    costThousand: null;
    positionCount: number;
    profileMatch: boolean;
  };
} = {
  analyticalNote: "локальный разбор из файла",
  highlights: [],
  citations: [],
  analysis: {
    vendor: "",
    region: "",
    zone: "",
    estimateNumber: "",
    workName: "",
    basis: "",
    priceLevel: "",
    costThousand: null,
    positionCount: 0,
    profileMatch: false,
  },
};

describe("refineNote failures", () => {
  it("keeps the local note and persists the model error instead of hiding it", async () => {
    mocks.modelConfigured.mockReturnValue(true);
    mocks.completeJsonWithUsage.mockRejectedValueOnce(new Error("Пустой ответ модели"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const refined = await refineNote(analysis, { fileName: "smeta.xlsx" }, []);

    expect(refined.analyticalNote).toBe("локальный разбор из файла");
    expect(refined.noteByModel).toBeFalsy();
    expect(refined.aiFailure).toBe("ИИ-анализ не выполнен: Пустой ответ модели");
    expect(errorLog).toHaveBeenCalledWith("model note skipped:", "Пустой ответ модели");
    errorLog.mockRestore();
  });

  it("does not mark a failure when the model key is absent", async () => {
    mocks.completeJsonWithUsage.mockClear();
    mocks.modelConfigured.mockReturnValue(false);
    const refined = await refineNote(analysis, { fileName: "smeta.xlsx" }, []);
    expect(refined.aiFailure).toBeUndefined();
    expect(mocks.completeJsonWithUsage).not.toHaveBeenCalled();
  });
});
