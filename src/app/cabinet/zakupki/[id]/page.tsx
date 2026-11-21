"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DateInputRu } from "@/components/date-input-ru";
import { AiFailureBanner } from "@/components/ai-failure-banner";
import { api, downloadUrl, getClientToken } from "@/lib/api";
import { DocumentWebPreview } from "@/components/document-web-preview";
import { cleanLabel } from "@/lib/display";
import { formatDate, formatDateTime, formatMoney, formatNumber } from "@/lib/format";
import { citationTopicLabel, readableCitations, regionFromCitations, submissionDeadlineFromCitations } from "@/lib/citation-display";
import { citationHref, matchDirectorySuppliers } from "@/lib/wave23";
import { pickLastExchangeForProcurement } from "@/lib/obmen-for-procurement";
import { ANALYSIS_IMPORTANCE_LABELS, ANALYSIS_TOPIC_CHECKLIST } from "@/lib/ai-topics";
import { PARTICIPATE_LABELS } from "@/lib/project-analytics";
import { parseDecimalRu } from "@/lib/decimal-ru";
import { PAYMENT_AMOUNT_ERROR, PAYMENT_BUCKET_LABELS, paymentBucket, paymentTotals, type PaymentBucket } from "@/lib/money-payments";
import { userHasSection } from "@/lib/acl";
import { plainExchangeTitle } from "@/lib/exchange-label";
import { gprStageLabel } from "@/lib/gpr-stage-label";
import { visibleProcurementNumber } from "@/lib/pipeline";
import { STATUS_LABELS, SYNC_STATUS_LABELS } from "@/lib/roles";
import type { Citation, DocumentCategory, ReviewStatus, SupplyRequest, SupplyStatus, SupplierDirectoryEntry, OrganizationCompanyCard } from "@/lib/types";
import type { SupplierSearchCandidate } from "@/server/supplier-discovery";
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

function distinctCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = citation.text.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\s+/g, " ").replace(/[.!?]+$/g, "").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function meaningfulMetadata(value?: string): string | undefined {
  const text = value?.trim();
  return text && !/^(?:нет данных|не указан(?:а|о|ы)?(?: в карточке.*)?|не найден(?:а|о|ы)?|—|-)$/iu.test(text) ? text : undefined;
}

function keyAnalyticsCitations(citations: Citation[]) {
  const patterns = [
    /штраф|пени|неустойк|ответственност/iu,
    /оплат|аванс|отсроч|расч[её]т[а-яё]* по контракту/iu,
    /срок|дата подачи|период выполнен|начало работ|окончание работ/iu,
    /заказчик|организатор закупки/iu,
    /объ[её]м работ|предмет закупки|место выполнен/iu,
  ];
  return citations
    .map((citation, index) => ({
      citation,
      index,
      score: patterns.reduce((score, pattern, weight) => score + (pattern.test(citation.text) ? patterns.length - weight : 0), 0),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 6)
    .map(({ citation }) => citation);
}

function DirectoryNeedHints({
  material,
  suppliers,
}: {
  material: string;
  suppliers: SupplierDirectoryEntry[];
}) {
  const matched = matchDirectorySuppliers(material, suppliers);
  const search = `https://duckduckgo.com/?q=${encodeURIComponent(`${material} поставщик`)}`;
  return (
    <div className="mt-2 space-y-1 text-xs" data-testid="supply-directory-hints">
      <p data-testid="directory-suppliers">Справочник: {matched.length ? matched.map((supplier) => supplier.name).join(", ") : "подходящих поставщиков нет"}</p>
      <a className="underline" href={search} target="_blank" rel="noreferrer">Искать в открытых источниках</a>
    </div>
  );
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
  const searchParams = useSearchParams();
  const {
    data,
    user,
    orgProcurements,
    setProcurementReview,
    ensureChain,
    sendToCalculation,
    analyzeProjectWithAI,
    reanalyzeDocument,
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
  const [aiAnalyzing, setAiAnalyzing] = useState(false);
  const [selectedTab, setSelectedTab] = useState<string | null>(null);
  const requestedTab = searchParams.get("tab");
  const activeTab = selectedTab ?? (requestedTab && ["overview", "docs", "analytics", "calc", "gpr", "money", "supply", "risks"].includes(requestedTab) ? requestedTab : "overview");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [payTitle, setPayTitle] = useState("");
  const [payType, setPayType] = useState<PaymentBucket>("postuplenie");
  const [payAmount, setPayAmount] = useState("");
  const [paySaving, setPaySaving] = useState(false);
  const [ask, setAsk] = useState<
    | null
    | { kind: "payment"; id: string; title: string }
    | { kind: "rfq"; supply: SupplyRequest; supplier: SupplierDirectoryEntry }
    | { kind: "supplier"; id: string; name: string }
  >(null);
  const paySavingRef = useRef(false);
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
  const [supplierNameNew, setSupplierNameNew] = useState("");
  const [supplierEmailNew, setSupplierEmailNew] = useState("");
  const [supplierMaterialsNew, setSupplierMaterialsNew] = useState("");
  const [supplierRegionsNew, setSupplierRegionsNew] = useState("");
  const [supplierWebsiteNew, setSupplierWebsiteNew] = useState("");
  const [supplierSaving, setSupplierSaving] = useState(false);
  const [manifestBusy, setManifestBusy] = useState(false);
  const [companyCardBusy, setCompanyCardBusy] = useState(false);
  const [companyCard, setCompanyCard] = useState<OrganizationCompanyCard | null>(null);
  const [supplyMailReady, setSupplyMailReady] = useState(false);
  const [supplyMailDetail, setSupplyMailDetail] = useState("Проверяем почтовую настройку…");
  const [supplierSearchBusyId, setSupplierSearchBusyId] = useState<string | null>(null);
  const [supplierSearchResults, setSupplierSearchResults] = useState<Record<string, SupplierSearchCandidate[]>>({});
  const [supplierSearchErrors, setSupplierSearchErrors] = useState<Record<string, string>>({});
  const companyCardInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    api<{ companyCard: OrganizationCompanyCard | null; mail: { live: boolean; detail: string } }>("/api/supply")
      .then((result) => {
        if (!active) return;
        setCompanyCard(result.companyCard);
        setSupplyMailReady(result.mail.live);
        setSupplyMailDetail(result.mail.detail);
      })
      .catch(() => { if (active) setSupplyMailDetail("Не удалось проверить SMTP"); });
    return () => { active = false; };
  }, []);

  const docs = useMemo(
    () =>
      procurement
        ? data.documents.filter((d) => d.procurementId === procurement.id)
        : [],
    [data.documents, procurement]
  );
  const estimateRows = useMemo(
    () => docs
      .filter((document) =>
        document.category === "estimate" ||
        /smeta|смет/i.test(document.fileName) ||
        Boolean(document.estimatePositions?.length) ||
        (document.analysis?.positionCount ?? 0) > 0
      )
      .flatMap((document) => (document.estimatePositions ?? []).map((position) => ({
        ...position,
        sourceFile: document.fileName,
      }))),
    [docs]
  );
  const calc = procurement?.calculationId
    ? data.calculations.find((c) => c.id === procurement.calculationId)
    : undefined;
  const original = (procurement?.originalCalculationId
    ? data.calculations.find(
        (c) => c.id === procurement.originalCalculationId && c.procurementId === procurement.id && c.kind === "customer_original"
      )
    : undefined) ?? data.calculations.find(
        (c) => c.procurementId === procurement?.id && c.kind === "customer_original"
      );
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
  const suppliers = (data.suppliers ?? []).filter((supplier) => supplier.orgId === user?.orgId);
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
    }
  }

  function downloadKpFile(text: string, materialName: string) {
    const body =
      `${text.trim()}\n\n---\nТекст запроса на коммерческое предложение.\n`;
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
  const displayCitations = analytics ? readableCitations(analytics.citations) : [];
  const renderableCitations = displayCitations.map(({ displayText, ...citation }) => ({ ...citation, text: displayText }));
  const keyCitations = keyAnalyticsCitations(renderableCitations);
  const findingCitationIds = new Set(analytics?.findings?.flatMap((finding) => finding.citationIds) ?? []);
  const hasFindingTopic = (topic: string) => Boolean(analytics?.findings?.some((finding) => finding.topic === topic));
  const allPaymentCitations = citationsMatching(renderableCitations, /оплат|аванс|отсроч|расч[её]т[а-яё]* по контракту/i);
  const allLiabilityCitations = citationsMatching(renderableCitations, /штраф|пени|неустойк|санкци/i);
  const paymentCitations = hasFindingTopic("Оплата") ? [] : distinctCitations(allPaymentCitations).slice(0, 2);
  const liabilityCitations = hasFindingTopic("Ответственность") ? [] : distinctCitations(allLiabilityCitations).slice(0, 2);
  const conditionCitationIds = new Set([...allPaymentCitations, ...allLiabilityCitations].map((citation) => citation.id));
  const remainingKeyCitations = keyCitations.filter((citation) => !conditionCitationIds.has(citation.id) && !findingCitationIds.has(citation.id));
  const primaryCitationTexts = new Set([
    ...[...findingCitationIds].map((id) => displayCitations.find((citation) => citation.id === id)?.displayText),
    ...paymentCitations.map((citation) => citation.text),
    ...liabilityCitations.map((citation) => citation.text),
  ].filter(Boolean).map((text) => text!.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\s+/g, " ").replace(/[.!?]+$/g, "").trim()));
  const primaryCitationIds = new Set([
    ...findingCitationIds,
    ...keyCitations.filter((citation) => !conditionCitationIds.has(citation.id)).map((citation) => citation.id),
    ...conditionCitationIds,
  ]);
  const remainingCitations = displayCitations.filter((citation) => {
    const key = citation.displayText.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\s+/g, " ").replace(/[.!?]+$/g, "").trim();
    return !primaryCitationIds.has(citation.id) && !primaryCitationTexts.has(key);
  });
  const conditionGroups = [
    { label: "Оплата и аванс", citations: paymentCitations },
    { label: "Штрафы и неустойки", citations: liabilityCitations },
  ].filter((group) => group.citations.length > 0);
  const documentRegion = docs.map((document) => meaningfulMetadata(document.analysis?.region)).find(Boolean);
  const sourceRegion = meaningfulMetadata(procurement.region) || documentRegion || regionFromCitations(analytics?.citations ?? []);
  const sourceZone = docs.map((document) => meaningfulMetadata(document.analysis?.zone)).find(Boolean);
  const sourceDeadline = submissionDeadlineFromCitations(analytics?.citations ?? []);
  const cardDeadline = procurement.deadline && Number.isFinite(new Date(procurement.deadline).getTime())
    ? formatDateTime(procurement.deadline)
    : sourceDeadline ? `${sourceDeadline} · из документа` : "Не найден в карточке и документах";
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

  async function saveSupplierDirectoryEntry() {
    const keywords = supplierMaterialsNew.split(/[;,\n]/).map((value) => value.trim()).filter(Boolean);
    if (!supplierNameNew.trim() || !supplierEmailNew.trim() || keywords.length === 0) {
      toast.error("Укажите поставщика, email и материалы, которые он поставляет");
      return;
    }
    setSupplierSaving(true);
    try {
      await api("/api/supply", { method: "POST", body: JSON.stringify({
        action: "upsertSupplier",
        supplier: { name: supplierNameNew, email: supplierEmailNew, materialKeywords: keywords, regions: supplierRegionsNew.split(/[;,\n]/).map((value) => value.trim()).filter(Boolean), website: supplierWebsiteNew },
      }) });
      await refresh();
      setSupplierNameNew(""); setSupplierEmailNew(""); setSupplierMaterialsNew(""); setSupplierRegionsNew(""); setSupplierWebsiteNew("");
      toast.success("Поставщик добавлен в справочник");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось сохранить поставщика");
    } finally { setSupplierSaving(false); }
  }

  async function uploadCompanyCard(file?: File) {
    if (!file) return;
    setCompanyCardBusy(true);
    try {
      const form = new FormData(); form.set("action", "companyCard"); form.set("file", file);
      const result = await api<{ companyCard: OrganizationCompanyCard | null }>("/api/supply", { method: "POST", body: form });
      setCompanyCard(result.companyCard);
      toast.success("Карточка предприятия сохранена и будет приложена к запросам КП");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось загрузить карточку предприятия");
    } finally { setCompanyCardBusy(false); }
  }

  async function generateMaterialManifest() {
    setManifestBusy(true);
    try {
      const result = await api<{ manifest: { created: number } }>("/api/supply", { method: "POST", body: JSON.stringify({ action: "generateManifest", procurementId: procurement!.id }) });
      await refresh();
      toast.success(result.manifest.created ? `Ведомость создана: добавлено ${result.manifest.created} поз.` : "Новых материальных позиций нет — ведомость уже актуальна");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось сформировать ведомость");
    } finally { setManifestBusy(false); }
  }

  async function sendSupplierRfq(supply: SupplyRequest, supplier: SupplierDirectoryEntry) {
    try {
      const result = await api<{ sent?: boolean; status?: string; message?: string; text?: string; fileName?: string }>("/api/supply", { method: "POST", body: JSON.stringify({ action: "sendRfq", id: supply.id, supplierId: supplier.id, confirmed: true }) });
      await refresh();
      if (result.sent === false) {
        toast.message(result.message ?? "Письмо не отправлено: почта не подключена. Файл запроса сохранён/скачайте его");
        if (result.text) {
          const blob = new Blob([result.text], { type: "text/plain;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = result.fileName ?? "zapros-kp.txt";
          link.click();
          URL.revokeObjectURL(url);
        }
        return;
      }
      toast.success(`Запрос КП отправлен: ${supplier.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось отправить запрос КП");
    }
  }

  async function searchPublicSuppliers(supply: SupplyRequest) {
    setSupplierSearchBusyId(supply.id);
    setSupplierSearchErrors((current) => ({ ...current, [supply.id]: "" }));
    try {
      const result = await api<{ candidates: SupplierSearchCandidate[] }>("/api/supply", {
        method: "POST", body: JSON.stringify({ action: "discoverSuppliers", id: supply.id }),
      });
      setSupplierSearchResults((current) => ({ ...current, [supply.id]: result.candidates }));
    } catch (error) {
      setSupplierSearchErrors((current) => ({ ...current, [supply.id]: error instanceof Error ? error.message : "Поиск поставщиков не выполнен" }));
    } finally { setSupplierSearchBusyId(null); }
  }

  async function addDiscoveredSupplier(supply: SupplyRequest, candidate: SupplierSearchCandidate) {
    if (!candidate.email) return;
    try {
      await api("/api/supply", { method: "POST", body: JSON.stringify({
        action: "upsertSupplier",
        supplier: {
          name: candidate.name, email: candidate.email,
          materialKeywords: [...new Set([supply.materialName, ...candidate.materials])],
          regions: [procurement!.region], website: candidate.website,
          note: `Найден ИИ-поиском; проверьте сведения перед отправкой КП. Источник: ${candidate.sourceUrl}. ${candidate.evidence}`,
        },
      }) });
      await refresh();
      setSupplierSearchResults((current) => ({ ...current, [supply.id]: (current[supply.id] ?? []).filter((item) => item.sourceUrl !== candidate.sourceUrl) }));
      toast.success("Поставщик добавлен и сопоставлен с материалом. Проверьте email и ассортимент.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Не удалось добавить поставщика"); }
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
      if (uploadCategory === "estimate") {
        await api("/api/zakupki", {
          method: "POST",
          body: JSON.stringify({ action: "attachCustomerEstimate", id: procurement!.id, fileName: file.name }),
        });
      }
      if (warning) toast.warning(warning);
      else toast.success(uploadCategory === "estimate" ? "Смета заказчика добавлена" : `Файл «${file.name}» добавлен в закупку`);
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

  async function analyzeProjectPackage() {
    setAiAnalyzing(true);
    try {
      const warning = await analyzeProjectWithAI(procurement!.id);
      if (warning) toast.warning(warning);
      else toast.success("ИИ подготовил сводный анализ всего пакета");
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
      const token = getClientToken();
      const response = await fetch("/api/zakupki/source-file", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
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
        description={`${visibleProcurementNumber(procurement)} · ${procurement.customer}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => router.push("/cabinet/zakupki")}>Назад</Button>
            {user && userHasSection(user, "zakupki") ? (
              <ProjectAiChat procurementId={procurement.id} projectTitle={procurement.title} screen="procurement" />
            ) : null}
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
                    const summary = await sendToCalculation(procurement.id);
                    if (summary.sourceRows > 0 && summary.missingRates > 0) {
                      toast.warning(
                        `Черновик создан из «${summary.sourceFile}»: ${summary.sourceRows} строк, ставок найдено ${summary.matchedRates}, без ставки ${summary.missingRates}. Проверьте неполные позиции.`
                      );
                    } else if (summary.sourceRows > 0) {
                      toast.success(
                        `Черновик создан из «${summary.sourceFile}»: ${summary.sourceRows} строк, ставки сопоставлены по коду и единице.`
                      );
                    } else {
                      toast.warning(
                        "Расчёт создан, но сметные строки не распознаны. Загрузите смету XLSX или добавьте позиции вручную."
                      );
                    }
                } catch (e) {
                  toast.error(
                    e instanceof Error ? e.message : "Не удалось отправить"
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Сформировать расчёт (расчёт по формулам, без ИИ)
            </Button>
            {canGpr ? <Button
              variant="outline"
              data-testid="create-gpr"
              disabled={busy || !procurement.calculationId}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await api<{ scheduleOutcome?: "estimate" | "placeholder" | "unchanged" }>("/api/zakupki", {
                    method: "POST",
                    body: JSON.stringify({ action: "createGpr", id: procurement.id }),
                  });
                  await refresh();
                  toast.success(
                    result.scheduleOutcome === "estimate"
                      ? "График создан по смете"
                      : result.scheduleOutcome === "placeholder"
                        ? "График создан. В смете нет разделов, этапы нужно заполнить."
                        : "График уже заполнен",
                  );
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "Не удалось создать график");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Создать ГПР
            </Button> : null}
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
        accept=".pdf,.xlsx,.xls,.xml,.gsfx,.gge"
        aria-label="Добавить смету заказчика"
        data-testid="customer-estimate-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onAttachCustomerEstimate(f);
          e.target.value = "";
        }}
      />

      {(() => {
        const failedDocument = docs.find((document) => document.aiFailure);
        const aiFailure = procurement.analytics?.aiFailure ?? failedDocument?.aiFailure;
        if (!aiFailure) return null;
        return (
          <div className="mb-4">
            <AiFailureBanner
              status={aiFailure}
              pending={aiAnalyzing}
              onRetry={() => {
                if (procurement.analytics?.aiFailure || !failedDocument) {
                  void analyzeProjectPackage();
                  return;
                }
                setAiAnalyzing(true);
                void reanalyzeDocument(failedDocument.id, { useLlm: true })
                  .then(() => toast.success("Повторный анализ документа завершён"))
                  .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Не удалось повторить анализ"))
                  .finally(() => setAiAnalyzing(false));
              }}
            />
          </div>
        );
      })()}

      <Tabs value={activeTab} onValueChange={setSelectedTab} className="mt-2">
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
            <div className="grid min-w-0 gap-3">
              <div className="min-w-0">
                <h2 className="font-[family-name:var(--font-display)] text-base">Аналитика и документы проекта</h2>
                <p className="mt-1 text-xs text-[var(--tk-muted)]">
                  Загрузите файл или архив — система сохранит его в карточке, обновит сводку и разберёт доступные источники.
                </p>
                {analytics ? (
                  <div className="mt-3">
                    <p className="text-sm font-medium">Рекомендация: {PARTICIPATE_LABELS[analytics.recommendation]}</p>
                    <p className="mt-1 line-clamp-3 text-sm text-[var(--tk-muted)]">{analytics.summary.split(/\n\n/)[0].replace(/\s+/g, " ").slice(0, 420)}</p>
                    <p className="mt-1 text-xs text-[var(--tk-muted)]">Документов: {analytics.quality?.sourceDocuments ?? docs.length}</p>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-[var(--tk-muted)]">Сводки пока нет. После загрузки документа она появится здесь.</p>
                )}
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
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
                <Button disabled={busy} onClick={() => fileRef.current?.click()}>
                  {busy ? "Загрузка…" : "Добавить файлы"}
                </Button>
                <Button
                  variant="outline"
                  disabled={aiAnalyzing || docs.length === 0}
                  title={docs.length === 0 ? "Сначала загрузите документы" : undefined}
                  onClick={() => void analyzeProjectPackage()}
                >
                  {aiAnalyzing ? "ИИ анализирует…" : "ИИ-анализ пакета"}
                </Button>
                {docs.length === 0 ? (
                  <span className="text-xs text-[var(--tk-muted)]">Сначала загрузите документы</span>
                ) : null}
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
                  Файл: {plainExchangeTitle(lastExchange.name)}. Позиций {lastExchange.positionsMapped}.{" "}
                  {lastExchange.confirmed ? "Подтверждено." : "Ожидает подтверждения."}
                  {lastExchange.discrepancies.length
                    ? ` Расхождений: ${lastExchange.discrepancies.length}.`
                    : " Без расхождений."}
                  {" "}{formatDateTime(lastExchange.at)}
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
                    {procurement.source === "manual" ? "Создано вручную" : /контур|api/iu.test(procurement.source) ? "Площадка" : cleanLabel(procurement.source)}{" "}
                    {procurement.sourceUrl ? <a href={procurement.sourceUrl} target="_blank" rel="noreferrer" className="ml-1 text-xs font-normal underline">Открыть на площадке</a> : null}
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
                    {(() => {
                      const original = data.procurements.find((p) => p.id === procurement.duplicateOf);
                      return original ? visibleProcurementNumber(original) : "карточка";
                    })()}
                  </Link>
                </p>
              ) : null}
              <p className="mt-4 text-xs text-[var(--tk-muted)]">
                Создано {formatDate(procurement.createdAt)}
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
                        ({
                          novaya: "Новое",
                          na_rassmotrenii: "В работе",
                          odobrena: "Участвуем",
                          otklonena: "Не участвуем",
                          dublirovana: "Дубликат",
                        } as Record<string, string>)[String(value)] ?? "Рассмотрение"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="novaya">Новое</SelectItem>
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
                    { label: "Заявка", detail: `${visibleProcurementNumber(procurement)} · ${docs.length} док.`, ready: true, href: `/cabinet/zakupki/${procurement.id}` },
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
                        {d.fileName} · {d.category === "estimate" ? "Смета" : d.category === "contract" ? "Договор" : d.category === "tz" ? "ТЗ" : d.category === "archive" ? "Архив" : "Файл"} · {STATUS_LABELS[d.status] ?? "Файл"}
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
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!d.storedPath}
                        onClick={() => {
                          void downloadUrl(`/api/dokumenty/file?id=${d.id}`).catch((error: unknown) => {
                            toast.error(error instanceof Error ? error.message : "Не удалось скачать файл");
                          });
                        }}
                      >
                        Скачать
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
                <Button
                  size="sm"
                  disabled={aiAnalyzing || docs.length === 0}
                  title={docs.length === 0 ? "Сначала загрузите документы" : "Разбор пакета по загруженным документам"}
                  onClick={() => void analyzeProjectPackage()}
                >
                  {aiAnalyzing ? "ИИ анализирует пакет…" : "ИИ-анализ пакета"}
                </Button>
                {docs.length === 0 ? (
                  <span className="self-center text-xs text-[var(--tk-muted)]">Сначала загрузите документы</span>
                ) : null}
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
                  <div className="mt-2 space-y-1 text-sm leading-relaxed text-[var(--tk-foreground)]">
                    {analytics.summary.split("\n").filter((line) => line.trim()).map((line, index) => (
                      <p key={`${index}-${line}`} className={index === 0 ? "font-medium" : "text-[var(--tk-muted)]"}>{line}</p>
                    ))}
                    {(procurement.customerAnswers ?? []).map((item) => (
                      <p key={item.question}>Ответ на вопрос «{item.question}»: {item.answer}</p>
                    ))}
                  </div>
                </section>
                {analytics.findings?.length ? (
                  <section className="mb-4 rounded-xl border border-[var(--tk-line)] bg-white p-4" data-testid="analytics-findings">
                    <div className="mb-3 flex items-baseline justify-between gap-2">
                      <h3 className="text-sm font-semibold">Что нашли в документах</h3>
                      <span className="text-xs text-[var(--tk-muted)]">{analytics.findings.length} подтверждённых вывода</span>
                    </div>
                    <ul className="space-y-2">
                      {analytics.findings.map((finding, index) => {
                        const quote = finding.quote?.replace(/\s+/g, " ").trim();
                        const sameFile = (citation: { id: string; sourceFile: string; text: string }) =>
                          finding.citationIds.includes(citation.id) &&
                          (!finding.sourceFiles?.length || finding.sourceFiles.includes(citation.sourceFile));
                        const quoted = analytics.citations.filter((citation) =>
                          sameFile(citation) && quote && citation.text.replace(/\s+/g, " ").includes(quote)
                        );
                        const source = [...quoted].sort((left, right) => left.text.length - right.text.length || (left.paragraph ?? 999) - (right.paragraph ?? 999))[0]
                          ?? analytics.citations.find((citation) => sameFile(citation));
                        const importanceLabel = ANALYSIS_IMPORTANCE_LABELS[finding.importance] ?? "К сведению";
                        return (
                          <li key={`${finding.topic}-${index}`} className="rounded-lg border border-[var(--tk-line)] px-3 py-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-xs font-semibold text-[var(--tk-muted)]">{finding.topic}</span>
                              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${finding.importance === "critical" || finding.importance === "high" ? "bg-amber-100 text-amber-900" : "bg-stone-100 text-stone-700"}`}>{importanceLabel}</span>
                            </div>
                            <p className="mt-1 text-sm leading-relaxed">{finding.text}</p>
                            <p className="mt-1 text-xs text-[var(--tk-muted)]">Влияние на себестоимость: {finding.costImpact || "не указано в документах"}</p>
                            <p className="text-xs text-[var(--tk-muted)]">Влияние на срок: {finding.scheduleImpact || "не указано в документах"}</p>
                            <details className="mt-2">
                              <summary className="w-fit cursor-pointer text-xs font-medium text-[var(--tk-muted)]">Показать фрагмент и источник</summary>
                              <blockquote className="mt-2 break-words rounded-md bg-stone-50 px-3 py-2 text-sm leading-relaxed [overflow-wrap:anywhere]">«{finding.quote}»</blockquote>
                              {source ? <p className="mt-1 text-xs text-[var(--tk-muted)]">{(() => {
                                const linked = docs.find((item) => item.fileName === source.sourceFile);
                                const label = `${source.sourceFile}${source.sheet ? ` · лист ${source.sheet}` : source.page ? ` · стр. ${source.page}` : ""}${source.paragraph ? ` · абз. ${source.paragraph}` : ""}${source.cell ? ` · ${source.cell}` : ""}`;
                                return linked ? <Link className="underline" href={citationHref(linked.id, source)}>{label}</Link> : label;
                              })()}</p> : null}
                            </details>
                          </li>
                        );
                      })}
                    </ul>
                    <div className="mt-4" data-testid="analytics-topic-coverage">
                      <h4 className="text-sm font-semibold">Что ещё искали в документах</h4>
                      <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                        {ANALYSIS_TOPIC_CHECKLIST.map((topic) => {
                          const found = analytics.findings?.some((finding) => finding.topic === topic.label);
                          return (
                            <li key={topic.key} className="text-sm">
                              {topic.label}: {found ? "есть вывод с цитатой" : "не указано в документах"}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  </section>
                ) : null}
                {analytics.customerQuestions?.length ? (
                  <section className="mb-4 rounded-xl border border-[var(--tk-line)] bg-white p-4" data-testid="analytics-customer-questions">
                    <h3 className="text-sm font-semibold">Вопросы заказчику</h3>
                    <ul className="mt-2 space-y-3 text-sm">
                      {analytics.customerQuestions.map((question, index) => {
                        const saved = procurement.customerAnswers?.find((item) => item.question === question);
                        return <li key={`${index}-${question}`} className="rounded-lg border border-[var(--tk-line)] p-3">
                          <p>{question}</p>
                          {saved ? <p className="mt-1 text-[var(--tk-muted)]">Ответ: {saved.answer}</p> : null}
                          <form className="mt-2 flex flex-wrap gap-2" onSubmit={(event) => {
                            event.preventDefault();
                            const answer = new FormData(event.currentTarget).get("answer");
                            if (typeof answer !== "string" || !answer.trim()) return;
                            void api("/api/zakupki", { method: "POST", body: JSON.stringify({ action: "answerCustomerQuestion", id: procurement.id, question, answer }) })
                              .then(() => refresh())
                              .then(() => toast.success("Ответ сохранён в карточке"))
                              .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Не удалось сохранить ответ"));
                          }}>
                            <Input name="answer" aria-label={`Ответ · ${question}`} defaultValue={saved?.answer ?? ""} placeholder="Ответ сохранится в карточке" className="h-9 max-w-md" />
                            <Button type="submit" size="sm" variant="outline">Ответить</Button>
                          </form>
                        </li>;
                      })}
                    </ul>
                    {procurement.customerAnswers?.length ? <p className="mt-3 text-xs text-[var(--tk-muted)]">Ответы добавлены в записку и чат этой закупки. Письмо заказчику не отправляется.</p> : null}
                  </section>
                ) : null}
                {analytics.economics ? (
                  <section className="mb-4 rounded-xl border border-[var(--tk-line)] bg-white p-4" data-testid="analytics-economics">
                    <h3 className="text-sm font-semibold">Себестоимость и рентабельность</h3>
                    {(() => {
                      const draft = data.calculations.find((item) => item.id === procurement.calculationId);
                      if (draft && draft.positions.length > 0) return null;
                      return <p className="mt-2 text-sm" data-testid="analytics-economics-empty">Расчёт не заполнен. {procurement.calculationId ? <Link className="underline" href={`/cabinet/raschety/${procurement.calculationId}`}>Открыть расчёт</Link> : null}</p>;
                    })()}
                    <dl className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
                      {([
                        ["Себестоимость", analytics.economics.cost],
                        ["Цена без НДС", analytics.economics.priceExVat],
                        ["Цена с НДС", analytics.economics.priceWithVat],
                        ["Расчётная прибыль", analytics.economics.profit],
                      ] as const).map(([label, value]) => (
                        <div key={label} className="rounded-lg border border-[var(--tk-line)] bg-stone-50 p-3">
                          <dt className="text-xs text-[var(--tk-muted)]">{label}</dt>
                          <dd className="mt-1 text-sm font-semibold tabular-nums">{value == null || !(data.calculations.find((item) => item.id === procurement.calculationId)?.positions.length) ? "Расчёт не заполнен" : formatMoney(value)}</dd>
                        </div>
                      ))}
                      <div className="rounded-lg border border-[var(--tk-line)] bg-stone-50 p-3">
                        <dt className="text-xs text-[var(--tk-muted)]">Рентабельность / маржа</dt>
                        <dd className="mt-1 text-sm font-semibold tabular-nums">
                          {analytics.economics.profitabilityPercent == null ? "—" : `${analytics.economics.profitabilityPercent}%`}
                          {analytics.economics.revenueMarginPercent == null ? "" : ` / ${analytics.economics.revenueMarginPercent}%`}
                        </dd>
                        <dd className="mt-1 text-[10px] text-[var(--tk-muted)]">к себестоимости / в цене</dd>
                      </div>
                    </dl>
                    {!analytics.economics.complete ? (
                      <p className="mt-2 text-xs text-amber-900">Расчёт неполный. Причины перечислены ниже; неполные суммы не считаются подтверждённой экономикой.</p>
                    ) : null}
                  </section>
                ) : null}
                <section className="mb-4 space-y-3" aria-label="Ключевые условия закупки">
                  <h3 className="text-sm font-semibold">Ключевые условия</h3>
                  <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-lg border border-[var(--tk-line)] bg-stone-50 p-3">
                      <dt className="text-xs text-[var(--tk-muted)]">Заказчик</dt>
                      <dd className="mt-1 text-sm font-medium">{procurement.customer || "Не указан в карточке"}</dd>
                    </div>
                    <div className="rounded-lg border border-[var(--tk-line)] bg-stone-50 p-3">
                      <dt className="text-xs text-[var(--tk-muted)]">Срок подачи</dt>
                      <dd className="mt-1 text-sm font-medium">{cardDeadline}</dd>
                    </div>
                    {sourceRegion ? (
                      <div className="rounded-lg border border-[var(--tk-line)] bg-stone-50 p-3">
                        <dt className="text-xs text-[var(--tk-muted)]">Регион</dt>
                        <dd className="mt-1 text-sm font-medium">{sourceRegion}{sourceZone ? ` · зона ${sourceZone}` : ""}</dd>
                      </div>
                    ) : null}
                    <div className="rounded-lg border border-[var(--tk-line)] bg-stone-50 p-3 sm:col-span-2">
                      <dt className="text-xs text-[var(--tk-muted)]">Предмет закупки</dt>
                      <dd className="mt-1 text-sm font-medium">{procurement.title}</dd>
                      {procurement.workType ? <dd className="mt-1 text-xs text-[var(--tk-muted)]">Вид работ: {procurement.workType}</dd> : null}
                    </div>
                  </dl>
                  {conditionGroups.length ? <div className="grid gap-3 lg:grid-cols-2">
                    {conditionGroups.map((group) => (
                      <div key={group.label} className="rounded-lg border border-[var(--tk-line)] p-3">
                        <h4 className="text-sm font-medium">{group.label}</h4>
                        {group.citations.length ? (
                          <ul className="mt-2 space-y-2">
                            {group.citations.map((citation) => (
                              <li key={citation.id} className="text-sm leading-relaxed">
                                <p className="break-words leading-relaxed [overflow-wrap:anywhere]">{citation.text}</p>
                                <p className="mt-1 break-words text-xs text-[var(--tk-muted)] [overflow-wrap:anywhere]">
                                  {citation.sourceFile}{citation.sheet ? `, лист ${citation.sheet}` : citation.page ? `, стр. ${citation.page}` : ""}{citation.paragraph ? `, абз. ${citation.paragraph}` : ""}{citation.cell ? `, ${citation.cell}` : ""}
                                </p>
                              </li>
                            ))}
                          </ul>
                        ) : <p className="mt-2 text-sm text-[var(--tk-muted)]">В извлечённых цитатах не найдено. Проверьте оригинал договора.</p>}
                      </div>
                    ))}
                  </div> : null}
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
                    <span>{analytics.quality.status === "evidence_backed" ? "Источники разобраны" : analytics.quality.status === "needs_review" ? "Есть замечания — смотрите список действий ниже" : "Не хватает проверяемых исходников"}</span>
                    <span>Документов: {analytics.quality.sourceDocuments}</span>
                    <span>Распознаны типы смета / договор / ТЗ: {analytics.quality.requiredDocumentsFound}/3</span>
                    <span>Проверяемых фрагментов: {displayCitations.length}</span>
                    {analytics.quality.acceptedClaims != null ? <span>Тезисов с цитатой: {analytics.quality.acceptedClaims}</span> : null}
                    {analytics.quality.rejectedClaims ? <span>Отброшено неподтверждённых: {analytics.quality.rejectedClaims}</span> : null}
                  </div>
                ) : null}
                {analytics.missingInputs.length ? (
                  <section className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4" data-testid="analytics-action-items">
                    <h3 className="text-sm font-semibold text-amber-950">Что именно проверить или подтвердить</h3>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-950">
                      {analytics.missingInputs.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
                    </ul>
                  </section>
                ) : null}
                <p className="mt-3 text-xs text-[var(--tk-muted)]">
                  {analytics.disclaimer} Метод: {analytics.method}. Без обещания
                  точности.
                </p>
                {remainingKeyCitations.length || remainingCitations.length ? (
                  <section className="mt-4" aria-label="Дополнительные подтверждения из документов">
                    <h3 className="text-sm font-medium">Дополнительные подтверждения из документов</h3>
                    <ul className="mt-2 grid gap-2 sm:grid-cols-2" data-testid="analytics-citations">
                    {remainingKeyCitations.map((c) => {
                      const source = displayCitations.find((citation) => citation.id === c.id);
                      return (
                        <li key={c.id} className="min-w-0 rounded-lg border border-[var(--tk-line)] bg-white px-3 py-3 text-sm" data-testid={`citation-${c.id}`}>
                          <span className="inline-flex rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-[var(--tk-muted)]">{citationTopicLabel(c.text)}</span>
                          <p className="mt-2 line-clamp-4 break-words leading-relaxed [overflow-wrap:anywhere]">{source?.displayText ?? c.text}</p>
                          <p className="mt-2 break-words text-xs text-[var(--tk-muted)] [overflow-wrap:anywhere]">
                            {c.sourceFile}{c.sheet ? ` · лист ${c.sheet}` : c.page ? ` · стр. ${c.page}` : ""}{c.paragraph ? ` · абз. ${c.paragraph}` : ""}{c.cell ? ` · ${c.cell}` : ""}
                          </p>
                        </li>
                      );
                    })}
                    </ul>
                    {remainingCitations.length ? (
                      <details className="mt-3 rounded-lg border border-[var(--tk-line)] bg-stone-50 px-3 py-2">
                        <summary className="cursor-pointer text-sm font-medium">
                          Показать остальные фрагменты ({remainingCitations.length})
                        </summary>
                        <ul className="mt-3 space-y-2" data-testid="analytics-all-citations">
                          {remainingCitations.map((c) => (
                            <li key={c.id} className="min-w-0 rounded-lg border border-[var(--tk-line)] bg-white px-3 py-2 text-sm">
                              <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-[var(--tk-muted)]">
                                <span className="rounded-full bg-stone-100 px-2 py-0.5">{c.topicLabel}</span>
                                <span className="break-all">{c.sourceFile}{c.sheet ? ` · лист ${c.sheet}` : c.page != null ? ` · стр. ${c.page}` : ""}{c.paragraph ? ` · абз. ${c.paragraph}` : ""}{c.cell ? ` · ${c.cell}` : ""}</span>
                              </p>
                              <p className="mt-1 break-words leading-relaxed [overflow-wrap:anywhere]">{c.displayText}</p>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </section>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-[var(--tk-muted)]">
                Сводка ещё не собрана. Загрузите документы и нажмите «ИИ-анализ пакета»
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
                Черновика нет — нажмите «Сформировать расчёт (расчёт по формулам, без ИИ)».
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
                      <div className="font-medium" title={gprStageLabel(s).title}>{gprStageLabel(s).text}</div>
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
                График создаётся кнопкой «Создать ГПР».
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
                <div className="mt-3 grid gap-2 sm:grid-cols-3" data-testid="money-totals">
                  {(["avans", "postuplenie", "spisanie", "klyuchevoy"] as const).map((bucket) => (
                    <div key={bucket} className="rounded-lg bg-stone-50 px-3 py-2 text-sm">
                      <span className="text-[var(--tk-muted)]">{bucket === "avans" ? "Авансы" : bucket === "postuplenie" ? "Поступления" : bucket === "spisanie" ? "Списания" : "Ключевые"}</span>
                      <span className="ml-2 font-semibold">{formatMoney(paymentTotals(money.payments)[bucket])}</span>
                    </div>
                  ))}
                </div>
                <ul className="mt-3 space-y-2">
                  {money.payments.map((pay) => (
                    <li
                      key={pay.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2"
                    >
                      <span className="text-xs font-medium">{PAYMENT_BUCKET_LABELS[paymentBucket(pay)]}</span>
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
                        key={`${pay.id}:${pay.amount}`}
                        className="w-32"
                        aria-label={`Сумма платежа ${pay.title}`}
                        defaultValue={String(pay.amount)}
                        onBlur={async (e) => {
                          const amount = parseDecimalRu(e.target.value);
                          if (amount == null || amount <= 0) {
                            toast.error(PAYMENT_AMOUNT_ERROR);
                            e.target.value = String(pay.amount);
                            return;
                          }
                          if (amount === pay.amount) return;
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
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setAsk({ kind: "payment", id: pay.id, title: pay.title })}
                      >
                        Удалить
                      </Button>
                    </li>
                  ))}
                </ul>
                <div className="mt-4 flex flex-wrap items-end gap-2 border-t pt-4">
                  <Input
                    placeholder="Название, например 2 этап"
                    aria-label="Название платежа"
                    value={payTitle}
                        onChange={(e) => setPayTitle(e.target.value)}
                  />
                  <select
                    aria-label="Тип платежа"
                    className="h-9 rounded-lg border border-[var(--tk-line)] bg-white px-2 text-sm"
                    data-testid="money-payment-type"
                    value={payType}
                    onChange={(event) => setPayType(event.target.value as PaymentBucket)}
                  >
                    <option value="avans">Аванс</option>
                    <option value="postuplenie">Поступление</option>
                    <option value="spisanie">Списание</option>
                  </select>
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
                    disabled={paySaving}
                    onClick={async () => {
                      if (paySavingRef.current) return;
                      const amount = parseDecimalRu(payAmount);
                      if (amount == null || amount <= 0) {
                        toast.error(PAYMENT_AMOUNT_ERROR);
                        return;
                      }
                      paySavingRef.current = true;
                      setPaySaving(true);
                      try {
                        await api("/api/zakupki", {
                          method: "POST",
                          body: JSON.stringify({
                            action: "addMoneyPayment",
                            moneyId: money.id,
                            payment: {
                              type: payType,
                              title: payTitle || "Платёж",
                              amount,
                              date: payDate,
                              week: 1,
                              month: Number(payDate.slice(5, 7)) || 1,
                            },
                          }),
                        });
                        await refresh();
                        setPayTitle("");
                        setPayAmount("");
                        toast.success("Платёж сохранён");
                      } catch (e) {
                        toast.error(
                          e instanceof Error ? e.message : "Ошибка сохранения"
                        );
                      } finally {
                        paySavingRef.current = false;
                        setPaySaving(false);
                      }
                    }}
                  >
                    {paySaving ? "Сохраняю…" : "Добавить и сохранить"}
                  </Button>
                </div>
                <p className="mt-3 text-xs text-[var(--tk-muted)]">
                  График платежей. Не путать с фактом выполненных работ.
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
              Ведомость материалов → запросы КП → поставка
            </h3>
            <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--tk-line)] bg-stone-50 p-3" data-testid="company-card-supply">
              <div>
                <h4 className="font-medium">Карточка предприятия для КП</h4>
                <p className="mt-1 text-xs text-[var(--tk-muted)]">{companyCard ? `Загружена: ${companyCard.fileName}` : "Загрузите карточку один раз — она будет приложена к каждому письму с запросом КП."}</p>
              </div>
              <input ref={companyCardInput} type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" className="sr-only" aria-label="Файл карточки предприятия" onChange={(event) => { const file = event.target.files?.[0]; void uploadCompanyCard(file); event.target.value = ""; }} />
              <Button variant="outline" disabled={companyCardBusy} onClick={() => companyCardInput.current?.click()}>{companyCardBusy ? "Загружаю…" : companyCard ? "Заменить карточку" : "Загрузить карточку предприятия"}</Button>
              <p className={`w-full text-xs ${supplyMailReady ? "text-emerald-800" : "text-amber-800"}`} data-testid="supply-mail-readiness">{supplyMailReady ? "Почта готова к отправке" : `Отправка писем недоступна: ${supplyMailDetail}`}</p>
            </section>

            <section className="rounded-lg border border-[var(--tk-line)] p-3" data-testid="supplier-directory">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div><h4 className="font-medium">Наши поставщики</h4><p className="mt-1 text-xs text-[var(--tk-muted)]">Добавьте email и ключевые слова ассортимента. По ним система подберёт адресатов к материалам.</p></div>
                <a className="text-xs text-sky-800 underline" target="_blank" rel="noreferrer" href={`https://duckduckgo.com/?q=${encodeURIComponent(`${procurement.region} поставщик ${matName || "строительные материалы"}`)}`}>Искать в открытых источниках ↗</a>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                <Input placeholder="Название поставщика" value={supplierNameNew} onChange={(event) => setSupplierNameNew(event.target.value)} />
                <Input type="email" placeholder="Email для запросов КП" value={supplierEmailNew} onChange={(event) => setSupplierEmailNew(event.target.value)} />
                <Input placeholder="Материалы через запятую" value={supplierMaterialsNew} onChange={(event) => setSupplierMaterialsNew(event.target.value)} />
                <Input placeholder="Регионы через запятую (необязательно)" value={supplierRegionsNew} onChange={(event) => setSupplierRegionsNew(event.target.value)} />
                <Input placeholder="Сайт (необязательно)" value={supplierWebsiteNew} onChange={(event) => setSupplierWebsiteNew(event.target.value)} />
                <Button disabled={supplierSaving} onClick={() => void saveSupplierDirectoryEntry()}>{supplierSaving ? "Сохраняю…" : "Добавить поставщика"}</Button>
              </div>
              {suppliers.length ? <ul className="mt-3 grid gap-2 md:grid-cols-2">{suppliers.map((supplier) => <li key={supplier.id} className="flex items-start justify-between gap-2 rounded-md bg-stone-50 px-3 py-2 text-xs" data-testid={`supplier-directory-${supplier.id}`}><div><span className="font-medium">{supplier.name}</span> · {supplier.email}<div className="mt-1 text-[var(--tk-muted)]">Ассортимент: {supplier.materialKeywords.join(", ")}{supplier.regions.length ? ` · Регион: ${supplier.regions.join(", ")}` : ""}</div></div><Button size="sm" variant="ghost" onClick={() => setAsk({ kind: "supplier", id: supplier.id, name: supplier.name })}>Удалить</Button></li>)}</ul> : <p className="mt-3 text-xs text-[var(--tk-muted)]">Справочник пока пуст. Добавьте поставщиков и укажите их ассортимент.</p>}
            </section>

            <Button data-testid="generate-material-manifest" disabled={manifestBusy} onClick={() => void generateMaterialManifest()}>{manifestBusy ? "Собираю ведомость…" : "Сформировать ведомость материалов"}</Button>
            <p className="text-xs text-[var(--tk-muted)]">Ведомость собирается по материальным строкам распознанных смет/ВОР и ресурсам ГПР. Позиции без количества система не додумывает. Автоматическая отправка требует настроенного боевого SMTP.</p>
            <section
              className="rounded-lg border border-[var(--tk-line)] bg-stone-50 p-3"
              data-testid="supply-buy-list-gpr"
            >
              <h4 className="text-sm font-medium">Не добавленные материалы ГПР</h4>
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
                    {s.source ? <div className="mt-1 text-xs text-[var(--tk-muted)]">Источник: {s.source === "gpr" ? "ГПР" : s.source === "estimate" ? `смета/ВОР${s.sourceFiles?.length ? ` · ${s.sourceFiles.join(", ")}` : ""}` : "вручную"}{s.quantityNeedsReview ? " · срок поставки требует подтверждения" : ""}</div> : null}
                    <DirectoryNeedHints material={s.materialName} suppliers={suppliers} />
                    {s.workName || s.supplierName || s.supplierEmail ? (
                      <div className="mt-1 text-xs text-[var(--tk-muted)]">
                        {s.workName ? `Работа: ${s.workName}. ` : ""}
                        {s.supplierName ? `Поставщик: ${s.supplierName}. ` : ""}
                        {s.supplierEmail ?? ""}
                      </div>
                    ) : null}
                    <div className="mt-2 rounded-md bg-stone-50 px-3 py-2" data-testid={`supply-matches-${s.id}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs font-medium">Подходящие поставщики</div>
                        <Button size="sm" variant="outline" disabled={supplierSearchBusyId === s.id} onClick={() => void searchPublicSuppliers(s)}>{supplierSearchBusyId === s.id ? "Идёт поиск…" : "Собрать"}</Button>
                      </div>
                      {(s.supplierIds ?? []).length ? <div className="mt-1 flex flex-wrap gap-2">{(s.supplierIds ?? []).map((supplierId) => {
                        const supplier = suppliers.find((item) => item.id === supplierId);
                        if (!supplier) return null;
                        const alreadySent = (s.sentToSupplierIds ?? []).includes(supplierId);
                        return <div key={supplierId} className="flex flex-wrap items-center gap-2 rounded border bg-white px-2 py-1 text-xs"><span>{supplier.name} · {supplier.email}</span>{alreadySent ? <span className="text-emerald-800">Запрос отправлен</span> : <Button size="sm" variant="outline" disabled={!supplyMailReady && !supplier.email} title={supplyMailReady ? undefined : "Почта не подключена: будет сохранён файл запроса"} onClick={() => setAsk({ kind: "rfq", supply: s, supplier })}>Отправить запрос КП</Button>}</div>;
                      })}</div> : <p className="mt-1 text-xs text-[var(--tk-muted)]">В справочнике нет поставщика с подходящим ассортиментом.</p>}
                      {supplierSearchErrors[s.id] ? <p className="mt-2 text-xs text-amber-800" role="alert">{supplierSearchErrors[s.id]}</p> : null}
                      {(supplierSearchResults[s.id]?.length ?? 0) > 0 ? <ul className="mt-2 space-y-2">{supplierSearchResults[s.id].map((candidate) => <li key={candidate.sourceUrl} className="rounded border bg-white p-2 text-xs" data-testid={`supplier-search-result-${s.id}`}>
                        <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{candidate.name}</span>{candidate.email ? <Button size="sm" variant="outline" onClick={() => void addDiscoveredSupplier(s, candidate)}>Добавить в поставщики</Button> : <a className="text-sky-800 underline" href={candidate.sourceUrl} target="_blank" rel="noreferrer">Проверить контакты ↗</a>}</div>
                        <p className="mt-1">Материалы: {candidate.materials.join(", ")}{candidate.email ? ` · ${candidate.email}` : " · email не найден в источнике"}</p>
                        {candidate.regionEvidence ? <p className="mt-1 text-[var(--tk-muted)]">Регион: {candidate.regionEvidence}</p> : null}
                        <p className="mt-1 text-[var(--tk-muted)]">{candidate.evidence}</p>
                        <a className="mt-1 inline-block text-sky-800 underline" href={candidate.sourceUrl} target="_blank" rel="noreferrer">Источник ↗</a>
                      </li>)}</ul> : null}
                      {supplierSearchResults[s.id] && supplierSearchResults[s.id].length === 0 ? <p className="mt-2 text-xs text-[var(--tk-muted)]">Подтверждённых поставщиков не найдено. Попробуйте уточнить название материала.</p> : null}
                      <p className="mt-2 text-[10px] text-[var(--tk-muted)]">Результаты ИИ-поиска требуют проверки на сайте поставщика. Письмо отправляется только поставщику из вашего справочника и только после нажатия кнопки отправки.</p>
                    </div>
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
                        const label = await parseRiskContract(risk.id);
                        toast.success(label);
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
              <div className="space-y-3">
                <p className="text-[var(--tk-muted)]">
                  Реестр для этой закупки ещё не создан. Разбор создаст его и пройдёт по чек-листу.
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => {
                    try {
                      const boot = await ensureChain(procurement.id);
                      const created = boot.data.risks.find((item) => item.procurementId === procurement.id);
                      if (!created) throw new Error("Реестр рисков не создан");
                      const label = await parseRiskContract(created.id);
                      toast.success(label);
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Ошибка разбора");
                    }
                  }}
                >
                  Разобрать договор
                </Button>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
      <Dialog open={ask != null} onOpenChange={(open) => { if (!open) setAsk(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {ask?.kind === "payment" ? "Удалить платёж?" : ask?.kind === "supplier" ? "Удалить поставщика?" : "Отправить запрос КП?"}
            </DialogTitle>
            <DialogDescription>
              {ask?.kind === "payment"
                ? `Платёж «${ask.title}» будет удалён.`
                : ask?.kind === "supplier"
                  ? `Поставщик «${ask.name}» будет удалён из справочника.`
                  : ask?.kind === "rfq"
                    ? `Отправить запрос КП на ${ask.supply.materialName} поставщику «${ask.supplier.name}» (${ask.supplier.email})? К письму будет приложена карточка предприятия.`
                    : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAsk(null)}>Отмена</Button>
            <Button onClick={() => {
              const action = ask;
              setAsk(null);
              if (!action) return;
              if (action.kind === "payment" && money) {
                void api("/api/zakupki", {
                  method: "POST",
                  body: JSON.stringify({
                    action: "saveMoney",
                    moneyId: money.id,
                    patch: { payments: money.payments.filter((item) => item.id !== action.id) },
                  }),
                }).then(() => refresh()).then(() => toast.success("Платёж удалён")).catch((error: unknown) => {
                  toast.error(error instanceof Error ? error.message : "Не удалось удалить платёж");
                });
                return;
              }
              if (action.kind === "supplier") {
                void api("/api/supply", { method: "POST", body: JSON.stringify({ action: "deleteSupplier", supplierId: action.id }) })
                  .then(() => refresh())
                  .then(() => toast.success("Поставщик удалён"))
                  .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Не удалось удалить поставщика"));
                return;
              }
              if (action.kind === "rfq") void sendSupplierRfq(action.supply, action.supplier);
            }}>{ask?.kind === "rfq" ? "Отправить" : "Удалить"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
