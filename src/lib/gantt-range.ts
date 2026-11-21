/** Inclusive day indexes visible in the timeline viewport. A partly shown day counts. */
export function visibleDayBounds(
  scrollLeft: number,
  timelineWidth: number,
  dayWidth: number,
  dayCount: number,
): { first: number; last: number } | null {
  if (!dayCount || dayWidth <= 0) return null;
  const origin = Math.max(0, scrollLeft);
  const first = Math.max(0, Math.min(dayCount - 1, Math.floor(origin / dayWidth)));
  const right = origin + Math.max(0, timelineWidth);
  const last = Math.max(first, Math.min(dayCount - 1, Math.ceil(right / dayWidth) - 1));
  return { first, last };
}
