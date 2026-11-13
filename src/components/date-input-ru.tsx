"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { formatDate, parseDateRu } from "@/lib/format";

/**
 * Date field shown as DD.MM.YYYY (never browser US MM/DD).
 * Value prop / onChange use ISO YYYY-MM-DD.
 *
 * Commits only on blur (or Enter) so partial edits like «15.03.2026» → «1.03.2026»
 * never fire an intermediate save while the user is still typing.
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

  function commit(raw: string) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      setInvalid(false);
      if (value) {
        setText(formatDate(value));
      }
      return;
    }
    const iso = parseDateRu(trimmed);
    if (iso) {
      setText(formatDate(iso));
      setInvalid(false);
      if (iso !== value) onChange(iso);
      return;
    }
    setInvalid(true);
    if (value) {
      setText(formatDate(value));
      setInvalid(false);
    }
  }

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
        if (v.trim() === "") {
          setInvalid(false);
          return;
        }
        setInvalid(parseDateRu(v) == null);
      }}
      onBlur={() => commit(text)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit(text);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
}
