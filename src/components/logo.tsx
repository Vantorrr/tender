import { cn } from "@/lib/utils";

function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 36 36"
      aria-hidden
      className={cn("shrink-0", className)}
    >
      <rect width="36" height="36" rx="10" fill="#e8a15a" />
      <path d="M18 7.6 27.4 12.8 18 18 8.6 12.8Z" fill="#1a120c" />
      <path d="M8.6 12.8 18 18v10.2L8.6 23Z" fill="#2a2118" />
      <path d="M27.4 12.8 18 18v10.2l9.4-5.2Z" fill="#1a120c" />
      <path d="M21.1 19.2 23.6 17.8v3.1l-2.5 1.4Z" fill="#e8a15a" />
      <path d="M12.2 19.4 14.6 20.7v2.6l-2.4-1.3Z" fill="#e8a15a" />
    </svg>
  );
}

export function Logo({
  wordmark = true,
  className,
  markClassName = "h-9 w-9",
  titleClassName = "text-[15px]",
}: {
  wordmark?: boolean;
  className?: string;
  markClassName?: string;
  titleClassName?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <LogoMark className={markClassName} />
      {wordmark ? (
        <span className="min-w-0 leading-tight">
          <span
            className={cn(
              "block truncate font-[family-name:var(--font-display)] font-semibold tracking-tight text-white",
              titleClassName
            )}
          >
            ТендерКонтур
          </span>
        </span>
      ) : null}
    </span>
  );
}
