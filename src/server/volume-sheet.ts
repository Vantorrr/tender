import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertOrgAccess } from "@/lib/acl";
import type { VolumeDraftRow } from "@/lib/wave23";
import { matchCompanyDirectoryRate } from "@/lib/client-dirs";
import { parseVolumeDraft, priceVolumeRows } from "@/lib/wave23";
import { readAppData, mutateAppData } from "@/server/db";
import { recomputeCalculationCost } from "@/server/repo";
import { parseDocxBuffer } from "@/server/docx-parse";
import { detectLocalOcrTools } from "@/server/ocr";
import { completeJson, modelConfigured } from "@/server/openrouter";
import { readUpload } from "@/server/uploads";
import type { AppData, DirectoryVersion, DocumentItem } from "@/lib/types";

const VOLUME_SYSTEM = `Ты выделяешь ведомость объёмов из технического задания. Ответ — один JSON {"rows":[{"work":"вид работ","unit":"единица","volume":число,"quote":"дословная цитата из текста"}]}. Каждая цитата должна быть непрерывным фрагментом исходного текста. Не выдумывай объёмы. Если объёма нет, не создавай строку. Пиши по-русски.`;

export const VOLUME_MODEL_MISSING = "Разбор не выполнен: модель не подключена. После подключения здесь появится черновик ведомости, его можно править вручную.";

function actorOf(data: AppData, actorId: string) {
  const actor = data.users.find((user) => user.id === actorId);
  if (!actor) throw new Error("Требуется вход");
  return actor;
}

function isSpecDocument(document: DocumentItem): boolean {
  return document.category === "tz" || /(?:^|[^а-яё])тз(?=$|[^а-яё])|техническ/iu.test(`${document.fileName} ${document.title}`);
}

function pdfTextLayer(bytes: Buffer): string {
  const tool = detectLocalOcrTools().pdftotext;
  if (!tool) return "";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tk-spec-"));
  try {
    const pdfPath = path.join(tmp, "spec.pdf");
    fs.writeFileSync(pdfPath, bytes);
    const result = spawnSync(tool, ["-layout", pdfPath, "-"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0) return "";
    return (result.stdout ?? "").trim();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Text of an uploaded specification: plain text, a docx body, or a PDF text layer. */
export async function extractUploadedSpecText(fileName: string, bytes: Buffer): Promise<string> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".txt") || lower.endsWith(".text")) {
    return bytes.toString("utf8").replace(/^\uFEFF/, "").trim();
  }
  if (lower.endsWith(".docx")) {
    return (await parseDocxBuffer(bytes))?.plainText.trim() ?? "";
  }
  if (lower.endsWith(".pdf")) return pdfTextLayer(bytes);
  return "";
}

function quoteIsFromText(source: string, quote: string): boolean {
  const needle = quote.trim();
  if (!needle) return false;
  if (source.includes(needle)) return true;
  const fold = (value: string) => value.replace(/\s+/g, " ").trim();
  return fold(source).includes(fold(needle));
}

async function specCorpus(data: AppData, procurementId: string): Promise<{ prompt: string; quoteSource: string }> {
  const documents = data.documents.filter((document) => document.procurementId === procurementId && isSpecDocument(document));
  const fileTexts = (await Promise.all(documents.map(async (document) => {
    if (!document.storedPath) return "";
    const bytes = readUpload(document.storedPath);
    if (!bytes?.length) return "";
    return extractUploadedSpecText(document.fileName, bytes);
  }))).filter(Boolean);
  const notes = documents
    .map((document) => [document.analyticalNote, ...document.citations.map((citation) => citation.text)].filter(Boolean).join("\n"))
    .filter(Boolean);
  const fileText = fileTexts.join("\n").trim();
  const noteText = notes.join("\n").trim();
  return {
    prompt: [fileText, noteText].filter(Boolean).join("\n").trim(),
    quoteSource: fileText || noteText,
  };
}

function rateFromDirectory(directories: DirectoryVersion[], work: string, unit: string): number | null {
  return matchCompanyDirectoryRate(directories, { code: "ВОР", name: work, unit })?.rate ?? null;
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
  const corpus = await specCorpus(data, calculation.procurementId);
  if (!corpus.prompt) throw new Error("Нет текста технического задания в карточке. Загрузите ТЗ или заполните ведомость вручную.");
  if (!ask && !modelConfigured()) {
    return { configured: false, message: VOLUME_MODEL_MISSING, rows: [] };
  }
  const raw = await (ask ?? completeJson)(VOLUME_SYSTEM, corpus.prompt.slice(0, 14_000));
  const grounded = parseVolumeDraft(raw).filter((row) => quoteIsFromText(corpus.quoteSource, row.quote));
  return {
    configured: true,
    rows: priceVolumeRows(grounded, (work, unit) => rateFromDirectory(data.directories, work, unit)),
  };
}

export function acceptVolumeDraft(actorId: string, calculationId: string, rows: VolumeDraftRow[]) {
  mutateAppData((data) => {
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
      ...accepted.map((row) => {
        const hit = matchCompanyDirectoryRate(data.directories, { code: "ВОР", name: row.work, unit: row.unit });
        const rate = hit?.rate ?? 0;
        return {
          id: `vor-${crypto.randomUUID()}`,
          code: "ВОР",
          name: row.work.trim(),
          unit: row.unit.trim(),
          quantity: row.volume,
          rate,
          rateMissing: !(rate > 0),
          ...(hit?.basis === "person_hour" ? { rateBasis: "person_hour" as const } : hit ? { rateBasis: "directory" as const, rateSourceDirectoryId: hit.dirId } : {}),
          sourceWorkName: row.work.trim(),
        };
      }),
    ];
    calculation.assumptions = [
      ...calculation.assumptions,
      ...accepted.map((row) => `Цитата · ${row.work.trim()}: ${row.quote.trim()}`),
    ];
    calculation.updatedAt = new Date().toISOString();
    return data;
  });
  recomputeCalculationCost(actorId, calculationId);
  return readAppData();
}
