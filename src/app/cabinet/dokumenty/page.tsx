"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { EntityCard } from "@/components/entity-card";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/format";
import { visibleProcurementNumber } from "@/lib/pipeline";
import { useStore } from "@/lib/store";
import { BatchUploadZone } from "@/components/batch-upload-zone";
import { runUploadQueue } from "@/lib/upload-queue";

export default function DokumentyPage() {
  const { orgDocuments, user, createDocumentUpload, orgProcurements, refresh } =
    useStore();
  const [q, setQ] = useState("");
  const [pickedId, setPickedId] = useState("");
  const procurementId = pickedId || orgProcurements[0]?.id || "";
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<Array<{ name: string; message: string }>>([]);
  const [uploading, setUploading] = useState(false);

  const filtered = orgDocuments.filter((d) => {
    if (!q) return true;
    return `${d.title} ${d.fileName}`.toLowerCase().includes(q.toLowerCase());
  });

  async function handleFiles(files: File[]) {
    if (!procurementId) {
      toast.error("Сначала выберите закупку");
      return;
    }
    setUploading(true);
    setFailures([]);
    setProgress({ done: 0, total: files.length });
    try {
      const result = await runUploadQueue(files, async (file) => {
        const warning = await createDocumentUpload({
          procurementId,
          title: file.name.replace(/\.[^.]+$/, ""),
          file,
          silent: true,
        });
        if (warning) throw new Error(warning);
      }, {
        concurrency: 4,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      await refresh();
      setFailures(result.errors);
      if (result.errors.length) toast.warning(`Загружено ${result.uploaded} из ${result.uploaded + result.errors.length}`);
      else toast.success(`Загружено ${result.uploaded} из ${result.uploaded}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Ошибка загрузки");
    } finally {
      setUploading(false);
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
              className="flex h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm sm:w-[360px]"
              value={procurementId}
              onChange={(e) => setPickedId(e.target.value)}
            >
              {orgProcurements.length === 0 ? (
                <option value="">Нет закупок</option>
              ) : null}
              {orgProcurements.map((p) => (
                <option key={p.id} value={p.id}>
                  {visibleProcurementNumber(p)} · {p.title}
                </option>
              ))}
            </select>
            {/* sr-only (not display:none) so a11y/E2E can target the input; button still opens picker. */}
            <input
              ref={inputRef}
              id="doc-file-input"
              data-testid="doc-file-input"
              type="file"
              multiple
              accept=".pdf,.doc,.docx,.xlsx,.xls,.zip,.rar,.7z,.txt"
              className="sr-only"
              onChange={async (e) => {
                const files = [...(e.target.files ?? [])];
                if (files.length) await handleFiles(files);
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

      <div className="mb-4">
        <BatchUploadZone
          testId="documents-batch-upload"
          disabled={!procurementId || uploading}
          accept=".pdf,.doc,.docx,.xlsx,.xls,.zip,.rar,.7z,.txt"
          hint="Можно выбрать папку или сразу много файлов. Прогресс — «Загружено X из N»."
          onFiles={(files) => void handleFiles(files)}
        />
        {progress ? <p className="mt-2 text-sm" role="status" data-testid="documents-upload-progress">Загружено {progress.done} из {progress.total}</p> : null}
        {failures.length ? (
          <ul className="mt-2 space-y-1 text-sm text-rose-900" data-testid="documents-upload-failures">
            {failures.map((failure) => <li key={`${failure.name}-${failure.message}`}>{failure.name}: {failure.message}</li>)}
          </ul>
        ) : null}
      </div>

      <Input
        className="mb-6 max-w-md"
        placeholder="Поиск по названию или файлу"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      {filtered.length === 0 ? (
        <EmptyState
          title="Документов пока нет"
          description="Выберите закупку и загрузите PDF, DOC, DOCX, XLSX или архив ZIP/RAR."
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
