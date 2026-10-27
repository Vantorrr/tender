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
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = orgDocuments.filter((d) => {
    if (!q) return true;
    return `${d.title} ${d.fileName}`.toLowerCase().includes(q.toLowerCase());
  });

  return (
    <div>
      <PageHeader
        title="Документы"
        description="Загрузка PDF/DOCX/XLSX, аналитическая записка с цитатами, версии и повторный разбор."
        actions={
          <>
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.docx,.xlsx"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const ext = file.name.split(".").pop()?.toLowerCase();
                const fileType =
                  ext === "docx" || ext === "xlsx" || ext === "pdf"
                    ? ext
                    : "pdf";
                await createDocumentUpload({
                  procurementId: orgProcurements[0]?.id ?? "p-1",
                  title: file.name.replace(/\.[^.]+$/, ""),
                  fileName: file.name,
                  fileType,
                });
                toast.success(`Файл «${file.name}» загружен на сервер`);
                e.target.value = "";
              }}
            />
            <Button onClick={() => inputRef.current?.click()}>
              Загрузить документ
            </Button>
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
          description="Загрузите PDF, DOCX или XLSX по закупке, чтобы запустить разбор."
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
                  <div>
                    Подсветок для проверки: {d.highlights.length}
                  </div>
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
