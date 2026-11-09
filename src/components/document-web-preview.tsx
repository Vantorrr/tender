"use client";

import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { api } from "@/lib/api";
import type { DocumentItem } from "@/lib/types";

type PreviewData =
  | { kind: "pdf" }
  | { kind: "docx"; paragraphs: Array<{ index: number; text: string }> }
  | { kind: "xlsx"; sheets: Array<{ name: string; rows: string[][] }> }
  | { kind: "archive"; files: NonNullable<DocumentItem["extractedFiles"]>; errors: string[] }
  | { kind: "unsupported"; fileName: string };

export function DocumentWebPreview({ document }: { document: DocumentItem }) {
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [error, setError] = useState("");
  const [sheet, setSheet] = useState(0);

  useEffect(() => {
    let alive = true;
    api<PreviewData>(`/api/dokumenty/preview?id=${encodeURIComponent(document.id)}`)
      .then((value) => { if (alive) setPreview(value); })
      .catch((reason) => {
        if (alive) setError(reason instanceof Error ? reason.message : "Не удалось открыть файл");
      });
    return () => { alive = false; };
  }, [document.id]);

  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!preview) return <p className="p-4 text-sm text-[var(--tk-muted)]">Открываем файл…</p>;
  if (preview.kind === "pdf") {
    return <iframe title={document.fileName} src={`/api/dokumenty/file?id=${document.id}&disposition=inline`} className="h-[70vh] w-full rounded-lg border" />;
  }
  if (preview.kind === "docx") {
    return <div className="max-h-[70vh] space-y-3 overflow-auto rounded-lg border bg-white p-5 text-sm leading-relaxed">
      {preview.paragraphs.length ? preview.paragraphs.map((paragraph) => <p key={paragraph.index}>{paragraph.text}</p>) : <p className="text-[var(--tk-muted)]">В документе нет текстовых абзацев.</p>}
    </div>;
  }
  if (preview.kind === "xlsx") {
    const currentSheet = preview.sheets[sheet];
    return <div className="overflow-hidden rounded-lg border bg-white">
      <div className="flex gap-1 overflow-x-auto border-b p-2">
        {preview.sheets.map((item, index) => <button key={item.name} type="button" onClick={() => setSheet(index)} className={`rounded-md px-3 py-1.5 text-sm ${sheet === index ? "bg-slate-900 text-white" : "hover:bg-stone-100"}`}>{item.name}</button>)}
      </div>
      <div className="max-h-[65vh] overflow-auto">
        <table className="min-w-full border-collapse text-xs">
          <tbody>{currentSheet?.rows.map((row, rowIndex) => <tr key={rowIndex} className="border-b even:bg-stone-50">{row.map((cell, colIndex) => <td key={colIndex} className="max-w-[24rem] whitespace-pre-wrap border-r px-2 py-1.5 align-top">{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <p className="border-t px-3 py-2 text-xs text-[var(--tk-muted)]">Показаны первые 500 строк и 30 столбцов листа.</p>
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
