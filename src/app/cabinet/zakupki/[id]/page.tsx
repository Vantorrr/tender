"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { ErrorState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { ReviewBadge, StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import type { ReviewStatus } from "@/lib/types";
import { useStore } from "@/lib/store";

export default function ZakupkaDetailPage() {
  const params = useParams<{ id: string }>();
  const { data, orgProcurements, setProcurementReview, user } = useStore();
  const procurement = orgProcurements.find((p) => p.id === params.id);

  if (!procurement) {
    return (
      <ErrorState
        title="Закупка не найдена"
        description="Нет доступа или закупка принадлежит другой организации."
      />
    );
  }

  const docs = data.documents.filter((d) =>
    procurement.documentIds.includes(d.id)
  );

  return (
    <div>
      <PageHeader
        title={procurement.title}
        description={`${procurement.number} · ${procurement.customer}`}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={procurement.status} />
            <ReviewBadge status={procurement.reviewStatus} />
          </div>
        }
      />

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-5 lg:col-span-2">
          <h2 className="font-[family-name:var(--font-display)] text-base">
            Карточка закупки
          </h2>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2 text-sm">
            <div>
              <dt className="text-[var(--tk-muted)]">НМЦК</dt>
              <dd className="font-semibold">{formatMoney(procurement.nmck)}</dd>
            </div>
            <div>
              <dt className="text-[var(--tk-muted)]">Срок подачи</dt>
              <dd className="font-semibold">
                {formatDateTime(procurement.deadline)}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--tk-muted)]">Регион</dt>
              <dd className="font-semibold">{procurement.region}</dd>
            </div>
            <div>
              <dt className="text-[var(--tk-muted)]">Источник</dt>
              <dd className="font-semibold">{procurement.source}</dd>
            </div>
            <div>
              <dt className="text-[var(--tk-muted)]">Синхронизация</dt>
              <dd className="font-semibold">
                {procurement.syncStatus} · {formatDateTime(procurement.syncAt)}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--tk-muted)]">Теги</dt>
              <dd className="font-semibold">{procurement.tags.join(", ")}</dd>
            </div>
          </dl>

          {procurement.duplicateOf ? (
            <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Обнаружен дубликат. Оригинал:{" "}
              <Link
                className="underline"
                href={`/cabinet/zakupki/${procurement.duplicateOf}`}
              >
                {procurement.duplicateOf}
              </Link>
            </p>
          ) : null}

          <div className="mt-6">
            <h3 className="mb-2 text-sm font-medium">Вложения</h3>
            <ul className="space-y-2">
              {procurement.attachments.length === 0 ? (
                <li className="text-sm text-[var(--tk-muted)]">Нет вложений</li>
              ) : (
                procurement.attachments.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center justify-between rounded-lg border border-[var(--tk-line)] px-3 py-2 text-sm"
                  >
                    <span>
                      {a.name}{" "}
                      <span className="text-[var(--tk-muted)]">
                        ({a.type.toUpperCase()}, {a.size})
                      </span>
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        toast.message("Скачивание (мок)", {
                          description: a.name,
                        })
                      }
                    >
                      Скачать
                    </Button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
            <h2 className="font-[family-name:var(--font-display)] text-base">
              Рассмотрение
            </h2>
            <Select
              value={procurement.reviewStatus}
              onValueChange={(v) => {
                if (!v) return;
                setProcurementReview(procurement.id, v as ReviewStatus);
                toast.success("Статус рассмотрения обновлён");
              }}
            >
              <SelectTrigger className="mt-3 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="novaya">Новая</SelectItem>
                <SelectItem value="na_rassmotrenii">На рассмотрении</SelectItem>
                <SelectItem value="odobrena">Одобрена</SelectItem>
                <SelectItem value="otklonena">Отклонена</SelectItem>
                <SelectItem value="dublirovana">Дубликат</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
            <h2 className="font-[family-name:var(--font-display)] text-base">
              Цепочка артефактов
            </h2>
            <ol className="mt-3 space-y-2 text-sm">
              <li>
                <Link className="text-[var(--tk-copper-deep)] underline" href={`/cabinet/zakupki/${procurement.id}`}>
                  Закупка
                </Link>
              </li>
              <li>
                {docs.length ? (
                  <Link
                    className="text-[var(--tk-copper-deep)] underline"
                    href={`/cabinet/dokumenty/${docs[0].id}`}
                  >
                    Документы ({docs.length})
                  </Link>
                ) : (
                  <span className="text-[var(--tk-muted)]">Документы — нет</span>
                )}
              </li>
              <li>
                {procurement.calculationId ? (
                  <Link
                    className="text-[var(--tk-copper-deep)] underline"
                    href={`/cabinet/raschety/${procurement.calculationId}`}
                  >
                    Расчёт
                  </Link>
                ) : (
                  <span className="text-[var(--tk-muted)]">Расчёт — нет</span>
                )}
              </li>
              <li>
                {procurement.gprId ? (
                  <Link
                    className="text-[var(--tk-copper-deep)] underline"
                    href={`/cabinet/gpr/${procurement.gprId}`}
                  >
                    ГПР
                  </Link>
                ) : (
                  <span className="text-[var(--tk-muted)]">ГПР — нет</span>
                )}
              </li>
              <li>
                {procurement.moneyId ? (
                  <Link
                    className="text-[var(--tk-copper-deep)] underline"
                    href="/cabinet/dengi"
                  >
                    Деньги
                  </Link>
                ) : (
                  <span className="text-[var(--tk-muted)]">Деньги — нет</span>
                )}
              </li>
              <li>
                {procurement.planFactId ? (
                  <Link
                    className="text-[var(--tk-copper-deep)] underline"
                    href="/cabinet/proizvodstvo"
                  >
                    План/факт
                  </Link>
                ) : (
                  <span className="text-[var(--tk-muted)]">План/факт — нет</span>
                )}
              </li>
            </ol>
            {user?.orgId === "org-alfa" ? (
              <p className="mt-3 text-xs text-[var(--tk-muted)]">
                Данные организации «АльфаСтрой». Закупки «БетаИнжиниринг»
                недоступны (изоляция).
              </p>
            ) : null}
            <p className="mt-2 text-xs text-[var(--tk-muted)]">
              Создано {formatDate(procurement.createdAt)}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
