import type { GprStage, GprStageResource } from "@/lib/types";

/**
 * Default multi-kind resources for a stage.
 * Names include the stage so stubs are not an identical anonymous kit on every bar.
 * `rate` null = цена не подтверждена (не подставлять 0 в итоговую подтверждённую сумму).
 */
export function defaultStageResources(
  stageId: string,
  crew: number,
  stageName = "этап"
): GprStageResource[] {
  const label = stageName.trim() || "этап";
  return [
    {
      id: `res-${stageId}-labor`,
      kind: "labor",
      name: `Бригада · ${label}`,
      quantity: crew,
      unit: "чел",
      rate: null,
    },
    {
      id: `res-${stageId}-mat`,
      kind: "material",
      name: `Материалы · ${label}`,
      quantity: 1,
      unit: "компл",
      rate: null,
    },
    {
      id: `res-${stageId}-eq`,
      kind: "equipment",
      name: `Техника · ${label}`,
      quantity: 1,
      unit: "маш",
      rate: null,
    },
    {
      id: `res-${stageId}-bus`,
      kind: "bus",
      name: `Автобус · ${label}`,
      quantity: Math.max(1, Math.ceil(crew / 20)),
      unit: "ед",
      rate: null,
    },
  ];
}

const LEGACY_STUB_NAMES = new Set([
  "Бригада основных работ",
  "Основные материалы этапа",
  "Вспомогательная техника",
  "Автобус доставки персонала",
]);

function isLegacyIdenticalStub(res: GprStageResource[]): boolean {
  if (res.length !== 4) return false;
  return res.every((r) => LEGACY_STUB_NAMES.has(r.name));
}

/** Ensure stage has multi-kind resources without wiping a complete custom set. */
export function ensureStageResources(stage: GprStage): GprStage {
  const res = stage.resources ?? [];
  const kinds = new Set(res.map((r) => r.kind));
  const incomplete =
    res.length === 0 ||
    (res.length === 1 && res[0]?.kind === "labor") ||
    !kinds.has("material") ||
    !kinds.has("equipment") ||
    !kinds.has("bus");
  if (incomplete || isLegacyIdenticalStub(res)) {
    const fresh = defaultStageResources(
      stage.id,
      stage.crewSize ?? 4,
      stage.name
    );
    // Preserve user qty when refreshing legacy identical stubs
    if (isLegacyIdenticalStub(res)) {
      for (const f of fresh) {
        const prev = res.find((r) => r.kind === f.kind);
        if (prev) f.quantity = prev.quantity;
      }
    }
    return { ...stage, resources: fresh };
  }
  return stage;
}

export function syncLaborBusToCrew(stage: GprStage): GprStage {
  const crew = stage.crewSize ?? 4;
  const resources = (stage.resources ?? []).map((r) => {
    if (r.kind === "labor" && /бригада/i.test(r.name)) {
      return { ...r, quantity: crew };
    }
    if (r.kind === "bus" && /автобус/i.test(r.name)) {
      return { ...r, quantity: Math.max(1, Math.ceil(crew / 20)) };
    }
    return r;
  });
  return { ...stage, resources };
}

/** Confirmed resource money = qty×rate only when rate is a finite number. */
export function confirmedResourceAmount(r: GprStageResource): number | null {
  if (r.rate == null || !Number.isFinite(r.rate)) return null;
  return Math.round(r.quantity * r.rate * 100) / 100;
}
