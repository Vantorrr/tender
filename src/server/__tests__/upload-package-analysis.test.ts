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
    mocks.config.openRouterOnUpload = false;
  });

  it("always refreshes deterministic analytics and only calls the model when enabled", async () => {
    await refreshAndMaybeAnalyzePackage("user-1", "proc-1");
    expect(mocks.refreshProcurementAnalytics).toHaveBeenCalledWith("user-1", "proc-1");
    expect(mocks.analyzeProcurementPackageWithAI).not.toHaveBeenCalled();

    mocks.config.openRouterOnUpload = true;
    await refreshAndMaybeAnalyzePackage("user-1", "proc-1");
    expect(mocks.analyzeProcurementPackageWithAI).toHaveBeenCalledWith("user-1", "proc-1");
  });

  it("keeps a successful upload successful when the model provider is unavailable", async () => {
    mocks.config.openRouterOnUpload = true;
    mocks.analyzeProcurementPackageWithAI.mockRejectedValueOnce(new Error("provider unavailable"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(refreshAndMaybeAnalyzePackage("user-1", "proc-1")).resolves.toBeUndefined();
    expect(mocks.refreshProcurementAnalytics).toHaveBeenCalledOnce();
    expect(errorLog).toHaveBeenCalledWith("[documents] automatic package analysis failed: provider unavailable");
    expect(mocks.recordProcurementAiFailure).toHaveBeenCalledWith("user-1", "proc-1", "provider unavailable");
    errorLog.mockRestore();
  });

  it("does not call the model again when the document set is unchanged", async () => {
    mocks.config.openRouterOnUpload = true;
    mocks.packageAnalysisAlreadyCurrent.mockReturnValue(true);
    await refreshAndMaybeAnalyzePackage("user-1", "proc-1");
    expect(mocks.refreshProcurementAnalytics).toHaveBeenCalledOnce();
    expect(mocks.analyzeProcurementPackageWithAI).not.toHaveBeenCalled();
  });

  it("lets a second automatic run wait and then skip when the first one covers the same files", async () => {
    mocks.config.openRouterOnUpload = true;
    mocks.packageAnalysisAlreadyCurrent.mockReturnValue(false);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.analyzeProcurementPackageWithAI.mockImplementationOnce(() => gate.then(() => {
      mocks.packageAnalysisAlreadyCurrent.mockReturnValue(true);
    }));

    const first = refreshAndMaybeAnalyzePackage("user-1", "proc-1");
    const second = refreshAndMaybeAnalyzePackage("user-1", "proc-1");
    release();
    await Promise.all([first, second]);
    expect(mocks.analyzeProcurementPackageWithAI).toHaveBeenCalledTimes(1);
  });
});
