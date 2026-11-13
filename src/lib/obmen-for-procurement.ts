/**
 * Pick the latest smeta exchange that belongs to this procurement.
 * Never falls back to an unrelated org-wide exchange.
 */
export function pickLastExchangeForProcurement<
  T extends { orgId: string; name: string; at: string },
>(
  exchanges: T[] | undefined,
  opts: {
    orgId: string;
    procurementId: string;
    procurementNumber: string;
    originalCalculationId?: string | null;
  }
): T | undefined {
  const { orgId, procurementId, procurementNumber, originalCalculationId } = opts;
  return (exchanges ?? [])
    .filter(
      (x) =>
        x.orgId === orgId &&
        (x.name.includes(procurementId) ||
          x.name.includes(procurementNumber) ||
          Boolean(originalCalculationId && x.name.includes(originalCalculationId)))
    )
    .sort((a, b) => b.at.localeCompare(a.at))[0];
}
