import { Badge } from "@/components/ui/badge";
import { REVIEW_LABELS, STATUS_LABELS } from "@/lib/roles";
import type { CardStatus, ReviewStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const statusClass: Record<CardStatus, string> = {
  zagruzheno: "bg-slate-100 text-slate-700 border-slate-200",
  v_rabote: "bg-sky-50 text-sky-800 border-sky-200",
  gotovo: "bg-emerald-50 text-emerald-800 border-emerald-200",
  trebuet_proverki: "bg-amber-50 text-amber-900 border-amber-200",
  oshibka: "bg-rose-50 text-rose-800 border-rose-200",
};

const reviewClass: Record<ReviewStatus, string> = {
  novaya: "bg-slate-100 text-slate-700 border-slate-200",
  na_rassmotrenii: "bg-sky-50 text-sky-800 border-sky-200",
  odobrena: "bg-emerald-50 text-emerald-800 border-emerald-200",
  otklonena: "bg-rose-50 text-rose-800 border-rose-200",
  dublirovana: "bg-orange-50 text-orange-900 border-orange-200",
};

/** Visible two-word status — flex gap cannot collapse like a tight single string. */
export function StatusLabel({
  status,
  className,
}: {
  status: CardStatus;
  className?: string;
}) {
  const plain = STATUS_LABELS[status];
  if (status === "v_rabote") {
    return (
      <span
        className={cn("inline-flex items-baseline gap-[0.35em]", className)}
        data-testid="status-label-v_rabote"
        title="В работе"
      >
        <span>В</span>
        <span>работе</span>
      </span>
    );
  }
  return (
    <span className={className} data-testid={`status-label-${status}`} title={plain}>
      {plain}
    </span>
  );
}

export function StatusBadge({
  status,
  className,
}: {
  status: CardStatus;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-6 min-w-fit shrink-0 px-2.5 font-medium whitespace-nowrap overflow-visible tracking-normal",
        statusClass[status],
        className
      )}
      data-testid={`status-badge-${status}`}
      title={STATUS_LABELS[status]}
    >
      <StatusLabel status={status} />
    </Badge>
  );
}

export function ReviewBadge({
  status,
  className,
}: {
  status: ReviewStatus;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("font-medium whitespace-nowrap", reviewClass[status], className)}
    >
      {REVIEW_LABELS[status]}
    </Badge>
  );
}
