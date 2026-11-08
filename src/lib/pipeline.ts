/** Procurement pipeline / kanban helpers for stage-1 matryoshka UI. */

import type { ReviewStatus } from "@/lib/types";

export type KanbanColumnId =
  | "novaya"
  | "v_rabote"
  | "uchastvuem"
  | "ne_uchastvuem"
  | "dublikat";

export const KANBAN_COLUMNS: Array<{
  id: KanbanColumnId;
  label: string;
  reviewStatuses: ReviewStatus[];
  tone: string;
  headerClass: string;
  cardClass: string;
}> = [
  {
    id: "novaya",
    label: "Новое",
    reviewStatuses: ["novaya"],
    tone: "#1d4ed8",
    headerClass: "bg-sky-100 text-sky-950 border-sky-200",
    cardClass: "border-l-sky-500",
  },
  {
    id: "v_rabote",
    label: "В работе",
    reviewStatuses: ["na_rassmotrenii"],
    tone: "#b45309",
    headerClass: "bg-amber-100 text-amber-950 border-amber-200",
    cardClass: "border-l-amber-500",
  },
  {
    id: "uchastvuem",
    label: "Участвуем",
    reviewStatuses: ["odobrena"],
    tone: "#15803d",
    headerClass: "bg-emerald-100 text-emerald-950 border-emerald-200",
    cardClass: "border-l-emerald-500",
  },
  {
    id: "ne_uchastvuem",
    label: "Не участвуем",
    reviewStatuses: ["otklonena"],
    tone: "#b91c1c",
    headerClass: "bg-rose-100 text-rose-950 border-rose-200",
    cardClass: "border-l-rose-500",
  },
  {
    id: "dublikat",
    label: "Дубликат",
    reviewStatuses: ["dublirovana"],
    tone: "#57534e",
    headerClass: "bg-stone-100 text-stone-800 border-stone-200",
    cardClass: "border-l-stone-400",
  },
];

export const WORK_TYPES = [
  "дорожные",
  "общестрой",
  "инженерные сети",
  "благоустройство",
  "спецработы",
  "прочее",
] as const;

export type WorkType = (typeof WORK_TYPES)[number];

export const REGION_PRESETS = ["Норильск", "Ямал"] as const;

export function reviewToKanban(status: ReviewStatus): KanbanColumnId {
  const hit = KANBAN_COLUMNS.find((c) => c.reviewStatuses.includes(status));
  return hit?.id ?? "novaya";
}

export function kanbanToReview(column: KanbanColumnId): ReviewStatus {
  const hit = KANBAN_COLUMNS.find((c) => c.id === column);
  return hit?.reviewStatuses[0] ?? "novaya";
}

export function isNorthernRegion(region: string): boolean {
  const r = region.toLowerCase();
  return (
    r.includes("норильск") ||
    r.includes("ямал") ||
    r.includes("таймыр") ||
    r.includes("янао")
  );
}
