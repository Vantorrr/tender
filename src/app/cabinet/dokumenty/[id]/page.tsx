"use client";

import { useParams } from "next/navigation";
import { toast } from "sonner";
import { ErrorState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { downloadUrl } from "@/lib/api";
import { downloadTextFile, formatDateTime } from "@/lib/format";
import { useStore } from "@/lib/store";

const severityClass = {
  info: "border-sky-200 bg-sky-50 text-sky-900",
  warning: "border-amber-200 bg-amber-50 text-amber-950",
  critical: "border-rose-200 bg-rose-50 text-rose-900",
};

export default function DocumentDetailPage() {
  const params = useParams<{ id: string }>();
  const { orgDocuments, data, reanalyzeDocument } = useStore();
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

  return (
    <div>
      <PageHeader
        title={doc.title}
        description={`${doc.fileName} · закупка ${doc.procurementId}`}
        actions={
          <>
            <StatusBadge status={doc.status} />
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
            <Button
              variant="outline"
              onClick={async () => {
                await reanalyzeDocument(doc.id);
                toast.success("Мок-ИИ pipeline: записка и версия обновлены");
              }}
            >
              Переразобрать (мок-ИИ)
            </Button>
            <Button
              onClick={() => {
                const content = [
                  `Аналитическая записка: ${doc.title}`,
                  "",
                  doc.analyticalNote,
                  "",
                  "Цитаты:",
                  ...doc.citations.map(
                    (c) => `- [${c.sourceFile}, с.${c.page}] ${c.text}`
                  ),
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

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <section className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
            <h2 className="font-[family-name:var(--font-display)] text-base">
              Аналитическая записка
            </h2>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-[var(--tk-ink-soft)]">
              {doc.analyticalNote}
            </p>
          </section>

          <section className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
            <h2 className="font-[family-name:var(--font-display)] text-base">
              Цитаты из источника
            </h2>
            <ul className="mt-3 space-y-3">
              {doc.citations.length === 0 ? (
                <li className="text-sm text-[var(--tk-muted)]">
                  Цитаты появятся после завершения разбора.
                </li>
              ) : (
                doc.citations.map((c) => (
                  <li
                    key={c.id}
                    className="rounded-lg border-l-4 border-[var(--tk-copper)] bg-[var(--tk-steel-50)]/60 px-3 py-2 text-sm"
                  >
                    <p>«{c.text}»</p>
                    <p className="mt-1 text-xs text-[var(--tk-muted)]">
                      {c.sourceFile}, стр. {c.page}
                    </p>
                  </li>
                ))
              )}
            </ul>
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
    </div>
  );
}
