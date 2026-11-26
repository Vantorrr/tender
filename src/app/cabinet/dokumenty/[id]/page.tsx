"use client";

import { useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { AiFailureBanner } from "@/components/ai-failure-banner";
import { ErrorState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { DocumentWebPreview } from "@/components/document-web-preview";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { downloadUrl } from "@/lib/api";
import { downloadTextFile, formatDateTime } from "@/lib/format";
import { presentAnalyticalNote } from "@/lib/analytical-note";
import { calcMemoState } from "@/lib/wave23";
import { readableCitations } from "@/lib/citation-display";
import { useStore } from "@/lib/store";

const severityClass = {
  info: "border-sky-200 bg-sky-50 text-sky-900",
  warning: "border-amber-200 bg-amber-50 text-amber-950",
  critical: "border-rose-200 bg-rose-50 text-rose-900",
};

function NoteEditor({
  docId,
  initialNote,
}: {
  docId: string;
  initialNote: string;
}) {
  const { updateDocument } = useStore();
  const [note, setNote] = useState(initialNote);
  const [saving, setSaving] = useState(false);

  return (
    <section className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
      <h2 className="font-[family-name:var(--font-display)] text-base">
        Аналитическая записка
      </h2>
      <p className="mt-1 text-xs text-[var(--tk-muted)]">
        Можно править вручную — сохранится новая версия документа. Неподтверждённое
        оставляйте как «нет данных». Отмены нет: верните текст вручную.
      </p>
      <textarea
        className="mt-3 min-h-[160px] w-full rounded-lg border border-[var(--tk-line)] bg-white px-3 py-2 text-sm leading-relaxed text-[var(--tk-ink-soft)]"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="mt-3 flex gap-2">
        <Button
          variant="outline"
          disabled={saving || note === initialNote}
          onClick={async () => {
            setSaving(true);
            try {
              await updateDocument(docId, { analyticalNote: note });
              toast.success("Записка сохранена (новая версия)");
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Ошибка сохранения");
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Сохранение…" : "Сохранить правку"}
        </Button>
      </div>
    </section>
  );
}

export default function DocumentDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const anchor = {
    page: searchParams.get("page") ?? undefined,
    sheet: searchParams.get("sheet") ?? undefined,
    cell: searchParams.get("cell") ?? undefined,
    paragraph: searchParams.get("paragraph") ?? undefined,
  };
  const anchorLabel = [
    anchor.page ? `страница ${anchor.page}` : "",
    anchor.sheet ? `лист ${anchor.sheet}` : "",
    anchor.cell ? `ячейка ${anchor.cell}` : "",
    anchor.paragraph ? `абзац ${anchor.paragraph}` : "",
  ].filter(Boolean).join(", ");
  const { orgDocuments, data, reanalyzeDocument } = useStore();
  const [retryingAi, setRetryingAi] = useState(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryNotice, setSummaryNotice] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(Boolean(anchorLabel));
  const [askModel, setAskModel] = useState(false);
  const [noteExpanded, setNoteExpanded] = useState(false);
  const doc = orgDocuments.find((d) => d.id === params.id);

  if (!doc) {
    return (
      <ErrorState
        title="Документ не найден"
        description="Документ отсутствует или относится к другой организации."
      />
    );
  }

  const author = (id: string) =>
    data.users.find((u) => u.id === id)?.name ?? id;
  const displayCitations = readableCitations(doc.citations.filter((citation) => citation.confidence !== "ocr" && citation.sourceVersion !== "ocr-extract"));
  const linkedProcurement = data.procurements.find((item) => item.id === doc.procurementId);
  const linkedCalc = data.calculations.find((item) => item.id === linkedProcurement?.calculationId);
  const note = presentAnalyticalNote(doc.analyticalNote, calcMemoState(linkedCalc));

  return (
    <div>
      <PageHeader
        title={doc.title}
        description={`${doc.fileName} · ${
          data.procurements.find((item) => item.id === doc.procurementId)?.title ??
          "закупка"
        }`}
        actions={
          <>
            <Button variant="outline" onClick={() => router.push("/cabinet/dokumenty")}>Назад</Button>
            <StatusBadge status={doc.status} />
            <Button
              variant="outline"
              onClick={() => setPreviewOpen((open) => !open)}
            >
              {previewOpen ? "Закрыть просмотр" : "Открыть в веб"}
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  await downloadUrl(`/api/dokumenty/file?id=${doc.id}`);
                  toast.success("Файл скачан");
                } catch (e) {
                  toast.error(
                    e instanceof Error ? e.message : "Ошибка скачивания"
                  );
                }
              }}
            >
              Скачать файл
            </Button>
            {doc.category === "archive" || /\.(zip|rar|7z|tar|gz|tgz)$/i.test(doc.fileName) ? (
              <Button
                variant="outline"
                disabled={summaryBusy}
                data-testid="reextract-archive"
                onClick={async () => {
                  setSummaryBusy(true);
                  try {
                    await reanalyzeDocument(doc.id, { useLlm: false });
                    toast.success("Архив распакован снова, вложенные файлы проиндексированы");
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : "Не удалось распаковать архив");
                  } finally {
                    setSummaryBusy(false);
                  }
                }}
              >
                Распаковать снова
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={summaryBusy}
              onClick={async () => {
                const before = doc.analyticalNote;
                setSummaryBusy(true);
                setSummaryNotice("Обновляю сводку…");
                try {
                  const next = await reanalyzeDocument(doc.id, { useLlm: false });
                  const text = next.trim() === before.trim() ? "Новых данных нет — записка уже актуальна" : "Сводка обновлена";
                  setSummaryNotice(text);
                  toast.success(text);
                } catch (error) {
                  setSummaryNotice(null);
                  toast.error(error instanceof Error ? error.message : "Не удалось обновить сводку");
                } finally {
                  setSummaryBusy(false);
                }
              }}
            >
              {summaryBusy ? "Обновляю сводку…" : "Обновить сводку"}
            </Button>
            <Button onClick={() => setAskModel(true)}>
              Полный анализ ИИ
            </Button>
            <Button
              onClick={() => {
                const content = [
                  `Аналитическая записка: ${doc.title}`,
                  "",
                  note.text,
                  "",
                  "Цитаты:",
                  ...doc.citations.map((c) => {
                    const loc = [
                      c.sheet ? `лист ${c.sheet}` : null,
                      c.cell ? `яч. ${c.cell}` : null,
                      c.paragraph != null ? `абз. ${c.paragraph}` : null,
                      !c.sheet && !c.cell ? `с.${c.page}` : null,
                      c.sourceVersion ?? null,
                      c.confidence ?? null,
                    ]
                      .filter(Boolean)
                      .join(", ");
                    return `- [${c.sourceFile}${loc ? `; ${loc}` : ""}] ${c.text}`;
                  }),
                ].join("\n");
                downloadTextFile(
                  `zapiska-${doc.id}.txt`,
                  content,
                  "text/plain;charset=utf-8"
                );
                toast.success("Записка экспортирована");
              }}
            >
              Экспорт записки
            </Button>
          </>
        }
      />

      {summaryNotice ? <p className="mb-4 text-sm" role="status" data-testid="document-summary-status">{summaryNotice}</p> : null}

      {doc.aiFailure ? (
        <div className="mb-4">
          <AiFailureBanner
            status={doc.aiFailure}
            pending={retryingAi}
            onRetry={() => {
              setRetryingAi(true);
              void reanalyzeDocument(doc.id, { useLlm: true })
                .then(() => toast.success("Повторный анализ документа завершён"))
                .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Не удалось повторить анализ"))
                .finally(() => setRetryingAi(false));
            }}
          />
        </div>
      ) : null}

      {previewOpen ? (
        <section className="mb-4 rounded-xl border border-[var(--tk-line)] bg-white p-3">
          {anchorLabel ? <p className="mb-3 rounded-lg bg-amber-100 px-3 py-2 text-sm" data-testid="citation-anchor">Открыт фрагмент: {anchorLabel}</p> : null}
          <DocumentWebPreview key={doc.id} document={doc} highlight={anchor} />
        </section>
      ) : null}

      {doc.analysis ? (
        <section className="mb-4 grid gap-3 rounded-xl border border-[var(--tk-line)] bg-white/80 p-5 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Продукт", doc.analysis.vendor || "—"],
            ["Регион", doc.analysis.region || "—"],
            ["Зона", doc.analysis.zone || "—"],
            [
              "Стоимость",
              doc.analysis.costThousand != null
                ? `${doc.analysis.costThousand.toLocaleString("ru-RU")} тыс. руб.`
                : "—",
            ],
            ["Смета", doc.analysis.estimateNumber || "—"],
            ["Работы", doc.analysis.workName || "—"],
            ["Основание", doc.analysis.basis || "—"],
            ["Уровень цен", doc.analysis.priceLevel || "—"],
            ["Текст записки", doc.analysis.narrator || "по ячейкам сметы"],
          ].filter(([label, value]) => value !== "—" && value !== "" && (label !== "Зона" || !/^(?:нет данных|не указана|не указано)$/iu.test(String(value)))).map(([label, value]) => (
            <div key={label}>
              <div className="text-xs text-[var(--tk-muted)]">{label}</div>
              <div className="mt-1 text-sm leading-snug">{value}</div>
            </div>
          ))}
        </section>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {note.clipped ? (
            <section className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
              <p className="whitespace-pre-line text-sm leading-relaxed">{noteExpanded ? note.text : note.preview}</p>
              <button type="button" className="mt-2 text-sm font-medium text-[var(--tk-brand)] underline" onClick={() => setNoteExpanded((open) => !open)}>
                {noteExpanded ? "Свернуть" : "Показать полностью"}
              </button>
            </section>
          ) : null}
          {note.text ? (
            <NoteEditor
              key={`${doc.id}:${doc.versions.length}:${note.text.slice(0, 24)}`}
              docId={doc.id}
              initialNote={note.text}
            />
          ) : null}
          {note.recognized ? (
            <section className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
              {note.text ? null : <h2 className="font-[family-name:var(--font-display)] text-base">Записка</h2>}
              <p className="mt-2 text-sm">Текст распознан автоматически, сверьте с оригиналом</p>
              <Button className="mt-3" variant="outline" onClick={() => setPreviewOpen(true)}>Открыть документ</Button>
            </section>
          ) : null}
          {!note.text && !note.recognized ? (
            <NoteEditor
              key={`${doc.id}:${doc.versions.length}:empty`}
              docId={doc.id}
              initialNote=""
            />
          ) : null}

          <section className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
            <h2 className="font-[family-name:var(--font-display)] text-base">
              Подтверждающие фрагменты
            </h2>
            <p className="mt-1 text-sm text-[var(--tk-muted)]">Короткие выдержки с понятным названием темы. Пустые поля и служебные шифры скрыты.</p>
            <ul className="mt-3 space-y-3">
              {displayCitations.length === 0 ? (
                <li className="text-sm text-[var(--tk-muted)]">
                  В документе пока нет содержательных фрагментов для показа.
                </li>
              ) : (
                displayCitations.slice(0, 5).map((c) => (
                  <li
                    key={c.id}
                    className="min-w-0 rounded-lg border border-[var(--tk-line)] bg-white px-3 py-3 text-sm"
                  >
                    <span className="inline-flex rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-[var(--tk-muted)]">{c.topicLabel}</span>
                    <p className="mt-2 break-words leading-relaxed [overflow-wrap:anywhere]">{c.displayText}</p>
                    <p className="mt-2 break-words text-xs text-[var(--tk-muted)] [overflow-wrap:anywhere]">
                      {c.sourceFile}
                      {c.sheet ? ` · лист «${c.sheet}»` : ""}
                      {c.cell ? ` · область таблицы ${c.cell}` : ""}
                      {c.paragraph != null ? ` · абзац ${c.paragraph}` : ""}
                      {!c.sheet && !c.cell ? ` · стр. ${c.page}` : ""}
                    </p>
                  </li>
                ))
              )}
            </ul>
            {displayCitations.length > 5 ? (
              <details className="mt-3 rounded-lg border border-[var(--tk-line)] bg-stone-50 px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium">Остальные фрагменты ({displayCitations.length - 5})</summary>
                <ul className="mt-3 space-y-2">
                  {displayCitations.slice(5).map((c) => (
                    <li key={c.id} className="min-w-0 rounded-lg border border-[var(--tk-line)] bg-white px-3 py-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-[var(--tk-muted)]">{c.topicLabel}</span>
                        <span className="break-all text-xs text-[var(--tk-muted)]">{c.sourceFile}{c.sheet ? ` · лист «${c.sheet}»` : ""}{c.cell ? ` · ${c.cell}` : ""}{!c.sheet && c.page ? ` · стр. ${c.page}` : ""}</span>
                      </div>
                      <p className="mt-2 break-words leading-relaxed [overflow-wrap:anywhere]">{c.displayText}</p>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>

          <section className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
            <h2 className="font-[family-name:var(--font-display)] text-base">
              Подсветки для ручной проверки
            </h2>
            <ul className="mt-3 space-y-3">
              {doc.highlights.length === 0 ? (
                <li className="text-sm text-[var(--tk-muted)]">
                  Критичных фрагментов не выявлено.
                </li>
              ) : (
                doc.highlights.map((h) => (
                  <li
                    key={h.id}
                    className={`rounded-lg border px-3 py-2 text-sm ${severityClass[h.severity]}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{h.text}</span>
                      <Badge variant="outline">стр. {h.page}</Badge>
                    </div>
                    <p className="mt-1 opacity-90">{h.reason}</p>
                  </li>
                ))
              )}
            </ul>
          </section>
        </div>

        <section className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-5 h-fit">
          <h2 className="font-[family-name:var(--font-display)] text-base">
            Версии
          </h2>
          <ol className="mt-3 space-y-3">
            {[...doc.versions].reverse().map((v) => (
              <li
                key={v.id}
                className="rounded-lg border border-[var(--tk-line)] px-3 py-2 text-sm"
              >
                <div className="font-medium">Версия {v.version}</div>
                <div className="text-xs text-[var(--tk-muted)]">
                  {author(v.authorId)} · {formatDateTime(v.at)}
                </div>
                <div className="mt-1">{v.note}</div>
              </li>
            ))}
          </ol>
        </section>
      </div>
      <Dialog open={askModel} onOpenChange={setAskModel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Сформировать записку моделью?</DialogTitle>
            <DialogDescription>Это платный вызов внешнего сервиса анализа.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAskModel(false)}>Отмена</Button>
            <Button onClick={() => {
              setAskModel(false);
              void reanalyzeDocument(doc.id, { useLlm: true })
                .then(() => toast.success("Записка обновлена с участием модели"))
                .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Ошибка анализа моделью"));
            }}>Сформировать</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
