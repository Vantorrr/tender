"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { formatDate, parseDateRu } from "@/lib/format";

/**
 * Date field shown as DD.MM.YYYY (never browser US MM/DD).
 * Value prop / onChange use ISO YYYY-MM-DD.
 */
export function DateInputRu({
  value,
  onChange,
  id,
  "data-testid": testId,
  className,
  disabled,
}: {
  value: string;
  onChange: (iso: string) => void;
  id?: string;
  "data-testid"?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(() => (value ? formatDate(value) : ""));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    // Keep the editable text in sync when the parent changes the ISO value.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText(value ? formatDate(value) : "");
    setInvalid(false);
  }, [value]);

  return (
    <Input
      id={id}
      data-testid={testId}
      inputMode="numeric"
      placeholder="ДД.ММ.ГГГГ"
      autoComplete="off"
      lang="ru"
      disabled={disabled}
      className={className}
      value={text}
      aria-invalid={invalid || undefined}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        const iso = parseDateRu(v);
        if (iso) {
          setInvalid(false);
          onChange(iso);
        } else if (v.trim() === "") {
          setInvalid(false);
        } else {
          setInvalid(true);
        }
      }}
      onBlur={() => {
        const iso = parseDateRu(text);
        if (iso) {
          setText(formatDate(iso));
          setInvalid(false);
          onChange(iso);
        } else if (value) {
          setText(formatDate(value));
          setInvalid(false);
        }
      }}
    />
  );
}
