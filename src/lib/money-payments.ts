import type { MoneyPayment } from "@/lib/types";

export type PaymentBucket = "avans" | "postuplenie" | "spisanie";

export const PAYMENT_BUCKET_LABELS: Record<PaymentBucket, string> = {
  avans: "Аванс",
  postuplenie: "Поступление",
  spisanie: "Списание",
};

/**
 * Stage payments and settlements are receipts, not advances.
 * A title that names the kind wins over a stored type left over from the
 * old form, which saved every new row as an advance.
 */
export function paymentBucket(payment: { type?: string; title?: string }): PaymentBucket {
  const title = (payment.title ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  if (/списан/.test(title)) return "spisanie";
  if (/аванс/.test(title)) return "avans";
  if (/этап|поступлен|оплат|расчет|закрыти/.test(title)) return "postuplenie";
  if (payment.type === "spisanie") return "spisanie";
  if (payment.type === "avans") return "avans";
  return "postuplenie";
}

export function paymentTypeForSave(payment: { type?: string; title?: string }): MoneyPayment["type"] {
  return paymentBucket(payment);
}

export function paymentTotals(payments: Array<{ type?: string; title?: string; amount: number }>) {
  const totals = { total: 0, avans: 0, postuplenie: 0, spisanie: 0 };
  for (const payment of payments) {
    const amount = Number(payment.amount) || 0;
    totals.total += amount;
    totals[paymentBucket(payment)] += amount;
  }
  return totals;
}
