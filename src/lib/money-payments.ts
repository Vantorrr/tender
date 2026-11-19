import type { MoneyPayment } from "@/lib/types";

export type PaymentBucket = "avans" | "postuplenie" | "spisanie" | "klyuchevoy";

export const PAYMENT_BUCKET_LABELS: Record<PaymentBucket, string> = {
  avans: "Аванс",
  postuplenie: "Поступление",
  spisanie: "Списание",
  klyuchevoy: "Ключевой платёж",
};

const STORED_TYPES = new Set<PaymentBucket>(["avans", "postuplenie", "spisanie", "klyuchevoy"]);

/**
 * The type the user chose is the type we keep.
 * A title like «Аванс 2 этап» does not override «Списание».
 * Legacy rows stored as `klyuchevoy` stay key payments.
 * The title is used only when no type was stored.
 */
export function paymentBucket(payment: { type?: string; title?: string }): PaymentBucket {
  if (payment.type && STORED_TYPES.has(payment.type as PaymentBucket)) {
    return payment.type as PaymentBucket;
  }
  const title = (payment.title ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  if (/списан/.test(title)) return "spisanie";
  if (/аванс/.test(title)) return "avans";
  if (/этап|поступлен|оплат|расчет|закрыти/.test(title)) return "postuplenie";
  return "postuplenie";
}

export function paymentTypeForSave(payment: { type?: string; title?: string }): MoneyPayment["type"] {
  return paymentBucket(payment);
}

export function paymentTotals(payments: Array<{ type?: string; title?: string; amount: number }>) {
  const totals = { total: 0, avans: 0, postuplenie: 0, spisanie: 0, klyuchevoy: 0 };
  for (const payment of payments) {
    const amount = Number(payment.amount) || 0;
    totals.total += amount;
    totals[paymentBucket(payment)] += amount;
  }
  return totals;
}
