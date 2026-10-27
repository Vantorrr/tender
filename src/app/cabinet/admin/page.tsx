"use client";

import Link from "next/link";
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
import { formatDateTime } from "@/lib/format";
import { ROLE_LABELS } from "@/lib/roles";
import { useStore } from "@/lib/store";

export default function AdminPage() {
  const { data, user, resetData } = useStore();
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
          user.role === "superadmin" ? (
            <Button
              variant="outline"
              onClick={() => {
                resetData();
                toast.success("Данные сброшены к демо-набору");
              }}
            >
              Сбросить демо-данные
            </Button>
          ) : null
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
            </div>
          );
        })}
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
          Цепочка артефактов:{" "}
          <Link
            className="text-[var(--tk-copper-deep)] underline"
            href="/cabinet/zakupki/p-1"
          >
            закупка p-1
          </Link>{" "}
          → документы → расчёт → ГПР → деньги → план/факт.
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
