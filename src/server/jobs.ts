import { insertJob, listJobs, mutateAppData, updateJob } from "@/server/db";
import { reanalyzeDocument } from "@/server/repo";

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

    const orgId = actor?.orgId ?? "org-alfa";
    const exists = data.procurements.some((p) => p.number.endsWith("-AUTO"));
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
        body: "Добавлена новая закупка из согласованного источника",
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
      detail: `Синхронизация: обновлено записей ${updated}`,
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

export function runReanalyzePipeline(actorId: string, documentId: string) {
  const id = `job-reanalyze-${Date.now()}`;
  insertJob({
    id,
    type: "document_reanalyze",
    status: "running",
    detail: `Разбор документа ${documentId}`,
    createdAt: new Date().toISOString(),
  });
  const data = reanalyzeDocument(actorId, documentId);
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
