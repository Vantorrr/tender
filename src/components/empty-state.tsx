import { Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="tk-glass flex flex-col items-center justify-center rounded-3xl border-dashed px-6 py-16 text-center animate-in fade-in duration-500">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--tk-steel-50)] text-[var(--tk-steel)]">
        <Inbox className="h-6 w-6" />
      </div>
      <h3 className="font-[family-name:var(--font-display)] text-lg tracking-tight text-[var(--tk-ink)]">
        {title}
      </h3>
      <p className="mt-2 max-w-md text-sm text-[var(--tk-muted)]">{description}</p>
      {actionLabel && onAction ? (
        <Button className="mt-6" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

export function LoadingState({ label = "Загрузка…" }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 animate-in fade-in">
      <div className="h-9 w-9 animate-spin rounded-full border-2 border-[var(--tk-copper)] border-t-transparent" />
      <p className="text-sm text-[var(--tk-muted)]">{label}</p>
    </div>
  );
}

export function ErrorState({
  title = "Не удалось загрузить",
  description = "Попробуйте обновить страницу или вернитесь позже.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50/80 px-6 py-10 text-center">
      <h3 className="font-[family-name:var(--font-display)] text-lg text-rose-900">
        {title}
      </h3>
      <p className="mt-2 text-sm text-rose-700">{description}</p>
    </div>
  );
}
