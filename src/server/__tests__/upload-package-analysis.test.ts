import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshProcurementAnalytics: vi.fn(),
  analyzeProcurementPackageWithAI: vi.fn(),
  recordProcurementAiFailure: vi.fn(),
  packageAnalysisAlreadyCurrent: vi.fn(() => false),
  config: { openRouterOnUpload: false },
}));

vi.mock("@/server/repo", () => ({
  refreshProcurementAnalytics: mocks.refreshProcurementAnalytics,
  analyzeProcurementPackageWithAI: mocks.analyzeProcurementPackageWithAI,
  recordProcurementAiFailure: mocks.recordProcurementAiFailure,
  packageAnalysisAlreadyCurrent: mocks.packageAnalysisAlreadyCurrent,
}));
vi.mock("@/server/config", () => ({ config: mocks.config }));

import { refreshAndMaybeAnalyzePackage } from "@/server/upload-package-analysis";

describe("refreshAndMaybeAnalyzePackage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config.openRouterOnUpload = true;
  });

  it("refreshes the local note and never calls the model, even when upload AI is enabled", async () => {
    await refreshAndMaybeAnalyzePackage("user-1", "proc-1");
    expect(mocks.refreshProcurementAnalytics).toHaveBeenCalledWith("user-1", "proc-1");
    expect(mocks.analyzeProcurementPackageWithAI).not.toHaveBeenCalled();
    expect(mocks.recordProcurementAiFailure).not.toHaveBeenCalled();
  });
});
