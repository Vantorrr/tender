/** A calculation row is removed only when the in-app dialog is confirmed. */
export function rowDeleteConfirmed(decision: "confirm" | "dismiss"): boolean {
  return decision === "confirm";
}
