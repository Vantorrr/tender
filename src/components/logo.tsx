import { cn } from "@/lib/utils";

/** Трассировка знака «и» из фирменного файла истройки. */
const MARK_PATH =
  "M50 213.31C29.8 209.93 15.49 197.11 9.1 176.66L6.54 168.5 6.22 91.75 5.91 15H69v60.78c0 83.3-2.33 81.59 38.53 28.22 50.68-66.22 62.66-78.98 84.47-89.99 24.11-12.18 53.91-9.28 67.89 6.6 10.94 12.43 12.03 19.11 12.08 73.71.03 45.74.13 46.68 4.92 46.68 3.97 0 9.09-5.75 31.6-35.5 50.19-66.33 61.53-78.58 83.69-90.42 30.39-16.24 65.31-8.87 77.21 16.28 5.04 10.66 4.96 9.14 5.34 95.89l.36 81.75H412v-61.43c0-62.74-.16-65.52-3.95-67.54-4.55-2.44-2.53-4.73-39.75 44.97-46.41 61.95-56.15 72.66-74.8 82.25-28.08 14.43-66.09 5.03-77.79-19.25-5.83-12.1-6-13.73-6.46-61.79l-.43-44.28-2.36-1.55c-4.28-2.8-5.96-.95-39.63 43.94-50.5 67.32-57.31 74.68-77.62 83.88-10.86 4.93-27.41 7.08-39.21 5.11Z";

export const BRAND = {
  green: "#1E5241",
  ink: "#2B2020",
  name: "истройка",
} as const;

export function LogoMark({
  className,
  color = "currentColor",
}: {
  className?: string;
  color?: string;
}) {
  return (
    <svg
      viewBox="0 -6 482 232"
      aria-hidden
      className={cn("shrink-0", className)}
    >
      <path fill={color} d={MARK_PATH} />
    </svg>
  );
}

export function LogoIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden className={cn("shrink-0", className)}>
      <rect width="64" height="64" rx="16" fill={BRAND.green} />
      <svg x="6" y="20" width="52" height="24" viewBox="0 -6 482 232">
        <path fill="#fff" d={MARK_PATH} />
      </svg>
    </svg>
  );
}

export function Logo({
  wordmark = true,
  tone = "light",
  className,
  markClassName = "h-9 w-9",
  titleClassName = "text-[15px]",
}: {
  wordmark?: boolean;
  tone?: "light" | "ink";
  className?: string;
  markClassName?: string;
  titleClassName?: string;
}) {
  const onDark = tone === "light";
  const mark = onDark ? "#ffffff" : BRAND.green;
  const text = onDark ? "#ffffff" : BRAND.ink;

  if (!wordmark) {
    return (
      <span className={cn("inline-flex", className)} role="img" aria-label={BRAND.name}>
        <LogoIcon className={markClassName} />
      </span>
    );
  }

  return (
    <span
      role="img"
      aria-label={BRAND.name}
      className={cn(
        "inline-flex min-w-0 items-center gap-[0.22em] font-[family-name:var(--font-display)] font-semibold leading-none tracking-[-0.03em]",
        titleClassName,
        className
      )}
      style={{ color: text }}
    >
      <LogoMark color={mark} className="h-[0.72em] w-auto" />
      <span className="truncate">
        стройка
        <span style={{ color: onDark ? "#8ED4B8" : BRAND.green }}>.</span>
      </span>
    </span>
  );
}
