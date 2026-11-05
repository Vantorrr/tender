import { insertJob, listJobs, mutateAppData, readAppData, updateJob } from "@/server/db";
import { analyzeUpload } from "@/server/grand-smeta";
import { reanalyzeDocument } from "@/server/repo";
import { readUpload } from "@/server/uploads";

/** Normalized notice number for dedup (strip -DUP/-AUTO suffixes). */
export function normalizeProcurementNumber(number: string): string {
  return number
    .trim()
    .toUpperCase()
    .replace(/-(DUP|AUTO)(\d*)?$/i, "");
}

export function runProcurementSync(actorId: string) {
  const id = `job-sync-${Date.now()}`;
  const createdAt = new Date().toISOString();
  insertJob({
    id,
    type: "procurement_sync",
    status: "running",
    detail: "Синхронизация согласованного источника…",
    createdAt,
  });

  const result = mutateAppData((data) => {
    const now = new Date().toISOString();
    const actor = data.users.find((u) => u.id === actorId);
    const isSuper = actor?.role === "superadmin";
    let updated = 0;
    let duplicates = 0;

    data.procurements = data.procurements.map((p) => {
      if (actor && !isSuper && p.orgId !== actor.orgId) return p;
      updated += 1;
      if (p.syncStatus === "oshibka_sinhronizacii") {
        return {
          ...p,
          syncStatus: "aktualno" as const,
          syncAt: now,
          status: p.status === "oshibka" ? ("zagruzheno" as const) : p.status,
        };
      }
      if (p.syncStatus === "ustarelo") {
        return { ...p, syncStatus: "aktualno" as const, syncAt: now };
      }
      return { ...p, syncAt: now, syncStatus: "aktualno" as const };
    });

    // Dedup within each org by normalized number
    const byOrg = new Map<string, typeof data.procurements>();
    for (const p of data.procurements) {
      const list = byOrg.get(p.orgId) ?? [];
      list.push(p);
      byOrg.set(p.orgId, list);
    }
    const canon = new Map<string, string>(); // key org|norm -> first id
    for (const [orgId, list] of byOrg) {
      const sorted = [...list].sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      for (const p of sorted) {
        const key = `${orgId}|${normalizeProcurementNumber(p.number)}`;
        if (!canon.has(key)) {
          canon.set(key, p.id);
          continue;
        }
        const originalId = canon.get(key)!;
        if (p.id === originalId || p.duplicateOf === originalId) continue;
        duplicates += 1;
        data.procurements = data.procurements.map((x) =>
          x.id === p.id
            ? {
                ...x,
                reviewStatus: "dublirovana" as const,
                duplicateOf: originalId,
                tags: x.tags.includes("дубликат")
                  ? x.tags
                  : [...x.tags, "дубликат"],
              }
            : x
        );
      }
    }

    const orgId = actor?.orgId ?? "org-alfa";
    const exists = data.procurements.some(
      (p) => p.orgId === orgId && p.number.endsWith("-AUTO")
    );
    if (!exists) {
      data.procurements.unshift({
        id: `p-auto-${Date.now()}`,
        orgId,
        number: `${Date.now().toString().slice(-12)}-AUTO`,
        title: "Автосинхронизация: ремонт дорожного покрытия (мок-источник)",
        customer: "ГБУ «Автодор»",
        region: "Москва",
        nmck: 27600000,
        deadline: new Date(Date.now() + 14 * 86400000).toISOString(),
        source: "Согласованный источник (мок)",
        status: "zagruzheno",
        reviewStatus: "novaya",
        syncStatus: "aktualno",
        syncAt: now,
        attachments: [
          {
            id: "a-auto",
            name: "izveshchenie.pdf",
            type: "pdf",
            size: "640 КБ",
          },
        ],
        documentIds: [],
        tags: ["автосинхронизация", "мок"],
        createdAt: now,
      });
      updated += 1;
      data.notifications.unshift({
        id: `n-sync-${Date.now()}`,
        userId: actorId,
        title: "Синхронизация завершена",
        body:
          duplicates > 0
            ? `Добавлена закупка. Найдено дублей: ${duplicates}`
            : "Добавлена новая закупка из согласованного источника",
        read: false,
        at: now,
        href: "/cabinet/zakupki",
      });
    } else if (duplicates > 0) {
      data.notifications.unshift({
        id: `n-dedup-${Date.now()}`,
        userId: actorId,
        title: "Дедупликация",
        body: `При синхронизации отмечено дублей: ${duplicates}`,
        read: false,
        at: now,
        href: "/cabinet/zakupki",
      });
    }

    data.auditLog.unshift({
      id: `aud-sync-${Date.now()}`,
      at: now,
      actorId,
      action: "sync",
      entity: "procurement",
      entityId: "feed",
      detail: `Синхронизация: обновлено ${updated}, дублей ${duplicates}`,
    });
    return data;
  });

  updateJob(id, {
    status: "done",
    detail: "Синхронизация согласованного источника завершена",
    finishedAt: new Date().toISOString(),
  });

  return { jobId: id, jobs: listJobs(), data: result };
}

export async function runReanalyzePipeline(actorId: string, documentId: string) {
  const id = `job-reanalyze-${Date.now()}`;
  insertJob({
    id,
    type: "document_reanalyze",
    status: "running",
    detail: `Разбор документа ${documentId}`,
    createdAt: new Date().toISOString(),
  });
  const existing = readAppData().documents.find((item) => item.id === documentId);
  const buf = existing?.storedPath ? readUpload(existing.storedPath) : null;
  const prepared = buf
    ? await analyzeUpload(existing?.fileName ?? "file", existing?.fileType ?? "xlsx", buf)
    : null;
  const data = reanalyzeDocument(actorId, documentId, prepared);
  updateJob(id, {
    status: "done",
    detail: `Документ ${documentId} разобран`,
    finishedAt: new Date().toISOString(),
  });
  return { jobId: id, data, jobs: listJobs() };
}

export function getJobs() {
  return listJobs();
}
