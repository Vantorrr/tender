import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:mb-9 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 animate-fade-slide">
        <h1 className="font-[family-name:var(--font-display)] text-[1.7rem] font-semibold leading-[1.15] tracking-[-0.03em] text-[var(--tk-ink)] sm:text-[2rem]">
          {title}
        </h1>
        {description ? (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--tk-muted)] sm:text-[0.975rem]">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2 animate-fade-slide">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
