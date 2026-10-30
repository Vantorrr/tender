"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { ROLE_LABELS } from "@/lib/roles";
import { useStore } from "@/lib/store";

type JobRow = {
  id: string;
  type: string;
  status: string;
  detail: string;
  createdAt: string;
  finishedAt: string | null;
};

function AdminJobs({ reloadKey }: { reloadKey: number }) {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const load = useCallback(async () => {
    try {
      const res = await api<{ jobs: JobRow[] }>("/api/admin");
      setJobs(res.jobs ?? []);
    } catch {
      setJobs([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, reloadKey]);
  if (jobs.length === 0) {
    return (
      <p className="mt-3 text-sm text-[var(--tk-muted)]">Заданий пока нет</p>
    );
  }
  return (
    <ul className="mt-3 max-h-48 space-y-2 overflow-y-auto text-sm">
      {jobs.slice(0, 12).map((j) => (
        <li
          key={j.id}
          className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-[var(--tk-line)] px-3 py-2"
        >
          <span>
            <Badge variant="outline" className="mr-2">
              {j.status}
            </Badge>
            {j.type}
          </span>
          <span className="text-xs text-[var(--tk-muted)]">
            {formatDateTime(j.createdAt)}
          </span>
          <span className="w-full text-xs text-[var(--tk-muted)]">
            {j.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function AdminPage() {
  const {
    data,
    user,
    resetData,
    setOrganizationActive,
    importClientXlsx,
  } = useStore();
  const [jobsKey, setJobsKey] = useState(0);
  const [importing, setImporting] = useState(false);
  if (!user) return null;

  if (user.role !== "superadmin" && user.role !== "admin") {
    return (
      <div>
        <PageHeader
          title="Администрирование"
          description="Раздел доступен только администраторам."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Администрирование"
        description="Организации, роли, журнал аудита и демонстрация изоляции данных."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={importing}
              onClick={async () => {
                setImporting(true);
                try {
                  const r = await importClientXlsx();
                  toast.success(
                    `Импорт: техника ${r.equipment}, труд ${r.labor}, парк ${r.fleet}`
                  );
                  setJobsKey((k) => k + 1);
                } catch (e) {
                  toast.error(
                    e instanceof Error ? e.message : "Ошибка импорта"
                  );
                } finally {
                  setImporting(false);
                }
              }}
            >
              {importing ? "Импорт…" : "Импорт клиентских XLSX"}
            </Button>
            {user.role === "superadmin" ? (
              <Button
                variant="outline"
                onClick={async () => {
                  await resetData();
                  toast.success("Данные сброшены к демо-набору");
                }}
              >
                Сбросить демо-данные
              </Button>
            ) : null}
          </div>
        }
      />

      <section className="mb-6 grid gap-4 md:grid-cols-2">
        {data.organizations.map((org) => {
          const count = data.users.filter((u) => u.orgId === org.id).length;
          const procs = data.procurements.filter((p) => p.orgId === org.id)
            .length;
          return (
            <div
              key={org.id}
              className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-5"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="font-[family-name:var(--font-display)] text-base">
                    {org.name}
                  </h2>
                  <p className="text-sm text-[var(--tk-muted)]">
                    ИНН {org.inn}
                  </p>
                </div>
                <Badge variant={org.active ? "secondary" : "outline"}>
                  {org.active ? "Активна" : "Отключена"}
                </Badge>
              </div>
              <p className="mt-3 text-sm">
                Пользователей: {count} · закупок: {procs}
              </p>
              {user.role === "superadmin" ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={async () => {
                    await setOrganizationActive(org.id, !org.active);
                    toast.success(
                      org.active
                        ? "Организация отключена"
                        : "Организация активирована"
                    );
                  }}
                >
                  {org.active ? "Отключить" : "Активировать"}
                </Button>
              ) : null}
            </div>
          );
        })}
      </section>

      <section className="mb-6 rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-[family-name:var(--font-display)] text-base">
            Фоновые задания
          </h2>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setJobsKey((k) => k + 1);
              toast.success("Обновлено");
            }}
          >
            Обновить
          </Button>
        </div>
        <AdminJobs reloadKey={jobsKey} />
      </section>

      <section className="mb-6 rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
        <h2 className="font-[family-name:var(--font-display)] text-base">
          Роли платформы
        </h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {Object.entries(ROLE_LABELS).map(([k, v]) => (
            <Badge key={k} variant="outline">
              {v}
            </Badge>
          ))}
        </div>
        <p className="mt-3 text-sm text-[var(--tk-muted)]">
          Изоляция: пользователь «БетаИнжиниринг» видит только закупки своей
          организации. Войдите как{" "}
          <code className="rounded bg-[var(--tk-steel-50)] px-1">
            tender@betain.ru
          </code>{" "}
          / Beta123! для проверки.
        </p>
        <p className="mt-2 text-sm">
          Цепочка артефактов доступна из карточки любой закупки организации
          («Создать недостающие артефакты»).
        </p>
      </section>

      <section className="overflow-x-auto rounded-xl border border-[var(--tk-line)] bg-white/80">
        <div className="border-b border-[var(--tk-line)] px-4 py-3 font-[family-name:var(--font-display)] text-base">
          Журнал аудита
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Время</TableHead>
              <TableHead>Кто</TableHead>
              <TableHead>Действие</TableHead>
              <TableHead>Объект</TableHead>
              <TableHead>Детали</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.auditLog.slice(0, 30).map((a) => (
              <TableRow key={a.id}>
                <TableCell className="whitespace-nowrap text-xs">
                  {formatDateTime(a.at)}
                </TableCell>
                <TableCell className="text-sm">
                  {data.users.find((u) => u.id === a.actorId)?.name ??
                    a.actorId}
                </TableCell>
                <TableCell>{a.action}</TableCell>
                <TableCell>
                  {a.entity}:{a.entityId}
                </TableCell>
                <TableCell className="max-w-[280px] truncate text-sm">
                  {a.detail}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
