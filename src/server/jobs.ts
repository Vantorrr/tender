import { assertOrgAccess } from "@/server/acl";
import { insertJob, listJobs, mutateAppData, readAppData, updateJob } from "@/server/db";
import { analyzeUpload } from "@/server/grand-smeta";
import {
  getProcurementSource,
  type ProcurementNoticeDraft,
} from "@/server/procurement-source";
import { reanalyzeDocument } from "@/server/repo";
import { readUpload } from "@/server/uploads";

/** Normalized notice number for dedup (strip -DUP/-AUTO suffixes). */
export function normalizeProcurementNumber(number: string): string {
  return number
    .trim()
    .toUpperCase()
    .replace(/-(DUP|AUTO)(\d*)?$/i, "");
}

function applyDedup(data: ReturnType<typeof readAppData>): number {
  let duplicates = 0;
  const byOrg = new Map<string, typeof data.procurements>();
  for (const p of data.procurements) {
    const list = byOrg.get(p.orgId) ?? [];
    list.push(p);
    byOrg.set(p.orgId, list);
  }
  const canon = new Map<string, string>();
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
  return duplicates;
}

function insertNotice(
  data: ReturnType<typeof readAppData>,
  orgId: string,
  notice: ProcurementNoticeDraft,
  now: string
) {
  const exists = data.procurements.some(
    (p) => p.orgId === orgId && p.number === notice.number
  );
  if (exists) return false;
  data.procurements.unshift({
    id: `p-auto-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    orgId,
    number: notice.number,
    title: notice.title,
    customer: notice.customer,
    region: notice.region,
    nmck: notice.nmck,
    deadline: notice.deadline,
    source: notice.source,
    status: "zagruzheno",
    reviewStatus: "novaya",
    syncStatus: "aktualno",
    syncAt: now,
    attachments: [
      {
        id: `a-auto-${Date.now()}`,
        name: notice.attachmentName ?? "izveshchenie.pdf",
        type: "pdf",
        size: "640 КБ",
      },
    ],
    documentIds: [],
    tags: notice.tags ?? ["автосинхронизация"],
    createdAt: now,
  });
  return true;
}

export async function runProcurementSync(actorId: string) {
  const id = `job-sync-${Date.now()}`;
  const createdAt = new Date().toISOString();
  insertJob({
    id,
    type: "procurement_sync",
    status: "running",
    detail: "Синхронизация источника закупок…",
    createdAt,
  });

  try {
    const snapshot = readAppData();
    const actor = snapshot.users.find((u) => u.id === actorId);
    const isSuper = actor?.role === "superadmin";
    const orgId = actor?.orgId ?? "org-alfa";
    const source = getProcurementSource();
    const feed = await source.fetchNotices(orgId);

    const result = mutateAppData((data) => {
      const now = new Date().toISOString();
      let updated = 0;
      let inserted = 0;
      const sourceReady = feed.status === "ok" || feed.status === "demo";

      // Touch existing cards only when the feed is usable; never invent status for not_configured.
      data.procurements = data.procurements.map((p) => {
        if (actor && !isSuper && p.orgId !== actor.orgId) return p;
        updated += 1;
        if (!sourceReady) {
          return { ...p, syncAt: now };
        }
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

      for (const notice of feed.notices) {
        if (insertNotice(data, orgId, notice, now)) inserted += 1;
      }

      const duplicates = applyDedup(data);

      const notifyBody =
        feed.status === "not_configured"
          ? `Источник не подключён (${source.id}): новых заявок нет. ${feed.detail}`
          : duplicates > 0
            ? `Источник «${source.id}»: добавлено ${inserted}, дублей ${duplicates}`
            : `Источник «${source.id}»: добавлено ${inserted}. ${feed.detail}`;

      data.notifications.unshift({
        id: `n-sync-${Date.now()}`,
        userId: actorId,
        title:
          feed.status === "not_configured"
            ? "Синхронизация: источник не настроен"
            : "Синхронизация завершена",
        body: notifyBody,
        read: false,
        at: now,
        href: "/cabinet/zakupki",
      });

      data.auditLog.unshift({
        id: `aud-sync-${Date.now()}`,
        at: now,
        actorId,
        action: "sync",
        entity: "procurement",
        entityId: "feed",
        detail: `Синхронизация (${source.id}/${feed.status}): обновлено ${updated}, добавлено ${inserted}, дублей ${duplicates}; ${feed.detail}`,
      });
      return data;
    });

    updateJob(id, {
      status: feed.ok ? "done" : "error",
      detail:
        feed.status === "not_configured"
          ? `Источник «${source.id}» не подключён — без выдуманных заявок`
          : feed.status === "demo"
            ? `Демо-синхронизация «${source.id}» завершена`
            : `Синхронизация «${source.id}» завершена`,
      finishedAt: new Date().toISOString(),
    });

    return { jobId: id, jobs: listJobs(), data: result, feed };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 200) : "ошибка sync";
    updateJob(id, {
      status: "error",
      detail: `Ошибка синхронизации: ${message}`,
      finishedAt: new Date().toISOString(),
    });
    throw error;
  }
}

export async function runReanalyzePipeline(
  actorId: string,
  documentId: string,
  options: { useLlm?: boolean } = {}
) {
  const id = `job-reanalyze-${Date.now()}`;
  const useLlm = Boolean(options.useLlm);
  insertJob({
    id,
    type: "document_reanalyze",
    status: "running",
    detail: useLlm
      ? `Разбор документа ${documentId} (локально + модель)`
      : `Разбор документа ${documentId} (локально)`,
    createdAt: new Date().toISOString(),
  });
  try {
    const snapshot = readAppData();
    const actor = snapshot.users.find((u) => u.id === actorId);
    if (!actor || actor.blocked) throw new Error("Пользователь не найден");
    const existing = snapshot.documents.find((item) => item.id === documentId);
    if (!existing) throw new Error("Документ не найден");
    // Org ACL BEFORE readUpload / analyzeUpload / any paid model call.
    assertOrgAccess(actor, existing.orgId, "документа");
    const buf = existing.storedPath ? readUpload(existing.storedPath) : null;
    const prepared = buf
      ? await analyzeUpload(
          existing.fileName ?? "file",
          existing.fileType ?? "xlsx",
          buf,
          { useLlm }
        )
      : null;
    const data = reanalyzeDocument(actorId, documentId, prepared);
    updateJob(id, {
      status: "done",
      detail: useLlm
        ? `Документ ${documentId} разобран (модель по запросу)`
        : `Документ ${documentId} разобран локально`,
      finishedAt: new Date().toISOString(),
    });
    return { jobId: id, data, jobs: listJobs() };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 200) : "ошибка разбора";
    updateJob(id, {
      status: "error",
      detail: `Ошибка разбора: ${message}`,
      finishedAt: new Date().toISOString(),
    });
    throw error;
  }
}

export function getJobs() {
  return listJobs();
}
