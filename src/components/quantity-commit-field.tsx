"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { sameRoundedQuantity } from "@/lib/format";
import { parseCommittedQuantity } from "@/lib/quantity-draft";

/** Local quantity that saves on Enter or the button, never on focus alone. */
export function QuantityCommitField({
  label,
  value,
  ariaLabel,
  testId,
  disabled = false,
  onCommit,
}: {
  label: string;
  value: number;
  ariaLabel: string;
  testId?: string;
  disabled?: boolean;
  onCommit: (next: number) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(String(value));
    setError(null);
  }, [value]);

  async function commit() {
    if (disabled) return;
    const parsed = parseCommittedQuantity(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (sameRoundedQuantity(value, draft, 4)) {
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onCommit(parsed.value);
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : "Не удалось сохранить количество");
    } finally {
      setSaving(false);
    }
  }

  return (
    <label className="text-xs">
      {label}
      <span className="mt-1 flex flex-wrap items-center gap-1">
        <Input
          className="h-9 w-28"
          inputMode="decimal"
          aria-label={ariaLabel}
          data-testid={testId}
          value={draft}
          disabled={disabled || saving}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commit();
            }
          }}
        />
        <Button type="button" size="sm" variant="outline" disabled={disabled || saving} onClick={() => void commit()}>
          {saving ? "Сохраняю…" : "Сохранить"}
        </Button>
      </span>
      {error ? <span className="mt-1 block text-rose-700" role="alert">{error}</span> : null}
    </label>
  );
}
