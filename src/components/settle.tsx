"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Появление как на витрине Apple: из дымки, снизу, с длинным затуханием. */
export function Settle({
  children,
  delay = 0,
  y = 28,
  blur = 10,
  className,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  blur?: number;
  className?: string;
}) {
  const [on, setOn] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setOn(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);

  return (
    <div
      className={cn("tk-settle", on && "is-on", done && "is-done", className)}
      style={
        {
          animationDelay: `${delay}ms`,
          "--settle-y": `${y}px`,
          "--settle-blur": `${blur}px`,
        } as CSSProperties
      }
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setDone(true);
      }}
    >
      {children}
    </div>
  );
}
