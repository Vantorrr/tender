/**
 * Isolated t25u TEST fixture — separate from school №12 GPR/calc/facts.
 * Marked in titles with «[TEST]»; never mutates existing p-1 / g-1 / c-1 / pf-1.
 */
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
  scheduleId: "g-t25u-test",
  planFactId: "pf-t25u-test",
  workName: "Демонтаж перегородок",
  /** Fixed date inside TEST stage window — for acceptance UI path only */
  date: "2026-11-08",
} as const;

export function isT25uTestTitle(title: string | undefined | null): boolean {
  return Boolean(title && /\[TEST\]/i.test(title));
}

export function isT25uTestId(id: string | undefined | null): boolean {
  return Boolean(id && id.includes("t25u-test"));
}

function testCalculation(orgId: string): Calculation {
  return {
    id: T25U_TEST.calculationId,
    orgId,
    procurementId: T25U_TEST.procurementId,
    title: "[TEST] Расчёт стоимости — демо-контур t25u",
    kind: "resource_draft",
    status: "v_rabote",
    positions: [
      {
        id: "ctp-1",
        code: "LAB-T",
        name: "Демонтажник",
        unit: "чел",
        quantity: 10,
        rate: 1054,
      },
      {
        id: "ctp-2",
        code: "LAB-W",
        name: "Электрогазосварщик 3 разряда",
        unit: "чел",
        quantity: 2,
        rate: 1376,
      },
      {
        id: "ctp-3",
        code: "ATS-T",
        name: "JCB 5 CX",
        unit: "маш",
        quantity: 2,
        rate: 5800,
      },
      {
        id: "ctp-4",
        code: "MAT-T",
        name: "Контейнеры под бой",
        unit: "шт",
        quantity: 8,
        rate: 4500,
      },
    ],
    assumptions: [
      "[TEST] Изолированный контур приёмки t25u — не данные школы №12",
    ],
    scenario: "bazovyy",
    scenarioFactor: 1,
    participateDecision: "na_rassmotrenii",
    directoryVersionId: "dir-rascenki-client-1",
    version: 1,
    authorId: "u-smet",
    updatedAt: "2026-11-08T12:00:00Z",
    immutable: false,
    changeLog: [],
    dataFlags: ["t25u_test_fixture"],
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
            name: "JCB 5 CX",
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
          {
            id: "rst-1-bus",
            kind: "bus",
            name: "Автобус доставки",
            quantity: 1,
            unit: "ед",
            rate: 2650,
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
          {
            id: "rst-2-bus",
            kind: "bus",
            name: "Автобус доставки",
            quantity: 1,
            unit: "ед",
            rate: 2650,
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
        // no labor — proves Gantt resource filter
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
          {
            id: "rst-3-bus",
            kind: "bus",
            name: "Автобус доставки",
            quantity: 1,
            unit: "ед",
            rate: 2650,
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
    createdAt: "2026-11-01T10:00:00Z",
  };
}

/** Insert TEST entities if absent — never patches school p-1/g-1/c-1/pf-1. */
export function ensureT25uTestFixture(data: AppData): AppData {
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
  if (!data.calculations.some((c) => c.id === T25U_TEST.calculationId)) {
    data.calculations.push(testCalculation(orgId));
  }
  if (!data.schedules.some((s) => s.id === T25U_TEST.scheduleId)) {
    data.schedules.push(testSchedule(orgId));
  }
  if (!data.planFacts.some((p) => p.id === T25U_TEST.planFactId)) {
    data.planFacts.push(testPlanFact(orgId, objectId));
  }
  return data;
}
