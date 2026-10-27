"use client";

import Link from "next/link";
import {
  ArrowRight,
  Calculator,
  FileText,
  FolderKanban,
  ShieldAlert,
} from "lucide-react";
import { EntityCard } from "@/components/entity-card";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/format";
import { ROLE_LABELS } from "@/lib/roles";
import { useStore } from "@/lib/store";

export default function CabinetHomePage() {
  const { user, orgProcurements, orgDocuments, data, unreadCount } = useStore();
  if (!user) return null;

  const calcs = data.calculations.filter((c) => c.orgId === user.orgId);
  const risks = data.risks.filter((r) => r.orgId === user.orgId);
  const recent = orgProcurements.slice(0, 4);

  const stats = [
    {
      label: "Закупки",
      value: orgProcurements.length,
      href: "/cabinet/zakupki",
      icon: FolderKanban,
    },
    {
      label: "Документы",
      value: orgDocuments.length,
      href: "/cabinet/dokumenty",
      icon: FileText,
    },
    {
      label: "Расчёты",
      value: calcs.length,
      href: "/cabinet/raschety",
      icon: Calculator,
    },
    {
      label: "Риски",
      value: risks.length,
      href: "/cabinet/riski",
      icon: ShieldAlert,
    },
  ];

  return (
    <div className="animate-in fade-in duration-500">
      <PageHeader
        title={`Здравствуйте, ${user.name.split(" ")[0]}`}
        description={`${ROLE_LABELS[user.role]} · ${
          data.organizations.find((o) => o.id === user.orgId)?.name
        }${unreadCount ? ` · ${unreadCount} новых уведомлений` : ""}`}
        actions={
          <Button render={<Link href="/cabinet/zakupki" />}>
            К закупкам
            <ArrowRight className="h-4 w-4" />
          </Button>
        }
      />

      <div className="mb-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((s, i) => (
          <Link
            key={s.label}
            href={s.href}
            className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4 transition hover:-translate-y-0.5 hover:border-[var(--tk-copper)]/40"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm text-[var(--tk-muted)]">{s.label}</span>
              <s.icon className="h-4 w-4 text-[var(--tk-copper)]" />
            </div>
            <div className="mt-2 font-[family-name:var(--font-display)] text-3xl text-[var(--tk-ink)]">
              {s.value}
            </div>
          </Link>
        ))}
      </div>

      <h2 className="mb-4 font-[family-name:var(--font-display)] text-lg tracking-tight">
        Активные закупки
      </h2>
      <div className="grid gap-4 md:grid-cols-2">
        {recent.map((p) => (
          <EntityCard
            key={p.id}
            href={`/cabinet/zakupki/${p.id}`}
            title={p.title}
            subtitle={`${p.number} · ${p.customer}`}
            status={p.status}
            meta={
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span>НМЦК {formatMoney(p.nmck)}</span>
                <span>{p.region}</span>
              </div>
            }
            footer={
              <div className="flex items-center justify-between text-xs text-[var(--tk-muted)]">
                <span>Источник: {p.source}</span>
                <StatusBadge status={p.status} className="hidden" />
              </div>
            }
          />
        ))}
      </div>

      <div className="mt-8 rounded-xl border border-[var(--tk-line)] bg-[linear-gradient(120deg,rgba(27,58,75,0.06),rgba(184,107,43,0.08))] p-5">
        <h3 className="font-[family-name:var(--font-display)] text-base">
          Сквозная цепочка
        </h3>
        <p className="mt-1 text-sm text-[var(--tk-muted)]">
          Закупка → документы → расчёт → ГПР → деньги → план/факт. Откройте
          карточку закупки «Капитальный ремонт здания школы №12», чтобы пройти
          весь путь.
        </p>
        <Button
          render={<Link href="/cabinet/zakupki/p-1" />}
          variant="outline"
          className="mt-4"
        >
          Открыть эталонную закупку
        </Button>
      </div>
    </div>
  );
}
