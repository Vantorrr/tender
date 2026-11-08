/**
 * Isolated t25u TEST fixture — separate from school №12 GPR/calc/facts.
 * Marked in titles with «[TEST]»; never mutates existing p-1 / g-1 / c-1 / pf-1.
 *
 * OPT-IN only: install when T25U_TEST_FIXTURE=1, PROCUREMENT_DEMO=1, or NODE_ENV=test.
 * Never auto-inject into every tenant on prod migrate.
 */
import { EXCEL_RESOURCE_SCHEDULE_DEFAULTS } from "@/lib/resource-schedule-model";
import { syncDraftFromStages } from "@/lib/unified-resource-sync";
import type {
  AppData,
  Calculation,
  GprSchedule,
  PlanFact,
  Procurement,
} from "@/lib/types";

export const T25U_TEST = {
  procurementId: "p-t25u-test",
  calculationId: "c-t25u-test",
  originalCalculationId: "c-t25u-original",
  scheduleId: "g-t25u-test",
  planFactId: "pf-t25u-test",
  workName: "Демонтаж перегородок",
  /** Fixed date inside TEST stage window — for acceptance UI path only */
  date: "2026-11-08",
} as const;

/** Gate for installing the demo/test contour — not a silent prod migrate. */
export function isT25uTestFixtureOptIn(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  // Explicit off wins (even under NODE_ENV=test) — proves prod migrate path.
  if (env.T25U_TEST_FIXTURE === "0") return false;
  if (env.T25U_TEST_FIXTURE === "1") return true;
  if (env.PROCUREMENT_DEMO === "1") return true;
  if (env.NODE_ENV === "test") return true;
  return false;
}

export function isT25uTestTitle(title: string | undefined | null): boolean {
  return Boolean(title && /\[TEST\]/i.test(title));
}

export function isT25uTestId(id: string | undefined | null): boolean {
  return Boolean(id && id.includes("t25u-test"));
}

/** Frozen customer estimate positions — NR15/SP8 total ≈ 74 897 ₽ (immutable). */
function originalPositions() {
  return [
    {
      id: "cto-1",
      code: "LAB-T",
      name: "Демонтажник",
      unit: "чел",
      quantity: 10,
      rate: 1054,
    },
    {
      id: "cto-2",
      code: "LAB-W",
      name: "Электрогазосварщик 3 разряда",
      unit: "чел",
      quantity: 2,
      rate: 1376,
    },
    {
      id: "cto-3",
      code: "ATS-T",
      name: "JCB 5 CX",
      unit: "маш",
      quantity: 2,
      rate: 5800,
    },
    {
      id: "cto-4",
      code: "MAT-T",
      name: "Контейнеры под бой",
      unit: "шт",
      quantity: 8,
      rate: 4500,
    },
  ];
}

function testOriginalCalculation(orgId: string): Calculation {
  return {
    id: T25U_TEST.originalCalculationId,
    orgId,
    procurementId: T25U_TEST.procurementId,
    title: "[TEST] Смета заказчика (оригинал) — t25u",
    kind: "customer_original",
    status: "gotovo",
    positions: originalPositions(),
    assumptions: [
      "[TEST] Immutable оригинал; правки только в resource_draft",
      "Итого позиций×коэф.+НР15/СП8 ≈ 74897 ₽ — не путать с ресурсным Z (НР43%/наценка40%)",
    ],
    scenario: "bazovyy",
    scenarioFactor: 1,
    participateDecision: "uchastvovat",
    directoryVersionId: "dir-rascenki-client-1",
    version: 1,
    authorId: "u-smet",
    updatedAt: "2026-11-08T12:00:00Z",
    immutable: true,
    pairedCalculationId: T25U_TEST.calculationId,
    changeLog: [],
    dataFlags: ["t25u_test_fixture", "immutable_original"],
  };
}

function testCalculation(orgId: string): Calculation {
  return {
    id: T25U_TEST.calculationId,
    orgId,
    procurementId: T25U_TEST.procurementId,
    title: "[TEST] Расчёт стоимости — демо-контур t25u",
    kind: "resource_draft",
    status: "v_rabote",
    positions: originalPositions().map((p) => ({
      ...p,
      id: p.id.replace("cto-", "ctp-"),
    })),
    assumptions: [
      "[TEST] Изолированный контур приёмки t25u — не данные школы №12",
      "Единая ресурсная модель: дерево qty/rate → cost-engine V/W/X/Y/Z",
    ],
    scenario: "bazovyy",
    scenarioFactor: 1,
    participateDecision: "na_rassmotrenii",
    directoryVersionId: "dir-rascenki-client-1",
    version: 1,
    authorId: "u-smet",
    updatedAt: "2026-11-08T12:00:00Z",
    immutable: false,
    pairedCalculationId: T25U_TEST.originalCalculationId,
    changeLog: [],
    dataFlags: ["t25u_test_fixture", "unified_resource_tree"],
    resourceScheduleParams: { ...EXCEL_RESOURCE_SCHEDULE_DEFAULTS },
  };
}

function testSchedule(orgId: string): GprSchedule {
  return {
    id: T25U_TEST.scheduleId,
    orgId,
    procurementId: T25U_TEST.procurementId,
    calculationId: T25U_TEST.calculationId,
    title: "[TEST] ГПР — демо-контур t25u",
    status: "v_rabote",
    stages: [
      {
        id: "gst-1",
        name: "Мобилизация [TEST]",
        start: "2026-10-25",
        end: "2026-11-02",
        sequence: 1,
        crewSize: 4,
        planVolume: 40,
        workName: "Мобилизация",
        resources: [
          {
            id: "rst-1-labor",
            kind: "labor",
            name: "Дорожный рабочий",
            quantity: 4,
            unit: "чел",
            rate: 1054,
          },
          {
            id: "rst-1-eq",
            kind: "equipment",
            name: "JCB 5 CX мобилизация",
            quantity: 1,
            unit: "маш",
            rate: 5800,
          },
          {
            id: "rst-1-mat",
            kind: "material",
            name: "Материалы мобилизации",
            quantity: 1,
            unit: "компл",
            rate: null,
          },
          // Bus A — stage 1; distinct from bus B on gst-2 (both summed, not leave-first)
          {
            id: "rst-1-bus",
            kind: "bus",
            name: "Автобус мобилизации",
            quantity: 1,
            unit: "ед",
            rate: 2650,
            quantityBasis: "count_per_shift",
            hoursPerShift: 11,
            shiftsPerDay: 1,
            days: 2,
          },
        ],
      },
      {
        id: "gst-2",
        name: "Демонтаж [TEST]",
        start: "2026-11-01",
        end: "2026-11-20",
        sequence: 2,
        dependsOn: "gst-1",
        crewSize: 12,
        planVolume: 420,
        workName: T25U_TEST.workName,
        resources: [
          {
            id: "rst-2-labor",
            kind: "labor",
            name: "Демонтажник",
            quantity: 10,
            unit: "чел",
            rate: 1054,
          },
          {
            id: "rst-2-labor-2",
            kind: "labor",
            name: "Электрогазосварщик 3 разряда",
            quantity: 2,
            unit: "чел",
            rate: 1376,
          },
          {
            id: "rst-2-mat",
            kind: "material",
            name: "Контейнеры под бой",
            quantity: 8,
            unit: "шт",
            rate: 4500,
          },
          {
            id: "rst-2-eq",
            kind: "equipment",
            name: "JCB 5 CX",
            quantity: 2,
            unit: "маш",
            rate: 5800,
          },
          // Bus B — golden Q: 2×11×1×3×2650 = 174900 (full tariff, no extra fuel/driver)
          {
            id: "rst-2-bus",
            kind: "bus",
            name: "Автобус доставки",
            quantity: 2,
            unit: "ед",
            rate: 2650,
            quantityBasis: "count_per_shift",
            hoursPerShift: 11,
            shiftsPerDay: 1,
            days: 3,
          },
        ],
      },
      {
        id: "gst-3",
        name: "Сдача [TEST]",
        start: "2026-11-18",
        end: "2026-11-30",
        sequence: 3,
        dependsOn: "gst-2",
        crewSize: 2,
        planVolume: 50,
        workName: "Сдача",
        resources: [
          {
            id: "rst-3-mat",
            kind: "material",
            name: "Комплект сдачи",
            quantity: 1,
            unit: "компл",
            rate: null,
          },
          {
            id: "rst-3-eq",
            kind: "equipment",
            name: "Подъёмник",
            quantity: 1,
            unit: "маш",
            rate: null,
          },
        ],
      },
    ],
    version: 1,
    authorId: "u-smet",
    updatedAt: "2026-11-08T12:00:00Z",
  };
}

function testPlanFact(orgId: string, objectId: string): PlanFact {
  return {
    id: T25U_TEST.planFactId,
    orgId,
    objectId,
    procurementId: T25U_TEST.procurementId,
    title: "[TEST] План/факт — демо-контур t25u",
    status: "v_rabote",
    entries: [
      {
        id: "pfe-t25u-1",
        workName: T25U_TEST.workName,
        unit: "м²",
        plan: 420,
        fact: 0,
        contractRemaining: 420,
      },
    ],
    dailyFacts: [],
    updatedAt: "2026-11-08T12:00:00Z",
  };
}

function testProcurement(orgId: string, objectId: string): Procurement {
  return {
    id: T25U_TEST.procurementId,
    orgId,
    objectId,
    number: "TEST-T25U-001",
    title: "[TEST] Демо-контур приёмки t25u",
    customer: "TEST заказчик",
    nmck: 1_000_000,
    region: "TEST",
    source: "TEST fixture",
    deadline: "2026-11-30T18:00:00Z",
    status: "v_rabote",
    reviewStatus: "odobrena",
    syncStatus: "aktualno",
    syncAt: "2026-11-08T12:00:00Z",
    attachments: [],
    documentIds: [],
    lifecycle: "production",
    calculationId: T25U_TEST.calculationId,
    gprId: T25U_TEST.scheduleId,
    planFactId: T25U_TEST.planFactId,
    tags: ["TEST", "t25u"],
    workType: "общестрой",
    createdAt: "2026-11-01T10:00:00Z",
  };
}

/**
 * Insert TEST entities if absent — never patches school p-1/g-1/c-1/pf-1.
 * No-op unless opt-in (test/demo env).
 */
export function ensureT25uTestFixture(data: AppData): AppData {
  if (!isT25uTestFixtureOptIn()) return data;

  const orgId =
    data.organizations.find((o) => o.id === "org-alfa")?.id ??
    data.organizations[0]?.id ??
    "org-alfa";
  const objectId =
    data.objects.find((o) => o.orgId === orgId)?.id ??
    data.objects[0]?.id ??
    "obj-1";

  if (!data.procurements.some((p) => p.id === T25U_TEST.procurementId)) {
    data.procurements.push(testProcurement(orgId, objectId));
  }
  if (
    !data.calculations.some((c) => c.id === T25U_TEST.originalCalculationId)
  ) {
    data.calculations.push(testOriginalCalculation(orgId));
  }
  if (!data.calculations.some((c) => c.id === T25U_TEST.calculationId)) {
    data.calculations.push(testCalculation(orgId));
  }
  if (!data.schedules.some((s) => s.id === T25U_TEST.scheduleId)) {
    data.schedules.push(testSchedule(orgId));
  } else {
    // Additive heal: ensure golden bus B exists on gst-2 (sum with bus A; never leave-first)
    const schedule = data.schedules.find((s) => s.id === T25U_TEST.scheduleId)!;
    const gst2 = schedule.stages.find((s) => s.id === "gst-2");
    if (gst2 && !(gst2.resources ?? []).some((r) => r.id === "rst-2-bus")) {
      gst2.resources = [
        ...(gst2.resources ?? []),
        {
          id: "rst-2-bus",
          kind: "bus",
          name: "Автобус доставки",
          quantity: 2,
          unit: "ед",
          rate: 2650,
          quantityBasis: "count_per_shift",
          hoursPerShift: 11,
          shiftsPerDay: 1,
          days: 3,
        },
      ];
    }
    const gst1 = schedule.stages.find((s) => s.id === "gst-1");
    const bus1 = gst1?.resources?.find((r) => r.id === "rst-1-bus");
    if (bus1) {
      bus1.name = bus1.name.includes("мобилиз")
        ? bus1.name
        : "Автобус мобилизации";
      bus1.quantityBasis = bus1.quantityBasis ?? "count_per_shift";
      bus1.hoursPerShift = bus1.hoursPerShift ?? 11;
      bus1.shiftsPerDay = bus1.shiftsPerDay ?? 1;
      bus1.days = bus1.days ?? 2;
    }
  }
  if (!data.planFacts.some((p) => p.id === T25U_TEST.planFactId)) {
    data.planFacts.push(testPlanFact(orgId, objectId));
  }

  const schedule = data.schedules.find((s) => s.id === T25U_TEST.scheduleId);
  const draft = data.calculations.find((c) => c.id === T25U_TEST.calculationId);
  const original = data.calculations.find(
    (c) => c.id === T25U_TEST.originalCalculationId
  );
  if (draft && schedule) {
    draft.pairedCalculationId =
      draft.pairedCalculationId ?? T25U_TEST.originalCalculationId;
    draft.resourceScheduleParams =
      draft.resourceScheduleParams ?? { ...EXCEL_RESOURCE_SCHEDULE_DEFAULTS };
    draft.dataFlags = [
      ...new Set([
        ...(draft.dataFlags ?? []),
        "t25u_test_fixture",
        "unified_resource_tree",
      ]),
    ];
    const synced = syncDraftFromStages(draft, schedule.stages, {
      replacePositions: true,
    });
    Object.assign(draft, synced.calc);
  }
  if (original) {
    original.immutable = true;
    original.kind = "customer_original";
    original.pairedCalculationId =
      original.pairedCalculationId ?? T25U_TEST.calculationId;
  }
  return data;
}
