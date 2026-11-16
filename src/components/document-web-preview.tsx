"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { api, getClientToken } from "@/lib/api";
import type { DocumentItem } from "@/lib/types";

type PreviewData =
  | { kind: "pdf" }
  | { kind: "image" }
  | { kind: "docx"; paragraphs: Array<{ index: number; text: string }> }
  | { kind: "xlsx"; sheets: Array<{ name: string; rows: string[][] }> }
  | { kind: "archive"; files: NonNullable<DocumentItem["extractedFiles"]>; errors: string[] }
  | { kind: "unsupported"; fileName: string };

export function DocumentWebPreview({ document }: { document: DocumentItem }) {
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [error, setError] = useState("");
  const [sheet, setSheet] = useState(0);
  const [search, setSearch] = useState("");
  const [docxLoaded, setDocxLoaded] = useState(false);
  const [docxRenderError, setDocxRenderError] = useState("");
  const docxBodyRef = useRef<HTMLDivElement>(null);
  const docxStylesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api<PreviewData>(`/api/dokumenty/preview?id=${encodeURIComponent(document.id)}`)
      .then((value) => { if (alive) setPreview(value); })
      .catch((reason) => {
        if (alive) setError(reason instanceof Error ? reason.message : "Не удалось открыть файл");
      });
    return () => { alive = false; };
  }, [document.id]);

  useEffect(() => {
    if (preview?.kind !== "docx") return;
    const controller = new AbortController();
    let alive = true;
    const bodyElement = docxBodyRef.current;
    const stylesElement = docxStylesRef.current;
    void (async () => {
      try {
        const token = getClientToken();
        const response = await fetch(
          `/api/dokumenty/file?id=${encodeURIComponent(document.id)}&disposition=inline`,
          {
            credentials: "include",
            signal: controller.signal,
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          }
        );
        if (!response.ok) throw new Error(`Не удалось открыть оригинал (${response.status})`);
        const blob = await response.blob();
        const { renderAsync } = await import("docx-preview");
        if (!alive || !bodyElement || !stylesElement) return;
        await renderAsync(blob, bodyElement, stylesElement, {
          className: "tma361-docx",
          inWrapper: true,
          breakPages: true,
          renderAltChunks: false,
        });
        if (alive) setDocxLoaded(true);
      } catch (reason) {
        if (alive && !controller.signal.aborted) {
          setDocxRenderError(reason instanceof Error ? reason.message : "Не удалось отобразить DOCX");
        }
      }
    })();
    return () => {
      alive = false;
      controller.abort();
      bodyElement?.replaceChildren();
      stylesElement?.replaceChildren();
    };
  }, [document.id, preview?.kind]);

  const currentSheet = preview?.kind === "xlsx" ? preview.sheets[sheet] : undefined;
  const query = search.trim().toLocaleLowerCase("ru-RU");
  const visibleRows = useMemo(() => (currentSheet?.rows ?? [])
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !query || row.some((cell) => cell.toLocaleLowerCase("ru-RU").includes(query))), [currentSheet, query]);

  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!preview) return <p className="p-4 text-sm text-[var(--tk-muted)]">Открываем файл…</p>;
  if (preview.kind === "pdf") {
    return <iframe title={document.fileName} src={`/api/dokumenty/file?id=${document.id}&disposition=inline`} className="h-[70vh] w-full rounded-lg border" />;
  }
  if (preview.kind === "image") {
    return <div className="max-h-[75vh] overflow-auto rounded-lg border bg-stone-100 p-2">
      {/* The file endpoint checks the user's session and organization before serving bytes. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/dokumenty/file?id=${encodeURIComponent(document.id)}&disposition=inline`}
        alt={document.fileName}
        className="mx-auto h-auto max-w-full object-contain"
      />
    </div>;
  }
  if (preview.kind === "docx") {
    return <div className="max-h-[75vh] overflow-auto rounded-lg border bg-stone-100 p-4" data-testid="docx-document-preview">
      <div ref={docxStylesRef} />
      <div ref={docxBodyRef} />
      {docxRenderError ? <Alert variant="destructive" className="mt-3"><AlertDescription>{docxRenderError} · Ниже показан текстовый запасной просмотр.</AlertDescription></Alert> : null}
      {docxRenderError ? <div className="mt-3 space-y-2 rounded-lg bg-white p-5 text-sm leading-relaxed">{preview.paragraphs.map((paragraph) => <p key={paragraph.index}>{paragraph.text}</p>)}</div> : null}
      {!docxLoaded && !docxRenderError ? <p className="p-4 text-sm text-[var(--tk-muted)]">Загружаем форматированный документ…</p> : null}
    </div>;
  }
  if (preview.kind === "xlsx") {
    const columnName = (index: number) => {
      let value = index + 1;
      let label = "";
      while (value > 0) {
        value -= 1;
        label = String.fromCharCode(65 + (value % 26)) + label;
        value = Math.floor(value / 26);
      }
      return label;
    };
    return <div className="overflow-hidden rounded-lg border bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-stone-50 p-3">
        <div className="flex min-w-0 gap-1 overflow-x-auto" role="tablist" aria-label="Листы таблицы">
          {preview.sheets.map((item, index) => <button key={item.name} type="button" role="tab" aria-selected={sheet === index} onClick={() => setSheet(index)} className={`shrink-0 rounded-md px-3 py-1.5 text-sm ${sheet === index ? "bg-slate-900 text-white" : "hover:bg-stone-200"}`}>{item.name}</button>)}
        </div>
        <label className="flex min-w-[15rem] flex-1 items-center gap-2 sm:max-w-sm">
          <span className="sr-only">Поиск по ячейкам листа</span>
          <Input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти в листе…" aria-label="Поиск по ячейкам листа" className="h-9 bg-white" />
        </label>
      </div>
      <div className="max-h-[65vh] overflow-auto">
        <table className="min-w-full border-collapse text-xs tabular-nums" data-testid="spreadsheet-document-preview">
          <caption className="sr-only">Предпросмотр листа {currentSheet?.name ?? ""}</caption>
          <thead className="sticky top-0 z-20 bg-slate-100 text-[var(--tk-muted)] shadow-sm">
            <tr>
              <th scope="col" className="sticky left-0 z-30 min-w-12 border-b border-r bg-slate-100 px-2 py-2 text-center font-medium">№</th>
              {Array.from({ length: Math.max(0, ...((currentSheet?.rows ?? []).map((row) => row.length))) }, (_, colIndex) => <th key={colIndex} scope="col" className="min-w-24 border-b border-r px-2 py-2 text-center font-medium">{columnName(colIndex)}</th>)}
            </tr>
          </thead>
          <tbody>{visibleRows.map(({ row, index }) => <tr key={index} className="border-b even:bg-stone-50 hover:bg-amber-50/70" data-testid="spreadsheet-preview-row">
            <th scope="row" className="sticky left-0 z-10 border-r bg-stone-100 px-2 py-1.5 text-center font-medium text-[var(--tk-muted)]">{index + 1}</th>
            {row.map((cell, colIndex) => {
              const displayValue = cell.trim();
              return <td key={colIndex} title={displayValue || undefined} className={`max-w-[24rem] border-r px-2 py-1.5 align-top ${/^-?\d[\d\s.,]*%?$/.test(displayValue) ? "whitespace-nowrap text-right" : "min-w-32 whitespace-pre-wrap"}`}><span className="block max-h-12 overflow-y-auto">{displayValue || <span aria-hidden="true" className="text-stone-300">&nbsp;</span>}</span></td>;
            })}
          </tr>)}</tbody>
        </table>
        {!visibleRows.length ? <p className="px-4 py-8 text-center text-sm text-[var(--tk-muted)]">{query ? "Совпадений не найдено." : "На листе нет заполненных строк."}</p> : null}
      </div>
      <p className="border-t bg-stone-50 px-3 py-2 text-xs text-[var(--tk-muted)]" aria-live="polite">Лист «{currentSheet?.name ?? "—"}» · строк в предпросмотре: {visibleRows.length}{query ? ` из ${currentSheet?.rows.length ?? 0}` : ""} · максимум 500 строк и 30 столбцов.</p>
    </div>;
  }
  if (preview.kind === "archive") return <div className="space-y-3">
    <section className="rounded-lg border bg-white p-4">
      <h3 className="font-medium">Файлы в архиве</h3>
      {preview.files.length ? <ul className="mt-2 space-y-1 text-sm">{preview.files.map((file) => <li key={file.relativePath}>{file.relativePath} <span className="text-xs text-[var(--tk-muted)]">· {Math.ceil(file.size / 1024)} КБ</span></li>)}</ul> : <p className="mt-2 text-sm text-[var(--tk-muted)]">Поддерживаемые документы не найдены.</p>}
    </section>
    {preview.errors.length ? <Alert variant="destructive"><AlertDescription>{preview.errors.join("; ")}</AlertDescription></Alert> : null}
  </div>;
  return <p className="p-4 text-sm text-[var(--tk-muted)]">Для этого формата доступно скачивание файла.</p>;
}
