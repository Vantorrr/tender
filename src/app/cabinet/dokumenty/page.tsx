"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { EntityCard } from "@/components/entity-card";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/format";
import { useStore } from "@/lib/store";

export default function DokumentyPage() {
  const { orgDocuments, user, createDocumentUpload, orgProcurements } =
    useStore();
  const [q, setQ] = useState("");
  const [pickedId, setPickedId] = useState("");
  const procurementId = pickedId || orgProcurements[0]?.id || "";
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = orgDocuments.filter((d) => {
    if (!q) return true;
    return `${d.title} ${d.fileName}`.toLowerCase().includes(q.toLowerCase());
  });

  async function handleFile(file: File) {
    if (!procurementId) {
      toast.error("Сначала выберите закупку");
      return;
    }
    try {
      await createDocumentUpload({
        procurementId,
        title: file.name.replace(/\.[^.]+$/, ""),
        file,
      });
      toast.success(`Файл «${file.name}» сохранён на сервере`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Ошибка загрузки");
    }
  }

  return (
    <div>
      <PageHeader
        title="Документы"
        description="Раздел убран из сайдбара: работайте с файлами внутри карточки закупки. Эта страница — deep-link / список."
        actions={
          <>
            <select
              data-testid="doc-procurement"
              aria-label="Закупка для загрузки"
              className="flex h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm sm:w-[220px]"
              value={procurementId}
              onChange={(e) => setPickedId(e.target.value)}
            >
              {orgProcurements.length === 0 ? (
                <option value="">Нет закупок</option>
              ) : null}
              {orgProcurements.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number}
                </option>
              ))}
            </select>
            {/* sr-only (not display:none) so a11y/E2E can target the input; button still opens picker. */}
            <input
              ref={inputRef}
              id="doc-file-input"
              data-testid="doc-file-input"
              type="file"
              accept=".pdf,.docx,.xlsx,.txt"
              className="sr-only"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                await handleFile(file);
                e.target.value = "";
              }}
            />
            <Button
              data-testid="doc-upload"
              type="button"
              disabled={!procurementId}
              onClick={() => inputRef.current?.click()}
            >
              Загрузить документ
            </Button>
            <label
              htmlFor="doc-file-input"
              data-testid="doc-upload-label"
              className={
                procurementId
                  ? "sr-only"
                  : "pointer-events-none sr-only opacity-50"
              }
            >
              Выбрать файл документа
            </label>
          </>
        }
      />

      <Input
        className="mb-6 max-w-md"
        placeholder="Поиск по названию или файлу"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      {filtered.length === 0 ? (
        <EmptyState
          title="Документов пока нет"
          description="Выберите закупку и загрузите PDF, DOCX или XLSX."
          actionLabel="Загрузить"
          onAction={() => inputRef.current?.click()}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filtered.map((d) => (
            <EntityCard
              key={d.id}
              href={`/cabinet/dokumenty/${d.id}`}
              title={d.title}
              subtitle={`${d.fileName} · ${d.fileType.toUpperCase()}`}
              status={d.status}
              meta={
                <div className="space-y-1">
                  <div>Версий: {d.versions.length}</div>
                  <div>Цитат: {d.citations.length}</div>
                  <div>Подсветок для проверки: {d.highlights.length}</div>
                  {d.analysis?.region ? (
                    <div>
                      {d.analysis.region}
                      {d.analysis.zone ? `, зона ${d.analysis.zone}` : ""}
                    </div>
                  ) : null}
                  {d.fileSize ? (
                    <div>
                      Размер: {(d.fileSize / 1024).toFixed(1)} КБ
                    </div>
                  ) : null}
                </div>
              }
              footer={
                <span className="text-xs text-[var(--tk-muted)]">
                  Загружено {formatDateTime(d.uploadedAt)}
                  {user ? ` · ${user.name.split(" ")[0]}` : ""}
                </span>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
