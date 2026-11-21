import { assertOrgAccess } from "@/lib/acl";
import type { VolumeDraftRow } from "@/lib/wave23";
import { parseVolumeDraft, priceVolumeRows } from "@/lib/wave23";
import { readAppData, mutateAppData } from "@/server/db";
import { completeJson, modelConfigured } from "@/server/openrouter";
import type { AppData, DirectoryVersion } from "@/lib/types";

const VOLUME_SYSTEM = `Ты выделяешь ведомость объёмов из технического задания. Ответ — один JSON {"rows":[{"work":"вид работ","unit":"единица","volume":число,"quote":"дословная цитата из текста"}]}. Каждая цитата должна быть непрерывным фрагментом исходного текста. Не выдумывай объёмы. Если объёма нет, не создавай строку. Пиши по-русски.`;

export const VOLUME_MODEL_MISSING = "Разбор не выполнен: модель не подключена. После подключения здесь появится черновик ведомости, его можно править вручную.";

function actorOf(data: AppData, actorId: string) {
  const actor = data.users.find((user) => user.id === actorId);
  if (!actor) throw new Error("Требуется вход");
  return actor;
}

function tzCorpus(data: AppData, procurementId: string): string {
  return data.documents
    .filter((document) => document.procurementId === procurementId && (
      document.category === "tz" || /(?:^|[^а-яё])тз(?=$|[^а-яё])|техническ/iu.test(`${document.fileName} ${document.title}`)
    ))
    .map((document) => [document.analyticalNote, ...document.citations.map((citation) => citation.text)].filter(Boolean).join("\n"))
    .join("\n")
    .trim();
}

function rateFromDirectory(directories: DirectoryVersion[], work: string, unit: string): number | null {
  const workKey = work.toLocaleLowerCase("ru-RU");
  const unitKey = unit.toLocaleLowerCase("ru-RU").replace(/\s+/g, "");
  for (const directory of directories) {
    if (!directory.current || (directory.type !== "rascenki" && directory.type !== "ceny")) continue;
    for (const row of directory.rows) {
      const name = String(row.work ?? row.name ?? "").toLocaleLowerCase("ru-RU");
      const rowUnit = String(row.unit ?? "").toLocaleLowerCase("ru-RU").replace(/\s+/g, "");
      const rate = typeof row.rate === "number" ? row.rate : typeof row.price === "number" ? row.price : null;
      if (!name || rate == null || rate <= 0) continue;
      if (rowUnit && rowUnit !== unitKey) continue;
      if (workKey.includes(name) || name.includes(workKey)) return rate;
    }
  }
  return null;
}

export async function draftVolumeSheet(
  actorId: string,
  calculationId: string,
  ask?: (system: string, user: string) => Promise<string>,
): Promise<{ configured: boolean; message?: string; rows: VolumeDraftRow[] }> {
  const data = readAppData();
  const actor = actorOf(data, actorId);
  const calculation = data.calculations.find((item) => item.id === calculationId);
  if (!calculation) throw new Error("Расчёт не найден");
  assertOrgAccess(actor, calculation.orgId, "расчёта");
  const corpus = tzCorpus(data, calculation.procurementId);
  if (!corpus) throw new Error("В карточке нет текста технического задания");
  if (!ask && !modelConfigured()) {
    return { configured: false, message: VOLUME_MODEL_MISSING, rows: [] };
  }
  const raw = await (ask ?? completeJson)(VOLUME_SYSTEM, corpus.slice(0, 14_000));
  const grounded = parseVolumeDraft(raw).filter((row) => corpus.includes(row.quote));
  return {
    configured: true,
    rows: priceVolumeRows(grounded, (work, unit) => rateFromDirectory(data.directories, work, unit)),
  };
}

export function acceptVolumeDraft(actorId: string, calculationId: string, rows: VolumeDraftRow[]) {
  return mutateAppData((data) => {
    const actor = actorOf(data, actorId);
    const calculation = data.calculations.find((item) => item.id === calculationId);
    if (!calculation) throw new Error("Расчёт не найден");
    assertOrgAccess(actor, calculation.orgId, "расчёта");
    if (calculation.immutable || calculation.kind === "customer_original") {
      throw new Error("Этот расчёт нельзя изменять");
    }
    const accepted = rows.filter((row) => row.work.trim() && row.unit.trim() && Number.isFinite(row.volume));
    calculation.positions = [
      ...calculation.positions,
      ...accepted.map((row) => ({
        id: `vor-${crypto.randomUUID()}`,
        code: "ВОР",
        name: row.work.trim(),
        unit: row.unit.trim(),
        quantity: row.volume,
        rate: row.rate != null && row.rate > 0 ? row.rate : 0,
        rateMissing: !(row.rate != null && row.rate > 0),
        sourceWorkName: row.work.trim(),
      })),
    ];
    calculation.assumptions = [
      ...calculation.assumptions,
      ...accepted.map((row) => `Цитата · ${row.work.trim()}: ${row.quote.trim()}`),
    ];
    calculation.updatedAt = new Date().toISOString();
    return data;
  });
}
