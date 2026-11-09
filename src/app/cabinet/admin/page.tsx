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
import {
  ACTION_LABELS,
  ENTITY_LABELS,
  humanizeCodes,
  JOB_STATUS_LABELS,
  JOB_TYPE_LABELS,
  ROLE_LABELS,
} from "@/lib/roles";
import { useStore } from "@/lib/store";

type JobRow = {
  id: string;
  type: string;
  status: string;
  detail: string;
  createdAt: string;
  finishedAt: string | null;
};

type IntegrationSnapshot = {
  procurement: {
    id: string;
    status: "ok" | "not_configured" | "demo";
    detail: string;
    configured: boolean;
  };
  mail: {
    transport: string;
    live: boolean;
    smtpConfigured: boolean;
    missing: string[];
    detail: string;
  };
  ocr: {
    configured: boolean;
    provider: string;
    tesseract: boolean;
    pdftoppm: boolean;
    pdftotext: boolean;
  };
  llm: {
    configured: boolean;
    onUpload: boolean;
    model: string;
  };
};

function IntegrationPanel() {
  const [integrations, setIntegrations] = useState<IntegrationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<{ integrations: IntegrationSnapshot }>("/api/admin");
      setIntegrations(result.integrations);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось получить статусы интеграций");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void api<{ integrations: IntegrationSnapshot }>("/api/admin")
      .then((result) => {
        if (!active) return;
        setIntegrations(result.integrations);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Не удалось получить статусы интеграций");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const cards = integrations
    ? [
        {
          title: "Источник закупок",
          ready: integrations.procurement.status === "ok",
          status: integrations.procurement.status === "demo" ? "Демо" : integrations.procurement.status === "ok" ? "Работает" : "Не подключён",
          detail: integrations.procurement.detail,
          next: integrations.procurement.status === "ok"
            ? "Открытая лента «Норникеля» подключена. Закрытые площадки настраиваются отдельно по их API."
            : "Для реальной синхронизации укажите поддерживаемый источник и доступы площадки.",
        },
        {
          title: "Распознавание документов",
          ready: integrations.ocr.configured,
          status: integrations.ocr.configured ? "Работает" : "Нужны системные пакеты",
          detail: `Провайдер: ${integrations.ocr.provider}. Tesseract ${integrations.ocr.tesseract ? "есть" : "нет"}, Poppler ${integrations.ocr.pdftotext && integrations.ocr.pdftoppm ? "есть" : "нет"}.`,
          next: integrations.ocr.configured
            ? "Текстовые PDF и сканы доступны для распознавания."
            : "Установите tesseract-ocr и poppler-utils; в Docker-образе они уже включены.",
        },
        {
          title: "ИИ-анализ пакета",
          ready: integrations.llm.configured,
          status: integrations.llm.configured ? "Ключ настроен" : "Нужен ключ модели",
          detail: `Модель: ${integrations.llm.model}. Автоанализ при загрузке ${integrations.llm.onUpload ? "включён" : "выключен"}.`,
          next: integrations.llm.configured
            ? "Ручной анализ пакета доступен в карточке закупки. Автоанализ управляется OPENROUTER_ON_UPLOAD."
            : "Добавьте OPENROUTER_API_KEY в окружение сервера; после этого ручной анализ станет доступен в карточке закупки.",
        },
        {
          title: "Отправка писем",
          ready: integrations.mail.live,
          status: integrations.mail.live ? "SMTP работает" : "SMTP не настроен",
          detail: integrations.mail.detail,
          next: integrations.mail.live
            ? "Письма восстановления пароля отправляются через настроенный SMTP."
            : `Для доставки писем настройте MAIL_TRANSPORT=smtp и SMTP_*${integrations.mail.missing.length ? `: ${integrations.mail.missing.join(", ")}` : ""}.`,
        },
      ]
    : [];

  return (
    <section className="mb-6 rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-[family-name:var(--font-display)] text-base">Состояние подключений</h2>
          <p className="mt-1 text-sm text-[var(--tk-muted)]">Статусы без отображения секретных ключей и паролей.</p>
        </div>
        <Button size="sm" variant="outline" disabled={loading} onClick={() => void load()}>
          {loading ? "Проверяем…" : "Проверить снова"}
        </Button>
      </div>
      {error ? <p role="alert" className="mt-3 text-sm text-rose-800">{error}</p> : null}
      {integrations ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {cards.map((card) => (
            <article key={card.title} className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{card.title}</h3>
                <Badge variant={card.ready ? "secondary" : "outline"}>{card.status}</Badge>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-[var(--tk-muted)]">{card.detail}</p>
              <p className="mt-2 text-xs leading-relaxed">{card.next}</p>
            </article>
          ))}
        </div>
      ) : loading ? (
        <p className="mt-3 text-sm text-[var(--tk-muted)]">Загружаем статусы…</p>
      ) : null}
    </section>
  );
}

function AdminJobs({ reloadKey }: { reloadKey: number }) {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  useEffect(() => {
    let active = true;
    void api<{ jobs: JobRow[] }>("/api/admin")
      .then((res) => {
        if (active) setJobs(res.jobs ?? []);
      })
      .catch(() => {
        if (active) setJobs([]);
      });
    return () => {
      active = false;
    };
  }, [reloadKey]);
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
              {JOB_STATUS_LABELS[j.status] ?? j.status}
            </Badge>
            {JOB_TYPE_LABELS[j.type] ?? j.type}
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
        description="Организации, журнал аудита, импорт справочников. Секретные ключи — в разделе «Пользователи»."
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
                    `Клиентские XLSX: АТС ${r.equipment}, нормо-час ${r.labor}, парк ${r.fleet}`
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
                  toast.success("Данные сброшены, справочники восстановлены");
                }}
              >
                Сбросить данные
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

      <IntegrationPanel />

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
                <TableCell>{ACTION_LABELS[a.action] ?? humanizeCodes(a.action)}</TableCell>
                <TableCell>{ENTITY_LABELS[a.entity] ?? a.entity}</TableCell>
                <TableCell className="max-w-[280px] truncate text-sm">
                  {humanizeCodes(a.detail)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
