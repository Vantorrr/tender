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
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 basis-48">
          <h3 className="line-clamp-3 break-words font-semibold text-[var(--tk-ink)] group-hover:text-[var(--tk-copper-deep)]">
            {title}
          </h3>
          {subtitle ? (
            <p className="mt-1 line-clamp-2 break-all text-sm text-[var(--tk-muted)]">
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
    "tk-glass group block w-full min-w-0 max-w-full rounded-3xl p-4 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-[0_18px_40px_-18px_rgba(46,58,90,0.35)] sm:p-5",
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
