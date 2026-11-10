"use client";

import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { downloadUrl } from "@/lib/api";
import { REMARK_STATUS_LABELS, SEVERITY_LABELS } from "@/lib/roles";
import type { RiskRemark } from "@/lib/types";
import { useStore } from "@/lib/store";

export default function RiskiPage() {
  const { data, user, updateRisk, parseRiskContract } = useStore();
  const [riskId, setRiskId] = useState("");

  const risks = user
    ? data.risks
        .filter((r) => r.orgId === user.orgId)
        .slice()
        .sort((a, b) => {
          const score = (r: (typeof data.risks)[0]) =>
            (r.remarks.length > 0 ? 2 : 0) + (r.contractParsed ? 1 : 0);
          return score(b) - score(a);
        })
    : [];
  // Prefer a registry that already has remarks (seed / parsed) over empty
  // auto-created chain stubs that were unshifted to the front.
  const preferredId = risks[0]?.id || "";
  const activeId = riskId || preferredId;
  const risk = risks.find((r) => r.id === activeId);

  if (!user) return null;

  return (
    <div>
      <PageHeader
        title="Риски"
        description="Убрано из сайдбара — договор и замечания в карточке закупки. Эвристический помощник, не юрэкспертиза."
        actions={
          risk ? (
            <>
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    await parseRiskContract(risk.id);
                    toast.success(
                      "Разбор выполнен (помощник, не юрэкспертиза)"
                    );
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
                onClick={async () => {
                  try {
                    await downloadUrl(
                      `/api/export?kind=risks-xlsx&id=${risk.id}`
                    );
                    toast.success("XLSX скачан");
                  } catch (e) {
                    toast.error(
                      e instanceof Error ? e.message : "Ошибка экспорта"
                    );
                  }
                }}
              >
                Экспорт
              </Button>
            </>
          ) : null
        }
      />

      {risks.length === 0 ? (
        <EmptyState
          title="Реестров рисков нет"
          description="Загрузите проект контракта и запустите помощник разбора."
        />
      ) : (
        <>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <Select value={activeId} onValueChange={(v) => setRiskId(v ?? "")}>
              <SelectTrigger className="w-full sm:w-[300px]">
                <SelectValue>
                  {(value) =>
                    risks.find((r) => r.id === value)?.title ?? "Реестр"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {risks.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {risk ? (
              <>
                <StatusBadge status={risk.status} />
                <Badge variant="outline">
                  {risk.contractParsed
                    ? "Договор разобран"
                    : "Разбор не выполнен"}
                </Badge>
              </>
            ) : null}
          </div>

          {risk ? (
            <div className="space-y-3">
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                Авторазбор — эвристический помощник, не юридическая экспертиза.
                Проверяйте цитаты вручную перед решением.
              </p>
              {risk.remarks.length === 0 ? (
                <EmptyState
                  title="Нет данных"
                  description="В тексте договора не найдено типовых рисковых формулировок, либо текст ещё не загружен. Ничего не выдумано."
                />
              ) : null}
              {risk.remarks.map((remark) => (
                <div
                  key={remark.id}
                  className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="font-semibold">{remark.text}</h3>
                      <p className="mt-1 rounded-md bg-[var(--tk-steel-50)] px-2 py-1 text-sm text-[var(--tk-ink-soft)]">
                        «{remark.sourceExcerpt}»
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">
                        {SEVERITY_LABELS[remark.severity]}
                      </Badge>
                      <Select
                        value={remark.status}
                        onValueChange={(v) => {
                          if (!v) return;
                          updateRisk(risk.id, {
                            remarks: risk.remarks.map((r) =>
                              r.id === remark.id
                                ? {
                                    ...r,
                                    status: v as RiskRemark["status"],
                                  }
                                : r
                            ),
                          });
                        }}
                      >
                        <SelectTrigger className="w-full sm:w-[150px]">
                          <SelectValue>
                            {(value) =>
                              REMARK_STATUS_LABELS[
                                value as RiskRemark["status"]
                              ] ?? "Статус"
                            }
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="otkryto">Открыто</SelectItem>
                          <SelectItem value="v_rabote">В работе</SelectItem>
                          <SelectItem value="zakryto">Закрыто</SelectItem>
                          <SelectItem value="prinyato">Принято</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="mt-3">
                    <p className="mb-1 text-xs text-[var(--tk-muted)]">
                      Решение
                    </p>
                    <Input
                      value={remark.decision ?? ""}
                      placeholder="Зафиксировать решение…"
                      onChange={(e) => {
                        updateRisk(risk.id, {
                          remarks: risk.remarks.map((r) =>
                            r.id === remark.id
                              ? { ...r, decision: e.target.value }
                              : r
                          ),
                        });
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
