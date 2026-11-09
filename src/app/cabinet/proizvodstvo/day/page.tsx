"use client";

import Link from "next/link";
import { useEffect, useRef, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ErrorState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { DateInputRu } from "@/components/date-input-ru";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import {
  planResourceLinesForDay,
  stagesForWork,
} from "@/lib/day-resource-plan";
import { formatDate, formatNumber } from "@/lib/format";
import { allocatePlanForSlice } from "@/lib/plan-from-gpr";
import {
  entryDisplayFact,
  sumDailyQty,
} from "@/lib/plan-fact-agg";
import { isT25uTestId, isT25uTestTitle } from "@/lib/t25u-test-fixture";
import type { DailyFact, DailyResourceLine } from "@/lib/types";
import { useStore } from "@/lib/store";

function createDailyFactId() {
  return `df-${crypto.randomUUID()}`;
}

function ResourceRows({
  lines,
  all,
  testPrefix,
  onChange,
}: {
  lines: DailyResourceLine[];
  all: DailyResourceLine[];
  testPrefix: string;
  onChange: (next: DailyResourceLine[]) => void;
}) {
  return (
    <div className="space-y-2 text-sm" data-testid={`${testPrefix}-table`}>
      <div
        className="grid grid-cols-[1fr_4.5rem_5rem_5rem] gap-2 border-b border-[var(--tk-line)] pb-1 text-xs font-medium text-[var(--tk-muted)]"
        data-testid={`${testPrefix}-headers`}
      >
        <div>Ресурс</div>
        <div className="text-right">План</div>
        <div className="text-right">Факт</div>
        <div className="text-right">Отклонение</div>
      </div>
      {lines.length === 0 ? (
        <p
          className="text-[var(--tk-muted)]"
          data-testid={`${testPrefix}-empty`}
        >
          нет данных по плану для выбранной работы/даты
        </p>
      ) : (
        lines.map((l, i) => (
          <div
            key={`${testPrefix}-${l.kind}-${l.name}-${i}`}
            className="grid grid-cols-[1fr_4.5rem_5rem_5rem] items-center gap-2"
          >
            <span>
              {l.name}{" "}
              <span className="text-xs text-[var(--tk-muted)]">{l.unit}</span>
            </span>
            <span className="text-right text-[var(--tk-muted)]">
              {formatNumber(l.planQty)}
            </span>
            <Input
              className="h-8"
              type="number"
              min={0}
              step="any"
              placeholder="—"
              value={l.factQty == null ? "" : String(l.factQty)}
              data-testid={`${testPrefix}-fact-${i}`}
              onChange={(e) => {
                const raw = e.target.value.trim();
                const factQty = raw === "" ? null : Number(raw) || 0;
                const target = lines[i];
                onChange(
                  all.map((x) => (x === target ? { ...x, factQty } : x))
                );
              }}
            />
            <span
              className={`text-right text-xs tabular-nums ${
                l.factQty != null && l.factQty < l.planQty
                  ? "text-rose-700"
                  : "text-[var(--tk-muted)]"
              }`}
            >
              {l.factQty == null
                ? "—"
                : formatNumber(l.factQty - l.planQty)}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

function DayDetailsInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const { data, user, refresh } = useStore();
  const photoRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const pendingFactIdRef = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);

  const planFactId = sp.get("planFactId") ?? "";
  const [date, setDate] = useState(
    sp.get("date") ?? new Date().toISOString().slice(0, 10)
  );
  const workParam = sp.get("work") ?? "";

  const plan = data.planFacts.find(
    (p) => p.id === planFactId && (!user || p.orgId === user.orgId)
  );
  const procurement = plan
    ? data.procurements.find((p) => p.id === plan.procurementId)
    : undefined;
  const schedule = data.schedules.find(
    (s) => s.procurementId === plan?.procurementId
  );

  const workOptions = plan?.entries.map((e) => e.workName) ?? [];
  const [workName, setWorkName] = useState(workParam || workOptions[0] || "");
  const selectedWork = workName || workOptions[0] || "";
  const entry = plan?.entries.find((e) => e.workName === selectedWork);

  const dayFacts = (plan?.dailyFacts ?? []).filter(
    (d) => d.date === date && d.workName === selectedWork
  );
  const dayQty = sumDailyQty(dayFacts);
  const contractFact = entry
    ? entryDisplayFact(entry, plan?.dailyFacts ?? [])
    : 0;

  const linkedStages = stagesForWork(schedule?.stages ?? [], selectedWork, date);
  const linkedAnyDate = stagesForWork(schedule?.stages ?? [], selectedWork);

  const dayPlan =
    entry && linkedStages.length
      ? allocatePlanForSlice(entry.plan, linkedStages, "day", date).plan
      : 0;

  const baselineLines = planResourceLinesForDay(
    schedule?.stages ?? [],
    date,
    selectedWork
  );

  const existingLines = dayFacts.reduce<DailyFact | undefined>(
    (latest, item) => (!latest || item.at > latest.at ? item : latest),
    undefined
  )?.resourceLines;
  const [lines, setLines] = useState<DailyResourceLine[] | null>(null);
  const displayLines = lines ?? existingLines ?? baselineLines;

  const [qty, setQty] = useState(String(dayQty || ""));
  const [caption, setCaption] = useState("");

  useEffect(() => {
    // Reset the local daily draft when its work/date context changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLines(null);
    setQty(dayQty ? String(dayQty) : "");
  }, [date, selectedWork, dayQty]);

  if (!user) return null;
  if (!plan) {
    return (
      <ErrorState
        title="План/факт не найден"
        description="Откройте день из производства или Ганта."
      />
    );
  }

  const people = displayLines.filter((l) => l.kind === "labor");
  const materials = displayLines.filter((l) => l.kind === "material");
  const transport = displayLines.filter(
    (l) => l.kind === "bus" || l.kind === "equipment"
  );
  const linkMissing = linkedAnyDate.length === 0;
  const dateMiss = !linkMissing && linkedStages.length === 0;

  async function save(withPhoto: boolean) {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const factId = pendingFactIdRef.current ?? createDailyFactId();
    pendingFactIdRef.current = factId;
    try {
      const resourceLines = displayLines.map((l) => ({
        ...l,
        factQty: l.factQty,
      }));
      if (withPhoto && photoRef.current?.files?.[0]) {
        const form = new FormData();
        form.append("factId", factId);
        form.append("planFactId", plan!.id);
        form.append("date", date);
        form.append("workName", selectedWork);
        form.append("unit", entry?.unit ?? "%");
        form.append("quantity", qty || "0");
        form.append("resourceLines", JSON.stringify(resourceLines));
        if (caption.trim()) form.append("caption", caption.trim());
        form.append("photo", photoRef.current.files[0]);
        await api("/api/proizvodstvo", { method: "POST", body: form });
      } else {
        await api("/api/proizvodstvo", {
          method: "POST",
          body: JSON.stringify({
            action: "dailyFact",
            planFactId: plan!.id,
            fact: {
              factId,
              date,
              workName: selectedWork,
              unit: entry?.unit ?? "%",
              quantity: Number(qty) || 0,
              resourceLines,
              comment: caption.trim() || undefined,
            },
          }),
        });
      }
      await refresh();
      pendingFactIdRef.current = null;
      setLines(null);
      if (photoRef.current) photoRef.current.value = "";
      setCaption("");
      toast.success("Сохранено");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Ошибка сохранения");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const photos = dayFacts.flatMap((d) => d.photos ?? []);
  // The input value is exactly what save() sends. An explicitly cleared or
  // zero quantity must not silently fall back to the previous total.
  const factVal = qty.trim() === "" ? 0 : Number(qty) || 0;
  const delta = factVal - dayPlan;
  const isTest =
    isT25uTestId(plan.id) ||
    isT25uTestTitle(plan.title) ||
    isT25uTestTitle(procurement?.title);

  return (
    <div data-testid="day-details" className="relative isolate">
      <PageHeader
        title="Детали дня"
        description={`${procurement?.title ?? plan.title} · ${selectedWork || "работа"} · ${formatDate(date)}`}
        actions={
          <Button
            variant="outline"
            data-testid="day-back"
            onClick={() => router.push("/cabinet/proizvodstvo")}
          >
            Назад
          </Button>
        }
      />
      {isTest ? (
        <div
          className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950"
          data-testid="t25u-test-banner"
        >
          <span className="font-semibold">TEST</span> — изолированный контур
          приёмки t25u (не данные школы №12).
        </div>
      ) : null}
      <nav
        className="mb-4 text-sm text-[var(--tk-muted)]"
        data-testid="day-breadcrumbs"
      >
        <Link href="/cabinet/proizvodstvo" className="underline">
          Производство
        </Link>
        {" / "}
        <span>{procurement?.title ?? plan.title}</span>
        {" / "}
        <span>{selectedWork || "работа"}</span>
        {" / "}
        <span>{formatDate(date)}</span>
      </nav>

      <div className="mb-4 flex flex-wrap gap-3">
        <div>
          <p className="mb-1 text-xs text-[var(--tk-muted)]">Дата</p>
          <DateInputRu
            data-testid="day-date"
            value={date}
            onChange={(iso) => setDate(iso)}
          />
        </div>
        <div>
          <p className="mb-1 text-xs text-[var(--tk-muted)]">Вид работ</p>
          <select
            className="flex h-9 min-w-[220px] rounded-lg border border-input bg-transparent px-2.5 text-sm"
            data-testid="day-work"
            value={selectedWork}
            onChange={(e) => setWorkName(e.target.value)}
          >
            {workOptions.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </div>
        {linkMissing ? (
          <p
            className="self-end text-sm text-amber-800"
            data-testid="day-link-missing"
          >
            Вид работ не связан с этапом ГПР — план ресурсов и срез дня: нет
            данных
          </p>
        ) : null}
        {dateMiss ? (
          <p
            className="self-end text-sm text-amber-800"
            data-testid="day-date-miss"
          >
            Дата вне периода связанного этапа ГПР
            {linkedAnyDate[0]
              ? ` (${formatDate(linkedAnyDate[0].start)}–${formatDate(linkedAnyDate[0].end)})`
              : ""}
          </p>
        ) : null}
      </div>

      <div
        className="mb-6 grid gap-3 sm:grid-cols-2"
        data-testid="day-plan-fact-row"
      >
        <div
          className="rounded-2xl border border-[var(--tk-line)] bg-white/90 p-5"
          data-testid="day-plan-card"
        >
          <p className="text-xs text-[var(--tk-muted)]">План (срез дня из ГПР)</p>
          <p className="mt-1 font-[family-name:var(--font-display)] text-3xl">
            {linkedStages.length === 0 ? (
              <span className="text-lg text-amber-800">нет данных</span>
            ) : (
              <>
                {formatNumber(dayPlan)}{" "}
                <span className="text-base font-normal">
                  {entry?.unit ?? ""}
                </span>
              </>
            )}
          </p>
        </div>
        <div
          className="rounded-2xl border border-teal-800 bg-teal-800 p-5 text-white"
          data-testid="day-fact-card"
        >
          <p className="text-xs text-teal-100">Факт за день</p>
          <p className="mt-1 font-[family-name:var(--font-display)] text-3xl">
            {formatNumber(factVal)}{" "}
            <span className="text-base font-normal">{entry?.unit ?? ""}</span>
          </p>
          <p className="mt-2 text-sm">
            Δ к плану дня:{" "}
            <span className={delta < 0 ? "text-rose-200" : "text-teal-100"}>
              {linkedStages.length === 0 ? "—" : formatNumber(delta)}
            </span>
          </p>
          <p className="mt-1 text-xs text-teal-100">
            Накоплено по виду работ: {formatNumber(contractFact)} /{" "}
            {formatNumber(entry?.plan ?? 0)}
          </p>
        </div>
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <div
          className="rounded-2xl border border-[var(--tk-line)] bg-white/90 p-4"
          data-testid="day-people-list"
        >
          <h3 className="mb-3 font-medium">Люди</h3>
          <ResourceRows
            lines={people}
            all={displayLines}
            testPrefix="day-people"
            onChange={setLines}
          />
        </div>
        <div
          className="rounded-2xl border border-[var(--tk-line)] bg-white/90 p-4"
          data-testid="day-materials-list"
        >
          <h3 className="mb-3 font-medium">Материалы</h3>
          <ResourceRows
            lines={materials}
            all={displayLines}
            testPrefix="day-mat"
            onChange={setLines}
          />
        </div>
      </div>

      <div
        className="mb-6 rounded-2xl border border-[var(--tk-line)] bg-white/90 p-4"
        data-testid="day-transport-list"
      >
        <h3 className="mb-3 font-medium">Техника / транспорт</h3>
        <ResourceRows
          lines={transport}
          all={displayLines}
          testPrefix="day-transport"
          onChange={setLines}
        />
      </div>

      <div className="mb-6 rounded-2xl border border-[var(--tk-line)] bg-white/90 p-4">
        <h3 className="mb-2 font-medium">Факт объёма и фотоотчёт</h3>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div>
            <p className="mb-1 text-xs text-[var(--tk-muted)]">
              Факт, {entry?.unit}
            </p>
            <Input
              className="w-32"
              type="number"
              step="any"
              data-testid="day-qty"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </div>
          <div>
            <p className="mb-1 text-xs text-[var(--tk-muted)]">Подпись к фото</p>
            <Input
              className="w-56"
              data-testid="day-caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="подпись к снимку"
            />
          </div>
          <Input
            type="file"
            accept="image/*"
            ref={photoRef}
            data-testid="day-upload-input"
          />
          <Button disabled={saving} data-testid="day-save" onClick={() => void save(false)}>
            {saving ? "Сохранение…" : "Сохранить"}
          </Button>
          <Button
            variant="outline"
            disabled={saving}
            data-testid="day-save-photo"
            onClick={() => void save(true)}
          >
            Факт + фото
          </Button>
          <Button
            variant="outline"
            data-testid="day-reload"
            onClick={() =>
              void refresh().then(() => toast.success("Обновлено"))
            }
          >
            Обновить
          </Button>
        </div>
        <div
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          data-testid="day-photo-report"
        >
          {photos.length === 0 ? (
            <p className="text-sm text-[var(--tk-muted)]">
              Нет фото за этот день / вид работ
            </p>
          ) : (
            photos.map((ph) => (
              <a
                key={ph.id}
                href={`/api/proizvodstvo/photo?id=${ph.id}&disposition=inline`}
                target="_blank"
                rel="noreferrer"
                className="overflow-hidden rounded-xl border border-[var(--tk-line)] hover:bg-stone-50"
                data-testid={`day-photo-${ph.id}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/proizvodstvo/photo?id=${ph.id}&disposition=inline`}
                  alt={ph.caption || ph.fileName}
                  className="h-28 w-full object-cover bg-stone-100"
                />
                <div className="p-2 text-sm">
                  <p className="font-medium tabular-nums">
                    {ph.at
                      ? new Date(ph.at).toLocaleString("ru-RU", {
                          day: "2-digit",
                          month: "2-digit",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "—"}
                  </p>
                  {ph.caption ? (
                    <p className="mt-0.5 text-xs">{ph.caption}</p>
                  ) : (
                    <p className="mt-0.5 text-xs text-[var(--tk-muted)]">
                      {ph.fileName}
                    </p>
                  )}
                </div>
              </a>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default function DayDetailsPage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm">Загрузка…</p>}>
      <DayDetailsInner />
    </Suspense>
  );
}
