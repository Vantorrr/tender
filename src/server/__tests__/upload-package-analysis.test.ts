import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshProcurementAnalytics: vi.fn(),
  analyzeProcurementPackageWithAI: vi.fn(),
  config: { openRouterOnUpload: false },
}));

vi.mock("@/server/repo", () => ({
  refreshProcurementAnalytics: mocks.refreshProcurementAnalytics,
  analyzeProcurementPackageWithAI: mocks.analyzeProcurementPackageWithAI,
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(refreshAndMaybeAnalyzePackage("user-1", "proc-1")).resolves.toBeUndefined();
    expect(mocks.refreshProcurementAnalytics).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("[documents] automatic package analysis failed (Error)");
    warn.mockRestore();
  });
});
