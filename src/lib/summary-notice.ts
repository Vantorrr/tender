export const SUMMARY_FRESH = "Сводка обновлена";
export const SUMMARY_UNCHANGED = "Новых данных нет — записка уже актуальна";

/** «Сводка обновлена» only when the note text itself changed. */
export function summaryRefreshNotice(before: string | null | undefined, after: string | null | undefined): string {
  return (before ?? "").trim() === (after ?? "").trim() ? SUMMARY_UNCHANGED : SUMMARY_FRESH;
}
