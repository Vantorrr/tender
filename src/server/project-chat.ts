import type {
  AppData,
  ProjectChatMessage,
  ProjectChatScreen,
  ProjectChatSource,
  User,
} from "@/lib/types";
import { CHAT_CALC_POSITIONS, CHAT_CITATION_BLOCK_CHARS, CHAT_CITATIONS_PER_DOCUMENT, CHAT_DOCUMENTS, CHAT_ESTIMATE_POSITIONS, CHAT_PROMPT_SOURCE_CHARS, CHAT_PROMPT_SOURCES, PROJECT_CHAT_SYSTEM } from "@/server/ai-prompts";
import { completeJson, modelConfigured } from "@/server/openrouter";
import { visibleProcurementNumber } from "@/lib/pipeline";
import { getBootstrap } from "@/server/repo";
import { mutateAppData, readAppData } from "@/server/db";

const MAX_QUESTION_LENGTH = 1200;
const MAX_HISTORY_MESSAGES = 6;
const MAX_SOURCES = 160;
const MAX_PROMPT_SOURCES = CHAT_PROMPT_SOURCES;
const MAX_PROMPT_SOURCE_LENGTH = CHAT_PROMPT_SOURCE_CHARS;
const CHAT_CAP = 40;

const SYSTEM = PROJECT_CHAT_SYSTEM;

type Source = ProjectChatSource & { sourceText: string };
type ChatResult = { answer: string; outOfScope: boolean; sources: Array<{ sourceId: string; quote: string }> };
const NO_EVIDENCE_ANSWER = "В материалах этой закупки не нашёл ответа на этот вопрос. Добавьте нужный документ или уточните, где искать: в договоре, смете, ГПР или плане/факте.";

function normalize(value: string) {
  return value.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

const RU_ENDINGS = ["иями", "ями", "ами", "ого", "ему", "ыми", "ими", "ее", "ые", "ая", "яя", "ое", "ий", "ый", "ой", "ым", "им", "ом", "ем", "ых", "их", "ах", "ях", "ам", "ям", "ов", "ев", "ей", "ою", "ею", "а", "я", "о", "е", "ы", "и", "у", "ю", "ь", "й"];

function stemTerm(value: string) {
  const term = normalize(value);
  if (!/^[а-я]+$/u.test(term)) return term;
  for (const ending of RU_ENDINGS) {
    if (term.endsWith(ending) && term.length - ending.length >= 3) return term.slice(0, -ending.length);
  }
  return term;
}

function questionTerms(question: string) {
  return normalize(question)
    .split(/[^а-яa-z0-9]+/u)
    .filter((term) => term.length >= 3 && !/^(?:какие|какой|какая|какое|этот|этого|почему|сколько|можно|нужно|есть|будет|тогда|чтобы|проект|закупка)$/u.test(term))
    .map(stemTerm);
}

function textHasTerm(text: string, term: string) {
  return normalize(text).split(/[^а-яa-z0-9]+/u).some((word) => stemTerm(word) === term);
}

function isExplicitCardQuestion(question: string) {
  return /заказчик|кто разместил|организатор|срок подачи|дата подачи|дедлайн|до какого числа|прием заявок|приём заявок|нмцк|начальн\p{L}* цен|стартов\p{L}* цен|регион|где расположен|место выполнения|номер закупки|номер извещения|реестров\p{L}* номер|название закупки|наименование закупки|что за закупка|реквизит\p{L}* закупки|данные закупки/iu.test(question);
}

function isProcurementCardDump(answer: string) {
  const fields = answer.split("\n").filter((line) => /^\s*(?:(?:[-*•])\s*|\d+[.)]\s*)?(?:название|номер|заказчик|регион|вид работ|нмцк|срок подачи|решение об участии|стадия проекта)\s*:/iu.test(line));
  return fields.length >= 2 || /^\s*(?:\*\*)?(?:карточка закупки|данные закупки|сводка закупки)(?:\*\*)?\s*[:—-]?\s*(?:\n|$)/iu.test(answer);
}

/** Keep the project card and the sources that actually match the question. */
export function selectRelevantProjectChatSources<T extends { id: string; label: string; sourceText: string }>(
  question: string,
  sources: T[],
  limit = MAX_PROMPT_SOURCES
) {
  const card = sources.find((source) => source.label === "Карточка закупки");
  const includeCard = Boolean(card && isExplicitCardQuestion(question));
  const terms = questionTerms(question);
  const ranked = sources
    .filter((source) => source !== card)
    .map((source, index) => {
      const score = terms.reduce((total, term) =>
        total + (textHasTerm(source.label, term) ? 4 : 0) + (textHasTerm(source.sourceText, term) ? 1 : 0), 0);
      return { source, index, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, limit - (includeCard ? 1 : 0)))
    .map(({ source }) => source);
  // The procurement card is only supplied for explicit metadata questions.
  // Token overlap with generic terms like "работы" made the model dump its fields.
  return [...ranked, ...(includeCard ? [card] : [])].filter((source): source is T => Boolean(source));
}

function isClearlyOutOfScope(question: string) {
  return /погод(?:а|у|ы|е|ой|ный|ные)|прогноз погоды|анекдот|рецепт|фильм|сериал|футбол|хоккей|биткоин|криптовалют|политик/u.test(
    question.toLocaleLowerCase("ru-RU")
  );
}

function displayedDeadline(value: string) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return value || "не указан";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(date);
}

function directCardFacts(question: string, cardSource: Source | undefined) {
  if (!cardSource) return null;
  const fieldPatterns: Array<[RegExp, RegExp]> = [
    [/(?:заказчик|кто разместил|организатор закупки)/iu, /^Заказчик:/u],
    [/(?:срок подачи|дата подачи|дедлайн|до какого числа|когда заканчивается прием)/iu, /^Срок подачи/u],
    [/(?:нмцк|начальн\p{L}* цен|стартов\p{L}* цен)/iu, /^НМЦК:/u],
    [/(?:регион|где расположен|место выполнения)/iu, /^Регион:/u],
    [/(?:номер закупки|номер извещения|реестров\p{L}* номер)/iu, /^Номер:/u],
    [/(?:название|наименование) (?:закупки|проекта|объекта)|что за закупка/iu, /^Название:/u],
  ];
  const lines = cardSource.sourceText.split("\n");
  const quotes = fieldPatterns
    .filter(([questionPattern]) => questionPattern.test(question))
    .map(([, linePattern]) => lines.find((line) => linePattern.test(line)))
    .filter((line): line is string => Boolean(line && !/: (?:не указан|не указана)$/u.test(line)))
    .slice(0, 4);
  if (!quotes.length) return null;
  return {
    answer: quotes.join("\n"),
    outOfScope: false,
    sources: quotes.map((quote) => ({ sourceId: cardSource.id, quote })),
  } satisfies ChatResult;
}

export function parseProjectChatResult(raw: string): ChatResult {
  const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(text) as Partial<ChatResult>;
  if (typeof parsed.answer !== "string" || !parsed.answer.trim()) {
    throw new Error("Пустой ответ ИИ");
  }
  return {
    answer: parsed.answer.trim().slice(0, 4000),
    outOfScope: parsed.outOfScope === true,
    sources: Array.isArray(parsed.sources)
      ? parsed.sources.filter((source): source is { sourceId: string; quote: string } =>
          Boolean(source && typeof source.sourceId === "string" && typeof source.quote === "string")
        ).slice(0, 8)
      : [],
  };
}

export function validateProjectChatResult(result: ChatResult, sources: Source[], question = "") {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const accepted: ProjectChatSource[] = [];
  for (const candidate of result.sources) {
    const source = byId.get(candidate.sourceId);
    const quote = normalize(candidate.quote);
    if (!source || quote.length < 8 || !normalize(source.sourceText).includes(quote)) continue;
    if (accepted.some((item) => item.id === source.id && normalize(item.quote) === quote)) continue;
    accepted.push({ id: source.id, label: source.label, quote: candidate.quote.trim(), href: source.href });
  }
  const answerNumbers = result.answer.match(/\d+(?:[.,]\d+)?\s*%?/g) ?? [];
  const quoted = normalize(accepted.map((source) => source.quote).join(" "));
  const numbersGrounded = answerNumbers.every((number) => quoted.includes(normalize(number)));
  if (!result.outOfScope && (isProcurementCardDump(result.answer) && !isExplicitCardQuestion(question) || !accepted.length || !numbersGrounded)) {
    return {
      answer: NO_EVIDENCE_ANSWER,
      outOfScope: false,
      sources: [] as ProjectChatSource[],
    };
  }
  return {
    answer: result.outOfScope
      ? "Я отвечаю только по текущей закупке: её документам, смете, расчёту, графику, рискам, поставкам и производству."
      : result.answer,
    outOfScope: result.outOfScope,
    sources: result.outOfScope ? [] : accepted,
  };
}

function buildSources(data: AppData, procurementId: string): Source[] {
  const procurement = data.procurements.find((item) => item.id === procurementId);
  if (!procurement) return [];
  const sources: Source[] = [];
  let index = 0;
  const add = (label: string, text: string, href?: string, maxLength = 900) => {
    const sourceText = text.trim().slice(0, maxLength);
    if (!sourceText) return;
    sources.push({ id: `S${String(++index).padStart(3, "0")}`, label, quote: "", sourceText, href });
  };

  add(
    "Карточка закупки",
    [
      `Название: ${procurement.title}`,
      `Номер: ${visibleProcurementNumber(procurement)}`,
      `Заказчик: ${procurement.customer}`,
      `Регион: ${procurement.region}`,
      `Вид работ: ${procurement.workType ?? "не указан"}`,
      `НМЦК: ${procurement.nmck ?? "не указана"}`,
      `Срок подачи: ${displayedDeadline(procurement.deadline)}${procurement.deadline ? ` (исходное значение: ${procurement.deadline})` : ""}`,
      `Решение об участии: ${procurement.reviewStatus}`,
      `Стадия проекта: ${procurement.lifecycle ?? "закупка"}`,
    ].join("\n"),
    `/cabinet/zakupki/${procurement.id}`
  );
  if (procurement.analytics) {
    add(
      "Автоматическая сводка проекта · требует проверки по источникам",
      [
        `Рекомендация: ${procurement.analytics.recommendation}`,
        `Полнота источников: ${procurement.analytics.quality?.status ?? "не оценена"}`,
        `Документов: ${procurement.analytics.quality?.sourceDocuments ?? "не указано"}`,
        `Цитат: ${procurement.analytics.quality?.citationCount ?? procurement.analytics.citations.length}`,
        `Чего не хватает: ${procurement.analytics.missingInputs.join("; ") || "не указано"}`,
      ].join("\n"),
      `/cabinet/zakupki/${procurement.id}`
    );
  }

  const documents = data.documents.filter((item) => item.procurementId === procurementId && item.storedPath);
  const unavailableDocuments = data.documents.filter((item) => item.procurementId === procurementId && !item.storedPath);
  if (unavailableDocuments.length) {
    add(
      "Недоступные оригиналы документов",
      unavailableDocuments.map((item) => `${item.fileName}: исходный файл не приложен или недоступен; сведения из карточки документа нельзя подтверждать этим источником.`).join("\n"),
      `/cabinet/zakupki/${procurementId}`
    );
  }
  for (const doc of documents.slice(0, CHAT_DOCUMENTS)) {
    const docHref = `/cabinet/dokumenty/${doc.id}`;
    add(
      `Документ · ${doc.fileName}`,
      `Название: ${doc.title}\nФайл: ${doc.fileName}\nКатегория: ${doc.category ?? "не указана"}\nСтатус разбора: ${doc.status}${doc.extractionErrors?.length ? `\nОшибки: ${doc.extractionErrors.join("; ")}` : ""}`,
      docHref
    );
    const citations = doc.citations.slice(0, CHAT_CITATIONS_PER_DOCUMENT).map((citation) => {
      const location = citation.sheet
        ? `лист ${citation.sheet}${citation.cell ? `, ${citation.cell}` : ""}`
        : citation.paragraph != null
          ? `абзац ${citation.paragraph}`
          : `стр. ${citation.page}`;
      return `[${location}] ${citation.text}`;
    });
    if (citations.length) add(`Выдержки · ${doc.fileName}`, citations.join("\n"), docHref, CHAT_CITATION_BLOCK_CHARS);
    const positions = (doc.estimatePositions ?? []).slice(0, CHAT_ESTIMATE_POSITIONS);
    if (positions.length) {
      add(
        `Позиции сметы · ${doc.fileName}`,
        positions.map((position) => `${position.code || "—"} · ${position.name}; ${position.quantity} ${position.unit}; ${position.rate} ₽/ед.`).join("\n"),
        docHref,
        5000
      );
    }
  }

  const calculations = data.calculations.filter((item) => item.procurementId === procurementId);
  for (const calc of calculations) {
    add(
      `Расчёт · ${calc.title}`,
      [
        `Статус: ${calc.status}`,
        `Тип: ${calc.kind ?? "не указан"}`,
        `Сценарий: ${calc.scenario}`,
        `Итог: ${calc.costSummary?.priceIncVat ?? calc.costSummary?.C0 ?? "нет подтверждённого итога"} ₽`,
        `Неполные входные данные: ${(calc.costSummary?.incomplete ?? calc.dataFlags ?? []).join("; ") || "не указаны"}`,
        `Допущения: ${(calc.assumptions ?? []).join("; ") || "не указаны"}`,
      ].join("\n"),
      `/cabinet/raschety/${calc.id}`
    );
    const positions = calc.positions.slice(0, CHAT_CALC_POSITIONS);
    if (positions.length) add(
      `Позиции расчёта · ${calc.title}`,
      positions.map((position) => `${position.code ? `${position.code} · ` : ""}${position.name}; ${position.quantity} ${position.unit} × ${position.rate} ₽${position.rateMissing ? "; ставка не подтверждена" : ""}`).join("\n"),
      `/cabinet/raschety/${calc.id}`,
      8000
    );
  }

  const schedules = data.schedules.filter((item) => item.procurementId === procurementId);
  for (const schedule of schedules) {
    add(
      `ГПР · ${schedule.title}`,
      `Версия: ${schedule.version}; допущения: ${(schedule.assumptions ?? []).join("; ") || "нет"}`,
      `/cabinet/gpr/${schedule.id}`
    );
    for (const stage of schedule.stages) {
      add(
        `Этап ГПР · ${stage.name}`,
        [
          `Работы: ${(stage.workNames?.length ? stage.workNames : stage.workName ? [stage.workName] : []).join(", ") || "не связана с видом работ"}`,
          `Период: ${stage.start} — ${stage.end}`,
          `Плановый объём: ${stage.planVolume ?? "не задан"}`,
          `Зависимость: ${stage.dependencyType ?? "нет"}${stage.dependsOn ? ` от ${stage.dependsOn}` : ""}`,
          `Ресурсы: ${(stage.resources ?? []).map((resource) => `${resource.kind} ${resource.name}: ${resource.quantity} ${resource.unit}, ставка ${resource.rate ?? "не задана"}`).join("; ") || "не заданы"}`,
        ].join("\n"),
        `/cabinet/gpr/${schedule.id}`
      );
    }
  }

  const risks = data.risks.find((item) => item.procurementId === procurementId);
  if (risks) {
    add(
      `Риски · ${risks.title}`,
      [`Договор разобран: ${risks.contractParsed ? "да" : "нет"}; статус: ${risks.status}`,
        ...risks.remarks.map((remark) => `${remark.severity} · ${remark.status}: ${remark.text}\nИсточник: ${remark.sourceExcerpt || "нет цитаты"}${remark.decision ? `\nРешение: ${remark.decision}` : ""}`),
      ].join("\n"),
      `/cabinet/zakupki/${procurementId}`,
      8000
    );
  }

  const money = data.moneyPlans.find((item) => item.procurementId === procurementId);
  if (money) add(
    `Денежный план · ${money.title}`,
    money.payments.map((payment) => `${payment.type} · ${payment.title}; дата: ${payment.date}; сумма: ${payment.amount} ₽; условие: ${payment.note || "не указано"}`).join("\n"),
    `/cabinet/zakupki/${procurementId}`,
    5000
  );

  const supplies = (data.supplyRequests ?? []).filter((item) => item.procurementId === procurementId).slice(0, 60);
  if (supplies.length) add(
    "Материалы и поставки",
    supplies.map((supply) => `${supply.materialName}; работа: ${supply.workName || "не указана"}; потребность: ${supply.qtyNeed} ${supply.unit}; заказано: ${supply.qtyOrdered}; получено: ${supply.qtyDelivered}; нужно к: ${supply.needBy}; статус: ${supply.status}; цена: ${supply.unitPrice ?? "не задана"}`).join("\n"),
    `/cabinet/zakupki/${procurementId}`,
    7000
  );

  const plan = data.planFacts.find((item) => item.procurementId === procurementId);
  if (plan) {
    add(
      `План/факт · ${plan.title}`,
      plan.entries.slice(0, 80).map((entry) => `${entry.workName}: план ${entry.plan} ${entry.unit}, факт ${entry.fact} ${entry.unit}, остаток ${entry.contractRemaining ?? Math.max(0, entry.plan - entry.fact)} ${entry.unit}`).join("\n"),
      `/cabinet/proizvodstvo?planFactId=${plan.id}`,
      7000
    );
  }
  return sources.slice(0, MAX_SOURCES);
}

export function getProjectChat(user: User, procurementId: string) {
  const data = getBootstrap(user).data;
  const procurement = data.procurements.find((item) => item.id === procurementId);
  if (!procurement) throw new Error("Закупка не найдена или нет доступа");
  const stored = readAppData().projectChatMessages ?? [];
  return {
    modelAvailable: modelConfigured(),
    messages: stored
      .filter((item) => item.userId === user.id && item.procurementId === procurementId)
      .map((item) => item.role === "assistant" && isProcurementCardDump(item.content)
        ? {
            ...item,
            content: "Старый ответ пересказывал карточку вместо ответа на вопрос. Задайте этот вопрос ещё раз — теперь чат ищет подтверждение в документах и материалах закупки.",
            sources: [],
          }
        : item),
  };
}

export async function sendProjectChatMessage(
  user: User,
  input: { procurementId: string; screen: ProjectChatScreen; message: string }
) {
  const question = input.message.trim();
  if (!question) throw new Error("Введите вопрос");
  if (question.length > MAX_QUESTION_LENGTH) throw new Error(`Вопрос не должен превышать ${MAX_QUESTION_LENGTH} символов`);

  const data = getBootstrap(user).data;
  const procurement = data.procurements.find((item) => item.id === input.procurementId);
  if (!procurement) throw new Error("Закупка не найдена или нет доступа");
  const allSources = buildSources(data, procurement.id);
  const history = (readAppData().projectChatMessages ?? [])
    .filter((item) => item.userId === user.id && item.procurementId === procurement.id)
    .slice(-MAX_HISTORY_MESSAGES)
    .filter((item) => item.role !== "assistant" || !isProcurementCardDump(item.content))
    .map(({ role, content }) => ({ role, content: content.slice(0, 1000) }));

  let answer: string;
  let citations: ProjectChatSource[] = [];
  const outOfScope = isClearlyOutOfScope(question);
  if (outOfScope) {
    answer = "Я отвечаю только по текущей закупке: её документам, смете, расчёту, графику, рискам, поставкам и производству.";
  } else {
    const direct = directCardFacts(question, allSources[0]);
    if (direct) {
      const validated = validateProjectChatResult(direct, allSources, question);
      answer = validated.answer;
      citations = validated.sources;
    } else {
      if (!modelConfigured()) throw new Error("ИИ-чат не настроен: администратору нужно подключить модель");
      const promptSources = selectRelevantProjectChatSources(question, allSources);
      if (!promptSources.length) {
        // Don't call the model with an empty evidence set: it tended to fill
        // the gap by repeating procurement metadata instead of answering.
        answer = NO_EVIDENCE_ANSWER;
      } else {
        const userPrompt = JSON.stringify({
          currentBlock: input.screen,
          history,
          question,
          sources: promptSources.map(({ id, label, sourceText }) => ({
            id,
            label,
            text: sourceText.slice(0, MAX_PROMPT_SOURCE_LENGTH),
          })),
        });
        const parsed = parseProjectChatResult(await completeJson(SYSTEM, userPrompt));
        const validated = validateProjectChatResult(parsed, allSources, question);
        answer = validated.answer;
        citations = validated.sources;
      }
    }
  }

  const now = new Date().toISOString();
  const userMessage: ProjectChatMessage = {
    id: `chat-${crypto.randomUUID()}`,
    orgId: procurement.orgId,
    procurementId: procurement.id,
    userId: user.id,
    role: "user",
    content: question,
    screen: input.screen,
    createdAt: now,
  };
  const assistantMessage: ProjectChatMessage = {
    id: `chat-${crypto.randomUUID()}`,
    orgId: procurement.orgId,
    procurementId: procurement.id,
    userId: user.id,
    role: "assistant",
    content: answer,
    screen: input.screen,
    sources: citations,
    createdAt: new Date().toISOString(),
  };

  mutateAppData((current) => {
    if (!current.procurements.some((item) =>
      item.id === procurement.id && (user.role === "superadmin" || item.orgId === user.orgId)
    )) {
      throw new Error("Закупка не найдена или нет доступа");
    }
    const messages = current.projectChatMessages ?? [];
    messages.push(userMessage, assistantMessage);
    const projectUserMessages = messages.filter((item) => item.userId === user.id && item.procurementId === procurement.id);
    const removeIds = new Set(projectUserMessages.slice(0, Math.max(0, projectUserMessages.length - CHAT_CAP)).map((item) => item.id));
    current.projectChatMessages = messages.filter((item) => !removeIds.has(item.id));
    return current;
  });

  return { userMessage, assistantMessage };
}
