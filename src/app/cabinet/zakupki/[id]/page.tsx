"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { ReviewBadge, StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, getClientToken } from "@/lib/api";
import { cleanLabel } from "@/lib/display";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { PARTICIPATE_LABELS } from "@/lib/project-analytics";
import { WORK_TYPES } from "@/lib/pipeline";
import { REVIEW_LABELS, SYNC_STATUS_LABELS } from "@/lib/roles";
import type { DocumentCategory, ReviewStatus, SupplyStatus } from "@/lib/types";
import { useStore } from "@/lib/store";
import { Input } from "@/components/ui/input";

const SUPPLY_RU: Record<SupplyStatus, string> = {
  need: "Потребность",
  quoted_draft: "Черновик КП",
  ordered: "Заказано",
  in_transit: "В пути",
  delivered: "Поставлено",
  accepted: "Принято",
  cancelled: "Отменено",
};

export default function ZakupkaDetailPage() {
  const params = useParams<{ id: string }>();
  const {
    data,
    orgProcurements,
    setProcurementReview,
    ensureChain,
    sendToCalculation,
    refreshAnalytics,
    createDocumentUpload,
    updateRisk,
    parseRiskContract,
    refresh,
  } = useStore();
  const procurement = orgProcurements.find((p) => p.id === params.id);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadCategory, setUploadCategory] =
    useState<DocumentCategory>("general");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [payTitle, setPayTitle] = useState("Аванс");
  const [payAmount, setPayAmount] = useState("0");
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [matName, setMatName] = useState("");
  const [matQty, setMatQty] = useState("1");
  const [matUnit, setMatUnit] = useState("шт");
  const [matNeedBy, setMatNeedBy] = useState(
    new Date().toISOString().slice(0, 10)
  );
  const [matQuote, setMatQuote] = useState("");

  const docs = useMemo(
    () =>
      procurement
        ? data.documents.filter((d) => d.procurementId === procurement.id)
        : [],
    [data.documents, procurement]
  );
  const calc = procurement?.calculationId
    ? data.calculations.find((c) => c.id === procurement.calculationId)
    : undefined;
  const original = procurement?.originalCalculationId
    ? data.calculations.find((c) => c.id === procurement.originalCalculationId)
    : undefined;
  const gpr = procurement?.gprId
    ? data.schedules.find((s) => s.id === procurement.gprId)
    : undefined;
  const money = procurement?.moneyId
    ? data.moneyPlans.find((m) => m.id === procurement.moneyId)
    : undefined;
  const risk = procurement
    ? data.risks.find((r) => r.procurementId === procurement.id)
    : undefined;

  if (!procurement) {
    return (
      <ErrorState
        title="Закупка не найдена"
        description="Нет доступа или закупка принадлежит другой организации."
      />
    );
  }

  const analytics = procurement.analytics;
  const previewDoc = previewId
    ? docs.find((d) => d.id === previewId)
    : null;
  const previewUrl = previewDoc
    ? `/api/dokumenty/file?id=${previewDoc.id}&disposition=inline`
    : null;

  const supplies = useMemo(
    () =>
      (data.supplyRequests ?? []).filter(
        (s) => s.procurementId === procurement?.id
      ),
    [data.supplyRequests, procurement?.id]
  );

  async function onUpload(file: File) {
    setBusy(true);
    setUploadError(null);
    try {
      await createDocumentUpload({
        procurementId: procurement!.id,
        title: file.name.replace(/\.[^.]+$/, ""),
        file,
        category: uploadCategory,
      });
      toast.success(`Файл «${file.name}» добавлен в закупку`);
      await refresh();
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.message
          : "Ошибка загрузки (неподдерживаемый или повреждённый файл)";
      setUploadError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={procurement.title}
        description={`${procurement.number} · ${procurement.customer}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={procurement.status} />
            <ReviewBadge status={procurement.reviewStatus} />
            <Button
              data-testid="send-to-calc"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await sendToCalculation(procurement.id);
                  toast.success(
                    "Ресурсный черновик и ГПР созданы; документы сохранены"
                  );
                } catch (e) {
                  toast.error(
                    e instanceof Error ? e.message : "Не удалось отправить"
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Отправить в расчёт
            </Button>
          </div>
        }
      />

      <Tabs defaultValue="overview" className="mt-2">
        <TabsList className="mb-4 flex h-auto flex-wrap gap-1">
          <TabsTrigger value="overview">Карточка</TabsTrigger>
          <TabsTrigger value="docs">Документы ({docs.length})</TabsTrigger>
          <TabsTrigger value="analytics">Аналитика</TabsTrigger>
          <TabsTrigger value="calc">Расчёт</TabsTrigger>
          <TabsTrigger value="gpr">ГПР</TabsTrigger>
          <TabsTrigger value="money">Деньги</TabsTrigger>
          <TabsTrigger value="supply">Поставки</TabsTrigger>
          <TabsTrigger value="risks">Риски</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-5 lg:col-span-2">
              <h2 className="font-[family-name:var(--font-display)] text-base">
                Карточка закупки
              </h2>
              <dl className="mt-4 grid gap-3 sm:grid-cols-2 text-sm">
                <div>
                  <dt className="text-[var(--tk-muted)]">НМЦК</dt>
                  <dd className="font-semibold">
                    {formatMoney(procurement.nmck)}
                  </dd>
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
                  <dt className="text-[var(--tk-muted)]">Вид работ</dt>
                  <dd className="font-semibold">
                    {procurement.workType ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--tk-muted)]">Источник</dt>
                  <dd className="font-semibold">
                    {cleanLabel(procurement.source)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--tk-muted)]">Синхронизация</dt>
                  <dd className="font-semibold">
                    {SYNC_STATUS_LABELS[procurement.syncStatus]} ·{" "}
                    {formatDateTime(procurement.syncAt)}
                  </dd>
                </div>
              </dl>
              {procurement.duplicateOf ? (
                <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  Дубликат. Оригинал:{" "}
                  <Link
                    className="underline"
                    href={`/cabinet/zakupki/${procurement.duplicateOf}`}
                  >
                    {data.procurements.find(
                      (p) => p.id === procurement.duplicateOf
                    )?.number ?? "карточка"}
                  </Link>
                </p>
              ) : null}
              <p className="mt-4 text-xs text-[var(--tk-muted)]">
                Создано {formatDate(procurement.createdAt)}. Виды работ
                справочно: {WORK_TYPES.join(", ")}.
              </p>
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
                    <SelectValue>
                      {(value) =>
                        REVIEW_LABELS[value as ReviewStatus] ?? "Рассмотрение"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="novaya">Новая</SelectItem>
                    <SelectItem value="na_rassmotrenii">В работе</SelectItem>
                    <SelectItem value="odobrena">Участвуем</SelectItem>
                    <SelectItem value="otklonena">Не участвуем</SelectItem>
                    <SelectItem value="dublirovana">Дубликат</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
                <h2 className="font-[family-name:var(--font-display)] text-base">
                  Цепочка проекта
                </h2>
                <ul className="mt-3 space-y-1 text-sm">
                  <li>Документы: {docs.length}</li>
                  <li>
                    Черновик:{" "}
                    {calc ? (
                      <Link
                        className="underline text-[var(--tk-copper-deep)]"
                        href={`/cabinet/raschety/${calc.id}`}
                      >
                        {calc.title}
                      </Link>
                    ) : (
                      "нет"
                    )}
                  </li>
                  <li>
                    Оригинал сметы:{" "}
                    {original ? (
                      <Link
                        className="underline text-[var(--tk-copper-deep)]"
                        href={`/cabinet/raschety/${original.id}`}
                      >
                        immutable
                      </Link>
                    ) : (
                      "нет"
                    )}
                  </li>
                  <li>ГПР: {gpr ? "есть" : "нет"}</li>
                  <li>Деньги: {money ? "есть" : "нет"}</li>
                  <li>Риски: {risk ? "есть" : "нет"}</li>
                </ul>
                <Button
                  className="mt-4 w-full"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await ensureChain(procurement.id);
                      toast.success("Недостающие артефакты созданы");
                    } catch (e) {
                      toast.error(
                        e instanceof Error ? e.message : "Ошибка создания"
                      );
                    }
                  }}
                >
                  Создать недостающие артефакты
                </Button>
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="docs">
          {uploadError ? (
            <Alert
              className="mb-4 border-rose-200 bg-rose-50 text-rose-950"
              data-testid="upload-error"
            >
              <AlertTitle>Загрузка не принята</AlertTitle>
              <AlertDescription>{uploadError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-[var(--tk-line)] bg-white/80 p-4">
            <div>
              <p className="mb-1 text-xs text-[var(--tk-muted)]">Категория</p>
              <select
                className="h-9 rounded-lg border px-2 text-sm"
                value={uploadCategory}
                onChange={(e) =>
                  setUploadCategory(e.target.value as DocumentCategory)
                }
              >
                <option value="general">Файл</option>
                <option value="estimate">Смета</option>
                <option value="contract">Договор</option>
                <option value="tz">ТЗ / извещение</option>
                <option value="archive">Архив</option>
              </select>
            </div>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept=".pdf,.docx,.xlsx,.zip"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onUpload(f);
                e.target.value = "";
              }}
            />
            <Button
              disabled={busy}
              data-testid="upload-to-procurement"
              onClick={() => fileRef.current?.click()}
            >
              Добавить файл вручную
            </Button>
            <p className="text-xs text-[var(--tk-muted)]">
              PDF / DOCX / XLSX / ZIP. Ошибки распаковки архива показываются явно.
            </p>
          </div>
          <ul className="space-y-2">
            {docs.length === 0 ? (
              <li className="text-sm text-[var(--tk-muted)]">
                Документов пока нет — загрузите пакет в эту закупку.
              </li>
            ) : (
              docs.map((d) => (
                <li
                  key={d.id}
                  className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="font-medium">{d.title}</div>
                      <div className="text-xs text-[var(--tk-muted)]">
                        {d.fileName} · {d.category ?? "general"} · {d.status}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setPreviewId(d.id)}
                      >
                        Открыть в веб
                      </Button>
                      <Link
                        className="inline-flex h-8 items-center rounded-lg px-3 text-sm hover:bg-stone-100"
                        href={`/cabinet/dokumenty/${d.id}`}
                      >
                        Карточка
                      </Link>
                    </div>
                  </div>
                  {(d.extractionErrors?.length ?? 0) > 0 ? (
                    <Alert className="mt-3 border-rose-200 bg-rose-50 text-rose-950">
                      <AlertTitle>Ошибки извлечения</AlertTitle>
                      <AlertDescription>
                        {d.extractionErrors!.join("; ")}
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  {(d.extractedFiles?.length ?? 0) > 0 ? (
                    <p className="mt-2 text-xs text-[var(--tk-muted)]">
                      Извлечено:{" "}
                      {d.extractedFiles!.map((f) => f.name).join(", ")}
                    </p>
                  ) : null}
                </li>
              ))
            )}
          </ul>
          {previewUrl && previewDoc ? (
            <div className="mt-4 rounded-xl border border-[var(--tk-line)] bg-white p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium">
                  Просмотр: {previewDoc.fileName}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setPreviewId(null)}
                >
                  Закрыть
                </Button>
              </div>
              {previewDoc.fileType === "pdf" ? (
                <iframe
                  title={previewDoc.fileName}
                  src={previewUrl}
                  className="h-[70vh] w-full rounded-lg border"
                />
              ) : (
                <p className="text-sm text-[var(--tk-muted)]">
                  Встроенный просмотр для {previewDoc.fileType.toUpperCase()} —
                  скачайте или откройте ссылку:{" "}
                  <a
                    className="underline"
                    href={previewUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => {
                      const token = getClientToken();
                      if (token) {
                        e.preventDefault();
                        void fetch(previewUrl, {
                          headers: { Authorization: `Bearer ${token}` },
                          credentials: "include",
                        }).then(async (r) => {
                          const blob = await r.blob();
                          window.open(URL.createObjectURL(blob), "_blank");
                        });
                      }
                    }}
                  >
                    открыть файл
                  </a>
                  .
                </p>
              )}
            </div>
          ) : null}
        </TabsContent>

        <TabsContent value="analytics">
          <div className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-[family-name:var(--font-display)] text-base">
                Аналитическая сводка проекта
              </h2>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  await refreshAnalytics(procurement.id);
                  toast.success("Сводка пересчитана");
                }}
              >
                Обновить сводку
              </Button>
            </div>
            {analytics ? (
              <>
                <p className="mb-2 text-sm font-semibold">
                  Рекомендация:{" "}
                  {PARTICIPATE_LABELS[analytics.recommendation]}
                </p>
                <pre className="whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-sm leading-relaxed">
                  {analytics.summary}
                </pre>
                <p className="mt-3 text-xs text-[var(--tk-muted)]">
                  {analytics.disclaimer} Метод: {analytics.method}. Без обещания
                  точности.
                </p>
                <h3 className="mt-4 text-sm font-medium">Цитаты</h3>
                <ul className="mt-2 space-y-2">
                  {analytics.citations.length === 0 ? (
                    <li className="text-sm text-[var(--tk-muted)]">
                      Цитат пока нет — загрузите и разберите документы.
                    </li>
                  ) : (
                    analytics.citations.map((c) => (
                      <li
                        key={c.id}
                        className="rounded-lg border border-[var(--tk-line)] px-3 py-2 text-sm"
                      >
                        <blockquote className="italic">«{c.text}»</blockquote>
                        <div className="mt-1 text-xs text-[var(--tk-muted)]">
                          {c.sourceFile}
                          {c.page ? `, стр. ${c.page}` : ""}
                          {c.paragraph ? `, абз. ${c.paragraph}` : ""}
                          {c.sheet ? `, лист ${c.sheet}` : ""}
                          {c.cell ? `, ${c.cell}` : ""}
                          {c.confidence ? ` · ${c.confidence}` : ""}
                        </div>
                      </li>
                    ))
                  )}
                </ul>
              </>
            ) : (
              <p className="text-sm text-[var(--tk-muted)]">
                Сводка ещё не собрана. Нажмите «Обновить сводку» после загрузки
                пакета.
              </p>
            )}
          </div>
        </TabsContent>

        <TabsContent value="calc">
          <div className="space-y-3 rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
            <p className="text-sm">
              Ресурсный черновик редактируем; оригинал сметы заказчика —
              immutable. Собственные ресурсы не пишутся в нормативную смету.
            </p>
            {calc ? (
              <Link
                className="text-[var(--tk-copper-deep)] underline"
                href={`/cabinet/raschety/${calc.id}`}
              >
                Открыть черновик: {calc.title}
              </Link>
            ) : (
              <p className="text-sm text-[var(--tk-muted)]">
                Черновика нет — нажмите «Отправить в расчёт».
              </p>
            )}
            {original ? (
              <div>
                <Link
                  className="text-[var(--tk-copper-deep)] underline"
                  href={`/cabinet/raschety/${original.id}`}
                >
                  Оригинал сметы (только чтение)
                </Link>
              </div>
            ) : null}
          </div>
        </TabsContent>

        <TabsContent value="gpr">
          <div className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-5 text-sm">
            {gpr ? (
              <>
                <p className="font-medium">{gpr.title}</p>
                <ul className="mt-3 space-y-2">
                  {gpr.stages.map((s) => (
                    <li key={s.id} className="rounded-lg border px-3 py-2">
                      <div className="font-medium">{s.name}</div>
                      <div className="text-xs text-[var(--tk-muted)]">
                        {s.start} → {s.end}
                        {s.dependsOn ? ` · зависит от ${s.dependsOn}` : ""}
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded bg-stone-100">
                        <div
                          className="h-full bg-teal-600/70"
                          style={{ width: `${Math.min(100, 20 + s.sequence * 25)}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-[var(--tk-muted)]">
                  Полный Гант с перетаскиванием и сводкой — в карточке ГПР.
                </p>
                <Link
                  className="mt-3 inline-flex h-9 items-center rounded-lg border px-3 text-sm"
                  href={`/cabinet/gpr/${gpr.id}`}
                >
                  Открыть ГПР
                </Link>
              </>
            ) : (
              <p className="text-[var(--tk-muted)]">
                ГПР появится после «Отправить в расчёт».
              </p>
            )}
          </div>
        </TabsContent>

        <TabsContent value="money">
          <div
            className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-5 text-sm"
            data-testid="project-money-tab"
          >
            {!money ? (
              <div className="space-y-3">
                <p className="text-[var(--tk-muted)]">
                  Денежный план ещё не создан для этой закупки.
                </p>
                <Button
                  data-testid="ensure-money"
                  onClick={async () => {
                    try {
                      await api("/api/zakupki", {
                        method: "POST",
                        body: JSON.stringify({
                          action: "ensureMoney",
                          id: procurement.id,
                        }),
                      });
                      await refresh();
                      toast.success("Денежный план создан в карточке проекта");
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Ошибка");
                    }
                  }}
                >
                  Создать план денег
                </Button>
              </div>
            ) : (
              <>
                <p className="font-medium">{money.title}</p>
                <ul className="mt-3 space-y-2">
                  {money.payments.map((pay) => (
                    <li
                      key={pay.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2"
                    >
                      <Input
                        className="w-40"
                        value={pay.title}
                        onChange={async (e) => {
                          const title = e.target.value;
                          await api("/api/zakupki", {
                            method: "POST",
                            body: JSON.stringify({
                              action: "saveMoney",
                              moneyId: money.id,
                              patch: {
                                payments: money.payments.map((x) =>
                                  x.id === pay.id ? { ...x, title } : x
                                ),
                              },
                            }),
                          });
                          await refresh();
                        }}
                      />
                      <Input
                        className="w-32"
                        value={String(pay.amount)}
                        onChange={async (e) => {
                          const amount = Number(e.target.value) || 0;
                          await api("/api/zakupki", {
                            method: "POST",
                            body: JSON.stringify({
                              action: "saveMoney",
                              moneyId: money.id,
                              patch: {
                                payments: money.payments.map((x) =>
                                  x.id === pay.id ? { ...x, amount } : x
                                ),
                              },
                            }),
                          });
                          await refresh();
                        }}
                      />
                      <span className="text-xs text-[var(--tk-muted)]">
                        {formatDate(pay.date)} · {formatMoney(pay.amount)}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-4 flex flex-wrap items-end gap-2 border-t pt-4">
                  <Input
                    placeholder="Название"
                    value={payTitle}
                    onChange={(e) => setPayTitle(e.target.value)}
                  />
                  <Input
                    className="w-28"
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                  />
                  <Input
                    type="date"
                    value={payDate}
                    onChange={(e) => setPayDate(e.target.value)}
                  />
                  <Button
                    data-testid="add-money-payment"
                    onClick={async () => {
                      try {
                        await api("/api/zakupki", {
                          method: "POST",
                          body: JSON.stringify({
                            action: "addMoneyPayment",
                            moneyId: money.id,
                            payment: {
                              type: "avans",
                              title: payTitle || "Платёж",
                              amount: Number(payAmount) || 0,
                              date: payDate,
                              week: 1,
                              month: Number(payDate.slice(5, 7)) || 1,
                            },
                          }),
                        });
                        await refresh();
                        toast.success("Платёж сохранён");
                      } catch (e) {
                        toast.error(
                          e instanceof Error ? e.message : "Ошибка сохранения"
                        );
                      }
                    }}
                  >
                    Добавить и сохранить
                  </Button>
                </div>
                <p className="mt-3 text-xs text-[var(--tk-muted)]">
                  Деньги ведутся в карточке проекта (не в сайдбаре). Это касса /
                  график платежей — не путать с физ. фактом производства.
                </p>
              </>
            )}
          </div>
        </TabsContent>

        <TabsContent value="supply">
          <div
            className="space-y-4 rounded-xl border border-[var(--tk-line)] bg-white/80 p-5 text-sm"
            data-testid="supply-tab"
          >
            <h3 className="font-medium">
              Потребность → черновик КП → поставка
            </h3>
            <p className="text-xs text-[var(--tk-muted)]">
              Отправка писем поставщикам не выполняется. Можно подготовить текст
              запроса КП и вести статусы вручную.
            </p>
            <div className="flex flex-wrap gap-2">
              <Input
                placeholder="Материал"
                value={matName}
                onChange={(e) => setMatName(e.target.value)}
              />
              <Input
                className="w-24"
                value={matQty}
                onChange={(e) => setMatQty(e.target.value)}
              />
              <Input
                className="w-20"
                value={matUnit}
                onChange={(e) => setMatUnit(e.target.value)}
              />
              <Input
                type="date"
                value={matNeedBy}
                onChange={(e) => setMatNeedBy(e.target.value)}
              />
              <Input
                className="min-w-[220px] flex-1"
                placeholder="Черновик текста КП (не отправка)"
                value={matQuote}
                onChange={(e) => setMatQuote(e.target.value)}
              />
              <Button
                data-testid="supply-create"
                onClick={async () => {
                  if (!matName.trim()) {
                    toast.error("Укажите материал");
                    return;
                  }
                  try {
                    await api("/api/supply", {
                      method: "POST",
                      body: JSON.stringify({
                        procurementId: procurement.id,
                        materialName: matName.trim(),
                        unit: matUnit || "шт",
                        qtyNeed: Number(matQty) || 0,
                        needBy: matNeedBy,
                        status: matQuote.trim() ? "quoted_draft" : "need",
                        quoteDraftText: matQuote.trim() || undefined,
                      }),
                    });
                    await refresh();
                    toast.success("Потребность сохранена");
                    setMatName("");
                    setMatQuote("");
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Ошибка");
                  }
                }}
              >
                Сохранить потребность
              </Button>
            </div>
            <ul className="space-y-2">
              {supplies.length === 0 ? (
                <li className="text-[var(--tk-muted)]">Пока нет потребностей</li>
              ) : (
                supplies.map((s) => (
                  <li
                    key={s.id}
                    className="rounded-lg border px-3 py-2"
                    data-testid={`supply-${s.id}`}
                  >
                    <div className="font-medium">
                      {s.materialName} · {s.qtyNeed} {s.unit} · к{" "}
                      {formatDate(s.needBy)}
                    </div>
                    <div className="text-xs text-[var(--tk-muted)]">
                      {SUPPLY_RU[s.status]} · заказано {s.qtyOrdered} ·
                      поставлено {s.qtyDelivered}
                    </div>
                    {s.quoteDraftText ? (
                      <pre className="mt-2 whitespace-pre-wrap rounded bg-stone-50 p-2 text-xs">
                        {s.quoteDraftText}
                      </pre>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {(
                        [
                          "need",
                          "quoted_draft",
                          "ordered",
                          "in_transit",
                          "delivered",
                          "accepted",
                        ] as SupplyStatus[]
                      ).map((st) => (
                        <Button
                          key={st}
                          size="sm"
                          variant={s.status === st ? "default" : "outline"}
                          onClick={async () => {
                            await api("/api/supply", {
                              method: "POST",
                              body: JSON.stringify({
                                id: s.id,
                                procurementId: procurement.id,
                                materialName: s.materialName,
                                unit: s.unit,
                                qtyNeed: s.qtyNeed,
                                needBy: s.needBy,
                                status: st,
                                qtyDelivered:
                                  st === "delivered" || st === "accepted"
                                    ? s.qtyNeed
                                    : s.qtyDelivered,
                                qtyOrdered:
                                  st === "ordered" ||
                                  st === "in_transit" ||
                                  st === "delivered" ||
                                  st === "accepted"
                                    ? Math.max(s.qtyOrdered, s.qtyNeed)
                                    : s.qtyOrdered,
                                quoteDraftText: s.quoteDraftText,
                              }),
                            });
                            await refresh();
                          }}
                        >
                          {SUPPLY_RU[st]}
                        </Button>
                      ))}
                    </div>
                  </li>
                ))
              )}
            </ul>
          </div>
        </TabsContent>

        <TabsContent value="risks">
          <div className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-5 text-sm space-y-3">
            {risk ? (
              <>
                <p className="font-medium">{risk.title}</p>
                <p>
                  Договор разобран: {risk.contractParsed ? "да" : "нет"} ·
                  замечаний: {risk.remarks.length}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setUploadCategory("contract");
                      fileRef.current?.click();
                    }}
                  >
                    Загрузить договор в риски
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      try {
                        await parseRiskContract(risk.id);
                        toast.success("Разбор договора выполнен");
                      } catch (e) {
                        toast.error(
                          e instanceof Error ? e.message : "Ошибка разбора"
                        );
                      }
                    }}
                  >
                    Разобрать договор
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await updateRisk(risk.id, { status: "trebuet_proverki" });
                      toast.success("Статус рисков обновлён");
                    }}
                  >
                    Пометить к проверке
                  </Button>
                </div>
                <ul className="space-y-2">
                  {risk.remarks.map((r) => (
                    <li key={r.id} className="rounded-lg border px-3 py-2">
                      <div>{r.text}</div>
                      <div className="mt-1 text-xs text-[var(--tk-muted)]">
                        «{r.sourceExcerpt}»
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-[var(--tk-muted)]">
                Реестр рисков создайте через «Создать недостающие артефакты».
              </p>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
