import { afterEach, expect, it, vi } from "vitest";
import "./setup";
import {
  closeDb,
  ensureReady,
  procurementStatusSnapshot,
  saveProcurementSyncStatus,
} from "@/server/db";
import { resetProcurementSource } from "@/server/procurement-source";

afterEach(() => {
  resetProcurementSource();
  vi.unstubAllEnvs();
  closeDb();
});

it("shares the latest live procurement result across API workers", () => {
  vi.stubEnv("PROCUREMENT_SOURCE", "kontur");
  vi.stubEnv("KONTUR_API_KEY", "test-secret");
  resetProcurementSource();
  ensureReady();

  saveProcurementSyncStatus(
    "kontur-external-api",
    "error",
    "Контур API маскирует реквизиты; проверьте доступ к API-лицензии."
  );
  expect(procurementStatusSnapshot()).toMatchObject({
    configured: true,
    status: "error",
    detail: "Контур API маскирует реквизиты; проверьте доступ к API-лицензии.",
  });

  saveProcurementSyncStatus("kontur-external-api", "ok", "Контур API: загрузка успешна.");
  expect(procurementStatusSnapshot()).toMatchObject({ status: "ok", detail: "Контур API: загрузка успешна." });
});
