"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { formatDate, parseDateRu } from "@/lib/format";

/**
 * Date field shown as DD.MM.YYYY (never browser US MM/DD).
 * Value prop / onChange use ISO YYYY-MM-DD.
 *
 * Commits only on blur (or Enter) so partial edits like «15.03.2026» → «1.03.2026»
 * never fire an intermediate save while the user is still typing.
 *
 * Enter commits once: we skip the subsequent blur commit, and also dedupe
 * against the last emitted ISO so Gantt relative shifts cannot double-apply.
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
  const lastEmittedIso = useRef(value);
  const skipNextBlurCommit = useRef(false);

  useEffect(() => {
    // Keep the editable text in sync when the parent changes the ISO value.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText(value ? formatDate(value) : "");
    setInvalid(false);
    lastEmittedIso.current = value;
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
      // Dedupe: Enter then blur must not fire onChange twice before parent re-renders.
      if (iso !== lastEmittedIso.current) {
        lastEmittedIso.current = iso;
        onChange(iso);
      }
      return;
    }
    // Keep the invalid text visible with an error (do not silently revert mid-feedback).
    setInvalid(true);
  }

  const errorId = testId ? `${testId}-error` : id ? `${id}-error` : undefined;

  return (
    <div className="grid gap-1">
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
        aria-describedby={invalid && errorId ? errorId : undefined}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          if (v.trim() === "") {
            setInvalid(false);
            return;
          }
          setInvalid(parseDateRu(v) == null);
        }}
        onBlur={() => {
          if (skipNextBlurCommit.current) {
            skipNextBlurCommit.current = false;
            return;
          }
          commit(text);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(text);
            // Blur for UX, but do not re-commit on the blur that follows Enter.
            skipNextBlurCommit.current = true;
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
      />
      {invalid ? (
        <p
          id={errorId}
          data-testid={errorId}
          className="text-[11px] font-medium text-rose-700"
          role="alert"
        >
          Неверная дата — укажите ДД.ММ.ГГГГ
        </p>
      ) : null}
    </div>
  );
}

/** Pure helper for regression: emit only when ISO differs from last emitted. */
export function nextEmittedIso(
  lastEmitted: string,
  candidate: string | null
): string | null {
  if (!candidate || candidate === lastEmitted) return null;
  return candidate;
}
