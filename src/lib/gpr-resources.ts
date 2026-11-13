import type { GprStage, GprStageResource } from "@/lib/types";

/**
 * Default multi-kind resources for a stage.
 * Names include the stage so stubs are not an identical anonymous kit on every bar.
 * `rate` null = цена не подтверждена (не подставлять 0 в итоговую подтверждённую сумму).
 */
export function defaultStageResources(
  stageId: string,
  _crew: number,
  stageName = "этап"
): GprStageResource[] {
  const label = stageName.trim() || "этап";
  return [
    {
      id: `res-${stageId}-labor`,
      kind: "labor",
      name: `Бригада · ${label}`,
      quantity: 0,
      unit: "чел",
      rate: null,
      quantityBasis: "uncertain",
    },
    {
      id: `res-${stageId}-mat`,
      kind: "material",
      name: `Указать материалы · ${label}`,
      quantity: 0,
      unit: "компл",
      rate: null,
      quantityBasis: "uncertain",
    },
    {
      id: `res-${stageId}-eq`,
      kind: "equipment",
      name: `Указать технику · ${label}`,
      quantity: 0,
      unit: "маш",
      rate: null,
      quantityBasis: "uncertain",
    },
    {
      id: `res-${stageId}-bus`,
      kind: "bus",
      name: `Указать транспорт · ${label}`,
      quantity: 0,
      unit: "ед",
      rate: null,
      quantityBasis: "uncertain",
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
  const missing = defaultStageResources(stage.id, stage.crewSize ?? 0, stage.name)
    .filter((resource) => !kinds.has(resource.kind));
  if (res.length === 0 || missing.length > 0 || isLegacyIdenticalStub(res)) {
    // Keep every resource the user already entered. Add only missing, explicitly
    // unconfirmed placeholder rows with zero quantity and no tariff.
    return { ...stage, resources: [...res, ...missing] };
  }
  return stage;
}

export function syncLaborBusToCrew(stage: GprStage): GprStage {
  const crew = stage.crewSize ?? 4;
  const resources = (stage.resources ?? []).map((r) => {
    if (r.kind === "labor" && /бригада/i.test(r.name)) {
      return { ...r, quantity: crew };
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
