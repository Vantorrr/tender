import Link from "next/link";
import type { ReactNode } from "react";
import { StatusBadge } from "@/components/status-badge";
import type { CardStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export function EntityCard({
  href,
  title,
  subtitle,
  status,
  meta,
  footer,
  className,
}: {
  href?: string;
  title: string;
  subtitle?: string;
  status?: CardStatus;
  meta?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const inner = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-[var(--tk-ink)] group-hover:text-[var(--tk-copper-deep)]">
            {title}
          </h3>
          {subtitle ? (
            <p className="mt-1 truncate text-sm text-[var(--tk-muted)]">
              {subtitle}
            </p>
          ) : null}
        </div>
        {status ? <StatusBadge status={status} /> : null}
      </div>
      {meta ? <div className="mt-4 text-sm text-[var(--tk-muted)]">{meta}</div> : null}
      {footer ? (
        <div className="mt-4 border-t border-[var(--tk-line)] pt-3">{footer}</div>
      ) : null}
    </>
  );

  const classes = cn(
    "group block rounded-2xl border border-[var(--tk-line)] bg-white p-4 shadow-[0_1px_2px_rgba(18,21,28,0.04)] transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-[#d8dbe3] hover:shadow-[0_12px_30px_-18px_rgba(18,21,28,0.35)] sm:p-5",
    className
  );

  if (href) {
    return (
      <Link href={href} className={classes}>
        {inner}
      </Link>
    );
  }
  return <div className={classes}>{inner}</div>;
}
