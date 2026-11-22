/**
 * Прогон промптов на тестовых документах репозитория.
 *
 * Реальный вызов (на проде модель google/gemini-3-flash-preview):
 *   OPENROUTER_API_KEY=... npx tsx scripts/eval-ai-prompts.ts
 *
 * Без ключа, с подставленным ответом:
 *   npx tsx scripts/eval-ai-prompts.ts --mock
 *
 * Ответы: eval-output/*.json, сводка: eval-output/summary.md
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreModelResponse, renderScoreSummary, type PromptScore } from "../src/server/ai-prompt-score";
import { rollupWorkSections } from "../src/server/estimate-rollup";
import { applyLiveSupplierLinks, filterSupplierCandidates, resolveSearchSources } from "../src/server/supplier-discovery";
import {
  MODEL_NOTE_SYSTEM,
  PRODUCTION_VARIANCE_SYSTEM,
  PROJECT_ANALYSIS_SYSTEM,
  PROJECT_CHAT_SYSTEM,
  SUPPLIER_DISCOVERY_SYSTEM,
} from "../src/server/ai-prompts";
import { buildCalcCompareBatch } from "../src/server/calc-compare-ai";
import { analysisFromDocx, parseDocxBuffer } from "../src/server/docx-parse";
import { analysisFromGrand, analysisFromScan, parseGrandBuffer } from "../src/server/grand-smeta";
import { buildModelNoteUserContent } from "../src/server/model-note";
import { completeJsonWithUsage } from "../src/server/openrouter";
import { citationForModel } from "../src/server/project-analysis-ai";
import { buildProductionVarianceUserContent } from "../src/server/production-variance-ai";
import { buildSupplierQuery } from "../src/server/supplier-discovery";
import type { Calculation, Citation } from "../src/lib/types";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "eval-output");
const mock = process.argv.includes("--mock") || process.env.EVAL_AI_MOCK === "1";
const evalModel = process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash";

type EvalCase = {
  id: string;
  title: string;
  system: string;
  user: string;
  requiredFields: string[];
  allowEmptyArrays?: string[];
  citationHint?: string;
  fixtureNote: string;
  webSearch?: boolean;
  maxTokens?: number;
  completeness?: { label: string; quantities: number[] };
};

function readPdfPages(filePath: string): { pages: string[]; note: string } {
  const probe = spawnSync("which", ["pdftotext"], { encoding: "utf8" });
  if (probe.status !== 0 || !probe.stdout.trim()) {
    return { pages: [], note: "pdftotext не найден, текстовый слой PDF в этот прогон не попал" };
  }
  const extracted = spawnSync("pdftotext", ["-layout", filePath, "-"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (extracted.status !== 0) {
    return { pages: [], note: "pdftotext не смог прочитать PDF" };
  }
  const pages = extracted.stdout.split("\f").map((page) => page.trim()).filter(Boolean);
  return { pages, note: pages.length ? `pdftotext: ${pages.length} стр.` : "pdftotext вернул пустой текст" };
}

function calculationFromPositions(id: string, positions: Array<{ code: string; name: string; unit: string; quantity: number; rate: number }>, params?: Calculation["resourceScheduleParams"]): Calculation {
  return {
    id,
    orgId: "eval",
    procurementId: "eval",
    title: id,
    status: "v_rabote",
    positions: positions.map((position, index) => ({ id: `${id}-${index}`, ...position })),
    assumptions: [],
    scenario: "bazovyy",
    scenarioFactor: 1,
    participateDecision: null,
    directoryVersionId: "eval",
    version: 1,
    authorId: "eval",
    updatedAt: new Date().toISOString(),
    kind: id === "original" ? "customer_original" : "resource_draft",
    resourceScheduleParams: params,
  };
}

async function loadCases(): Promise<EvalCase[]> {
  const docxPath = path.join(root, "fixtures/docx/contract-terms.docx");
  const docx = await parseDocxBuffer(fs.readFileSync(docxPath));
  const docxAnalysis = docx ? analysisFromDocx("contract-terms.docx", docx) : null;
  const estimatePath = path.join(root, "fixtures/grand-smeta/ls-02-02-01-burenie.xlsx");
  const estimateBuffer = fs.readFileSync(estimatePath);
  const parsedEstimate = await parseGrandBuffer(estimateBuffer);
  const estimateAnalysis = parsedEstimate ? analysisFromGrand(parsedEstimate, "ЛС-02-02-01-бурение.xlsx") : null;
  const installPath = path.join(root, "fixtures/grand-smeta/ls-02-02-02-ustanovka.xlsx");
  const installParsed = await parseGrandBuffer(fs.readFileSync(installPath));
  const otherPath = path.join(root, "fixtures/grand-smeta/ls-01-02-01-demontazh.xlsx");
  const otherParsed = await parseGrandBuffer(fs.readFileSync(otherPath));
  const pdfPath = path.join(root, "fixtures/grand-smeta/III-D-101-3103-KM.L2_TP-KP-M-D_etap-2.pdf");
  const pdf = readPdfPages(pdfPath);
  const pdfAnalysis = analysisFromScan("III-D-101-3103-KM.L2.pdf", {
    status: pdf.pages.length ? "ok" : "empty",
    text: pdf.pages.join("\n"),
    pages: pdf.pages,
    pageCount: pdf.pages.length,
    reason: pdf.note,
  });
  const schedule = JSON.parse(fs.readFileSync(path.join(root, "fixtures/resource-schedule/anon-mobilization.json"), "utf8")) as {
    params: { overheadRate: number; profitMarkupOnCostWithOh: number; personHourRate: number; personnelShiftsPerDay: number; hoursPerShift: number; equipmentShiftsPerDay: number };
  };
  const sampleNote = fs.readFileSync(path.join(root, "fixtures/uploads/sample-note.txt"), "utf8").trim();

  const packageCitations: Citation[] = [
    ...(docxAnalysis?.citations ?? []),
    ...(estimateAnalysis?.citations ?? []),
    ...pdfAnalysis.citations,
  ];
  const drillingRollup = rollupWorkSections(parsedEstimate?.positions ?? []);
  const noteFacts = {
    kind: "local-estimate" as const,
    fileName: "ЛС-02-02-01-бурение.xlsx",
    zone: parsedEstimate?.zone ?? "",
    region: parsedEstimate?.region ?? "",
    estimateNumber: parsedEstimate?.estimateNumber ?? "",
    workName: parsedEstimate?.workName ?? "",
    costThousand: parsedEstimate?.costCurrentThousand ?? null,
    positionCount: parsedEstimate?.positions.length ?? 0,
    coefficientNotes: parsedEstimate?.coefficientNotes ?? [],
    sectionRollup: drillingRollup,
    largest: (parsedEstimate?.positions ?? []).slice(0, 5).map((position) => ({
      name: position.name,
      unit: position.unit,
      quantity: position.quantity,
      rate: position.rate,
    })),
  };

  const originalPositions = (parsedEstimate?.positions ?? []).slice(0, 30).map((position) => ({
    code: position.code,
    name: position.name,
    unit: position.unit,
    quantity: position.quantity,
    rate: position.rate,
  }));
  const draftPositions = (otherParsed?.positions ?? originalPositions).slice(0, 30).map((position) => ({
    code: position.code,
    name: position.name,
    unit: position.unit,
    quantity: position.quantity,
    rate: position.rate,
  }));
  const compare = buildCalcCompareBatch(
    calculationFromPositions("original", originalPositions),
    calculationFromPositions("draft", draftPositions, schedule.params),
  );
  const contractQuote = docxAnalysis?.citations.find((citation) => citation.text.length >= 8)?.text
    ?? sampleNote;
  const varianceSources = [{
    id: "fact-1",
    kind: "daily_comment" as const,
    text: `Дата: 2026-11-09; работа: ${docxAnalysis?.analysis.workName || "работы по договору"}; комментарий: ${contractQuote.slice(0, 500)}`,
  }];

  return [
    {
      id: "model-note",
      title: "Заметка по смете",
      system: MODEL_NOTE_SYSTEM,
      user: buildModelNoteUserContent(noteFacts, estimateAnalysis?.highlights ?? [], estimateAnalysis?.citations ?? []),
      requiredFields: ["note"],
      citationHint: "ЛС-02-02-01-бурение.xlsx",
      fixtureNote: `Гранд-смета ${estimatePath}`,
      completeness: {
        label: "бурение, сумма разделов",
        quantities: [
          ...drillingRollup.sections.map((section) => section.quantity),
          ...drillingRollup.totalsByUnit.map((item) => item.quantity),
          ...drillingRollup.titledCounts.map((item) => item.quantity),
        ],
      },
    },
    {
      id: "project-package",
      title: "ИИ-анализ пакета",
      system: PROJECT_ANALYSIS_SYSTEM,
      user: JSON.stringify({
        procurement: {
          number: "EVAL-1",
          title: docxAnalysis?.title || "Пакет тестовых документов",
          customer: "не указан в карточке",
          region: estimateAnalysis?.analysis.region || "не указан",
          deadline: "не найден в загруженных документах",
        },
        documents: [
          {
            fileName: "contract-terms.docx",
            citations: (docxAnalysis?.citations ?? []).map((citation) => citationForModel(citation)),
          },
          {
            fileName: "ЛС-02-02-01-бурение.xlsx",
            citations: (estimateAnalysis?.citations ?? []).slice(0, 40).map((citation) => citationForModel(citation)),
            estimatePositions: (parsedEstimate?.positions ?? []).slice(0, 20),
            sectionRollup: drillingRollup,
          },
          {
            fileName: "ЛС-02-02-02-установка.xlsx",
            sectionRollup: rollupWorkSections(installParsed?.positions ?? []),
            estimatePositions: (installParsed?.positions ?? []).filter((position) => position.isWorkItem).slice(0, 40),
          },
          {
            fileName: "III-D-101-3103-KM.L2.pdf",
            extraction: pdf.note,
            citations: pdfAnalysis.citations.slice(0, 20).map((citation) => citationForModel(citation)),
          },
        ],
        citationCount: packageCitations.length,
      }),
      requiredFields: ["recommendation", "evidence"],
      allowEmptyArrays: ["missingInputs", "customerQuestions", "evidence"],
      fixtureNote: `Договор, смета бурения, смета установки (${installParsed?.positions.length ?? 0} поз.) и PDF (${pdf.note})`,
    },
    {
      id: "project-chat",
      title: "Спросить ИИ",
      system: PROJECT_CHAT_SYSTEM,
      user: JSON.stringify({
        question: "Какая зона и какие условия договора указаны в файле?",
        sources: (docxAnalysis?.citations ?? []).slice(0, 8).map((citation, index) => ({
          id: `S${String(index + 1).padStart(3, "0")}`,
          label: `Выдержки · contract-terms.docx`,
          text: `[${citation.paragraph != null ? `абзац ${citation.paragraph}` : `стр. ${citation.page}`}] ${citation.text}`,
        })),
      }),
      requiredFields: ["answer", "sources"],
      fixtureNote: "fixtures/docx/contract-terms.docx",
    },
    {
      id: "calc-compare",
      title: "Комментарий к сравнению сметы",
      system: compare.system,
      user: compare.user,
      requiredFields: ["summary", "findings"],
      allowEmptyArrays: ["findings"],
      fixtureNote: "Две локальные сметы и правила накладных из ресурсного графика",
      maxTokens: 4000,
    },
    {
      id: "production-variance",
      title: "Отклонение плана и факта",
      system: PRODUCTION_VARIANCE_SYSTEM,
      user: buildProductionVarianceUserContent({
        title: "Тестовый пакет",
        period: "day",
        workName: docxAnalysis?.analysis.workName || "работы по договору",
        planQuantity: 10,
        factQuantity: 6,
        sources: varianceSources,
      }),
      requiredFields: ["summary", "observations"],
      allowEmptyArrays: ["observations"],
      fixtureNote: "Комментарий взят из цитаты договора",
    },
    {
      id: "supplier-discovery",
      title: "Поиск поставщика",
      system: SUPPLIER_DISCOVERY_SYSTEM,
      user: buildSupplierQuery({
        material: "долото трёхшарошечное, трубы стальные",
        region: "Норильск",
      }),
      requiredFields: ["candidates"],
      allowEmptyArrays: ["candidates"],
      webSearch: true,
      fixtureNote: "Материалы: долото трёхшарошечное и трубы стальные, регион Норильск, с веб-поиском как на проде",
    },
  ];
}

function mockReply(evalCase: EvalCase): string {
  const file = evalCase.citationHint ?? "contract-terms.docx";
  if (evalCase.id === "model-note") {
    return JSON.stringify({
      note: `• Файл ${file}. Свод: 716 м, 17076 м, 720 м, 32 м, итого 18544 м, 3044 шт. ${"В переданных фактах нет новых чисел сверх файла. ".repeat(6)}Зона и объёмы взяты только из источника.`,
    });
  }
  if (evalCase.id === "project-package") {
    return JSON.stringify({
      recommendation: "insufficient_data",
      missingInputs: [],
      customerQuestions: ["Уточните районный коэффициент: в переданных выдержках он не указан."],
      evidence: [{
        topic: "other",
        importance: "info",
        text: "Проверка опирается на файл contract-terms.docx.",
        quote: "contract-terms.docx",
        citationIds: ["mock"],
        costImpact: "не указано в документах",
        scheduleImpact: "не указано в документах",
      }],
    });
  }
  if (evalCase.id === "project-chat") {
    const parsed = JSON.parse(evalCase.user) as { sources: Array<{ id: string; text: string }> };
    const source = parsed.sources[0];
    const quote = source?.text.replace(/^\[[^\]]+\]\s*/, "").slice(0, 180) ?? "";
    return JSON.stringify({
      answer: "Ответ только по выдержке договора.",
      outOfScope: false,
      sources: source ? [{ sourceId: source.id, quote }] : [],
    });
  }
  if (evalCase.id === "calc-compare") {
    const parsed = JSON.parse(evalCase.user) as { materialGroups?: Array<{ rowId: string; factsText: string }>; pricingText: string; totals?: { deltaTotal?: number | null } };
    const row = parsed.materialGroups?.find((item) => item.factsText.includes("Ставка"));
    const delta = parsed.totals?.deltaTotal;
    return JSON.stringify({
      summary: `${parsed.pricingText.slice(0, 180)} Итоговая разница ${delta ?? "не указано в документах"}.`,
      findings: row ? [{
        rowId: row.rowId,
        text: "Строка сверена по переданным количеству и ставке.",
        sourceExcerpt: row.factsText.slice(0, 120),
      }] : [],
    });
  }
  if (evalCase.id === "production-variance") {
    const parsed = JSON.parse(evalCase.user) as { sources: Array<{ id: string; text: string }> };
    const source = parsed.sources[0];
    const quote = source?.text.slice(-80) ?? "";
    return JSON.stringify({
      summary: "Причина смотрится только по переданному комментарию.",
      observations: source && quote.length >= 8 ? [{
        sourceId: source.id,
        kind: "documented_reason",
        text: "В комментарии есть запись по работе.",
        sourceQuote: quote,
      }] : [],
    });
  }
  return JSON.stringify({ candidates: [] });
}

function presentQuantities(raw: string, quantities: number[]): { present: number[]; missing: number[] } {
  const present: number[] = [];
  const missing: number[] = [];
  for (const quantity of quantities) {
    const digits = String(Math.trunc(quantity));
    const pattern = new RegExp(`(?:^|\\D)${digits.split("").join("[\\s\\u00a0]?")}(?:\\D|$)`);
    (pattern.test(raw) ? present : missing).push(quantity);
  }
  return { present, missing };
}

async function runCase(evalCase: EvalCase): Promise<{ score: PromptScore; raw: string; sourceUrls: string[] }> {
  const started = Date.now();
  try {
    if (mock) {
      const raw = mockReply(evalCase);
      return {
        raw,
        sourceUrls: [],
        score: scoreModelResponse({
          ...evalCase,
          raw,
          elapsedMs: Date.now() - started,
        }),
      };
    }
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error("Не задан OPENROUTER_API_KEY. Для проверки без сети запустите с --mock.");
    }
    const completion = await completeJsonWithUsage(evalCase.system, evalCase.user, 0, {
      webSearch: evalCase.webSearch,
      maxTokens: evalCase.maxTokens,
      model: evalModel,
      purpose: "prompt-eval",
    });
    const resolvedSources = evalCase.webSearch ? await resolveSearchSources(completion.sourceUrls) : completion.sourceUrls;
    const raw = evalCase.webSearch
      ? JSON.stringify({
        model: JSON.parse(completion.content),
        kept: await applyLiveSupplierLinks(filterSupplierCandidates(completion.content, resolvedSources), resolvedSources),
        sourceUrls: completion.sourceUrls,
        resolvedSources,
      })
      : completion.content;
    return {
      raw,
      sourceUrls: completion.sourceUrls,
      score: scoreModelResponse({
        ...evalCase,
        raw: completion.content,
        elapsedMs: completion.elapsedMs,
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
        totalTokens: completion.totalTokens,
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "ошибка прогона";
    return {
      raw: "",
      sourceUrls: [],
      score: scoreModelResponse({
        ...evalCase,
        raw: "",
        elapsedMs: Date.now() - started,
        error: message,
      }),
    };
  }
}

async function main() {
  const cases = await loadCases();
  fs.mkdirSync(outDir, { recursive: true });
  const scores: PromptScore[] = [];
  const completenessNotes: string[] = [`Модель прогона: ${evalModel}.`, ""];
  for (const evalCase of cases) {
    const result = await runCase(evalCase);
    scores.push(result.score);
    const completeness = evalCase.completeness ? presentQuantities(result.raw, evalCase.completeness.quantities) : null;
    if (completeness && evalCase.completeness) {
      completenessNotes.push(`- ${evalCase.completeness.label}: есть ${completeness.present.join(", ") || "—"}; нет ${completeness.missing.join(", ") || "—"}.`);
    }
    const locationInPrompt = /(?:стр\.|абзац|лист )/.test(evalCase.user) && /(?:\.docx|\.xlsx|\.pdf|contract-terms|бурение)/i.test(evalCase.user);
    fs.writeFileSync(path.join(outDir, `${evalCase.id}.json`), JSON.stringify({
      title: evalCase.title,
      fixture: evalCase.fixtureNote,
      systemPreview: evalCase.system.slice(0, 400),
      userChars: evalCase.user.length,
      userPreview: evalCase.user.slice(0, 500),
      locationInPrompt,
      score: result.score,
      model: evalModel,
      webSearch: Boolean(evalCase.webSearch),
      sourceUrls: result.sourceUrls,
      completeness: evalCase.completeness ? presentQuantities(result.raw, evalCase.completeness.quantities) : null,
      response: result.raw,
    }, null, 2));
    console.log(`${evalCase.title}: json=${result.score.jsonValid} поля=${result.score.fieldsFilled} цитата=${result.score.hasCitation} ${result.score.elapsedMs} мс`);
  }
  const summary = `${renderScoreSummary(scores)}\n\n## Полнота\n\n${completenessNotes.join("\n")}\n`;
  fs.writeFileSync(path.join(outDir, "summary.md"), summary);
  console.log(`\nСводка: ${path.join(outDir, "summary.md")}`);
  if (scores.some((score) => score.error)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
