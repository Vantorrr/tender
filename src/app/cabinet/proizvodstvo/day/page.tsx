"use client";

import Link from "next/link";
import { useMemo, useRef, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ErrorState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { DateInputRu } from "@/components/date-input-ru";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatDate, formatNumber } from "@/lib/format";
import { allocatePlanForSlice } from "@/lib/plan-from-gpr";
import {
  entryDisplayFact,
  sumDailyQty,
} from "@/lib/plan-fact-agg";
import type { DailyResourceLine, GprStage } from "@/lib/types";
import { useStore } from "@/lib/store";

function stageMatchesWork(s: GprStage, workName: string) {
  if (!workName) return false;
  return (
    s.workName === workName ||
    s.name === workName ||
    s.name.includes(workName) ||
    workName.includes(s.name)
  );
}

function planResourceLinesForDay(
  stages: GprStage[],
  date: string,
  workName: string
): DailyResourceLine[] {
  const coveringWork = stages.filter(
    (s) => s.start <= date && s.end >= date && stageMatchesWork(s, workName)
  );
  const coveringDate = stages.filter(
    (s) => s.start <= date && s.end >= date
  );
  const byWork = stages.filter((s) => stageMatchesWork(s, workName));
  // Prefer calendar overlap; if selected day is outside ГПР (common in demo),
  // still show sourced plan lines for the chosen work / whole schedule.
  const stagesUse = coveringWork.length
    ? coveringWork
    : coveringDate.length
      ? coveringDate
      : byWork.length
        ? byWork
        : stages;
  const lines: DailyResourceLine[] = [];
  const seen = new Set<string>();
  for (const st of stagesUse) {
    for (const r of st.resources ?? []) {
      if (r.kind !== "labor" && r.kind !== "material" && r.kind !== "bus") {
        continue;
      }
      const key = `${r.kind}|${r.name}|${r.unit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push({
        kind: r.kind,
        name: r.name,
        unit: r.unit || (r.kind === "labor" ? "чел" : "ед."),
        planQty: r.quantity,
        factQty: null,
      });
    }
  }
  return lines;
}

function DayDetailsInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const { data, user, refresh } = useStore();
  const photoRef = useRef<HTMLInputElement>(null);

  const planFactId = sp.get("planFactId") ?? "";
  const [date, setDate] = useState(sp.get("date") ?? new Date().toISOString().slice(0, 10));
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

  const dayPlan = schedule
    ? allocatePlanForSlice(
        entry?.plan ?? 0,
        schedule.stages,
        "day",
        date
      ).plan
    : 0;

  const baselineLines = useMemo(
    () =>
      planResourceLinesForDay(
        schedule?.stages ?? [],
        date,
        selectedWork
      ),
    [schedule?.stages, date, selectedWork]
  );

  const existingLines = dayFacts[0]?.resourceLines;
  const [lines, setLines] = useState<DailyResourceLine[] | null>(null);
  const displayLines = lines ?? existingLines ?? baselineLines;

  const [qty, setQty] = useState(String(dayQty || ""));
  const [caption, setCaption] = useState("");

  if (!user) return null;
  if (!plan) {
    return (
      <ErrorState
        title="План/факт не найден"
        description="Откройте день из производства или Ганта."
      />
    );
  }

  async function save(withPhoto: boolean) {
    try {
      const resourceLines = displayLines.map((l) => ({
        ...l,
        factQty: l.factQty,
      }));
      if (withPhoto && photoRef.current?.files?.[0]) {
        const form = new FormData();
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
      setLines(null);
      if (photoRef.current) photoRef.current.value = "";
      setCaption("");
      toast.success("Сохранено");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Ошибка сохранения");
    }
  }

  const photos = dayFacts.flatMap((d) => d.photos ?? []);
  const delta = (Number(qty) || dayQty) - dayPlan;

  return (
    <div data-testid="day-details">
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
            onChange={(iso) => {
              setDate(iso);
              setLines(null);
            }}
          />
        </div>
        <div>
          <p className="mb-1 text-xs text-[var(--tk-muted)]">Вид работ</p>
          <select
            className="flex h-9 min-w-[220px] rounded-lg border border-input bg-transparent px-2.5 text-sm"
            data-testid="day-work"
            value={selectedWork}
            onChange={(e) => {
              setWorkName(e.target.value);
              setLines(null);
            }}
          >
            {workOptions.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <div
          className="rounded-2xl border border-[var(--tk-line)] bg-white/90 p-5"
          data-testid="day-plan-card"
        >
          <p className="text-xs text-[var(--tk-muted)]">План (срез дня из ГПР)</p>
          <p className="mt-1 font-[family-name:var(--font-display)] text-3xl">
            {formatNumber(dayPlan)}{" "}
            <span className="text-base font-normal">{entry?.unit ?? ""}</span>
          </p>
        </div>
        <div
          className="rounded-2xl border border-teal-800 bg-teal-800 p-5 text-white"
          data-testid="day-fact-card"
        >
          <p className="text-xs text-teal-100">Факт за день</p>
          <p className="mt-1 font-[family-name:var(--font-display)] text-3xl">
            {formatNumber(Number(qty) || dayQty)}{" "}
            <span className="text-base font-normal">{entry?.unit ?? ""}</span>
          </p>
          <p className="mt-2 text-sm">
            Δ к плану дня:{" "}
            <span className={delta < 0 ? "text-rose-200" : "text-teal-100"}>
              {formatNumber(delta)}
            </span>
          </p>
          <p className="mt-1 text-xs text-teal-100">
            Накоплено по виду работ: {formatNumber(contractFact)} /{" "}
            {formatNumber(entry?.plan ?? 0)}
          </p>
        </div>
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-[var(--tk-line)] bg-white/90 p-4">
          <h3 className="mb-2 font-medium">Люди</h3>
          <ul className="space-y-2 text-sm" data-testid="day-people-list">
            {displayLines.filter((l) => l.kind === "labor" || l.kind === "bus").length ===
            0 ? (
              <li className="text-[var(--tk-muted)]">нет данных по плану ресурсов</li>
            ) : (
              displayLines
                .filter((l) => l.kind === "labor" || l.kind === "bus")
                .map((l, i) => (
                  <li
                    key={`p-${l.name}-${i}`}
                    className="grid grid-cols-[1fr_4rem_5rem_4rem] items-center gap-2"
                  >
                    <span>{l.name}</span>
                    <span className="text-right text-[var(--tk-muted)]">
                      {formatNumber(l.planQty)}
                    </span>
                    <Input
                      className="h-8"
                      type="number"
                      min={0}
                      step="any"
                      placeholder="факт"
                      value={l.factQty == null ? "" : String(l.factQty)}
                      data-testid={`day-people-fact-${i}`}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        const factQty = raw === "" ? null : Number(raw) || 0;
                        const people = displayLines.filter(
                          (x) => x.kind === "labor" || x.kind === "bus"
                        );
                        const target = people[i];
                        setLines(
                          displayLines.map((x) =>
                            x === target ? { ...x, factQty } : x
                          )
                        );
                      }}
                    />
                    <span
                      className={`text-right text-xs ${
                        l.factQty != null && l.factQty < l.planQty
                          ? "text-rose-700"
                          : "text-[var(--tk-muted)]"
                      }`}
                    >
                      {l.factQty == null
                        ? "—"
                        : `Δ ${formatNumber(l.factQty - l.planQty)}`}
                    </span>
                  </li>
                ))
            )}
          </ul>
        </div>
        <div className="rounded-2xl border border-[var(--tk-line)] bg-white/90 p-4">
          <h3 className="mb-2 font-medium">Материалы</h3>
          <ul className="space-y-2 text-sm" data-testid="day-materials-list">
            {displayLines.filter((l) => l.kind === "material").length === 0 ? (
              <li className="text-[var(--tk-muted)]">нет данных по плану материалов</li>
            ) : (
              displayLines
                .filter((l) => l.kind === "material")
                .map((l, i) => (
                  <li
                    key={`m-${l.name}-${i}`}
                    className="grid grid-cols-[1fr_4rem_5rem_4rem] items-center gap-2"
                  >
                    <span>
                      {l.name}{" "}
                      <span className="text-xs text-[var(--tk-muted)]">
                        {l.unit}
                      </span>
                    </span>
                    <span className="text-right text-[var(--tk-muted)]">
                      {formatNumber(l.planQty)}
                    </span>
                    <Input
                      className="h-8"
                      type="number"
                      min={0}
                      step="any"
                      placeholder="факт"
                      value={l.factQty == null ? "" : String(l.factQty)}
                      data-testid={`day-mat-fact-${i}`}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        const factQty = raw === "" ? null : Number(raw) || 0;
                        setLines(
                          displayLines.map((x) =>
                            x.name === l.name && x.kind === "material"
                              ? { ...x, factQty }
                              : x
                          )
                        );
                      }}
                    />
                    <span className="text-right text-xs text-[var(--tk-muted)]">
                      {l.factQty == null
                        ? "—"
                        : `Δ ${formatNumber(l.factQty - l.planQty)}`}
                    </span>
                  </li>
                ))
            )}
          </ul>
        </div>
      </div>

      <div className="mb-6 rounded-2xl border border-[var(--tk-line)] bg-white/90 p-4">
        <h3 className="mb-2 font-medium">Факт объёма и фотоотчёт</h3>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div>
            <p className="mb-1 text-xs text-[var(--tk-muted)]">Факт, {entry?.unit}</p>
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
              placeholder="например: укладка арматуры"
            />
          </div>
          <Input
            type="file"
            accept="image/*"
            ref={photoRef}
            data-testid="day-photo-input"
          />
          <Button data-testid="day-save" onClick={() => void save(false)}>
            Сохранить
          </Button>
          <Button
            variant="outline"
            data-testid="day-save-photo"
            onClick={() => void save(true)}
          >
            Факт + фото
          </Button>
          <Button
            variant="outline"
            data-testid="day-reload"
            onClick={() => void refresh().then(() => toast.success("Обновлено"))}
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
                className="rounded-xl border border-[var(--tk-line)] p-3 text-sm hover:bg-stone-50"
                data-testid={`day-photo-${ph.id}`}
              >
                <p className="font-medium">{ph.fileName}</p>
                <p className="text-xs text-[var(--tk-muted)]">
                  {ph.at ? new Date(ph.at).toLocaleString("ru-RU") : "—"}
                </p>
                {ph.caption ? (
                  <p className="mt-1 text-xs">{ph.caption}</p>
                ) : null}
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
