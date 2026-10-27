"use client";

import { useMemo, useState } from "react";
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
import type { RiskRemark } from "@/lib/types";
import { useStore } from "@/lib/store";

const statusLabel: Record<RiskRemark["status"], string> = {
  otkryto: "Открыто",
  v_rabote: "В работе",
  zakryto: "Закрыто",
  prinyato: "Принято",
};

export default function RiskiPage() {
  const { data, user, updateRisk } = useStore();
  const [riskId, setRiskId] = useState("");

  const risks = useMemo(
    () => (user ? data.risks.filter((r) => r.orgId === user.orgId) : []),
    [data.risks, user]
  );
  const activeId = riskId || risks[0]?.id || "";
  const risk = risks.find((r) => r.id === activeId);

  if (!user) return null;

  return (
    <div>
      <PageHeader
        title="Риски"
        description="Разбор договора, реестр замечаний с привязкой к тексту, статусы и решения."
        actions={
          risk ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  updateRisk(risk.id, { contractParsed: true });
                  toast.success("Договор разобран (мок-помощник)");
                }}
              >
                Разобрать договор
              </Button>
              <Button
                onClick={() => {
                  downloadUrl(`/api/export?kind=risks-xlsx&id=${risk.id}`);
                  toast.success("Скачивание XLSX…");
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
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Select value={activeId} onValueChange={(v) => setRiskId(v ?? "")}>
              <SelectTrigger className="w-[300px]">
                <SelectValue />
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
                    <div className="flex gap-2">
                      <Badge variant="outline">{remark.severity}</Badge>
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
                        <SelectTrigger className="w-[150px]">
                          <SelectValue />
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
