"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

export function BatchUploadZone({
  disabled,
  accept,
  testId = "batch-upload",
  label = "Выбрать файлы",
  hint,
  onFiles,
}: {
  disabled?: boolean;
  accept: string;
  testId?: string;
  label?: string;
  hint?: string;
  onFiles: (files: File[]) => void;
}) {
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  function take(list: FileList | null) {
    const files = [...(list ?? [])];
    if (files.length) onFiles(files);
  }

  return (
    <div
      data-testid={testId}
      className={`rounded-xl border border-dashed px-3 py-3 ${over ? "border-[var(--tk-copper)] bg-amber-50" : "border-[var(--tk-line)] bg-white/70"}`}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        if (disabled) return;
        take(event.dataTransfer.files);
      }}
    >
      <input
        ref={filesRef}
        type="file"
        multiple
        accept={accept}
        className="sr-only"
        data-testid={`${testId}-files`}
        aria-label="Выбрать несколько файлов"
        disabled={disabled}
        onChange={(event) => {
          take(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={folderRef}
        type="file"
        multiple
        className="sr-only"
        data-testid={`${testId}-folder`}
        aria-label="Выбрать папку"
        disabled={disabled}
        {...{ webkitdirectory: "true", directory: "true" }}
        onChange={(event) => {
          take(event.target.files);
          event.target.value = "";
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={disabled} data-testid={`${testId}-pick`} onClick={() => filesRef.current?.click()}>
          {label}
        </Button>
        <Button type="button" variant="outline" disabled={disabled} data-testid={`${testId}-pick-folder`} onClick={() => folderRef.current?.click()}>
          Выбрать папку
        </Button>
        <span className="text-xs text-[var(--tk-muted)]">Или перетащите файлы сюда</span>
      </div>
      {hint ? <p className="mt-2 text-xs text-[var(--tk-muted)]">{hint}</p> : null}
    </div>
  );
}
