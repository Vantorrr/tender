import fs from "node:fs";
import path from "node:path";
import pack from "@/lib/grand-reference.json";
import type {
  AppData,
  CalcPosition,
  DocumentItem,
  Highlight,
} from "@/lib/types";
import { config } from "@/server/config";
import { safeFileName } from "@/server/uploads";

const PROC_ID = "p-tpkp";
const OBJ_ID = "obj-tpkp";
const CALC_ID = "c-tpkp";
const AT = "2026-11-05T06:40:00.000Z";

function moneyThousand(value: number) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value);
}

export function installGrandReference(data: AppData): AppData {
  const fixtureDir = path.join(
    /*turbopackIgnore: true*/ process.cwd(),
    "fixtures",
    "grand-smeta"
  );
  const uploadDir = path.join(
    /*turbopackIgnore: true*/ config.dataDir,
    "uploads"
  );
  fs.mkdirSync(uploadDir, { recursive: true });

  const ids = new Set(pack.documents.map((item) => item.id));
  data.documents = data.documents.filter((item) => !ids.has(item.id));
  data.procurements = data.procurements.filter((item) => item.id !== PROC_ID);
  data.objects = data.objects.filter((item) => item.id !== OBJ_ID);
  data.calculations = data.calculations.filter((item) => item.id !== CALC_ID);
  data.notifications = data.notifications.filter((item) => !item.id.startsWith("n-gs-"));
  data.auditLog = data.auditLog.filter((item) => item.id !== "aud-grand-ref");

  const documents: DocumentItem[] = pack.documents.map((src) => {
    const storedName = `${src.id}-${safeFileName(src.fileName)}`;
    const absolute = path.join(uploadDir, storedName);
    const sourcePath = path.join(fixtureDir, src.fixture);
    if (fs.existsSync(sourcePath)) fs.copyFileSync(sourcePath, absolute);
    const cost = src.analysis.costThousand;
    const title =
      cost != null ? `${src.title} · ${moneyThousand(cost)} тыс. руб.` : src.title;
    return {
      id: src.id,
      orgId: "org-alfa",
      procurementId: PROC_ID,
      title,
      fileName: src.fileName,
      fileType: src.fileType === "pdf" ? "pdf" : "xlsx",
      status: src.status === "gotovo" ? "gotovo" : "trebuet_proverki",
      versions: [
        {
          id: `${src.id}-v1`,
          version: 1,
          authorId: "u-smet",
          at: AT,
          note: "Разбор по параметрам ГРАНД-Смета 2022.3",
        },
      ],
      analyticalNote: src.analyticalNote,
      citations: src.citations,
      highlights: src.highlights as Highlight[],
      uploadedBy: "u-smet",
      uploadedAt: AT,
      storedPath: path.join("uploads", storedName),
      fileSize: fs.existsSync(absolute) ? fs.statSync(absolute).size : undefined,
      analysis: {
        ...src.analysis,
        costThousand: src.analysis.costThousand,
      },
    };
  });

  data.objects.unshift({
    id: OBJ_ID,
    orgId: "org-alfa",
    name: "Конденсатопровод Мессояха – Дудинка, 88–127 км",
    address: "Красноярский край, зона 5",
    responsibleId: "u-object",
    status: "v_rabote",
  });

  const rates = data.directories.find((item) => item.type === "rascenki" && item.current);
  data.calculations.unshift({
    id: CALC_ID,
    orgId: "org-alfa",
    procurementId: PROC_ID,
    title: "Объёмы ТП-КП-М-Д · локальные сметы ГРАНД-Смета",
    status: "trebuet_proverki",
    positions: pack.positions as CalcPosition[],
    assumptions: [
      "Позиции сняты с локальных смет ГРАНД-Смета 2022.3, форма приказа № 421",
      "Код: номер сметы и обоснование. Объём — графа «всего с учётом коэффициентов»",
      "Ставка черновая: итог по расценке в текущем уровне, делённый на объём. Накладные и прибыль в ставку не входят",
      "Регион — Красноярский край, зона 5, уровень цен 2023 год, основание — дефектная ведомость № 1.2",
      "ЛС 01-02-01 пришла двумя редакциями с разной стоимостью",
    ],
    scenario: "bazovyy",
    scenarioFactor: 1,
    participateDecision: "na_rassmotrenii",
    directoryVersionId: rates?.id ?? "",
    version: 1,
    authorId: "u-smet",
    updatedAt: AT,
  });

  data.procurements.unshift({
    id: PROC_ID,
    orgId: "org-alfa",
    number: "ТП-КП-М-Д",
    title: "Техническое перевооружение ОРЧ конденсатопровода Мессояха–Дудинка, 2 этап",
    customer: "Комплект локальных смет и чертёж КМ",
    region: "Красноярский край",
    nmck: pack.nmck,
    deadline: "2026-12-15T12:00:00Z",
    source: "ГРАНД-Смета 2022.3",
    status: "trebuet_proverki",
    reviewStatus: "na_rassmotrenii",
    syncStatus: "aktualno",
    syncAt: AT,
    attachments: documents.map((doc) => ({
      id: `att-${doc.id}`,
      name: doc.fileName,
      type: doc.fileType,
      size: doc.fileSize ? `${Math.max(1, Math.round(doc.fileSize / 1024))} КБ` : "",
    })),
    objectId: OBJ_ID,
    documentIds: documents.map((doc) => doc.id),
    calculationId: CALC_ID,
    tags: ["ГРАНД-Смета", "ТП-КП-М-Д", "Красноярский край"],
    createdAt: AT,
  });

  data.documents.unshift(...documents);

  for (const userId of ["u-super", "u-smet", "u-tender"]) {
    data.notifications.unshift({
      id: `n-gs-${userId}`,
      userId,
      title: "Разобран комплект ТП-КП-М-Д",
      body: "Локальные сметы ГРАНД-Смета 2022.3 и чертёж КМ.Л2 разобраны: Красноярский край, зона 5.",
      read: false,
      at: AT,
      href: "/cabinet/dokumenty/d-gs-bur",
    });
  }

  data.auditLog.unshift({
    id: "aud-grand-ref",
    at: AT,
    actorId: "u-smet",
    action: "import",
    entity: "document",
    entityId: PROC_ID,
    detail: `Эталон ГРАНД-Смета: ${documents.length} файлов, ${pack.positions.length} позиций`,
  });

  return data;
}
