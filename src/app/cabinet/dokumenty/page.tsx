"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { EntityCard } from "@/components/entity-card";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
        description="Загрузка PDF/DOCX/XLSX на сервер, аналитическая записка, версии и повторный разбор."
        actions={
          <>
            <Select
              value={procurementId}
              onValueChange={(v) => {
                if (v) setPickedId(v);
              }}
            >
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Закупка">
                  {(value) =>
                    orgProcurements.find((p) => p.id === value)?.number ??
                    "Закупка"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {orgProcurements.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.number}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.docx,.xlsx"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                await handleFile(file);
                e.target.value = "";
              }}
            />
            <Button
              onClick={() => inputRef.current?.click()}
              disabled={!procurementId}
            >
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
