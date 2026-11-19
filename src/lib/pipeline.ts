/** Procurement pipeline / kanban helpers for stage-1 matryoshka UI. */

import type { ReviewStatus } from "@/lib/types";

export type KanbanColumnId =
  | "novaya"
  | "v_rabote"
  | "uchastvuem"
  | "ne_uchastvuem"
  | "dublikat"
  | "in_production"
  | "realized"
  | "closed_not_realized";

export const KANBAN_COLUMNS: Array<{
  id: KanbanColumnId;
  label: string;
  reviewStatuses: ReviewStatus[];
  tone: string;
  headerClass: string;
  cardClass: string;
  lifecycle?: "production" | "closed";
  outcome?: "successful" | "not_realized";
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
  {
    id: "in_production",
    label: "В производстве",
    reviewStatuses: [],
    lifecycle: "production",
    tone: "#0369a1",
    headerClass: "bg-cyan-100 text-cyan-950 border-cyan-200",
    cardClass: "border-l-cyan-600",
  },
  {
    id: "realized",
    label: "Успешно реализовано",
    reviewStatuses: [],
    lifecycle: "closed",
    outcome: "successful",
    tone: "#047857",
    headerClass: "bg-emerald-100 text-emerald-950 border-emerald-200",
    cardClass: "border-l-emerald-700",
  },
  {
    id: "closed_not_realized",
    label: "Закрыто и не реализовано",
    reviewStatuses: [],
    lifecycle: "closed",
    outcome: "not_realized",
    tone: "#6b7280",
    headerClass: "bg-slate-100 text-slate-900 border-slate-200",
    cardClass: "border-l-slate-500",
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

export function procurementBoardLabel(input: {
  reviewStatus: ReviewStatus;
  lifecycle?: string;
  lifecycleOutcome?: string;
}): string {
  const column = displayedKanbanColumn(input);
  return KANBAN_COLUMNS.find((item) => item.id === column)?.label ?? "Новое";
}

export function displayedKanbanColumn(input: {
  reviewStatus: ReviewStatus;
  lifecycle?: string;
  lifecycleOutcome?: string;
}): KanbanColumnId {
  if (input.lifecycle === "production") return "in_production";
  if (input.lifecycle === "closed") {
    return input.lifecycleOutcome === "successful" ? "realized" : "closed_not_realized";
  }
  const review = reviewToKanban(input.reviewStatus);
  if (review === "ne_uchastvuem" || review === "dublikat") return "closed_not_realized";
  return review;
}

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
