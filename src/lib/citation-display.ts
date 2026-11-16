import type { Citation } from "@/lib/types";

const MISSING_VALUE = /^(?:нет данных|не указан(?:а|о|ы)?(?: в файле| в документе)?|не найден(?:а|о|ы)?|—|-|n\/?a)$/iu;

function tidy(value: string): string {
  return value.replace(/\s+/gu, " ").replace(/[«»]/gu, "").trim();
}

/** Remove parser placeholders and header-only fragments from user-facing evidence. */
export function citationTextForDisplay(citation: Citation): string | null {
  let text = tidy(citation.text)
    .replace(/(?:^|[;,]\s*)(?:зона(?: сметного района)?|регион(?: в смете)?|стоимость|основание|площадка|объект|смета)\s*:\s*(?:нет данных|не указан(?:а|о|ы)?(?: в файле| в документе)?)(?=$|[;,])/giu, " ")
    .replace(/\s*[;,]\s*[;,]/gu, ";")
    .replace(/^[;,.\s]+|[;,.\s]+$/gu, "");

  if (!text || MISSING_VALUE.test(text)) return null;
  if (citation.confidence === "unconfirmed" && /нет данных|не указан(?:а|о|ы)?|не найден(?:а|о|ы)?/iu.test(text)) return null;
  if (/^(?:зона|регион|срок подачи предложения|срок подачи заявки|сметная стоимость)\s*:?$/iu.test(text)) return null;
  if (/^срок подачи (?:предложения|заявки)\b/iu.test(text) && !/\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+\d{4}/iu.test(text)) return null;

  // Grand-Smeta codes are useful for an estimator but obscure the meaning for
  // a procurement manager. Keep the item name and quantity in the short view.
  text = text.replace(/^(?:ФЕР|ТЕР|ГЭСН|ФССЦ|ФСБЦ|ФЕРм|ФЕРр|ФЕРп)\s*[-\w.]+\s+/iu, "");
  return text || null;
}

export function citationTopicLabel(text: string): string {
  if (/штраф|пени|неустойк|удержан|ответствен/iu.test(text)) return "Ответственность";
  if (/оплат|аванс|отсроч|при[её]мк/iu.test(text)) return "Оплата";
  if (/срок подачи|подач[аи] предложен|окончан.{0,16}заяв/iu.test(text)) return "Срок подачи";
  if (/срок|календар|начало работ|окончание работ/iu.test(text)) return "Сроки выполнения";
  if (/материал|комплект|поставк/iu.test(text)) return "Материалы";
  if (/объ[её]м|количеств|перечень работ|предмет закуп/iu.test(text)) return "Объём работ";
  if (/регион|зон[аеы]/iu.test(text)) return "Регион и условия";
  if (/^(?:ФЕР|ТЕР|ГЭСН|ФССЦ|ФСБЦ)/iu.test(text)) return "Позиция сметы";
  return "Условие закупки";
}

function relevantClause(text: string): string {
  const clauses = text.split(/(?<=[.!?;])\s+(?=[А-ЯЁA-Z«])/u).map((item) => item.trim()).filter(Boolean);
  if (clauses.length < 2) return text;
  const patterns = [
    [/штраф|пени|неустойк|удержан|ответствен/iu, /штраф|пени|неустойк|удержан|ответствен/iu],
    [/оплат|аванс|отсроч|при[её]мк/iu, /оплат|аванс|отсроч|при[её]мк/iu],
    [/срок подачи|подач[аи] предложен|окончан.{0,16}заяв/iu, /срок подачи|подач[аи] предложен|окончан.{0,16}заяв/iu],
    [/срок|календар|начало работ|окончание работ/iu, /срок|календар|начало работ|окончание работ/iu],
    [/материал|комплект|поставк/iu, /материал|комплект|поставк/iu],
    [/объ[её]м|количеств|перечень работ|предмет закуп/iu, /объ[её]м|количеств|перечень работ|предмет закуп/iu],
  ];
  const topic = patterns.find(([topicPattern]) => topicPattern.test(text));
  const matching = topic ? clauses.filter((clause) => topic[1].test(clause)) : [];
  return (matching.length ? matching : clauses).join(" ");
}

export function readableCitations(citations: Citation[]): Array<Citation & { displayText: string; topicLabel: string }> {
  return citations.flatMap((citation) => {
    const rawText = citationTextForDisplay(citation);
    const displayText = rawText ? relevantClause(rawText) : null;
    return displayText ? [{ ...citation, displayText, topicLabel: citationTopicLabel(citation.text) }] : [];
  });
}

export function submissionDeadlineFromCitations(citations: Citation[]): string | null {
  const date = String.raw`(?:\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+\d{4})`;
  const pattern = new RegExp(String.raw`(?:срок\s+подачи(?:\s+(?:заявки|предложения))?|окончани[ея]\s+подачи(?:\s+(?:заявок|предложений))?|подать\s+предложение)[^\n]{0,100}?(${date})(?:\s*(?:г\.?|года))?(?:\s*(?:в|до)\s*(\d{1,2}:\d{2}))?`, "iu");
  for (const citation of citations) {
    const text = citationTextForDisplay(citation);
    if (!text) continue;
    const match = text.match(pattern);
    if (match) return `${match[1]}${match[2] ? `, ${match[2]}` : ""}`;
  }
  return null;
}

export function regionFromCitations(citations: Citation[]): string | null {
  for (const citation of citations) {
    const text = citationTextForDisplay(citation);
    if (!text) continue;
    const match = text.match(/регион(?: в смете)?\s*:\s*([^;,]+)/iu);
    if (match && !MISSING_VALUE.test(match[1].trim())) return match[1].trim();
  }
  return null;
}
