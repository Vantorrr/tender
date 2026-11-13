"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
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
import { DateInputRu } from "@/components/date-input-ru";
import { api } from "@/lib/api";
import { DocumentWebPreview } from "@/components/document-web-preview";
import { cleanLabel } from "@/lib/display";
import { formatDate, formatDateTime, formatMoney, formatNumber } from "@/lib/format";
import { pickLastExchangeForProcurement } from "@/lib/obmen-for-procurement";
import { PARTICIPATE_LABELS } from "@/lib/project-analytics";
import { WORK_TYPES } from "@/lib/pipeline";
import { userHasSection } from "@/lib/acl";
import { REVIEW_LABELS, SYNC_STATUS_LABELS } from "@/lib/roles";
import type { Citation, DocumentCategory, ReviewStatus, SupplyRequest, SupplyStatus } from "@/lib/types";
import { useStore } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { ProjectAiChat } from "@/components/project-ai-chat";

const SUPPLY_RU: Record<SupplyStatus, string> = {
  need: "Потребность",
  quoted_draft: "Черновик КП",
  ordered: "Заказано",
  in_transit: "В пути",
  delivered: "Поставлено",
  accepted: "Принято",
  cancelled: "Отменено",
};

function citationsMatching(citations: Citation[], pattern: RegExp) {
  return citations.filter((citation) => pattern.test(citation.text));
}

function SupplierQuotesEditor({
  supply,
  onUpdated,
}: {
  supply: SupplyRequest;
  onUpdated: () => Promise<void>;
}) {
  const [supplierName, setSupplierName] = useState("");
  const [supplierEmail, setSupplierEmail] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [deliveryDays, setDeliveryDays] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const quotes = supply.quotes ?? [];

  async function recordQuote() {
    const price = Number(unitPrice);
    const leadDays = deliveryDays.trim() ? Number(deliveryDays) : null;
    if (!supplierName.trim() || !unitPrice.trim() || !Number.isFinite(price) || price < 0) {
      toast.error("Укажите поставщика и корректную цену КП");
      return;
    }
    if (leadDays != null && (!Number.isFinite(leadDays) || leadDays < 0)) {
      toast.error("Срок поставки должен быть неотрицательным числом");
      return;
    }
    setSaving(true);
    try {
      await api("/api/supply", {
        method: "POST",
        body: JSON.stringify({
          action: "recordQuote",
          id: supply.id,
          quote: {
            supplierName: supplierName.trim(),
            supplierEmail: supplierEmail.trim() || undefined,
            unitPrice: price,
            deliveryDays: leadDays,
            note: note.trim() || undefined,
          },
        }),
      });
      await onUpdated();
      setSupplierName("");
      setSupplierEmail("");
      setUnitPrice("");
      setDeliveryDays("");
      setNote("");
      toast.success("КП добавлено к сравнению");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось сохранить КП");
    } finally {
      setSaving(false);
    }
  }

  async function chooseQuote(quoteId: string) {
    try {
      await api("/api/supply", {
        method: "POST",
        body: JSON.stringify({ action: "selectQuote", id: supply.id, quoteId }),
      });
      await onUpdated();
      toast.success("Поставщик и цена выбранного КП привязаны к потребности");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось выбрать КП");
    }
  }

  return (
    <section className="mt-3 rounded-lg border border-[var(--tk-line)] bg-stone-50/70 p-3" aria-label={`Коммерческие предложения · ${supply.materialName}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">Сравнение КП · {quotes.length}</h3>
        {supply.selectedQuoteId ? <span className="text-xs text-emerald-800">Выбранное КП учитывается в потребности</span> : null}
      </div>
      {quotes.length ? (
        <div className="mt-2 max-h-64 overflow-auto rounded-md border border-[var(--tk-line)] bg-white">
          <table className="w-full table-fixed text-left text-xs">
            <thead className="bg-stone-100 text-[var(--tk-muted)]">
              <tr><th className="w-[24%] p-2">Поставщик</th><th className="w-[20%] p-2">Цена / {supply.unit}</th><th className="w-[14%] p-2">Срок</th><th className="w-[26%] p-2">Условия</th><th className="w-[16%] p-2">Выбор</th></tr>
            </thead>
            <tbody>
              {quotes.slice().sort((a, b) => a.unitPrice - b.unitPrice).map((quote) => (
                <tr key={quote.id} className="border-t border-[var(--tk-line)] align-top">
                  <td className="break-words p-2"><span className="font-medium">{quote.supplierName}</span>{quote.supplierEmail ? <span className="block break-all text-[var(--tk-muted)]">{quote.supplierEmail}</span> : null}</td>
                  <td className="break-words p-2 font-medium tabular-nums">{formatMoney(quote.unitPrice)}</td>
                  <td className="break-words p-2">{quote.deliveryDays == null ? "не указан" : `${quote.deliveryDays} дн.`}</td>
                  <td className="break-words p-2">{quote.note || "—"}</td>
                  <td className="break-words p-2">{supply.selectedQuoteId === quote.id ? <span className="font-medium text-emerald-800">Выбрано</span> : <Button size="sm" variant="outline" onClick={() => void chooseQuote(quote.id)}>Выбрать</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="mt-2 text-xs text-[var(--tk-muted)]">Добавьте полученные предложения, чтобы сравнить цену и срок поставки.</p>}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium text-[var(--tk-copper-deep)]">Добавить полученное КП</summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <Input aria-label="Поставщик в КП" placeholder="Поставщик" value={supplierName} onChange={(event) => setSupplierName(event.target.value)} />
          <Input aria-label="Email поставщика в КП" type="email" placeholder="Email" value={supplierEmail} onChange={(event) => setSupplierEmail(event.target.value)} />
          <Input aria-label="Цена КП за единицу" type="number" min={0} step="any" placeholder={`Цена за ${supply.unit}`} value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} />
          <Input aria-label="Срок поставки в днях" type="number" min={0} step="1" placeholder="Срок, дней" value={deliveryDays} onChange={(event) => setDeliveryDays(event.target.value)} />
          <Input aria-label="Условия КП" placeholder="Условия / примечание" value={note} onChange={(event) => setNote(event.target.value)} />
          <p className="text-xs text-[var(--tk-muted)] sm:col-span-2 lg:col-span-4">Предложения заносятся вручную после получения. Для отправки запроса используйте черновик письма выше.</p>
          <Button size="sm" disabled={saving} onClick={() => void recordQuote()}>{saving ? "Сохраняю…" : "Добавить КП"}</Button>
        </div>
      </details>
    </section>
  );
}

export default function ZakupkaDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const {
    data,
    user,
    orgProcurements,
    setProcurementReview,
    ensureChain,
    sendToCalculation,
    refreshAnalytics,
    analyzeProjectWithAI,
    createDocumentUpload,
    updateRisk,
    parseRiskContract,
    refresh,
  } = useStore();
  const procurement = orgProcurements.find((p) => p.id === params.id);
  const canMoney = user ? userHasSection(user, "dengi") : false;
  const canGpr = user ? userHasSection(user, "gpr") : false;
  const canProduction = user ? userHasSection(user, "proizvodstvo") : false;
  const canRisks = user ? userHasSection(user, "riski") : false;
  const canDocs = user ? userHasSection(user, "dokumenty") : false;
  const fileRef = useRef<HTMLInputElement>(null);
  const customerEstimateRef = useRef<HTMLInputElement>(null);
  const [uploadCategory, setUploadCategory] =
    useState<DocumentCategory>("general");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [customerEstimateBusy, setCustomerEstimateBusy] = useState(false);
  const [aiAnalyzing, setAiAnalyzing] = useState(false);
  const [analyticsBusy, setAnalyticsBusy] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
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
  const [matWork, setMatWork] = useState("");
  const [matSupplierName, setMatSupplierName] = useState("");
  const [matSupplierEmail, setMatSupplierEmail] = useState("");

  const docs = useMemo(
    () =>
      procurement
        ? data.documents.filter((d) => d.procurementId === procurement.id)
        : [],
    [data.documents, procurement]
  );
  const estimateRows = useMemo(
    () => docs
      .filter((document) => document.category === "estimate" || /smeta|смет/i.test(document.fileName))
      .flatMap((document) => (document.estimatePositions ?? []).map((position) => ({
        ...position,
        sourceFile: document.fileName,
      }))),
    [docs]
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
  const supplies = (data.supplyRequests ?? []).filter(
    (s) => s.procurementId === params.id
  );
  const lastExchange = useMemo(() => {
    if (!procurement || !user) return undefined;
    return pickLastExchangeForProcurement(data.smetaExchanges, {
      orgId: user.orgId,
      procurementId: procurement.id,
      procurementNumber: procurement.number,
      originalCalculationId: original?.id,
    });
  }, [data.smetaExchanges, procurement, user, original]);
  const gprBuyList = useMemo(() => {
    const linked = new Set(
      supplies.map((s) =>
        `${s.workName ?? ""}|${s.materialName}`.toLocaleLowerCase("ru-RU")
      )
    );
    return (gpr?.stages ?? []).flatMap((stage) =>
      (stage.resources ?? [])
        .filter((r) => r.kind === "material" && r.quantity > 0)
        .filter(
          (r) =>
            !linked.has(
              `${stage.name}|${r.name}`.toLocaleLowerCase("ru-RU")
            )
        )
        .map((r) => ({
          key: `${stage.id}:${r.id}`,
          workName: stage.name,
          materialName: r.name,
          unit: r.unit,
          qtyNeed: r.quantity,
          needBy: stage.end,
        }))
    );
  }, [gpr?.stages, supplies]);

  async function onAttachCustomerEstimate(file: File) {
    setCustomerEstimateBusy(true);
    setUploadError(null);
    try {
      await createDocumentUpload({
        procurementId: procurement!.id,
        title: `Смета заказчика — ${file.name}`,
        file,
        category: "estimate",
      });
      await api("/api/zakupki", {
        method: "POST",
        body: JSON.stringify({
          action: "attachCustomerEstimate",
          id: procurement!.id,
          fileName: file.name,
        }),
      });
      await refresh();
      toast.success("Смета заказчика прикреплена как исходный оригинал");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Не удалось добавить смету";
      setUploadError(message);
      toast.error(message);
    } finally {
      setCustomerEstimateBusy(false);
    }
  }

  function downloadKpFile(text: string, materialName: string) {
    const body =
      `${text.trim()}\n\n---\nПисьмо не отправляется из сервиса (SMTP отключён). ` +
      `Скопируйте текст или откройте файл в почтовом приложении вручную.\n`;
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `zapros-kp-${materialName.replace(/\s+/g, "-").slice(0, 40)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

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

  async function updateSupply(
    supply: (typeof supplies)[number],
    patch: Partial<(typeof supplies)[number]>
  ) {
    try {
      await api("/api/supply", {
        method: "POST",
        body: JSON.stringify({
          id: supply.id,
          procurementId: procurement!.id,
          materialName: supply.materialName,
          unit: supply.unit,
          qtyNeed: supply.qtyNeed,
          needBy: supply.needBy,
          workName: supply.workName,
          status: supply.status,
          quoteDraftText: supply.quoteDraftText,
          supplierName: supply.supplierName,
          supplierEmail: supply.supplierEmail,
          supplierNote: supply.supplierNote,
          qtyOrdered: supply.qtyOrdered,
          qtyDelivered: supply.qtyDelivered,
          unitPrice: supply.unitPrice,
          ...patch,
        }),
      });
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось сохранить поставку");
    }
  }

  function quoteText() {
    return [
      "Здравствуйте! Просим предоставить коммерческое предложение.",
      `Объект: ${procurement!.title}`,
      matWork.trim() ? `Вид работ: ${matWork.trim()}` : null,
      `Материал: ${matName.trim() || "укажите материал"}`,
      `Количество: ${matQty || "0"} ${matUnit || "шт"}`,
      `Желаемый срок поставки: ${formatDate(matNeedBy)}`,
      "Просим указать цену, срок действия предложения и условия доставки.",
    ].filter(Boolean).join("\n");
  }

  async function onUpload(file: File) {
    setBusy(true);
    setUploadError(null);
    try {
      const warning = await createDocumentUpload({
        procurementId: procurement!.id,
        title: file.name.replace(/\.[^.]+$/, ""),
        file,
        category: uploadCategory,
      });
      if (warning) toast.warning(warning);
      else toast.success(`Файл «${file.name}» добавлен в закупку`);
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

  async function refreshProjectAnalytics() {
    setAnalyticsBusy(true);
    try {
      await refreshAnalytics(procurement!.id);
      toast.success("Сводка проекта обновлена");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось обновить сводку");
    } finally {
      setAnalyticsBusy(false);
    }
  }

  async function analyzeProjectPackage() {
    setAiAnalyzing(true);
    try {
      await analyzeProjectWithAI(procurement!.id);
      toast.success("ИИ подготовил сводный анализ всего пакета");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось проанализировать пакет");
    } finally {
      setAiAnalyzing(false);
    }
  }

  async function onImportSourceAttachment(attachment: { id: string; name: string }) {
    setBusy(true);
    setUploadError(null);
    try {
      const response = await fetch("/api/zakupki/source-file", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ procurementId: procurement!.id, attachmentId: attachment.id }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error ?? "Не удалось скачать файл источника");
      }
      const file = new File([await response.blob()], attachment.name, {
        type: response.headers.get("content-type") ?? "application/octet-stream",
      });
      await createDocumentUpload({
        procurementId: procurement!.id,
        title: attachment.name,
        file,
        category: /смет|smeta/i.test(attachment.name)
          ? "estimate"
          : /договор|контракт|dogovor/i.test(attachment.name)
            ? "contract"
            : /\.(zip|rar|7z)$/i.test(attachment.name)
              ? "archive"
              : "general",
      });
      toast.success(`Файл «${attachment.name}» загружен в карточку`);
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ошибка загрузки файла";
      setUploadError(message);
      toast.error(message);
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
            {user && userHasSection(user, "zakupki") ? (
              <ProjectAiChat procurementId={procurement.id} projectTitle={procurement.title} screen="procurement" />
            ) : null}
            <StatusBadge status={procurement.status} />
            <ReviewBadge status={procurement.reviewStatus} />
            {procurement.lifecycle !== "production" && user?.sections.includes("zakupki") ? (
              <Button
                variant="outline"
                data-testid="procurement-won-to-production"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await ensureChain(procurement.id);
                    await api("/api/zakupki", {
                      method: "POST",
                      body: JSON.stringify({
                        action: "transferToProduction",
                        id: procurement.id,
                      }),
                    });
                    await refresh();
                    toast.success("Тендер отмечен выигранным и передан в производство");
                    router.push("/cabinet/proizvodstvo");
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : "Не удалось передать проект");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Передача…" : "Выиграли → в производство"}
              </Button>
            ) : null}
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

      <input
        ref={fileRef}
        type="file"
        className="sr-only"
        accept=".pdf,.doc,.docx,.xlsx,.zip,.rar,.png,.jpg,.jpeg,.webp,.tif,.tiff,.bmp"
        aria-label="Выберите документы для загрузки в закупку"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onUpload(f);
          e.target.value = "";
        }}
      />
      <input
        ref={customerEstimateRef}
        type="file"
        className="sr-only"
        accept=".xlsx,.xls,.xml,.gsfx,.gge"
        aria-label="Добавить смету заказчика"
        data-testid="customer-estimate-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onAttachCustomerEstimate(f);
          e.target.value = "";
        }}
      />

      <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-2">
        <TabsList className="mb-4 flex h-auto flex-wrap gap-1">
          <TabsTrigger value="overview">Карточка</TabsTrigger>
          {canDocs ? (
            <TabsTrigger value="docs">Документы ({docs.length})</TabsTrigger>
          ) : null}
          <TabsTrigger value="analytics">Аналитика</TabsTrigger>
          <TabsTrigger value="calc">Расчёт</TabsTrigger>
          {canGpr ? <TabsTrigger value="gpr">ГПР</TabsTrigger> : null}
          {canMoney ? (
            <TabsTrigger value="money" data-testid="tab-money">
              Деньги
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="supply">Поставки</TabsTrigger>
          {canRisks ? <TabsTrigger value="risks">Риски</TabsTrigger> : null}
        </TabsList>

        <TabsContent value="overview">
          <section className="mb-4 rounded-xl border border-[var(--tk-line)] bg-white/80 p-4" data-testid="procurement-overview-analysis">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="font-[family-name:var(--font-display)] text-base">Аналитика и документы проекта</h2>
                <p className="mt-1 text-xs text-[var(--tk-muted)]">
                  Загрузите файл или архив — система сохранит его в карточке, обновит сводку и разберёт доступные источники.
                </p>
                {analytics ? (
                  <div className="mt-3">
                    <p className="text-sm font-medium">Рекомендация: {PARTICIPATE_LABELS[analytics.recommendation]}</p>
                    <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm text-[var(--tk-muted)]">{analytics.summary}</p>
                    <p className="mt-1 text-xs text-[var(--tk-muted)]">Документов: {analytics.quality?.sourceDocuments ?? docs.length} · Цитат: {analytics.citations.length} · {analytics.quality?.status === "evidence_backed" ? "есть подтверждённые источниками тезисы" : "проверьте исходные документы"}</p>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-[var(--tk-muted)]">Сводки пока нет. После загрузки документа она появится здесь.</p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <label className="sr-only" htmlFor="overview-upload-category">Тип загружаемого файла</label>
                <select
                  id="overview-upload-category"
                  className="h-9 rounded-lg border border-[var(--tk-line)] bg-white px-2 text-sm"
                  value={uploadCategory}
                  onChange={(event) => setUploadCategory(event.target.value as DocumentCategory)}
                >
                  <option value="general">Другой файл</option>
                  <option value="estimate">Смета</option>
                  <option value="contract">Договор</option>
                  <option value="tz">ТЗ / извещение</option>
                  <option value="archive">Архив</option>
                </select>
                <Button variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
                  {busy ? "Загрузка…" : "Добавить файлы"}
                </Button>
                <Button
                  variant="outline"
                  disabled={customerEstimateBusy}
                  data-testid="add-customer-estimate"
                  onClick={() => customerEstimateRef.current?.click()}
                >
                  {customerEstimateBusy ? "Прикрепляю…" : "Добавить смету заказчика"}
                </Button>
                <Button variant="outline" disabled={analyticsBusy} onClick={() => void refreshProjectAnalytics()}>
                  {analyticsBusy ? "Обновляю…" : "Обновить сводку"}
                </Button>
                {docs.some((document) => document.citations.length > 0) ? (
                  <Button disabled={aiAnalyzing} onClick={() => void analyzeProjectPackage()}>
                    {aiAnalyzing ? "ИИ анализирует…" : "ИИ-анализ пакета"}
                  </Button>
                ) : null}
                <Button variant="ghost" onClick={() => setActiveTab("analytics")}>Подробная аналитика</Button>
              </div>
            </div>
            {original ? (
              <p className="mt-3 text-xs text-[var(--tk-muted)]" data-testid="customer-estimate-attached">
                Исходная смета заказчика: {original.title} · позиций {original.positions.length}
              </p>
            ) : null}
            {lastExchange ? (
              <div
                className="mt-3 rounded-lg border border-[var(--tk-line)] bg-stone-50 px-3 py-2 text-sm"
                data-testid="obmen-result-on-card"
              >
                <p className="font-medium">Результат обмена со сметным ПО</p>
                <p className="mt-1 text-xs text-[var(--tk-muted)]">
                  {lastExchange.name} · {formatDateTime(lastExchange.at)} · позиций{" "}
                  {lastExchange.positionsMapped}
                  {lastExchange.confirmed ? " · подтверждён" : " · ожидает подтверждения"}
                  {lastExchange.discrepancies.length
                    ? ` · расхождений ${lastExchange.discrepancies.length}`
                    : " · без расхождений"}
                </p>
                <Link href="/cabinet/obmen" className="mt-1 inline-block text-xs text-sky-800 underline">
                  Открыть раздел «Обмен»
                </Link>
              </div>
            ) : (
              <p className="mt-3 text-xs text-[var(--tk-muted)]" data-testid="obmen-result-empty">
                Результат обмена со сметным ПО пока не появлялся в этой карточке.
              </p>
            )}
          </section>
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
                <ol className="mt-3 space-y-2" aria-label="Этапы проекта">
                  {[
                    { label: "Заявка", detail: `${procurement.number} · ${docs.length} док.`, ready: true, href: `/cabinet/zakupki/${procurement.id}` },
                    { label: "Расчёт", detail: calc?.title ?? "Черновик ещё не создан", ready: Boolean(calc), href: calc ? `/cabinet/raschety/${calc.id}` : undefined },
                    { label: "ГПР", detail: gpr ? `${gpr.stages.length} этапов · версия ${gpr.version}` : "График ещё не создан", ready: Boolean(gpr), href: gpr && canGpr ? `/cabinet/gpr/${gpr.id}` : undefined },
                    { label: "Производство", detail: procurement.lifecycle === "production" ? "Контракт передан в производство" : "Ожидает отметки о победе", ready: procurement.lifecycle === "production", href: procurement.planFactId && canProduction ? `/cabinet/proizvodstvo?planFactId=${encodeURIComponent(procurement.planFactId)}` : undefined },
                  ].map((step, index) => (
                    <li key={step.label} className="flex items-start gap-3 rounded-lg border border-[var(--tk-line)] px-3 py-2">
                      <span className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${step.ready ? "bg-emerald-100 text-emerald-800" : "bg-stone-100 text-[var(--tk-muted)]"}`} aria-label={step.ready ? "Готово" : "Не создано"}>
                        {step.ready ? "✓" : index + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{step.href ? <Link className="underline decoration-[var(--tk-copper-deep)] underline-offset-2" href={step.href}>{step.label}</Link> : step.label}</span>
                        <span className="block break-words text-xs text-[var(--tk-muted)]">{step.detail}</span>
                      </span>
                    </li>
                  ))}
                </ol>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-md bg-stone-50 px-2 py-1.5">Оригинал сметы: {original ? <Link className="underline" href={`/cabinet/raschety/${original.id}`}>открыть</Link> : "нет"}</div>
                  <div className="rounded-md bg-stone-50 px-2 py-1.5">Деньги: {money ? "связаны" : "не заведены"}</div>
                  <div className="rounded-md bg-stone-50 px-2 py-1.5">Риски: {risk ? "карточка есть" : "не заведены"}</div>
                  <div className="rounded-md bg-stone-50 px-2 py-1.5">Поставки: {supplies.length}</div>
                </div>
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
          {procurement.attachments.some((attachment) => attachment.sourceUrl) ? (
            <section className="mb-4 rounded-xl border border-[var(--tk-line)] bg-white/80 p-4">
              <h2 className="font-medium">Файлы с площадки</h2>
              <p className="mt-1 text-xs text-[var(--tk-muted)]">
                Скачайте пакет в карточку: PDF, DOC, DOCX, XLSX, ZIP и RAR будут разобраны автоматически.
              </p>
              <ul className="mt-3 space-y-2">
                {procurement.attachments.filter((attachment) => attachment.sourceUrl).map((attachment) => (
                  <li key={attachment.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                    <span>{attachment.name} · {attachment.size}</span>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void onImportSourceAttachment(attachment)}>
                      Скачать и разобрать
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
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
            <Button
              disabled={busy}
              data-testid="upload-to-procurement"
              onClick={() => fileRef.current?.click()}
            >
              Добавить файл вручную
            </Button>
            <p className="text-xs text-[var(--tk-muted)]">
              PDF / DOC / DOCX / XLSX / ZIP / RAR. Ошибки распаковки показываются в карточке.
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
                      {!d.storedPath ? (
                        <div className="mt-1 text-xs font-medium text-amber-800">
                          Исходный файл не приложен или недоступен. Загрузите оригинал, чтобы открыть его и включить в анализ.
                        </div>
                      ) : null}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!d.storedPath}
                        title={!d.storedPath ? "Оригинальный файл недоступен" : undefined}
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
          {previewDoc ? (
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
              <DocumentWebPreview key={previewDoc.id} document={previewDoc} />
            </div>
          ) : null}
        </TabsContent>

        <TabsContent value="analytics">
          <div className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-[family-name:var(--font-display)] text-base" data-testid="analytics-main-title">
                Главное / краткие выводы
              </h2>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" disabled={analyticsBusy} onClick={() => void refreshProjectAnalytics()}>
                  {analyticsBusy ? "Обновляю…" : "Обновить сводку"}
                </Button>
                <Button
                  size="sm"
                  disabled={aiAnalyzing || docs.length === 0 || !docs.some((document) => document.citations.length > 0)}
                  title="Модель может вернуть только тезисы с дословной цитатой из загруженных документов"
                  onClick={() => void analyzeProjectPackage()}
                >
                  {aiAnalyzing ? "ИИ анализирует пакет…" : "ИИ-анализ всего пакета"}
                </Button>
              </div>
            </div>
            <p className="mb-3 text-xs text-[var(--tk-muted)]">
              Сводный запрос отправляет выдержки во внешний сервис анализа (может
              тарифицироваться). Неподтверждённые тезисы отбрасываются; цифры
              сметы считаются по формулам.
            </p>
            {analytics ? (
              <>
                <section
                  className="mb-4 rounded-xl border border-[var(--tk-line)] bg-stone-50 p-4"
                  data-testid="analytics-brief"
                  aria-label="Главное и краткие выводы"
                >
                  <p className="text-sm font-semibold">
                    Рекомендация: {PARTICIPATE_LABELS[analytics.recommendation]}
                  </p>
                  <pre className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">
                    {analytics.summary}
                  </pre>
                </section>
                <section className="mb-4 space-y-3" aria-label="Ключевые условия закупки">
                  <h3 className="text-sm font-semibold">Ключевые условия</h3>
                  <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-lg border border-[var(--tk-line)] bg-stone-50 p-3">
                      <dt className="text-xs text-[var(--tk-muted)]">Заказчик</dt>
                      <dd className="mt-1 text-sm font-medium">{procurement.customer || "Нет данных"}</dd>
                    </div>
                    <div className="rounded-lg border border-[var(--tk-line)] bg-stone-50 p-3">
                      <dt className="text-xs text-[var(--tk-muted)]">Срок подачи</dt>
                      <dd className="mt-1 text-sm font-medium">{formatDateTime(procurement.deadline)}</dd>
                    </div>
                    <div className="rounded-lg border border-[var(--tk-line)] bg-stone-50 p-3 sm:col-span-2">
                      <dt className="text-xs text-[var(--tk-muted)]">Предмет закупки</dt>
                      <dd className="mt-1 text-sm font-medium">{procurement.title}</dd>
                      {procurement.workType ? <dd className="mt-1 text-xs text-[var(--tk-muted)]">Вид работ: {procurement.workType}</dd> : null}
                    </div>
                  </dl>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {([
                      { label: "Оплата и аванс", citations: citationsMatching(analytics.citations, /оплат|аванс|отсроч|расч[её]т[а-яё]* по контракту/i) },
                      { label: "Штрафы и неустойки", citations: citationsMatching(analytics.citations, /штраф|пени|неустойк|санкци/i) },
                    ] as const).map((group) => (
                      <div key={group.label} className="rounded-lg border border-[var(--tk-line)] p-3">
                        <h4 className="text-sm font-medium">{group.label}</h4>
                        {group.citations.length ? (
                          <ul className="mt-2 space-y-2">
                            {group.citations.slice(0, 4).map((citation) => (
                              <li key={citation.id} className="text-sm leading-relaxed">
                                <blockquote>«{citation.text}»</blockquote>
                                <p className="mt-1 text-xs text-[var(--tk-muted)]">
                                  {citation.sourceFile}{citation.page ? `, стр. ${citation.page}` : ""}{citation.paragraph ? `, абз. ${citation.paragraph}` : ""}{citation.sheet ? `, лист ${citation.sheet}` : ""}{citation.cell ? `, ${citation.cell}` : ""}
                                </p>
                              </li>
                            ))}
                          </ul>
                        ) : <p className="mt-2 text-sm text-[var(--tk-muted)]">В извлечённых цитатах не найдено. Проверьте оригинал договора.</p>}
                        {group.citations.length > 4 ? <p className="mt-2 text-xs text-[var(--tk-muted)]">Показаны первые 4 из {group.citations.length} цитат; полный список ниже.</p> : null}
                      </div>
                    ))}
                  </div>
                  <div className="rounded-lg border border-[var(--tk-line)] p-3">
                    <h4 className="text-sm font-medium">Объём работ из загруженной сметы</h4>
                    {estimateRows.length ? (
                      <>
                        <p className="mt-1 text-xs text-[var(--tk-muted)]">Распознано позиций: {estimateRows.length}. Значения приведены из файла; суммы по разным единицам не складываются.</p>
                        <div className="mt-2 max-h-80 overflow-auto rounded-md border border-[var(--tk-line)]">
                          <table className="w-full table-fixed text-left text-xs">
                            <thead className="sticky top-0 bg-stone-100 text-[var(--tk-muted)]">
                              <tr><th className="w-[42%] p-2">Работа / ресурс</th><th className="w-[13%] p-2">Количество</th><th className="w-[8%] p-2">Ед.</th><th className="w-[17%] p-2">Цена</th><th className="w-[20%] p-2">Смета</th></tr>
                            </thead>
                            <tbody>
                              {estimateRows.map((position) => (
                                <tr key={`${position.id}-${position.sourceFile}`} className="border-t border-[var(--tk-line)]">
                                  <td className="break-words p-2"><span className="font-medium">{position.name}</span>{position.code ? <span className="ml-2 text-[var(--tk-muted)]">{position.code}</span> : null}</td>
                                  <td className="break-words p-2 tabular-nums">{formatNumber(position.quantity)}</td>
                                  <td className="p-2">{position.unit}</td>
                                  <td className="p-2 tabular-nums">{formatMoney(position.rate)}</td>
                                  <td className="break-words p-2 text-[var(--tk-muted)]">{position.sourceFile}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    ) : <p className="mt-2 text-sm text-[var(--tk-muted)]">Сметные объёмы не распознаны. Прикрепите смету или проверьте исходный файл.</p>}
                  </div>
                </section>
                {analytics.quality ? (
                  <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 rounded-lg border border-[var(--tk-line)] bg-stone-50 px-3 py-2 text-xs" data-testid="analytics-quality">
                    <span>{analytics.quality.status === "evidence_backed" ? "Источники разобраны" : analytics.quality.status === "needs_review" ? "Нужна проверка источников" : "Недостаточно источников"}</span>
                    <span>Документов: {analytics.quality.sourceDocuments}</span>
                    <span>Обязательных типов: {analytics.quality.requiredDocumentsFound}/3</span>
                    <span>Цитат: {analytics.quality.citationCount}</span>
                    {analytics.quality.acceptedClaims != null ? <span>Тезисов с цитатой: {analytics.quality.acceptedClaims}</span> : null}
                    {analytics.quality.rejectedClaims ? <span>Отброшено неподтверждённых: {analytics.quality.rejectedClaims}</span> : null}
                  </div>
                ) : null}
                <p className="mt-3 text-xs text-[var(--tk-muted)]">
                  {analytics.disclaimer} Метод: {analytics.method}. Без обещания
                  точности.
                </p>
                <h3 className="mt-4 text-sm font-medium">Цитаты из источников</h3>
                <ul className="mt-2 space-y-2" data-testid="analytics-citations">
                  {analytics.citations.length === 0 ? (
                    <li className="text-sm text-[var(--tk-muted)]">
                      Цитат пока нет — загрузите и разберите документы.
                    </li>
                  ) : (
                    analytics.citations.map((c) => (
                      <li
                        key={c.id}
                        className="rounded-lg border border-[var(--tk-line)] px-3 py-2 text-sm"
                        data-testid={`citation-${c.id}`}
                      >
                        <p className="text-xs font-medium text-[var(--tk-muted)]">
                          Источник: {c.sourceFile}
                          {c.page != null ? ` · стр. ${c.page}` : ""}
                          {c.paragraph ? ` · абз. ${c.paragraph}` : ""}
                          {c.sheet ? ` · лист ${c.sheet}` : ""}
                          {c.cell ? ` · ${c.cell}` : ""}
                        </p>
                        <blockquote className="mt-1 rounded-md bg-amber-50/80 px-2 py-1.5 italic leading-relaxed">
                          «{c.text}»
                        </blockquote>
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
              Ресурсный черновик редактируем; оригинал сметы заказчика не
              изменяется. Собственные ресурсы не пишутся в нормативную смету.
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
            {!canMoney ? (
              <ErrorState
                title="Нет доступа к разделу «dengi»"
                description="Вкладка денег в карточке закупки требует право dengi (вложенный ACL)."
              />
            ) : !money ? (
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
                  <DateInputRu
                    value={payDate}
                    onChange={setPayDate}
                    className="w-[140px]"
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
              Запрос можно подготовить и скачать файлом. Сервис сам письмо не
              отправляет (SMTP отключён); заказ и приёмка фиксируются вручную.
            </p>
            <section
              className="rounded-lg border border-[var(--tk-line)] bg-stone-50 p-3"
              data-testid="supply-buy-list-gpr"
            >
              <h4 className="text-sm font-medium">Список закупок из ГПР</h4>
              <p className="mt-1 text-xs text-[var(--tk-muted)]">
                Что / сколько / когда — по материалам этапов графика.
              </p>
              {gprBuyList.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--tk-muted)]">
                  {gpr
                    ? "Все материалы ГПР уже в потребностях или в ГПР нет материалов."
                    : "ГПР ещё не связан с закупкой — список пуст."}
                </p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {gprBuyList.map((need) => (
                    <li
                      key={need.key}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-white px-3 py-2 text-sm"
                      data-testid={`buy-list-${need.key}`}
                    >
                      <div>
                        <div className="font-medium">
                          {need.materialName} · {formatNumber(need.qtyNeed)}{" "}
                          {need.unit}
                        </div>
                        <div className="text-xs text-[var(--tk-muted)]">
                          Работа: {need.workName} · к {formatDate(need.needBy)}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          try {
                            await api("/api/supply", {
                              method: "POST",
                              body: JSON.stringify({
                                procurementId: procurement.id,
                                materialName: need.materialName,
                                unit: need.unit,
                                qtyNeed: need.qtyNeed,
                                needBy: need.needBy,
                                workName: need.workName,
                                status: "need",
                              }),
                            });
                            await refresh();
                            toast.success("Потребность создана из ГПР");
                          } catch (e) {
                            toast.error(
                              e instanceof Error ? e.message : "Ошибка"
                            );
                          }
                        }}
                      >
                        В потребность
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <div className="flex flex-wrap gap-2">
              <Input
                className="min-w-[180px]"
                placeholder="Вид работ (необязательно)"
                value={matWork}
                onChange={(e) => setMatWork(e.target.value)}
              />
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
              <DateInputRu
                value={matNeedBy}
                onChange={setMatNeedBy}
                className="w-[140px]"
              />
              <Input
                className="min-w-[160px]"
                placeholder="Поставщик (необязательно)"
                value={matSupplierName}
                onChange={(e) => setMatSupplierName(e.target.value)}
              />
              <Input
                className="min-w-[190px]"
                type="email"
                placeholder="Email поставщика"
                value={matSupplierEmail}
                onChange={(e) => setMatSupplierEmail(e.target.value)}
              />
              <Input
                className="min-w-[220px] flex-1"
                placeholder="Черновик запроса КП"
                value={matQuote}
                onChange={(e) => setMatQuote(e.target.value)}
              />
              <Button
                variant="outline"
                onClick={() => setMatQuote(quoteText())}
              >
                Сформировать запрос КП
              </Button>
              <Button
                variant="outline"
                data-testid="supply-kp-download"
                disabled={!matQuote.trim() && !matName.trim()}
                onClick={() => {
                  const text = matQuote.trim() || quoteText();
                  if (!text.trim()) {
                    toast.error("Сначала сформируйте текст запроса");
                    return;
                  }
                  setMatQuote(text);
                  downloadKpFile(text, matName.trim() || "material");
                  toast.success("Файл запроса КП готов (SMTP не используется)");
                }}
              >
                Скачать файл запроса КП
              </Button>
              <span className="text-xs text-amber-800" data-testid="supply-no-smtp">
                Отправка писем из сервиса отключена
              </span>
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
                        workName: matWork.trim() || undefined,
                        status: matQuote.trim() ? "quoted_draft" : "need",
                        quoteDraftText: matQuote.trim() || undefined,
                        supplierName: matSupplierName.trim() || undefined,
                        supplierEmail: matSupplierEmail.trim() || undefined,
                      }),
                    });
                    await refresh();
                    toast.success("Потребность сохранена");
                    setMatName("");
                    setMatWork("");
                    setMatQuote("");
                    setMatSupplierName("");
                    setMatSupplierEmail("");
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
                    {s.workName || s.supplierName || s.supplierEmail ? (
                      <div className="mt-1 text-xs text-[var(--tk-muted)]">
                        {s.workName ? `Работа: ${s.workName}. ` : ""}
                        {s.supplierName ? `Поставщик: ${s.supplierName}. ` : ""}
                        {s.supplierEmail ?? ""}
                      </div>
                    ) : null}
                    <details className="mt-2 text-xs">
                      <summary className="cursor-pointer text-[var(--tk-muted)]">
                        Контакт и запрос КП
                      </summary>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <Input
                          aria-label="Поставщик"
                          placeholder="Поставщик"
                          defaultValue={s.supplierName ?? ""}
                          onBlur={(e) => {
                            if (e.target.value !== (s.supplierName ?? "")) {
                              void updateSupply(s, { supplierName: e.target.value.trim() });
                            }
                          }}
                        />
                        <Input
                          aria-label="Email поставщика"
                          type="email"
                          placeholder="Email поставщика"
                          defaultValue={s.supplierEmail ?? ""}
                          onBlur={(e) => {
                            if (e.target.value !== (s.supplierEmail ?? "")) {
                              void updateSupply(s, { supplierEmail: e.target.value.trim() });
                            }
                          }}
                        />
                        <textarea
                          aria-label="Текст запроса коммерческого предложения"
                          className="min-h-24 rounded-lg border border-[var(--tk-line)] bg-white p-2 sm:col-span-2"
                          placeholder="Текст запроса КП"
                          defaultValue={s.quoteDraftText ?? ""}
                          onBlur={(e) => {
                            if (e.target.value !== (s.quoteDraftText ?? "")) {
                              void updateSupply(s, { quoteDraftText: e.target.value });
                            }
                          }}
                        />
                      </div>
                    </details>
                    <SupplierQuotesEditor supply={s} onUpdated={refresh} />
                    {s.quoteDraftText ? (
                      <div className="mt-2 space-y-2">
                        <pre className="whitespace-pre-wrap rounded bg-stone-50 p-2 text-xs">
                          {s.quoteDraftText}
                        </pre>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            downloadKpFile(s.quoteDraftText!, s.materialName)
                          }
                        >
                          Скачать файл запроса КП
                        </Button>
                      </div>
                    ) : null}
                    <div className="mt-2 flex flex-wrap items-end gap-2">
                      <label className="text-xs">
                        Заказано
                        <Input
                          className="mt-1 w-28"
                          type="number"
                          min="0"
                          step="any"
                          defaultValue={s.qtyOrdered}
                          onBlur={(e) => {
                            const value = Number(e.target.value);
                            if (Number.isFinite(value) && value !== s.qtyOrdered) {
                              void updateSupply(s, { qtyOrdered: value });
                            }
                          }}
                        />
                      </label>
                      <label className="text-xs">
                        Поставлено
                        <Input
                          className="mt-1 w-28"
                          type="number"
                          min="0"
                          step="any"
                          defaultValue={s.qtyDelivered}
                          onBlur={(e) => {
                            const value = Number(e.target.value);
                            if (Number.isFinite(value) && value !== s.qtyDelivered) {
                              void updateSupply(s, { qtyDelivered: value });
                            }
                          }}
                        />
                      </label>
                      <label className="text-xs">
                        Цена за единицу, ₽
                        <Input
                          className="mt-1 w-36"
                          type="number"
                          min="0"
                          step="any"
                          defaultValue={s.unitPrice ?? ""}
                          onBlur={(e) => {
                            const raw = e.target.value.trim();
                            const value = raw === "" ? null : Number(raw);
                            if (value === null || (Number.isFinite(value) && value !== s.unitPrice)) {
                              void updateSupply(s, { unitPrice: value });
                            }
                          }}
                        />
                      </label>
                      {s.supplierEmail && s.quoteDraftText ? (
                        <a
                          className="inline-flex h-9 items-center rounded-lg border px-3 text-sm hover:bg-stone-50"
                          href={`mailto:${encodeURIComponent(s.supplierEmail)}?subject=${encodeURIComponent(`Запрос КП: ${s.materialName}`)}&body=${encodeURIComponent(s.quoteDraftText)}`}
                        >
                          Открыть письмо
                        </a>
                      ) : null}
                    </div>
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
