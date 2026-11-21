/** A second click of the same create action inside this window is the same entity. */
export const DUPLICATE_CLICK_MS = 3_000;

export function recentPaymentId(
  payments: Array<{ id: string; type?: string; title?: string; amount: number; date: string }>,
  next: { type?: string; title?: string; amount: number; date: string },
  now = Date.now(),
): string | null {
  const title = (next.title ?? "").trim() || "Платёж";
  const type = next.type ?? "";
  for (let index = payments.length - 1; index >= 0; index -= 1) {
    const payment = payments[index];
    const stamp = Number(String(payment.id).replace(/^pay-/, ""));
    if (!Number.isFinite(stamp) || stamp > now || now - stamp > DUPLICATE_CLICK_MS) continue;
    if (
      payment.amount === next.amount
      && payment.date === next.date
      && (payment.type ?? "") === type
      && (payment.title ?? "").trim() === title
    ) {
      return payment.id;
    }
  }
  return null;
}
